import type { TerminalControlPort } from '@/integrations/terminalHost/controlTypes';

import { captureScreenState, sendResultToFailure } from './controlRuntime';
import type { ClaudeScreenState } from './screenState';
import {
  getClaudeUnifiedDialogIdentity,
  resolveClaudeUnifiedVisibleDialog,
  type ClaudeUnifiedDialogId,
  type ClaudeUnifiedVisibleDialog,
} from './dialogRegistry';

export type ClaudeUnifiedDialogAnswerResult =
  | Readonly<{ status: 'answered' }>
  | Readonly<{ status: 'not_visible' }>
  | Readonly<{ status: 'dialog_changed'; dialog: ClaudeUnifiedVisibleDialog }>
  | Readonly<{ status: 'failed'; reason: string }>;

function failed(reason: string): ClaudeUnifiedDialogAnswerResult {
  return { status: 'failed', reason };
}

function captureFailureReason(
  result: Exclude<Awaited<ReturnType<typeof captureScreenState>>, { kind: 'state' }>,
): string {
  return result.kind === 'host_dead'
    ? `host_dead:${result.recoverable ? 'recoverable' : 'unrecoverable'}`
    : result.reason;
}

async function sendKey(port: TerminalControlPort, key: 'ArrowUp' | 'ArrowDown' | 'Enter') {
  const failure = sendResultToFailure(await port.sendSpecialKey(key));
  return failure ? failed(('reason' in failure ? failure.reason : undefined) ?? failure.kind) : null;
}

export async function answerClaudeUnifiedRegisteredDialog(params: Readonly<{
  port: TerminalControlPort;
  dialogId: ClaudeUnifiedDialogId;
  expectedIdentity?: string | undefined;
  choice: string;
  initialState?: ClaudeScreenState | undefined;
  verifyAfterSubmit?: boolean | undefined;
  settleMs: number;
  wait: (ms: number) => Promise<void>;
  verifyPollIntervalMs?: number | undefined;
  verifyPollTimeoutMs?: number | undefined;
  onSubmitted?: (() => void) | undefined;
}>): Promise<ClaudeUnifiedDialogAnswerResult> {
  let captured = params.initialState
    ? { kind: 'state' as const, state: params.initialState }
    : await captureScreenState(params.port);
  if (captured.kind !== 'state') return failed(captureFailureReason(captured));
  let dialog = resolveClaudeUnifiedVisibleDialog(captured.state);
  if (!dialog) return { status: 'not_visible' };
  const identity = params.expectedIdentity ?? getClaudeUnifiedDialogIdentity(dialog);
  if (dialog.dialogId !== params.dialogId || getClaudeUnifiedDialogIdentity(dialog) !== identity) {
    return { status: 'dialog_changed', dialog };
  }

  let currentOption = dialog.options.find((candidate) => (
    candidate.choice === params.choice
  ));
  if (!currentOption) return { status: 'dialog_changed', dialog };
  if (currentOption.answer.kind === 'unavailable') return failed('selection_unavailable');

  if (currentOption.answer.kind === 'literal') {
    const failure = sendResultToFailure(await params.port.sendLiteralText(currentOption.answer.text));
    if (failure) return failed(('reason' in failure ? failure.reason : undefined) ?? failure.kind);
  } else {
    const targetLabel = currentOption.answer.targetLabel;
    const maxSteps = Math.max(1, captured.state.visibleDialogSelection?.options.length ?? 0);
    let submitted = false;
    for (let step = 0; step <= maxSteps; step += 1) {
      const presentation = captured.state.visibleDialogSelection;
      if (!presentation || presentation.kind !== 'focused') return failed('selection_presentation_changed');
      const targetIndexes = presentation.options.flatMap((candidate, index) => (
        candidate.label === targetLabel ? [index] : []
      ));
      const targetIndex = targetIndexes[0] ?? -1;
      const focusedIndexes = presentation.options.flatMap((candidate, index) => candidate.focused ? [index] : []);
      if (targetIndexes.length !== 1 || focusedIndexes.length !== 1) return failed('selection_ambiguous');
      const focusedIndex = focusedIndexes[0]!;
      if (focusedIndex === targetIndex) {
        const failure = await sendKey(params.port, 'Enter');
        if (failure) return failure;
        submitted = true;
        break;
      }
      const direction = targetIndex > focusedIndex ? 'ArrowDown' : 'ArrowUp';
      const failure = await sendKey(params.port, direction);
      if (failure) return failure;
      await params.wait(params.settleMs);
      const next = await captureScreenState(params.port);
      if (next.kind !== 'state') return failed(captureFailureReason(next));
      const nextDialog = resolveClaudeUnifiedVisibleDialog(next.state);
      if (!nextDialog) return failed('dialog_disappeared_during_navigation');
      if (nextDialog.dialogId !== params.dialogId || getClaudeUnifiedDialogIdentity(nextDialog) !== identity) {
        return { status: 'dialog_changed', dialog: nextDialog };
      }
      const nextFocused = next.state.visibleDialogSelection?.options.findIndex((candidate) => candidate.focused) ?? -1;
      if (nextFocused === focusedIndex) return failed('selection_did_not_move');
      captured = next;
      dialog = nextDialog;
      currentOption = dialog.options.find((candidate) => (
        candidate.choice === params.choice
      ));
      if (!currentOption || currentOption.answer.kind !== 'selection') {
        return failed('selection_presentation_changed');
      }
    }
    if (!submitted) return failed('selection_target_unreachable');
  }

  params.onSubmitted?.();
  if (params.verifyAfterSubmit === false) return { status: 'answered' };
  const pollIntervalMs = Math.max(1, params.verifyPollIntervalMs ?? 25);
  const timeoutMs = Math.max(pollIntervalMs, params.verifyPollTimeoutMs ?? 2_000);
  const polls = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  for (let poll = 0; poll < polls; poll += 1) {
    await params.wait(poll === 0 ? params.settleMs : pollIntervalMs);
    const after = await captureScreenState(params.port);
    if (after.kind !== 'state') return failed(captureFailureReason(after));
    const remaining = resolveClaudeUnifiedVisibleDialog(after.state);
    if (!remaining || getClaudeUnifiedDialogIdentity(remaining) !== identity) return { status: 'answered' };
  }
  return failed('dialog_still_visible');
}
