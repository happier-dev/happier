import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

describe('active focus transaction with the production connection manager and Sync', () => {
    let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>> | null = null;

    afterEach(async () => {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        network?.dispose();
        network = null;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('does not hand focused ownership to the next Home until full Sync applies the current Home', async () => {
        vi.resetModules();
        const lockTails = new Map<string, Promise<void>>();
        vi.stubGlobal('navigator', {
            locks: {
                request: <T>(name: string, callback: () => T | PromiseLike<T>): Promise<T> => {
                    const previous = lockTails.get(name) ?? Promise.resolve();
                    const result = previous.then(callback);
                    lockTails.set(name, result.then(() => undefined, () => undefined));
                    return result;
                },
            },
        });
        network = await installSessionOpsNetworkBoundary();
        const active = await network.addHome('https://active.example.test', 'active-account');
        const middle = await network.addHome('https://middle.example.test', 'middle-account');
        const final = await network.addHome('https://final.example.test', 'final-account');
        const firstSwitchStarted = createDeferred<void>();
        const releaseFirstSwitch = createDeferred<void>();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const readCredential = vi.mocked(TokenStorage.getCredentialsForServerUrl).getMockImplementation()!;
        let holdMiddleRead = true;
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockImplementation(async (...args) => {
            if (args[0] === middle.serverUrl && holdMiddleRead) {
                firstSwitchStarted.resolve();
                await releaseFirstSwitch.promise;
            }
            return await readCredential(...args);
        });
        network.setHttpResponder(async (input) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/account/encryption/currentness') {
                return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            }
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            return null;
        });

        const profiles = await import('./serverProfiles');
        await profiles.setActiveServerId(active.id, { scope: 'device' });
        await loadSyncSingletonForTests();
        const connection = await import('@/sync/runtime/orchestration/connectionManager');
        await connection.restoreConnectionToActiveServer({ token: active.token });
        const switches = await import('./activeServerSwitch');
        const first = switches.setActiveServerAndSwitch({ serverId: middle.id, scope: 'device' });
        await firstSwitchStarted.promise;
        const second = switches.setActiveServerAndSwitch({ serverId: final.id, scope: 'device' });

        await Promise.resolve();
        expect(profiles.getActiveServerId()).toBe(middle.id);
        expect(connection.getAppliedActiveServerId()).toBe(active.id);
        expect(network.httpRequests.some(({ url }) => new URL(url).origin === final.serverUrl)).toBe(false);

        holdMiddleRead = false;
        releaseFirstSwitch.resolve();
        await expect(Promise.all([first, second])).resolves.toEqual(['switched', 'switched']);

        expect(profiles.getActiveServerId()).toBe(final.id);
        expect(connection.getAppliedActiveServerId()).toBe(final.id);
        expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(true);
    });
});
