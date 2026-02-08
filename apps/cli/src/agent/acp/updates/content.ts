import type { SessionUpdate } from './types';

/**
 * Parse args from update content (can be array or object).
 */
export function parseArgsFromContent(content: unknown): Record<string, unknown> {
  if (Array.isArray(content)) {
    return { items: content };
  }
  if (typeof content === 'string') {
    return { value: content };
  }
  if (content && typeof content === 'object' && content !== null) {
    return content as Record<string, unknown>;
  }
  return {};
}

export function extractToolInput(update: SessionUpdate): unknown {
  if (update.rawInput !== undefined) return update.rawInput;
  if (update.input !== undefined) return update.input;
  return update.content;
}

export function extractToolOutput(update: SessionUpdate): unknown {
  if (update.rawOutput !== undefined) return update.rawOutput;
  if (update.output !== undefined) return update.output;
  if (update.result !== undefined) return update.result;
  if (update.liveContent !== undefined) return update.liveContent;
  if (update.live_content !== undefined) return update.live_content;
  return update.content;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function getAcpMetaFromArgs(args: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(args._acp);
}

export function extractMeta(update: SessionUpdate): Record<string, unknown> | null {
  const meta = update.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  return meta as Record<string, unknown>;
}

export function hasMeaningfulToolUpdate(update: SessionUpdate): boolean {
  if (typeof update.title === 'string' && update.title.trim().length > 0) return true;
  if (update.rawInput !== undefined) return true;
  if (update.input !== undefined) return true;
  if (update.content !== undefined) return true;
  if (Array.isArray(update.locations) && update.locations.length > 0) return true;
  const meta = extractMeta(update);
  if (meta) {
    if (meta.terminal_output) return true;
    if (meta.terminal_exit) return true;
  }
  return false;
}

export function attachAcpMetadataToArgs(
  args: Record<string, unknown>,
  update: SessionUpdate,
  toolKind: string,
  rawInput: unknown,
): void {
  const meta = extractMeta(update);
  const acp: Record<string, unknown> = { kind: toolKind };

  if (typeof update.title === 'string' && update.title.trim().length > 0) {
    acp.title = update.title;
    // Prevent "empty tool" UIs when a provider omits rawInput/content but provides a title.
    if (typeof args.description !== 'string' || args.description.trim().length === 0) {
      args.description = update.title;
    }
  }

  if (rawInput !== undefined) acp.rawInput = rawInput;
  if (Array.isArray(update.locations) && update.locations.length > 0) acp.locations = update.locations;
  if (meta) acp.meta = meta;

  // Only attach when we have something beyond kind (keeps payloads small).
  if (Object.keys(acp).length > 1) {
    args._acp = { ...(getAcpMetaFromArgs(args) ?? {}), ...acp };
  }
}

/**
 * Extract error detail from update content.
 */
export function extractErrorDetail(content: unknown): string | undefined {
  if (!content) return undefined;

  if (typeof content === 'string') {
    return content;
  }

  if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
    const obj = content as Record<string, unknown>;

    if (obj.error) {
      const error = obj.error;
      if (typeof error === 'string') return error;
      if (error && typeof error === 'object' && 'message' in error) {
        const errObj = error as { message?: unknown };
        if (typeof errObj.message === 'string') return errObj.message;
      }
      return JSON.stringify(error);
    }

    if (typeof obj.message === 'string') return obj.message;

    const status = typeof obj.status === 'string' ? obj.status : undefined;
    const reason = typeof obj.reason === 'string' ? obj.reason : undefined;
    return status || reason || JSON.stringify(obj).substring(0, 500);
  }

  return undefined;
}

export function extractTextFromContentBlock(content: unknown): string | null {
  if (!content) return null;
  if (typeof content === 'string') return content;
  if (typeof content !== 'object' || Array.isArray(content)) return null;
  const obj = content as Record<string, unknown>;
  if (typeof obj.text === 'string') return obj.text;
  return null;
}
