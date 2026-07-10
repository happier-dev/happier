const SGR_SEQUENCE_PREFIX = '\u001b[';
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?/gu;

export { SGR_SEQUENCE_PREFIX };

function stripTerminalControlSequences(text: string): string {
  return text.replace(ANSI_SEQUENCE, '');
}

function readRawComposerLinesForContent(rawText: string, content: string): string[] {
  if (content.length === 0) return [];
  const lines = rawText.replace(/\r\n?/g, '\n').split('\n');
  const matches: string[] = [];
  for (const rawLine of lines) {
    const stripped = stripTerminalControlSequences(rawLine);
    if (!/[>›❯]/u.test(stripped)) continue;
    if (!stripped.includes(content)) continue;
    matches.push(rawLine);
  }
  return matches;
}

export function hasComposerLineStyleEvidence(rawText: string, content: string): boolean {
  return readRawComposerLinesForContent(rawText, content)
    .some((line) => line.includes(SGR_SEQUENCE_PREFIX));
}
