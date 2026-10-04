import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';

import { planStartCompletion, reviewStartCompletion } from './specs/executionRunCompletion.js';
import {
  freezeActionCompletionContractV1,
  prepareActionCompletionV1,
  resumeActionCompletionV1,
  readActionCompletionRunObservationV1,
  type ActionCompletionStateV1,
} from './actionCompletion.js';

describe('Action completion owner', () => {
  it('observes standalone walkthrough completion without waiting for its retained process to exit', () => {
    const declaration = getActionSpec('review.walkthrough').completion;
    expect(declaration).toBeDefined();
    const prepared = prepareActionCompletionV1(declaration, { ok: true, result: {
      runId: 'narrator-1', comparisonId: 'comparison-1', mode: 'seeded_narrator', state: 'collecting',
      observation: { kind: 'review_walkthrough', comparisonId: 'comparison-1', resultId: 'saved-1', afterRevision: 2 },
    } });
    expect(prepared).toMatchObject({ kind: 'awaiting', state: { awaitedRuns: [{
      key: 'narrator', runId: 'narrator-1', observation: { kind: 'review_walkthrough', comparisonId: 'comparison-1', resultId: 'saved-1', afterRevision: 2 },
    }] } });
  });
  it.each(['partial', 'failed'] as const)('does not promote %s findings to a clean review when narration completes', async (reviewOutcome) => {
    const prepared = prepareActionCompletionV1(reviewStartCompletion, { ok: true, result: {
      intent: 'review', sessionId: 'origin', results: [{ key: 'codex', ok: true, result: { runId: 'review-1' } }],
      narration: { runId: 'review-1', comparisonId: 'comparison-1', mode: 'continued_review', state: 'collecting' },
    } });
    if (prepared.kind !== 'awaiting') throw new Error('Expected retained narration observation');
    const narrated = {
      success: true, sourceKey: 'comparison-1', metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison-1' },
      comparison: { id: 'comparison-1', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' },
        endpoints: { before: 'a', after: 'b' }, inventory: { state: 'complete', reasons: [], files: [] } },
      requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'complete',
        value: { title: 'Changes', intro: '', stops: [], otherChangeRefs: [] } } },
      analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
      producer: { kind: 'review', reviewedRuns: [{ runId: 'review-1', callId: 'call-1', backendId: 'codex',
        status: 'running', hasOutput: true, reviewOutcome }] },
    };
    expect(await resumeActionCompletionV1({ actionId: 'review.start',
      completion: freezeActionCompletionContractV1(reviewStartCompletion), state: prepared.state,
      resolveDeclaration: () => reviewStartCompletion,
      observeRun: async () => ({ kind: 'completed', result: narrated }),
    })).toMatchObject({ kind: 'completed', value: { reviewedFingerprint: null, commentIds: [],
      perEngineOutcome: [{ runId: 'review-1', outcome: reviewOutcome === 'failed' ? 'failed' : 'completed', reviewOutcome }],
      narration: { runId: 'review-1', outputState: 'complete', outcome: 'completed' },
    } });
  });
  it.each(['completed', 'failed', 'cancelled'] as const)('preserves actual findings independently of %s narration on the same Run', async (status) => {
    const prepared = prepareActionCompletionV1(reviewStartCompletion, { ok: true, result: {
      intent: 'review', sessionId: 'origin', results: [{ key: 'codex', ok: true, result: { runId: 'review-1' } }],
      narration: { runId: 'review-1', comparisonId: 'comparison-1', mode: 'continued_review', state: 'collecting' },
    } });
    if (prepared.kind !== 'awaiting') throw new Error('Expected retained narration observation');
    const payload = {
      success: true, sourceKey: 'comparison-1', metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison-1' },
      comparison: { id: 'comparison-1', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' },
        endpoints: { before: 'a', after: 'b' }, inventory: { state: 'complete', reasons: [], files: [] } },
      requestedOutputs: ['walkthrough'], outputs: { walkthrough: status === 'completed'
        ? { state: 'complete', value: { title: 'Changes', intro: '', stops: [], otherChangeRefs: [] } }
        : { state: 'writing' } },
      analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
      producer: { kind: 'review', reviewedRuns: [{ runId: 'review-1', callId: 'call-1', backendId: 'codex',
        status: 'running', hasOutput: true, reviewOutcome: 'complete' }] },
    };
    const complete = (snapshot: unknown) => resumeActionCompletionV1({ actionId: 'review.start',
      completion: freezeActionCompletionContractV1(reviewStartCompletion), state: prepared.state,
      resolveDeclaration: () => reviewStartCompletion,
      observeRun: async ({ observation }) => readActionCompletionRunObservationV1({
        run: { status: status === 'completed' ? 'running' : status,
          ...(status === 'failed' ? { error: { code: 'revision_conflict' } } : {}) },
        structuredMeta: { kind: 'scm_diff_summary.v1', payload: snapshot },
      }, observation),
    });
    expect(await complete(payload)).toMatchObject({ kind: 'completed', value: { reviewedFingerprint: null, commentIds: [],
      perEngineOutcome: [{ runId: 'review-1', outcome: 'completed', reviewOutcome: 'complete' }],
      narration: { runId: 'review-1', outcome: status },
    } });
    const materialization = status === 'failed' ? { kind: 'complete' as const }
      : { kind: 'partial' as const, errorCode: 'review_comment_writes_partial' };
    expect(await complete({ ...payload, producer: { ...payload.producer, reviewedRuns: [{
      ...payload.producer.reviewedRuns[0], reviewedFingerprint: 'reviewed-before-narration',
      commentIds: ['persisted-comment'], materialization,
    }] } })).toMatchObject({ kind: 'completed', value: {
      reviewedFingerprint: 'reviewed-before-narration', commentIds: ['persisted-comment'],
      perEngineOutcome: [{ runId: 'review-1', outcome: 'completed', reviewOutcome: 'complete', materialization }],
      narration: { runId: 'review-1', outcome: status },
    } });
    for (const foreign of [
      { ...payload, comparison: { ...payload.comparison, id: 'other-comparison' } },
      { ...payload, producer: { ...payload.producer, reviewedRuns: [{ ...payload.producer.reviewedRuns[0], runId: 'other-review' }] } },
    ]) {
      if (status === 'completed' && foreign.comparison.id !== 'comparison-1') {
        expect(await complete(foreign)).toMatchObject({ kind: 'outcome_uncertain' });
      } else expect(await complete(foreign)).toMatchObject({ kind: 'completed', value: {
        perEngineOutcome: [{ runId: 'review-1', outcome: 'failed', reviewOutcome: 'unavailable', errorCode: 'review_output_unavailable' }],
        narration: { runId: 'review-1', outcome: status },
      } });
    }
  });
  it.each([
    { second: 'F-b', expected: 'F-b' },
    { second: 'F-c', expected: null },
    { second: null, expected: null },
    { second: undefined, expected: null },
  ])('certifies only an agreed final review panel ($second)', async ({ second, expected }) => {
    const prepared = prepareActionCompletionV1(reviewStartCompletion, { ok: true, result: {
      intent: 'review', sessionId: 'origin', results: [
        { key: 'a', ok: true, result: { runId: 'run-a' } },
        { key: 'b', ok: true, result: { runId: 'run-b' } },
      ],
    } });
    if (prepared.kind !== 'awaiting') throw new Error('Expected persisted launch state');
    expect(await resumeActionCompletionV1({ actionId: 'review.start',
      completion: freezeActionCompletionContractV1(reviewStartCompletion), state: prepared.state,
      resolveDeclaration: () => reviewStartCompletion,
      observeRun: async ({ key }) => ({ kind: 'completed', result: {},
        ...(key === 'a' ? { reviewedFingerprint: 'F-b' } : second === undefined ? {} : { reviewedFingerprint: second }),
        commentIds: [], materialization: { kind: 'complete' },
      }),
    })).toMatchObject({ kind: 'completed', value: { reviewedFingerprint: expected } });
  });

  it('does not certify a panel with a failed engine from the first completed engine', async () => {
    const prepared = prepareActionCompletionV1(reviewStartCompletion, { ok: true, result: {
      intent: 'review', sessionId: 'origin', results: [
        { key: 'a', ok: true, result: { runId: 'run-a' } },
        { key: 'b', ok: true, result: { runId: 'run-b' } },
      ],
    } });
    if (prepared.kind !== 'awaiting') throw new Error('Expected persisted launch state');
    expect(await resumeActionCompletionV1({ actionId: 'review.start',
      completion: freezeActionCompletionContractV1(reviewStartCompletion), state: prepared.state,
      resolveDeclaration: () => reviewStartCompletion,
      observeRun: async ({ key }) => key === 'a'
        ? { kind: 'completed', result: {}, reviewedFingerprint: 'F-b', commentIds: [], materialization: { kind: 'complete' } }
        : { kind: 'failed', code: 'review_failed' },
    })).toMatchObject({ kind: 'completed', value: { reviewedFingerprint: null } });
  });

  it('persists launch correspondence before observation and rejoins the same runs with partial failures as values', async () => {
    // The real fanoutStarts public output shape, retained as JSON across a restart.
    const executed = { ok: true as const, result: {
      intent: 'review', sessionId: 'session-1', results: [
        { key: 'codex', ok: true, result: { runId: 'run-codex', callId: 'call-codex', sidechainId: 'call-codex' } },
        { key: 'claude', ok: true, result: { runId: 'run-claude', callId: 'call-claude', sidechainId: 'call-claude' } },
        { key: 'gemini', ok: false, errorCode: 'engine_busy', error: 'engine_busy',
          details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } },
      ],
    } };
    const frozen = freezeActionCompletionContractV1(reviewStartCompletion);
    const prepared = prepareActionCompletionV1(reviewStartCompletion, executed);
    expect(prepared.kind).toBe('awaiting');
    if (prepared.kind !== 'awaiting') throw new Error('Expected persisted launch state');
    // A restart opens only JSON state and resolves the current declaration by frozen id.
    const retained: ActionCompletionStateV1 = JSON.parse(JSON.stringify(prepared.state));
    const observed: string[] = [];
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const completing = resumeActionCompletionV1({
      actionId: 'review.start', completion: frozen, state: retained,
      resolveDeclaration: (actionId) => actionId === 'review.start' ? reviewStartCompletion : undefined,
      observeRun: async ({ runId }) => {
        observed.push(runId);
        if (runId === 'run-codex') {
          await delayed;
          return { kind: 'completed', result: {}, commentIds: ['comment-1'], materialization: { kind: 'complete' } };
        }
        return { kind: 'failed', code: 'review_failed' };
      },
    });
    await Promise.resolve();
    expect(observed).toEqual(['run-codex', 'run-claude']);
    let settled = false;
    void completing.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await completing).toEqual({ kind: 'completed', value: {
      reviewedFingerprint: null, commentIds: ['comment-1'], perEngineOutcome: [
        { key: 'codex', runId: 'run-codex', outcome: 'completed', materialization: { kind: 'complete' } },
        { key: 'claude', runId: 'run-claude', outcome: 'failed', errorCode: 'review_failed' },
        { key: 'gemini', outcome: 'launch_failed', errorCode: 'engine_busy' },
      ],
    } });
  });

  it('applies the same owner to planning values, including JSON strings and cancellation', async () => {
    const declaration = planStartCompletion;
    const prepared = prepareActionCompletionV1(declaration, { ok: true, result: {
      intent: 'plan', sessionId: null, results: [
        { key: 'a', ok: true, result: { runId: 'run-a' } },
        { key: 'b', ok: true, result: { runId: 'run-b' } },
      ],
    } });
    if (prepared.kind !== 'awaiting') throw new Error('Expected persisted launch state');
    expect(await resumeActionCompletionV1({
      actionId: 'subagents.plan.start', completion: freezeActionCompletionContractV1(declaration), state: prepared.state,
      resolveDeclaration: () => declaration,
      observeRun: async ({ runId }) => runId === 'run-a'
        ? { kind: 'completed', result: '"already decoded"' }
        : { kind: 'cancelled', code: 'cancelled_by_user' },
    })).toEqual({ kind: 'completed', value: {
      plans: [{ key: 'a', runId: 'run-a', value: '"already decoded"' }],
      perEngineOutcome: [
        { key: 'a', runId: 'run-a', outcome: 'completed' },
        { key: 'b', runId: 'run-b', outcome: 'cancelled', errorCode: 'cancelled_by_user' },
      ],
    } });
  });

  it('keeps immediate Actions immediate, and fails on no launches or Action failure', () => {
    expect(prepareActionCompletionV1(undefined, { ok: true, result: { hello: true } }))
      .toEqual({ kind: 'completed', value: { hello: true } });
    const declaration = reviewStartCompletion;
    expect(prepareActionCompletionV1(declaration, { ok: false, errorCode: 'denied', error: 'denied' }))
      .toEqual({ kind: 'failed', errorCode: 'denied' });
    expect(prepareActionCompletionV1(declaration, { ok: true, result: {
      intent: 'review', sessionId: 's', results: [{ key: 'a', ok: false, errorCode: 'engine_busy' }],
    } })).toEqual({ kind: 'failed', errorCode: 'engine_busy' });
  });

  it('does not claim successful review materialization when the observation lacks that evidence', async () => {
    const declaration = reviewStartCompletion;
    const prepared = prepareActionCompletionV1(declaration, { ok: true, result: {
      intent: 'review', sessionId: 's', reviewedFingerprint: 'reviewed-at-launch',
      results: [{ key: 'a', ok: true, result: { runId: 'run-a' } }],
    } });
    if (prepared.kind !== 'awaiting') throw new Error('Expected persisted launch state');
    expect(await resumeActionCompletionV1({
      actionId: 'review.start', completion: freezeActionCompletionContractV1(declaration), state: prepared.state,
      resolveDeclaration: () => declaration,
      observeRun: async () => ({ kind: 'completed', result: { findings: [] } }),
    })).toEqual({ kind: 'completed', value: {
      reviewedFingerprint: 'reviewed-at-launch', commentIds: [], perEngineOutcome: [{
        key: 'a', runId: 'run-a', outcome: 'completed',
        materialization: { kind: 'failed', errorCode: 'review_materialization_unavailable' },
      }],
    } });
  });

  it.each([
    { retained: undefined, expected: 'observed-panel' },
    { retained: null, expected: null },
  ])('retains fingerprint $expected and ids from partial materialization', async ({ retained, expected }) => {
    const declaration = reviewStartCompletion;
    const prepared = prepareActionCompletionV1(declaration, { ok: true, result: {
      intent: 'review', sessionId: 's',
      ...(retained === undefined ? {} : { reviewedFingerprint: retained }),
      results: [{ key: 'a', ok: true, result: { runId: 'run-a' } }],
    } });
    if (prepared.kind !== 'awaiting') throw new Error('Expected persisted launch state');
    expect(await resumeActionCompletionV1({
      actionId: 'review.start', completion: freezeActionCompletionContractV1(declaration), state: prepared.state,
      resolveDeclaration: () => declaration,
      observeRun: async () => ({
        kind: 'completed', result: {}, reviewedFingerprint: 'observed-panel', commentIds: ['saved-comment'],
        materialization: { kind: 'partial', errorCode: 'findings_partially_saved' },
      }),
    })).toEqual({ kind: 'completed', value: {
      reviewedFingerprint: expected, commentIds: ['saved-comment'], perEngineOutcome: [{
        key: 'a', runId: 'run-a', outcome: 'completed',
        materialization: { kind: 'partial', errorCode: 'findings_partially_saved' },
      }],
    } });
  });

});
