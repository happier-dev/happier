export type BoundedToolCallNameCache = Readonly<{
  clear: () => void;
  delete: (callId: string) => void;
  evict: (nowMs?: number) => void;
  get: (callId: string) => string | null;
  record: (callId: string, toolName: string) => void;
}>;

export function createBoundedToolCallNameCache(params: Readonly<{ maxEntries: number; ttlMs: number }>): BoundedToolCallNameCache {
  const maxEntries = Math.max(1, params.maxEntries);
  const ttlMs = Math.max(1, params.ttlMs);

  const toolNameByCallId = new Map<string, { toolName: string; createdAtMs: number }>();
  const toolCallIdQueue: string[] = [];

  const clear = () => {
    toolNameByCallId.clear();
    toolCallIdQueue.length = 0;
  };

  const compactQueue = () => {
    // We lazily remove callIds from the queue (the Map is the source of truth). Compact occasionally to
    // avoid unbounded growth when tool-results arrive out of order.
    const maxQueueLen = maxEntries * 4;
    if (toolCallIdQueue.length <= maxQueueLen) return;
    let write = 0;
    for (const callId of toolCallIdQueue) {
      if (toolNameByCallId.has(callId)) {
        toolCallIdQueue[write] = callId;
        write += 1;
      }
    }
    toolCallIdQueue.length = write;
  };

  const evict = (nowMs: number = Date.now()) => {
    // TTL eviction: because the queue is insertion-ordered, we only need to consider the head.
    while (toolCallIdQueue.length > 0) {
      const oldestCallId = toolCallIdQueue[0]!;
      const entry = toolNameByCallId.get(oldestCallId);
      if (!entry) {
        toolCallIdQueue.shift();
        continue;
      }
      if (nowMs - entry.createdAtMs > ttlMs) {
        toolNameByCallId.delete(oldestCallId);
        toolCallIdQueue.shift();
        continue;
      }
      break;
    }

    // Size eviction: remove oldest entries until within bounds.
    while (toolNameByCallId.size > maxEntries && toolCallIdQueue.length > 0) {
      const oldestCallId = toolCallIdQueue.shift()!;
      toolNameByCallId.delete(oldestCallId);
    }

    // Defensive: if the queue was desynced (shouldn't happen), keep memory bounded.
    if (toolNameByCallId.size > maxEntries && toolCallIdQueue.length === 0) {
      toolNameByCallId.clear();
    }

    compactQueue();
  };

  const record = (callId: string, toolName: string) => {
    const nowMs = Date.now();
    toolNameByCallId.set(callId, { toolName, createdAtMs: nowMs });
    toolCallIdQueue.push(callId);
    evict(nowMs);
  };

  const get = (callId: string): string | null => {
    return toolNameByCallId.get(callId)?.toolName ?? null;
  };

  const del = (callId: string) => {
    toolNameByCallId.delete(callId);
  };

  return Object.freeze({
    clear,
    delete: del,
    evict,
    get,
    record,
  });
}
