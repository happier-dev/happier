import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScmDiffSummaryGenerateInputSchema, ScmDiffSummaryGenerateOutputSchema} from '@happier-dev/protocol/scm/diffSummary';
import { type TurnChangeSet } from '@happier-dev/protocol/sessions/changes/types';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { buildTurnChangeSetDiffInput } from '../../../../../cli/src/agent/tools/diff/buildTurnChangeSetDiffInput';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { AGENT_IDS, getAgentCore, getAgentStaticModels } from '@happier-dev/agents';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';

// Account Action HTTP and execution-run RPC are transport boundaries.
const network = vi.hoisted(() => ({ generate: vi.fn(), rawRpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: network.rawRpc }));
vi.mock('@/sync/ops/sessionExecutionRuns', () => ({ sessionExecutionRunGet: vi.fn() }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { createToolCallMessageFixture } = await import('@/dev/testkit/fixtures/transcriptFixtures');
const { serverAccountScopeKeySuffix } = await import('@/sync/domains/scope/serverAccountScope');
const { selectSessionScmWalkthroughKey } = await import('@/sync/domains/scm/diffSummary/selection');
const { prefetchCompletedCheckpointMessages } = await import('./checkpointPrefetch');
const { getScmDiffSummaryState, retireScmDiffSummaryScope } = await import('./generate');
const { storage } = await import('@/sync/domains/state/storage');
const { answerScmRunMachineCustodyForTests } = await import('@/dev/testkit/harness/scmActionTransport');
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
        accountId: 'checkpoint-account', serverIdentityId: 'srv_checkpoint_home', currentAccount: true });
    scope = { serverId, accountId: 'checkpoint-account' };
    answerScmRunMachineCustodyForTests(harness, serverId, 'scm.diffSummary.generate', {
        homeId: 'srv_checkpoint_home', accountId: scope.accountId, machineId: 'fixture-machine', installationId: 'installation',
    });
    harness.answer(serverId, '/v1/actions/scm.diffSummary.generate', { select: async (body, request) => {
        const admission = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        if (admission.envelope.v !== 1) throw new Error('Plain checkpoint fixture requires a plain envelope');
        const output: unknown = await network.generate({ payload: admission.envelope.input, signal: request.signal });
        return { body: { v: 1, actionId: 'scm.diffSummary.generate', requestId: admission.envelope.requestId,
            execution: { ok: true, result: output } } };
    } });
    harness.answer(serverId, ACP_CATALOG_ROWS_ROUTE_V1, { body: AcpCatalogRowReadResponseV1Schema.parse({ status: 'absent' }) });
    harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } });
    session = createSessionFixture({ id: turn.sessionId, serverId, latestTurnId: turn.turnId,
        latestTurnStatus: 'completed', metadata: { path: '/repo', host: 'fixture', homeDir: '/home/fixture', machineId: 'fixture-machine', flavor: 'codex' } });
    storage.setState({ sessions: { [session.id]: session } });
});

afterEach(() => { retireScmDiffSummaryScope(scope); network.generate.mockReset(); network.rawRpc.mockReset(); standardCleanup(); });

describe('completed checkpoint transcript prefetch', () => {
    it.each(['unset', 'saved'] as const)('preserves the %s model preference through checkpoint generation and reuses its run on replay', async preference => {
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
        const saved = preference === 'saved' ? AGENT_IDS.flatMap(agentId => buildScmDiffSummaryModelProfiles({ backendTarget: { kind: 'backend', backendId: agentId },
            models: getAgentStaticModels(agentId, { catalogOnly: true }), agentFormats: getAgentCore(agentId)?.structuredOutput?.formats }))
            .find(profile => profile.structuredOutput === 'supported') : null;
        if (preference === 'saved' && !saved?.modelSelector) throw new Error('Expected a structured model from the real Agent catalog');
        const params = { session, messages: [message()], settings: { 'scm.diffSummary.prefetch': true,
            ...(saved ? { 'scm.diffSummary.modelProfileOverride': saved.catalogId } : {}),
        }, lifetime };
        await Promise.all([prefetchCompletedCheckpointMessages(params), prefetchCompletedCheckpointMessages(params)]);
        await prefetchCompletedCheckpointMessages(params);
        expect(network.generate, JSON.stringify({ http: harness.requests.map(({ serverUrl, path }) => ({ serverUrl, path })),
            state: getScmDiffSummaryState(),
        })).toHaveBeenCalledTimes(1);
        expect(network.rawRpc).not.toHaveBeenCalled();
        expect(network.generate.mock.calls[0]?.[0]?.payload).toMatchObject({ cwd: '/repo', sessionId: session.id,
            source: { kind: 'turnCheckpoint', sessionId: session.id, turnId: turn.turnId,
                checkpointReceiptId: 'checkpoint.finalized', evidenceMode: 'checkpoint' },
            outputs: ['walkthrough'],
        });
        const request = ScmDiffSummaryGenerateInputSchema.parse(network.generate.mock.calls[0]?.[0]?.payload);
        if (preference === 'unset') expect(request).not.toHaveProperty('modelSelector');
        else expect(request.modelSelector).toEqual(saved?.modelSelector);
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
