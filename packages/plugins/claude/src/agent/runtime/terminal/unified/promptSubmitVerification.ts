import { isExactClaudePastedTextMarker } from './pastedTextMarker.js';
import { isClaudeUnifiedComposerTextMatch } from './promptIdentity.js';
import { parseClaudeScreenState } from './screenState.js';
import { classifyClaudeOwnComposerDraft } from './ownComposerDraftClassification.js';

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function isCollapsedPastedTextComposer(composerContent: string | null): boolean {
  return composerContent !== null
    && isExactClaudePastedTextMarker(composerContent);
}

function isPromptInComposer(params: Readonly<{ promptText: string; screenText: string; beforeSubmit?: boolean }>): boolean {
  const promptText = normalizeNewlines(params.promptText);
  const screen = parseClaudeScreenState(params.screenText);
  const composerContent = screen.composerContent;
  // During this authorized paste, Claude may expose fewer than 256 characters
  // in a small viewport (observed with 2.1.280). Historical draft ownership
  // keeps its stronger threshold; submission must not depend on window size.
  const matches = (composerText: string) => isCollapsedPastedTextComposer(composerText)
    || isClaudeUnifiedComposerTextMatch({
      promptText,
      composerText,
      allowShortVisibleWindow: true,
    });
  if (composerContent !== null && matches(composerContent)) return true;
  if (params.beforeSubmit && classifyClaudeOwnComposerDraft({
    screen, rawText: params.screenText, ownComposerTexts: { matches },
  }) === 'foreign') throw new Error('Claude composer changed before prompt submission');
  return false;
}

export function createClaudePromptSubmitVerificationPolicy() {
  return {
    shouldVerifyAfterSubmit(promptText: string) {
      return normalizeNewlines(promptText).trim().length > 0;
    },
    verifyBeforeSubmitStaging: (params: Readonly<{ promptText: string; screenText: string }>) => isPromptInComposer({ ...params, beforeSubmit: true }),
    verifyAfterSubmit: isPromptInComposer,
  };
}
