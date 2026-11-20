import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor as createCoreActionExecutor, type ActionExecutorDeps } from './actionExecutor';
import type { AgentStartContextV1 } from '../account/settings/admitAgentStartV1';
import { ActionIdSchema } from './actionIds';
import { projectActionWorkflowSelectionInputV1 } from './executor/agentStartAdmission';
import { ExecutionRunStartRequestSchema } from '../execution/runs/startRequest';
import { AgentExecutionTargetV1Schema } from '../agents/executionTargetV1';
import { buildAcpConfigOptionOverridesV1 } from '../sessions/metadata/metadataOverridesV1';
import { createReviewRecordPortV1, ReviewRoundBindingV1Schema, type ReviewArtifactTransportV1, type ReviewRecordPortV1 } from '../reviews/reviewArtifactV1.js';
import { WorkflowRunStartRequestV1Schema } from '../workflows/actionsV1.js';
import { createInMemoryReviewRecordPortV1 } from '../reviews/reviewArtifactV1.testkit.js';
import { ReviewStartInputSchema, reviewReviewerIdForSelectionV1 } from '../reviews/reviewStart.js';
import { dispatchReviewDispatch2 } from './executor/review/dispatch.js';
import { startExecutionRunWithSelectionV1 } from './executor/executionRuns.js';
import { ScmComparisonCaptureInputSchema } from '../scm/diffSummary.js';
import { createScmCapabilities } from '../scm/index.js';

const comparisonId = 'c'.repeat(64);

function createActionExecutor(deps: ActionExecutorDeps) {
  const records = createInMemoryReviewRecordPortV1();
  // SCM and Session operations cross the Machine transport boundary. Keep their
  // real Action admission/schema path while these controls exercise reviewer options.
  const effectiveDeps: ActionExecutorDeps = { reviewRecords: () => records,
    sessionStatusGet: async ({ sessionId }) => ({ session: { id: sessionId, createdAt: 1, updatedAt: 1,
      active: true, activeAt: 1, encryption: null, path: '/repo', machineId: 'machine-1' } }),
    ...deps,
    scmActionExecute: async args => {
      if (args.actionId === 'scm.status.snapshot') return { success: true, snapshot: {
        projectKey: 'review-options', fetchedAt: 1, detail: 'facts',
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' }, capabilities: createScmCapabilities(),
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false }, hasConflicts: false, entries: [],
        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0,
          pendingAdded: 0, pendingRemoved: 0 } } };
      if (args.actionId === 'scm.diffSummary.capture') {
        const input = ScmComparisonCaptureInputSchema.parse(args.input);
        const source = input.source ?? { kind: 'workingTree' as const };
        return { success: true, comparison: { id: input.comparisonId ?? comparisonId, source,
          repository: { rootPath: input.cwd }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
          metadata: { source, sourceKey: input.comparisonId ?? comparisonId } };
      }
      if (deps.scmActionExecute) return deps.scmActionExecute(args);
      throw new Error(`Unexpected SCM operation: ${args.actionId}`);
    },
  };
  const core = createCoreActionExecutor(effectiveDeps);
  return { ...core, execute: async (...args: Parameters<typeof core.execute>) => {
    const [actionId, input, context = {}] = args;
    if (actionId !== 'review.start' || !input || typeof input !== 'object' || !('reviewRound' in input)) return core.execute(...args);
    // Native leaf controls exercise dispatch after the durable round was admitted.
    const data = ReviewStartInputSchema.parse(input);
    const result = await dispatchReviewDispatch2({ actionId, parsed: { data }, data, deps: effectiveDeps, ctx: context,
      workflowSessionScope: null, executeHostChild: (childId, childInput, childContext) => core.execute(childId, childInput, childContext),
      startExecutionRunWithSelection: (...nativeArgs) => startExecutionRunWithSelectionV1(effectiveDeps, ...nativeArgs) });
    if (!result) throw new Error('Expected native Review dispatch');
    return result;
  } };
}

// These controls exercise native leaves of an already admitted historical graph.
// New multi-reviewer authoring is covered at the workflow composition boundary.
async function admitNativeReviewRound(records: ReviewRecordPortV1, reviewId = 'native-leaf-review') {
  return records.start({ reviewId, title: 'Native reviewer options', subjectKind: 'comparison',
    sourceKind: 'workflow', comparisonId,
    reviewerIds: [reviewReviewerIdForSelectionV1(0), reviewReviewerIdForSelectionV1(1)], startedAt: 1 });
}

const workflowStartContext: AgentStartContextV1 = {
  caller: { kind: 'originless', runId: 'workflow-1', runDepth: 0 },
  baseline: { machineId: 'machine-1', directory: '/repo' },
  ledSubtreeSessionIds: [], workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'read-only',
};

describe('createActionExecutor (review.start)', () => {
  it('retains saved Workflow lineage in durable native Review admission', async () => {
    const records = createInMemoryReviewRecordPortV1();
    let binding: unknown;
    const executor = createActionExecutor({
      reviewRecords: () => records,
      executionRunCheckProtocolV2: async () => ({ ok: true }),
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      executionRunStart: async (_sessionId, input) => {
        binding = (input.intentInput as Readonly<Record<string, unknown>>).reviewRound;
        return { runId: 'native-review-run', callId: 'call', sidechainId: 'call' };
      },
    } as ActionExecutorDeps);
    const actionCaller = { kind: 'workflowRun' as const, runId: 'hunt-run-attempt-2', workflowId: 'saved-hunt',
      authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'read-only' as const } };
    await executor.execute('review.start', { sessionId: 's1', scope: 'repository', instructions: 'Find repository issues.',
      reviewers: [{ kind: 'engine', engineId: 'codex' }],
    }, { surface: 'ui', actionCaller });
    const round = ReviewRoundBindingV1Schema.parse(binding);
    expect(records.readMetadata(round.reviewId)).toMatchObject({ workflowId: 'saved-hunt', sourceKind: 'workflow' });
  });
  it.each([false, true])('records the selected pull request subject through admission (composed: %s)', async composed => {
    const records = createInMemoryReviewRecordPortV1();
    let binding: unknown;
    const executor = createActionExecutor({
      reviewRecords: () => records,
      executionRunCheckProtocolV2: async () => ({ ok: true }),
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      executionRunStart: async (_sessionId, input) => {
        // The Machine transport receives the real canonical admission binding.
        binding = (input.intentInput as Readonly<Record<string, unknown>>).reviewRound;
        return { runId: 'pr-review-run', callId: 'call', sidechainId: 'call' };
      },
      workflowAction: async invocation => {
        if (invocation.actionId !== 'workflow.run.start') throw new Error('Unexpected Workflow operation');
        binding = WorkflowRunStartRequestV1Schema.parse(invocation.input).inputs?.reviewRound;
        return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      },
    } as ActionExecutorDeps);
    const result = await executor.execute('review.start', {
      sessionId: 's1', instructions: 'Review the selected pull request.',
      reviewers: [{ kind: 'engine', engineId: 'codex' },
        ...(composed ? [{ kind: 'engine', engineId: 'codex', modelId: 'second-model' }] : [])],
      ...(composed ? { comparisonId } : {}),
      scmPullRequestReviewScope: {
        kind: 'scm_pull_request_review_scope.v1',
        account: { service: { pluginId: 'happier.scm-github', localId: 'github' }, accountId: 'account-7' },
        pullRequest: { number: 42 },
        observed: { baseSha: '1'.repeat(40), headSha: '2'.repeat(40), nativeRevision: 'pr-42', observedAtMs: 1_700_000_000_000 },
      },
    }, { surface: 'ui' });
    expect(result).toMatchObject(composed ? { ok: false, errorCode: 'content_unavailable' } : { ok: true });
    const round = ReviewRoundBindingV1Schema.parse(binding);
    expect(records.readMetadata(round.reviewId)).toMatchObject({ subjectKind: 'pull_request' });
    expect((await records.read(round.reviewId))?.rounds[0]?.comparisonId).toBe(composed ? comparisonId : undefined);
  });
  it.each(['roster', 'steps', 'people-only'] as const)('refuses an unavailable human request from %s before starting executable reviewers', async selectionSource => {
    let workflowStarts = 0;
    const records = createInMemoryReviewRecordPortV1();
    // Observe the generated identity; admission and settlement keep their real implementation.
    const starts = vi.spyOn(records, 'start');
    const executor = createActionExecutor({
      reviewRecords: () => records,
      workflowAction: async () => { workflowStarts++; return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' }; },
      reviewEnginesList: async () => { throw new Error('Reviewers must not start before the human request'); },
    } as ActionExecutorDeps);
    const engine = { kind: 'engine', engineId: 'codex' } as const;
    const person = { kind: 'person', principal: { kind: 'account', accountId: 'requested-user' }, required: true } as const;
    expect(await executor.execute('review.start', { sessionId: 's1', scope: 'repository', instructions: 'Review together.',
      reviewers: selectionSource === 'steps' ? [engine] : selectionSource === 'people-only' ? [person] : [engine, person],
      ...(selectionSource === 'steps' ? { steps: [{ kind: 'review', reviewers: [engine, person], instructions: 'Review together.' }] } : {}) },
    { surface: 'ui' })).toMatchObject({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:review.reviewers.set' });
    expect(workflowStarts).toBe(0);
    const admission = starts.mock.calls[0]?.[0];
    if (!admission) throw new Error('Expected the durable Review admission');
    expect((await records.read(admission.reviewId))?.rounds).toEqual([
      expect.objectContaining({ state: 'failed', finishedAt: expect.any(Number), runs: [] }),
    ]);
  });
  it('settles a cancelled human request without passing the aborted signal to persistence', async () => {
    const controller = new AbortController();
    let reviewId = '';
    let row: Awaited<ReturnType<ReviewArtifactTransportV1['read']>> = null;
    const records = createReviewRecordPortV1({
      read: async () => row,
      create: async input => {
        reviewId = input.artifactId;
        row = { ...input, revision: { headerVersion: 1, bodyVersion: 1 } };
        controller.abort();
        return row;
      },
      update: async input => {
        input.signal?.throwIfAborted();
        row = { ...input, revision: { headerVersion: 2, bodyVersion: 2 } };
        return { ok: true, revision: row.revision };
      },
    });
    const executor = createActionExecutor({ reviewRecords: () => records,
      workflowAction: async () => { throw new Error('Cancelled requests must not launch executable work'); },
    } as ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 's1', scope: 'repository', instructions: 'Review.',
      reviewers: [{ kind: 'person', principal: { kind: 'account', accountId: 'requested-user' }, required: true }] },
    { surface: 'ui', signal: controller.signal })).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect((await records.read(reviewId))?.rounds).toEqual([
      expect.objectContaining({ state: 'cancelled', finishedAt: expect.any(Number), runs: [] }),
    ]);
  });
  it('admits an ordered mixed engine roster once through the canonical Workflow start', async () => {
    const records = createInMemoryReviewRecordPortV1();
    const workflowStarts: unknown[] = [];
    const reviewers = [{ kind: 'engine', engineId: 'codex', modelId: 'first-model', options: { focus: 'security' } },
      { kind: 'engine', engineId: 'codex', modelId: 'second-model', options: { focus: 'correctness' } }];
    const executor = createActionExecutor({ reviewRecords: () => records,
      workflowAction: async invocation => {
        if (invocation.actionId !== 'workflow.run.start') throw new Error('Unexpected Workflow operation');
        workflowStarts.push(invocation.input);
        return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      },
    } as ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 's1', scope: 'repository', reviewers,
      instructions: 'Review independently.' }, { surface: 'ui' })).toMatchObject({
      ok: false, errorCode: 'content_unavailable',
    });
    expect(workflowStarts).toEqual([expect.objectContaining({
      source: { kind: 'inline', definition: expect.objectContaining({ blocks: expect.arrayContaining([
        expect.objectContaining({ id: 'step-1', kind: 'parallel', branches: [
          expect.objectContaining({ id: 'branch-step-1-reviewer-1' }),
          expect.objectContaining({ id: 'branch-step-1-reviewer-2' }),
        ] }),
      ]) }) },
      inputs: expect.objectContaining({ reviewInput: expect.objectContaining({ reviewers }),
        reviewRound: { reviewId: expect.any(String), roundOrdinal: 1 } }),
    })]);
    const request = WorkflowRunStartRequestV1Schema.parse(workflowStarts[0]);
    const round = ReviewRoundBindingV1Schema.parse(request.inputs?.reviewRound);
    expect((await records.read(round.reviewId))?.rounds[0]?.state).toBe('failed');
  });
  it.each([
    { runCreation: 'noRunCreated', cancel: false, expectedState: 'failed' },
    { runCreation: 'outcomeUnknown', cancel: false, expectedState: 'running' },
    { runCreation: 'noRunCreated', cancel: true, expectedState: 'cancelled' },
  ] as const)('keeps the durable round consistent with $runCreation launch evidence (cancel=$cancel)', async ({ runCreation, cancel, expectedState }) => {
    const controller = new AbortController();
    let row: Awaited<ReturnType<ReviewArtifactTransportV1['read']>> = null;
    let reviewId = '';
    const records = createReviewRecordPortV1({
      read: async () => row,
      create: async input => {
        reviewId = input.artifactId;
        row = { ...input, revision: { headerVersion: 1, bodyVersion: 1 } };
        return row;
      },
      update: async input => {
        const revision = { headerVersion: input.expectedRevision.headerVersion + 1, bodyVersion: input.expectedRevision.bodyVersion + 1 };
        row = { ...input, revision };
        return { ok: true, revision };
      },
    });
    const executor = createActionExecutor({
      reviewRecords: () => records,
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      executionRunStart: async () => {
        if (cancel) controller.abort();
        throw Object.assign(new Error('Launch acknowledgement unavailable'), {
          details: { executionRunStart: { v: 1, runCreation } },
        });
      },
    } as ActionExecutorDeps);
    const result = await executor.execute('review.start', { sessionId: 's1', reviewers: [{ kind: 'engine', engineId: 'codex' }], comparisonId, instructions: 'Review.' }, { surface: 'ui', signal: controller.signal });
    if (!cancel) expect(result).toMatchObject({ ok: true, result: { results: [{ ok: false }] } });
    expect((await records.read(reviewId))?.rounds[0]?.state).toBe(expectedState);
  });
  it('admits a durable Review before starting reviewers, including clean results', async () => {
    let row: Awaited<ReturnType<ReviewArtifactTransportV1['read']>> = null;
    const records = createReviewRecordPortV1({
      read: async () => row,
      create: async input => {
        row = { ...input, revision: { headerVersion: 1, bodyVersion: 1 } };
        return row;
      },
      update: async () => { throw new Error('No terminal update at admission'); },
    });
    let binding: unknown;
    const executor = createActionExecutor({
      reviewRecords: () => records,
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      executionRunStart: async (_sessionId, input) => {
        expect(row).not.toBeNull();
        binding = (input.intentInput as Record<string, unknown>).reviewRound;
        return { runId: 'clean-run', callId: 'call', sidechainId: 'call' };
      },
    } as ActionExecutorDeps);
    const result = await executor.execute('review.start', { sessionId: 's1', reviewers: [{ kind: 'engine', engineId: 'codex' }], comparisonId, instructions: 'Review.' }, { surface: 'ui' });
    expect(result).toMatchObject({ ok: true, result: { reviewRound: binding, results: [{ ok: true }] } });
    expect(binding).toMatchObject({ reviewId: expect.any(String), roundOrdinal: 1 });
  });
  it('consumes each review profile retention from the inventory instead of forcing follow-up support', async () => {
    const requests: ReturnType<typeof ExecutionRunStartRequestSchema.parse>[] = [];
    const records = createInMemoryReviewRecordPortV1();
    const reviewRound = await admitNativeReviewRound(records);
    const executor = createActionExecutor({ reviewRecords: () => records,
      executionRunStart: async (_sessionId, input) => {
        requests.push(ExecutionRunStartRequestSchema.parse(input));
        return { runId: `review-${requests.length}`, callId: 'call', sidechainId: 'call' };
      },
      reviewEnginesList: async () => ({ items: [
        { value: 'codex', label: 'Codex', retentionPolicy: 'resumable' },
        { value: 'coderabbit', label: 'CodeRabbit', retentionPolicy: 'ephemeral' },
      ] }),
    } as ActionExecutorDeps);
    expect(await executor.execute('review.start', {
      sessionId: 's1', reviewers: [{ kind: 'engine', engineId: 'codex' }, { kind: 'engine', engineId: 'coderabbit' }], reviewRound, comparisonId, instructions: 'Review.',
    }, { surface: 'ui' })).toMatchObject({ ok: true, result: { results: [{ ok: true }, { ok: true }] } });
    expect(requests.map(request => request.retentionPolicy)).toEqual(['resumable', 'ephemeral']);
  });
  it.each([true, false])('admits only the explicitly selected profile availability with no default reviewer (enabled: %s)', async enabled => {
    const requests: ReturnType<typeof ExecutionRunStartRequestSchema.parse>[] = [];
    const profileSourceCustody = { kind: 'managed', immutableGenerationId: 'authored-review', installSource: 'archive' } as const;
    const records = createInMemoryReviewRecordPortV1();
    const executor = createCoreActionExecutor({
      reviewRecords: () => records,
      executionRunStart: async (_sessionId, input) => {
        requests.push(ExecutionRunStartRequestSchema.parse(input));
        return { runId: 'authored-review', callId: 'call', sidechainId: 'call' };
      },
      reviewEnginesList: async () => ({ items: [], selectionItems: [
        { value: 'codex', label: 'Authored', profileId: 'authored-review', enabled, retentionPolicy: 'ephemeral' },
        { value: 'codex', label: 'Neighbor', profileId: 'neighbor-review', enabled: !enabled },
      ] }),
    } as ActionExecutorDeps);
    const result = await executor.execute('review.start', {
      sessionId: 's1', scope: 'repository', instructions: 'Review the repository.',
      reviewers: [{ kind: 'engine', engineId: 'codex', profileId: 'authored-review', profileSourceCustody }],
    }, { surface: 'ui' });
    expect(result).toMatchObject({ ok: true, result: { results: [enabled
      ? { ok: true }
      : { ok: false, errorCode: 'review_engine_unavailable' }] } });
    expect(requests.map(request => ({ profileId: request.profileId, retentionPolicy: request.retentionPolicy })))
      .toEqual(enabled ? [{ profileId: 'authored-review', retentionPolicy: 'ephemeral' }] : []);
  });
  it('uses the explicitly selected profile retention instead of the same Agent default', async () => {
    const requests: ReturnType<typeof ExecutionRunStartRequestSchema.parse>[] = [];
    const profileSourceCustody = { kind: 'managed', immutableGenerationId: 'one-shot-review', installSource: 'archive' } as const;
    const executor = createActionExecutor({
      executionRunStart: async (_sessionId, input) => {
        requests.push(ExecutionRunStartRequestSchema.parse(input));
        return { runId: 'one-shot', callId: 'call', sidechainId: 'call' };
      },
      reviewEnginesList: async () => ({
        items: [{ value: 'codex', label: 'Codex', retentionPolicy: 'resumable' }],
        selectionItems: [{ value: 'codex', label: 'One shot', profileId: 'one-shot-review', retentionPolicy: 'ephemeral' }],
      }),
    } as ActionExecutorDeps);
    expect(await executor.execute('review.start', {
      sessionId: 's1', reviewers: [{ kind: 'engine', engineId: 'codex', profileId: 'one-shot-review', profileSourceCustody }],
      comparisonId, instructions: 'Review.',
    }, { surface: 'ui' })).toMatchObject({ ok: true });
    expect(requests.map(request => request.retentionPolicy)).toEqual(['ephemeral']);
  });
  it.each([false, true])('starts separate narration for selected ephemeral or duplicate reviewer instances (duplicate: %s)', async duplicate => {
    const records = createInMemoryReviewRecordPortV1();
    const reviewRound = await admitNativeReviewRound(records);
    const starts: ReturnType<typeof ExecutionRunStartRequestSchema.parse>[] = [];
    const narrationInputs: unknown[] = [];
    const profileSourceCustody = { kind: 'managed', immutableGenerationId: 'selected-review', installSource: 'archive' } as const;
    const executor = createActionExecutor({ reviewRecords: () => records,
      reviewEnginesList: async () => ({
        items: [{ value: 'codex', label: 'Default', retentionPolicy: 'resumable', capabilities: { structuredNarration: true } }],
        selectionItems: [{ value: 'codex', label: 'Selected', profileId: 'selected-profile',
          retentionPolicy: duplicate ? 'resumable' : 'ephemeral', capabilities: { structuredNarration: true } }],
      }),
      executionRunStart: async (_sessionId, input) => {
        starts.push(ExecutionRunStartRequestSchema.parse(input));
        return { runId: `review-${starts.length}`, callId: `call-${starts.length}`, sidechainId: `call-${starts.length}` };
      },
      executionRunAction: async (_sessionId, input) => {
        narrationInputs.push(input);
        return { runId: 'separate-narrator', mode: 'seeded_narrator', state: 'collecting' };
      },
    } as ActionExecutorDeps);
    const reviewer = { kind: 'engine' as const, engineId: 'codex', profileId: 'selected-profile', profileSourceCustody };
    expect(await executor.execute('review.start', { sessionId: 's1', reviewRound,
      reviewers: duplicate ? [reviewer, reviewer] : [reviewer], instructions: 'Review.',
      comparisonId, outputs: ['walkthrough'], narrator: { engineId: 'codex' },
    }, { surface: 'ui' })).toMatchObject({ ok: true, result: { narration: { runId: 'separate-narrator' } } });
    expect(starts.map(start => start.runClass)).toEqual(duplicate ? ['bounded', 'bounded'] : ['bounded']);
    expect(starts.map(start => start.retentionPolicy)).toEqual(duplicate ? ['resumable', 'resumable'] : ['ephemeral']);
    expect(narrationInputs).toEqual([{ runId: 'review-1', actionId: 'review.walkthrough', input: {
      reviewRunIds: duplicate ? ['review-1', 'review-2'] : ['review-1'], comparisonId, narrator: { engineId: 'codex' },
    } }]);
  });
  it.each([undefined, 'agentDefault'] as const)('preserves Session Review inheritance and explicit Account-default choice (%s)', async childSelection => {
    const requests: ReturnType<typeof ExecutionRunStartRequestSchema.parse>[] = [];
    const sessionConfigOptionOverrides = buildAcpConfigOptionOverridesV1({
      updatedAt: 1,
      overrides: { reasoning_effort: { updatedAt: 1, value: 'low' } },
    });
    const records = createInMemoryReviewRecordPortV1();
    const reviewRound = await admitNativeReviewRound(records);
    const executor = createActionExecutor({ reviewRecords: () => records,
      // The machine transport is the boundary; the Action normalization, fanout
      // and receiver schema stay real so dropping the field changes the result.
      executionRunStart: async (_sessionId, input) => {
        AgentExecutionTargetV1Schema.parse(input.backendTarget);
        requests.push(ExecutionRunStartRequestSchema.parse(input));
        return { runId: 'review-1', callId: 'review-call', sidechainId: 'review-call' };
      },
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }] }),
    } as ActionExecutorDeps);
    expect(await executor.execute('review.start', {
      sessionId: 's1', reviewers: [{ kind: 'engine', engineId: 'codex' }, { kind: 'engine', engineId: 'claude' }], reviewRound, comparisonId, instructions: 'Review.',
      sessionConfigOptionOverrides,
      ...(childSelection ? { childSelection } : {}),
    }, { surface: 'ui' })).toMatchObject({ ok: true, result: { results: [{ ok: true }, { ok: true }] } });
    expect(requests.map(request => request.childSelection)).toEqual([childSelection, childSelection]);
    expect(requests.map(request => request.sessionConfigOptionOverrides)).toEqual([
      sessionConfigOptionOverrides, sessionConfigOptionOverrides,
    ]);
  });

  it.each([
    { selected: 'openai-codex:group:pool-X', expected: { connectedServices: { v: 2, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: 'pool-X' },
    } } } },
    { selected: 'native', expected: { connectedServices: null } },
    { selected: 'openai-codex:native', expected: { connectedServices: { v: 2, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'native' },
    } } } },
    { selected: 'openai-codex', expected: { connectedServicesDefaultServiceIds: ['happier.agent.codex/openai-codex'] } },
  ])('preserves Workflow-selected $selected through admission to the Run input', async ({ selected, expected }) => {
    const executionRunStart = vi.fn<ActionExecutorDeps['executionRunStart']>(async (_sessionId, input) => {
      // The dispatched request crosses the machine transport boundary; validate with its real receiver schema.
      ExecutionRunStartRequestSchema.parse(input);
      return { runId: 'review-1', callId: 'review-call', sidechainId: 'review-call' };
    });
    const executor = createActionExecutor({ executionRunStart,
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
    } as ActionExecutorDeps);
    const input = projectActionWorkflowSelectionInputV1('review.start', {
      sessionId: 's1', reviewers: [{ kind: 'engine', engineId: 'codex' }], comparisonId, instructions: 'Review.',
    }, { connectedServices: selected === 'native' ? null : selected === 'openai-codex:group:pool-X'
      ? { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
          source: 'connected', selection: 'group', groupId: 'pool-X',
        } } }
      : undefined });
    if (selected !== 'native' && selected !== 'openai-codex:group:pool-X') input.connectedServices = selected;
    expect(await executor.execute('review.start', input, { surface: 'ui' })).toMatchObject({
      ok: true, result: { results: [{ ok: true }] },
    });
    expect(executionRunStart.mock.calls[0]?.[1]).toMatchObject(expected);
    expect(executionRunStart.mock.calls[0]?.[1]).not.toHaveProperty('childSelection');
  });

  it('applies per-target Connected-services over a blanket choice and refuses malformed fan-out before any start', async () => {
    const requests: unknown[] = [];
    const executionRunStart: ActionExecutorDeps['executionRunStart'] = async (_session, input) => {
      requests.push(ExecutionRunStartRequestSchema.parse(input));
      return { runId: 'review-1', callId: 'review-call', sidechainId: 'review-call' };
    };
    const records = createInMemoryReviewRecordPortV1();
    const reviewRound = await admitNativeReviewRound(records);
    const executor = createActionExecutor({ reviewRecords: () => records, executionRunStart,
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }] }),
    } as ActionExecutorDeps);
    const input = { sessionId: 's1', reviewers: [{ kind: 'engine', engineId: 'codex', connectedServices: 'openai-codex:group:pool-X' },
        { kind: 'engine', engineId: 'claude', connectedServices: 'native' }], reviewRound, comparisonId, instructions: 'Review.',
      connectedServices: 'native' };
    expect(await executor.execute('review.start', input, { surface: 'ui' })).toMatchObject({ ok: true });
    expect(requests).toMatchObject([
      { connectedServices: { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
        source: 'connected', selection: 'group', groupId: 'pool-X',
      } } } },
      { connectedServices: null },
    ]);
    requests.length = 0;
    expect(await executor.execute('review.start', { ...input,
      reviewers: [{ kind: 'engine', engineId: 'codex', connectedServices: 'native' },
        { kind: 'engine', engineId: 'claude', connectedServices: 'unknown-service:group:pool-X' }],
    }, { surface: 'ui' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(requests).toEqual([]);
  });

  const narrationInventory = { items: [
    { value: 'codex', label: 'Codex', capabilities: { structuredNarration: true } },
    { value: 'claude', label: 'Claude', capabilities: { structuredNarration: true } },
    { value: 'coderabbit', label: 'CodeRabbit', capabilities: { structuredNarration: false } },
  ] };
  it('keeps detached review narration and explanation on the exact Machine without inheriting a default Session', async () => {
    const executionRunStart = vi.fn<ActionExecutorDeps['executionRunStart']>(async () => ({ runId: 'review-1', callId: 'call-1', sidechainId: 'call-1' }));
    const executionRunAction = vi.fn<ActionExecutorDeps['executionRunAction']>(async (_sessionId, request) => request.actionId === 'review.explain_findings'
      ? { ok: true, result: { refinement: { actionId: 'scm.diffSummary.refine', input: {
        cwd: '/repo', resultId: 'result-1', expectedRevision: 2, output: 'walkthrough', stopIds: ['stop-1'], instructions: 'Explain selected finding.',
      } } } } : { ok: true, result: { runId: 'narrator-1', state: 'collecting' } });
    const refinements: unknown[] = [];
    const records = createInMemoryReviewRecordPortV1();
    const reviewRound = await admitNativeReviewRound(records);
    const executor = createActionExecutor({ reviewRecords: () => records, executionRunStart, executionRunAction,
      executionRunCheckProtocolV2: async () => ({ ok: true }), reviewEnginesList: async () => narrationInventory,
      scmActionExecute: async ({ input, context }) => {
        refinements.push({ input, sessionId: context.defaultSessionId, machineId: context.executionRunTargetMachineId });
        return { success: false, errorCode: 'revision_conflict', error: 'Saved result changed', latestRevision: 3 };
      },
    } as ActionExecutorDeps);
    const context = { surface: 'ui' as const, defaultSessionId: 'unrelated-session', serverId: 'home-1',
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } } };
    const started = await executor.execute('review.start', { target: { kind: 'detached' }, cwd: '/untrusted-root', reviewers: [{ kind: 'engine', engineId: 'codex' }, { kind: 'engine', engineId: 'claude' }], reviewRound,
      instructions: 'Review.', outputs: ['walkthrough'], comparisonId }, context);
    expect(started).toMatchObject({ ok: true, result: { sessionId: null, narration: { runId: 'narrator-1' } } });
    expect(executionRunStart.mock.calls[0]).toMatchObject([null, { cwd: '/repo' }, { targetMachineId: 'machine-1' }]);
    expect(executionRunAction.mock.calls[0]).toMatchObject([null, { actionId: 'review.walkthrough' }, { targetMachineId: 'machine-1' }]);
    expect(await executor.execute('review.walkthrough', { target: { kind: 'detached' }, runId: 'review-1', comparisonId }, context))
      .toMatchObject({ ok: true });
    expect(await executor.execute('review.explain_findings', { target: { kind: 'detached' }, runId: 'review-1', cwd: '/repo',
      resultId: 'result-1', expectedRevision: 2, findingIds: [{ runId: 'review-1', findingId: 'finding-1' }] }, context))
      .toMatchObject({ ok: true, result: { success: false, errorCode: 'revision_conflict' } });
    expect(executionRunAction.mock.calls.every(call => call[0] === null && call[2]?.targetMachineId === 'machine-1')).toBe(true);
    expect(refinements).toMatchObject([{ input: { cwd: '/repo' }, sessionId: undefined, machineId: 'machine-1' }]);
    executionRunAction.mockClear();
    expect(await executor.execute('review.walkthrough', { target: { kind: 'detached' }, sessionId: 'private-session',
      runId: 'review-1', comparisonId }, context)).toMatchObject({ ok: false });
    expect(await executor.execute('review.walkthrough', { runId: 'review-1', comparisonId }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'session_not_selected' });
    expect(executionRunAction).not.toHaveBeenCalled();
  });
  it('offers capable narrators without hiding findings-only reviewer choices', async () => {
    const executor = createActionExecutor({ reviewEnginesList: async () => narrationInventory } as ActionExecutorDeps);
    const narrator = await executor.execute('action.options.resolve', {
      actionId: 'review.start', fieldPath: 'narrator.engineId', sessionId: 's1',
    }, { surface: 'ui' });
    expect(narrator).toMatchObject({ ok: true, result: { options: [
      { value: 'codex' }, { value: 'claude' },
    ] } });
    const reviewers = await executor.execute('action.options.resolve', {
      actionId: 'review.start', fieldPath: 'reviewers', sessionId: 's1',
    }, { surface: 'ui' });
    expect(reviewers).toMatchObject({ ok: true, result: { options: [
      { value: 'codex' }, { value: 'claude' }, { value: 'coderabbit' },
    ] } });
  });
  it.each([true, false])('retains the selected capable reviewer for narration without a default profile (default present: %s)', async defaultPresent => {
    const executionRunStart = vi.fn<ActionExecutorDeps['executionRunStart']>(async () => ({ runId: 'review-1', callId: 'call-1', sidechainId: 'call-1' }));
    const executionRunAction = vi.fn<ActionExecutorDeps['executionRunAction']>(async () => ({}));
    const profileSourceCustody = { kind: 'managed', immutableGenerationId: 'selected-narrator', installSource: 'archive' } as const;
    const executor = createActionExecutor({ executionRunStart, executionRunAction,
      reviewEnginesList: async () => ({ items: defaultPresent ? narrationInventory.items : [], selectionItems: [
        { value: 'codex', label: 'Selected narrator', profileId: 'selected-narrator', retentionPolicy: 'resumable',
          capabilities: { structuredNarration: true } },
      ] }) } as ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 's1', reviewers: [
      { kind: 'engine', engineId: 'codex', profileId: 'selected-narrator', profileSourceCustody },
    ], instructions: 'Review.',
      outputs: ['walkthrough'], comparisonId }, { surface: 'ui' })).toMatchObject({
      ok: true, result: { narration: { runId: 'review-1', state: 'collecting' } },
    });
    expect(executionRunStart.mock.calls[0]?.[1]).toMatchObject({ runClass: 'long_lived', profileId: 'selected-narrator', profileSourceCustody,
      intentInput: { outputs: ['walkthrough'], comparisonId, narrator: { engineId: 'codex' } } });
    expect(executionRunAction).not.toHaveBeenCalled();
  });
  it('fans out bounded reviews then admits one narrator from only confirmed runs and launch provenance', async () => {
    const executionRunStart = vi.fn<ActionExecutorDeps['executionRunStart']>(async (_session, input) =>
      input.backendTarget?.kind === 'agent' && input.backendTarget.identity.pluginId === 'happier.agent.claude'
        && input.backendTarget.identity.localId === 'claude'
        ? { ok: false, errorCode: 'engine_failed', error: 'Engine failed' }
        : { runId: 'review-1', callId: 'call-1', sidechainId: 'call-1' });
    const executionRunAction = vi.fn<ActionExecutorDeps['executionRunAction']>(async () => ({ ok: true, data: { ok: true, result: {
      runId: 'narrator-1', comparisonId, mode: 'seeded_narrator', state: 'collecting',
    } } }));
    const records = createInMemoryReviewRecordPortV1();
    const reviewRound = await admitNativeReviewRound(records);
    const executor = createActionExecutor({ reviewRecords: () => records, executionRunStart, executionRunAction,
      reviewEnginesList: async () => narrationInventory } as ActionExecutorDeps);
    const result = await executor.execute('review.start', { sessionId: 's1', reviewers: [{ kind: 'engine', engineId: 'codex' }, { kind: 'engine', engineId: 'claude' }], reviewRound, instructions: 'Review.',
      outputs: ['walkthrough'], comparisonId }, { surface: 'ui' });
    expect(result).toMatchObject({ ok: true, result: { narration: { runId: 'narrator-1', state: 'collecting' } } });
    expect(executionRunStart.mock.calls.every((call) => call[1].runClass === 'bounded')).toBe(true);
    expect(executionRunStart.mock.calls.every((call) => call[1].intentInput?.outputs === undefined)).toBe(true);
    expect(executionRunAction.mock.calls).toHaveLength(1);
    expect(executionRunAction.mock.calls[0]?.slice(0, 2)).toEqual(['s1', { runId: 'review-1', actionId: 'review.walkthrough', input: {
      reviewRunIds: ['review-1'], comparisonId, narrator: { engineId: 'codex' },
      launchFailures: [{ engineId: 'claude', errorCode: 'engine_failed', error: 'Engine failed' }],
    } }]);
  });
  it('preserves explicit narrator model selection without replacing the original reviewer model', async () => {
    const executionRunStart = vi.fn<ActionExecutorDeps['executionRunStart']>(async () => ({ runId: 'review-1', callId: 'call-1', sidechainId: 'call-1' }));
    const executionRunAction = vi.fn<ActionExecutorDeps['executionRunAction']>(async () => ({ ok: true, result: {
      runId: 'narrator-1', comparisonId, mode: 'seeded_narrator', state: 'collecting',
    } }));
    const executor = createActionExecutor({ executionRunStart, executionRunAction,
      reviewEnginesList: async () => narrationInventory } as ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 's1', reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'Review.',
      modelId: 'review-model', outputs: ['walkthrough'], comparisonId,
      narrator: { engineId: 'codex', modelId: 'narration-model' } }, { surface: 'ui' }))
      .toMatchObject({ ok: true, result: { narration: { runId: 'narrator-1' } } });
    expect(executionRunStart.mock.calls[0]?.[1]).toMatchObject({ runClass: 'bounded', modelId: 'review-model',
      reviewOutputSelection: { outputs: ['walkthrough'], narrator: { engineId: 'codex', modelId: 'narration-model' } } });
    expect(executionRunAction.mock.calls[0]?.[1].input).toMatchObject({ narrator: { engineId: 'codex', modelId: 'narration-model' } });
  });
  it.each([
    { reviewers: [{ kind: 'engine', engineId: 'coderabbit' }], comparisonId },
    { reviewers: [{ kind: 'engine', engineId: 'codex' }], comparisonId, narrator: { engineId: 'coderabbit' } },
  ])('rejects invalid narration before any reviewer starts: %j', async (selection) => {
    const executionRunStart = vi.fn<ActionExecutorDeps['executionRunStart']>(async () => ({}));
    const executor = createActionExecutor({ executionRunStart, reviewEnginesList: async () => narrationInventory } as ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 's1', instructions: 'Review.', outputs: ['walkthrough'],
      ...selection }, { surface: 'ui' })).toMatchObject({ ok: false });
    expect(executionRunStart).not.toHaveBeenCalled();
  });
  it('keeps failed reviewer launches truthful and does not create narration without a confirmed run', async () => {
    const executionRunAction = vi.fn<ActionExecutorDeps['executionRunAction']>(async () => ({}));
    const records = createInMemoryReviewRecordPortV1();
    const reviewRound = await admitNativeReviewRound(records);
    const executor = createActionExecutor({ reviewRecords: () => records, executionRunAction,
      executionRunStart: async () => ({ ok: false, errorCode: 'engine_failed', error: 'Engine failed' }),
      reviewEnginesList: async () => narrationInventory } as ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 's1', reviewers: [{ kind: 'engine', engineId: 'codex' }, { kind: 'engine', engineId: 'claude' }], reviewRound, instructions: 'Review.',
      outputs: ['walkthrough'], comparisonId }, { surface: 'ui' })).toMatchObject({
      ok: true, result: { results: [{ ok: false }, { ok: false }], narration: { state: 'failed' } },
    });
    expect(executionRunAction).not.toHaveBeenCalled();
  });
  it('routes finished-review narration and targeted explanation through the existing Run Action authority', async () => {
    const executionRunAction = vi.fn<ActionExecutorDeps['executionRunAction']>(async (_sessionId, request) => request.actionId === 'review.explain_findings'
      ? { ok: true, result: { refinement: { actionId: 'scm.diffSummary.refine', input: {
        cwd: '/repo', resultId: 'result-1', expectedRevision: 2, output: 'walkthrough', stopIds: ['stop-1'], instructions: 'Explain selected finding.',
      } } } } : { ok: true, runId: 'narrator-1' });
    const executor = createActionExecutor({ executionRunAction,
      scmActionExecute: async () => ({ success: false, errorCode: 'revision_conflict', error: 'Saved result changed', latestRevision: 3 }),
    } as ActionExecutorDeps);
    const walkthrough = await executor.execute(ActionIdSchema.parse('review.walkthrough'), {
      sessionId: 's1', runId: 'review-1', comparisonId,
    }, { surface: 'cli' });
    expect(walkthrough).toMatchObject({ ok: true });
    expect(executionRunAction.mock.calls[0]?.slice(0, 2)).toEqual(['s1', { runId: 'review-1', actionId: 'review.walkthrough',
      input: { reviewRunIds: ['review-1'], comparisonId } }]);
    const explanation = await executor.execute(ActionIdSchema.parse('review.explain_findings'), {
      runId: 'review-1', cwd: '/repo', resultId: 'result-1', expectedRevision: 2,
      findingIds: [{ runId: 'review-1', findingId: 'finding-1' }],
    }, { surface: 'mcp', defaultSessionId: 's1' });
    expect(explanation).toMatchObject({ ok: true, result: { success: false, errorCode: 'revision_conflict', latestRevision: 3 } });
    expect(executionRunAction.mock.calls[1]?.slice(0, 2)).toEqual(['s1', { runId: 'review-1', actionId: 'review.explain_findings', input: {
      reviewRunIds: ['review-1'], cwd: '/repo', resultId: 'result-1', expectedRevision: 2,
      findingIds: [{ runId: 'review-1', findingId: 'finding-1' }],
    } }]);
  });
  it('stamps one fresh group on every engine Run, including detached Workflow fanout', async () => {
    const starts: Array<Record<string, unknown>> = [];
    const records = createInMemoryReviewRecordPortV1();
    const reviewRound = await admitNativeReviewRound(records);
    const executor = createActionExecutor({ reviewRecords: () => records,
      executionRunStart: async (_sessionId, input) => {
        starts.push(input);
        return { runId: `run-${starts.length}`, callId: `call-${starts.length}`, sidechainId: `call-${starts.length}` };
      },
      executionRunCheckProtocolV2: async () => ({ ok: true }),
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }] }),
    } as ActionExecutorDeps);
    const input = { reviewers: [{ kind: 'engine', engineId: 'codex' }, { kind: 'engine', engineId: 'claude' }], reviewRound, comparisonId, instructions: 'Review.', display: { groupId: 'caller-forged' } };
    await executor.execute('review.start', { ...input, sessionId: 's1' }, { surface: 'ui' });
    await executor.execute('review.start', { ...input, reviewRound: await admitNativeReviewRound(records, 'other-native-review') }, {
      surface: 'agent', defaultSessionId: 'origin-session', executionRunTargetMachineId: 'machine-1',
      agentStartContext: workflowStartContext,
      externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } },
      actionCaller: { kind: 'workflowRun', runId: 'workflow-1', authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'read-only' } },
    });
    expect(starts).toHaveLength(4);
    const groups = starts.map((start) => (start.display as { groupId?: string } | undefined)?.groupId);
    expect(groups[0]).toEqual(expect.any(String));
    expect(groups[0]).not.toBe('caller-forged');
    expect(groups[1]).toBe(groups[0]);
    expect(groups[2]).toEqual(expect.any(String));
    expect(groups[3]).toBe(groups[2]);
    expect(groups[2]).not.toBe(groups[0]);
  });
  it.each([true, false])('forwards caller notification %s to every launched review engine', async (notifyParentOnCompletion) => {
    const executionRunStart = vi.fn<ActionExecutorDeps['executionRunStart']>(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const records = createInMemoryReviewRecordPortV1();
    const reviewRound = await admitNativeReviewRound(records);
    const executor = createActionExecutor({ reviewRecords: () => records,
      executionRunStart,
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }] }),
    } as ActionExecutorDeps);

    const result = await executor.execute('review.start', {
      sessionId: 's1', reviewers: [{ kind: 'engine', engineId: 'codex' }, { kind: 'engine', engineId: 'claude' }], reviewRound, comparisonId, instructions: 'Review this.', notifyParentOnCompletion,
    }, { surface: 'ui', defaultSessionId: 's1' });

    expect(result.ok).toBe(true);
    expect(executionRunStart.mock.calls).toHaveLength(2);
    for (const call of executionRunStart.mock.calls) {
      expect(call[0]).toBe('s1');
      expect(call[1]).toMatchObject({ notifyParentOnCompletion, retentionPolicy: 'resumable' });
    }
  });

  it.each([undefined, { kind: 'detached' as const }, { sessionId: 'origin-session' }])('starts an originless workflow review with target %j and carries trusted workflow identity outside input', async (target) => {
    // Execution start/capability adapters are the machine transport boundary.
    const executionRunStart = vi.fn<ActionExecutorDeps['executionRunStart']>(async () => ({ runId: 'review-1', callId: 'call-review', sidechainId: 'call-review' }));
    const reviewEnginesList = vi.fn<ActionExecutorDeps['reviewEnginesList']>(async () => ({ items: [{ value: 'codex', label: 'Codex' }] }));
    const executor = createActionExecutor({
      executionRunStart,
      executionRunCheckProtocolV2: async () => ({ ok: true }),
      reviewEnginesList,
    } as ActionExecutorDeps);
    const result = await executor.execute('review.start', {
      ...(target && 'sessionId' in target ? target : target ? { target } : {}), reviewers: [{ kind: 'engine', engineId: 'codex' }], comparisonId, instructions: 'Review the workspace.',
      cwd: '/caller/other-checkout',
      workflowRunId: 'forged-input-id',
    }, {
      surface: 'agent', defaultSessionId: 'origin-session', executionRunTargetMachineId: 'machine-1',
      agentStartContext: workflowStartContext,
      actionRequestId: 'review-request',
      externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } },
      actionCaller: { kind: 'workflowRun', runId: 'workflow-1', authorization: {
        principal: { kind: 'host' }, admittedPermissionCeiling: 'read-only',
      } },
    });
    expect(result).toMatchObject({ ok: true, result: { intent: 'review', sessionId: null } });
    expect(reviewEnginesList.mock.calls[0]?.[0]).toEqual({ sessionId: null, machineId: 'machine-1', includeDisabled: false, scope: 'worktree' });
    expect(executionRunStart).toHaveBeenCalledWith(null, expect.objectContaining({ intent: 'review', cwd: '/repo' }),
      expect.objectContaining({ workflowRunId: 'workflow-1', targetMachineId: 'machine-1', actionRequestId: 'review-request',
        actionCaller: expect.objectContaining({ kind: 'workflowRun', runId: 'workflow-1' }) }));
  });

  it('preserves a Saved Secret overlay on a current-session review through the canonical Run', async () => {
    const executionRunStart = vi.fn<ActionExecutorDeps['executionRunStart']>(async () => ({ runId: 'run-review', callId: 'call-review', sidechainId: 'call-review' }));
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const }));
    const executor = createActionExecutor({
      executionRunStart,
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      executionRunCheckProtocolV2,
    } as ActionExecutorDeps);

    await expect(executor.execute('review.start', {
      sessionId: 's1',
      reviewers: [{ kind: 'engine', engineId: 'codex' }], comparisonId,
      instructions: 'Review this.',
      runLocation: 'current_session',
      secretReferenceOverlay: {
        v: 1,
        bindings: { OPENAI_API_KEY: { ref: 'happier:shared-secret:v1:shared-1', revision: 7 } },
      },
    }, { surface: 'ui', defaultSessionId: 's1' })).resolves.toMatchObject({
      ok: true,
      result: { results: [{ key: reviewReviewerIdForSelectionV1(0), ok: true, result: { runId: 'run-review' } }] },
    });
    expect(executionRunCheckProtocolV2).toHaveBeenCalled();
    expect(executionRunStart).toHaveBeenCalledWith('s1', expect.objectContaining({
      secretReferenceOverlay: { v: 1, bindings: { OPENAI_API_KEY: { ref: 'happier:shared-secret:v1:shared-1', revision: 7 } } },
    }), expect.any(Object));
  });

  it('rejects an invalid run payload rather than reporting an inline success', async () => {
    const executor = createActionExecutor({
      executionRunStart: async () => new Map([['unexpected', true]]),
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
    } as ActionExecutorDeps);

    await expect(executor.execute(
      'review.start',
      {
        sessionId: 's1',
        reviewers: [{ kind: 'engine', engineId: 'codex' }], comparisonId,
        instructions: 'Review this.',
        runLocation: 'current_session',
      },
      { surface: 'ui', defaultSessionId: 's1' },
    )).resolves.toMatchObject({
      ok: true,
      result: { results: [{ key: reviewReviewerIdForSelectionV1(0), ok: false }] },
    });
  });

  it('routes current-session reviews through the materializing bounded Run owner', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));

    const executor = createActionExecutor({
      executionRunStart,
      executionRunList: async () => ({}),
      executionRunGet: async () => ({}),
      detachedExecutionRunSend: async () => ({}),
      executionRunStop: async () => ({}),
      executionRunAction: async () => ({}),
      executionRunWait: async () => ({}),
      sessionOpen: async () => ({}),
      sessionFork: async () => ({}),
      sessionRollback: async () => ({}),
      sessionSpawnNew: async () => ({}),
      pathsListRecent: async () => ({ items: [] }),
      machinesList: async () => ({ items: [] }),
      serversList: async () => ({ items: [] }),
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      agentsBackendsList: async () => ({ items: [] }),
      agentsModelsList: async () => ({ items: [] }),
      sessionSendMessage: async () => ({}),
      sessionPermissionRespond: async () => ({}),
      sessionUserActionAnswer: async () => ({}),
      sessionModeSet: async () => ({}),
      sessionModesList: async () => ({ items: [] }),
      sessionTargetPrimarySet: async () => ({}),
      sessionTargetTrackedSet: async () => ({}),
      sessionList: async () => ({}),
      sessionActivityGet: async () => ({}),
      sessionRecentMessagesGet: async () => ({}),
      daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
      daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
      daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
      resetGlobalVoiceAgent: async () => {},
    });

    await expect(executor.execute(
      'review.start',
      {
        sessionId: 's1',
        reviewers: [{ kind: 'engine', engineId: 'codex' }], comparisonId,
        instructions: 'Review this.',
        runLocation: 'current_session',
        changeType: 'uncommitted',
        base: { kind: 'none' },
      },
      { surface: 'ui', defaultSessionId: 's1' },
    )).resolves.toMatchObject({
      ok: true,
      result: { intent: 'review', sessionId: 's1', results: [{ key: reviewReviewerIdForSelectionV1(0), ok: true, result: { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' } }] },
    });

    expect(executionRunStart).toHaveBeenCalledWith('s1', expect.objectContaining({
      intent: 'review', runClass: 'bounded',
      instructions: 'Review this.',
      backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    }), { approvalProfileTeamOrGroupDerived: false });
  });

  it('passes the clamped agent permission mode to current-session review Runs', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));

    const executor = createActionExecutor({
      executionRunStart,
      executionRunList: async () => ({}),
      executionRunGet: async () => ({}),
      detachedExecutionRunSend: async () => ({}),
      executionRunStop: async () => ({}),
      executionRunAction: async () => ({}),
      executionRunWait: async () => ({}),
      sessionOpen: async () => ({}),
      sessionFork: async () => ({}),
      sessionRollback: async () => ({}),
      sessionSpawnNew: async () => ({}),
      pathsListRecent: async () => ({ items: [] }),
      machinesList: async () => ({ items: [] }),
      serversList: async () => ({ items: [] }),
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      agentsBackendsList: async () => ({ items: [] }),
      agentsModelsList: async () => ({ items: [] }),
      sessionSendMessage: async () => ({}),
      sessionPermissionRespond: async () => ({}),
      sessionUserActionAnswer: async () => ({}),
      sessionModeSet: async () => ({}),
      sessionModesList: async () => ({ items: [] }),
      sessionTargetPrimarySet: async () => ({}),
      sessionTargetTrackedSet: async () => ({}),
      sessionList: async () => ({}),
      sessionActivityGet: async () => ({}),
      sessionRecentMessagesGet: async () => ({}),
      daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
      daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
      daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
      resetGlobalVoiceAgent: async () => {},
    });

    const res = await executor.execute(
      'review.start',
      {
        sessionId: 's1',
        reviewers: [{ kind: 'engine', engineId: 'codex' }], comparisonId,
        instructions: 'Review this.',
        runLocation: 'current_session',
        permissionMode: 'safe-yolo',
        changeType: 'uncommitted',
        base: { kind: 'none' },
      },
      {
        surface: 'agent',
        defaultSessionId: 's1',
        callerPermissionMode: 'safe-yolo',
        agentStartContext: {
          caller: { kind: 'session', sessionId: 's1', starterDepth: 0, turnDepth: 0 },
          baseline: { machineId: 'machine-1', directory: '/repo' },
          ledSubtreeSessionIds: [], workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'safe-yolo',
        },
      },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalledWith('s1', expect.objectContaining({ permissionMode: 'workspace_write' }), expect.any(Object));
  });

  it('starts a qualified plugin Agent review in the genuine Session scope', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const pluginAgentId = 'acme.review/reviewer';

    const executor = createActionExecutor({
      executionRunStart,
      executionRunList: async () => ({}),
      executionRunGet: async () => ({}),
      detachedExecutionRunSend: async () => ({}),
      executionRunStop: async () => ({}),
      executionRunAction: async () => ({}),
      executionRunWait: async () => ({}),
      sessionOpen: async () => ({}),
      sessionFork: async () => ({}),
      sessionRollback: async () => ({}),
      sessionSpawnNew: async () => ({}),
      pathsListRecent: async () => ({ items: [] }),
      machinesList: async () => ({ items: [] }),
      serversList: async () => ({ items: [] }),
      reviewEnginesList: async () => ({ items: [{ value: pluginAgentId, label: 'Acme Reviewer' }] }),
      agentsBackendsList: async () => ({ items: [] }),
      agentsModelsList: async () => ({ items: [] }),
      sessionSendMessage: async () => ({}),
      sessionPermissionRespond: async () => ({}),
      sessionUserActionAnswer: async () => ({}),
      sessionModeSet: async () => ({}),
      sessionModesList: async () => ({ items: [] }),
      sessionTargetPrimarySet: async () => ({}),
      sessionTargetTrackedSet: async () => ({}),
      sessionList: async () => ({}),
      sessionActivityGet: async () => ({}),
      sessionRecentMessagesGet: async () => ({}),
      daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
      daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
      daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
      resetGlobalVoiceAgent: async () => {},
    });

    const res = await executor.execute(
      'review.start' as any,
      {
        sessionId: 's1',
        reviewers: [{ kind: 'engine', engineId: pluginAgentId }], comparisonId,
        instructions: 'Review this.',
        permissionMode: 'read_only',
        changeType: 'committed',
        base: { kind: 'none' },
      },
      { surface: 'ui', defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        intent: 'review',
        backendTarget: { kind: 'agent', identity: { pluginId: 'acme.review', localId: 'reviewer' } },
        retentionPolicy: 'resumable',
        ioMode: 'streaming',
        intentInput: expect.objectContaining({ engineId: pluginAgentId }),
      }),
      { approvalProfileTeamOrGroupDerived: false },
    );
  });

  it('starts a configured ACP review using its concrete inventory target', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_acp', callId: 'call_acp', sidechainId: 'call_acp' }));
    const targetKey = 'backend:review-bot:configured:review-bot';
    const executor = createActionExecutor({
      executionRunStart,
      reviewEnginesList: async () => ({ items: [{ value: targetKey, label: 'Review Bot' }] }),
    } as ActionExecutorDeps);

    const result = await executor.execute('review.start', {
      sessionId: 's1', reviewers: [{ kind: 'engine', engineId: targetKey }], comparisonId, instructions: 'Review this.',
    }, { surface: 'ui', defaultSessionId: 's1' });

    expect(result).toMatchObject({
      ok: true,
      result: { results: [{ key: reviewReviewerIdForSelectionV1(0), ok: true }] },
    });
    expect(executionRunStart).toHaveBeenCalledWith('s1', expect.objectContaining({
      intent: 'review',
      backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' },
        definitionId: 'review-bot' },
      retentionPolicy: 'resumable',
    }), { approvalProfileTeamOrGroupDerived: false });
  });

  it('marks malformed execution-run start payloads as failed fanout items', async () => {
    const executionRunStart = vi.fn(async () => ({ error: 'Unable to resolve a default base branch for CodeRabbit review.' }));

    const executor = createActionExecutor({
      executionRunStart,
      executionRunList: async () => ({}),
      executionRunGet: async () => ({}),
      detachedExecutionRunSend: async () => ({}),
      executionRunStop: async () => ({}),
      executionRunAction: async () => ({}),
      executionRunWait: async () => ({}),
      sessionOpen: async () => ({}),
      sessionFork: async () => ({}),
      sessionRollback: async () => ({}),
      sessionSpawnNew: async () => ({}),
      pathsListRecent: async () => ({ items: [] }),
      machinesList: async () => ({ items: [] }),
      serversList: async () => ({ items: [] }),
      reviewEnginesList: async () => ({ items: [{ value: 'coderabbit', label: 'CodeRabbit' }] }),
      agentsBackendsList: async () => ({ items: [] }),
      agentsModelsList: async () => ({ items: [] }),
      sessionSendMessage: async () => ({}),
      sessionPermissionRespond: async () => ({}),
      sessionUserActionAnswer: async () => ({}),
      sessionModeSet: async () => ({}),
      sessionModesList: async () => ({ items: [] }),
      sessionTargetPrimarySet: async () => ({}),
      sessionTargetTrackedSet: async () => ({}),
      sessionList: async () => ({}),
      sessionActivityGet: async () => ({}),
      sessionRecentMessagesGet: async () => ({}),
      daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
      daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
      daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
      resetGlobalVoiceAgent: async () => {},
    });

    const res = await executor.execute(
      'review.start' as any,
      {
        sessionId: 's1',
        reviewers: [{ kind: 'engine', engineId: 'coderabbit' }], comparisonId,
        instructions: 'Review this.',
        permissionMode: 'read_only',
        changeType: 'committed',
        base: { kind: 'none' },
      },
      { surface: 'ui', defaultSessionId: 's1' },
    );

    expect(res).toMatchObject({
      ok: true,
      result: {
        intent: 'review',
        sessionId: 's1',
        results: [
          {
            key: reviewReviewerIdForSelectionV1(0),
            ok: false,
            error: 'Unable to resolve a default base branch for CodeRabbit review.',
            details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
          },
        ],
      },
    });
  });

  it('does not launch review runs for unavailable engines', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));

    const reviewEnginesList = vi.fn(async () => ({ items: [{ value: 'claude', label: 'Claude' }] }));

    const executor = createActionExecutor({
      executionRunStart,
      executionRunList: async () => ({}),
      executionRunGet: async () => ({}),
      detachedExecutionRunSend: async () => ({}),
      executionRunStop: async () => ({}),
      executionRunAction: async () => ({}),
      executionRunWait: async () => ({}),
      sessionOpen: async () => ({}),
      sessionFork: async () => ({}),
      sessionRollback: async () => ({}),
      sessionSpawnNew: async () => ({}),
      pathsListRecent: async () => ({ items: [] }),
      machinesList: async () => ({ items: [] }),
      serversList: async () => ({ items: [] }),
      reviewEnginesList,
      agentsBackendsList: async () => ({ items: [] }),
      agentsModelsList: async () => ({ items: [] }),
      sessionSendMessage: async () => ({}),
      sessionPermissionRespond: async () => ({}),
      sessionUserActionAnswer: async () => ({}),
      sessionModeSet: async () => ({}),
      sessionModesList: async () => ({ items: [] }),
      sessionTargetPrimarySet: async () => ({}),
      sessionTargetTrackedSet: async () => ({}),
      sessionList: async () => ({}),
      sessionActivityGet: async () => ({}),
      sessionRecentMessagesGet: async () => ({}),
      daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
      daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
      daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
      resetGlobalVoiceAgent: async () => {},
    });

    const res = await executor.execute(
      'review.start' as any,
      {
        sessionId: 's1',
        reviewers: [{ kind: 'engine', engineId: 'coderabbit' }], comparisonId,
        instructions: 'Review this.',
        permissionMode: 'read_only',
        changeType: 'committed',
        base: { kind: 'none' },
        selectedPaths: ['src/auth.ts'],
      },
      { surface: 'ui', defaultSessionId: 's1' },
    );

    expect(executionRunStart).not.toHaveBeenCalled();
    expect(reviewEnginesList.mock.calls[0]?.[0]).toEqual({
      sessionId: 's1',
      includeDisabled: false,
      scope: 'paths',
    });
    expect(res).toMatchObject({
      ok: true,
      result: {
        intent: 'review',
        sessionId: 's1',
        results: [
          {
            key: reviewReviewerIdForSelectionV1(0),
            ok: false,
            errorCode: 'review_engine_unavailable',
            error: 'review_engine_unavailable',
            details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
          },
        ],
      },
    });
  });
});
