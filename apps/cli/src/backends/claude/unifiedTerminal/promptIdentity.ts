export function normalizeClaudeUnifiedPromptIdentityText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/**
 * Claude may render one logical composer value across several terminal rows. Treat those visual
 * whitespace breaks as presentation only while retaining the exact normalized word sequence.
 */
export function normalizeClaudeUnifiedComposerRenderingText(value: string): string {
  return normalizeClaudeUnifiedPromptIdentityText(value).replace(/\s+/g, ' ');
}

export const CLAUDE_UNIFIED_LONG_COMPOSER_RESIDUE_MIN_CHARS = 256;

export function isClaudeUnifiedComposerTextExactMatch(params: Readonly<{
  promptText: string;
  composerText: string;
}>): boolean {
  const promptText = normalizeClaudeUnifiedComposerRenderingText(params.promptText);
  const composerText = normalizeClaudeUnifiedComposerRenderingText(params.composerText);
  return promptText.length > 0 && composerText === promptText;
}

/**
 * Match the complete logical composer text, or a sufficiently long visible prefix when Claude's
 * terminal viewport exposes only the beginning of a longer draft. Both sides use the same
 * soft-wrap-insensitive identity so terminal row wrapping is presentation, not prompt content.
 */
export function isClaudeUnifiedComposerTextMatch(params: Readonly<{
  promptText: string;
  composerText: string;
  minPrefixChars?: number | undefined;
}>): boolean {
  const promptText = normalizeClaudeUnifiedComposerRenderingText(params.promptText);
  const composerText = normalizeClaudeUnifiedComposerRenderingText(params.composerText);
  if (!promptText || !composerText) return false;
  if (composerText === promptText) return true;

  const minPrefixChars = Math.max(
    1,
    Math.trunc(params.minPrefixChars ?? CLAUDE_UNIFIED_LONG_COMPOSER_RESIDUE_MIN_CHARS),
  );
  return composerText.length >= minPrefixChars
    && promptText.length > composerText.length
    && promptText.startsWith(composerText);
}
