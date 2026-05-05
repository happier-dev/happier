import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';

import {
  createNotificationRegistry,
  createNotificationsService,
} from './service';
import { createNotificationRegistryFromPluginRuntime } from './pluginRuntimeRegistry';

describe('notifications service', () => {
  it('rejects category and channel id collisions with owner diagnostics', () => {
    const registry = createNotificationRegistry({
      categories: [
        {
          id: 'builtin.activity.ready',
          kind: 'activity',
          title: 'Ready',
          owner: { kind: 'built_in' },
          eventIds: ['ready'],
        },
      ],
      channels: [
        {
          id: 'builtin:expo_push',
          kind: 'expo_push',
          title: 'Expo push',
          owner: { kind: 'built_in' },
        },
      ],
    });

    expect(() => registry.registerCategory({
      id: 'builtin.activity.ready',
      kind: 'activity',
      title: 'Plugin ready',
      owner: { kind: 'plugin', pluginId: 'acme.notifications' },
    })).toThrow(/Notification category 'builtin\.activity\.ready' from plugin 'acme\.notifications' conflicts with built-in category/);

    expect(() => registry.registerChannel({
      id: 'builtin:expo_push',
      kind: 'plugin',
      title: 'Plugin push',
      owner: { kind: 'plugin', pluginId: 'acme.notifications' },
      send: async () => ({ delivered: true }),
    })).toThrow(/Notification channel 'builtin:expo_push' from plugin 'acme\.notifications' conflicts with built-in channel/);
  });

  it('routes plugin notifications through registered channel senders and preference decisions', async () => {
    const delivered: unknown[] = [];
    const registry = createNotificationRegistry({
      categories: [
        {
          id: 'acme.notifications.reviewReady',
          kind: 'activity',
          title: 'Review ready',
          owner: { kind: 'plugin', pluginId: 'acme.notifications' },
          eventIds: ['ready'],
        },
      ],
      channels: [
        {
          id: 'acme.notifications.memory',
          kind: 'plugin',
          title: 'Memory channel',
          owner: { kind: 'plugin', pluginId: 'acme.notifications' },
          send: async (notification) => {
            delivered.push(notification);
            return { delivered: true };
          },
        },
      ],
    });
    const service = createNotificationsService({
      registry,
      getSettings: () => accountSettingsParse({
        attentionDeliveryPolicyV1: {
          channels: {
            'acme.notifications.memory': {
              enabled: true,
            },
          },
        },
      }),
    });

    await expect(service.listCategories()).resolves.toEqual([
      expect.objectContaining({
        id: 'acme.notifications.reviewReady',
        kind: 'activity',
      }),
    ]);
    await expect(service.getUserPreferences('acme.notifications.reviewReady')).resolves.toEqual(
      expect.objectContaining({
        categoryId: 'acme.notifications.reviewReady',
      }),
    );
    await expect(service.send({
      categoryId: 'acme.notifications.reviewReady',
      title: 'Review ready',
      body: 'The review is waiting for input',
      channelIds: ['acme.notifications.memory'],
      payload: {
        sessionId: 'session-1',
      },
    })).resolves.toEqual({
      delivered: ['acme.notifications.memory'],
    });

    expect(delivered).toEqual([
      expect.objectContaining({
        categoryId: 'acme.notifications.reviewReady',
        title: 'Review ready',
        body: 'The review is waiting for input',
      }),
    ]);
  });

  it('scopes plugin contexts to owned notification descriptors', async () => {
    const registry = createNotificationRegistry({
      categories: [
        {
          id: 'builtin.activity.ready',
          kind: 'activity',
          title: 'Ready',
          owner: { kind: 'built_in' },
        },
        {
          id: 'acme.owner.reviewReady',
          kind: 'activity',
          title: 'Review ready',
          owner: { kind: 'plugin', pluginId: 'acme.owner' },
        },
        {
          id: 'acme.foreign.reviewReady',
          kind: 'activity',
          title: 'Foreign review ready',
          owner: { kind: 'plugin', pluginId: 'acme.foreign' },
        },
      ],
      channels: [
        {
          id: 'builtin:webhook',
          kind: 'webhook',
          title: 'Webhook',
          owner: { kind: 'built_in' },
        },
        {
          id: 'acme.owner.memory',
          kind: 'plugin',
          title: 'Owner memory channel',
          owner: { kind: 'plugin', pluginId: 'acme.owner' },
          send: async () => ({ delivered: true }),
        },
        {
          id: 'acme.foreign.memory',
          kind: 'plugin',
          title: 'Foreign memory channel',
          owner: { kind: 'plugin', pluginId: 'acme.foreign' },
          send: async () => ({ delivered: true }),
        },
      ],
    });
    const service = createNotificationsService({
      registry,
      pluginId: 'acme.owner',
    });

    await expect(service.listCategories()).resolves.toEqual([
      expect.objectContaining({ id: 'acme.owner.reviewReady' }),
    ]);
    await expect(service.listChannels()).resolves.toEqual([
      expect.objectContaining({ id: 'acme.owner.memory' }),
      expect.objectContaining({ id: 'builtin:webhook' }),
    ]);
  });

  it('routes built-in approval notification categories through the activity attention dispatcher', async () => {
    const dispatchedEvents: unknown[] = [];
    const service = createNotificationsService({
      dispatchActivityNotification: async (params) => {
        dispatchedEvents.push(params.event);
        return { attemptedChannels: 1, deliveredChannels: 1 };
      },
    });

    await expect(service.send({
      categoryId: 'builtin.approval.permission_request',
      title: 'Permission required',
      payload: {
        topic: 'permission_request',
        sessionId: 'session-1',
        requestId: 'request-1',
        toolName: 'Edit',
      },
    })).resolves.toEqual({
      delivered: ['activity'],
    });

    expect(dispatchedEvents).toEqual([
      expect.objectContaining({
        topic: 'permission_request',
        requestId: 'request-1',
      }),
    ]);
  });

  it('rejects scoped plugin access to foreign notification descriptors', async () => {
    const foreignDeliveries: unknown[] = [];
    const registry = createNotificationRegistry({
      categories: [
        {
          id: 'acme.owner.reviewReady',
          kind: 'activity',
          title: 'Review ready',
          owner: { kind: 'plugin', pluginId: 'acme.owner' },
          defaultChannelIds: ['acme.owner.memory'],
        },
        {
          id: 'acme.foreign.reviewReady',
          kind: 'activity',
          title: 'Foreign review ready',
          owner: { kind: 'plugin', pluginId: 'acme.foreign' },
          defaultChannelIds: ['acme.foreign.memory'],
        },
      ],
      channels: [
        {
          id: 'acme.owner.memory',
          kind: 'plugin',
          title: 'Owner memory channel',
          owner: { kind: 'plugin', pluginId: 'acme.owner' },
          send: async () => ({ delivered: true }),
        },
        {
          id: 'acme.foreign.memory',
          kind: 'plugin',
          title: 'Foreign memory channel',
          owner: { kind: 'plugin', pluginId: 'acme.foreign' },
          send: async (notification) => {
            foreignDeliveries.push(notification);
            return { delivered: true };
          },
        },
      ],
    });
    const service = createNotificationsService({
      registry,
      pluginId: 'acme.owner',
    });

    await expect(service.getUserPreferences('acme.foreign.reviewReady')).rejects.toThrow(/not available/);
    await expect(service.send({
      categoryId: 'acme.foreign.reviewReady',
      title: 'Foreign review ready',
    })).rejects.toThrow(/not available/);
    await expect(service.send({
      categoryId: 'acme.owner.reviewReady',
      title: 'Review ready',
      channelIds: ['acme.foreign.memory'],
    })).rejects.toThrow(/not available/);
    expect(foreignDeliveries).toEqual([]);
  });

  it('hydrates plugin-declared notification categories with activated channel senders', async () => {
    const delivered: unknown[] = [];
    const registry = createNotificationRegistryFromPluginRuntime({
      contributes: {
        notifications: [
          {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.notifications',
            definition: {
              id: 'acme.notifications.reviewReady',
              kind: 'activity',
              title: 'Review ready',
              eventIds: ['ready'],
              defaultChannelIds: ['acme.notifications.memory'],
            },
          },
        ],
        notificationChannels: [
          {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.notifications',
            definition: {
              id: 'acme.notifications.memory',
              kind: 'webhook',
              title: 'Memory channel',
              configurable: false,
              defaultEnabled: true,
            },
          },
        ],
      },
      notificationChannelsById: new Map([
        ['acme.notifications.memory', {
          pluginId: 'acme.notifications',
          registration: {
            id: 'acme.notifications.memory',
            kind: 'webhook',
            title: 'Memory channel',
            send: async (notification) => {
              delivered.push(notification);
              return { delivered: true };
            },
          },
        }],
      ]),
    });
    const service = createNotificationsService({
      registry,
      getSettings: () => accountSettingsParse({
        attentionDeliveryPolicyV1: {
          channels: {
            webhook: {
              enabled: true,
            },
          },
        },
      }),
    });

    await expect(service.send({
      categoryId: 'acme.notifications.reviewReady',
      title: 'Review ready',
    })).resolves.toEqual({
      delivered: ['acme.notifications.memory'],
    });
    expect(delivered).toEqual([
      expect.objectContaining({
        categoryId: 'acme.notifications.reviewReady',
        channelId: 'acme.notifications.memory',
      }),
    ]);
  });
});
