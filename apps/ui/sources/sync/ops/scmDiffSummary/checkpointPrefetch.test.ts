import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScmDiffSummaryGenerateInputSchema, ScmDiffSummaryGenerateOutputSchema, type TurnChangeSet } from '@happier-dev/protocol';
import { createSessionFixture, createToolCallMessageFixture } from '@/dev/testkit';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { selectSessionScmWalkthroughKey } from '@/sync/domains/scm/diffSummary/selection';
import { buildTurnChangeSetDiffInput } from '../../../../../cli/src/agent/tools/diff/buildTurnChangeSetDiffInput';
import { prefetchCompletedCheckpointMessages } from './checkpointPrefetch';
import { getScmDiffSummaryState, retireScmDiffSummaryScope } from './generate';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storage';

// Authenticated SCM RPC and execution-run RPC are transport boundaries.
const network = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: network.generate }));
vi.mock('@/sync/ops/sessionExecutionRuns', () => ({ sessionExecutionRunGet: vi.fn() }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
await import('@/sync/ops/actions/defaultActionExecutor');

let scope = { serverId: 'checkpoint-home', accountId: 'checkpoint-account' };
function createLifetime() {
    let current = true;
    const retirements = new Set<() => void>();
    return {
        lifetime: { scope, isCurrent: () => current, onRetire: (cancel: () => void) => {
            retirements.add(cancel); return { dispose: () => { retirements.delete(cancel); } };
        } } satisfies ServerAccountScopeLifetime,
        retire: () => { current = false; for (const cancel of retirements) cancel(); },
    };
}
const turn = { sessionId: 'checkpoint-session', turnId: 'checkpoint-turn', status: 'completed',
    seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 }, provider: 'codex', derivedAt: 5,
    files: [{ filePath: 'src/app.ts', changeKind: 'modified', source: 'scm_checkpoint', confidence: 'exact',
        provider: 'scm:git', unifiedDiff: '@@ -1 +1 @@\n-before\n+after' }],
    repositoryCheckpoint: { version: 1, scopeId: 'checkpoint-session:/repo', baseRefSource: 'turn_start', contentConfidence: 'exact',
        attributionScope: 'shared_worktree', startRef: 'refs/happier/checkpoints/start', finalRef: 'refs/happier/checkpoints/final',
        receipts: [{ id: 'checkpoint.finalized', phase: 'turn-final', ref: 'refs/happier/checkpoints/final' }],
    },
} satisfies TurnChangeSet;
function message(changeSet: TurnChangeSet = turn) {
    return createToolCallMessageFixture({ id: 'checkpoint-diff', tool: { name: 'Diff', state: 'completed',
        createdAt: 5, startedAt: 5, completedAt: 6, description: null,
        input: buildTurnChangeSetDiffInput({ turnChangeSet: changeSet, protocol: 'codex', rawToolName: 'RepositoryCheckpointDiff' }),
    } });
}
let session: ReturnType<typeof createSessionFixture>;
beforeEach(async () => {
    await harness.reset();
    const serverId = await harness.addHome({ name: 'Checkpoint Home', serverUrl: 'https://checkpoint-home.example',
        accountId: 'checkpoint-account', serverIdentityId: 'srv-checkpoint-home' });
    scope = { serverId, accountId: 'checkpoint-account' };
    harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } });
    session = createSessionFixture({ id: turn.sessionId, serverId, latestTurnId: turn.turnId,
        latestTurnStatus: 'completed', metadata: { path: '/repo', host: 'fixture', homeDir: '/home/fixture', machineId: 'fixture-machine', flavor: 'codex' } });
    storage.setState({ sessions: { [session.id]: session } });
});

afterEach(() => { retireScmDiffSummaryScope(scope); network.generate.mockReset(); standardCleanup(); });

describe('completed checkpoint transcript prefetch', () => {
    it('consumes durable final transcript evidence through the actual generate owner and reuses its run on replay', async () => {
        network.generate.mockImplementation(async ({ payload }) => {
            const input = ScmDiffSummaryGenerateInputSchema.parse(payload);
            return ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'checkpoint-comparison',
                metadata: { source: input.source, sourceKey: 'checkpoint-comparison' },
                comparison: { id: 'checkpoint-comparison', source: input.source, repository: { rootPath: '/repo' },
                    endpoints: { before: 'start', after: 'final' }, inventory: { state: 'complete', files: [], reasons: [] } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
                requestedOutputs: input.outputs, outputs: input.outputs?.includes('walkthrough')
                    ? { walkthrough: { state: 'pending' } } : { summary: { state: 'pending' } }, runId: 'checkpoint-run' });
        });
        const { lifetime } = createLifetime();
        const params = { session, messages: [message()], settings: { 'scm.diffSummary.prefetch': true }, lifetime };
        await Promise.all([prefetchCompletedCheckpointMessages(params), prefetchCompletedCheckpointMessages(params)]);
        await prefetchCompletedCheckpointMessages(params);
        expect(network.generate).toHaveBeenCalledTimes(1);
        expect(network.generate.mock.calls[0]?.[0]?.payload).toMatchObject({ cwd: '/repo', sessionId: session.id,
            source: { kind: 'turnCheckpoint', sessionId: session.id, turnId: turn.turnId,
                checkpointReceiptId: 'checkpoint.finalized', evidenceMode: 'checkpoint' },
            modelSelector: { backendTargetKey: 'agent:happier.agent.codex/codex' }, outputs: ['walkthrough'],
        });
        expect(Object.values(getScmDiffSummaryState().entriesByKey)).toEqual([expect.objectContaining({ executionRunId: 'checkpoint-run' })]);
        expect(selectSessionScmWalkthroughKey(getScmDiffSummaryState(), session.id,
            { kind: 'turnCheckpoint', turnId: turn.turnId }, 'walkthrough', serverAccountScopeKeySuffix(scope))).not.toBeNull();
    });

    it('stays off by default and ignores old turns, provider evidence and foreign-session receipts', async () => {
        const { lifetime } = createLifetime();
        const params = { session, messages: [message()], lifetime, settings: {} };
        await prefetchCompletedCheckpointMessages(params);
        for (const changeSet of [{ ...turn, turnId: 'old-turn' }, { ...turn, repositoryCheckpoint: undefined }, { ...turn, sessionId: 'foreign-session' }]) {
            await prefetchCompletedCheckpointMessages({ ...params, settings: { 'scm.diffSummary.prefetch': true }, messages: [message(changeSet)] });
        }
        expect(network.generate).not.toHaveBeenCalled();
    });

    it('aborts an admitted request and discards its late publication when the captured Account retires', async () => {
        let resolve!: (value: unknown) => void;
        network.generate.mockImplementation(() => new Promise((done) => { resolve = done; }));
        const { lifetime, retire } = createLifetime();
        const request = prefetchCompletedCheckpointMessages({ session, messages: [message()], lifetime, settings: { 'scm.diffSummary.prefetch': true } });
        await vi.waitFor(() => expect(network.generate).toHaveBeenCalledTimes(1));
        const signal = network.generate.mock.calls[0]?.[0]?.signal as AbortSignal;
        retire();
        expect(signal.aborted).toBe(true);
        resolve({ success: true, sourceKey: 'late-comparison', metadata: { source: { kind: 'turnCheckpoint' }, sourceKey: 'late-comparison' },
            requestedOutputs: ['summary'], outputs: { summary: { state: 'pending' } }, runId: 'late-run' });
        await request;
        expect(getScmDiffSummaryState().entriesByKey).toEqual({});
    });
});
