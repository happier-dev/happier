import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { clearPersistenceStorage, getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { resetSessionSurfaceVisibilityForTests, setFocusedSessionId } from '@/sync/domains/session/sessionSurfaceVisibility';
import { resolveSessionSwitcherRecentPool } from '@/sync/domains/session/navigation/sessionSwitcherOrder';
import { useSessionSurfaceActivation, type UseSessionSurfaceActivationInput } from './useSessionSurfaceActivation';

const key = (sessionId: string, serverId = 'home-a') => sessionAddressKey({ sessionId, serverId });
const destination = 'ui-state:session-navigation-mru-v1:order';
const readMruOrder = (): string[] => JSON.parse(getPersistenceStorage().getString(destination) ?? '[]');

beforeEach(() => {
    resetSessionSurfaceVisibilityForTests();
    clearPersistenceStorage();
    storage.setState({ localSettings: { ...localSettingsDefaults } });
});

afterEach(async () => {
    await standardCleanup();
    resetSessionSurfaceVisibilityForTests();
    vi.restoreAllMocks();
    clearPersistenceStorage();
});

describe('focused session MRU without a Sessions list participant', () => {
    it('persists route opens and retained tab activation for the switcher Recent source', async () => {
        const writes = vi.spyOn(getPersistenceStorage(), 'set');
        // Switcher, notification and deep-link routes mount/retarget this same surface;
        // a retained workspace tab instead becomes focused without remounting.
        const surface = (sessionId: string, focused = true): UseSessionSurfaceActivationInput => ({
            sessionId, serverId: 'home-a', surfaceVisible: true, surfaceFocused: focused, routeAnchor: focused,
        });
        const hook = await renderHook(useSessionSurfaceActivation, { initialProps: surface('switcher-open') });
        expect(readMruOrder()).toEqual([key('switcher-open')]);

        await hook.rerender(surface('tab-open', false));
        expect(readMruOrder()).toEqual([key('switcher-open')]);
        await hook.rerender(surface('tab-open'));
        expect(readMruOrder()).toEqual([key('tab-open'), key('switcher-open')]);

        await hook.rerender(surface('notification-open'));
        expect(readMruOrder()).toEqual([
            key('notification-open'), key('tab-open'), key('switcher-open'),
        ]);
        await hook.unmount();
        // Cold route entry, as with a deep link, does not need a list or existing session record.
        const deepLink = await renderHook(useSessionSurfaceActivation, { initialProps: surface('deep-link-open') });
        const expected = [key('deep-link-open'), key('notification-open'), key('tab-open'), key('switcher-open')];
        expect(readMruOrder()).toEqual(expected);
        expect(resolveSessionSwitcherRecentPool({
            currentKey: key('deep-link-open'), mruSessionKeys: readMruOrder(), openTabs: [],
        }).map((entry) => entry.sessionKey)).toEqual(expected);
        expect(writes.mock.calls.filter(([name]) => name === 'settings' || name === 'local-settings')).toHaveLength(0);
        await deepLink.unmount();
    });

    it('preserves other Homes and unloaded history, deduplicates revisits, and suppresses same-focus writes', () => {
        const unloaded = key('unloaded', 'home-b');
        getPersistenceStorage().set(destination, JSON.stringify([unloaded]));
        setFocusedSessionId('same-id', 'home-a');
        setFocusedSessionId('same-id', 'home-b');
        setFocusedSessionId('same-id', 'home-a');
        expect(readMruOrder()).toEqual([key('same-id'), key('same-id', 'home-b'), unloaded]);
        const snapshot = storage.getState();
        setFocusedSessionId('same-id', 'home-a');
        setFocusedSessionId(null);
        expect(storage.getState()).toBe(snapshot);
    });
});
