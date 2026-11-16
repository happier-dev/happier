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
    it('snapshots the same identity-qualified multi-Home defaults for a saved-space override', async () => {
        const first = await harness.addHome({ name: 'A', serverUrl: 'https://spaces.a.example',
            serverIdentityId: 'srv_spaces_a', accountId: 'account-a' });
        const second = await harness.addHome({ name: 'B', serverUrl: 'https://spaces.b.example',
            serverIdentityId: 'srv_spaces_b', accountId: 'account-b' });
        const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
        await updateEffectiveHomeViewState(() => ({ version: 1,
            groups: [{ id: 'both', name: 'Both', serverIds: [first, second] }], activeTargetKind: 'group', activeTargetId: 'both',
        }), { scope: 'device' });
        const { useResolvedActiveServerSelection } = await import('./useEffectiveServerSelection');
        const hook = await renderHook(() => useResolvedActiveServerSelection());
        await waitForHomeGovernance(() => expect(hook.getCurrent().allowedServerIds).toEqual(['srv_spaces_a', 'srv_spaces_b']));
        const { readResolvedActiveServerSelection } = await import('@/sync/domains/server/selection/serverSelectionResolution');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        expect(readResolvedActiveServerSelection(settingsDefaults)).toEqual(hook.getCurrent());
        const { readCollectionSpaceDefaultV1 } = await import('@/components/settings/session/collectionSpaceDefaults');
        expect(readCollectionSpaceDefaultV1('sessionWork', settingsDefaults))
            .toMatchObject({ id: 'my-work', entityKind: 'sessionWork', filter: {
                homeServerIds: ['srv_spaces_a', 'srv_spaces_b'], scope: 'my_work', audiences: [],
            } });
    });

    it('retains only an unchanged Home view in its device namespace, and publishes changed content', async () => {
        const { loadHomeViewState, saveHomeViewState, resetServerProfilesRuntimeForTests } = await import('@/sync/domains/server/serverProfiles');
        // Exercise namespaced browser persistence, not the suite's native
        // MMKV boundary whose in-memory backing intentionally ignores ids.
        vi.stubGlobal('window', { localStorage });
        vi.stubGlobal('document', {});
        resetServerProfilesRuntimeForTests();
        const home = await harness.addHome({ name: 'A', serverUrl: 'https://projection.a.example', accountId: 'account-a' });
        await saveHomeViewState({ version: 1, groups: [], activeTargetKind: null, activeTargetId: null });
        const previous = loadHomeViewState();
        expect(previous).not.toBeNull();
        await saveHomeViewState({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: home });
        const changed = loadHomeViewState();
        expect(changed).not.toBe(previous);
        expect(changed).toMatchObject({ activeTargetKind: 'server', activeTargetId: home });
        expect(loadHomeViewState()).toBe(changed);

        vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', 'home-view-projection-empty-scope');
        resetServerProfilesRuntimeForTests();
        try {
            expect(loadHomeViewState()).toBeNull();
        } finally {
            vi.unstubAllEnvs();
            resetServerProfilesRuntimeForTests();
        }
    });
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
        const { setServerProfileShareableUrl, getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        await act(async () => { await setServerProfileShareableUrl(home, 'https://public.a.example'); });
        expect(getServerProfileById(home)?.shareableServerUrl).toBe('https://public.a.example');
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
    it('derives one selection for every mounted reader (a Session screen mounts hundreds of feature decisions)', async () => {
        await harness.addHome({ name: 'A', serverUrl: 'https://shared.a.example', accountId: 'account-a' });
        const { useEffectiveServerSelection, useResolvedActiveServerSelection } = await import('./useEffectiveServerSelection');
        const readers = 20;
        const hook = await renderHook(() => Array.from({ length: readers }, (_, index) => index % 2 === 0
            ? useEffectiveServerSelection() : useResolvedActiveServerSelection()));
        await waitForHomeGovernance(() => expect((hook.getCurrent()[0] as { serverIds: string[] }).serverIds).toHaveLength(1));
        const current = hook.getCurrent();
        expect(new Set(current.filter((_, index) => index % 2 === 0)).size).toBe(1);
        expect(new Set(current.filter((_, index) => index % 2 === 1)).size).toBe(1);
    });
});
