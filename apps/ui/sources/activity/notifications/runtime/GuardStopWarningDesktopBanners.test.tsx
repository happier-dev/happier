import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { renderScreen, waitForTestEvent } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';

const os = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    return { listeners, invoke: vi.fn(async (_command: string, _args?: unknown) => {
        if (_command === 'desktop_capture_read_state') return { status: 'idle' };
        for (const notify of listeners) notify();
    }) };
});
// Only native IPC and notification permission are replaced; the channel and producer run for real.
vi.mock('@/utils/platform/desktopHost', () => ({ isDesktopHost: () => true, desktopHostKind: () => 'tauri', invokeDesktopHost: os.invoke,
    listenDesktopHostEvent: async () => () => {} }));
vi.mock('@tauri-apps/plugin-notification', () => ({
    isPermissionGranted: async () => true, requestPermission: async () => 'granted', sendNotification: vi.fn(),
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { GuardStopWarningDesktopBanners } = await import('./GuardStopWarningDesktopBanners');
let homeId: string;
beforeEach(async () => {
    await homes.reset();
    homeId = await homes.addHome({ name: 'Banner Home', serverUrl: 'https://guard-banner.test', accountId: 'owner', currentAccount: true });
});

const before = storage.getState();
afterEach(async () => { setScreenSharingPrivacyActive(false); storage.setState(before); os.invoke.mockClear(); os.listeners.clear(); await homes.reset(); });

function stopping(stopAt: number): Session {
    return createSessionFixture({ id: 'tidy', active: true, serverId: homeId,
        metadata: { path: '/w', host: 'leeroy-mbp', homeDir: '/u', machineId: 'm', summary: { text: 'Tidy fixtures', updatedAt: 1 },
            sessionGuardStateV1: { v: 1, kind: 'stopping', stopAt, rule: 'idle_sessions' } } as Session['metadata'] });
}

function stoppingNamed(stopAt: number): Session {
    return createSessionFixture({ id: 'named', active: true, serverId: homeId,
        metadata: { path: '/w', host: 'leeroy-mbp', homeDir: '/u', machineId: 'm', name: 'Nightly sweep',
            sessionGuardStateV1: { v: 1, kind: 'stopping', stopAt, rule: 'idle_sessions' } } as Session['metadata'] });
}

describe('GuardStopWarningDesktopBanners', () => {
    it('omits recording-private guard banners while still announcing a public Session', async () => {
        const stopAt = Date.now() + 7 * 60_000;
        storage.setState({ sessions: { named: stoppingNamed(stopAt), tidy: stopping(stopAt) } });
        storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [homeId]: ['private'] } });
        storage.getState().setSessionTagAssignmentsOptimistic(homeId, 'named', ['private']);
        setScreenSharingPrivacyActive(true);
        const screen = await renderScreen(<GuardStopWarningDesktopBanners />);
        await act(async () => { await Promise.resolve(); });
        const titles = os.invoke.mock.calls.filter(([command]) => command === 'desktop_notification_show')
            .map(([, args]) => (args as { notification: { title: string } }).notification.title);
        expect(titles).toHaveLength(1);
        expect(titles[0]).toContain('Tidy fixtures');
        expect(titles.join(' ')).not.toContain('Nightly sweep');
        await act(async () => { setScreenSharingPrivacyActive(false); });
        const restoredTitles = os.invoke.mock.calls.filter(([command]) => command === 'desktop_notification_show')
            .map(([, args]) => (args as { notification: { title: string } }).notification.title);
        expect(restoredTitles).toHaveLength(2);
        expect(restoredTitles[1]).toContain('Nightly sweep');
        await screen.unmount();
    });

    it('names a Session the way the list and header do, not only by its summary', async () => {
        storage.setState({ sessions: { named: stoppingNamed(Date.now() + 5 * 60_000) } } as never);
        const screen = await renderScreen(<GuardStopWarningDesktopBanners />);
        await act(async () => { await Promise.resolve(); });
        expect(os.invoke).toHaveBeenCalledWith('desktop_notification_show', { notification: expect.objectContaining({ title: 'Stopping “Nightly sweep” in 5 minutes' }) });
        await screen.unmount?.();
    });

    it('announces a coming guard stop once on this computer, naming the session and when', async () => {
        const stopAt = Date.now() + 5 * 60_000;
        storage.setState({ sessions: { tidy: stopping(stopAt) } } as never);
        const screen = await renderScreen(<GuardStopWarningDesktopBanners />);
        await act(async () => { await Promise.resolve(); });
        const shows = () => os.invoke.mock.calls.filter(([command]) => command === 'desktop_notification_show');
        expect(shows()).toHaveLength(1);
        expect(os.invoke).toHaveBeenCalledWith('desktop_notification_show', { notification: expect.objectContaining({ title: 'Stopping “Tidy fixtures” in 5 minutes',
            body: 'It finished its work and wakes on your next message. Keep it running from the session.',
            actions: [expect.objectContaining({ id: 'HAPPIER_GUARD_KEEP_RUNNING_V1' }), expect.objectContaining({ id: 'HAPPIER_GUARD_STOP_NOW_V1' })],
        }) });
        const first = shows()[0][1] as { notification: { identifier: string; data: unknown } };
        const { GuardStopWarningPushDataV1Schema } = await import('@happier-dev/protocol/activity/webhookPayload');
        expect(GuardStopWarningPushDataV1Schema.safeParse(first.notification.data).success).toBe(true);
        // The same warning again (any later store change) is not announced twice; a new stop time is.
        await act(async () => { storage.setState({ sessions: { tidy: stopping(stopAt) } } as never); });
        expect(shows()).toHaveLength(1);
        await act(async () => { storage.setState({ localSettings: { ...storage.getState().localSettings } }); });
        expect(shows()).toHaveLength(1);
        await act(async () => { storage.setState({ sessions: { tidy: stopping(stopAt + 3_600_000) } } as never); });
        await act(async () => {
            await waitForTestEvent(notify => {
                os.listeners.add(notify);
                return () => { os.listeners.delete(notify); };
            }, () => { expect(shows()).toHaveLength(2); });
        });
        await screen.unmount?.();
    });
});
