import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { listAutomationDefinitionRunsV3, listAutomationRuns } from './apiAutomationRuns';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'test',
        serverUrl: 'https://api.example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

const credentials: AuthCredentials = { token: 'token-1', secret: 'secret-1' };

const v3EventRun = {
    id: 'run-event-1',
    automationId: 'automation-event-1',
    state: 'queued' as const,
    origin: {
        kind: 'pluginEvent' as const,
        occurrenceKey: 'occurrence-1',
        sourceSelectorId: 'selector-1',
        occurredAt: 1_786_257_600_000,
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

	    it('requests run history with clamped limit and optional cursor', async () => {
	        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<any>>(async () => ({
	            ok: true,
	            status: 200,
            json: async () => ({
                runs: [],
                nextCursor: null,
            }),
        }));

        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

	        await listAutomationRuns({
	            credentials,
	            automationId: 'auto-1',
	            limit: 999,
	            cursor: 'next-1',
	        });

	        const runsCall = fetchSpy.mock.calls.find(([input]) =>
	            String(input).includes('/v2/automations/auto-1/runs?'),
	        );
	        expect(runsCall).toBeTruthy();
	        const requestUrl = String(runsCall?.[0] ?? '');
	        const request = runsCall?.[1];
	        const headers = new Headers(request?.headers);

	        expect(requestUrl).toContain('/v2/automations/auto-1/runs?limit=100&cursor=next-1');
	        expect(headers.get('Authorization')).toBe('Bearer token-1');
	});

    it('reads Event run summaries only through the V3 owner', async () => {
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ runs: [v3EventRun], nextCursor: null }),
        }) as Response);
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const result = await listAutomationDefinitionRunsV3({
            credentials,
            automationId: 'automation-event-1',
            limit: 25,
            cursor: 'cursor-event-1',
        });

        expect(result).toEqual({ runs: [v3EventRun], nextCursor: null });
        expect(fetchSpy.mock.calls).toHaveLength(1);
        expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
            '/v3/automations/automation-event-1/runs?limit=25&cursor=cursor-event-1',
        );
        expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain('/v2/');
    });

});
