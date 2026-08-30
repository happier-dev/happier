/**
 * Normalize a Claude model name for display inside an already Claude-scoped picker.
 *
 * Anthropic's model surfaces may return names such as `Claude Sonnet 5`; the surrounding UI
 * already identifies the provider as Claude, so repeating that prefix makes dynamic rows diverge
 * from curated rows such as `Sonnet 5`. Non-Claude gateway model names remain unchanged.
 */
export function normalizeClaudeModelDisplayName(nameRaw: unknown, fallback: string): string {
  const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
  const prefixed = /^claude\s+(.+)$/iu.exec(name);
  return prefixed?.[1]?.trim() || name || fallback.trim();
}
