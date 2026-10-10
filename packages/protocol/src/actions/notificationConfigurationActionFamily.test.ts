import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_CONFIGURATION_ACTION_IDS,
  NotificationConfigurationActionInputSchemas,
  NotificationConfigurationActionOutputSchemas,
} from './notificationConfigurationActionFamily.js';

describe('notification signing secret Action input', () => {
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
