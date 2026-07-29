import { describe, expect, it } from 'vitest';

import {
  PluginNotificationCategoryContributionV2Schema,
  PluginNotificationCategoryKindV1Schema,
  PluginNotificationChannelContributionV2Schema,
  PluginNotificationChannelKindV1Schema,
} from './notifications.js';

describe('notification contribution schemas', () => {
  it('preserves the approved closed category and channel kind contracts', () => {
    expect(PluginNotificationCategoryKindV1Schema.options).toEqual([
      'activity',
      'approval',
      'plugin',
    ]);
    expect(PluginNotificationChannelKindV1Schema.options).toEqual([
      'expo_push',
      'webhook',
      'local_notification',
      'badge',
      'desktop_overlay',
      'live_activity',
      'home_widget',
      'plugin',
    ]);
  });

  it('requires an approved kind on every notification category and channel', () => {
    const category = {
      id: 'review-ready',
      kind: 'activity',
      title: 'Review ready',
      eventIds: ['review-ready-event'],
    };
    const channel = {
      id: 'review-webhook',
      kind: 'webhook',
      title: 'Review webhook',
    };

    expect(PluginNotificationCategoryContributionV2Schema.safeParse(category).success).toBe(true);
    expect(PluginNotificationChannelContributionV2Schema.safeParse(channel).success).toBe(true);
    expect(PluginNotificationCategoryContributionV2Schema.safeParse({ ...category, kind: 'other' }).success).toBe(false);
    expect(PluginNotificationChannelContributionV2Schema.safeParse({ ...channel, kind: 'other' }).success).toBe(false);
    expect(PluginNotificationCategoryContributionV2Schema.safeParse({ ...category, kind: undefined }).success).toBe(false);
    expect(PluginNotificationChannelContributionV2Schema.safeParse({ ...channel, kind: undefined }).success).toBe(false);
  });

  it('retains non-secret configuration and secret credential fields on configured channels', () => {
    const parsed = PluginNotificationChannelContributionV2Schema.parse({
      id: 'review-webhook',
      kind: 'webhook',
      title: 'Review webhook',
      configurable: true,
      settings: [{
        id: 'endpoint',
        title: 'Endpoint',
        schema: { type: 'string', minLength: 1 },
        default: 'https://example.invalid/webhook',
      }, {
        id: 'token',
        title: 'Token',
        schema: { type: 'string', minLength: 1 },
        secret: true,
      }],
    });

    expect(parsed.settings).toEqual([
      expect.objectContaining({ id: 'endpoint', default: 'https://example.invalid/webhook' }),
      expect.objectContaining({ id: 'token', secret: true }),
    ]);
    expect(PluginNotificationChannelContributionV2Schema.safeParse({
      ...parsed,
      settings: [{
        id: 'token',
        title: 'Token',
        schema: { type: 'string' },
        secret: true,
        default: 'must-not-be-public',
      }],
    }).success).toBe(false);
  });
});
