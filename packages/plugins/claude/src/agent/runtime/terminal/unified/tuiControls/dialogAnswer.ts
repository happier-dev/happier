import type { TerminalControlPort } from '@happier-dev/plugin-sdk/agents/runtime';

import { captureScreenState, sendResultToFailure } from './controlRuntime.js';
import {
  getClaudeUnifiedDialogIdentity,
  resolveClaudeUnifiedVisibleDialog,
  type ClaudeUnifiedDialogId,
  type ClaudeUnifiedDialogOption,
} from './dialogRegistry.js';
import { DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS } from './types.js';

/**
 * The ONE recipe-driven answerer for every recognized Claude Unified dialog. It replaces the
 * per-dialog `answerClaude*Dialog` helpers so there is a single owner for the option's exact answer
 * recipe. It always RECAPTURES the screen before typing and re-resolves the visible dialog
 * from the registry: if the recaptured dialog id no longer matches the one the caller decided to
 * answer (an A→B dialog replacement between the publish decision and the keystroke), it types
 * NOTHING and reports `dialog_changed` so the caller can cancel and republish for the new dialog.
 */
export type ClaudeUnifiedDialogAnswerResult =
  | Readonly<{ status: 'answered' }>
  | Readonly<{ status: 'not_visible' }>
  | Readonly<{ status: 'dialog_changed'; dialogId: ClaudeUnifiedDialogId | null }>
  | Readonly<{ status: 'failed'; reason: string }>;

function failed(reason: string): ClaudeUnifiedDialogAnswerResult {
  return { status: 'failed', reason };
}

export type ClaudeUnifiedDialogOptionSubmissionResult =
  | Readonly<{ status: 'submitted' }>
  | Readonly<{ status: 'failed'; reason: string }>;

/**
 * The one terminal-write owner for a registered Claude numbered-dialog option. Claude's numeric
 * hotkeys submit immediately; appending Enter can submit into the next composer after the dialog
 * closes (for resume-from-summary this can start a second `/compact`).
 */
export async function submitClaudeUnifiedDialogOption(params: Readonly<{
  port: TerminalControlPort;
  option: ClaudeUnifiedDialogOption;
  onSubmitted?: (() => void) | undefined;
}>): Promise<ClaudeUnifiedDialogOptionSubmissionResult> {
  const literalFailure = sendResultToFailure(await params.port.sendLiteralText(params.option.answer.text));
  if (literalFailure) {
    return { status: 'failed', reason: literalFailure.reason ?? literalFailure.kind };
  }
  params.onSubmitted?.();
  return { status: 'submitted' };
}

function captureFailureReason(
  failure: Extract<Awaited<ReturnType<typeof captureScreenState>>, { kind: 'host_dead' | 'capture_failed' }>,
): string {
  return failure.kind === 'host_dead'
    ? `host_dead:${failure.recoverable ? 'recoverable' : 'unrecoverable'}`
    : failure.reason;
}

export async function answerClaudeUnifiedRegisteredDialog(params: Readonly<{
  port: TerminalControlPort;
  dialogId: ClaudeUnifiedDialogId;
  expectedIdentity?: string | undefined;
  option: ClaudeUnifiedDialogOption;
  settleMs: number;
  wait: (ms: number) => Promise<void>;
  /** Fired after the option's complete answer recipe was successfully written to the terminal. */
  onSubmitted?: (() => void) | undefined;
}>): Promise<ClaudeUnifiedDialogAnswerResult> {
  const before = await captureScreenState(params.port);
  if (before.kind !== 'state') return failed(captureFailureReason(before));

  const beforeDialog = resolveClaudeUnifiedVisibleDialog(before.state);
  if (!beforeDialog) return { status: 'not_visible' };
  if (
    beforeDialog.dialogId !== params.dialogId
    || (params.expectedIdentity !== undefined && getClaudeUnifiedDialogIdentity(beforeDialog) !== params.expectedIdentity)
  ) {
    return { status: 'dialog_changed', dialogId: beforeDialog.dialogId };
  }

  const submission = await submitClaudeUnifiedDialogOption({
    port: params.port,
    option: params.option,
    onSubmitted: params.onSubmitted,
  });
  if (submission.status === 'failed') return failed(submission.reason);

  const { verifyPollIntervalMs, verifyPollTimeoutMs } = DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS;
  const maxVerifyPolls = Math.max(1, Math.ceil(verifyPollTimeoutMs / verifyPollIntervalMs));
  for (let poll = 0; poll < maxVerifyPolls; poll += 1) {
    await params.wait(poll === 0 ? params.settleMs : verifyPollIntervalMs);
    const after = await captureScreenState(params.port);
    if (after.kind !== 'state') return failed(captureFailureReason(after));

    const afterDialog = resolveClaudeUnifiedVisibleDialog(after.state);
    const sameDialog = afterDialog && (
      params.expectedIdentity === undefined
        ? afterDialog.dialogId === params.dialogId
        : getClaudeUnifiedDialogIdentity(afterDialog) === params.expectedIdentity
    );
    if (!sameDialog) return { status: 'answered' };
  }
  return failed('dialog_still_visible');
}
