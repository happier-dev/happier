import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TaskResourceV1Schema, TaskResourcesListResponseV1Schema, TaskResourceMutateRequestV1Schema } from '@happier-dev/protocol/actions/internalTaskActions';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); });
afterEach(async () => { vi.restoreAllMocks(); await homes.reset(); });

async function restoreHome(serverId: string, serverUrl: string) {
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
    if (!credentials) throw new Error('Home credentials unavailable');
    await restoreConnectionToActiveServer(credentials);
    homes.answer(serverId, 'GET /v1/tasks', { status: 404, body: { statusCode: 404, error: 'Not Found', message: 'Route GET:/v1/tasks not found' } });
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual({ serverId, accountId: 'owner' });
}

describe('internal Task Action captured Account authority', () => {
    it('lists shared tasks, edits their owner row, and keeps the legacy own TodoState free of collaborator rows', async () => {
        const serverId = await homes.addHome({ name: 'Shared Task Home', serverUrl: 'https://task-shared.test', accountId: 'owner', currentAccount: true });
        await restoreHome(serverId, 'https://task-shared.test');
        const scope = { serverId, accountId: 'owner' };
        const own = { id: 'same', title: 'Own task', done: false, createdAt: 1, updatedAt: 1 };
        let shared = TaskResourceV1Schema.parse({ ownerAccountId: 'other', taskId: 'same', access: 'edit', encryptionMode: 'plain',
            encryptedDataKey: null, version: 3, content: { t: 'plain', v: { ...own, title: 'Other task' } } });
        homes.answer(serverId, 'GET /v1/tasks', { select: () => ({ body: TaskResourcesListResponseV1Schema.parse({ tasks: [
            { ...shared, ownerAccountId: 'owner', access: 'owner', content: { t: 'plain', v: own }, version: 2 }, shared,
        ] }) }) });
        homes.answer(serverId, 'GET /v1/kv/todo.index', { body: { key: 'todo.index', version: 1,
            value: Buffer.from(JSON.stringify({ t: 'plain', v: { undoneOrder: ['same'], completedOrder: [] } })).toString('base64') } });
        homes.answer(serverId, 'GET /v1/tasks/other/same', { select: () => ({ body: shared }) });
        homes.answer(serverId, 'PUT /v1/tasks/other/same', { select: input => {
            const mutation = TaskResourceMutateRequestV1Schema.parse(input);
            expect(mutation.expectedVersion).toBe(3);
            shared = TaskResourceV1Schema.parse({ ...shared, content: mutation.content, version: 4 });
            return { body: shared };
        } });
        const { executeInternalTaskHostAction } = await import('./internalTaskAction');
        expect(await executeInternalTaskHostAction({ actionId: 'tasks.internal.list', input: {} })).toMatchObject({ status: 'ok',
            todos: [{ ownerAccountId: 'owner', title: 'Own task' }, { ownerAccountId: 'other', title: 'Other task' }] });
        expect(await executeInternalTaskHostAction({ actionId: 'tasks.internal.edit', input: { scope, ownerAccountId: 'other', taskId: 'same', fields: { title: 'Shared edit' } } }))
            .toMatchObject({ status: 'applied', todo: { title: 'Shared edit', ownerAccountId: 'other' } });
        const { sync } = await import('@/sync/sync');
        const { fetchTodos } = await import('@/sync/domains/todos/todoOps');
        const credentials = sync.getCredentials(); if (!credentials) throw new Error('Expected current Account');
        expect(await fetchTodos(credentials)).toMatchObject({ todos: { same: own }, undoneOrder: ['same'], versions: { 'todo.same': 2 } });
        expect(homes.requests.filter(request => request.method === 'POST' && new URL(request.path, request.serverUrl).pathname === '/v1/kv')).toHaveLength(0);
    });
    it('captures credentials once rather than reevaluating the live bearer through an admitted read', async () => {
        const serverId = await homes.addHome({ name: 'Task Home', serverUrl: 'https://task-admission.test', accountId: 'owner', currentAccount: true });
        await restoreHome(serverId, 'https://task-admission.test');
        homes.answer(serverId, 'GET /v1/kv', { body: { items: [] } });
        const { sync } = await import('@/sync/sync');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual({ serverId, accountId: 'owner' });
        expect(sync.getCredentials()).not.toBeNull();
        // Call-through measurement: Sync, Account-mode admission, protocol and KV logic stay real.
        const captured = vi.spyOn(sync, 'getCredentials');
        const { executeInternalTaskHostAction } = await import('./internalTaskAction');
        const result = await executeInternalTaskHostAction({ actionId: 'tasks.internal.list', input: {} });
        expect(result).toEqual({ status: 'ok', scope: { serverId, accountId: 'owner' }, todos: [], undoneOrder: [], completedOrder: [], labelCatalog: [] });
        expect(homes.requests.filter(request => new URL(request.path, request.serverUrl).pathname === '/v1/kv')).toHaveLength(1);
        expect(captured).toHaveBeenCalledTimes(1);
    });

    it.each(['caller', 'account', 'home'] as const)('keeps %s lifetime cancellation while the admitted response body is pending', async change => {
        const serverId = await homes.addHome({ name: 'Task Home', serverUrl: 'https://task-lifetime.test', accountId: 'owner', currentAccount: true });
        await restoreHome(serverId, 'https://task-lifetime.test');
        const otherHome = change === 'home' ? await homes.addHome({ name: 'Other Home', serverUrl: 'https://task-other.test', accountId: 'other', currentAccount: true, active: false }) : null;
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let admit!: () => void;
        const entered = new Promise<void>(resolve => { admit = resolve; });
        homes.answer(serverId, 'GET /v1/kv', { select: () => { admit(); return { body: { items: [] }, bodyAfter: held }; } });
        const controller = new AbortController();
        const { executeInternalTaskHostAction } = await import('./internalTaskAction');
        const pending = executeInternalTaskHostAction({ actionId: 'tasks.internal.list', input: {}, signal: controller.signal });
        try {
            await entered;
            if (change === 'caller') controller.abort();
            else if (change === 'account') await homes.switchAccount(serverId, 'successor', { currentAccount: true });
            else {
                const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
                await setActiveServerId(otherHome!, { scope: 'device' });
            }
            release();
            expect(await pending).not.toHaveProperty('status', 'ok');
            expect(homes.requests.filter(request => new URL(request.path, request.serverUrl).pathname === '/v1/kv')).toHaveLength(1);
        } finally { release(); await pending; }
    });
});
