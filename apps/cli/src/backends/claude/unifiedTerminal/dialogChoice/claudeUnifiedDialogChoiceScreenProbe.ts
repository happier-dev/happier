import type { TerminalControlPort } from '@/integrations/terminalHost/controlTypes';
import { logger } from '@/ui/logger';

import {
  captureFailureToResult,
  captureScreenState,
} from '../tuiControls/controlRuntime';
import { answerClaudeUnifiedRegisteredDialog } from '../tuiControls/dialogAnswer';
import {
  resolveClaudeUnifiedVisibleDialog,
  getClaudeUnifiedDialogIdentity,
  type ClaudeUnifiedDialogId,
  type ClaudeUnifiedVisibleDialog,
} from '../tuiControls/dialogRegistry';
import type { ClaudeScreenState } from '../tuiControls/screenState';
import type {
  ClaudeUnifiedDialogChoiceBroker,
  ClaudeUnifiedDialogChoiceDecision,
} from './claudeUnifiedDialogChoiceBroker';

export type ClaudeUnifiedDialogChoiceScreenProbeResult =
  | Readonly<{ kind: 'request_published'; dialogId: ClaudeUnifiedDialogId }>
  | Readonly<{ kind: 'already_pending'; dialogId: ClaudeUnifiedDialogId }>
  | Readonly<{ kind: 'automatic_answer_started'; dialogId: ClaudeUnifiedDialogId }>
  | Readonly<{ kind: 'owned'; dialogId: ClaudeUnifiedDialogId }>
  | Readonly<{ kind: 'not_visible' }>
  | Readonly<{ kind: 'failed'; reason: string }>
  | Readonly<{ kind: 'unsupported'; reason?: string | undefined }>;

export type ClaudeUnifiedDialogChoiceScreenProbe = Readonly<{
  probe: () => Promise<ClaudeUnifiedDialogChoiceScreenProbeResult>;
  evaluateScreenState: (state: ClaudeScreenState) => Promise<ClaudeUnifiedDialogChoiceScreenProbeResult>;
  dispose: () => void;
}>;

function captureFailureResult(
  captured: Awaited<ReturnType<typeof captureScreenState>>,
): ClaudeUnifiedDialogChoiceScreenProbeResult | null {
  if (captured.kind === 'state') return null;
  const failure = captureFailureToResult(captured);
  if (failure?.kind === 'unsupported') return { kind: 'unsupported', reason: failure.reason };
  return { kind: 'failed', reason: failure?.kind ?? 'capture_failed' };
}

export function createClaudeUnifiedDialogChoiceScreenProbe(params: Readonly<{
  broker: ClaudeUnifiedDialogChoiceBroker;
  port: TerminalControlPort;
  wait: (ms: number) => Promise<void>;
  graceMs: number;
  settleMs: number;
  verifyPollIntervalMs: number;
  verifyPollTimeoutMs: number;
  isDialogOwned: (dialogId: ClaudeUnifiedDialogId) => boolean;
  /**
   * Whether the startup resume resolver is still active (i.e. the startup window has not yet closed).
   * `resume_choice` is owned by that resolver ONLY during startup; once startup is ready the resolver
   * has stood down, so a resume dialog surfacing afterward must fail OPEN and be published like any
   * unowned dialog rather than deferred into a silent hang (S1-F2). Absent → assume startup-active
   * (defer), preserving the startup single-publisher guarantee.
   */
  isResumeStartupActive?: (() => boolean) | undefined;
}>): ClaudeUnifiedDialogChoiceScreenProbe {
  let disposed = false;
  let answerTask: Promise<void> | null = null;
  let answerTaskIdentity: string | null = null;
  let abortController: AbortController | null = null;
  const automaticAttemptedIdentities = new Set<string>();
  const manualFailedIdentities = new Set<string>();

  const dialogIsOwned = (dialog: ClaudeUnifiedVisibleDialog): boolean => {
    if (dialog.owner === null) return false;
    // resume_choice is published exclusively by its dedicated startup resolver DURING the startup
    // window; the generalized broker must defer then to avoid the startup double-publish (F2). But the
    // ownership is scoped: once startup is ready the resolver has stood down, so a resume dialog that
    // surfaces afterward is unowned and must be published — never silently deferred forever (S1-F2).
    // slash-controls-owned dialogs stay gated on the live control-run ownership predicate.
    if (dialog.owner.kind === 'resume_startup') return params.isResumeStartupActive?.() ?? true;
    return params.isDialogOwned(dialog.dialogId);
  };

  const cancelPendingIfResolved = async (): Promise<void> => {
    if (
      (params.isResumeStartupActive?.() ?? true)
      && params.broker.hasPendingChoice('resume_choice')
    ) {
      return;
    }
    await params.broker.noteDialogResolvedInTerminal('claude_dialog_resolved_in_terminal');
  };

  const startAnswerTask = (
    dialog: ClaudeUnifiedVisibleDialog,
    automaticDecision: ClaudeUnifiedDialogChoiceDecision | null = null,
  ): boolean => {
    const identity = getClaudeUnifiedDialogIdentity(dialog);
    if (answerTask && answerTaskIdentity === identity) return false;
    if (answerTask) {
      abortController?.abort('claude_unified_dialog_changed');
      params.broker.cancelPendingChoice('claude_unified_dialog_changed');
    }
    const taskAbortController = new AbortController();
    abortController = taskAbortController;
    params.broker.activate();
    const signal = taskAbortController.signal;
    const task = (automaticDecision
      ? Promise.resolve(automaticDecision)
      : params.broker.requestDialogChoice({ dialog, signal }))
      .then(async (decision) => {
        if (disposed) return;
        const result = await answerClaudeUnifiedRegisteredDialog({
          port: params.port,
          dialogId: dialog.dialogId,
          expectedIdentity: getClaudeUnifiedDialogIdentity(dialog),
          choice: decision.choice,
          wait: params.wait,
          settleMs: params.settleMs,
          verifyPollIntervalMs: params.verifyPollIntervalMs,
          verifyPollTimeoutMs: params.verifyPollTimeoutMs,
        });
        if (result.status === 'not_visible') {
          params.broker.noteTerminalAnswerFailed(dialog);
          params.broker.noteDialogResolvedInTerminal('claude_dialog_resolved_in_terminal');
        } else if (result.status === 'answered') {
          params.broker.noteTerminalAnswerSucceeded(dialog);
        } else if (result.status === 'dialog_changed') {
          params.broker.noteTerminalAnswerFailed(dialog);
          params.broker.cancelPendingChoice('claude_unified_dialog_changed');
          if (!dialogIsOwned(result.dialog)) startAnswerTask(result.dialog);
        } else if (result.status === 'failed') {
          params.broker.noteTerminalAnswerFailed(dialog);
          if (automaticDecision) automaticAttemptedIdentities.add(identity);
          else manualFailedIdentities.add(identity);
          logger.debug('[unified]: failed to answer Claude unified terminal dialog', {
            dialogId: decision.dialogId,
            reason: result.reason,
          });
        }
      })
      .catch((error) => {
        if (!disposed) logger.debug('[unified]: Claude dialog choice request ended without an answer', error);
      })
      .finally(() => {
        if (answerTask === task) {
          answerTask = null;
          answerTaskIdentity = null;
          abortController = null;
        }
      });
    answerTask = task;
    answerTaskIdentity = identity;
    return true;
  };

  const evaluateScreenState = async (
    state: ClaudeScreenState,
  ): Promise<ClaudeUnifiedDialogChoiceScreenProbeResult> => {
    if (disposed) return { kind: 'failed', reason: 'disposed' };
    const initialDialog = resolveClaudeUnifiedVisibleDialog(state);
    if (!initialDialog) {
      await cancelPendingIfResolved();
      return { kind: 'not_visible' };
    }
    if (dialogIsOwned(initialDialog)) {
      if (!params.broker.hasPendingChoiceForDialog(initialDialog)) {
        await params.broker.noteDialogResolvedInTerminal('claude_dialog_owned_by_control_path');
      }
      return { kind: 'owned', dialogId: initialDialog.dialogId };
    }

    await params.wait(Math.max(0, params.graceMs));
    if (disposed) return { kind: 'failed', reason: 'disposed' };
    const recaptured = await captureScreenState(params.port);
    const failure = captureFailureResult(recaptured);
    if (failure) return failure;
    if (recaptured.kind !== 'state') return { kind: 'failed', reason: 'capture_failed' };
    const dialog = resolveClaudeUnifiedVisibleDialog(recaptured.state);
    if (!dialog) {
      await cancelPendingIfResolved();
      return { kind: 'not_visible' };
    }
    if (dialogIsOwned(dialog)) {
      if (!params.broker.hasPendingChoiceForDialog(dialog)) {
        await params.broker.noteDialogResolvedInTerminal('claude_dialog_owned_by_control_path');
      }
      return { kind: 'owned', dialogId: dialog.dialogId };
    }

    const identity = getClaudeUnifiedDialogIdentity(dialog);
    if (manualFailedIdentities.has(identity)) {
      return { kind: 'failed', reason: 'dialog_answer_failed_requires_terminal' };
    }
    const automaticDecision = automaticAttemptedIdentities.has(identity)
      ? null
      : params.broker.resolveAutomaticDialogChoice(dialog);
    const alreadyPending = params.broker.hasPendingChoiceForDialog(dialog)
      && answerTaskIdentity === identity;
    const started = startAnswerTask(dialog, automaticDecision);
    return {
      kind: alreadyPending || !started
        ? 'already_pending'
        : automaticDecision
          ? 'automatic_answer_started'
          : 'request_published',
      dialogId: dialog.dialogId,
    };
  };

  return {
    async probe() {
      if (disposed) return { kind: 'failed', reason: 'disposed' };
      const captured = await captureScreenState(params.port);
      const failure = captureFailureResult(captured);
      if (failure) return failure;
      if (captured.kind !== 'state') return { kind: 'failed', reason: 'capture_failed' };
      return evaluateScreenState(captured.state);
    },
    evaluateScreenState,
    dispose() {
      if (disposed) return;
      disposed = true;
      abortController?.abort('claude_unified_dialog_choice_screen_probe_disposed');
      abortController = null;
      answerTask = null;
      answerTaskIdentity = null;
    },
  };
}
