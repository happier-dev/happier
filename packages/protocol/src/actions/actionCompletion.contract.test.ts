import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getActionSpec } from './actionSpecs.js';
import {
  freezeActionCompletionContractV1, prepareActionCompletionV1, resumeActionCompletionV1,
  type ActionCompletionDeclaration,
} from './actionCompletion.js';

// A declaring Action fixture, not a mock of the completion owner.
const declaration: ActionCompletionDeclaration = {
  awaits: 'execution_runs',
  terminalOutputSchema: z.object({ values: z.array(z.string()) }).strict(),
  launched: (output) => {
    const parsed = z.object({ runId: z.string() }).strict().parse(output);
    return { runs: [{ key: 'a', runId: parsed.runId }], failed: [] };
  },
  terminal: (_output, runs) => ({ values: runs.map(({ outcome }) => outcome.kind) }),
};

describe('generic Action completion seam', () => {
  it('separates launch persistence from observation and re-resolves only the retained Action id', async () => {
    const prepared = prepareActionCompletionV1(declaration, { ok: true, result: { runId: 'run-a' } });
    expect(prepared.kind).toBe('awaiting');
    if (prepared.kind !== 'awaiting') throw new Error('Missing launch state');
    const ids: string[] = [];
    expect(await resumeActionCompletionV1({
      actionId: 'fixture.action', completion: freezeActionCompletionContractV1(declaration),
      state: JSON.parse(JSON.stringify(prepared.state)),
      resolveDeclaration: (id) => { ids.push(id); return declaration; },
      observeRun: async ({ runId }) => { expect(runId).toBe('run-a'); return { kind: 'cancelled' }; },
    })).toEqual({ kind: 'completed', value: { values: ['cancelled'] } });
    expect(ids).toEqual(['fixture.action']);
  });

  it.each(['missing', 'unparseable', 'changed_correspondence', 'missing_launch_fact'] as const)
  ('fails %s recovery closed before observing anything', async (variant) => {
    let observations = 0;
    expect(await resumeActionCompletionV1({
      actionId: 'fixture.action', completion: freezeActionCompletionContractV1(declaration),
      state: variant === 'missing_launch_fact' ? undefined : {
        output: variant === 'unparseable' ? {} : { runId: 'run-a' },
        awaitedRuns: [{ key: 'a', runId: variant === 'changed_correspondence' ? 'other' : 'run-a' }],
      },
      resolveDeclaration: () => variant === 'missing' ? undefined : declaration,
      observeRun: async () => { observations++; return { kind: 'cancelled' }; },
    })).toEqual({ kind: 'outcome_uncertain', errorCode: 'outcome_uncertain' });
    expect(observations).toBe(0);
  });

  it('validates against the frozen schema and keeps executable functions out of its JSON snapshot', async () => {
    const frozen = JSON.parse(JSON.stringify(freezeActionCompletionContractV1(declaration)));
    expect(Object.keys(frozen).sort()).toEqual(['awaits', 'terminalOutputSchema']);
    expect(await resumeActionCompletionV1({
      actionId: 'fixture.action', completion: frozen,
      state: { output: { runId: 'run-a' }, awaitedRuns: [{ key: 'a', runId: 'run-a' }] },
      resolveDeclaration: () => ({ ...declaration, terminal: () => ({ invalid: true }) }),
      observeRun: async () => ({ kind: 'cancelled' }),
    })).toEqual({ kind: 'failed', errorCode: 'invalid_action_output' });
    expect(prepareActionCompletionV1(undefined, { ok: true, result: 'immediate' }))
      .toEqual({ kind: 'completed', value: 'immediate' });
    expect(prepareActionCompletionV1(declaration, { ok: false, errorCode: 'denied', error: 'denied' }))
      .toEqual({ kind: 'failed', errorCode: 'denied' });
  });

  it('does not manufacture a terminal value when the observation transport cannot establish an outcome', async () => {
    expect(await resumeActionCompletionV1({
      actionId: 'fixture.action', completion: freezeActionCompletionContractV1(declaration),
      state: { output: { runId: 'run-a' }, awaitedRuns: [{ key: 'a', runId: 'run-a' }] },
      resolveDeclaration: () => declaration,
      observeRun: async () => { throw new Error('machine unavailable'); },
    })).toEqual({ kind: 'outcome_uncertain', errorCode: 'outcome_uncertain' });
  });

  it('keeps a partially acknowledged review launch uncertain after valid known-run completion', async () => {
    const review = getActionSpec('review.start').completion;
    if (!review) throw new Error('Review completion declaration missing');
    const prepared = prepareActionCompletionV1(review, { ok: true, result: {
      intent: 'review', sessionId: 'session-a', reviewedFingerprint: 'fingerprint',
      results: [
        { key: 'codex', ok: true, result: { runId: 'review-a' } },
        { key: 'claude', ok: false, errorCode: 'native_response_lost', error: 'native_response_lost' },
      ],
    } });
    if (prepared.kind !== 'awaiting') throw new Error('Known review run did not retain observation custody');
    expect(await resumeActionCompletionV1({
      actionId: 'review.start', completion: freezeActionCompletionContractV1(review),
      state: prepared.state, resolveDeclaration: (actionId) => actionId === 'review.start'
        ? getActionSpec('review.start').completion : undefined,
      observeRun: async () => ({ kind: 'completed', result: {}, reviewedFingerprint: 'fingerprint',
        commentIds: [], materialization: { kind: 'complete' } }),
    })).toEqual({ kind: 'outcome_uncertain', errorCode: 'outcome_uncertain' });
  });
});
