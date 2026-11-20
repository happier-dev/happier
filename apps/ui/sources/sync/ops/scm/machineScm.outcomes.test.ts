import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createScmCapabilities } from '@happier-dev/protocol/scm';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { storage } = await import('@/sync/domains/state/storage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { machineScmCommitCreate, machineScmRemotePush, machineScmPullRequestOpenOrReuse, machineScmStashCreate } = await import('./machineScm');
let serverId: string;

beforeEach(async () => {
    storage.setState(storage.getInitialState(), true);
    rpc.mockReset();
    await harness.reset();
    serverId = await harness.addHome({ name: 'SCM Home', serverUrl: 'https://scm-outcomes.test',
        accountId: 'scm-account', serverIdentityId: 'srv_scm_outcomes', currentAccount: true });
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'scm-account' };
    const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({
        v: 1,
        // These tests exercise acknowledged/lost transport outcomes after the
        // user's persisted approval policy has admitted the mutation.
        approvalWaivedSurfaces: Object.fromEntries(['scm.commit.create', 'scm.commit.undoLast',
            'scm.remote.push', 'scm.pullRequest.openOrReuse', 'scm.stash.create'].map(actionId => [actionId, ['ui']])),
    }) };
    storage.setState({ settingsScope: scope, profileScope: scope });
    storage.getState().applySettingsForScope(scope, settings, 1);
    harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
});
afterEach(() => { standardCleanup(); });

describe('SCM mutation transport outcomes', () => {
    it('keeps both the capability read and the admitted commit in the selected managed Project', async () => {
        const workspace = { v: 2, kind: 'managed', serverId, workspaceId: 'remote-project', managedId: 'guest',
            controller: { machineId: 'controller', installationId: 'installation' }, rootPath: '/repo' } as const;
        const expectedHeadOid = 'a'.repeat(40);
        const expectedRef = 'refs/heads/main';
        rpc.mockImplementation(async (input: { method: string }) => input.method === RPC_METHODS.SCM_BACKEND_DESCRIBE
            ? { success: true, capabilities: createScmCapabilities({ writeCommit: true, writeCommitExpectedBase: true }) }
            : { success: true, commitSha: 'b'.repeat(40) });
        const result = await machineScmCommitCreate('controller', { cwd: '/repo', message: 'commit', expectedHeadOid, expectedRef }, { serverId, workspace });
        expect(result).toMatchObject({ success: true, commitSha: 'b'.repeat(40) });
        expect(rpc.mock.calls.map(([request]) => ({ method: request.method, target: request.payload.target, machineId: request.machineId })))
            .toEqual([RPC_METHODS.SCM_BACKEND_DESCRIBE, RPC_METHODS.SCM_COMMIT_CREATE]
                .map(method => ({ method, target: workspace, machineId: 'controller' })));
    });
    it('returns the managed Project source recovery from the exact Push admission', async () => {
        const workspace = { v: 2, kind: 'managed', serverId, workspaceId: 'remote-project', managedId: 'guest',
            controller: { machineId: 'controller', installationId: 'installation' }, rootPath: '/repo' } as const;
        const outcome = { v: 1, kind: 'needs_input', errorCode: 'REMOTE_AUTH_REQUIRED',
            nextActions: [{ kind: 'connect_repository' }] } as const;
        rpc.mockResolvedValue({ success: false, errorCode: outcome.errorCode, outcome });

        const result = await machineScmRemotePush('controller', { cwd: workspace.rootPath }, { serverId, workspace });
        expect(result).toMatchObject({ success: false, outcome });
        expect(rpc).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            method: RPC_METHODS.SCM_REMOTE_PUSH,
            machineId: workspace.controller.machineId,
            payload: { v: 1, kind: 'targeted_action_rpc', target: workspace,
                input: { cwd: workspace.rootPath, outcomeVersion: 1 } },
        }));
    });
    it('returns the guest commit when the controller has a different repository at the same path', async () => {
        const { searchWorkspaceCommits } = await import('@/scm/search/searchWorkspaceCommits');
        const workspace = { v: 2, kind: 'managed', serverId, workspaceId: 'remote-project', managedId: 'guest',
            controller: { machineId: 'controller', installationId: 'installation' }, rootPath: '/repo' } as const;
        rpc.mockImplementation(async (request: { payload: { target?: unknown } }) => {
            const isGuest = request.payload.target !== undefined;
            const sha = (isGuest ? 'b' : 'a').repeat(40);
            return { success: true, queryApplied: true, entries: [{
                sha, shortSha: sha.slice(0, 12), authorName: 'Test Author', authorEmail: 'author@example.test',
                timestamp: 1_767_225_600_000, subject: 'matching commit', body: '',
            }] };
        });
        const scope = { serverId, machineId: workspace.controller.machineId, rootPath: workspace.rootPath };
        await expect(searchWorkspaceCommits({ scope, query: 'matching' })).resolves.toMatchObject({
            status: 'matches', entries: [{ sha: 'a'.repeat(40) }],
        });
        await expect(searchWorkspaceCommits({ scope: { ...scope, workspace }, query: 'matching' })).resolves.toMatchObject({
            status: 'matches', entries: [{ sha: 'b'.repeat(40) }],
        });
        expect(rpc).toHaveBeenLastCalledWith(expect.objectContaining({
            method: RPC_METHODS.SCM_LOG_LIST, payload: expect.objectContaining({ target: workspace }),
        }));
    });
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
        const result = await machineScmCommitUndoLast('machine-other', { cwd: '/repo', expectedHeadOid }, { serverId });
        expect(result, JSON.stringify(result)).toMatchObject({ success: true, undoneCommitSha: expectedHeadOid, headOid: 'b'.repeat(40) });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-other', serverId: resolveServerProfileScopeIdForIdentifier(serverId), method: 'scm.commit.undoLast', payload: { cwd: '/repo', expectedHeadOid, outcomeVersion: 1 } }));

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
        expect(commit, JSON.stringify(commit)).toMatchObject({ success: false, outcome: { kind: 'outcome_unknown', reconciliation: { kind: 'repository_status', cwd: '/repo' }, nextActions: [{ kind: 'refresh' }] } });
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
