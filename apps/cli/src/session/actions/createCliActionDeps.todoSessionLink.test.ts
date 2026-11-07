import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, getActionSpec, resolveActionSurfaceAvailability } from '@happier-dev/protocol';
import { createCliActionDeps } from './createCliActionDeps';

const scope = { serverId: 'task-home', accountId: 'task-account' };
const token = `header.${Buffer.from(JSON.stringify({ sub: scope.accountId })).toString('base64url')}.signature`;
const input = { scope, taskId: 'task-a', session: { ...scope, sessionId: 'accepted-session' } };
const encode = (value: unknown) => Buffer.from(JSON.stringify({ t: 'plain', v: value })).toString('base64');
const decode = (value: string) => JSON.parse(Buffer.from(value, 'base64').toString()).v;
beforeEach(() => {
    // This Home has the predecessor KV routes, not the new Task-resource route.
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        const url = new URL(request.url!);
        expect(url.origin).toBe('https://task-home.test');
        expect(url.pathname).toMatch(/^\/v1\/tasks\//);
        return { status: 404, data: { statusCode: 404, error: 'Not Found', message: `Route GET:${url.pathname} not found` } };
    });
});
afterEach(() => vi.restoreAllMocks());

describe('agent task association through the CLI Account executor and real KV/CAS owner', () => {
    it('rebases against a concurrent human Done, persists qualified identity and retries without another write', async () => {
        let todo = { id: 'task-a', title: 'Current task', done: false, createdAt: 1, updatedAt: 1 };
        let version = 1;
        let writes = 0;
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(url).pathname;
            expect(new URL(url).origin).toBe('https://task-home.test');
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            } };
            if (path === '/v1/kv/todo.task-a') return { status: 200, data: { key: 'todo.task-a', value: encode(todo), version } };
            throw new Error(`Unexpected route ${path}`);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
            const { mutations } = body as { mutations: { key: string; value: string; version: number }[] };
            expect(mutations.map(item => item.key)).toEqual(['todo.task-a']);
            writes += 1;
            if (writes === 1) {
                todo = { ...todo, title: 'Human renamed', done: true, updatedAt: 2 };
                version += 1;
                return { status: 409, data: { success: false, errors: [{ key: 'todo.task-a', error: 'version-mismatch', value: encode(todo), version }] } };
            }
            expect(mutations[0]?.version).toBe(version);
            todo = decode(mutations[0]!.value);
            version += 1;
            return { status: 200, data: { success: true, results: [{ key: 'todo.task-a', version }] } };
        });
        const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
            sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: scope.serverId, serverHttpBaseUrl: 'https://task-home.test' }));
        const context = { surface: 'agent', authority: 'account_automation', bypassApprovals: true } as const;
        expect(await executor.execute('tasks.internal.session.link', { taskId: input.taskId,
            session: { sessionId: input.session.sessionId } }, context)).toEqual({ ok: true, result: { status: 'linked' } });
        expect(todo).toMatchObject({ done: true, title: 'Human renamed', linkedSessions: {
            '9:task-home12:task-account16:accepted-session': { session: input.session },
        } });
        expect(await executor.execute('tasks.internal.session.link', input, { ...context, surface: 'mcp' })).toEqual({ ok: true, result: { status: 'linked' } });
        expect(writes).toBe(2);
        expect(await executor.execute('tasks.internal.session.link', input, { ...context, surface: 'cli' })).toEqual({ ok: true, result: { status: 'linked' } });
        expect(writes).toBe(2);
        expect(getActionSpec('tasks.internal.session.link')).toMatchObject({ executionPlacement: 'account',
            bindings: { mcpToolName: 'tasks_internal_session_link' }, cli: { commands: [{ path: ['tasks', 'internal', 'session', 'link'] }] } });
        expect(resolveActionSurfaceAvailability({ actionId: 'tasks.internal.session.link', surface: 'mcp', requireToolBinding: true }).available).toBe(true);
        expect(await executor.execute('tasks.internal.session.link', { ...input, linked: false }, context)).toEqual({ ok: true, result: { status: 'unlinked' } });
        expect(todo).toMatchObject({ done: true, linkedSessions: {} });
        expect(writes).toBe(3);
    });

    it('refuses deleted tasks and another Account before any write', async () => {
        const post = vi.spyOn(axios, 'post');
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(url).pathname;
            return path.endsWith('/currentness')
                ? { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }
                : { status: 404 };
        });
        const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
            sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: scope.serverId, serverHttpBaseUrl: 'https://task-home.test' }));
        const context = { surface: 'agent', authority: 'account_automation', bypassApprovals: true } as const;
        expect(await executor.execute('tasks.internal.session.link', input, context)).toEqual({ ok: true, result: { status: 'refused', reason: 'task_deleted' } });
        expect(await executor.execute('tasks.internal.session.link', { ...input, scope: { ...scope, accountId: 'other' } }, context))
            .toEqual({ ok: true, result: { status: 'refused', reason: 'task_scope_mismatch' } });
        expect(post).not.toHaveBeenCalled();
    });
});
