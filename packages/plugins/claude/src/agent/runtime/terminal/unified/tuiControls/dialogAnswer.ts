import type { TerminalControlPort } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import { captureScreenState, sendResultToFailure } from './controlRuntime.js';
import {
  resolveClaudeUnifiedVisibleDialog,
  type ClaudeUnifiedDialogId,
  type ClaudeUnifiedDialogOption,
  type ClaudeUnifiedRecognizedDialogId,
} from './dialogRegistry.js';

/**
 * The ONE recipe-driven answerer for every recognized Claude Unified dialog. It replaces the
 * per-dialog `answerClaude*Dialog` helpers so there is a single owner for "type the option and
 * press Enter". It always RECAPTURES the screen before typing and re-resolves the visible dialog
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

function captureFailureReason(
  failure: Extract<Awaited<ReturnType<typeof captureScreenState>>, { kind: 'host_dead' | 'capture_failed' }>,
): string {
  return failure.kind === 'host_dead'
    ? `host_dead:${failure.recoverable ? 'recoverable' : 'unrecoverable'}`
    : failure.reason;
}

export async function answerClaudeUnifiedRegisteredDialog(params: Readonly<{
  port: TerminalControlPort;
  dialogId: ClaudeUnifiedRecognizedDialogId;
  option: ClaudeUnifiedDialogOption;
  settleMs: number;
  wait: (ms: number) => Promise<void>;
}>): Promise<ClaudeUnifiedDialogAnswerResult> {
  const before = await captureScreenState(params.port);
  if (before.kind !== 'state') return failed(captureFailureReason(before));

  const beforeDialog = resolveClaudeUnifiedVisibleDialog(before.state);
  if (!beforeDialog) return { status: 'not_visible' };
  if (beforeDialog.dialogId !== params.dialogId) {
    return { status: 'dialog_changed', dialogId: beforeDialog.dialogId };
  }

  const literalFailure = sendResultToFailure(await params.port.sendLiteralText(params.option.answer.text));
  if (literalFailure) return failed(literalFailure.reason ?? literalFailure.kind);
  const enterFailure = sendResultToFailure(await params.port.sendSpecialKey('Enter'));
  if (enterFailure) return failed(enterFailure.reason ?? enterFailure.kind);

  await params.wait(params.settleMs);
  const after = await captureScreenState(params.port);
  if (after.kind !== 'state') return failed(captureFailureReason(after));

  const afterDialog = resolveClaudeUnifiedVisibleDialog(after.state);
  return afterDialog?.dialogId === params.dialogId
    ? failed('dialog_still_visible')
    : { status: 'answered' };
}
