import { buildBackendTargetKey, type ActionExecuteResult, type ActionExecutorContext, type ActionId, type BackendTargetRefV1 } from '@happier-dev/protocol';

import type { SessionComposerSendResolution } from './resolveSessionComposerSend';
import { storage } from '@/sync/domains/state/storage';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import { resolveExecutionRunActionDefaultPermissionMode } from '@/sync/domains/actions/resolveExecutionRunActionDefaultPermissionMode';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

export type SessionComposerActionExecutor = Readonly<{
  execute: (actionId: ActionId, input: unknown, ctx?: ActionExecutorContext) => Promise<ActionExecuteResult>;
}>;

export async function executeSessionComposerResolution(args: Readonly<{
  resolved: SessionComposerSendResolution;
  sessionId: string;
  agentId: string;
  backendTarget?: BackendTargetRefV1 | null;
  permissionMode: string | null;
  actionExecutor: SessionComposerActionExecutor;
  previousMessage?: string | null;

  setMessage: (text: string) => void;
  clearDraft: () => void;
  trackMessageSent: () => void;
  navigateToRuns: () => void;
  modalAlert: (title: string, message: string) => void;
}>): Promise<boolean> {
  const ctx: ActionExecutorContext = {
    defaultSessionId: args.sessionId,
    surface: 'ui_slash_command',
    placement: 'slash_command',
  };

  if (args.resolved.kind !== 'action') return false;

  const actionId = args.resolved.actionId;
  const rest = args.resolved.rest;

  if (actionId === 'ui.voice_global.reset') {
    args.setMessage('');
    await args.actionExecutor.execute('ui.voice_global.reset', {}, ctx);
    return true;
  }

  if (actionId === 'execution.run.list') {
    args.setMessage('');
    args.navigateToRuns();
    return true;
  }

  if (actionId === 'review.start') {
    const instructions = rest.trim();
    if (instructions.length === 0) {
      args.setMessage('');
      args.clearDraft();
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
    args.trackMessageSent();
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
      if (previousMessage) args.setMessage(previousMessage);
      args.modalAlert('Error', startError);
    }
    return true;
  }

  if (actionId === 'subagents.plan.start' || actionId === 'subagents.delegate.start') {
    const permissionMode = resolveExecutionRunActionDefaultPermissionMode(actionId) ?? 'read-only';
    const instructions = rest.trim();
    if (instructions.length === 0) {
      args.setMessage('');
      args.clearDraft();
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
    args.trackMessageSent();

    const started = await args.actionExecutor.execute(
      actionId,
      {
        sessionId: args.sessionId,
        backendTargetKeys: [buildBackendTargetKey(args.backendTarget ?? { kind: 'builtInAgent', agentId: args.agentId as any })],
        instructions,
        permissionMode,
      },
      ctx,
    );

    const startError = resolveActionExecutionFailureMessage(started, 'Failed to start execution run');
    if (startError) {
      if (previousMessage) args.setMessage(previousMessage);
      args.modalAlert('Error', startError);
    }
    return true;
  }

  return false;
}
