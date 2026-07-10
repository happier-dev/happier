const CLAUDE_PASTED_TEXT_MARKER = /\[\s*Pasted text(?:\s*#\s*\d+)?\s*\+\s*([0-9][0-9,._\s]*)\s+lines?\s*\]/i;
const CLAUDE_PASTED_TEXT_MARKER_ONLY = /^\s*\[\s*Pasted text(?:\s*#\s*\d+)?\s*\+\s*([0-9][0-9,._\s]*)\s+lines?\s*\]\s*$/i;

export function countPromptNewlines(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

export function parseClaudePastedTextMarkerLineCount(text: string): number | null {
  const match = CLAUDE_PASTED_TEXT_MARKER.exec(text);
  if (!match) return null;
  const digits = match[1]?.replace(/\D/g, '') ?? '';
  if (!digits) return null;
  const parsed = Number.parseInt(digits, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parseExactClaudePastedTextMarkerLineCount(text: string): number | null {
  const match = CLAUDE_PASTED_TEXT_MARKER_ONLY.exec(text);
  if (!match) return null;
  const digits = match[1]?.replace(/\D/g, '') ?? '';
  if (!digits) return null;
  const parsed = Number.parseInt(digits, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function pastedTextLineCountMatchesPrompt(params: Readonly<{
  promptText: string;
  pastedLineCount: number;
}>): boolean {
  const expectedNewlines = countPromptNewlines(params.promptText);
  const lowerBound = Math.max(1, expectedNewlines - 2);
  const upperBound = expectedNewlines + 3;
  return params.pastedLineCount >= lowerBound && params.pastedLineCount <= upperBound;
}
