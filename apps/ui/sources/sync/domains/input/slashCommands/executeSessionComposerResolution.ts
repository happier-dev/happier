import type { ActionExecuteResult, ActionExecutorContext, ActionId } from '@happier-dev/protocol';

import type { SessionComposerSendResolution } from './resolveSessionComposerSend';
import { storage } from '@/sync/domains/state/storage';
import { buildActionDraftInput } from '@/sync/domains/actions/buildActionDraftInput';

export type SessionComposerActionExecutor = Readonly<{
  execute: (actionId: ActionId, input: unknown, ctx?: ActionExecutorContext) => Promise<ActionExecuteResult>;
}>;

export async function executeSessionComposerResolution(args: Readonly<{
  resolved: SessionComposerSendResolution;
  sessionId: string;
  agentId: string;
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
        input: buildActionDraftInput({
          actionId: 'review.start' as any,
          sessionId: args.sessionId,
          defaultBackendId: args.agentId,
          instructions: '',
          extra: { permissionMode: args.permissionMode ?? 'read_only' },
        }),
      });
      return true;
    }

    const previousMessage = args.previousMessage ?? null;
    args.setMessage('');
    args.clearDraft();
    args.trackMessageSent();

    const engineIds = [args.agentId];

    const started = await args.actionExecutor.execute(
      'review.start',
      {
        sessionId: args.sessionId,
        engineIds,
        instructions,
        permissionMode: args.permissionMode ?? 'read_only',
        changeType: 'committed',
        base: { kind: 'none' },
      },
      ctx,
    );

    if (!started.ok) {
      if (previousMessage) args.setMessage(previousMessage);
      args.modalAlert('Error', started.error ?? 'Failed to start execution run');
    } else {
      const inner: any = started.result;
      if (inner && typeof inner === 'object' && inner.ok === false) {
        if (previousMessage) args.setMessage(previousMessage);
        args.modalAlert('Error', inner.error ?? 'Failed to start execution run');
      }
    }
    return true;
  }

  if (actionId === 'plan.start' || actionId === 'delegate.start') {
    const instructions = rest.trim();
    if (instructions.length === 0) {
      args.setMessage('');
      args.clearDraft();
      storage.getState().createSessionActionDraft(args.sessionId, {
        actionId,
        input: buildActionDraftInput({
          actionId: actionId as any,
          sessionId: args.sessionId,
          defaultBackendId: args.agentId,
          instructions: '',
          extra: { permissionMode: args.permissionMode ?? (actionId === 'delegate.start' ? 'default' : 'read_only') },
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
        backendIds: [args.agentId],
        instructions,
        permissionMode: args.permissionMode ?? (actionId === 'delegate.start' ? 'default' : 'read_only'),
      },
      ctx,
    );

    if (!started.ok) {
      if (previousMessage) args.setMessage(previousMessage);
      args.modalAlert('Error', started.error ?? 'Failed to start execution run');
    } else {
      const inner: any = started.result;
      if (inner && typeof inner === 'object' && inner.ok === false) {
        if (previousMessage) args.setMessage(previousMessage);
        args.modalAlert('Error', inner.error ?? 'Failed to start execution run');
      }
    }
    return true;
  }

  return false;
}
