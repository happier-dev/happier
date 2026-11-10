import { expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createStablePluginNotificationsOwner, type PluginNotificationSenderBinding } from '@/plugins/runtime/invocation/services/notifications';
import * as dispatch from './dispatchActivityNotification';

it('reports quiet-hours pause through the same delivery owner and sends only the saved destination when resumed', async () => {
    const send = vi.fn(async (request: Parameters<PluginNotificationSenderBinding['send']>[0]) => ({
        deliveryId: request.deliveryId, channelId: request.channelId, status: 'accepted' as const, evidence: 'provider' as const,
    }));
    const pluginNotifications = createStablePluginNotificationsOwner({ categories: [], channels: [{
        provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.delivery',
        definition: { id: 'health', kind: 'plugin', title: 'Health', configurable: true, defaultEnabled: true },
    }], activateChannel: async () => {}, readChannel: () => ({ occurrenceId: 'current', isCurrent: () => true, send }) });
    const channelId = (await pluginNotifications.availableHostChannels())[0]!.value;
    const destination = { connectionId: 'production', endpoint: { kind: 'shared', audience: 'shared', id: 'saved-channel' } };
    const test: unknown = Reflect.get(dispatch, 'dispatchSavedHealthAlertTestAsync');
    expect(test).toBeTypeOf('function');
    if (typeof test !== 'function') throw new Error('Saved alert Test delivery is unavailable');
    const params = { channel: { channelId, destination }, pluginNotifications,
        notificationChannelCatalog: { status: 'ready' as const, revision: 1, diagnostics: [], channels: [] },
        nowMs: () => Date.parse('2026-11-10T12:00:00Z') };
    expect(await test({ ...params, settings: accountSettingsParse({ attentionDeliveryPolicyV1: {
        quietHours: { enabled: true, timezone: 'UTC', windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }] },
    } }) })).toEqual({ status: 'paused' });
    expect(send).not.toHaveBeenCalled();
    expect(await test({ ...params, settings: accountSettingsParse({}) })).toEqual({ status: 'sent' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ destination, title: 'Health alert test' });
});
