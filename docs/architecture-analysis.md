# Remi 架构重设计：MCP Server + Hooks 模式

## 核心思路

**架构反转：Claude Code 是运行时主控，Remi 是它的 MCP 工具服务 + 记忆层。**

不再自己造 skill/plugin/middleware，而是直接复用 Claude Code 原生能力：

| 能力 | 原来 Remi 自己做 | 现在用 Claude Code 原生 |
|------|------------------|------------------------|
| AI 推理 | `providers/claude_cli/` 包裹子进程 | Claude Code 自身 |
| 对话管理 | `core.py` session/lane lock | Claude Code session |
| Skills/Slash Commands | 无 | Claude Code `/skill` 体系 |
| 消息输入 | `connectors/` (CLI, Feishu) | Claude Code 自己的 CLI；Feishu 走 webhook→`claude -p` |
| System Prompt | `core.py` 硬编码 `SYSTEM_PROMPT` | `CLAUDE.md` 文件 |
| 自定义 Tools | `ToolDefinition` 注册到 Provider | **Remi MCP Server** 暴露 tools |
| 记忆系统 | `memory/store.py` + 工具闭包 | **Remi MCP Server** 暴露 recall/remember |
| Hooks | `pre_tool_hook/post_tool_hook` | Claude Code **hooks** 系统调 Remi |
| 定时维护 | `scheduler/jobs.py` | Remi daemon 只跑记忆维护 |

## 架构对比

### 现在（Remi 包裹 Claude）

```
User → Connector → Remi(orchestrator) → Claude CLI(subprocess)
                     ↑                         ↓
                   Memory                  Tool calls
                   Store               (Remi 内部处理)
```

Remi 做了太多事：消息路由、会话管理、Provider 抽象、Connector 抽象、工具派发……
这些 Claude Code **原生就有**。

### 目标（Claude Code 调用 Remi）

```
                    Claude Code (原生运行)
                    ├── CLAUDE.md              ← 人设 + 记忆说明
                    ├── .claude/settings.json  ← 注册 Remi MCP Server
                    ├── hooks                  ← stop hook → 记忆入队
                    │
                    └── MCP Server: remi
                         ├── tool: recall(query)
                         ├── tool: remember(entity, type, observation)
                         ├── tool: (任意自定义 tool...)
                         ├── resource: memory://context   ← 自动注入上下文
                         └── resource: memory://entities  ← 实体目录
```

Remi 只管两件事：**记忆** 和 **自定义工具**。

---

## 模块裁剪

### 删除（Claude Code 原生覆盖）

| 文件 | 原因 |
|------|------|
| `core.py` | 编排器不需要了，Claude Code 自己编排 |
| `providers/` (整个目录) | 不再包裹 Claude 子进程 |
| `connectors/base.py` | 不再抽象输入适配器 |
| `connectors/cli.py` | Claude Code 自带 CLI |
| `daemon.py` | 不再有 Remi daemon 包裹 Claude |
| `__main__.py` | 入口改为 MCP Server |

### 保留（Remi 核心价值）

| 文件 | 角色 |
|------|------|
| `memory/store.py` | 记忆存储引擎，~600 行，Remi 核心 |
| `memory/maintenance.py` | 记忆维护 agent prompt + action 执行 |
| `memory/enqueue.py` | Claude Code stop hook，已经在用 |
| `memory/daemon.py` | 队列消费 + 维护 agent |
| `tools/memory_tools.py` | recall/remember → 变成 MCP tools |
| `config.py` | 简化，只保留 memory 相关配置 |

### 新增

| 文件 | 角色 |
|------|------|
| `mcp/server.ts` | MCP Server 主进程（stdio 传输） |
| `mcp/tools.ts` | 工具注册：recall, remember, 自定义 |
| `mcp/resources.ts` | 资源暴露：记忆上下文 |
| `hooks/stop.ts` | stop hook：对话结束 → 记忆入队 |
| `daemon.ts` | 轻量 daemon：只跑记忆维护（消费队列 + 定时压缩） |

---

## 代码量对比

```
现在（Python）                    目标（TS/Bun）
─────────────────────            ─────────────────────
core.py          ~150  ×删       mcp/server.ts    ~100
providers/       ~600  ×删       mcp/tools.ts     ~80
connectors/      ~250  ×删       mcp/resources.ts ~50
daemon.py        ~150  ×删       hooks/stop.ts    ~40
scheduler/       ~250  ×删       daemon.ts        ~80
__main__.py      ~70   ×删

memory/store.py  ~600  →移植     memory/store.ts  ~500
memory/maint.    ~170  →移植     memory/maint.ts  ~150
memory/enqueue   ~45   →移植     (合入 hooks/)
memory/daemon    ~160  →移植     (合入 daemon.ts)
tools/           ~50   →合入     (合入 mcp/tools)
config.py        ~110  →简化     config.ts        ~60
─────────────────────            ─────────────────────
总计 ~2600 行                    总计 ~1060 行
```

**减少 60%，且每一行都是 Remi 自己的核心价值。**

---

## 具体实现

### 1. MCP Server（Remi 主体）

```typescript
// src/mcp/server.ts
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MemoryStore } from "../memory/store";
import { loadConfig } from "../config";

const config = loadConfig();
const store = new MemoryStore(config.memoryDir);

const server = new McpServer({
  name: "remi",
  version: "2.0.0",
});

// ── Tools ─────────────────────────────────────────

server.tool(
  "recall",
  "搜索所有记忆（实体、日志、项目记忆）。精确匹配返回全文，模糊匹配返回摘要。",
  {
    query: z.string().describe("搜索关键词或实体名"),
    type: z.string().optional().describe("实体类型过滤"),
    cwd: z.string().optional().describe("当前工作目录"),
  },
  async ({ query, type, cwd }) => {
    const result = store.recall(query, { type, cwd });
    return { content: [{ type: "text", text: result || "(无匹配结果)" }] };
  }
);

server.tool(
  "remember",
  "即时记住重要信息。实体不存在则创建，已存在则追加观察。",
  {
    entity: z.string().describe("实体名称"),
    type: z.string().describe("实体类型：person/project/decision/..."),
    observation: z.string().describe("要记住的内容"),
    scope: z.enum(["personal", "project"]).default("personal"),
    cwd: z.string().optional(),
  },
  async ({ entity, type, observation, scope, cwd }) => {
    const result = store.remember(entity, type, observation, { scope, cwd });
    return { content: [{ type: "text", text: result }] };
  }
);

// ── Resources（自动上下文注入）──────────────────────

server.resource(
  "memory-context",
  "memory://context",
  async (uri) => {
    const context = store.gatherContext(process.cwd());
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: context }] };
  }
);

// ── 启动 ──────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
```

### 2. Claude Code 配置

```jsonc
// ~/.claude/settings.json
{
  "mcpServers": {
    "remi": {
      "command": "bun",
      "args": ["run", "/path/to/remi/src/mcp/server.ts"]
    }
  }
}
```

```jsonc
// .claude/settings.json（项目级，可按项目定制）
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun run /path/to/remi/src/hooks/stop.ts"
          }
        ]
      }
    ]
  }
}
```

### 3. CLAUDE.md（替代硬编码 SYSTEM_PROMPT）

```markdown
# CLAUDE.md

你是 Remi，Jack 的个人 AI 助手。

## 记忆系统

你通过 MCP 工具访问持久化记忆：

- **recall(query)** — 搜索所有记忆。注入的上下文不够时使用。
- **remember(entity, type, observation)** — 即时保存重要信息。

每次对话开始时，读取 memory://context 获取当前记忆上下文。

## 行为准则
- 当用户告知生日、偏好、重要决策时，主动调用 remember
- 不确定的信息先 recall 再回答
```

### 4. Stop Hook（记忆入队）

```typescript
// src/hooks/stop.ts  — Claude Code stop hook
// 对话结束时自动触发，读取 transcript 入队
import { createHash } from "crypto";
import { mkdir, readFile, writeFile, appendFile } from "fs/promises";
import { join } from "path";

const queueDir = join(process.env.HOME!, ".remi", "queue");
await mkdir(queueDir, { recursive: true });

const transcript = await Bun.stdin.text();
if (!transcript.trim()) process.exit(0);

const hash = createHash("sha256").update(transcript).digest("hex").slice(0, 16);
const processedFile = join(queueDir, ".processed");

try {
  const processed = await readFile(processedFile, "utf-8");
  if (processed.includes(hash)) process.exit(0);
} catch {}

const ts = new Date().toISOString().replace(/[:-]/g, "").slice(0, 15);
const entry = JSON.stringify({ timestamp: ts, hash, transcript });
await writeFile(join(queueDir, `${ts}.jsonl`), entry + "\n");
```

### 5. 记忆维护 Daemon（唯一的常驻进程）

```typescript
// src/daemon.ts — 只做记忆维护，不做 Claude 编排
// 运行方式：bun run src/daemon.ts（systemd/launchd 管理）

import { MemoryStore } from "./memory/store";
import { processQueue } from "./memory/queue";
import { loadConfig } from "./config";

const config = loadConfig();
const store = new MemoryStore(config.memoryDir);

// 1. 轮询队列，消费 transcript → 提取记忆
setInterval(() => processQueue(store, config), 10_000);

// 2. 每日凌晨 3 点：压缩日志 + 清理旧文件
function scheduleDailyMaintenance() {
  const now = new Date();
  const next3am = new Date(now);
  next3am.setHours(3, 0, 0, 0);
  if (next3am <= now) next3am.setDate(next3am.getDate() + 1);

  setTimeout(async () => {
    await store.compactDaily();
    store.cleanupOldDailies(30);
    store.cleanupOldVersions(50);
    scheduleDailyMaintenance(); // 递归调度下一天
  }, next3am.getTime() - now.getTime());
}

scheduleDailyMaintenance();
console.log("Remi memory daemon started");
```

### 6. 添加自定义 Tool（扩展方式）

```typescript
// 在 mcp/server.ts 中，添加任意自定义工具极其简单：

server.tool(
  "search_web",
  "搜索互联网获取最新信息",
  { query: z.string() },
  async ({ query }) => {
    const res = await fetch(`https://api.search.example/q=${encodeURIComponent(query)}`);
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data.results) }] };
  }
);

server.tool(
  "feishu_send",
  "发送飞书消息",
  {
    chat_id: z.string(),
    text: z.string(),
  },
  async ({ chat_id, text }) => {
    // 直接 fetch 飞书 API
    // ...
    return { content: [{ type: "text", text: "已发送" }] };
  }
);
```

---

## 项目结构（TS/Bun）

```
remi/
├── package.json
├── tsconfig.json
├── CLAUDE.md                    ← 人设 + 记忆指令（替代硬编码 SYSTEM_PROMPT）
│
├── src/
│   ├── mcp/
│   │   └── server.ts            ← MCP Server 入口（被 Claude Code 启动）
│   │
│   ├── memory/
│   │   ├── store.ts             ← MemoryStore（移植，核心 ~500 行）
│   │   ├── maintenance.ts       ← 维护 agent prompt + action 解析
│   │   └── queue.ts             ← 队列消费逻辑
│   │
│   ├── hooks/
│   │   └── stop.ts              ← Claude Code stop hook
│   │
│   ├── daemon.ts                ← 记忆维护常驻进程
│   └── config.ts                ← 配置（Zod + TOML）
│
└── tests/
    ├── store.test.ts
    └── mcp.test.ts
```

**10 个文件，~1000 行。** 这就是整个 Remi。

---

## Feishu 怎么办？

Feishu 不再是 Remi Connector，而是一个独立的薄 webhook 转发层：

```
Feishu webhook → 轻量 HTTP server → claude -p "用户消息" → 回复 Feishu
```

```typescript
// feishu-bridge/server.ts（独立项目，或 Remi 的一个子命令）
import { Hono } from "hono";

const app = new Hono();

app.post("/webhook/feishu", async (c) => {
  const body = await c.req.json();
  const text = extractText(body);

  // 直接调 claude CLI
  const proc = Bun.spawn(["claude", "-p", text], { stdout: "pipe" });
  const reply = await new Response(proc.stdout).text();

  await sendFeishuReply(body.event.message.chat_id, reply);
  return c.json({ code: 0 });
});

export default { port: 9000, fetch: app.fetch };
```

---

## 总结

| 维度 | 之前 | 之后 |
|------|------|------|
| Remi 角色 | 编排器（包裹 Claude） | MCP 工具服务（被 Claude 调用） |
| 代码量 | ~2600 行 / 15 文件 | ~1000 行 / 10 文件 |
| Claude 能力利用 | 仅用推理 | Skills + Hooks + MCP + CLAUDE.md 全部原生 |
| 自定义 Tool | 注册到 Provider 内部 | MCP server.tool()，一行注册 |
| 记忆注入 | core.py 手动拼 context | MCP Resource + CLAUDE.md |
| 扩展性 | 需自建 Plugin 体系 | 加个 server.tool() 就行 |
