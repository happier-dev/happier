import { beforeEach, describe, expect, it } from 'vitest';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { resetPendingQueueState } from '@/sync/engine/pending/pendingQueueV2.testHelpers';
import { storage } from '@/sync/domains/state/storage';
import type { ServerFetch } from '@/sync/http/client';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { decodeTodoStoredContent, type TodoItem } from './todoStoredContent';
import { applyTodoSessionLinkIntent } from './todoOps';
import { projectTaskSessionLinks } from './taskSessionLink';

const scope = { serverId: 'server-a', accountId: 'account-a' };
const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: scope.accountId })).toString('base64url')}.signature` };
const intent = { source: { kind: 'zen_task' as const, scope, taskId: 'task-a', title: 'Task' },
    session: { scope: { serverId: 'other-home', accountId: 'other-account' }, sessionId: 'accepted' } };
beforeEach(async () => {
    await import('@/sync/syncEngine');
    await resetPendingQueueState(scope);
});
describe('accepted-create association through the same semantic owner as the Action', () => {
    it('rebases on human Done, publishes the qualified link, and an accepted retry is write-free', async () => {
        let item: TodoItem = { id: 'task-a', title: 'Task', done: false, createdAt: 1, updatedAt: 1 };
        let version = 1;
        let writes = 0;
        const encoded = () => encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: item });
        storage.getState().applyTodos({ todos: { 'task-a': item }, undoneOrder: ['task-a'], doneOrder: [], versions: {} });
        const request: ServerFetch = async (path, init) => {
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/kv/todo.task-a') return Response.json({ key: 'todo.task-a', value: encoded(), version });
            if (path === '/v1/kv' && init?.method === 'POST') {
                writes += 1;
                if (writes === 1) {
                    item = { ...item, title: 'Human renamed', done: true, completedAt: 2 }; version = 2;
                    return Response.json({ success: false, errors: [{ key: 'todo.task-a', error: 'version-mismatch', value: encoded(), version }] }, { status: 409 });
                }
                const body = JSON.parse(String(init.body)) as { mutations: { key: string; value: string; version: number }[] };
                expect(body.mutations).toHaveLength(1);
                expect(body.mutations[0]?.version).toBe(2);
                const decoded = await decodeTodoStoredContent({ key: 'todo.task-a', encoded: body.mutations[0]!.value, expectedMode: 'plain', encryption: null });
                if (decoded.kind !== 'item') throw new Error('Expected todo');
                item = decoded.value; version = 3;
                return Response.json({ success: true, results: [{ key: 'todo.task-a', version }] });
            }
            throw new Error(`Unexpected path ${path}`);
        };
        await applyTodoSessionLinkIntent(credentials, intent, { request });
        expect(item).toMatchObject({ done: true, completedAt: 2, title: 'Human renamed', linkedSessions: {
            '10:other-home13:other-account8:accepted': { session: { ...intent.session.scope, sessionId: 'accepted' } },
        } });
        expect(storage.getState().todoState?.todos['task-a']).toEqual(item);
        expect(projectTaskSessionLinks(item, scope)).toMatchObject([{ ...intent.session.scope, sessionId: intent.session.sessionId }]);
        await applyTodoSessionLinkIntent(credentials, intent, { request });
        expect(writes).toBe(2);
    });
    it('rejects Account retirement after reading without disclosing into or writing the new Account', async () => {
        const request: ServerFetch = async path => {
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/kv/todo.task-a') {
                storage.getState().activateProfileScope({ ...scope, accountId: 'new-account' });
                return new Response(null, { status: 404 });
            }
            throw new Error('Unexpected write');
        };
        await expect(applyTodoSessionLinkIntent(credentials, intent, { request })).rejects.toMatchObject({ code: 'task_scope_mismatch' });
    });
});
