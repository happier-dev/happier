import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import { createReviewRecordPortV1, type ReviewArtifactTransportV1 } from '../reviews/reviewArtifactV1.js';
import { prepareReviewRoundV1 } from '../reviews/prepareReviewRoundV1.js';
import { ReviewPrepareRoundInputV1Schema } from '../reviews/reviewRoundActionsV1.js';
import { createInMemoryReviewRecordPortV1 } from '../reviews/reviewArtifactV1.testkit.js';
import { WorkflowRunStartRequestV1Schema } from '../workflows/actionsV1.js';
import { evaluateWorkflowCondition, resolveWorkflowActionFieldBinding, resolveWorkflowValueReference } from '../../../../apps/cli/src/daemon/workflows/input.js';
import { ScmComparisonCaptureInputSchema } from '../scm/diffSummary.js';
import { createScmCapabilities } from '../scm/index.js';
import { buildReviewStepsWorkflowV1 } from '../workflows/builtins/reviewAndConverge.js';
import { ReviewStartInputSchema } from '../reviews/reviewStart.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { readWorkflowActionFieldTextEncodingV1 } from '../workflows/workflowActionTextV1.js';
import { resolveActionCurrentSessionScopeFailure } from './executor/sessionListAccess.js';
import { AutomationActionRunEvidenceV1Schema } from '../automations/automationActionOccurrenceV1.js';
import type { ActionExecutorDeps } from './executor/types.js';

describe('committed Review source admission', () => {
  it.each([false, true])('delivers captured PR identity and head privately to After observers (retained capture: %s)', async retained => {
    const records = createInMemoryReviewRecordPortV1();
    const observeActionExecution = vi.fn<NonNullable<ActionExecutorDeps['observeActionExecution']>>(async () => undefined);
    const source = { kind: 'pullRequest' as const, locator: { providerId: 'github', repository: 'acme/reviews', number: 42 } };
    const comparisonId = 'a'.repeat(64);
    const executor = createActionExecutor({ reviewRecords: () => records,
      observeActionExecution,
      resolveApiTokenGrantSessionMachineId: async () => 'review-machine',
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      scmActionExecute: async ({ actionId, input }) => {
        expect(actionId).toBe('scm.diffSummary.capture');
        expect(ScmComparisonCaptureInputSchema.parse(input)).toMatchObject({ source,
          ...(retained ? { comparisonId } : {}) });
        return { success: true, comparison: { id: comparisonId, source,
          repository: { rootPath: '/review-repo' }, endpoints: { before: 'base', after: 'captured-head' },
          inventory: { state: 'complete', files: [], reasons: [] } }, metadata: { source, sourceKey: 'selected-pr' } };
      },
      executionRunStart: async () => ({ runId: 'reviewer-run', callId: 'reviewer-call', sidechainId: 'reviewer-call' }),
    });
    const started = await executor.execute('review.start', { sessionId: 'review-session', cwd: '/review-repo', source,
      ...(retained ? { comparisonId } : {}), instructions: 'Review this PR.', reviewers: [{ kind: 'engine', engineId: 'codex' }],
    }, { surface: 'ui' });
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
    const reviewObservations = observeActionExecution.mock.calls.filter(([event]) => event.actionId === 'review.start');
    expect(reviewObservations).toHaveLength(1);
    const after = reviewObservations[0]?.[0];
    expect(after).toMatchObject({ result: { ok: true, result: {
      reviewTarget: { locator: source.locator, headOid: 'captured-head' },
      reviewRound: { reviewId: expect.any(String), roundOrdinal: 1 },
    } } });
    // Public evidence is deliberately closed: a private hook result cannot enter it.
    const evidence = AutomationActionRunEvidenceV1Schema.parse({ actionId: 'review.start', requestId: 'request',
      phase: 'after', status: 'succeeded', outcome: 'succeeded' });
    expect(AutomationActionRunEvidenceV1Schema.safeParse({ ...evidence, output: after?.result }).success).toBe(false);
  });
  it.each(['explicit', 'upstream', 'default'] as const)('retains selected branch commits with %s base across Review admission', async baseSelection => {
    const records = createInMemoryReviewRecordPortV1();
    const starts = vi.spyOn(records, 'start');
    const capturedId = '9'.repeat(64);
    let snapshotReads = 0;
    const source = { kind: 'branch' as const, head: 'review-topic', base: baseSelection === 'explicit' ? 'review-base' : 'origin/review-base' };
    const executor = createActionExecutor({ reviewRecords: () => records,
      resolveApiTokenGrantSessionMachineId: async () => 'review-machine',
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      scmActionExecute: async ({ actionId, input }) => {
        if (actionId === 'scm.status.snapshot') { snapshotReads += 1; return { success: true, snapshot: {
          projectKey: 'review-branch', fetchedAt: 1, repo: { isRepo: true, rootPath: '/review-repo', backendId: 'git', mode: '.git',
            defaultBranch: 'review-base', defaultRef: 'origin/review-base' }, capabilities: createScmCapabilities(),
          branch: { head: 'other-checkout', upstream: baseSelection === 'upstream' ? 'origin/review-base' : null,
            ahead: 0, behind: 0, detached: false }, hasConflicts: false, entries: [],
          totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0,
            pendingAdded: 0, pendingRemoved: 0 } } }; }
        if (actionId !== 'scm.diffSummary.capture') throw new Error(`Unexpected SCM boundary: ${actionId}`);
        expect(ScmComparisonCaptureInputSchema.parse(input)).toMatchObject({ cwd: '/review-repo', source });
        return { success: true, comparison: { id: capturedId, source, repository: { rootPath: '/review-repo' },
          endpoints: { before: 'base-oid', after: 'head-oid' }, inventory: { state: 'complete', files: [], reasons: [] } },
          metadata: { source, sourceKey: capturedId } };
      },
      executionRunStart: async (_session, input) => {
        expect(input.intentInput).toMatchObject({ comparisonId: capturedId, source, headRef: 'review-topic' });
        return { runId: 'branch-run', callId: 'branch-call', sidechainId: 'branch-call' };
      },
    });
    const result = await executor.execute('review.start', { sessionId: 'review-session', cwd: '/review-repo',
      instructions: 'Review selected branch commits.', reviewers: [{ kind: 'engine', engineId: 'codex' }],
      changeType: 'committed', headRef: 'review-topic',
      base: baseSelection === 'explicit' ? { kind: 'branch', baseBranch: 'review-base' } : { kind: 'none' },
    }, { surface: 'ui' });
    expect(result).toMatchObject({ ok: true });
    expect(snapshotReads).toBe(baseSelection === 'explicit' ? 0 : 1);
    const admitted = starts.mock.calls[0]?.[0];
    if (!admitted) throw new Error('Expected admitted Review');
    expect((await records.read(admitted.reviewId))?.title).toBe('review-topic');
    expect((await records.read(admitted.reviewId))?.rounds[0]).toMatchObject({ comparisonId: capturedId,
      comparisonCapture: { input: { source } } });
  });
});

describe('Review round preparation', () => {
  it.each([false, true])('keeps repository admission and preparation free of changed-file scope (source: %s)', async explicitSource => {
    const records = createInMemoryReviewRecordPortV1();
    let request: ReturnType<typeof WorkflowRunStartRequestV1Schema.parse> | undefined;
    let captures = 0;
    const executor = createActionExecutor({ reviewRecords: () => records,
      resolveApiTokenGrantSessionMachineId: async () => 'review-machine',
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      scmActionExecute: async () => {
        captures++;
        const source = { kind: 'branch' as const, head: 'topic', base: 'main' };
        return { success: true, comparison: { id: 'c'.repeat(64), source, repository: { rootPath: '/review-repo' },
          endpoints: { before: 'base', after: 'head' }, inventory: { state: 'complete', files: [], reasons: [] } },
          metadata: { source, sourceKey: 'repository-neighbor' } };
      },
      workflowAction: async invocation => {
        request = WorkflowRunStartRequestV1Schema.parse(invocation.input);
        return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      },
    });
    expect(await executor.execute('review.start', { sessionId: 'review-session', cwd: '/review-repo', scope: 'repository',
      ...(explicitSource ? { source: { kind: 'branch', head: 'topic', base: 'main' } } : {}),
      instructions: 'Review the whole repository, including unchanged files.',
      reviewers: [{ kind: 'engine', engineId: 'codex' }, { kind: 'engine', engineId: 'codex' }],
    }, { surface: 'ui' })).toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    expect(captures).toBe(0);
    if (!request || request.source.kind !== 'inline') throw new Error('Expected actual admitted Review Workflow');
    const admitted = request;
    const prepare = admitted.source.definition.blocks.find(block => block.kind === 'action' && block.id === 'prepare');
    if (prepare?.kind !== 'action') throw new Error('Expected round preparation');
    const prepareInput = Object.fromEntries(await Promise.all(Object.entries(prepare.input ?? {}).map(async ([key, binding]) =>
      [key, await resolveWorkflowActionFieldBinding(binding, { inputs: admitted.inputs ?? {},
        resolveResult: async () => { throw new Error('No earlier result'); },
        resolveWorkspace: async () => { throw new Error('No workspace reference'); } })])));
    const prepared = await executor.execute('review.prepare_round', prepareInput, { surface: 'ui' });
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true });
    if (!prepared.ok) throw new Error('Expected whole-repository preparation');
    expect(prepared.result).not.toHaveProperty('comparison');
    expect(prepared.result).not.toHaveProperty('scmReviewScope');
  });
  it.each(['selectedPaths', 'selectedFiles'] as const)('retains admitted %s in actual Session and model reviewer inputs', async selector => {
    const records = createInMemoryReviewRecordPortV1();
    const comparison = { id: 'b'.repeat(64), source: { kind: 'workingTree' as const, area: 'pending' as const },
      repository: { rootPath: '/review-repo' }, endpoints: {}, inventory: { state: 'complete' as const, reasons: [],
        files: ['billing.ts', 'README.md'].map(path => ({ path, changeKind: 'modified' as const, binary: false,
          generated: false, lockfile: false, evidence: { state: 'deferred' as const, reason: 'Open the retained file evidence.' }, occurrences: [] })) } };
    const reviewRound = await records.start({ reviewId: 'selected-review', title: 'Review', subjectKind: 'comparison',
      sourceKind: 'workflow', reviewerIds: ['step-1-reviewer-1', 'step-1-reviewer-2'], comparisonId: comparison.id, startedAt: 1 });
    const reviewInput = ReviewStartInputSchema.parse({ cwd: '/review-repo', comparisonId: comparison.id,
      instructions: 'Find defects in the selected change.', [selector]: ['./billing.ts'],
      reviewers: [{ kind: 'session', session: { serverId: 'home', sessionId: 'existing-reviewer' } },
        { kind: 'model', launch: { executionTarget: { serverId: 'home', machineId: 'machine' },
          directory: { kind: 'path', path: '/review-repo' },
          agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'default' } } } }] });
    const built = buildReviewStepsWorkflowV1(reviewInput, reviewRound, comparison);
    const prepare = built.definition.blocks.find(block => block.kind === 'action' && block.id === 'prepare');
    if (prepare?.kind !== 'action') throw new Error('Expected Review preparation');
    const runtime = { inputs: built.inputs, resolveResult: async () => { throw new Error('No earlier result'); },
      resolveWorkspace: async () => { throw new Error('No workspace reference'); } };
    const prepareInput = Object.fromEntries(await Promise.all(Object.entries(prepare.input ?? {}).map(async ([key, binding]) =>
      [key, await resolveWorkflowActionFieldBinding(binding, runtime)])));
    const executor = createActionExecutor({ reviewRecords: () => records });
    const result = await executor.execute('review.prepare_round', prepareInput, { surface: 'ui' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('Expected prepared Review');
    const stage = built.definition.blocks.find(block => block.kind === 'parallel');
    if (stage?.kind !== 'parallel') throw new Error('Expected Session/model reviewer stage');
    for (const branch of stage.branches) {
      const leaf = branch.blocks[0];
      if (leaf?.kind !== 'step') throw new Error('Expected ordinary participant review');
      const inputs = await Promise.all((leaf.input ?? []).map(reference => resolveWorkflowValueReference(reference,
        { ...runtime, resolveResult: async () => StrictJsonValueSchema.parse(result.result) })));
      expect(inputs[0]).toMatchObject({ scmReviewScope: { status: 'supported', selectedPaths: ['billing.ts'],
        changedPaths: [{ path: 'billing.ts' }] },
        // Broader captured evidence stays available for justified supporting context.
        comparison: { inventory: { files: [{ path: 'billing.ts' }, { path: 'README.md' }] } } });
    }
    const denied = await executor.execute('review.prepare_round', { ...prepareInput,
      reviewInput: { ...reviewInput, [selector]: ['missing.ts'] } }, { surface: 'ui' });
    expect(denied).toMatchObject({ ok: false, errorCode: 'invalid_path' });
  });
  it.each([
    { mode: 'native', knownTitle: 'Keep selected changes separate', expectedTitle: 'Keep selected changes separate' },
    { mode: 'workflow', knownTitle: 'Show retained reviewer outcomes', expectedTitle: 'Show retained reviewer outcomes' },
    { mode: 'native', knownTitle: undefined, expectedTitle: 'acme/reviews#42' },
    { mode: 'workflow', knownTitle: undefined, expectedTitle: 'acme/reviews#42' },
  ] as const)('stamps the admitted PR subject on a $mode Review ($expectedTitle)', async ({ mode, knownTitle, expectedTitle }) => {
    const records = createInMemoryReviewRecordPortV1();
    const starts = vi.spyOn(records, 'start');
    const source = { kind: 'pullRequest' as const, locator: { providerId: 'github', repository: 'acme/reviews', number: 42 } };
    const executor = createActionExecutor({ reviewRecords: () => records,
      resolveApiTokenGrantSessionMachineId: async () => 'review-machine',
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      scmActionExecute: async ({ actionId }) => {
        expect(actionId).toBe('scm.diffSummary.capture');
        return { success: true, comparison: { id: 'a'.repeat(64), source,
          repository: { rootPath: '/review-repo' }, endpoints: { before: 'base', after: 'head' },
          inventory: { state: 'complete', files: [], reasons: [] } }, metadata: { source, sourceKey: 'selected-pr' } };
      },
      executionRunStart: async () => ({ runId: 'reviewer-run', callId: 'reviewer-call', sidechainId: 'reviewer-call' }),
      workflowAction: async () => ({ ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' }),
    });
    const result = await executor.execute('review.start', { sessionId: 'review-session', cwd: '/review-repo', source,
      instructions: 'Review the selected PR.',
      reviewers: Array.from({ length: mode === 'native' ? 1 : 2 }, () => ({ kind: 'engine', engineId: 'codex' })),
      scmPullRequestReviewScope: { kind: 'scm_pull_request_review_scope.v1',
        account: { service: { pluginId: 'happier.scm-github', localId: 'github' }, accountId: 'review-account' },
        pullRequest: { number: 42, ...(knownTitle ? { title: knownTitle } : {}) },
        observed: { baseSha: '1'.repeat(40), headSha: '2'.repeat(40), nativeRevision: 'pr-42', observedAtMs: 1 },
      },
    }, { surface: 'ui' });
    expect(result).toMatchObject(mode === 'native' ? { ok: true } : { ok: false, errorCode: 'content_unavailable' });
    const admitted = starts.mock.calls[0]?.[0];
    if (!admitted) throw new Error('Expected the durable Review admission');
    expect((await records.read(admitted.reviewId))?.title).toBe(expectedTitle);
  });

  it('admits a detached native reviewer without claiming the source Session as its execution target', async () => {
    const reviewInput = ReviewStartInputSchema.parse({ sessionId: 'selected-session', scope: 'repository',
      instructions: 'Review the selected repository.', then: 'fix', reviewers: [{ kind: 'engine', engineId: 'codex' }] });
    const reviewRound = { reviewId: 'existing-review', roundOrdinal: 1 };
    const built = buildReviewStepsWorkflowV1(reviewInput, reviewRound);
    const stage = built.definition.blocks.find(block => block.kind === 'parallel');
    const leaf = stage?.kind === 'parallel' ? stage.branches[0]?.blocks[0] : undefined;
    if (leaf?.kind !== 'action') throw new Error('Expected the native reviewer Action');
    const input = Object.fromEntries(await Promise.all(Object.entries(leaf.input ?? {}).map(async ([key, binding]) =>
      [key, await resolveWorkflowActionFieldBinding(binding, { inputs: built.inputs,
        resolveResult: async () => ({ reviewRound, newRoundCostConsent: false }),
        resolveWorkspace: async () => { throw new Error('No workspace reference'); },
      }, undefined, readWorkflowActionFieldTextEncodingV1(null, key))])));
    // Workflow custody supplies an admitted repository and Review round, not a
    // new Session target. This is the same empty Session corpus as READY296.
    await expect(resolveActionCurrentSessionScopeFailure('review.start', input,
      { surface: 'agent', actionCaller: { kind: 'workflowRun', runId: 'review-workflow',
        authorization: { admittedPermissionCeiling: 'read-only', principal: { kind: 'host' } } } },
      { sessionId: 'current_session' }, {}, undefined, undefined,
      { actionRequestId: 'review-workflow/reviewer/0', invocationId: 'reviewer', sessions: [] },
    )).resolves.toBeNull();
    expect(input.reviewRound).toEqual(reviewRound);
    expect(built.inputs.reviewInput).toMatchObject({ sessionId: 'selected-session' });
    expect(built.definition.blocks.find(block => block.id === 'fix')).toMatchObject({
      input: { sessionId: { kind: 'literal', value: 'selected-session' } },
    });
  });
  it.each([null, false, true, 'retained-graph'] as const)('uses fresh paid consent at the actual Workflow engine leaf (%s)', async choice => {
    const records = createInMemoryReviewRecordPortV1();
    const firstRound = await records.start({ reviewId: 'paid-workflow', title: 'Review', subjectKind: 'repository',
      sourceKind: 'workflow', reviewerIds: ['step-1-reviewer-1'], startedAt: 1 });
    if (choice !== null) await records.settle({ ...firstRound, outcome: 'completed', finishedAt: 2, runs: [] });
    const reviewInput = ReviewStartInputSchema.parse({ sessionId: 'target-session', scope: 'repository',
      instructions: 'Find defects.', profileId: 'paid-profile',
      profileSourceCustody: { kind: 'development', registeredRootId: 'paid-root' }, acceptCharge: true,
      engines: { codex: { acceptCharge: true, effort: 'high' } },
      reviewers: [{ kind: 'engine', engineId: 'codex', options: { acceptCharge: true, effort: 'high' } }] });
    const built = buildReviewStepsWorkflowV1(reviewInput, firstRound);
    const inputs = { ...built.inputs, previousRoundContext: choice === null ? null
      : { runId: 'previous-run', state: 'succeeded', outcomes: [], costConsent: choice === true } };
    const prepare = built.definition.blocks.find(block => block.kind === 'action' && block.id === 'prepare');
    const stage = built.definition.blocks.find(block => block.kind === 'parallel');
    const leaf = stage?.kind === 'parallel' ? stage.branches[0]?.blocks[0] : undefined;
    if (prepare?.kind !== 'action' || leaf?.kind !== 'action') throw new Error('Expected the actual Review engine graph');
    const runtime = { inputs, resolveResult: async () => { throw new Error('No earlier result'); },
      resolveWorkspace: async () => { throw new Error('No workspace reference'); } };
    const preparedInput = Object.fromEntries(await Promise.all(Object.entries(prepare.input ?? {}).map(async ([key, binding]) =>
      [key, await resolveWorkflowActionFieldBinding(binding, runtime)])));
    const prepared = await prepareReviewRoundV1(ReviewPrepareRoundInputV1Schema.parse(preparedInput), {
      reviewRecords: records, startedAt: 3, captureComparison: async () => { throw new Error('Repository review'); },
    });
    const leafInput = Object.fromEntries(await Promise.all(Object.entries(leaf.input ?? {})
      .filter(([key]) => choice !== 'retained-graph' || key !== 'newRoundCostConsent')
      .map(async ([key, binding]) => [key, await resolveWorkflowActionFieldBinding(binding, {
        ...runtime, resolveResult: async () => StrictJsonValueSchema.parse(prepared),
      }, undefined, readWorkflowActionFieldTextEncodingV1(null, key))])));
    let inventoryReads = 0;
    const starts: unknown[] = [];
    const executor = createActionExecutor({
      // The generated reviewer uses the daemon's detached Run protocol.
      executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'review-machine' }),
      reviewEnginesList: async input => {
        inventoryReads++;
        expect(input.engineIds).toEqual(['codex']);
        expect(input.profileSelections).toEqual([{ engineId: 'codex', profileId: 'paid-profile',
          profileSourceCustody: { kind: 'development', registeredRootId: 'paid-root' } }]);
        return { items: [], selectionItems: [{ engineId: 'codex', value: 'codex', label: 'Paid reviewer', enabled: true,
          profileId: 'paid-profile', capabilities: { structuredNarration: false },
          costConsent: { optionKey: 'acceptCharge', title: 'Approve paid review' } }] };
      },
      executionRunStart: async (_sessionId, input) => {
        starts.push(input);
        return { runId: 'engine-run', callId: 'call', sidechainId: 'sidechain' };
      },
    });
    const result = await executor.execute('review.start', leafInput, { surface: 'ui',
      externalActionTarget: { kind: 'machine', machineId: 'review-machine',
        project: { machineId: 'review-machine', directory: '/review-repo' } } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ profileId: 'paid-profile', intentInput: {
      acceptCharge: choice === null || choice === true,
      engines: { codex: { acceptCharge: choice === null || choice === true, effort: 'high' } },
    } });
    expect(inventoryReads).toBe(1);
  });
  it('consumes the initially admitted comparison without resolving its Machine again', async () => {
    const records = createInMemoryReviewRecordPortV1();
    const comparison = { id: 'f'.repeat(64), source: { kind: 'workingTree' as const, area: 'pending' as const },
      repository: { rootPath: '/host/repository' }, endpoints: {}, inventory: { state: 'complete' as const, files: [], reasons: [] } };
    const reviewRound = await records.start({ reviewId: 'admitted-review', title: 'Review', subjectKind: 'comparison',
      sourceKind: 'workflow', reviewerIds: ['step-1-reviewer-1'], comparisonId: comparison.id, startedAt: 1 });
    const executor = createActionExecutor({ reviewRecords: () => records,
      sessionStatusGet: async () => { throw new Error('Initial preparation already has its admitted comparison'); },
    });
    expect(await executor.execute('review.prepare_round', { reviewRound, comparison,
      comparisonCapture: { cwd: '/host/repository', sessionId: 'selected-session', source: comparison.source, comparisonId: comparison.id },
      reviewInput: { sessionId: 'selected-session', comparisonId: comparison.id, source: comparison.source,
        reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'Review admitted evidence.' },
      previousRoundContext: null,
    }, { surface: 'ui', defaultSessionId: 'caller-session', defaultSessionMachineId: 'caller-machine' }))
      .toMatchObject({ ok: true, result: { reviewRound, comparisonId: comparison.id, comparison } });
    expect((await records.read(reviewRound.reviewId))?.rounds).toHaveLength(1);
  });
  it.each(['native', 'workflow'] as const)('seals the original source of a comparisonId-only %s start', async mode => {
    const records = createInMemoryReviewRecordPortV1();
    const starts = vi.spyOn(records, 'start');
    const captured = { id: 'e'.repeat(64), source: { kind: 'branch' as const, head: 'topic', base: 'main' },
      repository: { rootPath: '/retained/repository' }, endpoints: { before: 'original-base', after: 'original-head' },
      inventory: { state: 'complete' as const, files: [], reasons: [] } };
    const executor = createActionExecutor({ reviewRecords: () => records,
      resolveApiTokenGrantSessionMachineId: async () => 'capture-machine',
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      scmActionExecute: async ({ actionId, input }) => {
        expect(actionId).toBe('scm.diffSummary.capture');
        expect(ScmComparisonCaptureInputSchema.parse(input)).toMatchObject({ cwd: '/retained/repository', comparisonId: captured.id });
        expect(input).not.toHaveProperty('source');
        return { success: true, comparison: captured, metadata: { source: captured.source, sourceKey: captured.id } };
      },
      executionRunStart: async (_session, input) => {
        expect(input.intentInput).toMatchObject({ comparisonId: captured.id, source: captured.source });
        return { runId: 'native-run', callId: 'call', sidechainId: 'sidechain' };
      },
      workflowAction: async invocation => {
        const request = WorkflowRunStartRequestV1Schema.parse(invocation.input);
        expect(request.inputs).toMatchObject({ reviewInput: { comparisonId: captured.id, source: captured.source }, comparison: captured });
        return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      },
    });
    expect(await executor.execute('review.start', { sessionId: 'capture-session', cwd: '/retained/repository',
      comparisonId: captured.id, instructions: 'Review retained changes.',
      reviewers: Array.from({ length: mode === 'native' ? 1 : 2 }, () => ({ kind: 'engine', engineId: 'codex' })),
    }, { surface: 'ui' })).toMatchObject(mode === 'native' ? { ok: true } : { ok: false, errorCode: 'content_unavailable' });
    const admitted = starts.mock.calls[0]?.[0];
    if (!admitted) throw new Error('Expected the durable Review admission');
    expect((await records.read(admitted.reviewId))?.rounds[0]).toMatchObject({ comparisonId: captured.id,
      comparisonCapture: { input: { source: captured.source, comparisonId: captured.id } } });
  });
  it('captures the selected Session host repository root when no directory was supplied', async () => {
    const records = createInMemoryReviewRecordPortV1();
    const starts = vi.spyOn(records, 'start');
    const captured = { id: 'd'.repeat(64), source: { kind: 'workingTree' as const, area: 'pending' as const },
      repository: { rootPath: '/host/repository' }, endpoints: {}, inventory: { state: 'complete' as const, files: [], reasons: [] } };
    const executor = createActionExecutor({ reviewRecords: () => records,
      sessionStatusGet: async () => ({ session: { id: 'selected-session', createdAt: 1, updatedAt: 1,
        active: true, activeAt: 1, encryption: null, path: '/agent/project', machineId: 'selected-machine' } }),
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      scmActionExecute: async ({ actionId, input }) => {
        if (actionId === 'scm.status.snapshot') {
          expect(input).toMatchObject({ sessionId: 'selected-session', detail: 'facts' });
          return { success: true, snapshot: { projectKey: 'selected-project', fetchedAt: 1, detail: 'facts',
            repo: { isRepo: true, rootPath: '/host/repository', backendId: 'git', mode: '.git' },
            capabilities: createScmCapabilities(),
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            hasConflicts: false, entries: [], totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0,
              includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 } } };
        }
        expect(actionId).toBe('scm.diffSummary.capture');
        expect(ScmComparisonCaptureInputSchema.parse(input)).toMatchObject({ cwd: '/host/repository',
          sessionId: 'selected-session', source: captured.source });
        return { success: true, comparison: captured, metadata: { source: captured.source, sourceKey: captured.id } };
      },
      executionRunStart: async () => ({ runId: 'native-run', callId: 'call', sidechainId: 'sidechain' }),
    });
    expect(await executor.execute('review.start', { sessionId: 'selected-session',
      reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'Review pending changes.' },
    { surface: 'ui' })).toMatchObject({ ok: true });
    const admitted = starts.mock.calls[0]?.[0];
    if (!admitted) throw new Error('Expected the durable Review admission');
    expect((await records.read(admitted.reviewId))?.rounds[0]).toMatchObject({ comparisonId: captured.id,
      comparisonCapture: { target: { kind: 'machine', machineId: 'selected-machine' },
        input: { cwd: '/host/repository', sessionId: 'selected-session', source: captured.source, comparisonId: captured.id } } });
  });
  it.each(['available', 'missing', 'malformed'] as const)('uses the selected Session Machine instead of caller placement when status is %s', async state => {
    const records = createInMemoryReviewRecordPortV1();
    const starts = vi.spyOn(records, 'start');
    const executor = createActionExecutor({ reviewRecords: () => records,
      resolveApiTokenGrantSessionMachineId: async () => null,
      sessionStatusGet: async ({ sessionId }) => {
        expect(sessionId).toBe('selected-session');
        return state === 'malformed' ? { session: null } : { session: {
          id: sessionId, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, encryption: null,
          path: '/agent/project', ...(state === 'available' ? { machineId: 'selected-machine' } : {}),
        } };
      },
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      executionRunStart: async () => ({ runId: 'native-run', callId: 'call', sidechainId: 'sidechain' }),
    });
    const result = await executor.execute('review.start', { sessionId: 'selected-session', cwd: '/host/project',
      comparisonId: 'a'.repeat(64), source: { kind: 'workingTree' },
      reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'Review the selected Session.' },
    { surface: 'ui', defaultSessionId: 'caller-session', defaultSessionMachineId: 'caller-machine',
      executionRunTargetMachineId: 'caller-machine' });
    if (state !== 'available') {
      expect(result).toMatchObject({ ok: false, errorCode: state === 'malformed' ? 'invalid_action_output' : 'workspace_unavailable' });
      expect(starts.mock.calls).toEqual([]);
      return;
    }
    expect(result).toMatchObject({ ok: true });
    const admitted = starts.mock.calls[0]?.[0];
    if (!admitted) throw new Error('Expected the durable Review admission');
    expect((await records.read(admitted.reviewId))?.rounds[0]?.comparisonCapture?.target)
      .toEqual({ kind: 'machine', machineId: 'selected-machine' });
  });
  it.each([
    { mode: 'native', sameSession: false }, { mode: 'workflow', sameSession: false },
    { mode: 'native', sameSession: true },
  ] as const)('retains captured pending evidence for an ordinary initial $mode round (current Session: $sameSession)', async ({ mode, sameSession }) => {
    const records = createInMemoryReviewRecordPortV1();
    const starts = vi.spyOn(records, 'start');
    const captured = { id: 'c'.repeat(64), source: { kind: 'workingTree' as const, area: 'pending' as const },
      repository: { rootPath: '/original/worktree' }, endpoints: { before: 'index', after: 'worktree' },
      inventory: { state: 'complete' as const, files: [], reasons: [] } };
    const executor = createActionExecutor({ reviewRecords: () => records,
      resolveApiTokenGrantSessionMachineId: async () => 'capture-machine',
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      scmActionExecute: async ({ actionId, input, context }) => {
        expect(actionId).toBe('scm.diffSummary.capture');
        expect(context.defaultSessionId).toBe('capture-session');
        expect(context.defaultSessionMachineId).toBe(sameSession ? 'capture-machine' : undefined);
        expect(context.executionRunTargetMachineId).toBeUndefined();
        expect(context.externalActionTarget).toBeUndefined();
        expect(ScmComparisonCaptureInputSchema.parse(input)).toMatchObject({ cwd: '/original/worktree', source: captured.source });
        return { success: true, comparison: captured, metadata: { source: captured.source, sourceKey: captured.id } };
      },
      executionRunStart: async (_session, input) => {
        expect(input.intentInput).toMatchObject({ comparisonId: captured.id, source: captured.source });
        return { runId: 'native-run', callId: 'call', sidechainId: 'sidechain' };
      },
      workflowAction: async invocation => {
        const request = WorkflowRunStartRequestV1Schema.parse(invocation.input);
        expect(request.inputs).toMatchObject({ reviewInput: { comparisonId: captured.id, source: captured.source } });
        return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      },
    });
    const result = await executor.execute('review.start', { sessionId: 'capture-session', cwd: '/original/worktree',
      reviewers: Array.from({ length: mode === 'native' ? 1 : 2 }, () => ({ kind: 'engine', engineId: 'codex' })),
      instructions: 'Inspect only pending changes.' }, { surface: 'ui', defaultSessionId: sameSession ? 'capture-session' : 'caller-session',
      defaultSessionMachineId: sameSession ? 'capture-machine' : 'caller-machine', executionRunTargetMachineId: 'caller-machine',
      externalActionTarget: { kind: 'machine', machineId: 'caller-machine' } });
    expect(result).toMatchObject(mode === 'native' ? { ok: true } : { ok: false, errorCode: 'content_unavailable' });
    const admitted = starts.mock.calls[0]?.[0];
    if (!admitted) throw new Error('Expected the durable Review admission');
    const artifact = await records.read(admitted.reviewId);
    expect(artifact?.rounds[0]).toMatchObject({ comparisonId: captured.id, comparisonCapture: {
      target: { kind: 'machine', machineId: 'capture-machine' }, input: {
        cwd: '/original/worktree', sessionId: 'capture-session', source: captured.source, comparisonId: captured.id,
      },
    } });
  });
  it.each([
    ['uncommitted', { kind: 'workingTree', area: 'pending' }],
    ['committed', { kind: 'branch', base: 'review-base', head: 'review-head' }],
    ['all', { kind: 'workingTree', area: 'both' }],
  ] as const)('captures the original %s scope for an ordinary change review on the next round', async (changeType, source) => {
    const records = createInMemoryReviewRecordPortV1();
    const reviewRound = await records.start({ reviewId: 'ordinary-review', title: 'Review', subjectKind: 'repository',
      sourceKind: 'direct', reviewerIds: ['step-1-reviewer-1'], startedAt: 1 });
    const prepared = await prepareReviewRoundV1(ReviewPrepareRoundInputV1Schema.parse({ reviewRound,
      reviewInput: { reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'Review the current changes.', changeType,
        ...(changeType === 'committed' ? { base: { kind: 'branch', baseBranch: 'review-base' }, headRef: 'review-head' } : {}) },
      previousRoundContext: {},
    }), { reviewRecords: records, startedAt: 2, cwd: '/workspace',
      comparisonTarget: { kind: 'machine', machineId: 'original-machine' },
      captureComparison: async input => {
        expect(input).toEqual({ cwd: '/workspace', source });
        return { id: 'b'.repeat(64), source, repository: { rootPath: '/workspace' },
          endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } };
      },
    });
    expect(prepared).toMatchObject({ reviewRound: { reviewId: 'ordinary-review', roundOrdinal: 2 }, comparisonId: 'b'.repeat(64) });
    expect((await records.read('ordinary-review'))?.rounds).toHaveLength(2);
  });

  it.each(['native', 'workflow'] as const)('seals the selected comparison address at %s admission', async mode => {
    const records = createInMemoryReviewRecordPortV1();
    const starts = vi.spyOn(records, 'start');
    let preparedComparisonId: string | undefined;
    const executor = createActionExecutor({ reviewRecords: () => records,
      resolveApiTokenGrantSessionMachineId: async ({ actionId, sessionId, context }) =>
        actionId === 'review.start' && sessionId === 'capture-session' && context.surface === 'ui' ? 'capture-machine' : null,
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      executionRunStart: async () => ({ runId: 'native-run', callId: 'call', sidechainId: 'sidechain' }),
      workflowAction: async invocation => {
        const request = WorkflowRunStartRequestV1Schema.parse(invocation.input);
        if (request.source.kind !== 'inline') throw new Error('Expected the actual inline Review graph');
        const block = request.source.definition.blocks.find(block => block.kind === 'action' && block.id === 'prepare');
        if (!block || block.kind !== 'action') throw new Error('Expected the first Review preparation Action');
        const input = Object.fromEntries(await Promise.all(Object.entries(block.input ?? {}).map(async ([key, binding]) =>
          [key, await resolveWorkflowActionFieldBinding(binding, { inputs: request.inputs ?? {},
            resolveResult: async () => { throw new Error('Initial preparation has no earlier result'); },
            resolveWorkspace: async () => { throw new Error('Preparation retains the original workspace'); },
          })])));
        const prepared = await prepareReviewRoundV1(ReviewPrepareRoundInputV1Schema.parse(input), {
          reviewRecords: records, startedAt: 2,
          captureComparison: async capture => {
            expect(capture.comparisonId).toBe('a'.repeat(64));
            return { id: 'a'.repeat(64), source: capture.source,
              repository: { rootPath: capture.cwd }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } };
          },
        });
        preparedComparisonId = prepared.comparisonId;
        return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      },
    });
    const result = await executor.execute('review.start', { sessionId: 'capture-session', cwd: '/original/worktree',
      reviewers: Array.from({ length: mode === 'native' ? 1 : 2 }, () => ({ kind: 'engine', engineId: 'codex' })),
      instructions: 'Inspect the selected comparison.', source: { kind: 'workingTree' }, comparisonId: 'a'.repeat(64),
    }, { surface: 'ui' });
    expect(result).toMatchObject(mode === 'native' ? { ok: true } : { ok: false, errorCode: 'content_unavailable' });
    if (mode === 'workflow') expect(preparedComparisonId).toBe('a'.repeat(64));
    const admitted = starts.mock.calls[0]?.[0];
    if (!admitted) throw new Error('Expected the durable Review admission');
    expect((await records.read(admitted.reviewId))?.rounds[0]).toMatchObject({ comparisonCapture: {
      target: { kind: 'machine', machineId: 'capture-machine' }, input: {
        cwd: '/original/worktree', sessionId: 'capture-session', source: { kind: 'workingTree' }, comparisonId: 'a'.repeat(64),
      },
    } });
  });

  it('routes an explicit native New round through its retained Session action owner', async () => {
    const receipt = { runId: 'next-native-run', callId: 'next-call', sidechainId: 'next-sidechain',
      reviewRound: { reviewId: 'same-review', roundOrdinal: 2 }, comparisonId: 'new-comparison' };
    const executor = createActionExecutor({
      resolveSessionReference: async ({ sessionId }) => ({ kind: 'unique', address: { serverId: 'home', sessionId: sessionId! } }),
      executionRunAction: async (sessionId, request) => {
        expect(sessionId).toBe('actual-session');
        expect(request).toEqual({ runId: 'previous-native-run', actionId: 'review.new_round', input: { fresh: true } });
        return { ok: true, result: receipt };
      },
    });
    await expect(executor.execute('review.new_round', { runId: 'previous-native-run', sessionId: 'actual-session', fresh: true },
      { surface: 'ui', serverId: 'home' })).resolves.toEqual({ ok: true, result: receipt });
  });

  it('retries only the selected reviewers in a new round; the other reviewer leaves are skipped', async () => {
    const records = createInMemoryReviewRecordPortV1();
    const reviewInput = ReviewStartInputSchema.parse({ scope: 'repository', instructions: 'Find defects.',
      reviewers: [{ kind: 'engine', engineId: 'codex' }, { kind: 'engine', engineId: 'claude' }] });
    const firstRound = await records.start({ reviewId: 'retry-review', title: 'Review', subjectKind: 'repository',
      sourceKind: 'workflow', reviewerIds: ['step-1-reviewer-1', 'step-1-reviewer-2'], startedAt: 1 });
    await records.settle({ ...firstRound, outcome: 'completed', finishedAt: 2, runs: [], reviewerOutcomes: [
      { key: 'step-1-reviewer-1', outcome: 'completed', reviewOutcome: 'complete', materialization: { kind: 'complete' } },
      { key: 'step-1-reviewer-2', outcome: 'failed' }] });
    const built = buildReviewStepsWorkflowV1(reviewInput, firstRound);
    const prepare = (reviewerIds: string[]) => prepareReviewRoundV1(ReviewPrepareRoundInputV1Schema.parse({ reviewRound: firstRound,
      reviewInput, previousRoundContext: { runId: 'partial-run', state: 'succeeded', outcomes: [], reviewerIds } }), {
      reviewRecords: records, startedAt: 3, captureComparison: async () => { throw new Error('Repository review'); } });
    await expect(prepare(['step-1-reviewer-9'])).rejects.toMatchObject({ rpcErrorCode: 'invalid_parameters' });
    const prepared = await prepare(['step-1-reviewer-2']);
    expect((await records.read('retry-review'))?.rounds.map(round => [round.ordinal, round.state, round.reviewerIds])).toEqual([
      [1, 'partial', ['step-1-reviewer-1', 'step-1-reviewer-2']], [2, 'running', ['step-1-reviewer-2']]]);
    const stage = built.definition.blocks.find(block => block.kind === 'parallel');
    if (stage?.kind !== 'parallel') throw new Error('Expected the reviewer stage');
    const runs = await Promise.all(stage.branches.map(async branch => {
      const leaf = branch.blocks[0];
      if (!leaf || !('onlyWhen' in leaf) || !leaf.onlyWhen) return [branch.id, 'always'];
      return [branch.id, await evaluateWorkflowCondition(leaf.onlyWhen, { inputs: built.inputs,
        resolveResult: async () => StrictJsonValueSchema.parse(prepared),
        resolveWorkspace: async () => { throw new Error('No workspace reference'); } })];
    }));
    expect(runs).toEqual([['branch-step-1-reviewer-1', false], ['branch-step-1-reviewer-2', true]]);
  });

  it('consumes initial admission and captures current evidence for later rounds of the same Review', async () => {
    let row: Awaited<ReturnType<ReviewArtifactTransportV1['read']>> = null;
    let writes = 0;
    const records = createReviewRecordPortV1({
      read: async () => row,
      create: async input => {
        writes++;
        row = { ...input, revision: { headerVersion: writes, bodyVersion: writes } };
        return row;
      },
      update: async input => {
        writes++;
        row = { ...input, revision: { headerVersion: writes, bodyVersion: writes } };
        return { ok: true, revision: row.revision };
      },
    });
    const reviewRound = await records.start({ reviewId: 'one-review', title: 'Review', subjectKind: 'repository',
      sourceKind: 'workflow', reviewerIds: ['step-1-reviewer-1'], startedAt: 1 });
    const reviewInput = { reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'Find bugs.', scope: 'repository' };
    const executor = createActionExecutor({ reviewRecords: () => records });
    const initial = await executor.execute('review.prepare_round', { reviewRound, reviewInput, previousRoundContext: null }, { surface: 'ui' });
    expect(initial).toMatchObject({ ok: true, result: { reviewRound } });
    expect(writes).toBe(1);
    await records.settle({ ...reviewRound, outcome: 'completed', finishedAt: 2, runs: [],
      reviewerOutcomes: [{ key: 'step-1-reviewer-1', outcome: 'completed', reviewOutcome: 'complete', materialization: { kind: 'complete' } }] });
    const replay = await executor.execute('review.prepare_round', { reviewRound, reviewInput,
      previousRoundContext: { runId: 'previous-workflow', state: 'succeeded', outcomes: [] } }, { surface: 'ui' });
    expect(replay).toMatchObject({ ok: true, result: { reviewRound: { reviewId: reviewRound.reviewId, roundOrdinal: 2 } } });
    expect((await records.read(reviewRound.reviewId))?.rounds).toMatchObject([
      { ordinal: 1, state: 'completed' }, { ordinal: 2, state: 'running', reviewerIds: ['step-1-reviewer-1'] },
    ]);
    expect(writes).toBe(3);
    const pinnedComparisonId = 'a'.repeat(64);
    const currentComparisonId = 'b'.repeat(64);
    const current = await prepareReviewRoundV1(ReviewPrepareRoundInputV1Schema.parse({ reviewRound,
      reviewInput: { ...reviewInput, scope: 'changes', comparisonId: pinnedComparisonId },
      comparisonCapture: { cwd: '/workspace', source: { kind: 'workingTree' }, comparisonId: pinnedComparisonId },
      previousRoundContext: { runId: 'second-workflow' },
    }), { reviewRecords: records, startedAt: 3, comparisonTarget: { kind: 'machine', machineId: 'original-machine' },
      // The host SCM boundary reads a pinned capture, or captures the current tree without a pin.
      captureComparison: async capture => ({ id: capture.comparisonId ?? currentComparisonId, source: capture.source,
        repository: { rootPath: '/workspace' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } }),
    });
    expect(current).toMatchObject({ reviewRound: { reviewId: reviewRound.reviewId, roundOrdinal: 3 }, comparisonId: currentComparisonId });
    expect((await records.read(reviewRound.reviewId))?.title).toBe('Review');
    expect((await records.read(reviewRound.reviewId))?.rounds[2]).toMatchObject({ comparisonCapture: {
      target: { kind: 'machine', machineId: 'original-machine' },
      input: { cwd: '/workspace', source: { kind: 'workingTree' }, comparisonId: currentComparisonId },
    } });
  });
});
