import { storage } from '@/sync/domains/state/storage';

export async function waitForNextAssistantTextMessage(
  sessionId: string,
  baselineIds: Set<string>,
  baselineCount: number,
  timeoutMs: number
): Promise<string | null> {
  return await new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: null | (() => void) = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      try {
        unsubscribe?.();
      } catch {
        // Best-effort cleanup; ignore unsubscribe errors.
      }
      unsubscribe = null;
    };

    const done = (text: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(text);
    };

    const check = () => {
      try {
        const messages = (storage.getState() as any).sessionMessages?.[sessionId]?.messages ?? [];
        const startIndex = messages.length >= baselineCount ? baselineCount : 0;
        for (let idx = startIndex; idx < messages.length; idx += 1) {
          const message = messages[idx];
          if (message?.kind !== 'agent-text') continue;
          if (typeof message?.text !== 'string') continue;
          if (typeof message?.id === 'string' && baselineIds.has(message.id)) continue;
          done(message.text);
          return;
        }
      } catch {
        done(null);
      }
    };

    timeout = setTimeout(() => done(null), timeoutMs);
    try {
      unsubscribe = storage.subscribe(check);
    } catch {
      done(null);
      return;
    }
    check();
  });
}
