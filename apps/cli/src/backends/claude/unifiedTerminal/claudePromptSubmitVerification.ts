import type { TerminalPromptSubmitVerificationPolicy } from '@/integrations/terminalHost/promptSubmitVerification';
import { isExactClaudePastedTextMarker } from './claudePastedTextMarker';
import { isClaudeUnifiedComposerTextMatch } from './promptIdentity';
import { classifyClaudeOwnComposerDraft } from './ownComposerDraftClassification';
import { parseClaudeScreenState } from './tuiControls/screenState';

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function isCollapsedPastedTextComposer(composerContent: string | null): boolean {
  return composerContent !== null
    && isExactClaudePastedTextMarker(composerContent);
}

function shouldVerifyAfterSubmit(promptText: string): boolean {
  return normalizeNewlines(promptText).trim().length > 0;
}

function isPromptInComposer(params: Readonly<{
  promptText: string;
  screenText: string;
  beforeSubmit?: boolean;
}>): boolean {
  const state = parseClaudeScreenState(params.screenText);
  const matches = (composerText: string) => isCollapsedPastedTextComposer(composerText)
    || isClaudeUnifiedComposerTextMatch({
      promptText: params.promptText,
      composerText,
      // During this authorized paste, Claude may expose fewer than 256 characters
      // in a small viewport (observed with 2.1.280). Historical draft ownership
      // keeps its stronger threshold; submission must not depend on window size.
      allowShortVisibleWindow: true,
    });
  if (state.composerContent !== null && matches(state.composerContent)) return true;
  // A prompt that starts with `!` flips Claude into bash mode on paste and shows up on the bash-mode
  // prompt line, which is not a message composer and so never appears in `composerContent`.
  if (params.promptText.startsWith('!')
    && state.shellComposerContent !== null
    && matches(state.shellComposerContent)) return true;
  if (params.beforeSubmit && classifyClaudeOwnComposerDraft({
    screen: state,
    rawText: params.screenText,
    ownComposerTexts: { matches },
    stopOnGenerating: false,
  }) === 'foreign') {
    throw new Error('Claude composer changed before prompt submission');
  }
  return false;
}

export function createClaudePromptSubmitVerificationPolicy(): TerminalPromptSubmitVerificationPolicy {
  return {
    shouldVerifyAfterSubmit,
    isPromptStagedBeforeSubmit: (params) => isPromptInComposer({ ...params, beforeSubmit: true }),
    isPromptStillPendingAfterSubmit: isPromptInComposer,
  };
}
