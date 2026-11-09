import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// Real focus transaction, profile owner, credential store and connection manager;
// only the browser, Home network and Socket SDK boundaries are fakes.
installTokenStorageWebPlatformMocks();
installDisconnectedServerSocketBoundary(socket => { configureConnectedServerSocketBoundary(socket); });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const profiles = await import('./serverProfiles');
const { getAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { setActiveServerAndSwitch, upsertActivateAndSwitchServer } = await import('./activeServerSwitch');
const baseline = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | null = null;

/** A credential the device holds for a Home but whose token names no Account, so the real Sync restore rejects it. */
const UNUSABLE_CREDENTIAL = { token: 'not-an-account-token' };

function requireOrigin(): string {
    if (!connection || !browser) throw new Error('Expected the admitted browser origin Account');
    return connection.serverId;
}

function appliedServerId(): string | null {
    return getAppliedActiveServerSnapshot().serverId;
}

function targetWithoutGeneration(snapshot: ReturnType<typeof profiles.getActiveServerSnapshot>) {
    const { generation: _generation, ...target } = snapshot;
    return target;
}

beforeEach(async () => {
    browser = await installBrowserRuntimeForTests({ url: 'https://app.happier.dev' });
    await homes.reset();
    storage.setState(baseline, true);
    await homes.addHome({ name: 'Origin', serverUrl: 'https://focus-origin.test', accountId: 'origin-account' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://focus-origin.test', accountId: 'origin-account', request: homes.request });
    installHomeGovernanceBoundaries(homes);
});

afterEach(async () => {
    vi.restoreAllMocks();
    // Cases end focused on whichever Home they switched to; stop its Sync while the
    // Home boundary still answers, so no late bootstrap request reaches the real network.
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    await connection?.dispose();
    connection = null;
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    browser?.restore();
    browser = null;
});

describe('activeServerSwitch device scope', () => {
    it('switches a full secondary Home without changing the main device Home', async () => {
        const originId = requireOrigin();
        const secondaryId = await homes.addHome({ name: 'Secondary', serverUrl: 'https://focus-secondary.test', accountId: 'secondary-account', active: false });
        vi.stubGlobal('isTauri', true);
        browser!.reconfigureUrl('https://app.happier.dev/desktop/app-window');
        const { resolveRoutineServerSelectionScope } = await import('./selection/serverSelectionScope');
        try {
            await expect(setActiveServerAndSwitch({ serverId: secondaryId, scope: resolveRoutineServerSelectionScope('web', true) })).resolves.toBe('switched');
            expect(profiles.getDeviceDefaultServerId()).toBe(originId);
            expect(profiles.getTabActiveServerId()).toBe(secondaryId);
            expect(appliedServerId()).toBe(secondaryId);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it.each(['saved-profile', 'address'] as const)('promotes the current tab Home to the device Home through %s', async entry => {
        requireOrigin();
        const tabId = await homes.addHome({ name: 'Tab', serverUrl: 'https://focus-tab.test', accountId: 'tab-account', active: false });
        await expect(setActiveServerAndSwitch({ serverId: tabId, scope: 'tab' })).resolves.toBe('switched');
        expect(profiles.getTabActiveServerId()).toBe(tabId);

        const switched = entry === 'saved-profile'
            ? await setActiveServerAndSwitch({ serverId: tabId, scope: 'device' })
            : await upsertActivateAndSwitchServer({ serverUrl: 'https://focus-tab.test', source: 'url', scope: 'device' });

        expect(switched).toBe('switched');
        expect(profiles.getTabActiveServerId()).toBeNull();
        expect(profiles.getDeviceDefaultServerId()).toBe(tabId);
        expect(profiles.getActiveServerId()).toBe(tabId);
        expect(appliedServerId()).toBe(tabId);
    });

    it('re-adopts a known Home without moving focus, then opens it without changing the saved groups', async () => {
        const originId = requireOrigin();
        const adoptedId = await homes.addHome({
            name: 'Adopted', serverUrl: 'https://focus-adopted.test', serverIdentityId: 'srv_adopted_home',
            accountId: 'adopted-account', active: false,
        });
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'saved-homes', name: 'Saved Homes', serverIds: [originId, adoptedId], presentation: 'grouped' }],
            activeTargetKind: 'server',
            activeTargetId: originId,
        });
        const groupsBefore = profiles.loadHomeViewState()?.groups;
        const { connectHomeAtAddress } = await import('@/sync/ops/home/connectHomeAtAddress');
        const reconnected = await connectHomeAtAddress({
            serverUrl: 'https://focus-adopted.test',
            confirmInsecureHttp: async () => true,
            confirmCanonicalUrl: async () => true,
        });
        expect(reconnected.kind).toBe('connected');
        if (reconnected.kind !== 'connected') throw new Error('Expected the known Home to reconnect');
        expect(reconnected.profile.id).toBe(adoptedId);
        expect(profiles.getActiveServerId()).toBe(originId);
        expect(appliedServerId()).toBe(originId);

        // Add a Home preserves focus; its explicit Open action owns the switch.
        await expect(setActiveServerAndSwitch({ serverId: reconnected.profile.id, scope: 'device' })).resolves.toBe('switched');

        expect(profiles.getActiveServerId()).toBe('srv_adopted_home');
        expect(profiles.getDeviceDefaultServerId()).toBe(adoptedId);
        expect(profiles.loadHomeViewState()?.groups).toEqual(groupsBefore);
        expect(appliedServerId()).toBe('srv_adopted_home');
    });

    it('returns to an already signed-in Home through the shared Add Home completion', async () => {
        requireOrigin();
        const knownId = await homes.addHome({
            name: 'Known', serverUrl: 'https://focus-known.test', serverIdentityId: 'srv_known_home',
            accountId: 'known-account', active: false,
        });
        const { readUsableHomeServerIds } = await import('@/sync/domains/scope/usableHomeServerIds');
        await vi.waitFor(() => expect(readUsableHomeServerIds()).toContain('srv_known_home'));
        const { renderHook } = await import('@/dev/testkit');
        const { act } = await import('react-test-renderer');
        const { useAddHomeFlow } = await import('@/components/homes/add/useAddHomeFlow');
        const hook = await renderHook(() => useAddHomeFlow({
            initialPath: 'direct', serviceStatus: 'not_offered',
            serviceHostsHome: false, canSetUpServerHome: false,
        }));
        try {
            const { connectHomeAtAddress } = await import('@/sync/ops/home/connectHomeAtAddress');
            const reconnected = await connectHomeAtAddress({
                serverUrl: 'https://focus-known.test',
                confirmInsecureHttp: async () => true,
                confirmCanonicalUrl: async () => true,
            });
            expect(reconnected.kind).toBe('connected');
            if (reconnected.kind !== 'connected') throw new Error('Expected the known Home to reconnect');
            expect(reconnected.profile.id).toBe(knownId);
            await act(async () => { await hook.getCurrent().homeConnected(reconnected.profile); });
            expect(hook.getCurrent().completion?.kind).toBe('focused');
            expect(profiles.getActiveServerId()).toBe('srv_known_home');
            expect(appliedServerId()).toBe('srv_known_home');
        } finally {
            await hook.unmount();
        }
    });

    it('does not switch when the target id aliases the active Home identity', async () => {
        const originId = requireOrigin();
        await profiles.setServerProfileIdentityForUrl('https://focus-origin.test', 'srv_identity_123');
        const appliedBefore = getAppliedActiveServerSnapshot();

        await expect(setActiveServerAndSwitch({ serverId: originId, scope: 'device' })).resolves.toBe('already_active');

        expect(profiles.getActiveServerId()).toBe('srv_identity_123');
        expect(profiles.getDeviceDefaultServerId()).toBe(originId);
        expect(getAppliedActiveServerSnapshot()).toBe(appliedBefore);
    });

    it('reasserts an exact saved profile and reconnects when its Home identity is already active', async () => {
        const originId = requireOrigin();
        await profiles.setServerProfileIdentityForUrl('https://focus-origin.test', 'srv_identity_123');
        const appliedGenerationBefore = getAppliedActiveServerSnapshot().generation;
        const refreshAuth = vi.fn(async () => {});

        await expect(setActiveServerAndSwitch({
            serverId: originId,
            scope: 'device',
            refreshAuth,
            requireExactProfile: true,
        })).resolves.toBe('switched');

        expect(profiles.getDeviceDefaultServerId()).toBe(originId);
        expect(refreshAuth).toHaveBeenCalledOnce();
        expect(getAppliedActiveServerSnapshot().generation).toBeGreaterThan(appliedGenerationBefore);
        expect(getAppliedActiveServerSnapshot().generation).toBe(profiles.getActiveServerSnapshot().generation);
    });

    it.each([
        ['the target Home cannot be connected', 'readiness'],
        ['the auth refresh rejects', 'refresh'],
    ] as const)('restores device and tab focus and reapplies the prior connection when %s', async (_label, failure) => {
        const originId = requireOrigin();
        const tabId = await homes.addHome({ name: 'Tab', serverUrl: 'https://focus-tab.test', accountId: 'tab-account', active: false });
        await expect(setActiveServerAndSwitch({ serverId: tabId, scope: 'tab' })).resolves.toBe('switched');
        const targetId = await homes.addHome({
            name: 'Target', serverUrl: 'https://focus-target.test', accountId: 'target-account', active: false,
            ...(failure === 'readiness' ? { credentials: UNUSABLE_CREDENTIAL } : {}),
        });
        const priorActive = profiles.getActiveServerSnapshot();
        const refreshFailure = new Error('active server auth refresh failed');
        const refreshAuth = vi.fn(async () => {
            if (failure === 'refresh') throw refreshFailure;
        });

        const attempted = setActiveServerAndSwitch({ serverId: targetId, scope: 'device', refreshAuth });

        if (failure === 'refresh') {
            await expect(attempted).rejects.toBe(refreshFailure);
            expect(refreshAuth).toHaveBeenCalledOnce();
        } else {
            await expect(attempted).rejects.toBeInstanceOf(Error);
            expect(refreshAuth).not.toHaveBeenCalled();
        }
        expect(profiles.getDeviceDefaultServerId()).toBe(originId);
        expect(profiles.getTabActiveServerId()).toBe(tabId);
        const restored = profiles.getActiveServerSnapshot();
        expect(targetWithoutGeneration(restored)).toEqual(targetWithoutGeneration(priorActive));
        expect(restored.generation).toBeGreaterThan(priorActive.generation);
        expect(appliedServerId()).toBe(tabId);
        expect(getAppliedActiveServerSnapshot().generation).toBe(restored.generation);
    });

    it('keeps the target failure visible when reapplying the prior connection also fails', async () => {
        const originId = requireOrigin();
        const originToken = connection!.credentials.token;
        const targetId = await homes.addHome({ name: 'Target', serverUrl: 'https://focus-target.test', accountId: 'target-account', active: false });
        const targetFailure = new Error('target auth refresh failed');
        const refreshAuth = vi.fn(async () => {
            // The prior Home's stored credential stops naming an Account at the
            // browser storage boundary, so reapplying it fails as well.
            const localStorage = browser!.window.localStorage;
            for (let index = 0; index < localStorage.length; index += 1) {
                const key = localStorage.key(index);
                const value = key === null ? null : localStorage.getItem(key);
                if (key !== null && value?.includes(originToken)) {
                    localStorage.setItem(key, value.replaceAll(originToken, UNUSABLE_CREDENTIAL.token));
                }
            }
            throw targetFailure;
        });

        const attempted = setActiveServerAndSwitch({ serverId: targetId, scope: 'tab', refreshAuth });

        await expect(attempted).rejects.toMatchObject({ name: 'AggregateError' });
        const failure = await attempted.catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toHaveLength(2);
        expect((failure as AggregateError).errors[0]).toBe(targetFailure);
        expect((failure as AggregateError).errors[1]).toBeInstanceOf(Error);
        expect(profiles.getDeviceDefaultServerId()).toBe(originId);
        expect(profiles.getTabActiveServerId()).toBeNull();
        expect(profiles.getActiveServerId()).toBe(originId);
    });

    it('finishes a failed tab focus rollback before applying the next tab request', async () => {
        const originId = requireOrigin();
        const middleId = await homes.addHome({
            name: 'Middle', serverUrl: 'https://focus-middle.test', accountId: 'middle-account', active: false,
            credentials: UNUSABLE_CREDENTIAL,
        });
        const finalId = await homes.addHome({ name: 'Final', serverUrl: 'https://focus-final.test', accountId: 'final-account', active: false });

        // Issued back to back: if the second request staged while the first was
        // still rolling back, that rollback would clear the second's tab focus.
        const first = setActiveServerAndSwitch({ serverId: middleId, scope: 'tab' });
        const second = setActiveServerAndSwitch({ serverId: finalId, scope: 'tab' });

        await expect(first).rejects.toBeInstanceOf(Error);
        await expect(second).resolves.toBe('switched');
        expect(profiles.getDeviceDefaultServerId()).toBe(originId);
        expect(profiles.getTabActiveServerId()).toBe(finalId);
        expect(profiles.getActiveServerId()).toBe(finalId);
        expect(appliedServerId()).toBe(finalId);
    });

    it('fails closed without mutating focus when the requested profile does not exist', async () => {
        const originId = requireOrigin();
        const appliedBefore = getAppliedActiveServerSnapshot();

        await expect(setActiveServerAndSwitch({ serverId: 'missing-home', scope: 'tab' })).resolves.toBe('blocked');

        expect(profiles.getDeviceDefaultServerId()).toBe(originId);
        expect(profiles.getTabActiveServerId()).toBeNull();
        expect(profiles.getActiveServerId()).toBe(originId);
        expect(getAppliedActiveServerSnapshot()).toBe(appliedBefore);
    });
});
