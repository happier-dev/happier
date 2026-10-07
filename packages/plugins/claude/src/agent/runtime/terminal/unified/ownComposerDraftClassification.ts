import type { ClaudeScreenState } from './screenState.js';
import { isClaudeComposerCaptureStyleUnavailablePlaceholderCandidate } from './composerCaptureClassification.js';
import { hasClaudeUnifiedVisibleDialog } from './tuiControls/dialogRegistry.js';
import { isControllerTypedSlashCommandResidue } from './tuiControls/slashControls.js';

export type ClaudeOwnComposerDraftClassification =
  | 'empty' | 'own' | 'foreign' | 'capture_style_unavailable'
  | 'non_input_state' | 'provider_unavailable';

export function classifyClaudeOwnComposerDraft(params: Readonly<{
  screen: ClaudeScreenState;
  rawText: string;
  ownComposerTexts: Readonly<{ matches: (draft: string) => boolean }>;
}>): ClaudeOwnComposerDraftClassification {
  const screen = params.screen;
  if (screen.usageLimitDialogVisible) return 'provider_unavailable';
  if (screen.permissionEditorOpen || screen.permissionPromptVisible || screen.trustFolderPromptVisible
    || hasClaudeUnifiedVisibleDialog(screen) || screen.queuedMessageBannerVisible || screen.selectionListVisible
    || screen.composerContent === null) return 'non_input_state';
  const content = screen.composerContent;
  if (content.length === 0) return 'empty';
  if (params.ownComposerTexts.matches(content) || isControllerTypedSlashCommandResidue(content)) return 'own';
  if (isClaudeComposerCaptureStyleUnavailablePlaceholderCandidate(params.rawText, screen)) return 'capture_style_unavailable';
  return 'foreign';
}
