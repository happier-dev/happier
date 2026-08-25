import {
  buildBackendTargetKey,
  convertBackendTargetRefV2ToV1,
  readBackendTargetRefV2,
  type ActionExecuteResult,
  type ActionExecutorContext,
  type ActionId,
  type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

import type { SessionComposerSendResolution } from './resolveSessionComposerSend';
import { storage } from '@/sync/domains/state/storage';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import { resolveExecutionRunActionDefaultPermissionMode } from '@/sync/domains/actions/resolveExecutionRunActionDefaultPermissionMode';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { resolveSessionGoalFailurePresentation } from '@/sync/ops/sessionGoalOperationFailure';
import { t } from '@/text';

export type SessionComposerActionExecutor = Readonly<{
  execute: (actionId: ActionId, input: unknown, ctx?: ActionExecutorContext) => Promise<ActionExecuteResult>;
}>;

export type SessionGoalOperationResult =
  | { ok: true }
  | { ok: false; error: string; errorCode?: string };

type SetSessionGoal = (
  sessionId: string,
  request: Readonly<{ objective?: string; status?: 'active' | 'paused' | 'complete' }>,
) => Promise<SessionGoalOperationResult>;

type ClearSessionGoal = (sessionId: string) => Promise<SessionGoalOperationResult>;

type SessionComposerTextSnapshot = Readonly<{
  sessionId: string;
  text: string;
}>;

function showGoalOperationFailure(
  result: SessionGoalOperationResult,
  modalAlert: (title: string, message: string) => void,
  options?: Readonly<{ statusOnly?: boolean }>,
): void {
  if (result.ok) return;
  const presentation = resolveSessionGoalFailurePresentation(result, options);
  modalAlert(presentation.title, presentation.message);
}

function restorePreviousComposerSnapshot(
  args: Readonly<{
    sessionId: string;
    previousMessage?: string | null;
    setMessage: (text: string) => void;
    restoreDraft?: (text: string) => void;
    restoreComposerSnapshotIfCurrentValueMatches?: (
      snapshot: SessionComposerTextSnapshot,
      expectedCurrentValue: string,
    ) => boolean;
    restoreComposerSnapshot?: (snapshot: SessionComposerTextSnapshot) => void;
  }>,
  previousMessageOverride?: string | null,
): void {
  const previousMessage = previousMessageOverride ?? args.previousMessage ?? null;
  if (!previousMessage) return;
  if (args.restoreComposerSnapshotIfCurrentValueMatches) {
    args.restoreComposerSnapshotIfCurrentValueMatches({
      sessionId: args.sessionId,
      text: previousMessage,
    }, '');
    return;
  }
  if (args.restoreComposerSnapshot) {
    args.restoreComposerSnapshot({
      sessionId: args.sessionId,
      text: previousMessage,
    });
    return;
  }
  args.setMessage(previousMessage);
  args.restoreDraft?.(previousMessage);
}

function clearAcceptedComposer(args: Readonly<{
  setMessage: (text: string) => void;
  clearDraft: () => void;
  clearTransientInputState?: () => void;
  clearSemanticDraftValues?: () => void;
}>): void {
  args.setMessage('');
  args.clearDraft();
  args.clearSemanticDraftValues?.();
  args.clearTransientInputState?.();
}

export async function executeSessionComposerResolution(args: Readonly<{
  resolved: SessionComposerSendResolution;
  sessionId: string;
  agentId: string;
  backendTarget?: BackendTargetRefV2Input | null;
  permissionMode: string | null;
  actionExecutor: SessionComposerActionExecutor;
  previousMessage?: string | null;

  setMessage: (text: string) => void;
  clearDraft: () => void;
  clearTransientInputState?: () => void;
  clearSemanticDraftValues?: () => void;
  restoreDraft?: (text: string) => void;
  restoreComposerSnapshotIfCurrentValueMatches?: (
    snapshot: SessionComposerTextSnapshot,
    expectedCurrentValue: string,
  ) => boolean;
  restoreComposerSnapshot?: (snapshot: SessionComposerTextSnapshot) => void;
  trackMessageSent: () => void;
  navigateToRuns: () => void;
  navigateToPetSettings?: () => void;
  openGoalControls?: () => void;
  setSessionGoal?: SetSessionGoal;
  clearSessionGoal?: ClearSessionGoal;
  modalAlert: (title: string, message: string) => void;
}>): Promise<boolean> {
  const ctx: ActionExecutorContext = {
    defaultSessionId: args.sessionId,
    surface: 'ui',
    placement: 'slash_command',
  };

  if (args.resolved.kind === 'goal') {
    if (args.resolved.command === 'open' || args.resolved.command === 'status') {
      clearAcceptedComposer(args);
      if (args.openGoalControls) {
        args.openGoalControls();
      } else {
        args.modalAlert(t('session.workState.unsupportedTitle'), t('session.workState.unsupportedMessage'));
      }
      return true;
    }

    if (args.resolved.command === 'set') {
      if (!args.setSessionGoal) {
        args.modalAlert(t('session.workState.unsupportedTitle'), t('session.workState.unsupportedMessage'));
        return true;
      }
      args.setMessage('');
      args.clearDraft();
      const result = await args.setSessionGoal(args.sessionId, { objective: args.resolved.objective });
      if (!result.ok) {
        restorePreviousComposerSnapshot(args);
        showGoalOperationFailure(result, args.modalAlert);
        return true;
      }
      args.clearSemanticDraftValues?.();
      args.clearTransientInputState?.();
      return true;
    }

    if (args.resolved.command === 'pause' || args.resolved.command === 'resume' || args.resolved.command === 'complete') {
      if (!args.setSessionGoal) {
        args.modalAlert(t('session.workState.unsupportedTitle'), t('session.workState.unsupportedMessage'));
        return true;
      }
      args.setMessage('');
      args.clearDraft();
      const result = await args.setSessionGoal(args.sessionId, {
        status: args.resolved.command === 'pause'
          ? 'paused'
          : args.resolved.command === 'complete'
            ? 'complete'
            : 'active',
      });
      if (!result.ok) {
        restorePreviousComposerSnapshot(args);
        showGoalOperationFailure(result, args.modalAlert, { statusOnly: true });
      } else {
        args.clearSemanticDraftValues?.();
        args.clearTransientInputState?.();
      }
      return true;
    }

    if (args.resolved.command === 'clear') {
      if (!args.clearSessionGoal) {
        args.modalAlert(t('session.workState.unsupportedTitle'), t('session.workState.unsupportedMessage'));
        return true;
      }
      args.setMessage('');
      args.clearDraft();
      const result = await args.clearSessionGoal(args.sessionId);
      if (!result.ok) {
        restorePreviousComposerSnapshot(args);
        showGoalOperationFailure(result, args.modalAlert);
      } else {
        args.clearSemanticDraftValues?.();
        args.clearTransientInputState?.();
      }
      return true;
    }
  }

  if (args.resolved.kind !== 'action') return false;

  const actionId = args.resolved.actionId;
  const rest = args.resolved.rest;

  if (actionId === 'ui.voice_global.reset') {
    const previousMessage = args.previousMessage ?? null;
    args.setMessage('');
    args.clearDraft();
    const reset = await args.actionExecutor.execute('ui.voice_global.reset', {}, ctx);
    const resetError = resolveActionExecutionFailureMessage(reset, 'Failed to reset voice');
    if (resetError) {
      restorePreviousComposerSnapshot(args, previousMessage);
      args.modalAlert('Error', resetError);
      return true;
    }
    args.clearSemanticDraftValues?.();
    args.clearTransientInputState?.();
    return true;
  }

  if (actionId === 'execution.run.list') {
    clearAcceptedComposer(args);
    args.navigateToRuns();
    return true;
  }

  if (actionId === 'ui.pet.choose') {
    clearAcceptedComposer(args);
    args.navigateToPetSettings?.();
    return true;
  }

  if (actionId === 'review.start') {
    const instructions = rest.trim();
    if (instructions.length === 0) {
      clearAcceptedComposer(args);
      // Insert a local-only draft card instead of sending a transcript message.
      storage.getState().createSessionActionDraft(args.sessionId, {
        actionId: 'review.start',
        input: buildExecutionRunActionDraftInputForUi({
          actionId: 'review.start' as any,
          sessionId: args.sessionId,
          defaultBackendTarget: args.backendTarget ?? null,
          defaultBackendId: args.agentId,
          instructions: '',
        }),
      });
      return true;
    }

    const previousMessage = args.previousMessage ?? null;
    args.setMessage('');
    args.clearDraft();
    const input = buildExecutionRunActionDraftInputForUi({
      actionId: 'review.start' as any,
      sessionId: args.sessionId,
      defaultBackendTarget: args.backendTarget ?? null,
      defaultBackendId: args.agentId,
      instructions,
    });
    if (!Array.isArray(input.engineIds) || input.engineIds.length === 0) {
      input.engineIds = [args.agentId];
    }

    const started = await args.actionExecutor.execute(
      'review.start',
      input,
      ctx,
    );

    const startError = resolveActionExecutionFailureMessage(started, 'Failed to start execution run');
    if (startError) {
      restorePreviousComposerSnapshot(args, previousMessage);
      args.modalAlert('Error', startError);
      return true;
    }
    args.clearSemanticDraftValues?.();
    args.clearTransientInputState?.();
    args.trackMessageSent();
    return true;
  }

  if (actionId === 'subagents.plan.start' || actionId === 'subagents.delegate.start') {
    const permissionMode = resolveExecutionRunActionDefaultPermissionMode(actionId) ?? 'read_only';
    const instructions = rest.trim();
    if (instructions.length === 0) {
      clearAcceptedComposer(args);
      storage.getState().createSessionActionDraft(args.sessionId, {
        actionId,
        input: buildExecutionRunActionDraftInputForUi({
          actionId: actionId as any,
          sessionId: args.sessionId,
          defaultBackendTarget: args.backendTarget ?? null,
          defaultBackendId: args.agentId,
          instructions: '',
        }),
      });
      return true;
    }

    const previousMessage = args.previousMessage ?? null;
    args.setMessage('');
    args.clearDraft();

    const started = await args.actionExecutor.execute(
      actionId,
      {
        sessionId: args.sessionId,
        backendTargetKeys: [buildBackendTargetKey(
          convertBackendTargetRefV2ToV1(
            readBackendTargetRefV2(args.backendTarget ?? { kind: 'backend', backendId: args.agentId }),
          ),
        )],
        instructions,
        permissionMode,
      },
      ctx,
    );

    const startError = resolveActionExecutionFailureMessage(started, 'Failed to start execution run');
    if (startError) {
      restorePreviousComposerSnapshot(args, previousMessage);
      args.modalAlert('Error', startError);
      return true;
    }
    args.clearSemanticDraftValues?.();
    args.clearTransientInputState?.();
    args.trackMessageSent();
    return true;
  }

  return false;
}
