# Remi 架构分析：Skill/Plugin 体系设计 + TS/Bun 迁移评估

## 1. 当前架构总览

### 1.1 Hub-and-Spoke 模式

```
┌─────────────┐     IncomingMessage     ┌──────────┐     Provider.send()    ┌──────────────┐
│  Connector   │ ──────────────────────→ │   Remi   │ ──────────────────── → │   Provider    │
│  (CLI/Feishu)│ ← ──────────────────── │  (Hub)   │ ← ──────────────────  │ (Claude CLI)  │
└─────────────┘     AgentResponse       └──────────┘     AgentResponse     └──────────────┘
                                              │
                                     ┌────────┴────────┐
                                     │                 │
                                ┌────▼────┐     ┌─────▼─────┐
                                │ Memory  │     │ Scheduler │
                                │ Store   │     │   Jobs    │
                                └─────────┘     └───────────┘
```

### 1.2 核心组件分析

| 组件 | 文件 | 职责 | 协议/接口 |
|------|------|------|-----------|
| **Remi** | `core.py` | 中心编排器，消息路由、会话管理、Lane Lock | 无协议，具体类 |
| **Provider** | `providers/base.py` | AI 后端抽象 | `Protocol`: `send()`, `health_check()`, `name` |
| **Connector** | `connectors/base.py` | 输入适配器 | `Protocol`: `start()`, `stop()`, `reply()`, `name` |
| **MemoryStore** | `memory/store.py` | 记忆读写，实体索引，上下文组装 | 具体类，无协议 |
| **Scheduler** | `scheduler/jobs.py` | 心跳、记忆压缩、清理 | 具体类 |
| **ClaudeCLIProvider** | `providers/claude_cli/` | Claude Code 流式子进程 | 实现 Provider 协议 |
| **ToolDefinition** | `providers/base.py` | 自定义工具注册 | dataclass |

### 1.3 现有的"准插件"模式

当前代码已经有一些插件化的雏形：

1. **Tool 注册** (`ClaudeCLIProvider.register_tool()`) — 可以注册自定义工具给 AI 调用
2. **Hook 系统** (`add_pre_tool_hook()` / `add_post_tool_hook()`) — 工具调用前后的拦截
3. **Memory Tools** (`tools/memory_tools.py`) — 通过 `get_memory_tools()` 动态生成工具闭包
4. **Maintenance Agent** (`memory/maintenance.py`) — 独立的维护 agent，结构化 action 解析+执行
5. **Connector 动态加载** (`daemon.py:_build_connectors`) — 按配置条件加载 Feishu

### 1.4 当前架构的局限

- **Tool 绑定在 Provider 上**：`register_tool()` 是 `ClaudeCLIProvider` 的方法，不是 Remi 层面的能力
- **没有统一的扩展点**：Connector、Provider、Tool 的注册散落在 `daemon.py` 中手动拼装
- **缺少生命周期管理**：Plugin 无法在 Remi 启动/关闭时执行初始化/清理
- **System Prompt 硬编码**：`SYSTEM_PROMPT` 在 `core.py` 中写死，Plugin 无法动态注入上下文
- **没有事件系统**：消息处理是线性的，没有 pre/post message hook

---

## 2. Skill / Plugin 体系设计

### 2.1 概念区分

| 概念 | 定义 | 生命周期 | 示例 |
|------|------|----------|------|
| **Plugin** | 可插拔的功能模块，拥有完整生命周期 | 随 Remi 启动/关闭 | `memory-plugin`, `scheduler-plugin`, `feishu-connector` |
| **Skill** | AI 可调用的能力单元（Tool 的上层封装） | 按需激活 | `recall`, `remember`, `web-search`, `code-exec` |
| **Middleware** | 消息处理管道中的拦截器 | 每条消息执行 | `rate-limiter`, `logging`, `auth-check` |

### 2.2 Plugin 接口设计

```typescript
// TypeScript 版本
interface Plugin {
  readonly name: string;
  readonly version: string;

  // 生命周期
  onLoad(ctx: RemiContext): Promise<void>;    // Remi 启动时
  onUnload(): Promise<void>;                  // Remi 关闭时

  // 注册能力（可选）
  skills?(): Skill[];                         // 暴露 Skill
  middlewares?(): Middleware[];                // 注册中间件
  connectors?(): Connector[];                 // 注册 Connector
  systemPromptFragments?(): string[];         // 注入 system prompt 片段
  configSchema?(): ZodSchema;                 // 声明配置结构
}
```

```python
# Python 等价（当前代码风格）
@runtime_checkable
class Plugin(Protocol):
    name: str
    version: str

    async def on_load(self, ctx: RemiContext) -> None: ...
    async def on_unload(self) -> None: ...

    def skills(self) -> list[Skill]: ...          # 可选
    def middlewares(self) -> list[Middleware]: ...  # 可选
```

### 2.3 Skill 接口设计

```typescript
interface Skill {
  readonly name: string;
  readonly description: string;          // 给 AI 看的描述
  readonly parameters: JsonSchema;       // 参数 schema

  execute(input: Record<string, unknown>, ctx: SkillContext): Promise<string>;
}

interface SkillContext {
  memory: MemoryStore;
  config: RemiConfig;
  chatId: string;
  sessionId?: string;
  // 允许 skill 调用其他 skill
  invoke(skillName: string, input: Record<string, unknown>): Promise<string>;
}
```

### 2.4 Middleware 接口设计

```typescript
type NextFn = (msg: IncomingMessage) => Promise<AgentResponse>;

interface Middleware {
  readonly name: string;
  readonly order: number;  // 执行顺序，越小越先执行

  handle(msg: IncomingMessage, next: NextFn): Promise<AgentResponse>;
}
```

### 2.5 Plugin 注册与发现

```
remi.toml:
  [plugins]
  builtin = ["memory", "scheduler"]    # 内置 plugin
  external = ["./plugins/my-plugin"]   # 本地路径
  npm = ["remi-plugin-notion"]         # npm 包（TS/Bun 场景）
```

加载顺序：
1. 内置 Plugin（memory, scheduler）
2. 配置文件声明的外部 Plugin
3. 自动发现 `~/.remi/plugins/` 下的 Plugin

### 2.6 重构后的消息流

```
IncomingMessage
      │
      ▼
┌─────────────────────────────────────────────────┐
│           Middleware Chain (洋葱模型)              │
│                                                   │
│  rate-limiter → auth → logging → ... → core      │
│                                                   │
│  core._process():                                 │
│    1. gather context (memory plugin)              │
│    2. collect system prompt fragments (plugins)   │
│    3. collect available skills → tools            │
│    4. provider.send(message, tools, system)       │
│    5. if tool_call → skill.execute()              │
│    6. append daily (memory plugin)                │
│    7. emit events (post-message)                  │
└─────────────────────────────────────────────────┘
      │
      ▼
  AgentResponse
```

### 2.7 内置 Plugin 拆分

将现有代码重构为 Plugin：

| Plugin | 来源 | Skills | 说明 |
|--------|------|--------|------|
| `memory-plugin` | `memory/`, `tools/memory_tools.py` | `recall`, `remember` | 记忆系统完整封装 |
| `scheduler-plugin` | `scheduler/jobs.py` | 无 | 定时任务管理 |
| `maintenance-plugin` | `memory/maintenance.py`, `memory/daemon.py` | 无 | 记忆维护 agent |
| `feishu-plugin` | `connectors/feishu.py` | 无 | 飞书连接器封装 |
| `cli-plugin` | `connectors/cli.py` | 无 | CLI REPL |

---

## 3. TypeScript + Bun 迁移分析

### 3.1 为什么迁移

**优势：**
- **类型安全**：TS 的类型系统远强于 Python typing，interface/generic/union 原生支持
- **Bun 性能**：启动速度极快（~10ms vs Python ~200ms），内置 bundler/test runner/package manager
- **Claude Code 生态亲和**：Claude Code 本身就是 TS 编写，stream-json 协议可以直接用 SDK
- **前端统一**：如果未来做 Web UI，全栈 TS
- **NPM 生态**：plugin 分发可以直接用 npm

**劣势 / 风险：**
- **完全重写**：不是渐进式迁移，是从头写（~2000 行 Python → ~1500 行 TS）
- **Python 生态丢失**：feishu SDK (`lark-oapi`) 是 Python 的，TS 端需要找替代或直接 HTTP
- **frontmatter 解析**：`python-frontmatter` 很成熟，TS 端用 `gray-matter`
- **异步模型差异**：Python 的 `asyncio` → JS 的 `Promise` + `async/await`（更简单）

### 3.2 模块映射

| Python 模块 | TypeScript 等价 | 复杂度 | 备注 |
|-------------|-----------------|--------|------|
| `core.py` | `src/core.ts` | 低 | 最核心，~150 行 |
| `config.py` | `src/config.ts` | 低 | 用 Zod 校验，比 dataclass 更强 |
| `providers/base.py` | `src/providers/types.ts` | 低 | interface 定义 |
| `providers/claude_cli/` | `src/providers/claude-cli/` | 中 | 子进程管理 + JSONL 协议 |
| `connectors/base.py` | `src/connectors/types.ts` | 低 | interface 定义 |
| `connectors/cli.py` | `src/connectors/cli.ts` | 低 | Bun 的 readline |
| `connectors/feishu.py` | `src/connectors/feishu.ts` | 中 | 需直接用 HTTP API 替代 SDK |
| `memory/store.py` | `src/memory/store.ts` | 高 | 最复杂，~600 行 |
| `memory/maintenance.py` | `src/memory/maintenance.ts` | 低 | prompt 构建 + JSON 解析 |
| `scheduler/jobs.py` | `src/scheduler/jobs.ts` | 中 | setTimeout/setInterval 替代 |
| `daemon.py` | `src/daemon.ts` | 中 | 进程管理、信号处理 |
| `tools/memory_tools.py` | 归入 `memory-plugin` | 低 | 作为 Skill 暴露 |

### 3.3 TS/Bun 项目结构建议

```
remi/
├── package.json
├── tsconfig.json
├── bunfig.toml
├── remi.toml                    # 运行时配置
│
├── src/
│   ├── index.ts                 # 入口
│   ├── core.ts                  # Remi hub
│   ├── config.ts                # Zod-based config
│   │
│   ├── types/
│   │   ├── plugin.ts            # Plugin / Skill / Middleware 接口
│   │   ├── provider.ts          # Provider 接口
│   │   ├── connector.ts         # Connector 接口
│   │   └── message.ts           # IncomingMessage / AgentResponse
│   │
│   ├── providers/
│   │   └── claude-cli/
│   │       ├── index.ts
│   │       ├── protocol.ts      # JSONL parse/format
│   │       └── process.ts       # 子进程管理 (Bun.spawn)
│   │
│   ├── plugins/
│   │   ├── memory/
│   │   │   ├── index.ts         # MemoryPlugin (implements Plugin)
│   │   │   ├── store.ts         # MemoryStore
│   │   │   ├── skills.ts        # recall / remember Skills
│   │   │   └── maintenance.ts
│   │   ├── scheduler/
│   │   │   └── index.ts         # SchedulerPlugin
│   │   ├── cli/
│   │   │   └── index.ts         # CLIPlugin (Connector)
│   │   └── feishu/
│   │       └── index.ts         # FeishuPlugin (Connector)
│   │
│   └── utils/
│       └── frontmatter.ts
│
├── tests/
│   ├── core.test.ts
│   ├── memory.test.ts
│   └── protocol.test.ts
│
└── docs/
```

### 3.4 Bun 特有优势

```typescript
// 1. 子进程管理 — Bun.spawn 比 child_process 更简洁
const proc = Bun.spawn(["claude", "--input-format", "stream-json", ...], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

// 直接流式读取
const reader = proc.stdout.getReader();
for await (const chunk of reader) {
  const line = decoder.decode(chunk);
  const msg = parseLine(line);
  // ...
}

// 2. 文件 I/O — Bun.file() 比 fs 快
const content = await Bun.file("~/.remi/memory/MEMORY.md").text();

// 3. 内置 test runner
import { test, expect } from "bun:test";
test("memory store recall", () => { ... });

// 4. TOML 配置加载
const config = await Bun.file("remi.toml").text();
// 用 @iarna/toml 或 smol-toml 解析

// 5. 热重载开发
// bun --watch src/index.ts
```

### 3.5 关键技术决策

| 决策点 | 推荐 | 理由 |
|--------|------|------|
| 运行时 | **Bun** | 启动快、内置工具链、TS 原生支持 |
| 包管理 | **Bun** (bun install) | 与运行时统一 |
| 测试 | **bun:test** | 内置，零配置 |
| Schema 校验 | **Zod** | 类型推导 + 运行时校验一体 |
| TOML 解析 | **smol-toml** | 轻量，符合 TOML v1.0 |
| Frontmatter | **gray-matter** | 成熟稳定 |
| HTTP 框架 | **Hono** | 轻量，Bun 原生支持，适合 webhook |
| 日志 | **pino** 或 **consola** | 结构化日志 |
| 飞书 SDK | **直接 HTTP** (fetch) | Bun 内置 fetch，不需要额外 SDK |

---

## 4. 迁移路线图

### Phase 1: 基础框架 + Plugin 骨架（1 周）

- [ ] 初始化 Bun + TS 项目
- [ ] 定义核心 interface：`Plugin`, `Skill`, `Middleware`, `Provider`, `Connector`
- [ ] 实现 `Remi` core（消息路由 + Plugin 注册 + Middleware chain）
- [ ] 实现 `RemiConfig`（Zod schema + TOML 加载）
- [ ] 基础测试

### Phase 2: Claude CLI Provider（3 天）

- [ ] 移植 JSONL 协议解析 (`protocol.ts`)
- [ ] 移植子进程管理 (`process.ts`) — 使用 `Bun.spawn`
- [ ] 实现 `ClaudeCLIProvider` — 流式 + fallback
- [ ] Tool call 处理集成

### Phase 3: Memory Plugin（1 周）

- [ ] 移植 `MemoryStore`（最大模块，~600 行）
- [ ] 实现 `MemoryPlugin`：`on_load` 初始化 store，暴露 `recall`/`remember` Skills
- [ ] Maintenance agent prompt + action 执行
- [ ] 上下文组装（gather_context → system prompt fragment）

### Phase 4: Connectors as Plugins（3 天）

- [ ] `CLIPlugin` — Bun readline
- [ ] `FeishuPlugin` — 用 Hono 做 webhook server + fetch 调飞书 API
- [ ] Daemon 模式 + 信号处理

### Phase 5: Scheduler + Polish（3 天）

- [ ] `SchedulerPlugin` — setInterval + 日期检查
- [ ] Memory compaction + cleanup
- [ ] CLI 入口 (`bun run src/index.ts [chat|serve]`)
- [ ] 完善测试覆盖

---

## 5. 代码示例：核心骨架（TS/Bun）

### 5.1 Plugin 接口

```typescript
// src/types/plugin.ts
import type { Skill } from "./skill";
import type { Middleware } from "./middleware";
import type { Connector } from "./connector";

export interface RemiContext {
  config: RemiConfig;
  registerSkill(skill: Skill): void;
  registerMiddleware(mw: Middleware): void;
  registerConnector(conn: Connector): void;
  getSkill(name: string): Skill | undefined;
}

export interface Plugin {
  readonly name: string;
  readonly version: string;

  onLoad(ctx: RemiContext): Promise<void>;
  onUnload?(): Promise<void>;

  // Optional: declare what this plugin provides
  systemPromptFragment?(): string;
}
```

### 5.2 Skill 接口

```typescript
// src/types/skill.ts
export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, ParameterDef>;

  execute(
    input: Record<string, unknown>,
    ctx: SkillContext,
  ): Promise<string>;
}

export interface ParameterDef {
  type: "string" | "number" | "boolean" | "array";
  description?: string;
  required?: boolean;
}

export interface SkillContext {
  chatId: string;
  sessionId?: string;
  invoke(skillName: string, input: Record<string, unknown>): Promise<string>;
}
```

### 5.3 Remi Core（简化）

```typescript
// src/core.ts
export class Remi {
  private plugins: Map<string, Plugin> = new Map();
  private skills: Map<string, Skill> = new Map();
  private middlewares: Middleware[] = [];
  private connectors: Connector[] = [];
  private providers: Map<string, Provider> = new Map();
  private sessions: Map<string, string> = new Map();  // chatId → sessionId
  private laneLocks: Map<string, Mutex> = new Map();

  constructor(private config: RemiConfig) {}

  // Plugin 生命周期
  async loadPlugin(plugin: Plugin): Promise<void> {
    const ctx: RemiContext = {
      config: this.config,
      registerSkill: (s) => this.skills.set(s.name, s),
      registerMiddleware: (m) => {
        this.middlewares.push(m);
        this.middlewares.sort((a, b) => a.order - b.order);
      },
      registerConnector: (c) => this.connectors.push(c),
      getSkill: (name) => this.skills.get(name),
    };
    await plugin.onLoad(ctx);
    this.plugins.set(plugin.name, plugin);
  }

  // 消息处理（中间件链）
  async handleMessage(msg: IncomingMessage): Promise<AgentResponse> {
    const lock = this.getLaneLock(msg.chatId);
    return lock.runExclusive(() => this.runMiddlewareChain(msg));
  }

  private async runMiddlewareChain(msg: IncomingMessage): Promise<AgentResponse> {
    let index = 0;
    const next = async (m: IncomingMessage): Promise<AgentResponse> => {
      if (index < this.middlewares.length) {
        return this.middlewares[index++].handle(m, next);
      }
      return this.process(m);
    };
    return next(msg);
  }

  private async process(msg: IncomingMessage): Promise<AgentResponse> {
    // 1. 收集 system prompt fragments
    const fragments = this.plugins.values()
      .filter(p => p.systemPromptFragment)
      .map(p => p.systemPromptFragment!());
    const systemPrompt = [BASE_SYSTEM_PROMPT, ...fragments].join("\n\n");

    // 2. 收集 skills → tools
    const tools = [...this.skills.values()].map(skillToToolDef);

    // 3. 路由到 provider
    const provider = this.getProvider();
    const response = await provider.send(msg.text, {
      systemPrompt,
      tools,
      sessionId: this.sessions.get(msg.chatId),
    });

    // 4. 处理 tool calls
    for (const call of response.toolCalls) {
      const skill = this.skills.get(call.name);
      if (skill) {
        const result = await skill.execute(call.input, {
          chatId: msg.chatId,
          sessionId: response.sessionId,
          invoke: (name, input) => this.invokeSkill(name, input, msg.chatId),
        });
        // ... send tool result back to provider
      }
    }

    // 5. 更新 session
    if (response.sessionId) {
      this.sessions.set(msg.chatId, response.sessionId);
    }

    return response;
  }
}
```

### 5.4 Memory Plugin 示例

```typescript
// src/plugins/memory/index.ts
import { MemoryStore } from "./store";
import { recallSkill, rememberSkill } from "./skills";
import type { Plugin, RemiContext } from "../../types/plugin";

export class MemoryPlugin implements Plugin {
  readonly name = "memory";
  readonly version = "2.0.0";

  private store!: MemoryStore;

  async onLoad(ctx: RemiContext): Promise<void> {
    this.store = new MemoryStore(ctx.config.memoryDir);
    ctx.registerSkill(recallSkill(this.store));
    ctx.registerSkill(rememberSkill(this.store));
  }

  async onUnload(): Promise<void> {
    // cleanup if needed
  }

  systemPromptFragment(): string {
    return `你拥有持久化记忆。可用工具：recall(query) 和 remember(entity, type, observation)。`;
  }
}
```

---

## 6. 总结与建议

### 推荐路径

**直接迁移到 TS/Bun，同时引入 Plugin 体系。** 理由：

1. 当前 Python 代码量不大（~2000 行），完整重写成本可控
2. Plugin 体系需要大幅重构 `core.py` 和 `daemon.py`，既然要重构，不如一步到位
3. Bun 的子进程管理、文件 I/O、HTTP server 都比 Python 对应方案更简洁
4. Claude Code 的 stream-json 协议在 TS 端有更自然的处理方式

### 不推荐的路径

- **Python 中先做 Plugin 再迁移 TS**：两次重构，浪费工作量
- **渐进式 Python→TS**：没有实际可行的渐进路径，两种语言无法混用

### 风险点

1. **MemoryStore 迁移最复杂**：frontmatter 解析、实体索引、上下文组装，建议优先 spike
2. **飞书 Connector**：需要直接调 HTTP API，工作量比 Python SDK 大
3. **Bun 稳定性**：Bun 仍在快速迭代，某些 edge case 可能有坑（如 signal handling）
