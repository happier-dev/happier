import { afterEach, describe, expect, it } from 'vitest';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { fetchTodos, applyTodoSessionLinkIntent, reorderTodos } = await import('./todoOps');

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => { await connection?.dispose(); });

describe('Todo reads through Account currentness', () => {
    it.each(['list', 'internal-task', 'link', 'reorder'] as const)('reuses the warm Account socket through the %s front door, then refuses disconnected disclosure', async frontDoor => {
        let refuseCurrentness = false;
        let currentnessReads = 0;
        let todoReads = 0;
        let connectedSocket: Parameters<typeof configureConnectedServerSocketBoundary>[0] | undefined;
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://todo-observation.example.test', accountId: 'todo-observation-account',
            configureSocket: socket => { configureConnectedServerSocketBoundary(socket); connectedSocket = socket; },
            request: async input => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/tasks' || path.startsWith('/v1/tasks/')) return Response.json({ statusCode: 404, error: 'Not Found', message: `Route GET:${path} not found` }, { status: 404 });
                if (path === '/v1/account/encryption/currentness') {
                    currentnessReads += 1;
                    return refuseCurrentness ? Response.json({ error: 'forbidden' }, { status: 403 })
                        : Response.json(createPlainAccountEncryptionCurrentnessFixture());
                }
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'todo-observation-account' });
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v2/sessions/active' || path === '/v2/sessions/query') return Response.json({
                    sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                });
                if (path === '/v1/machines' || path === '/v1/artifacts') return Response.json([]);
                if (path === '/v1/friends') return Response.json({ friends: [] });
                if (path === '/v1/kv') { todoReads += 1; return Response.json({ items: [] }); }
                if (path === '/v1/kv/bulk') { todoReads += 1; return Response.json({ values: [] }); }
                if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
                if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
                return null;
            },
        });
        await expect.poll(() => storage.getState().isDataReady).toBe(true);
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        // Observe the real producer's bootstrap, without manually binding a
        // request or calling a mode helper to qualify these unrelated readers.
        await expect.poll(() => apiSocket.getAccountEncryptionObservationBinding(connection!.credentials)?.peek()?.mode).toBe('plain');
        const { executeInternalTaskHostAction } = await import('@/sync/ops/actions/internalTaskAction');
        const { executeListReorderAction } = await import('@/sync/ops/actions/listReorderAction');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { createServerFetchForActiveServer } = await import('@/sync/http/client');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected the restored Account lifetime');
        const capturedRequest = createServerFetchForActiveServer(undefined, {
            credentials: connection.credentials, isCurrent: lifetime.isCurrent,
        });
        const scope = { serverId: connection.serverId, accountId: 'todo-observation-account' };
        const linkIntent = { source: { scope, taskId: 'deleted' }, session: { scope, sessionId: 'accepted-session' } };
        const warmReads = currentnessReads;
        for (let read = 0; read < 3; read += 1) {
            if (frontDoor === 'list') await expect(fetchTodos(connection.credentials, { retry: 'none' })).resolves.toMatchObject({ todos: {} });
            if (frontDoor === 'internal-task') await expect(executeInternalTaskHostAction({ actionId: 'tasks.internal.list', input: {} }))
                .resolves.toMatchObject({ status: 'ok', todos: [] });
            // Missing rows stop before CAS/sealing, isolating the initial
            // admission count without removing either write-authority phase.
            if (frontDoor === 'link') await expect(applyTodoSessionLinkIntent(connection.credentials, linkIntent))
                .rejects.toMatchObject({ code: 'task_deleted' });
            if (frontDoor === 'reorder') await expect(executeListReorderAction({ actionId: 'tasks.internal.reorder',
                input: { scope, sourceId: 'deleted', position: { anchorId: null, placement: 'before' } } }))
                .resolves.toMatchObject({ status: 'refused', reason: 'todo_reorder_stale' });
        }
        expect(currentnessReads).toBe(warmReads);

        refuseCurrentness = true;
        connectedSocket!.disconnect();
        const beforeRefusal = todoReads;
        await expect(fetchTodos(connection.credentials, { retry: 'none' })).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable', reason: 'account_currentness_unavailable',
        });
        await expect(executeInternalTaskHostAction({ actionId: 'tasks.internal.list', input: {} }))
            .resolves.toMatchObject({ status: 'failed' });
        await expect(applyTodoSessionLinkIntent(connection.credentials, linkIntent)).rejects.toMatchObject({ code: 'task_link_failed' });
        await expect(reorderTodos(connection.credentials, 'deleted', { anchorId: null, placement: 'before' }))
            .rejects.toMatchObject({ code: 'todo_stored_content_unavailable' });
        await expect(executeListReorderAction({ actionId: 'tasks.internal.reorder',
            input: { scope, sourceId: 'deleted', position: { anchorId: null, placement: 'before' } } }))
            .resolves.toMatchObject({ status: 'refused' });
        expect(todoReads).toBe(beforeRefusal);
        await connection.dispose();
        const beforeRetired = currentnessReads;
        const { fetchAccountEncryptionIdentity } = await import('@/sync/api/account/apiAccountEncryptionMode');
        await expect(fetchAccountEncryptionIdentity(connection.credentials, { request: capturedRequest, usage: 'identity' }))
            .rejects.toMatchObject({ name: 'StaleServerGenerationError' });
        expect(currentnessReads).toBe(beforeRetired);
        const beforeRetiredKv = todoReads;
        await expect(executeListReorderAction({ actionId: 'tasks.internal.reorder',
            input: { scope, sourceId: 'deleted', position: { anchorId: null, placement: 'before' } } }))
            .resolves.toMatchObject({ status: 'unavailable' });
        expect(todoReads).toBe(beforeRetiredKv);
    });

    it('refuses Todo reads and preserves prior state when an old Home lacks Account currentness', async () => {
        let currentnessUnavailable = false;
        const todoRequests: Array<{ path: string; method: string }> = [];
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://todo-currentness.example.test',
            accountId: 'todo-account',
            request: async (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/tasks' || path.startsWith('/v1/tasks/')) return Response.json({ statusCode: 404, error: 'Not Found', message: `Route GET:${path} not found` }, { status: 404 });
                if (path === '/v1/account/encryption/currentness') {
                    if (currentnessUnavailable) {
                        todoRequests.push({ path, method: init?.method ?? 'GET' });
                        return Response.json({ error: 'not-found' }, { status: 404 });
                    }
                    return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                }
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'todo-account' });
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v2/sessions/active' || path === '/v2/sessions/query') return Response.json({
                    sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                });
                if (path === '/v1/machines' || path === '/v1/artifacts') return Response.json([]);
                if (path === '/v1/friends') return Response.json({ friends: [] });
                if (path === '/v1/kv') {
                    if (currentnessUnavailable) todoRequests.push({ path, method: init?.method ?? 'GET' });
                    return Response.json({ items: [] });
                }
                if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
                if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
                return null;
            },
        });
        await expect.poll(() => storage.getState().isDataReady).toBe(true);
        const priorState = { todos: {}, undoneOrder: [], doneOrder: [], versions: {} };
        storage.getState().applyTodos(priorState);
        currentnessUnavailable = true;

        await expect(fetchTodos(connection.credentials)).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable',
            key: 'todo.index',
            reason: 'account_currentness_unavailable',
        });
        expect(todoRequests).toEqual([{ path: '/v1/account/encryption/currentness', method: 'GET' }]);
        expect(storage.getState().todoState).toEqual(priorState);
    });
});
