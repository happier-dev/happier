import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { admitActionAgentStartV1, resolveActionAgentStartContextV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import type { AgentStartContextV1 } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createSessionListActionDeps } from './sessionListActionDependency';

afterEach(() => vi.restoreAllMocks());

it('proves a target through one exact HTTP read and refuses it after removal without listing Sessions', async () => {
    let attached = true;
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
        const demand = SessionReadBatchRequestV1Schema.parse(body);
        expect(demand).toMatchObject({ sessionIds: ['child'], underSessionId: 'lead', includeTurns: false, includeMessages: false });
        return { status: 200, data: { results: [{ sessionId: 'child', detail: attached
            ? { status: 200, body: { session: createSessionRecordFixture({ id: 'child', encryptionMode: 'plain', archivedAt: 1 }) } }
            : { status: 404, body: { error: 'not_found' } } }] } };
    });
    const get = vi.spyOn(axios, 'get');
    const deps = createSessionListActionDeps({ credentials: { token: 'token', encryption: null },
        serverHttpBaseUrl: 'https://home.example.test' });
    const agentStartContext: AgentStartContextV1 = {
        caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'machine', directory: '/repo' }, roles: {}, callerPermissionCeiling: 'default',
        ledSubtreeSessionIds: [], workDepthLimit: 4,
    };
    const context = { defaultSessionId: 'lead', sessionListAccess: 'led_subtree' as const, agentStartContext };
    const read = async () => admitActionAgentStartV1(context, { kind: 'session_target', targetSessionId: 'child' },
        await resolveActionAgentStartContextV1(deps, context, 'child'));
    expect(await read()).toMatchObject({ ok: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe('https://home.example.test/v2/sessions/read-batch');
    attached = false;
    expect(await read()).toMatchObject({ ok: false, refusal: { code: 'subtree_denied' } });
    expect(post).toHaveBeenCalledTimes(2);
    expect(get).not.toHaveBeenCalled();
});
