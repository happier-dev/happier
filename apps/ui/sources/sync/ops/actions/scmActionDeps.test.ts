import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createScmCapabilities, ScmPullRequestPrepareWorktreeRequestSchema } from '@happier-dev/protocol/scm';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));

import { storage } from '@/sync/domains/state/storage';
import { createUiScmAction } from './scmActionDeps';
import { sessionScmCommitUndoLast } from '@/sync/ops/sessionScm';

const executeCanonicalAction = async () => ({ ok: false as const, errorCode: 'unsupported_action', error: 'unsupported_action' });
const expectedHeadOid = 'a'.repeat(40);

beforeEach(() => {
    storage.setState(storage.getInitialState(), true);
    rpc.mockReset();
    rpc.mockImplementation(async ({ method }: { method: string }) => method === 'scm.backend.describe'
        ? { success: true, capabilities: createScmCapabilities({ writeCommitUndoLast: true }) }
        : method === 'scm.pullRequest.prepareWorktree' ? { success: true, targetPath: '/repo/review' }
        : { success: true, undoneCommitSha: expectedHeadOid });
});

describe('SCM Action target binding', () => {
    it('routes machine inventory without inventing a repository and rejects a Session inventory request', async () => {
        const inventory = { success: true, results: [], count: 0, bytes: 0,
            sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 } };
        rpc.mockResolvedValue(inventory);
        expect(await createUiScmAction()({ actionId: 'scm.diffSummary.result.list', input: {},
            context: { serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' } }, executeCanonicalAction,
        })).toEqual(inventory);
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine', payload: {}, method: 'scm.diffSummary.result.list' }));
        expect(await createUiScmAction()({ actionId: 'scm.diffSummary.result.list', input: {},
            context: { defaultSessionId: 'session' }, executeCanonicalAction,
        })).toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
    });
    it('does not attach a Git reconciliation outcome to an unconfirmed result edit', async () => {
        rpc.mockRejectedValue(new Error('Disconnected'));
        const response = await createUiScmAction()({ actionId: 'scm.diffSummary.result.edit',
            input: { cwd: '/repo', resultId: 'saved', expectedRevision: 1, edit: { kind: 'renameWalkthrough', title: 'Draft' } },
            context: { externalActionTarget: { kind: 'machine', machineId: 'machine' } }, executeCanonicalAction,
        });
        expect(response).toMatchObject({ success: false, errorCode: 'COMMAND_OUTCOME_UNKNOWN' });
        expect(response).not.toHaveProperty('outcome');
    });
    it('sends strict saved-result requests without Git mutation envelope fields', async () => {
        storage.setState({ settings: { ...storage.getState().settings, scmGitRepoPreferredBackend: 'sapling' } });
        rpc.mockResolvedValue({ success: false, errorCode: 'revision_conflict', error: 'Changed', latestRevision: 2 });
        const input = { cwd: '/repo', resultId: 'saved', expectedRevision: 1, edit: { kind: 'renameWalkthrough', title: 'Draft' } };
        expect(await createUiScmAction()({ actionId: 'scm.diffSummary.result.edit', input,
            context: { serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' } }, executeCanonicalAction,
        })).toEqual({ success: false, errorCode: 'revision_conflict', error: 'Changed', latestRevision: 2 });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ payload: input }));
    });
    it('refuses machine undo without an explicit repository instead of using daemon cwd', async () => {
        expect(await createUiScmAction()({ actionId: 'scm.commit.undoLast', input: { expectedHeadOid },
            context: { serverId: 'home-other', runtimeAccountId: 'account-other', externalActionTarget: { kind: 'machine', machineId: 'machine-other' } }, executeCanonicalAction,
        })).toMatchObject({ ok: false, errorCode: 'invalid_input' });
        expect(rpc).not.toHaveBeenCalled();
    });

    it('binds session undo and prepared-worktree source to the selected session repository', async () => {
        storage.setState({ sessions: { selected: createSessionFixture({ id: 'selected', serverId: 'home-other',
            metadata: { path: '/repo/selected', machineId: 'machine-other', host: 'host', homeDir: '/home/user' },
        }) } });
        const context = { serverId: 'home-other', runtimeAccountId: 'account-other', defaultSessionId: 'selected' };
        await createUiScmAction()({ actionId: 'scm.commit.undoLast', input: { cwd: '/repo/not-selected', expectedHeadOid }, context, executeCanonicalAction });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'home-other', accountId: 'account-other', machineId: 'machine-other',
            method: 'scm.commit.undoLast', payload: { cwd: '/repo/selected', expectedHeadOid, outcomeVersion: 1 },
        }));
        const preparedInput = ScmPullRequestPrepareWorktreeRequestSchema.parse({ cwd: '/repo/not-selected', sourcePath: '/repo/not-selected', prReference: { number: 7 } });
        await createUiScmAction()({ actionId: 'scm.pullRequest.prepareWorktree', input: preparedInput, context, executeCanonicalAction });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'scm.pullRequest.prepareWorktree', payload: {
            ...preparedInput, cwd: '/repo/selected', sourcePath: '/repo/selected', outcomeVersion: 1,
        } }));
        // Action binding must not change the ordinary facade's relative-path contract.
        expect(await sessionScmCommitUndoLast('selected', { cwd: 'nested', expectedHeadOid }, 'home-other'))
            .toMatchObject({ success: true, undoneCommitSha: expectedHeadOid });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'home-other', machineId: 'machine-other',
            method: 'scm.commit.undoLast', payload: { cwd: '/repo/selected/nested', expectedHeadOid, outcomeVersion: 1 },
        }));
    });
});
