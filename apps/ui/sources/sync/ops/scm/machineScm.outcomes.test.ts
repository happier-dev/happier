import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import { createScmCapabilities } from '@happier-dev/protocol/scm';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));

import { storage } from '@/sync/domains/state/storage';
import { machineScmCommitCreate, machineScmRemotePush, machineScmPullRequestOpenOrReuse, machineScmStashCreate } from './machineScm';

beforeEach(() => {
    storage.setState(storage.getInitialState(), true);
    rpc.mockReset();
});

describe('SCM mutation transport outcomes', () => {
    it('refuses explicit commit-base authority when the target cannot honor it before sending a mutation', async () => {
        rpc.mockResolvedValue({ success: true, capabilities: createScmCapabilities({ writeCommit: true }) });
        const request = { cwd: '/repo', message: 'commit', expectedHeadOid: 'a'.repeat(40), expectedRef: 'refs/heads/main' };
        expect(await machineScmCommitCreate('m', request)).toMatchObject({ success: false, errorCode: 'FEATURE_UNSUPPORTED' });
        expect(rpc.mock.calls.map(([call]) => call.method)).toEqual(['scm.backend.describe']);
    });
    it('negotiates undo outcomes and preserves the observed HEAD on the exact machine target', async () => {
        const { machineScmCommitUndoLast } = await import('./machineScm');
        const expectedHeadOid = 'a'.repeat(40);
        rpc.mockImplementation(async (request: { method: string }) => request.method === 'scm.backend.describe'
            ? { success: true, capabilities: createScmCapabilities({ writeCommitUndoLast: true }) }
            : { success: true, undoneCommitSha: expectedHeadOid, headOid: 'b'.repeat(40) });
        const result = await machineScmCommitUndoLast('machine-other', { cwd: '/repo', expectedHeadOid }, { serverId: 'home-other' });
        expect(result).toMatchObject({ success: true, undoneCommitSha: expectedHeadOid, headOid: 'b'.repeat(40) });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-other', serverId: 'home-other', method: 'scm.commit.undoLast', payload: { cwd: '/repo', expectedHeadOid, outcomeVersion: 1 } }));

        rpc.mockImplementation(async (request: { method: string }) => {
            if (request.method === 'scm.backend.describe') return { success: true, capabilities: createScmCapabilities({ writeCommitUndoLast: true }) };
            throw new Error('lost mutation response');
        });
        expect(await machineScmCommitUndoLast('machine-other', { cwd: '/repo', expectedHeadOid }))
            .toMatchObject({ success: false, outcome: { kind: 'outcome_unknown', reconciliation: { kind: 'repository_status', cwd: '/repo' } } });
    });

    it('keeps an explicit missing method as a known no-effect failure', async () => {
        for (const rpcErrorCode of [RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, RPC_ERROR_CODES.METHOD_NOT_FOUND]) {
            rpc.mockRejectedValueOnce(Object.assign(new Error(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE), { rpcErrorCode }));
            const response = await machineScmCommitCreate('m', { cwd: '/repo', message: 'commit' });
            expect(response.success).toBe(false);
            expect(response.outcome?.kind).not.toBe('outcome_unknown');
        }
    });

    it('preserves uncertainty after a lost mutation response and names the read needed before retry', async () => {
        rpc.mockRejectedValue(new Error('lost response with private diagnostics'));
        const commit = await machineScmCommitCreate('m', { cwd: '/repo', message: 'commit' });
        expect(commit).toMatchObject({ success: false, outcome: { kind: 'outcome_unknown', reconciliation: { kind: 'repository_status', cwd: '/repo' }, nextActions: [{ kind: 'refresh' }] } });
        const push = await machineScmRemotePush('m', { cwd: '/repo', remote: 'upstream', branch: 'feature' });
        expect(push).toMatchObject({ outcome: { kind: 'outcome_unknown', reconciliation: { kind: 'remote_ref', remote: 'upstream', branch: 'feature' } } });
        const pr = await machineScmPullRequestOpenOrReuse('m', { cwd: '/repo', head: 'feature', base: 'main' });
        expect(pr).toMatchObject({ outcome: { kind: 'outcome_unknown', reconciliation: { kind: 'pull_request', head: 'feature', base: 'main' } } });
        const stash = await machineScmStashCreate('m', { cwd: '/repo', message: 'recovery' });
        expect(stash).toMatchObject({ outcome: { kind: 'outcome_unknown', reconciliation: { kind: 'stash', message: 'recovery' } } });
        expect(rpc).toHaveBeenCalledTimes(4);
        expect(JSON.stringify([commit, push, pr, stash])).not.toContain('private diagnostics');
    });
});
