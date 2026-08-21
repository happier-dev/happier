import { DefaultTransport } from '@/agent/transport';

export const GROK_TOOL_UPDATE_MIN_INTERVAL_MS = 250;
export const GROK_TOOL_CONTENT_CHAR_LIMIT = 8_192;

type GrokToolUpdate = Readonly<{
  toolCallId?: unknown;
  status?: unknown;
  content?: unknown;
}>;

function boundUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length <= GROK_TOOL_CONTENT_CHAR_LIMIT
      ? value
      : value.slice(-GROK_TOOL_CONTENT_CHAR_LIMIT);
  }
  if (Array.isArray(value)) {
    let bounded: unknown[] | null = null;
    value.forEach((entry, index) => {
      const boundedEntry = boundUnknown(entry);
      if (boundedEntry === entry) return;
      bounded ??= [...value];
      bounded[index] = boundedEntry;
    });
    return bounded ?? value;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    let bounded: Record<string, unknown> | null = null;
    for (const [key, entry] of Object.entries(record)) {
      const boundedEntry = boundUnknown(entry);
      if (boundedEntry === entry) continue;
      bounded ??= { ...record };
      bounded[key] = boundedEntry;
    }
    return bounded ?? value;
  }
  return value;
}

export class GrokTransport extends DefaultTransport {
  private readonly lastInProgressUpdateAtByToolCallId = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {
    super('grok');
  }

  override shouldProcessToolUpdate<T extends GrokToolUpdate>(
    update: T,
    context: Readonly<{ source: 'tool_call' | 'tool_call_update' }>,
  ): boolean {
    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : null;
    if (toolCallId === null || context.source !== 'tool_call_update') return true;
    if (update.status !== 'in_progress') {
      if (update.status === 'completed' || update.status === 'failed' || update.status === 'cancelled') {
        this.lastInProgressUpdateAtByToolCallId.delete(toolCallId);
      }
      return true;
    }

    const nowMs = this.now();
    const previousAt = this.lastInProgressUpdateAtByToolCallId.get(toolCallId);
    if (previousAt !== undefined && nowMs - previousAt < GROK_TOOL_UPDATE_MIN_INTERVAL_MS) {
      return false;
    }
    this.lastInProgressUpdateAtByToolCallId.set(toolCallId, nowMs);
    return true;
  }

  override sanitizeToolUpdateContent<T extends { content?: unknown }>(update: T): T {
    return boundUnknown(update) as T;
  }
}

export function createGrokTransport(options?: Readonly<{ now?: () => number }>): GrokTransport {
  return new GrokTransport(options?.now);
}

export const grokTransport = createGrokTransport();
