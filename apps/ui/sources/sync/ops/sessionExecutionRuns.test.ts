import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

const sessionRpcMock = vi.hoisted(() => vi.fn());
// The authenticated Account-scoped RPC transport is a network boundary.
const sessionAccountRpcMock = vi.hoisted(() => vi.fn());
const canUseSessionRpcMock = vi.hoisted(() => vi.fn(() => true));
const readMachineControlTargetMock = vi.hoisted(() => vi.fn(() => ({ machineId: 'machine-1' })));
const notifyExecutionRunActivityMock = vi.hoisted(() => vi.fn());
const expectRpcTimeout = expect.objectContaining({ timeoutMs: expect.any(Number) });
const sessionState = vi.hoisted(() => ({
    sessions: {} as Record<string, any>,
    settings: {},
}));

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: sessionRpcMock,
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async (importOriginal) => {
    const { createServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedSessionRpcModuleMock({
        importOriginal,
        overrides: {
            sessionRpcWithServerAccountScope: sessionAccountRpcMock,
            sessionRpcWithServerScope: async (params: Readonly<{
                sessionId: string;
                serverId?: string | null;
                method: string;
                payload: unknown;
            }>) => sessionRpcMock(
                params.sessionId,
                params.method,
                params.payload,
                { serverId: params.serverId, timeoutMs: 1 },
            ),
        },
    });
});

vi.mock('./sessionMachineTarget', () => ({
    INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR: 'Session RPC unavailable for inactive session',
    canUseSessionRpc: (...args: Parameters<typeof canUseSessionRpcMock>) => canUseSessionRpcMock(...args),
    readMachineControlTargetForSession: (...args: Parameters<typeof readMachineControlTargetMock>) =>
        readMachineControlTargetMock(...args),
}));

vi.mock('@/sync/runtime/executionRuns/executionRunActivityBus', () => ({
    notifyExecutionRunActivity: (...args: Parameters<typeof notifyExecutionRunActivityMock>) =>
        notifyExecutionRunActivityMock(...args),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => sessionState,
        },
    });
});

describe('sessionExecutionRuns', () => {
    let sessionExecutionRuns: typeof import('./sessionExecutionRuns');

    beforeAll(async () => {
        vi.resetModules();
        sessionExecutionRuns = await import('./sessionExecutionRuns');
    }, 120_000);

    afterAll(() => {
        vi.resetModules();
    });

    beforeEach(() => {
        sessionState.sessions = {
            'session-1': { id: 'session-1', serverId: 'server-a', active: true },
            'session-inactive': { id: 'session-inactive', serverId: 'server-a', active: false },
        };
    });

    afterEach(() => {
        sessionRpcMock.mockReset();
        sessionAccountRpcMock.mockReset();
        canUseSessionRpcMock.mockReset();
        canUseSessionRpcMock.mockReturnValue(true);
        readMachineControlTargetMock.mockReset();
        readMachineControlTargetMock.mockReturnValue({ machineId: 'machine-1' });
        notifyExecutionRunActivityMock.mockReset();
        sessionState.sessions = {};
        sessionState.settings = {};
    });

    it('preserves the captured Account refusal instead of using ambient Session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });
        const refusal = { ok: false, error: 'Account scope retired', errorCode: 'scope_retired' };
        sessionAccountRpcMock.mockImplementation(async (request) => request.scope.accountId === 'captured-account'
            ? refusal : { ok: true });
        const response = await sessionExecutionRuns.sessionExecutionRunAction('session-1', {
            runId: 'run_1', actionId: 'review.follow_up', input: { messageMarkdown: 'Explain this finding' },
        }, { serverId: 'server-a', scope: { serverId: 'server-a', accountId: 'captured-account' } });
        expect(response).toEqual(refusal);
        expect(notifyExecutionRunActivityMock).not.toHaveBeenCalled();
    });

    it.each([{ waitForInputId: 'input-1' }, { waitForOutput: { kind: 'review_walkthrough' as const, comparisonId: 'comparison-1' } }])
    ('keeps exact get observation under caller lifecycle: %j', async (wait) => {
        sessionAccountRpcMock.mockResolvedValue({ error: 'Observation cancelled' });
        const controller = new AbortController();
        await sessionExecutionRuns.sessionExecutionRunGet('session-1', { runId: 'run-1', ...wait }, {
            scope: { serverId: 'server-a', accountId: 'captured-account' }, signal: controller.signal,
        });
        expect(sessionAccountRpcMock).toHaveBeenCalledWith(expect.objectContaining({
            method: SESSION_RPC_METHODS.EXECUTION_RUN_GET, timeoutMs: null, signal: controller.signal,
        }));
    });

    it('calls execution.run.action through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });

        const response = await sessionExecutionRuns.sessionExecutionRunAction('session-1', {
            runId: 'run_1',
            actionId: 'review.triage',
            input: { findings: [{ id: 'f1', status: 'accept' }] },
        });

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-1',
            SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
            {
                runId: 'run_1',
                actionId: 'review.triage',
                input: { findings: [{ id: 'f1', status: 'accept' }] },
            },
            expectRpcTimeout,
        );
        expect(response.ok).toBe(true);
    });

    it('notifies execution-run activity after execution.run.action succeeds', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });

        const response = await sessionExecutionRuns.sessionExecutionRunAction('session-1', {
            runId: 'run_1',
            actionId: 'review.triage',
            input: { findings: [{ id: 'f1', status: 'accept' }] },
        });

        expect(response).toEqual({ ok: true });
        expect(notifyExecutionRunActivityMock).toHaveBeenCalledWith({
            serverId: 'server-a',
            sessionId: 'session-1',
        });
    });

    it('calls execution.run.start through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' });

        const response = await sessionExecutionRuns.sessionExecutionRunStart('session-1', {
            intent: 'review',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            instructions: 'Review this repo.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        });

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-1',
            SESSION_RPC_METHODS.EXECUTION_RUN_START,
            {
                intent: 'review',
                backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                instructions: 'Review this repo.',
                permissionMode: 'read_only',
                retentionPolicy: 'ephemeral',
                runClass: 'bounded',
                ioMode: 'request_response',
            },
            expectRpcTimeout,
        );
        expect((response as any).runId).toBe('run_1');
    });

    it('returns ok:false error shapes from execution.run.start without treating them as unsupported', async () => {
        sessionRpcMock.mockResolvedValue({ ok: false, error: 'Permission denied', errorCode: 'permission_denied' });

        const response = await sessionExecutionRuns.sessionExecutionRunStart('session-1', {
            intent: 'review',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            instructions: 'Review this repo.',
            permissionMode: 'full',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        });

        expect((response as any).ok).toBe(false);
        expect((response as any).errorCode).toBe('permission_denied');
    });

    it('returns typed noRunCreated and emits no RPC when the preflight target witness changed', async () => {
        readMachineControlTargetMock.mockReturnValue({ machineId: 'machine-2' });

        const response = await sessionExecutionRuns.sessionExecutionRunStart('session-1', {
            intent: 'review',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            instructions: 'Review this repo.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        }, { serverId: 'server-a', expectedMachineId: 'machine-1' });

        expect(response).toEqual({
            ok: false,
            error: 'execution_run_target_changed',
            errorCode: 'execution_run_target_changed',
            details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
        });
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('returns bare error responses from execution.run.start without collapsing them to unsupported', async () => {
        sessionRpcMock.mockResolvedValue({ error: 'Unable to resolve a default base branch for CodeRabbit review.' });

        const response = await sessionExecutionRuns.sessionExecutionRunStart('session-1', {
            intent: 'review',
            backendTarget: { kind: 'backend', backendId: 'coderabbit', sourceKind: 'built_in' },
            instructions: 'Review this repo.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        });

        expect((response as any).ok).toBe(false);
        expect((response as any).error).toBe('Unable to resolve a default base branch for CodeRabbit review.');
    });

    it('fails closed for execution.run.start when the session is inactive', async () => {
        canUseSessionRpcMock.mockReturnValue(false);

        const response = await sessionExecutionRuns.sessionExecutionRunStart('session-inactive', {
            intent: 'review',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            instructions: 'Review this repo.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        });

        expect(sessionRpcMock).not.toHaveBeenCalled();
        expect(response).toEqual({
            ok: false,
            error: 'Session RPC unavailable for inactive session',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
    });

    it('calls execution.run.stop through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });

        const response = await sessionExecutionRuns.sessionExecutionRunStop('session-1', { runId: 'run_1' });

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-1',
            SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
            { runId: 'run_1' },
            expectRpcTimeout,
        );
        expect(response.ok).toBe(true);
    });

    it('cancels the exact retained Run turn and resumes through canonical ensure', async () => {
        sessionRpcMock
            .mockResolvedValueOnce({
                ok: true, status: 'requested', runId: 'run_1', occurrenceId: 'occurrence_1', turnId: 'turn_1',
            })
            .mockResolvedValueOnce({ ok: true });

        await expect(sessionExecutionRuns.sessionExecutionRunCancelTurn('session-1', {
            runId: 'run_1', occurrenceId: 'occurrence_1', turnId: 'turn_1',
        })).resolves.toMatchObject({ ok: true, status: 'requested' });
        await expect(sessionExecutionRuns.sessionExecutionRunResume('session-1', {
            runId: 'run_1',
        })).resolves.toEqual({ ok: true });

        expect(sessionRpcMock.mock.calls.slice(-2).map((call) => [call[1], call[2]])).toEqual([
            [SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1, {
                runId: 'run_1', occurrenceId: 'occurrence_1', turnId: 'turn_1',
            }],
            [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE, { runId: 'run_1', resume: true }],
        ]);
    });

    it('notifies execution-run activity after execution.run.stop succeeds', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });

        const response = await sessionExecutionRuns.sessionExecutionRunStop('session-1', { runId: 'run_1' });

        expect(response).toEqual({ ok: true });
        expect(notifyExecutionRunActivityMock).toHaveBeenCalledWith({
            serverId: 'server-a',
            sessionId: 'session-1',
        });
    });

    it('returns ok:false error shapes from execution.run.stop without treating them as unsupported', async () => {
        sessionRpcMock.mockResolvedValue({ ok: false, error: 'Not running', errorCode: 'execution_run_not_allowed' });

        const response = await sessionExecutionRuns.sessionExecutionRunStop('session-1', { runId: 'run_1' });

        expect((response as any).ok).toBe(false);
        expect((response as any).errorCode).toBe('execution_run_not_allowed');
    });

    it('allows execution.run.stop for inactive sessions through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });
        canUseSessionRpcMock.mockReturnValue(false);

        const response = await sessionExecutionRuns.sessionExecutionRunStop('session-inactive', { runId: 'run_1' });

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-inactive',
            SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
            { runId: 'run_1' },
            expectRpcTimeout,
        );
        expect(response).toEqual({ ok: true });
    });

    it('calls execution.run.list through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ runs: [] });

        const response = await sessionExecutionRuns.sessionExecutionRunList('session-1', {});

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-1',
            SESSION_RPC_METHODS.EXECUTION_RUN_LIST,
            {},
            expectRpcTimeout,
        );
        expect(Array.isArray((response as any).runs)).toBe(true);
    });

    it('fails closed instead of routing a same-id Session operation to another Home', async () => {
        sessionRpcMock.mockResolvedValue({ runs: [] });

        await expect(sessionExecutionRuns.sessionExecutionRunList(
            'session-1',
            {},
            { serverId: 'server-b' },
        )).resolves.toEqual({
            ok: false,
            error: 'Execution Run Home is unavailable',
            errorCode: 'execution_run_home_unavailable',
        });

        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('fails closed when execution.run.list returns a sparse non-contract run', async () => {
        sessionRpcMock.mockResolvedValue({
            runs: [{
                runId: 'run_legacy_sparse',
                intent: 'voice_agent',
                status: 'running',
                backendId: 'claude',
            }],
        });

        await expect(sessionExecutionRuns.sessionExecutionRunList('session-1', {})).resolves.toEqual({
            ok: false,
            error: 'Unsupported response from session RPC',
        });
    });

    it('calls execution.run.get through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({
            run: {
                runId: 'run_1',
                callId: 'call_1',
                sidechainId: 'call_1',
                intent: 'review',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                permissionMode: 'read_only',
                retentionPolicy: 'ephemeral',
                runClass: 'bounded',
                ioMode: 'request_response',
                status: 'succeeded',
                startedAtMs: 1,
                finishedAtMs: 2,
            },
        });

        const response = await sessionExecutionRuns.sessionExecutionRunGet('session-1', { runId: 'run_1', includeStructured: true });

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-1',
            SESSION_RPC_METHODS.EXECUTION_RUN_GET,
            { runId: 'run_1', includeStructured: true },
            expectRpcTimeout,
        );
        expect((response as any).run?.runId).toBe('run_1');
    });

    it('fails closed when execution.run.get returns backend identity only through sparse predecessor fields', async () => {
        sessionRpcMock.mockResolvedValue({
            run: {
                runId: 'run_sparse',
                backendId: 'claude',
                resumeHandle: {
                    kind: 'provider_session.v1',
                    backendId: 'claude',
                    providerSessionId: 'provider_sparse',
                },
            },
        });

        await expect(sessionExecutionRuns.sessionExecutionRunGet('session-1', {
            runId: 'run_sparse',
            includeStructured: false,
        })).resolves.toEqual({
            ok: false,
            error: 'Unsupported response from session RPC',
        });
    });

    it('returns ok:false error shapes from execution.run.get without treating them as unsupported', async () => {
        sessionRpcMock.mockResolvedValue({ ok: false, error: 'Not found', errorCode: 'execution_run_not_found' });

        const response = await sessionExecutionRuns.sessionExecutionRunGet('session-1', { runId: 'run_1', includeStructured: true });

        expect((response as any).ok).toBe(false);
        expect((response as any).errorCode).toBe('execution_run_not_found');
    });

    it('rejects execution.run.action for inactive replay forks that cannot resume before session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });
        sessionState.sessions['session-inactive'] = {
            id: 'session-inactive',
            serverId: 'server-a',
            active: false,
            metadata: {
                flavor: 'claude',
                claudeSessionId: '',
                forkV1: {
                    v: 1,
                    parentSessionId: 'parent-session',
                    parentCutoffSeqInclusive: 7,
                    createdAtMs: 1000,
                    strategy: 'replay',
                    providerHint: { providerId: 'claude' },
                },
                replaySeedV1: {
                    v: 1,
                    seedText: '',
                    sourceSessionId: 'parent-session',
                    sourceCutoffSeqInclusive: 7,
                    createdAtMs: 1000,
                    appliedToLocalId: 'local-1',
                    appliedAtMs: 2000,
                },
            },
        };

        const response = await sessionExecutionRuns.sessionExecutionRunAction('session-inactive', {
            runId: 'run_1',
            actionId: 'review.triage',
            input: { findings: [{ id: 'f1', status: 'accept' }] },
        });

        expect(sessionRpcMock).not.toHaveBeenCalled();
        expect(response).toEqual({
            ok: false,
            error: 'SESSION_NOT_RESUMABLE',
            errorCode: 'SESSION_NOT_RESUMABLE',
        });
    });

    it('detects terminal not-running send errors by error code', async () => {
        expect(
            sessionExecutionRuns.isExecutionRunNotRunningMutationError({
                ok: false,
                error: 'Not running',
                errorCode: 'execution_run_not_allowed',
            }),
        ).toBe(true);
        expect(
            sessionExecutionRuns.isExecutionRunNotRunningMutationError({
                ok: false,
                error: 'Already finished',
                errorCode: 'execution_run_not_running',
            }),
        ).toBe(true);
    });

    it('detects terminal not-running send errors by message fallback', async () => {
        expect(
            sessionExecutionRuns.isExecutionRunNotRunningMutationError({
                ok: false,
                error: 'execution run is not running anymore',
            }),
        ).toBe(true);
        expect(
            sessionExecutionRuns.isExecutionRunNotRunningMutationError({
                ok: false,
                error: 'some other transport failure',
            }),
        ).toBe(false);
    });
});
