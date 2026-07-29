import { storage } from '@/sync/domains/state/storage';
import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';

export type AssistantTextMessageBaseline = Readonly<{
  baselineIds: Set<string>;
  baselineCount: number;
}>;

export type AssistantTextMessageEntry = Readonly<{
  entryId: string;
  text: string;
}>;

function getSessionMessages(sessionId: string): any[] {
  return readStoredSessionMessages(storage.getState(), sessionId) as any[];
}

export function captureAssistantTextMessageBaseline(sessionId: string): AssistantTextMessageBaseline {
  const messages = getSessionMessages(sessionId);
  return {
    baselineCount: messages.length,
    baselineIds: new Set<string>(
      messages
        .map((message: any) => message?.id)
        .filter((messageId: any): messageId is string => typeof messageId === 'string'),
    ),
  };
}

export function collectAssistantTextMessagesSinceBaseline(
  sessionId: string,
  baselineIds: Set<string>,
  baselineCount: number,
): string[] {
  return collectAssistantTextMessageEntriesSinceBaseline(
    sessionId,
    baselineIds,
    baselineCount,
  ).map((entry) => entry.text);
}

export function collectAssistantTextMessageEntriesSinceBaseline(
  sessionId: string,
  baselineIds: Set<string>,
  baselineCount: number,
): AssistantTextMessageEntry[] {
  const messages = getSessionMessages(sessionId);
  const startIndex = messages.length >= baselineCount ? baselineCount : 0;
  const out: AssistantTextMessageEntry[] = [];
  for (let idx = startIndex; idx < messages.length; idx += 1) {
    const message = messages[idx];
    if (message?.kind !== 'agent-text') continue;
    if (typeof message?.text !== 'string') continue;
    if (typeof message?.id === 'string' && baselineIds.has(message.id)) continue;
    const text = message.text.trim();
    const entryId = (
      typeof message?.realID === 'string' && message.realID.trim()
        ? message.realID
        : typeof message?.localId === 'string' && message.localId.trim()
          ? message.localId
          : typeof message?.id === 'string' && message.id.trim()
            ? message.id
            : ''
    ).trim();
    if (!text || !entryId) continue;
    out.push({ entryId, text });
  }
  return out;
}

export async function waitForNextAssistantTextMessageEntry(
  sessionId: string,
  baselineIds: Set<string>,
  baselineCount: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AssistantTextMessageEntry | null> {
  if (signal?.aborted) return null;
  return await new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: null | (() => void) = null;
    const abortListener = signal
      ? () => {
          done(null);
        }
      : null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      try {
        unsubscribe?.();
      } catch {
        // Best-effort cleanup; ignore unsubscribe errors.
      }
      unsubscribe = null;
      if (signal && abortListener) {
        try {
          signal.removeEventListener('abort', abortListener);
        } catch {
          // ignore
        }
      }
    };

    const done = (entry: AssistantTextMessageEntry | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(entry);
    };

    const check = () => {
      try {
        const matches = collectAssistantTextMessageEntriesSinceBaseline(
          sessionId,
          baselineIds,
          baselineCount,
        );
        if (matches.length > 0) done(matches[0] ?? null);
      } catch {
        done(null);
      }
    };

    timeout = setTimeout(() => done(null), timeoutMs);
    if (signal && abortListener) {
      try {
        signal.addEventListener('abort', abortListener, { once: true });
      } catch {
        // ignore
      }
    }
    try {
      unsubscribe = storage.subscribe(check);
    } catch {
      done(null);
      return;
    }
    check();
  });
}

export async function waitForNextAssistantTextMessage(
  sessionId: string,
  baselineIds: Set<string>,
  baselineCount: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string | null> {
  const entry = await waitForNextAssistantTextMessageEntry(
    sessionId,
    baselineIds,
    baselineCount,
    timeoutMs,
    signal,
  );
  return entry?.text ?? null;
}
