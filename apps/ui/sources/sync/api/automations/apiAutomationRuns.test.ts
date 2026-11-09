import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { listAutomationDefinitionRuns } from './apiAutomationRuns';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { isServerFetchConnectivityProbeRequest } from '@/dev/testkit/mocks/serverFetch';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

vi.mock('socket.io-client', async () => {
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    return { io: () => createSocketIoBoundaryStub().socket };
});

beforeEach(async () => {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://api.example.test', scope: 'device' });
});

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
        occurrenceKey: deriveAutomationOccurrenceKeyV1({
            triggerId: '11111111-1111-4111-8111-111111111111',
            evidence: {
                v: 1,
                kind: 'pluginEvent',
                eventRef: { pluginId: 'example.github', localId: 'push' },
                sourceSelectorId: '22222222-2222-4222-8222-222222222222',
                occurrenceId: 'occurrence-1',
                occurredAt: 1_786_257_600_000,
                payload: {},
            },
        }),
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
        apiSocket.disconnect();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it.each([false, true])('shares native summary bytes under captured authority (explicit credentials: %s)', async explicit => {
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const basis = getActiveServerSnapshot();
        publishAppliedActiveServerSnapshot(basis);
        const nativeCredentials = { token: createAccountTokenForTests('summary-account') };
        apiSocket.initialize({ endpoint: basis.serverUrl, serverId: basis.serverId,
            generation: basis.generation, token: nativeCredentials.token, credentials: nativeCredentials }, null);
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(nativeCredentials);
        const held = createDeferred<void>();
        let requests = 0;
        vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
            if (isServerFetchConnectivityProbeRequest(input)) return Response.json({ ok: true });
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path !== '/v3/automations/runs') throw new Error(`Unexpected native summary request: ${path}`);
            requests += 1;
            await held.promise;
            return Response.json({ runs: [eventRun], nextCursor: 'opaque_cursor' });
        }));
        const abort = new AbortController();
        const input = { attention: 'required' as const, ...(explicit ? { credentials: nativeCredentials } : {}) };
        const left = listAutomationDefinitionRuns({ ...input, signal: abort.signal });
        void left.catch(() => {});
        const right = listAutomationDefinitionRuns(input);
        try {
            await vi.waitFor(() => expect(requests).toBeGreaterThan(0));
            for (let tick = 0; tick < 50; tick++) await Promise.resolve();
            expect(requests).toBe(1);
            abort.abort();
            await expect(left).rejects.toMatchObject({ name: 'AbortError' });
            held.resolve();
            expect(await right).toMatchObject({ nextCursor: 'opaque_cursor' });
        } finally { held.resolve(); await Promise.allSettled([left, right]); }
    });

    it('reads Account attention in one paged summary request with cancellation', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({
            runs: [{ ...eventRun, state: 'failed', errorCode: 'machine_unavailable' }], nextCursor: 'next',
        }), { status: 200 }));
        const controller = new AbortController();
        const result = await listAutomationDefinitionRuns({
            credentials, attention: 'required', limit: 25, cursor: 'cursor', signal: controller.signal,
            requestContext: { serverId: 'test', request },
        });
        expect(result.runs[0]).toMatchObject({ state: 'failed', producedSessionId: null });
        expect(request).toHaveBeenCalledExactlyOnceWith('/v3/automations/runs?limit=25&cursor=cursor&attention=required',
            expect.objectContaining({ signal: controller.signal }), { includeAuth: false, recoveryRead: 'unbounded' });
    });

    it('reads Event run summaries only through the current owner', async () => {
        const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
            Response.json({ runs: [eventRun], nextCursor: null }));
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        const result = await listAutomationDefinitionRuns({
            credentials,
            automationId: 'automation-event-1',
            limit: 25,
            cursor: 'cursor-event-1',
        });

        expect(result).toEqual({ runs: [eventRun], nextCursor: null });
        const requestUrls = fetchSpy.mock.calls.map(([input]) => String(input));
        expect(requestUrls).toEqual(expect.arrayContaining([
            expect.stringContaining('/v3/automations/automation-event-1/runs?limit=25&cursor=cursor-event-1'),
        ]));
        expect(requestUrls.some((url) => url.includes('/v2/'))).toBe(false);
    });

    it('reads current run history without the retired API epoch advertisement', async () => {
        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input).includes('/features') || String(input).includes('/v2/')) throw new Error('unexpected_capability_probe');
            return new Response(JSON.stringify({ runs: [eventRun], nextCursor: null }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

        await expect(listAutomationDefinitionRuns({
            credentials,
            automationId: 'automation-event-1',
        })).resolves.toEqual({ runs: [eventRun], nextCursor: null });
        expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/features'))).toBe(false);
    });

});
