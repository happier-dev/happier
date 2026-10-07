import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

describe('syncTodos fetchTodos retry semantics at the HTTP boundary', () => {
    let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>>;
    let credentials: AuthCredentials;
    let fetchTodos: typeof import('./syncTodos').fetchTodos;
    let kvStatus: number;

    beforeEach(async () => {
        vi.resetModules();
        kvStatus = 200;
        network = await installSessionOpsNetworkBoundary();
        const home = await network.addHome('https://todos-retry.example.test', 'account-todos');
        credentials = { token: home.token };
        network.setHttpResponder(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption/currentness') {
                return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            }
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/kv') return Response.json({ items: [] }, { status: kvStatus });
            return null;
        });
        await loadSyncSingletonForTests();
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer(credentials);
        ({ fetchTodos } = await import('./syncTodos'));
        network.httpRequests.length = 0;
    });

    afterEach(async () => {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        network.dispose();
        vi.restoreAllMocks();
    });

    it('throws and performs only a single KV HTTP attempt when KV fetch fails', async () => {
        kvStatus = 500;
        await expect(fetchTodos({ credentials })).rejects.toThrow();

        const kvRequests = network.httpRequests.filter(({ url }) => new URL(url).pathname === '/v1/kv');
        expect(kvRequests).toHaveLength(1);
        expect(kvRequests[0]).toMatchObject({ token: `Bearer ${credentials.token}` });
        expect(new URL(kvRequests[0]!.url).searchParams.get('prefix')).toBe('todo.');
    });

    it('drops fetched todos when the captured sync scope is stale before apply', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const retained = { todos: {}, undoneOrder: ['retained'], doneOrder: [], versions: { retained: 4 } };
        storage.getState().applyTodos(retained);

        await fetchTodos({ credentials, shouldContinue: () => false });

        expect(storage.getState().todoState).toBe(retained);
        expect(network.httpRequests.filter(({ url }) => new URL(url).pathname === '/v1/kv')).toEqual([]);
    });
});
