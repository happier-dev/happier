import type { Message } from "@happier-dev/session-core/messages";
import { compareTranscriptMessagesOldestFirst } from "@happier-dev/session-core/messages";
import { normalizeSessionId } from "../domains/session/normalizeSessionId";

export const emptySessionMessagesSnapshot: unknown[] = [];
const emptyArray = emptySessionMessagesSnapshot;

type SessionMessagesArrayCacheEntry = Readonly<{
  idsRef: readonly string[];
  messagesByIdRef: Record<string, Message>;
  messagesVersion: number;
  messages: readonly Message[];
}>;

export const SESSION_MESSAGES_ARRAY_CACHE_MAX = 16;
export const sessionMessagesArrayCache = new Map<string, SessionMessagesArrayCacheEntry>();

/** Canonical ordered/continuity snapshot, shared by full and narrowly selected transcript readers. */
export function readSessionMessagesSnapshot(
  sessionId: string,
  ids: readonly string[],
  messagesById: Record<string, Message>,
  version: number,
  isLoaded: boolean,
): Message[] {
    const normalizedSessionId = normalizeSessionId(sessionId);

    if (!Array.isArray(ids) || ids.length === 0) {
      if (messagesById && Object.keys(messagesById).length > 0) {
        const cached = sessionMessagesArrayCache.get(normalizedSessionId);
        if (
          cached &&
          cached.messagesVersion === version &&
          cached.idsRef === ids &&
          cached.messagesByIdRef === messagesById
        ) {
          sessionMessagesArrayCache.delete(normalizedSessionId);
          sessionMessagesArrayCache.set(normalizedSessionId, cached);
          return cached.messages as Message[];
        }

        const out = Object.values(messagesById).slice().sort(compareTranscriptMessagesOldestFirst);
        sessionMessagesArrayCache.delete(normalizedSessionId);
        sessionMessagesArrayCache.set(normalizedSessionId, {
          idsRef: ids,
          messagesByIdRef: messagesById,
          messagesVersion: version,
          messages: out,
        });
        while (sessionMessagesArrayCache.size > SESSION_MESSAGES_ARRAY_CACHE_MAX) {
          const oldestKey = sessionMessagesArrayCache.keys().next().value;
          if (typeof oldestKey !== 'string') break;
          sessionMessagesArrayCache.delete(oldestKey);
        }
        return out;
      }

      // Minimal stale-while-revalidate behavior:
      // If a session transcript is temporarily reset (ids cleared + isLoaded=false) while a refresh is in flight,
      // keep showing the last derived messages array so switching sessions feels instant.
      const cached = sessionMessagesArrayCache.get(normalizedSessionId);
      if (cached && !isLoaded) {
        sessionMessagesArrayCache.delete(normalizedSessionId);
        sessionMessagesArrayCache.set(normalizedSessionId, cached);
        return cached.messages as Message[];
      }

      if (cached && isLoaded) {
        sessionMessagesArrayCache.delete(normalizedSessionId);
      }

      return emptyArray as Message[];
    }

    const cached = sessionMessagesArrayCache.get(normalizedSessionId);
    if (
      cached &&
      cached.messagesVersion === version &&
      cached.idsRef === ids &&
      cached.messagesByIdRef === messagesById
    ) {
      sessionMessagesArrayCache.delete(normalizedSessionId);
      sessionMessagesArrayCache.set(normalizedSessionId, cached);
      return cached.messages as Message[];
    }

    const out: Message[] = [];
    for (const id of ids) {
      const m = messagesById[id];
      if (m) out.push(m);
    }

    sessionMessagesArrayCache.delete(normalizedSessionId);
    sessionMessagesArrayCache.set(normalizedSessionId, {
      idsRef: ids,
      messagesByIdRef: messagesById,
      messagesVersion: version,
      messages: out,
    });
    while (sessionMessagesArrayCache.size > SESSION_MESSAGES_ARRAY_CACHE_MAX) {
      const oldestKey = sessionMessagesArrayCache.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      sessionMessagesArrayCache.delete(oldestKey);
    }

    return out;
}
