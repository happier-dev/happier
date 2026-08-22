import { isExactClaudePastedTextMarker } from './pastedTextMarker.js';
import { isClaudeUnifiedComposerTextMatch } from './promptIdentity.js';
import { parseClaudeScreenState } from './screenState.js';

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function isCollapsedPastedTextComposer(composerContent: string | null): boolean {
  return composerContent !== null
    && isExactClaudePastedTextMarker(composerContent);
}

export function createClaudePromptSubmitVerificationPolicy() {
  return {
    shouldVerifyAfterSubmit(promptText: string) {
      return normalizeNewlines(promptText).trim().length > 0;
    },
    verifyBeforeSubmitStaging(params: Readonly<{ promptText: string; screenText: string }>) {
      const promptText = normalizeNewlines(params.promptText);
      const composerContent = parseClaudeScreenState(params.screenText).composerContent;
      return isCollapsedPastedTextComposer(composerContent)
        || (composerContent !== null && isClaudeUnifiedComposerTextMatch({
          promptText,
          composerText: composerContent,
        }));
    },
    verifyAfterSubmit(params: Readonly<{ promptText: string; screenText: string }>) {
      const promptText = normalizeNewlines(params.promptText);
      const composerContent = parseClaudeScreenState(params.screenText).composerContent;
      return isCollapsedPastedTextComposer(composerContent)
        || (composerContent !== null
          && isClaudeUnifiedComposerTextMatch({ promptText, composerText: composerContent }));
    },
  };
}
