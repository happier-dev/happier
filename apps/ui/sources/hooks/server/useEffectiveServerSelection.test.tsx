import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook } from '@/dev/testkit/hooks/renderHook';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
beforeEach(async () => {
    await harness.reset();
    const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
    await updateEffectiveHomeViewState(() => ({
        version: 1, groups: [], activeTargetKind: null, activeTargetId: null,
    }), { scope: 'device' });
});
afterEach(standardCleanup);

describe('useResolvedActiveServerSelection', () => {
    it('recomputes the resolved active server when a signed-in Home is added after the initial pass', async () => {
        const { useResolvedActiveServerSelection } = await import('./useEffectiveServerSelection');
        const hook = await renderHook(() => useResolvedActiveServerSelection());
        const initialId = hook.getCurrent().activeServerId;
        let home = '';
        await act(async () => {
            home = await harness.addHome({ name: 'A', serverUrl: 'https://api.a.example', accountId: 'account-a' });
        });
        expect(home).not.toBe(initialId);
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({
            activeTarget: { kind: 'server', id: home, serverId: home },
            activeServerId: home,
            allowedServerIds: [home],
            enabled: false,
            presentation: 'grouped',
            explicit: false,
        }));
    });

    it('uses the identity-backed active server id as an available server id', async () => {
        const home = await harness.addHome({
            name: 'A', serverUrl: 'https://api.a.example',
            serverIdentityId: 'srv_identity_active', accountId: 'account-a',
        });
        const { getServerProfileById, resolveServerProfileScopeId } = await import('@/sync/domains/server/serverProfiles');
        const profile = getServerProfileById(home);
        if (!profile) throw new Error('Expected identity-backed Home');
        expect(resolveServerProfileScopeId(profile)).toBe('srv_identity_active');
        const { useResolvedActiveServerSelection } = await import('./useEffectiveServerSelection');
        const hook = await renderHook(() => useResolvedActiveServerSelection());
        expect(hook.getCurrent().activeServerId).toBe('srv_identity_active');
        expect(hook.getCurrent().allowedServerIds).toEqual(['srv_identity_active']);
    });

    it('keeps the resolved active server stable when profile metadata changes without changing selection inputs', async () => {
        const home = await harness.addHome({ name: 'A', serverUrl: 'https://api.a.example', accountId: 'account-a' });
        const { readUsableHomeServerIds } = await import('@/sync/domains/scope/usableHomeServerIds');
        await waitForHomeGovernance(() => expect(readUsableHomeServerIds()).toEqual([home]));
        const { useResolvedActiveServerSelection } = await import('./useEffectiveServerSelection');
        const hook = await renderHook(() => useResolvedActiveServerSelection());
        const initial = hook.getCurrent();
        const { upsertServerProfile, getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        await act(async () => { await upsertServerProfile({ serverUrl: 'https://api.a.example', name: 'Renamed A' }); });
        expect(getServerProfileById(home)?.name).toBe('Renamed A');
        expect(hook.getCurrent()).toBe(initial);
    });
});

describe('useEffectiveServerSelection', () => {
    it('recomputes the effective active server when a signed-in Home is added after the initial pass', async () => {
        const { useEffectiveServerSelection } = await import('./useEffectiveServerSelection');
        const hook = await renderHook(() => useEffectiveServerSelection());
        const initialIds = hook.getCurrent().serverIds;
        let home = '';
        await act(async () => {
            home = await harness.addHome({ name: 'A', serverUrl: 'https://api.a.example', accountId: 'account-a' });
        });
        expect(initialIds).not.toContain(home);
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({
            enabled: false, serverIds: [home], presentation: 'grouped',
        }));
    });
});
