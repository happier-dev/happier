import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_ID } from '@happier-dev/agents';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const boundary = await installSessionOpsNetworkBoundary();
const storage = (await import('@/sync/domains/state/storage')).storage;
const fixtures = await import('@/dev/testkit/fixtures/sessionFixtures');
const machineFixtures = await import('@/dev/testkit/fixtures/machineFixtures');
const metadata = await import('@happier-dev/session-core/state');
const ops = await import('./sessions');

describe('Resume settlement through the real Action executor and Home transport', () => {
    let home: Awaited<ReturnType<typeof boundary.addHome>>;

    beforeEach(async () => {
        storage.setState(storage.getInitialState(), true);
        boundary.resetRequests();
        home = await boundary.addHome('https://resume-settlement.example.test', 'resume-settlement-account');
        boundary.setHttpResponder(createSessionReadBatchFetchBoundary(async input => {
            const path = new URL(String(input)).pathname;
            if (!path.startsWith('/v2/sessions/')) return null;
            const id = decodeURIComponent(path.slice('/v2/sessions/'.length));
            const session = storage.getState().sessions[id];
            return Response.json({ session: fixtures.createPlainSessionCurrentProjectionRecordFixture({ id,
                ...(session ? { active: session.active, seq: session.seq, metadata: session.metadata } : {}) }) });
        }));
    });

    afterEach(() => {
        for (const sessionId of Object.keys(storage.getState().sessions)) storage.getState().clearSessionResuming(sessionId);
        vi.restoreAllMocks();
    });
    afterAll(() => boundary.dispose());

    function resumeRequests() {
        return boundary.requests.filter(request => request.method === RPC_METHODS.SPAWN_HAPPY_SESSION
            || request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE);
    }

    it.each(['acknowledged', 'refused', 'cancelled-before-admission', 'open-before-navigation'] as const)(
        'keeps the %s Resume result across caller cancellation through the real Action executor', async disposition => {
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
        const syncBridge = await loadSyncSingletonForTests();
        try {
            const machine = machineFixtures.createHydratedPlainMachineFixture({ id: 'machine-1', accountId: home.accountId,
                machine: { activeAt: Date.now(), managedMachineRef: null } });
            await publishMachineInventoryForTest({ serverId: home.id, accountId: home.accountId }, [machine]);
            const sessionId = 'c123456789012345678901234';
            storage.setState({ sessions: { [sessionId]: fixtures.createSessionFixture({ id: sessionId,
                serverId: home.id, active: false, metadata: metadata.MetadataSchema.parse({
                    path: '/tmp', host: 'host.local', machineId: machine.id,
                    runtimeDescriptorV1: { v: 1, agentId: DEFAULT_AGENT_ID, agent: {} },
                }) }) } });
            const caller = new AbortController();
            boundary.setRpcAckResponder(async request => {
                if (request.method !== RPC_METHODS.SPAWN_HAPPY_SESSION
                    && request.method !== RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
                    return { ok: false, error: 'Not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
                }
                return { ok: true, result: disposition === 'refused'
                    ? { type: 'error', errorCode: 'SESSION_DIRECTORY_MISSING', errorMessage: 'Missing folder' }
                    : { type: 'success', sessionId } };
            });
            const resumeSession = ops.resumeSession;
            // Observe settlement without replacing any owner logic or its result:
            // the original Resume consumes the real Socket.IO acknowledgement first.
            vi.spyOn(ops, 'resumeSession').mockImplementation(async options => {
                const result = await resumeSession(options);
                expect(result).toMatchObject(disposition === 'refused'
                    ? { type: 'error', errorCode: 'SESSION_DIRECTORY_MISSING' }
                    : { type: 'success', sessionId });
                caller.abort();
                return result;
            });
            if (disposition === 'cancelled-before-admission') caller.abort();
            const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
            const openSession = vi.fn();
            const execution = createDefaultActionExecutor({ openSession }).execute('session.open', {
                sessionId, serverId: home.id,
                ...(disposition === 'open-before-navigation'
                    ? { approvedNewDirectoryCreation: true } : { intent: 'resume' }),
            }, { serverId: home.id, surface: 'ui', authority: 'present_user', signal: caller.signal,
                actionRequestId: `resume-cancellation-${disposition}`, bypassApprovals: true });

            if (disposition === 'cancelled-before-admission') {
                await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
                expect(resumeRequests()).toEqual([]);
            } else {
                const result = await execution;
                expect(resumeRequests(), JSON.stringify({ result, paths: boundary.httpRequests.map(request => new URL(request.url).pathname) }))
                    .toHaveLength(1);
                expect(caller.signal.aborted).toBe(true);
                expect(result, JSON.stringify(result)).toMatchObject(disposition === 'open-before-navigation'
                    ? { ok: false, errorCode: 'cancelled' }
                    : disposition === 'refused'
                        ? { ok: false, errorCode: 'SESSION_DIRECTORY_MISSING' }
                        : { ok: true, result: { status: 'opened', sessionId } });
            }
            expect(openSession).not.toHaveBeenCalled();
        } finally { syncBridge.dispose(); }
    });
});
