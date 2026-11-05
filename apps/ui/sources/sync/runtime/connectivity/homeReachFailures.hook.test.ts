import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The focused connectivity harness avoids loading unrelated screen fixtures from the barrel.
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { getPersistenceStorage, getPersistenceStorageId } from '@/sync/domains/state/persistenceStorage';
import * as profiles from '@/sync/domains/server/serverProfiles';
import { useLaptopHomeNudgeFacts } from '@/components/homes/journeys/nudge/useLaptopHomeNudgeFacts';

import { dismissHomeReachNudge, recordFailedHomeReach, useHomeReachNudge } from './homeReachFailures';

describe('device-local Home reach nudge subscription', () => {
    beforeEach(async () => {
        await selectActiveTestHomeForTests();
        getPersistenceStorage().delete('home-reach-failures-v2');
        getPersistenceStorage().delete('home-reach-nudge-dismissed-v1');
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        getPersistenceStorage().delete('home-reach-failures-v2');
        getPersistenceStorage().delete('home-reach-nudge-dismissed-v1');
    });

    it('mounts, updates and unmounts on native without browser event APIs', async () => {
        vi.stubGlobal('window', globalThis);
        const hook = await renderHook(() => useHomeReachNudge('srv_home_a'));
        try {
            expect(hook.getCurrent()).toEqual({ show: false, failureCount: 0 });
            await act(async () => { recordFailedHomeReach('srv_home_a', Date.now()); });
            expect(hook.getCurrent()).toEqual({ show: false, failureCount: 1 });
        } finally {
            await hook.unmount();
        }
    });

    it('refreshes web readers on cross-tab storage events and detaches on unmount', async () => {
        const browserWindow = new EventTarget();
        vi.stubGlobal('window', browserWindow);
        const hook = await renderHook(() => useHomeReachNudge('srv_home_a'));
        const notifyOtherTab = () => {
            const event = new Event('storage');
            Object.defineProperty(event, 'key', { value: `${getPersistenceStorageId()}\\home-reach-failures-v2` });
            browserWindow.dispatchEvent(event);
        };
        try {
            await act(async () => {
                getPersistenceStorage().set('home-reach-failures-v2', JSON.stringify({
                    srv_home_a: [{ day: Math.floor(Date.now() / 86_400_000), count: 3 }],
                }));
                notifyOtherTab();
            });
            expect(hook.getCurrent()).toEqual({ show: true, failureCount: 3 });
        } finally {
            await hook.unmount();
        }
        getPersistenceStorage().delete('home-reach-failures-v2');
        notifyOtherTab();
        const remounted = await renderHook(() => useHomeReachNudge('srv_home_a'));
        try {
            expect(remounted.getCurrent()).toEqual({ show: false, failureCount: 0 });
        } finally {
            await remounted.unmount();
        }
    });

    it('updates the mounted reader at the third failure and after permanent dismissal', async () => {
        const hook = await renderHook(() => useHomeReachNudge('srv_home_a'));
        try {
            expect(hook.getCurrent()).toEqual({ show: false, failureCount: 0 });
            await act(async () => {
                recordFailedHomeReach('srv_home_a', Date.now());
                recordFailedHomeReach('srv_home_a', Date.now());
            });
            expect(hook.getCurrent()).toEqual({ show: false, failureCount: 2 });
            await act(async () => { recordFailedHomeReach('srv_home_a', Date.now()); });
            expect(hook.getCurrent()).toEqual({ show: true, failureCount: 3 });
            await act(async () => { dismissHomeReachNudge('srv_home_a'); });
            expect(hook.getCurrent()).toEqual({ show: false, failureCount: 3 });
        } finally {
            await hook.unmount();
        }
    });

    it('shows J6 for the focused Home’s local failures and follows Home changes and permanent dismissal', async () => {
        // Collect the real module graph above; module loading is not this contract's runtime.
        const previousServerId = profiles.getActiveServerId();
        const first = await profiles.upsertServerProfile({ serverUrl: 'https://nudge-a.example.test', name: 'Home A' });
        const second = await profiles.upsertServerProfile({ serverUrl: 'https://nudge-b.example.test', name: 'Home B' });
        await profiles.setServerProfileIdentityForUrl(first.serverUrl, 'srv_nudge_a');
        await profiles.setServerProfileIdentityForUrl(second.serverUrl, 'srv_nudge_b');
        expect(first.id).not.toBe('srv_nudge_a');
        await profiles.setActiveServerId('srv_nudge_a');
        const hook = await renderHook(() => useLaptopHomeNudgeFacts());
        try {
            expect(hook.getCurrent()).toBeNull();
            await act(async () => {
                for (let index = 0; index < 3; index++) recordFailedHomeReach('srv_nudge_a', Date.now());
            });
            expect(hook.getCurrent()).toMatchObject({ homeServerId: first.id, homeIdentityId: 'srv_nudge_a', missedReachesThisWeek: 3 });
            await act(async () => { await profiles.setActiveServerId('srv_nudge_b'); });
            expect(hook.getCurrent()).toBeNull();
            await act(async () => { await profiles.setActiveServerId('srv_nudge_a'); });
            expect(hook.getCurrent()).toMatchObject({ missedReachesThisWeek: 3 });
            await act(async () => { dismissHomeReachNudge('srv_nudge_a'); });
            expect(hook.getCurrent()).toBeNull();
        } finally {
            await hook.unmount();
            await profiles.setActiveServerId(previousServerId);
            await profiles.removeServerProfile(first.id);
            await profiles.removeServerProfile(second.id);
        }
    });
});
