import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
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
        homes.answer(serverId, 'POST /v1/kv/bulk', { body: { values: [{ key: 'todo.index', version: 1,
            value: Buffer.from(JSON.stringify({ t: 'plain', v: { undoneOrder: ['same'], completedOrder: [] } })).toString('base64') }] } });
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
    it('feeds acknowledged grant readiness through the loaded share controller without a census fan-out', async () => {
        const serverId = await homes.addHome({ name: 'Task Share Home', serverUrl: 'https://task-readiness.test', accountId: 'owner', currentAccount: true });
        await restoreHome(serverId, 'https://task-readiness.test');
        const { TaskAccessGrantsListResponseV1Schema } = await import('@happier-dev/protocol/actions/internalTaskActions');
        const readiness = { readyCount: 1, pendingCount: 2, unavailableCounts: {
            plain_account: 1, encryption_setup_required: 1, encryption_inconsistent: 1,
        } };
        const address = { ownerAccountId: 'other', taskId: 'shared' };
        homes.answer(serverId, 'GET /v1/tasks/other/shared/grants', { body: TaskAccessGrantsListResponseV1Schema.parse({
            ...address, access: 'view', grants: [{ principal: { kind: 'team', teamId: 'core' }, accessLevel: 'view',
                createdByAccountId: 'other', createdAt: 1, display: { name: 'Core' }, readiness }],
        }) });
        homes.answer(serverId, 'GET /v1/tasks/other/shared', { body: TaskResourceV1Schema.parse({ ...address,
            access: 'view', encryptionMode: 'plain', encryptedDataKey: null, version: 1,
            content: { t: 'plain', v: { id: 'shared', title: 'Shared task', done: false, createdAt: 1, updatedAt: 1 } },
        }) });
        const { useTaskShareController } = await import('@/components/sharing/tasks/useTaskShareController');
        const hook = await renderHook(() => useTaskShareController({ ...address, scope: { serverId, accountId: 'owner' } }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
            expect(hook.getCurrent().model.grants).toHaveLength(1);
            expect(hook.getCurrent().readiness.get('team:core')).toEqual(readiness);
            expect(homes.requests.filter(request => request.path.includes('/recipients/'))).toHaveLength(0);
            expect(homes.requests.filter(request => request.path === '/v1/tasks/other/shared/grants')).toHaveLength(1);
        } finally { await hook.unmount(); }
    });
    it('captures credentials once rather than reevaluating the live bearer through an admitted read', async () => {
        const serverId = await homes.addHome({ name: 'Task Home', serverUrl: 'https://task-admission.test', accountId: 'owner', currentAccount: true });
        await restoreHome(serverId, 'https://task-admission.test');
        homes.answer(serverId, 'GET /v1/kv', { body: { items: [] } });
        homes.answer(serverId, 'POST /v1/kv/bulk', { body: { values: [] } });
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
