/**
 * Claude records a bracketed-paste prompt wrapped in its own paste markers, each on its own line:
 *
 *   <pasted_content id="9b65">
 *   …the pasted text…
 *   </pasted_content id="9b65">
 *
 * The closing marker repeats the id, so this is not XML. The markers describe how the text
 * reached the composer, never what the prompt says, so prompt identity is the unwrapped text on
 * both sides of the terminal round-trip. Observed on Claude Code 2.1.259 (live incident
 * 2026-09-18, session cmtyf86rp1a1ttm237czmr4ts): without this, every multi-line prompt Happier
 * pastes reads back as different text, so provider acceptance never correlates and the delivered
 * message stays "delivering" forever.
 */
const CLAUDE_PASTED_CONTENT_MARKER_LINE = /^<\/?pasted_content id="[^"]*">$/;

export function normalizeClaudeUnifiedPromptIdentityText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    // Claude's native paste editor expands each tab to four spaces before hooks and JSONL.
    // Keep every acceptance and echo consumer on this same provider identity rule.
    .replaceAll('\t', '    ')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !CLAUDE_PASTED_CONTENT_MARKER_LINE.test(line))
    .join('\n')
    .trim();
}

/**
 * Claude may render one logical composer value across several terminal rows. This form is used
 * for recorded candidate text; matching also handles row breaks within tokens below.
 */
export function normalizeClaudeUnifiedComposerRenderingText(value: string): string {
  return normalizeClaudeUnifiedPromptIdentityText(value).replace(/\s+/g, ' ');
}

export const CLAUDE_UNIFIED_LONG_COMPOSER_RESIDUE_MIN_CHARS = 256;

/**
 * Match the complete logical composer text, or a sufficiently long visible window when Claude's
 * terminal viewport exposes only part of a longer draft. The cursor may leave that window at the
 * beginning, middle, or end of the prompt. A captured row break may fall at a word boundary or
 * inside a token; the actual characters on each row must still match the prompt.
 */
export function isClaudeUnifiedComposerTextMatch(params: Readonly<{
  promptText: string;
  composerText: string;
  minPrefixChars?: number | undefined;
  /** Only for verification of the current authorized paste, never historical draft ownership. */
  allowShortVisibleWindow?: boolean | undefined;
}>): boolean {
  const promptText = normalizeClaudeUnifiedComposerRenderingText(params.promptText);
  const composerLines = normalizeClaudeUnifiedPromptIdentityText(params.composerText)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!promptText || composerLines.length === 0) return false;
  const composerLength = composerLines.join(' ').length;

  const minPrefixChars = Math.max(
    1,
    Math.trunc(params.minPrefixChars ?? CLAUDE_UNIFIED_LONG_COMPOSER_RESIDUE_MIN_CHARS),
  );
  // A captured row break can stand for either an actual whitespace boundary or no character at
  // all when the terminal wraps inside a URL or JSON token. Keep spaces within each row required.
  const firstLine = composerLines[0]!;
  const remainingLines = composerLines.slice(1);
  for (let start = promptText.indexOf(firstLine); start !== -1; start = promptText.indexOf(firstLine, start + 1)) {
    let end = start + firstLine.length;
    let matches = true;
    for (const line of remainingLines) {
      if (promptText.startsWith(line, end)) {
        end += line.length;
      } else if (promptText[end] === ' ' && promptText.startsWith(line, end + 1)) {
        end += line.length + 1;
      } else {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (start === 0 && end === promptText.length) return true;
    if (params.allowShortVisibleWindow) return true;
    if (composerLength >= CLAUDE_UNIFIED_LONG_COMPOSER_RESIDUE_MIN_CHARS) return true;
    // Short possible-write residues are prefix-only so a genuine user draft that merely shares
    // a phrase with an earlier injection is never treated as controller-owned.
    if (start === 0 && composerLength >= minPrefixChars) return true;
  }
  return false;
}
