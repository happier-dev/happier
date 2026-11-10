import { describe, expect, it, vi } from 'vitest';
import * as channels from './pluginNotificationChannels';

describe('saved health notification destination inspection', () => {
    it('uses the current catalog setup owner without sending and retains unavailable destinations', async () => {
        const inspect: unknown = Reflect.get(channels, 'readSavedHealthAlertDestinationAvailabilityForHost');
        expect(inspect).toBeTypeOf('function');
        if (typeof inspect !== 'function') throw new Error('Destination inspection is unavailable');
        const destinationSetup = { pluginId: 'happier.channel.slack', localId: 'notifications/setup' };
        const destination = { connectionId: 'connection', endpoint: { kind: 'shared', audience: 'shared', id: 'slack:T1:channel:C1' } };
        // Plugin Action invocation is the provider boundary; the catalog and saved destination remain real owner inputs.
        const executeSetup = vi.fn(async (): Promise<unknown> => ({ kind: 'ready' }));
        const host = { notificationChannelsList: async () => [{ value: 'happier.channel.slack/alerts',
            destinationSetup, disabled: false }], executeSetup };
        expect(await inspect({ channel: { channelId: 'happier.channel.slack/alerts', destination } }, host)).toEqual({ kind: 'ready' });
        expect(executeSetup).toHaveBeenCalledWith(destinationSetup, { destination }, undefined);
        executeSetup.mockResolvedValueOnce({ kind: 'unavailable', reason: 'notification_connection_unavailable' });
        expect(await inspect({ channel: { channelId: 'happier.channel.slack/alerts', destination } }, host))
            .toEqual({ kind: 'unavailable', reason: 'notification_connection_unavailable' });
        executeSetup.mockClear();
        expect(await inspect({ channel: { channelId: 'missing', destination } }, host)).toEqual({ kind: 'unavailable', reason: 'notification_channel_unavailable' });
        expect(executeSetup).not.toHaveBeenCalled();
    });
});
