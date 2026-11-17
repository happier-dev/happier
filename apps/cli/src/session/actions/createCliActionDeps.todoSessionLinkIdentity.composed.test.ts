import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { TODO_LABEL_CATALOG_KEY_V1, TodoItemV1Schema, resolveTodoStateV1, type TodoItemV1 } from '@happier-dev/protocol/todos/todoSessionLinkV1';

import { projectInternalTaskSessionLinks } from '../../../../../packages/plugins/triage/src/internalTasks/source';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => vi.restoreAllMocks());

it('persists the portable Home identity so a Task started through a local CLI profile reopens with its Session', async () => {
    const localProfileId = 'stack_agent-qa-prs-issues__id_default';
    const serverIdentityId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    const accountId = 'task-account';
    const sessionId = 'accepted-session';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    let todo: TodoItemV1 = { id: 'task-a', title: 'Current task', done: false, createdAt: 1, updatedAt: 1 };
    let version = 1;

    // Only the Home HTTP boundary is replaced; Task resolution, KV/CAS mutation,
    // qualified Session identity and the Triage read projection remain real.
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        const url = new URL(request.url!);
        expect(url.origin).toBe('https://task-home.test');
        if (url.pathname === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) {
            expect(request.method).toBe('GET');
            return { status: 200, data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
        }
        expect(url.pathname).toMatch(/^\/v1\/tasks\//);
        return { status: 404, data: { statusCode: 404, error: 'Not Found', message: `Route GET:${url.pathname} not found` } };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(url).pathname;
        expect(new URL(url).origin).toBe('https://task-home.test');
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } };
        if (path === '/v1/kv/todo.task-a') return { status: 200, data: {
            key: 'todo.task-a', value: Buffer.from(JSON.stringify({ t: 'plain', v: todo })).toString('base64'), version,
        } };
        if (path === `/v1/kv/${TODO_LABEL_CATALOG_KEY_V1}`) return { status: 404 };
        throw new Error(`Unexpected route ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
        const { mutations } = body as { mutations: { key: string; value: string; version: number }[] };
        expect(mutations.map(item => item.key)).toEqual(['todo.task-a']);
        expect(mutations[0]?.version).toBe(version);
        // This fixture models the external KV service's opaque envelope storage.
        todo = TodoItemV1Schema.parse(JSON.parse(Buffer.from(mutations[0]!.value, 'base64').toString()).v);
        version += 1;
        return { status: 200, data: { success: true, results: [{ key: 'todo.task-a', version }] } };
    });

    const executor = createActionExecutor(createCliActionDeps({
        token, credentials: { token, encryption: null }, sessionId, mode: 'plain', ctx: null,
        serverId: localProfileId, serverIdentityId, serverHttpBaseUrl: 'https://task-home.test',
    }));
    const context = { surface: 'agent', authority: 'account_automation', bypassApprovals: true } as const;
    expect(await executor.execute('tasks.internal.session.link', {
        taskId: todo.id, session: { sessionId },
    }, context)).toEqual({ ok: true, result: { status: 'linked' } });

    expect(projectInternalTaskSessionLinks({ sessionId }, {
        scope: { serverId: serverIdentityId, accountId }, todos: [{ ...todo, state: resolveTodoStateV1(todo) }],
    })).toMatchObject({ kind: 'complete', links: [{ sessionId }] });
    expect(Object.values(todo.linkedSessions ?? {})).toMatchObject([
        { session: { serverId: serverIdentityId, accountId, sessionId } },
    ]);
    expect(await executor.execute('tasks.internal.read', { taskId: todo.id }, context)).toMatchObject({
        ok: true, result: { status: 'applied', scope: { serverId: serverIdentityId, accountId } },
    });
    expect(todo.done).toBe(false);
});
