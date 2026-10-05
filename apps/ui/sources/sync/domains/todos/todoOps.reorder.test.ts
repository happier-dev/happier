import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { resetPendingQueueState } from '@/sync/engine/pending/pendingQueueV2.testHelpers';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import type { ServerFetch } from '@/sync/http/client';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { decodeTodoStoredContent, type TodoItem } from './todoStoredContent';
import { reorderTodos, type TodoState } from './todoOps';

const scope = { serverId: 'server-a', accountId: 'account-a' };
const token = `header.${Buffer.from(JSON.stringify({ sub: scope.accountId })).toString('base64url')}.signature`;
const credentials = { token };
const mutationsSchema = z.object({ mutations: z.array(z.object({
    key: z.string(), value: z.string().nullable(), version: z.number(),
}).strict()) }).strict();

function todo(id: string): TodoItem { return { id, title: id, done: false, createdAt: 1, updatedAt: 1 }; }
function state(ids: string[]): TodoState {
    return { todos: Object.fromEntries(ids.map(id => [id, todo(id)])), undoneOrder: ids, doneOrder: [], versions: {} };
}

/** A real KV HTTP boundary: codecs, Account currentness, CAS and local storage are not mocked. */
function server(ids = ['a', 'b']) {
    const rows = new Map(ids.map(id => [`todo.${id}`, { key: `todo.${id}`, version: 1,
        value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: todo(id) }) }]));
    rows.set('todo.index', { key: 'todo.index', version: 1,
        value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { undoneOrder: ids, completedOrder: ['completed'] } }) });
    const writes: z.infer<typeof mutationsSchema>['mutations'][] = [];
    let onAcknowledged = () => {};
    let onRead = (_path: string) => {};
    let conflict = false;
    const request: ServerFetch = async (path, init) => {
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
        if (path === '/v1/account/encryption/currentness') {
            onRead(path);
            return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        }
        if (path.startsWith('/v1/kv/')) {
            onRead(path);
            const row = rows.get(decodeURIComponent(path.slice('/v1/kv/'.length)));
            return row ? Response.json(row) : new Response(null, { status: 404 });
        }
        if (path === '/v1/kv' && init?.method === 'POST') {
            const { mutations } = mutationsSchema.parse(JSON.parse(String(init.body)));
            writes.push(mutations);
            if (conflict) rows.set('todo.index', { ...rows.get('todo.index')!, version: 2 });
            const stale = mutations.filter(row => row.version !== (rows.get(row.key)?.version ?? -1));
            if (stale.length) return Response.json({ success: false, errors: stale.map(row => ({
                key: row.key, error: 'version-mismatch', version: rows.get(row.key)!.version, value: rows.get(row.key)!.value,
            })) }, { status: 409 });
            const results = mutations.map(row => {
                const version = row.version + 1;
                if (row.value === null) rows.delete(row.key);
                else rows.set(row.key, { key: row.key, value: row.value, version });
                return { key: row.key, version };
            });
            onAcknowledged();
            return Response.json({ success: true, results });
        }
        throw new Error(`Unexpected todo HTTP route: ${path}`);
    };
    return { rows, writes, request,
        acknowledge(callback: () => void) { onAcknowledged = callback; },
        read(callback: (path: string) => void) { onRead = callback; },
        rejectCas() { conflict = true; },
        async index() {
            const decoded = await decodeTodoStoredContent({ key: 'todo.index', encoded: rows.get('todo.index')!.value,
                expectedMode: 'plain', encryption: null });
            if (decoded.kind !== 'index') throw new Error('Expected canonical index');
            return decoded.value;
        },
    };
}

beforeEach(async () => {
    await import('@/sync/syncEngine');
    await resetPendingQueueState(scope);
    storage.getState().applyTodos(state(['a', 'b']));
});

describe('anchored todo reorder through real Account storage and KV HTTP', () => {
    it.each(['retirement', 'cancellation'] as const)('returns confirmed success after %s without publishing an obsolete projection', async reason => {
        const http = server();
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Missing real applied Account fixture');
        const controller = new AbortController();
        const next = state(['other-account-todo']);
        http.acknowledge(() => {
            if (reason === 'retirement') storage.getState().activateProfileScope({ ...scope, accountId: 'account-b' });
            else controller.abort();
            storage.getState().applyTodos(next);
        });
        await expect(reorderTodos(credentials, 'a', { anchorId: 'b', placement: 'after' }, {
            request: http.request, isCurrent: lifetime.isCurrent, signal: controller.signal,
        })).resolves.toBeUndefined();
        expect(await http.index()).toEqual({ undoneOrder: ['b', 'a'], completedOrder: ['completed'] });
        expect(storage.getState().todoState).toBe(next);
    });

    it('rebases on server additions and preserves current local titles, membership and versions at acknowledgement', async () => {
        const http = server(['a', 'added', 'b']);
        const next = state(['a', 'added', 'b']);
        next.todos.a = { ...next.todos.a!, title: 'New title' };
        next.versions['todo.added'] = 7;
        http.acknowledge(() => storage.getState().applyTodos(next));
        await reorderTodos(credentials, 'a', { anchorId: 'b', placement: 'after' }, { request: http.request });
        expect(await http.index()).toEqual({ undoneOrder: ['added', 'b', 'a'], completedOrder: ['completed'] });
        expect(http.writes[0]?.map(row => row.key)).toEqual(['todo.index']);
        expect(storage.getState().todoState).toMatchObject({ undoneOrder: ['added', 'b', 'a'],
            todos: { a: { title: 'New title' } }, versions: { 'todo.added': 7, 'todo.index': 2 } });
    });

    it.each(['deleted', 'completed'] as const)('does not resurrect a source %s locally while its save acknowledgement is pending', async change => {
        const http = server();
        const next = state(['b']);
        if (change === 'completed') {
            next.todos.a = { ...todo('a'), done: true, completedAt: 2 };
            next.doneOrder = ['a'];
        }
        http.acknowledge(() => storage.getState().applyTodos(next));
        await reorderTodos(credentials, 'a', { anchorId: 'b', placement: 'after' }, { request: http.request });
        expect(storage.getState().todoState).toBe(next);
        expect(await http.index()).toEqual({ undoneOrder: ['b', 'a'], completedOrder: ['completed'] });
    });

    it('reports an actual KV CAS refusal without replacing local state', async () => {
        const http = server();
        const prior = storage.getState().todoState;
        http.rejectCas();
        await expect(reorderTodos(credentials, 'a', { anchorId: 'b', placement: 'after' }, { request: http.request }))
            .rejects.toMatchObject({ code: 'todo_reorder_conflict' });
        expect(storage.getState().todoState).toBe(prior);
        expect(await http.index()).toEqual({ undoneOrder: ['a', 'b'], completedOrder: ['completed'] });
    });

    it('fences retirement during an Account-mode read before issuing a save', async () => {
        const http = server();
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Missing real applied Account fixture');
        const next = state(['other-account-todo']);
        http.read(path => {
            if (path !== '/v1/account/encryption/currentness') return;
            storage.getState().activateProfileScope({ ...scope, accountId: 'account-b' });
            storage.getState().applyTodos(next);
        });
        await expect(reorderTodos(credentials, 'a', { anchorId: 'b', placement: 'after' }, {
            request: http.request, isCurrent: lifetime.isCurrent,
        })).rejects.toMatchObject({ code: 'todo_reorder_scope_changed' });
        expect(http.writes).toEqual([]);
        expect(storage.getState().todoState).toBe(next);
    });

    it.each(['completed source', 'deleted anchor'] as const)('refuses current server %s before saving', async change => {
        const http = server();
        const prior = storage.getState().todoState;
        if (change === 'completed source') http.rows.set('todo.a', { key: 'todo.a', version: 2,
            value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { ...todo('a'), done: true } }) });
        else http.rows.delete('todo.b');
        await expect(reorderTodos(credentials, 'a', { anchorId: 'b', placement: 'after' }, { request: http.request }))
            .rejects.toMatchObject({ code: 'todo_reorder_stale' });
        expect(http.writes).toEqual([]);
        expect(storage.getState().todoState).toBe(prior);
    });
});
