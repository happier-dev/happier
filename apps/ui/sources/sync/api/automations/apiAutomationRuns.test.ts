import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { listAutomationDefinitionRuns } from './apiAutomationRuns';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'test',
        serverUrl: 'https://api.example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

const credentials: AuthCredentials = { token: 'token-1', secret: 'secret-1' };

const eventRun = {
    id: 'run-event-1',
    automationId: 'automation-event-1',
    revision: 1,
    state: 'queued' as const,
    triggerId: '11111111-1111-4111-8111-111111111111',
    triggerRetired: false,
    cause: {
        kind: 'trigger' as const,
        triggerId: '11111111-1111-4111-8111-111111111111',
        triggerRevision: 1,
        triggerKind: 'pluginEvent' as const,
        occurrenceKey: 'occurrence-1',
        occurredAt: 1_786_257_600_000,
        evidence: {
            eventRef: { pluginId: 'example.github', localId: 'push' },
            sourceSelectorId: '22222222-2222-4222-8222-222222222222',
        },
    },
    dueAt: 1_786_257_600_200,
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    claimedByMachineId: null,
    leaseExpiresAt: null,
    attempt: 0,
    errorCode: null,
    producedSessionId: null,
    executionDispatchState: null,
    executionAttempt: 0,
    replyHandoffState: 'none' as const,
    replyHandoffAttempt: 0,
    replyHandoffDueAt: null,
    createdAt: 1_786_257_600_000,
    updatedAt: 1_786_257_600_000,
};

describe('apiAutomationRuns', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('reads Event run summaries only through the current owner', async () => {
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ runs: [eventRun], nextCursor: null }),
        }) as Response);
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const result = await listAutomationDefinitionRuns({
            credentials,
            automationId: 'automation-event-1',
            limit: 25,
            cursor: 'cursor-event-1',
        });

        expect(result).toEqual({ runs: [eventRun], nextCursor: null });
        expect(fetchSpy.mock.calls).toHaveLength(1);
        expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
            '/v3/automations/automation-event-1/runs?limit=25&cursor=cursor-event-1',
        );
        expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain('/v2/');
    });

});
