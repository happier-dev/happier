import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import {
  NOTIFICATION_CONFIGURATION_ACTION_IDS,
  NotificationConfigurationActionInputSchemas,
  NotificationConfigurationActionOutputSchemas,
} from './notificationConfigurationActionFamily.js';

describe('notification signing secret Action input', () => {
  it('asks before an agent sends an external webhook test unless that surface has an explicit waiver', () => {
    const actionId = 'notifications.webhooks.test';
    const spec = getActionSpec(actionId);
    expect(spec.executionPlacement).toBe('account');
    for (const surface of ['agent', 'mcp', 'ui'] as const) {
      const context = { surface, authority: surface === 'ui' ? 'present_user' : 'account_automation', actionCaller: { kind: 'host' } } as const;
      expect(isApprovalRequiredByActionsSettings(actionId, normalizeActionsSettingsV1({ v: 1 }), context)).toBe(true);
      expect(isApprovalRequiredByActionsSettings(actionId, normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: { [actionId]: [surface] } }), context)).toBe(false);
    }
  });
  it('addresses only a configured webhook for test delivery and requires a reason for failed outcomes', () => {
    const input = Object.entries(NotificationConfigurationActionInputSchemas)
      .find(([id]) => id === 'notifications.webhooks.test')?.[1];
    const output = Object.entries(NotificationConfigurationActionOutputSchemas)
      .find(([id]) => id === 'notifications.webhooks.test')?.[1];
    expect(input?.safeParse({ channelId: 'hook' }).success).toBe(true);
    expect(input?.safeParse({ channelId: 'hook', url: 'https://other.example', body: 'private' }).success).toBe(false);
    expect(output?.safeParse({ status: 'delivered' }).success).toBe(true);
    expect(output?.safeParse({ status: 'refused', reason: 'http_rejected', httpStatus: 503 }).success).toBe(true);
    expect(output?.safeParse({ status: 'unreachable', reason: 'ECONNREFUSED' }).success).toBe(true);
    expect(output?.safeParse({ status: 'refused' }).success).toBe(false);
    expect(output?.safeParse({ status: 'unreachable' }).success).toBe(false);
  });
  it('admits an explicit local-notifications permission purpose without changing the default push request', () => {
    const schema = NotificationConfigurationActionInputSchemas['notifications.push.permission.request'];
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ purpose: 'local_notifications' })).toEqual({ purpose: 'local_notifications' });
    expect(schema.safeParse({ purpose: 'remote_push_override' }).success).toBe(false);
  });
  it('declares native sound Preview in the existing notification family with a strict receipt', () => {
    expect(NOTIFICATION_CONFIGURATION_ACTION_IDS).toContain('notifications.sounds.preview');
    const input = Object.entries(NotificationConfigurationActionInputSchemas).find(([id]) => id === 'notifications.sounds.preview')?.[1];
    const output = Object.entries(NotificationConfigurationActionOutputSchemas).find(([id]) => id === 'notifications.sounds.preview')?.[1];
    expect(input?.safeParse({}).success).toBe(true);
    expect(input?.safeParse({ sound: 'caller-selected.wav' }).success).toBe(false);
    expect(output?.parse({ notificationId: 'native-preview' })).toEqual({ notificationId: 'native-preview' });
  });
  it('admits waived OS permission requests without turning the waiver into an OS grant', async () => {
    for (const actionId of ['notifications.desktop.permission.request', 'notifications.push.permission.request'] as const) {
      const result = actionId === 'notifications.desktop.permission.request' ? { status: 'notGranted' }
        : { decision: 'skip_cannot_ask_again', granted: false };
      const effects: unknown[] = [];
      // The answering client's native permission adapter is the process boundary.
      const executor = createActionExecutor({
        notificationConfigurationAction: async args => { effects.push(args); return result; },
        isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id,
          context.actionsSettings ?? normalizeActionsSettingsV1({ v: 1 }), context),
      } as ActionExecutorDeps);
      for (const surface of ['agent', 'mcp'] as const) {
        const context = { surface, authority: 'account_automation', actionCaller: { kind: 'host' } } as const;
        expect(await executor.execute(actionId, {}, context)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
        expect(effects).toEqual([]);
        const actionsSettings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
        expect(await executor.execute(actionId, {}, { ...context, actionsSettings })).toEqual({ ok: true, result });
        expect(effects.pop()).toMatchObject({ actionId, context: { authority: 'account_automation' } });
      }
    }
  });
  it('preserves exact write-only signing material including surrounding whitespace', () => {
    const secret = '  byte-exact signing material\n';
    expect(NotificationConfigurationActionInputSchemas['notifications.webhooks.signingSecret.set'].parse({ channelId: 'hook', secret }))
      .toEqual({ channelId: 'hook', secret });
  });
});

function expoPushInputSchema() {
  const schema = Object.entries(NotificationConfigurationActionInputSchemas)
    .find(([id]) => id === 'notifications.expoPush.update')?.[1];
  expect(schema).toBeDefined();
  if (!schema) throw new Error('The existing push controls need their public configuration Action');
  return schema;
}

describe('builtin Expo push configuration Action input', () => {
  it('registers a fixed-membership edit with all six topic fields and a durable channel receipt', () => {
    expect(NOTIFICATION_CONFIGURATION_ACTION_IDS).toContain('notifications.expoPush.update');
    const input = { patch: { enabled: true, topics: {
      ready: true, permissionRequest: true, userActionRequest: true,
      connectedServiceAccountSwitch: false, connectedServiceQuotaBlocked: false, connectedServiceQuotaRecovered: true,
    }, readyIncludeMessageText: true, requestIncludeMessageText: false } };
    expect(expoPushInputSchema().parse(input)).toEqual(input);
    const output = Object.entries(NotificationConfigurationActionOutputSchemas)
      .find(([id]) => id === 'notifications.expoPush.update')?.[1];
    expect(output).toBeDefined();
    expect(output?.parse({ channelId: 'builtin:expo_push' })).toEqual({ channelId: 'builtin:expo_push' });
  });

  it('accepts sparse topic intent without synthesizing neighboring defaults or legacy recovery', () => {
    const input = { patch: { topics: { connectedServiceQuotaBlocked: false } } };
    expect(expoPushInputSchema().parse(input)).toEqual(input);
  });

  it('rejects empty, unknown, and caller-selected membership patches', () => {
    const schema = expoPushInputSchema();
    for (const input of [
      { patch: {} }, { patch: { enabled: undefined } }, { patch: { topics: {} } },
      { patch: { topics: { ready: undefined } } }, { patch: { invented: true } },
      { patch: { topics: { invented: true } } }, { channelId: 'another-endpoint', patch: { enabled: true } },
      { patch: { url: 'https://example.test/hook' } },
    ]) expect(schema.safeParse(input).success).toBe(false);
  });
});
