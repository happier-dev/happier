import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const machineRpcWithServerScope = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(machineRpcWithServerScope);
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { resumeActionOperationHandoff } = await import('./resumeActionOperationHandoff');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
let serverId: string;

describe('resumeActionOperationHandoff', () => {
    beforeEach(async () => {
        await homes.reset();
        machineRpcWithServerScope.mockReset();
        serverId = await homes.addHome({ name: 'Recovery Home', serverUrl: 'https://recovery.test', accountId: 'alice' });
    });

    it('binds the private resume Action only on its internal RPC surface', async () => {
        const input = { handoffId: 'handoff-1', jobId: 'job-1', expectedRevision: 7, attemptId: 'attempt-1' };
        const reply = { ok: false, error: { code: 'stale_revision', message: 'Handoff changed' } };
        machineRpcWithServerScope.mockResolvedValue(reply);
        const context = { serverId, authority: 'present_user' as const,
            externalActionTarget: { kind: 'machine' as const, machineId: 'machine-target' } };
        const executor = createDefaultActionExecutor();
        expect(await executor.execute('session.handoff.prepare_target.resume', input, { ...context, surface: 'ui' }))
            .toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(await executor.execute('session.handoff.prepare_target.resume', input, { ...context, surface: 'rpc' }))
            .toEqual({ ok: true, result: reply });
    });

    it('settles an unanswered handoff read when its request owner cancels', async () => {
        machineRpcWithServerScope.mockImplementation(({ signal }: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }));
        const controller = new AbortController();
        let result: Awaited<ReturnType<typeof resumeActionOperationHandoff>> | undefined;
        void resumeActionOperationHandoff({ serverId, handoffId: 'handoff-1', sessionId: 'session-1',
            targetMachineId: 'machine-1', signal: controller.signal }).then(value => { result = value; });
        await vi.waitFor(() => expect(machineRpcWithServerScope).toHaveBeenCalledOnce());
        controller.abort(new Error('aborted'));
        await vi.waitFor(() => expect(result).toEqual({ kind: 'failed', message: 'aborted' }));
    });

    it('queries and resumes the projected target through canonical machine RPC methods', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({
            handoffId: 'handoff-1',
            transitionRevision: 7,
            status: {
                handoffId: 'handoff-1',
                status: 'awaiting_user_resume' as const,
                phase: 'resuming' as const,
                jobId: 'job-1',
                recoveryActions: [],
            },
        }).mockResolvedValueOnce({
            ok: true as const,
            handoffId: 'handoff-1',
            jobId: 'job-1',
            transitionRevision: 8,
            status: {
                handoffId: 'handoff-1',
                status: 'in_progress' as const,
                phase: 'resuming' as const,
                jobId: 'job-1',
                recoveryActions: [],
            },
        });

        await expect(resumeActionOperationHandoff({
            serverId,
            handoffId: 'handoff-1',
            sessionId: 'session-1',
            targetMachineId: 'machine-target',
            createAttemptId: () => 'attempt-1',
        })).resolves.toEqual({ kind: 'requested' });

        expect(machineRpcWithServerScope).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-target', serverId, method: RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3,
            payload: { handoffId: 'handoff-1' },
        }));
        expect(machineRpcWithServerScope).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-target', serverId, method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESUME_V3,
            payload: {
                handoffId: 'handoff-1',
                jobId: 'job-1',
                expectedRevision: 7,
                attemptId: 'attempt-1',
            },
        }));
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2);
        for (const [request] of machineRpcWithServerScope.mock.calls) {
            expect(request).toMatchObject({ accountId: 'alice', signal: expect.any(AbortSignal) });
        }
    });

    it('retains the requesting Home when focus changes after the status read', async () => {
        machineRpcWithServerScope.mockImplementationOnce(async () => {
            await homes.addHome({ name: 'Other Home', serverUrl: 'https://other-recovery.test', accountId: 'bob' });
            return { transitionRevision: 7, status: { handoffId: 'handoff-1', status: 'awaiting_user_resume',
                phase: 'resuming', jobId: 'job-1', recoveryActions: [] } };
        }).mockResolvedValueOnce({ ok: false, error: { code: 'stale_revision', message: 'Handoff changed' } });
        await expect(resumeActionOperationHandoff({ serverId, handoffId: 'handoff-1', sessionId: 'session-1',
            targetMachineId: 'machine-target', createAttemptId: () => 'attempt-1' }))
            .resolves.toEqual({ kind: 'failed', message: 'Handoff changed' });
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2);
        for (const [request] of machineRpcWithServerScope.mock.calls) {
            expect(request).toMatchObject({ serverId, accountId: 'alice', machineId: 'machine-target' });
        }
    });

    it('does not guess resume material when canonical status is no longer resumable', async () => {
        machineRpcWithServerScope.mockResolvedValue({
                handoffId: 'handoff-1',
                transitionRevision: 8,
                status: {
                    handoffId: 'handoff-1',
                    status: 'completed',
                    phase: 'finalizing',
                    recoveryActions: [],
                },
        });

        await expect(resumeActionOperationHandoff({
            serverId,
            handoffId: 'handoff-1',
            sessionId: 'session-1',
            targetMachineId: 'machine-target',
            createAttemptId: () => 'attempt-1',
        })).resolves.toEqual({ kind: 'not_available' });
        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
    });

    it.each([
        [{ ok: false, error: { code: 'stale_revision', message: 'Handoff changed' } }, 'Handoff changed'],
        [{ unexpected: true }, 'session_handoff_resume_invalid_response'],
    ])('preserves recovery feedback for a refused or malformed resume response', async (reply, message) => {
        machineRpcWithServerScope.mockResolvedValueOnce({ transitionRevision: 7,
            status: { handoffId: 'handoff-1', status: 'awaiting_user_resume', phase: 'resuming',
                jobId: 'job-1', recoveryActions: [] } }).mockResolvedValueOnce(reply);
        await expect(resumeActionOperationHandoff({ serverId, handoffId: 'handoff-1', sessionId: 'session-1',
            targetMachineId: 'machine-target', createAttemptId: () => 'attempt-1' }))
            .resolves.toEqual({ kind: 'failed', message });
    });

    it('does not issue ambient RPC without exact Home evidence', async () => {
        await expect(resumeActionOperationHandoff({
            serverId: null,
            handoffId: 'handoff-1',
            sessionId: 'session-1',
            targetMachineId: 'machine-target',
        })).resolves.toEqual({ kind: 'not_available' });

        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });
});
