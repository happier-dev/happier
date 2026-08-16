import type { ClaudeScreenState } from './tuiControls/screenState';
import { isClaudeComposerCaptureStyleUnavailablePlaceholderCandidate } from './tuiControls/composerCaptureClassification';
import { hasClaudeUnifiedVisibleDialog } from './tuiControls/dialogRegistry';
import { isControllerTypedSlashCommandResidue } from './tuiControls/slashControls';

export type ClaudeOwnComposerDraftClassification =
  | 'empty'
  | 'own'
  | 'foreign'
  | 'capture_style_unavailable'
  | 'non_input_state'
  | 'provider_unavailable'
  | 'generating';

function hasNonInputComposerState(screen: ClaudeScreenState): boolean {
  return (
    screen.permissionEditorOpen
    || screen.permissionPromptVisible
    || screen.trustFolderPromptVisible
    || hasClaudeUnifiedVisibleDialog(screen)
    || screen.queuedMessageBannerVisible
    || screen.selectionListVisible
  );
}

export function classifyClaudeOwnComposerDraft(params: Readonly<{
  screen: ClaudeScreenState;
  rawText: string;
  ownComposerTexts: Readonly<{ matches: (draft: string) => boolean }>;
  /** Clear-key guards must short-circuit on generation; read-only evaluators may still classify. */
  stopOnGenerating?: boolean | undefined;
}>): ClaudeOwnComposerDraftClassification {
  if (params.screen.usageLimitDialogVisible) return 'provider_unavailable';
  if (params.stopOnGenerating !== false && params.screen.generating) return 'generating';
  if (hasNonInputComposerState(params.screen)) return 'non_input_state';
  if (params.screen.composerContent === null) return 'non_input_state';
  const content = params.screen.composerContent;
  if (content.length === 0) return 'empty';
  if (params.ownComposerTexts.matches(content)) return 'own';
  // Controller-typed slash commands are echo-suppressed out of the persisted transcript, so a
  // respawned registry can never exact-match their residue. The finite controller vocabulary
  // (/model, /effort) is still our own text and stays clearable; everything else stays foreign.
  if (isControllerTypedSlashCommandResidue(content)) return 'own';
  if (isClaudeComposerCaptureStyleUnavailablePlaceholderCandidate(params.rawText, params.screen)) {
    return 'capture_style_unavailable';
  }
  return 'foreign';
}
