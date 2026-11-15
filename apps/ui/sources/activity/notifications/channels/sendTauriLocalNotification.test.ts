import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { buildGuardStopWarningPushDataV1 } from '@happier-dev/protocol/activity/webhookPayload';

const isPermissionGranted = vi.hoisted(() => vi.fn(async () => false));
const requestPermission = vi.hoisted(() => vi.fn(async () => 'granted'));
const sendNotification = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/plugin-notification', () => ({
    isPermissionGranted,
    requestPermission,
    sendNotification,
}));

const native = vi.hoisted(() => ({
    invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined),
    listen: vi.fn(async (_event: string, _listener: () => void) => vi.fn()),
}));
vi.mock('@/utils/platform/desktopHost', () => ({ invokeDesktopHost: native.invoke, listenDesktopHostEvent: native.listen,
    isDesktopHost: () => false, desktopHostKind: () => null }));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let homeId: string;
afterEach(async () => { await homes.reset(); });

describe('sendTauriLocalNotification', () => {
    beforeEach(async () => {
        await homes.reset();
        homeId = await homes.addHome({ name: 'Native Home', serverUrl: 'https://native-notification.test', accountId: 'owner', currentAccount: true });
        isPermissionGranted.mockClear();
        requestPermission.mockClear();
        sendNotification.mockClear();
        native.invoke.mockClear();
        native.listen.mockClear();
    });

    it('requests permission before sending when needed', async () => {
        const { sendTauriLocalNotification } = await import('./sendTauriLocalNotification');

        const sent = await sendTauriLocalNotification({
            title: 'Permission request',
            body: 'A session needs approval.',
        });

        expect(sent).toBe(true);
        expect(requestPermission).toHaveBeenCalledTimes(1);
        expect(sendNotification).toHaveBeenCalledWith({
            title: 'Permission request',
            body: 'A session needs approval.',
        });
    });

    it('does not send when permission remains denied', async () => {
        requestPermission.mockResolvedValueOnce('denied');

        const { sendTauriLocalNotification } = await import('./sendTauriLocalNotification');

        const sent = await sendTauriLocalNotification({
            title: 'Permission request',
            body: 'A session needs approval.',
        });

        expect(sent).toBe(false);
        expect(sendNotification).not.toHaveBeenCalled();
    });

    it('delivers an actionable occurrence through the native boundary and withdraws that same occurrence', async () => {
        const channel = await import('./sendTauriLocalNotification');
        const interaction = { identifier: 'home-a:guard-stop:s1:900', data: {
            ...buildGuardStopWarningPushDataV1({ topic: 'guard_stop_warning', machineId: 'm', sessionId: 's1', rule: 'idle_sessions', stopAt: 900 }),
            serverId: homeId,
        },
            actions: [{ id: 'keep', title: 'Keep running' }, { id: 'stop', title: 'Stop now' }] };
        await channel.sendTauriLocalNotification({ title: 'Stopping soon', body: 'Finished work', interaction });
        expect(native.invoke).toHaveBeenCalledWith('desktop_notification_show', { notification: {
            title: 'Stopping soon', body: 'Finished work', ...interaction, accountId: 'owner',
        } });
        expect(sendNotification).not.toHaveBeenCalled();
        const { desktopGuardNotificationTransport } = await import('./tauriNotificationPlugin');
        await desktopGuardNotificationTransport.dismissNotificationAsync(interaction.identifier);
        expect(native.invoke).toHaveBeenLastCalledWith('desktop_notification_remove', { identifier: interaction.identifier });
    });

    it.each(['data', 'envelope'] as const)('refuses presentation for an Account replaced after the %s was produced', async location => {
        const { sendTauriLocalNotification } = await import('./sendTauriLocalNotification');
        await expect(sendTauriLocalNotification({ title: 'Original private session', body: 'Original content',
            interaction: { identifier: 'original-event',
                ...(location === 'envelope' ? { accountId: 'previous-owner' } : {}),
                data: { serverId: homeId, sessionId: 's1', ...(location === 'data' ? { accountId: 'previous-owner' } : {}) }, actions: [] },
        })).rejects.toThrow('notification_account_unavailable');
        expect(native.invoke).not.toHaveBeenCalled(); expect(sendNotification).not.toHaveBeenCalled();
    });

    it('recovers a native action received before the renderer subscribed, then drains only on native arrival', async () => {
        const { subscribeDesktopNotificationResponses } = await import('./tauriNotificationPlugin');
        const response = { actionIdentifier: 'HAPPIER_GUARD_KEEP_RUNNING_V1', notification: {
            request: { identifier: 'home-a:guard-stop:s1:900', content: { accountId: 'owner', data: { topic: 'guard_stop_warning', stopAt: 900 } } },
        } };
        native.invoke.mockResolvedValueOnce([response]).mockResolvedValue([]);
        const received = vi.fn();
        const remove = await subscribeDesktopNotificationResponses(received);
        expect(received.mock.calls).toEqual([[response]]);
        expect(native.invoke.mock.calls).toEqual([['desktop_notification_take_responses']]);
        // Settled notifications do not poll. One OS arrival drains the native queue once.
        native.listen.mock.calls[0][1]();
        await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(2));
        expect(received).toHaveBeenCalledTimes(1);
        remove();
    });
});
