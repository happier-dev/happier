import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec, SignedRootActionIdSchema } from './actionSpecs.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings, resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';

describe('Notify me Action', () => {
  it('keeps result custody separate from default consent and honors a Session caller Require setting before delivery', async () => {
    const actionId = 'notifications.notify_me';
    const spec = getActionSpec(actionId);
    const context = { surface: 'mcp' as const, serverId: 'home', runtimeAccountId: 'owner',
      actionRequestId: 'notify-one', actionCaller: { kind: 'session' as const, sessionId: 'session-one', starterDepth: 0, turnDepth: 0 } };
    expect(spec.approval.result).toBe('required');
    expect(resolveActionApprovalRouting({ actionId, spec, context })).toMatchObject({ required: false, result: 'required' });
    let request: ApprovalRequest | null = null;
    let delivered = false;
    const settings = ActionsSettingsV1Schema.parse({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } } });
    const executor = createActionExecutor({
      isActionApprovalRequired: (id, caller, input) => isApprovalRequiredByActionsSettings(id, settings, caller, undefined, undefined, input),
      approvalsCreate: async ({ request: pending }) => { request = pending; return { artifactId: 'notify-approval' }; },
      approvalsWaitForDecision: async ({ request: pending }) => ({ decision: 'reject', request: pending }),
      approvalsUpdate: async ({ request: settled }) => { request = settled; return { ok: true }; },
      notificationsNotifyMe: async () => { delivered = true; return { attemptedChannels: 1, deliveredChannels: 1 }; },
    });
    expect(await executor.execute(actionId, { message: 'Finished' }, context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'notify-approval', actionId } });
    expect(request).toMatchObject({ actionId, status: 'open', approval: { flow: 'deferred', result: 'required' } });
    expect(delivered).toBe(false);
  });
  it('binds a Session caller to its own session and agent surface before notification delivery', async () => {
    const executor = createActionExecutor({ notificationsNotifyMe: async (_input: unknown, context: unknown) => {
      expect(context).toMatchObject({ surface: 'agent', defaultSessionId: 'session-one',
        actionCaller: { kind: 'session', sessionId: 'session-one' } });
      return { attemptedChannels: 1, deliveredChannels: 1 };
    } } as unknown as ActionExecutorDeps);
    expect(await executor.execute('notifications.notify_me', { message: 'Finished' }, {
      surface: 'cli', defaultSessionId: 'foreign-session',
      actionCaller: { kind: 'session', sessionId: 'session-one', starterDepth: 1, turnDepth: 2 },
    })).toEqual({ ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
  });
  it('exposes channel discovery and passes the workflow request identity and default link to its Account host', async () => {
    const deliveries: unknown[] = [];
    // The injected delivery adapter is the external Account/notification boundary.
    const executor = createActionExecutor({
      notificationsNotifyMe: async (input: unknown, context: unknown) => {
        deliveries.push({ input, context });
        return { attemptedChannels: 1, deliveredChannels: 1 };
      },
      notificationChannelsList: async () => ({ items: [{ value: 'builtin:expo_push', label: 'Push notifications' }] }),
    } as unknown as ActionExecutorDeps);
    const context = {
      surface: 'agent' as const,
      actionRequestId: 'workflow-notify-request',
      actionCaller: { kind: 'workflowRun' as const, runId: 'workflow-1', authorization: {
        principal: { kind: 'host' as const }, admittedPermissionCeiling: 'read-only' as const,
      } },
    };
    expect(await executor.execute('notifications.notify_me', {
      title: "Review didn't converge", message: 'Open the run.', channels: ['builtin:expo_push'],
    }, context)).toEqual({ ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
    expect(deliveries).toEqual([{ input: {
      title: "Review didn't converge", message: 'Open the run.', channels: ['builtin:expo_push'],
      open: { kind: 'workflow_run', runId: 'workflow-1' },
    }, context }]);
    expect(getActionSpec('notifications.notify_me').inputHints?.fields?.find((field) => field.path === 'channels'))
      .toMatchObject({ optionsSourceId: 'notifications.channels.available' });
    expect(SignedRootActionIdSchema.safeParse('notifications.notify_me').success).toBe(true);
    expect(await executor.execute('action.options.resolve', {
      actionId: 'notifications.notify_me', fieldPath: 'channels', draftInput: {},
    }, { surface: 'agent' })).toMatchObject({ ok: true, result: { options: [{ value: 'builtin:expo_push', label: 'Push notifications' }] } });
  });

  it('refuses duplicate channels and another Account selector before delivery', async () => {
    let delivered = false;
    // Only the notification delivery boundary is substituted.
    const executor = createActionExecutor({ notificationsNotifyMe: async () => {
      delivered = true;
      return { attemptedChannels: 0, deliveredChannels: 0 };
    } } as unknown as ActionExecutorDeps);
    const spec = getActionSpec('notifications.notify_me');
    expect(spec.inputSchema.safeParse({ message: 'Hi', channels: ['x', 'x'] }).success).toBe(false);
    expect(await executor.execute('notifications.notify_me', { message: 'Hi', channels: ['x', 'x'] }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await executor.execute('notifications.notify_me', { message: 'Hi', accountId: 'someone-else' }, { surface: 'cli' }))
      .toMatchObject({ ok: false });
    expect(delivered).toBe(false);
  });

  it('preserves explicit links and leaves ordinary calls without an invented target', async () => {
    const inputs: unknown[] = [];
    const executor = createActionExecutor({ notificationsNotifyMe: async (input: unknown) => {
      inputs.push(input);
      return { attemptedChannels: 0, deliveredChannels: 0 };
    } } as unknown as ActionExecutorDeps);
    const open = { kind: 'session', sessionId: 'session-1' };
    expect(await executor.execute('notifications.notify_me', { message: 'Hi', open }, {
      surface: 'agent', actionCaller: { kind: 'workflowRun', runId: 'workflow-1', authorization: {
        principal: { kind: 'host' }, admittedPermissionCeiling: 'read-only',
      } },
    })).toEqual({ ok: true, result: { attemptedChannels: 0, deliveredChannels: 0 } });
    expect(await executor.execute('notifications.notify_me', { message: 'Hi', channels: [] }, { surface: 'cli' }))
      .toEqual({ ok: true, result: { attemptedChannels: 0, deliveredChannels: 0 } });
    expect(inputs).toEqual([{ message: 'Hi', open }, { message: 'Hi', channels: [] }]);
    expect(getActionSpec('notifications.notify_me').inputSchema.safeParse({
      message: 'Hi', open: { ...open, accountId: 'someone-else' },
    }).success).toBe(false);
  });

  it('returns host authorization failures and rejects an invalid delivery result', async () => {
    const denied = createActionExecutor({ notificationsNotifyMe: async () => ({
      ok: false, errorCode: 'run_access_denied', error: 'run_access_denied',
    }) } as unknown as ActionExecutorDeps);
    expect(await denied.execute('notifications.notify_me', { message: 'Hi' }, { surface: 'rpc' }))
      .toEqual({ ok: false, errorCode: 'run_access_denied', error: 'run_access_denied' });
    const malformed = createActionExecutor({ notificationsNotifyMe: async () => ({
      attemptedChannels: 0, deliveredChannels: -1,
    }) } as unknown as ActionExecutorDeps);
    expect(await malformed.execute('notifications.notify_me', { message: 'Hi' }, { surface: 'cli' }))
      .toMatchObject({ ok: false });
  });
});
