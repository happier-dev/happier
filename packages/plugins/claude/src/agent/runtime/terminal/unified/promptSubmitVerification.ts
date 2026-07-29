import {
  parseClaudePastedTextMarkerLineCount,
  pastedTextLineCountMatchesPrompt,
} from './pastedTextMarker.js';
import { parseClaudeScreenState } from './screenState.js';

const COMPOSER_LINE_PROMPT = /(?:^|[│|]\s*)[>›❯](?!\s*(?:\d+\.|[◯◉○●◐◑]))/u;

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function isLikelyTerminalFooterLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^[─━═┄┈\-\s]+$/.test(trimmed)) return true;
  if (/^(?:▶+|▸+|⏵+|>>)\s/.test(trimmed)) return true;
  return false;
}

function readPostSubmitPastedTextLineCount(screenText: string): number | null {
  const lines = normalizeNewlines(screenText).split('\n');
  let lastContentLineIndex = lines.length - 1;
  while (lastContentLineIndex >= 0 && lines[lastContentLineIndex]?.trim().length === 0) {
    lastContentLineIndex -= 1;
  }
  if (lastContentLineIndex < 0) return null;

  const bottomLineCount = parseClaudePastedTextMarkerLineCount(lines[lastContentLineIndex] ?? '');
  if (bottomLineCount !== null) return bottomLineCount;

  for (let index = lastContentLineIndex - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    const pastedLineCount = parseClaudePastedTextMarkerLineCount(line);
    if (pastedLineCount === null) continue;
    if (!COMPOSER_LINE_PROMPT.test(line)) return null;

    for (let after = index + 1; after <= lastContentLineIndex; after += 1) {
      const afterLine = lines[after] ?? '';
      if (isLikelyTerminalFooterLine(afterLine)) continue;
      if (COMPOSER_LINE_PROMPT.test(afterLine)) return null;
      return null;
    }
    return pastedLineCount;
  }
  return null;
}

export function createClaudePromptSubmitVerificationPolicy() {
  return {
    shouldVerifyBeforeSubmit() {
      return false;
    },
    verifyBeforeSubmit() {
      return true;
    },
    shouldVerifyAfterSubmit(promptText: string) {
      return normalizeNewlines(promptText).trim().length > 0;
    },
    verifyAfterSubmit(params: Readonly<{ promptText: string; screenText: string }>) {
      const promptText = normalizeNewlines(params.promptText);
      const pastedLineCount = readPostSubmitPastedTextLineCount(params.screenText);
      if (
        pastedLineCount !== null
        && pastedTextLineCountMatchesPrompt({ promptText, pastedLineCount })
      ) {
        return true;
      }

      const exactPrompt = promptText.trim();
      if (!exactPrompt) return false;
      const composerContent = parseClaudeScreenState(params.screenText).composerContent;
      return composerContent !== null
        && normalizeNewlines(composerContent).trim() === exactPrompt;
    },
  };
}
