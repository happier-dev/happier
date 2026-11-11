import type { RawJSONLines } from '../types';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function textBody(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.length !== 1) return null;
  const block = record(value[0]);
  return block?.type === 'text' && typeof block.text === 'string'
    && Object.keys(block).every(key => key === 'type' || key === 'text') ? block.text : null;
}

function repeatsNativeBody(content: unknown, native: unknown): boolean {
  const text = textBody(content);
  if (!text) return false;
  if (text === textBody(native)) return true;
  const metadata = record(native);
  return metadata !== null && ['stdout', 'stderr', 'content'].some(key => text === textBody(metadata[key]));
}

/** Keep native response metadata on its own tool blocks before combining results. */
export function embedClaudeToolResultMetadata(content: unknown, toolUseResult: unknown): unknown {
  if (toolUseResult === undefined || !Array.isArray(content)) return content;
  return content.map((block: unknown) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
    const result = block as Record<string, unknown>;
    if (result.type !== 'tool_result' || typeof result.tool_use_id !== 'string') return block;
    const existing = result.content;
    if (existing && typeof existing === 'object' && !Array.isArray(existing)
      && (existing as Record<string, unknown>).tool_use_result !== undefined) return block;
    if (repeatsNativeBody(existing, toolUseResult)) return { ...result, content: toolUseResult };
    return { ...result, content: { content: existing, tool_use_result: toolUseResult } };
  });
}

/** Scanner rows carry native metadata at the row level; store an exact repeated body on its tool instead. */
export function compactClaudeToolResultMetadata(body: RawJSONLines): RawJSONLines {
  if (body.type !== 'user' || !Array.isArray(body.message.content)) return body;
  const native = body.toolUseResult ?? body.tool_use_result;
  const results = body.message.content.filter((block: unknown) => record(block)?.type === 'tool_result');
  const result = record(results[0]);
  if (results.length !== 1 || typeof result?.tool_use_id !== 'string' || !repeatsNativeBody(result.content, native)) return body;
  const { toolUseResult: _camel, tool_use_result: _snake, ...rest } = body;
  return { ...rest, message: { ...body.message,
    content: body.message.content.map((block: unknown) => block === results[0] ? { ...result, content: native } : block),
  } };
}
