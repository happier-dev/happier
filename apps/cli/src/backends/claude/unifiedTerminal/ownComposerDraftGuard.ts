import { parseClaudeScreenState, type ClaudeScreenState } from './tuiControls/screenState';
import { classifyClaudeOwnComposerDraft } from './ownComposerDraftClassification';
import { resolveClaudeUnifiedDialogBlockedReason } from './tuiControls/dialogRegistry';

const DEFAULT_DRAFT_CLEAR_SETTLE_MS = 250;
// Same bounded semantics as the slash-control leftover clear (lane U): one clear key can leave the
// draft text behind, so allow a second press before giving up.
export const MAX_OWN_LEFTOVER_DRAFT_CLEAR_ATTEMPTS = 2;

export type OwnComposerDraftGuardResult =
  | Readonly<{ status: 'no_draft'; screen: ClaudeScreenState }>
  | Readonly<{ status: 'cleared'; screen: ClaudeScreenState; attempts: number }>
  /** Composer holds text we did NOT write — a genuine user draft that must never be touched. */
  | Readonly<{ status: 'foreign_draft'; screen: ClaudeScreenState }>
  /** Composer text may be a dim Claude suggestion, but the capture lacks style evidence. */
  | Readonly<{ status: 'capture_style_unavailable'; screen: ClaudeScreenState }>
  /** Provider is known unavailable from the visible Claude TUI state; this is not a user draft. */
  | Readonly<{ status: 'provider_unavailable'; screen: ClaudeScreenState }>
  /** A dialog/editor/selection state owns input; this is not a user draft. */
  | Readonly<{ status: 'blocked_non_input_state'; screen: ClaudeScreenState; blockedReason: string }>
  /** Screen is generating: the clear key (Escape) would interrupt the running turn. */
  | Readonly<{ status: 'generating'; screen: ClaudeScreenState }>
  | Readonly<{ status: 'capture_failed' }>
  | Readonly<{ status: 'clear_failed'; screen: ClaudeScreenState }>;

/**
 * C11 (incident cmq8y3nlx): bounded clear of OUR OWN leftover composer text before acting on the
 * composer. The leftover classifier is the own-injected-text registry (`ownComposerTextLog`,
 * respawn-seeded from the persisted prompt store), so both the in-flight steer evaluator and the
 * idle pre-injection guard share one owner for "is this draft ours?" — a genuine user draft is
 * NEVER touched, and nothing is cleared while the screen is generating.
 *
 * Live-proven defect this guards (runner pid 83791, 09:34): idle injection typed the new prompt
 * AFTER a predecessor's leftover injection and submitted the concatenation as one corrupted prompt.
 */
export async function clearOwnLeftoverComposerDraft(opts: Readonly<{
  captureInputState: () => Promise<Readonly<{
    currentInput: string;
    cursor?: Readonly<{ x: number; y: number }> | undefined;
  }>>;
  /** Sends ONE composer-clear keypress (Escape). Only invoked for exact-match own leftovers. */
  sendClearKey: () => Promise<void>;
  ownComposerTexts: Readonly<{ matches: (draft: string) => boolean }>;
  settleMs?: number | undefined;
  wait?: ((ms: number) => Promise<void>) | undefined;
  /** Telemetry tap: fired after each clear attempt with the recaptured screen. */
  onClearAttempt?: ((info: Readonly<{ attempt: number; screen: ClaudeScreenState }>) => void) | undefined;
}>): Promise<OwnComposerDraftGuardResult> {
  const settleMs = Math.max(0, Math.trunc(opts.settleMs ?? DEFAULT_DRAFT_CLEAR_SETTLE_MS));
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));

  async function capture(): Promise<Readonly<{ screen: ClaudeScreenState; rawText: string }> | null> {
    try {
      const inputState = await opts.captureInputState();
      const rawText = inputState.currentInput;
      return { screen: parseClaudeScreenState(rawText, { cursor: inputState.cursor }), rawText };
    } catch {
      return null;
    }
  }

  function classify(captureResult: Readonly<{ screen: ClaudeScreenState; rawText: string }>) {
    return classifyClaudeOwnComposerDraft({
      screen: captureResult.screen,
      rawText: captureResult.rawText,
      ownComposerTexts: opts.ownComposerTexts,
    });
  }

  function resolveBlockedNonInputReason(screen: ClaudeScreenState): string {
    const dialogReason = resolveClaudeUnifiedDialogBlockedReason(screen);
    if (dialogReason) return dialogReason;
    if (screen.permissionPromptVisible) return 'permission_prompt';
    if (screen.trustFolderPromptVisible) return 'trust_folder_prompt';
    if (screen.permissionEditorOpen) return 'permission_editor';
    if (screen.selectionListVisible) return 'selection_list';
    if (screen.queuedMessageBannerVisible) return 'queued_message_banner';
    if (screen.generating) return 'generating';
    if (screen.composerContent === null) return 'no_interactive_composer';
    return 'non_input_state';
  }

  let captured = await capture();
  if (!captured) return { status: 'capture_failed' };
  let screen = captured.screen;
  switch (classify(captured)) {
    case 'empty':
      return { status: 'no_draft', screen };
    case 'generating':
      return { status: 'generating', screen };
    case 'provider_unavailable':
      return { status: 'provider_unavailable', screen };
    case 'non_input_state':
      return { status: 'blocked_non_input_state', screen, blockedReason: resolveBlockedNonInputReason(screen) };
    case 'capture_style_unavailable':
      return { status: 'capture_style_unavailable', screen };
    case 'foreign':
      return { status: 'foreign_draft', screen };
    case 'own':
      break;
  }

  for (let attempt = 1; attempt <= MAX_OWN_LEFTOVER_DRAFT_CLEAR_ATTEMPTS; attempt += 1) {
    try {
      await opts.sendClearKey();
    } catch {
      return { status: 'clear_failed', screen };
    }
    await wait(settleMs);
    const recaptured = await capture();
    if (!recaptured) return { status: 'capture_failed' };
    captured = recaptured;
    screen = recaptured.screen;
    opts.onClearAttempt?.({ attempt, screen });
    switch (classify(captured)) {
      case 'empty':
        return { status: 'cleared', screen, attempts: attempt };
      case 'generating':
        return { status: 'generating', screen };
      case 'provider_unavailable':
        return { status: 'provider_unavailable', screen };
      case 'non_input_state':
        return { status: 'blocked_non_input_state', screen, blockedReason: resolveBlockedNonInputReason(screen) };
      case 'capture_style_unavailable':
        return { status: 'capture_style_unavailable', screen };
      case 'foreign':
        // The draft changed under us (user started typing): stop immediately, never touch it.
        return { status: 'foreign_draft', screen };
      case 'own':
        break;
    }
  }
  return { status: 'clear_failed', screen };
}
