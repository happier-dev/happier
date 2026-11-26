import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSessionFilesHookCommonModuleMocks } from './sessionFilesHookTestHelpers';
import { createScmNetworkTestHarness } from '../sourceControl/scmNetworkTestHarness';
const { rpc, alert, confirm } = vi.hoisted(() => ({ rpc: vi.fn(), alert: vi.fn(), confirm: vi.fn(async () => true) }));
installSessionFilesHookCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ confirmResult: true, spies: { alert, confirm } }).module;
    },
    storage: async (original) => original(),
});
const harness = await createScmNetworkTestHarness();
const { storage } = harness;
const { executeScmCommit } = await import('./executeScmCommit');
afterAll(() => harness.dispose());
describe('commit result survives refresh failure', () => {
    beforeEach(async () => {
        await harness.reset();
        storage.getState().markSessionProjectScmCommitSelectionPaths('s1', ['a.txt'], harness.serverId);
        storage.getState().upsertSessionProjectScmCommitSelectionPatch('s1', { path: 'b.txt', patch: 'patch' }, harness.serverId);
        rpc.mockReset().mockResolvedValue({ success: true, commitSha: 'abc123' });
        harness.network.setRpcResponder(async (request) => {
            if (request.method !== RPC_METHODS.SCM_COMMIT_CREATE) throw new Error(`Unexpected commit RPC: ${request.method}`);
            return await rpc(request);
        });
        alert.mockReset();
        confirm.mockClear();
    });
    it('returns the missing Git identity refusal for inline repair and preserves the selection', async () => {
        rpc.mockResolvedValueOnce({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_IDENTITY_REQUIRED,
            error: 'A Git identity is required' });
        const refreshScmData = vi.fn(async () => {});
        const result = await executeScmCommit({
            sessionId: 's1', serverId: harness.serverId, repoPath: '/repo', commitMessage: 'commit', scmCommitStrategy: 'atomic',
            commitSelectionPaths: ['a.txt'], commitSelectionPatches: [], refreshScmData, loadCommitHistory: async () => {},
            setScmOperationBusy: vi.fn(), setScmOperationStatus: vi.fn(), tracking: null,
        });
        expect(result).toEqual({ ok: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_IDENTITY_REQUIRED });
        expect(storage.getState().getSessionProjectScmCommitSelectionPaths('s1', harness.serverId)).toEqual(['a.txt']);
        expect(refreshScmData).not.toHaveBeenCalled();
        expect(alert).not.toHaveBeenCalled();
    });
    it.each(['status', 'history', 'feedback', 'reporting'] as const)('preserves success and only retries refresh after %s fails', async (failure) => {
        const refreshScmData = vi.fn(async () => {});
        const loadCommitHistory = vi.fn(async () => {});
        const setScmOperationStatus = vi.fn<(status: string | null) => void>();
        const capture = vi.fn();
        const refreshAttempts = failure === 'status' || failure === 'history' ? 1 : 0;
        if (failure === 'reporting') capture.mockImplementationOnce(() => { throw new Error('telemetry unavailable'); });
        else if (failure === 'feedback') setScmOperationStatus.mockImplementationOnce(() => { throw new Error('feedback unavailable'); });
        else (failure === 'status' ? refreshScmData : loadCommitHistory).mockRejectedValueOnce(new Error('RPC method not available'));
        const result = await executeScmCommit({
            sessionId: 's1', serverId: harness.serverId, repoPath: '/repo', commitMessage: 'commit', scmCommitStrategy: 'atomic',
            commitSelectionPaths: ['a.txt'], commitSelectionPatches: [{ path: 'b.txt', patch: 'patch' }],
            refreshScmData, loadCommitHistory, setScmOperationBusy: vi.fn(), setScmOperationStatus, tracking: { capture },
        });
        expect(refreshScmData).toHaveBeenCalledTimes(refreshAttempts);
        expect(result.ok).toBe(true);
        expect(storage.getState().getSessionProjectScmCommitSelectionPaths('s1', harness.serverId)).toEqual([]);
        expect(storage.getState().getSessionProjectScmCommitSelectionPatches('s1', harness.serverId)).toEqual([]);
        const log = storage.getState().getSessionProjectScmOperationLog('s1', harness.serverId);
        expect(log).toEqual(expect.arrayContaining([
            expect.objectContaining({ operation: 'commit', status: 'success', detail: 'abc123' }),
            expect.objectContaining({ operation: 'refresh', status: 'failed' }),
        ]));
        expect(log).not.toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'commit', status: 'failed' })]));
        // The pane's outcome line says it (and offers Try again); nothing is a modal.
        expect(alert).not.toHaveBeenCalled();
        expect(storage.getState().getSessionProjectScmInFlightOperation('s1', harness.serverId)).toBeNull();
    });
    it('never repeats creation when final index sync fails after a commit SHA exists', async () => {
        rpc.mockResolvedValueOnce({
            success: false,
            commitSha: 'abc123',
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: "fatal: Unable to create '/tmp/commit-test/.git/index.lock': File exists.",
        });
        const result = await executeScmCommit({
            sessionId: 's1', serverId: harness.serverId, repoPath: '/repo', commitMessage: 'commit', scmCommitStrategy: 'atomic',
            commitSelectionPaths: ['a.txt'], commitSelectionPatches: [{ path: 'b.txt', patch: 'patch' }],
            refreshScmData: vi.fn(async () => {}), loadCommitHistory: vi.fn(async () => {}),
            setScmOperationBusy: vi.fn(), setScmOperationStatus: vi.fn(), tracking: null,
        });
        expect(result.ok).toBe(false);
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(confirm).not.toHaveBeenCalled();
        expect(storage.getState().getSessionProjectScmCommitSelectionPaths('s1', harness.serverId)).toEqual([]);
        expect(storage.getState().getSessionProjectScmCommitSelectionPatches('s1', harness.serverId)).toEqual([]);
        expect(storage.getState().getSessionProjectScmOperationLog('s1', harness.serverId).find((entry) => entry.operation === 'commit')).toMatchObject({
            operation: 'commit',
            outcome: { kind: 'effect_applied_with_warning', effect: { kind: 'commit', commitSha: 'abc123' } },
        });
    });
    it.each(['published', 'unknown'] as const)('never retries %s publication with a lock diagnostic and no legacy SHA', async (state) => {
        const candidateOid = 'b'.repeat(40);
        rpc.mockResolvedValueOnce({ success: false, errorCode: 'INDEX_LOCKED', error: 'index.lock: File exists', publication: { state, expectedHeadOid: 'a'.repeat(40), expectedRef: 'refs/heads/main', candidateOid, indexReconciliation: 'failed' } });
        const refreshScmData = vi.fn(async () => {});
        await executeScmCommit({ sessionId: 's1', serverId: harness.serverId, repoPath: '/repo', commitMessage: 'commit', scmCommitStrategy: 'atomic', commitSelectionPaths: ['a.txt'], commitSelectionPatches: [], refreshScmData, loadCommitHistory: async () => {}, setScmOperationBusy: vi.fn(), setScmOperationStatus: vi.fn(), tracking: null });
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(confirm).not.toHaveBeenCalled();
        const operation = storage.getState().getSessionProjectScmOperationLog('s1', harness.serverId).find((entry) => entry.operation === 'commit');
        expect(operation?.outcome).toMatchObject(state === 'published' ? { kind: 'effect_applied_with_warning', effect: { kind: 'commit', commitSha: candidateOid } } : { kind: 'outcome_unknown' });
        expect(refreshScmData).toHaveBeenCalledTimes(1);
    });
    it('retains canonical commit identity when a new response omits the legacy SHA field', async () => {
        rpc.mockResolvedValueOnce({ success: true, outcome: { v: 1, kind: 'succeeded', effect: { kind: 'commit', commitSha: 'canonical-sha' }, nextActions: [] } });
        await executeScmCommit({
            sessionId: 's1', serverId: harness.serverId, repoPath: '/repo', commitMessage: 'commit', scmCommitStrategy: 'atomic',
            commitSelectionPaths: ['a.txt'], commitSelectionPatches: [],
            refreshScmData: async () => { throw new Error('status unavailable'); }, loadCommitHistory: async () => {},
            setScmOperationBusy: vi.fn(), setScmOperationStatus: vi.fn(), tracking: null,
        });
        expect(storage.getState().getSessionProjectScmOperationLog('s1', harness.serverId)[0]).toMatchObject({
            operation: 'refresh', outcome: { kind: 'effect_applied_with_warning', effect: { kind: 'commit', commitSha: 'canonical-sha' } },
        });
        expect(rpc).toHaveBeenCalledTimes(1);
    });
});
