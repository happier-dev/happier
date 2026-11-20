import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createActionExecutor, listActionSpecs } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { buildAgentActivityEntryId } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityEntryId';
import { SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityHeadlineV1';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const parent = 'parent-session';
const base = 'https://subagents.example.invalid';
const credentials = { token: 'session-child-test-token', encryption: null } as const;
const list = listActionSpecs().find(spec => spec.bindings?.rpcMethod === RPC_METHODS.SESSIONS_SUBAGENTS_LIST)!;
const get = listActionSpecs().find(spec => spec.bindings?.rpcMethod === RPC_METHODS.SESSIONS_SUBAGENTS_GET)!;

function callRow(id: string, seq: number, childSessionId?: string) {
    return { id: `call-${id}`, seq, createdAt: seq, messageRole: 'agent', content: { t: 'plain', v: {
        role: 'agent', content: { type: 'acp', agentId: 'muse', data: { type: 'tool-call', callId: id, name: 'Task',
            input: JSON.stringify({ name: id, nativeChild: { subagentId: id, ...(childSessionId ? { childSessionId } : {}) } }) } },
    } } };
}

function resultRow(id: string, seq: number) {
    return { id: `result-${id}`, seq, createdAt: seq, messageRole: 'agent', content: { t: 'plain', v: {
        role: 'agent', content: { type: 'acp', agentId: 'muse', data: { type: 'tool-result', callId: id, output: `result for ${id}` } },
    } } };
}

function useHome(historySize: number, readable = true) {
    const requests: URL[] = [];
    const record = createSessionRecordFixture({ id: parent, encryptionMode: 'plain', metadata: JSON.stringify({
        path: '/workspace', flavor: 'muse', machineId: 'remote-machine',
        [SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY]: { v: 1, backendId: 'muse', updatedAt: 99, activeEntries: [
            { entryId: buildAgentActivityEntryId({ kind: 'workflow_agent', runId: 'workflow', agentId: 'remote' }),
                kind: 'workflow_agent', title: 'Remote child', status: 'running', startedAt: 90, updatedAt: 99, sidechainId: 'remote' },
        ] },
    }) });
    vi.spyOn(axios, 'get').mockImplementation(async href => {
        const url = new URL(String(href));
        requests.push(url);
        if (url.pathname === '/v1/account/encryption/currentness') {
            return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
        }
        if (!readable) return { status: 404, data: { error: 'not_found' } };
        if (url.pathname === `/v2/sessions/${parent}`) return { status: 200, data: { session: record } };
        if (url.pathname === `/v1/sessions/${parent}/messages`) {
            const before = url.searchParams.get('beforeSeq');
            const sidechain = url.searchParams.get('sidechainId');
            if (sidechain) return { status: 200, data: { hasMore: false, messages: [{
                id: `message-${sidechain}`, seq: 3, createdAt: 3, messageRole: 'agent', sidechainId: sidechain,
                content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', agentId: 'muse',
                    data: { type: 'text', text: `activity from ${sidechain}` } } } },
            }] } };
            if (before === '90') return { status: 200, data: {
                messages: [resultRow('retained', 2), callRow('retained', 1)], hasMore: false,
            } };
            return { status: 200, data: {
                messages: [callRow('local', historySize + 1, 'other-session'), callRow('remote', 90)],
                hasMore: true, nextBeforeSeq: 90,
            } };
        }
        throw new Error(`Unexpected HTTP request ${url.pathname}`);
    });
    const executor = createActionExecutor(createCliActionDeps({
        mode: 'plain', ctx: null, token: credentials.token, credentials, sessionId: 'cli-global', serverHttpBaseUrl: base,
    }));
    const execute = (id: typeof list.id, input: unknown) => runWithServerHttpBaseUrl(base,
        () => executor.execute(id, input, { surface: 'agent', authority: 'account_automation', defaultSessionId: parent }));
    const query = async (beforeSeq?: number) => {
        const response = await execute(list.id, beforeSeq === undefined ? {} : { beforeSeq });
        expect(response).toMatchObject({ ok: true });
        if (!response.ok) throw new Error(response.error);
        return response.result as {
            rows: Array<{ id: string; status: string; operand: { toolId: string; beforeSeq?: number } }>;
            nextBeforeSeq: number | null;
        };
    };
    return { requests, execute, query };
}

describe('Session child Action reads', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([
        { toolId: 'local', beforeSeq: undefined, id: 'subagent_sidechain:local', status: 'running' },
        { toolId: 'retained', beforeSeq: 90, id: 'subagent_sidechain:retained', status: 'succeeded' },
        { toolId: 'remote', beforeSeq: undefined, id: 'workflow_agent:workflow:remote', status: 'running' },
    ])('gets the $toolId child displayed by the Session projection using the list operand', async ({ toolId, beforeSeq, id, status }) => {
        const { execute, query, requests } = useHome(100);
        const { rows } = await query(beforeSeq);
        const row = rows.find(candidate => candidate.operand.toolId === toolId);
        expect(row).toMatchObject({ id, status });
        expect(await execute(get.id, row!.operand)).toMatchObject({
            ok: true, result: { ...row, detail: { sidechainId: toolId, messages: [{ text: `activity from ${toolId}` }],
                tool: { name: 'Task', input: { nativeChild: { subagentId: toolId } },
                    ...(toolId === 'retained' ? { result: 'result for retained' } : {}) } } },
        });
        expect(requests.filter(url => url.searchParams.has('sidechainId')).map(url => url.searchParams.get('sidechainId')))
            .toEqual([toolId]);
    });

    it('refuses both reads without disclosing any child when the parent is unavailable', async () => {
        const { execute, requests } = useHome(100, false);
        const refusal = { ok: false, errorCode: 'session_not_found' };
        expect(await execute(list.id, {})).toMatchObject(refusal);
        expect(await execute(get.id, { sessionId: parent, entryId: 'subagent_sidechain:retained', toolId: 'retained', beforeSeq: 90 })).toMatchObject(refusal);
        expect(requests.some(url => url.pathname.endsWith('/messages'))).toBe(false);
    });

    it.each([100, 100_000])('reads one transcript page for a roster over %i messages', async historySize => {
        const { requests, query } = useHome(historySize);
        expect(await query()).toMatchObject({ nextBeforeSeq: 90 });
        expect(requests.filter(url => url.pathname === `/v2/sessions/${parent}`)).toHaveLength(1);
        expect(requests.filter(url => url.pathname === `/v1/sessions/${parent}/messages`)).toHaveLength(1);
    });
});
