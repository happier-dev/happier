import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachinePoolViewV1 } from '@happier-dev/protocol';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storage';
import { switchConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { refreshMachinePools } from './machinePools';

const initialStorageState = getStorage().getState();
const boundary = {
    activeServerId: '',
    backgroundServerId: '',
    pendingResponses: [] as Array<{ url: string; resolve(response: Response): void }>,
};

// Releasing an acquired transport is genuinely asynchronous for the Home carrier. The real
// transport is preserved; only its release is held open so an Account switch can land inside it.
const transportBoundary = vi.hoisted(() => ({
    delayRelease: false,
    pendingReleases: [] as Array<() => void>,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport', async (importOriginal) => {
    type TransportModule = typeof import('@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport');
    const actual = await importOriginal<TransportModule>();
    return {
        ...actual,
        resolveServerScopedTransport: async (args: Parameters<TransportModule['resolveServerScopedTransport']>[0]) => {
            const transport = await actual.resolveServerScopedTransport(args);
            return {
                ...transport,
                release: async () => {
                    if (transportBoundary.delayRelease) {
                        await new Promise<void>((resolve) => transportBoundary.pendingReleases.push(resolve));
                    }
                    await transport.release();
                },
            };
        },
    };
});

const alicePool = {
    pool: {
        id: '00000000-0000-4000-8000-000000000001', name: 'Alice private pool',
        description: null, revision: 1, createdAt: 1, updatedAt: 1, members: [],
    },
    availability: { state: 'known' as const, connectedCount: 0, enabledCount: 0 },
} satisfies MachinePoolViewV1;

async function enableMachinePoolsFeatures(serverIds: readonly string[]): Promise<void> {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
        features: { machines: { enabled: true, pools: { enabled: true } } },
        capabilities: {},
    })));
    for (const serverId of serverIds) await getServerFeaturesSnapshot({ serverId, force: true });
}

describe('machine pool Account lifetime', () => {
    beforeEach(async () => {
        await loadSyncSingletonForTests();
        retireActiveServerAccountScopeLifetime();
        resetServerFeaturesClientForTests();
        getStorage().setState(initialStorageState, true);
        boundary.activeServerId = (await upsertAndActivateServer({ serverUrl: 'https://home-a.test', name: 'Focused Home' })).id;
        boundary.backgroundServerId = (await upsertServerProfile({ serverUrl: 'https://home-b.test', name: 'Background Home' })).id;
        // Selecting a Home is not applying it: the Account lifetime this suite
        // switches only exists once the real connection owner has published an
        // applied runtime. The credential store is still untouched here, so the
        // genuine switch lifecycle runs without starting authenticated Sync.
        await switchConnectionToActiveServer();
        boundary.pendingResponses.length = 0;
        transportBoundary.delayRelease = false;
        transportBoundary.pendingReleases.length = 0;
        getStorage().getState().activateProfileScope({ serverId: boundary.activeServerId, accountId: 'alice' });
        getStorage().setState({ settingsScope: { serverId: boundary.activeServerId, accountId: 'alice' } });
        getStorage().setState({ machinePoolListByServerId: {}, machinePoolListStatusByServerId: {} });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: `e30.${btoa(JSON.stringify({ sub: 'alice' }))}.signature` });
        await enableMachinePoolsFeatures([boundary.activeServerId, boundary.backgroundServerId]);
        setRuntimeFetch(async (url) => {
            const value = String(url);
            const pathname = new URL(value).pathname;
            if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (pathname === '/v1/machines/pools/list') {
                return await new Promise<Response>((resolve) => boundary.pendingResponses.push({ url: value, resolve }));
            }
            throw new Error(`Unexpected Machine Pool request: ${pathname}`);
        });
    });

    afterEach(() => {
        retireActiveServerAccountScopeLifetime(); resetRuntimeFetch(); resetServerFeaturesClientForTests();
        vi.restoreAllMocks(); vi.unstubAllGlobals();
    });

    it('does not publish an Alice response after the same Home switches to Bob', async () => {
        const pending = refreshMachinePools(boundary.activeServerId);
        await vi.waitFor(() => expect(boundary.pendingResponses).toHaveLength(1));

        getStorage().getState().activateProfileScope({ serverId: boundary.activeServerId, accountId: 'bob' });
        boundary.pendingResponses[0]?.resolve(Response.json({ pools: [alicePool] }));

        await expect(pending).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        expect(getStorage().getState().machinePoolListByServerId[boundary.activeServerId]).toBeUndefined();
    });

    it('does not admit an Alice intent after an Account switch before the Action executor loads', async () => {
        const pending = refreshMachinePools(boundary.activeServerId);
        getStorage().getState().activateProfileScope({ serverId: boundary.activeServerId, accountId: 'bob' });
        setRuntimeFetch(async (url) => {
            const pathname = new URL(String(url)).pathname;
            if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (pathname === '/v1/auth/ping') return Response.json({ ok: true });
            boundary.pendingResponses.push({ url: String(url), resolve: () => {} });
            return Response.json({ pools: [alicePool] });
        });

        await expect(pending).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        expect(boundary.pendingResponses).toHaveLength(0);
        expect(getStorage().getState().machinePoolListByServerId[boundary.activeServerId]).toBeUndefined();
    });

    it('does not publish an Alice response when the same Home switches to Bob while the transport releases', async () => {
        const pending = refreshMachinePools(boundary.activeServerId);
        await vi.waitFor(() => expect(boundary.pendingResponses).toHaveLength(1));
        transportBoundary.delayRelease = true;
        boundary.pendingResponses[0]?.resolve(Response.json({ pools: [alicePool] }));
        await vi.waitFor(() => expect(transportBoundary.pendingReleases.length).toBeGreaterThan(0));

        getStorage().getState().activateProfileScope({ serverId: boundary.activeServerId, accountId: 'bob' });
        for (const release of transportBoundary.pendingReleases) release();

        await expect(pending).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        expect(getStorage().getState().machinePoolListByServerId[boundary.activeServerId]).toBeUndefined();
        expect(getStorage().getState().machinePoolListStatusByServerId[boundary.activeServerId]).not.toBe('error');
    });

    it('does not publish a failed Alice refresh as the next Account Home status', async () => {
        const pending = refreshMachinePools(boundary.activeServerId);
        await vi.waitFor(() => expect(boundary.pendingResponses).toHaveLength(1));
        transportBoundary.delayRelease = true;
        boundary.pendingResponses[0]?.resolve(Response.json({ code: 'internal' }, { status: 500 }));
        await vi.waitFor(() => expect(transportBoundary.pendingReleases.length).toBeGreaterThan(0));

        getStorage().getState().activateProfileScope({ serverId: boundary.activeServerId, accountId: 'bob' });
        for (const release of transportBoundary.pendingReleases) release();

        await expect(pending).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        expect(getStorage().getState().machinePoolListStatusByServerId[boundary.activeServerId]).not.toBe('error');
    });

    it('does not bind a background Home request to the focused Home Account lifetime', async () => {
        const pending = refreshMachinePools(boundary.backgroundServerId);
        await vi.waitFor(() => expect(boundary.pendingResponses).toHaveLength(1));
        expect(new URL(boundary.pendingResponses[0]!.url).origin).toBe('https://home-b.test');

        getStorage().getState().activateProfileScope({ serverId: boundary.activeServerId, accountId: 'bob' });
        boundary.pendingResponses[0]?.resolve(Response.json({ pools: [alicePool] }));

        await expect(pending).resolves.toEqual([alicePool]);
        expect(getStorage().getState().machinePoolListByServerId[boundary.backgroundServerId]).toEqual([alicePool]);
    });

    it('projects the shared signed-out Action context as signed out without replacing retained rows', async () => {
        getStorage().setState({ machinePoolListByServerId: { [boundary.activeServerId]: [alicePool] } });
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue(null);

        await expect(refreshMachinePools(boundary.activeServerId)).rejects.toThrow('action_home_signed_out');

        expect(getStorage().getState().machinePoolListStatusByServerId[boundary.activeServerId]).toBe('signedOut');
        expect(getStorage().getState().machinePoolListByServerId[boundary.activeServerId]).toEqual([alicePool]);
    });
});
