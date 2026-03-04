/**
 * Cached Feishu chat info lookups.
 * Used to detect topic groups (chat_mode === "topic") so that
 * every root message gets its own isolated session.
 */

import type * as Lark from "@larksuiteoapi/node-sdk";

const CHAT_MODE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — chat_mode rarely changes
const chatModeCache = new Map<string, { mode: string; expireAt: number }>();

/**
 * Get the chat_mode for a given chat_id ("group" or "topic").
 * Results are cached for 24h to avoid repeated API calls.
 */
export async function getChatMode(
  client: Lark.Client,
  chatId: string,
): Promise<string | undefined> {
  const cached = chatModeCache.get(chatId);
  const now = Date.now();
  if (cached && cached.expireAt > now) return cached.mode;

  try {
    const res: any = await client.im.chat.get({
      path: { chat_id: chatId },
    });
    const mode: string | undefined = res?.data?.chat_mode;
    if (mode) {
      chatModeCache.set(chatId, { mode, expireAt: now + CHAT_MODE_TTL_MS });
    }
    return mode;
  } catch {
    // Non-critical — if we can't determine chat_mode, fall back to default behavior
    return undefined;
  }
}
