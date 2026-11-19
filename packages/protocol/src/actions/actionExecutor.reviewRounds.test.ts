import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import { createReviewRecordPortV1, type ReviewArtifactTransportV1 } from '../reviews/reviewArtifactV1.js';
import { prepareReviewRoundV1 } from '../reviews/prepareReviewRoundV1.js';
import { ReviewPrepareRoundInputV1Schema } from '../reviews/reviewRoundActionsV1.js';
import { createInMemoryReviewRecordPortV1 } from '../reviews/reviewArtifactV1.testkit.js';
import { WorkflowRunStartRequestV1Schema } from '../workflows/actionsV1.js';
import { resolveWorkflowActionFieldBinding } from '../../../../apps/cli/src/daemon/workflows/input.js';
import { ScmComparisonCaptureInputSchema } from '../scm/diffSummary.js';
import { createScmCapabilities } from '../scm/index.js';

describe('Review round preparation', () => {
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
    ['uncommitted', 'pending'], ['committed', 'included'], ['all', 'both'],
  ] as const)('captures the original %s scope for an ordinary change review on the next round', async (changeType, area) => {
    const records = createInMemoryReviewRecordPortV1();
    const reviewRound = await records.start({ reviewId: 'ordinary-review', title: 'Review', subjectKind: 'repository',
      sourceKind: 'direct', reviewerIds: ['step-1-reviewer-1'], startedAt: 1 });
    const prepared = await prepareReviewRoundV1(ReviewPrepareRoundInputV1Schema.parse({ reviewRound,
      reviewInput: { reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'Review the current changes.', changeType },
      previousRoundContext: {},
    }), { reviewRecords: records, startedAt: 2, cwd: '/workspace',
      comparisonTarget: { kind: 'machine', machineId: 'original-machine' },
      captureComparison: async input => {
        expect(input).toEqual({ cwd: '/workspace', source: { kind: 'workingTree', area } });
        return { id: 'b'.repeat(64), source: { kind: 'workingTree', area }, repository: { rootPath: '/workspace' },
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
    expect((await records.read(reviewRound.reviewId))?.rounds[2]).toMatchObject({ comparisonCapture: {
      target: { kind: 'machine', machineId: 'original-machine' },
      input: { cwd: '/workspace', source: { kind: 'workingTree' }, comparisonId: currentComparisonId },
    } });
  });
});
