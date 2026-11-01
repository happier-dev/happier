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
    return { ...result, content: { content: existing, tool_use_result: toolUseResult } };
  });
}
