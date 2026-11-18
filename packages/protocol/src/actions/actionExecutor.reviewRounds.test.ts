import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import { createReviewRecordPortV1, type ReviewArtifactTransportV1 } from '../reviews/reviewArtifactV1.js';
import { prepareReviewRoundV1 } from '../reviews/prepareReviewRoundV1.js';
import { ReviewPrepareRoundInputV1Schema } from '../reviews/reviewRoundActionsV1.js';
import { createInMemoryReviewRecordPortV1 } from '../reviews/reviewArtifactV1.testkit.js';
import { WorkflowRunStartRequestV1Schema } from '../workflows/actionsV1.js';
import { resolveWorkflowActionFieldBinding } from '../../../../apps/cli/src/daemon/workflows/input.js';

describe('Review round preparation', () => {
  it.each(['native', 'workflow'] as const)('seals the selected comparison address at %s admission', async mode => {
    const records = createInMemoryReviewRecordPortV1();
    const starts = vi.spyOn(records, 'start');
    let preparedComparisonId: string | undefined;
    const executor = createActionExecutor({ reviewRecords: () => records,
      resolveSessionMachineId: async () => 'capture-machine',
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
