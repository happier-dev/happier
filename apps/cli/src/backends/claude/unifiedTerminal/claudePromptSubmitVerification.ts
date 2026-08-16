import type { TerminalPromptSubmitVerificationPolicy } from '@/integrations/terminalHost/promptSubmitVerification';
import { isExactClaudePastedTextMarker } from './claudePastedTextMarker';
import { isClaudeUnifiedComposerTextMatch } from './promptIdentity';
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

function isPromptStillPendingAfterSubmit(params: Readonly<{
  promptText: string;
  screenText: string;
}>): boolean {
  const state = parseClaudeScreenState(params.screenText);
  return isCollapsedPastedTextComposer(state.composerContent)
    || (state.composerContent !== null && isClaudeUnifiedComposerTextMatch({
      promptText: params.promptText,
      composerText: state.composerContent,
    }));
}

function isPromptStagedBeforeSubmit(params: Readonly<{
  promptText: string;
  screenText: string;
}>): boolean {
  const promptText = normalizeNewlines(params.promptText);
  const state = parseClaudeScreenState(params.screenText);
  return isCollapsedPastedTextComposer(state.composerContent)
    || (state.composerContent !== null && isClaudeUnifiedComposerTextMatch({
      promptText,
      composerText: state.composerContent,
    }));
}

export function createClaudePromptSubmitVerificationPolicy(): TerminalPromptSubmitVerificationPolicy {
  return {
    shouldVerifyAfterSubmit,
    isPromptStagedBeforeSubmit,
    isPromptStillPendingAfterSubmit,
  };
}
