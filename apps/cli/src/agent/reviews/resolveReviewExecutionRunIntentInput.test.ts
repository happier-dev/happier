import { describe, expect, it } from 'vitest';

import { resolveReviewExecutionRunIntentInput } from './resolveReviewExecutionRunIntentInput';

describe('resolveReviewExecutionRunIntentInput', () => {
  it('reads predecessor engineIds intent as canonical reviewers with engine options', () => {
    // Observed ../0.2 reviewStart.ts and intent resolver at 26ad40e86bafea7b2230939b2f2f409e9d4cf1d7.
    const resolved = resolveReviewExecutionRunIntentInput({
      engineIds: ['coderabbit'], instructions: 'Review.', engines: { coderabbit: { focus: 'security' } },
    });

    expect(resolved).toMatchObject({
      kind: 'review_start', input: { reviewers: [{ kind: 'engine', engineId: 'coderabbit', options: { focus: 'security' } }] },
    });
    if (resolved.kind !== 'review_start') throw new Error('Expected historical review start');
    expect(resolved.input).not.toHaveProperty('engineIds');
  });

  it('fills partial run intent defaults while preserving selected comparison and transcript', () => {
    const sourceSession = { serverId: 'home-1', sessionId: 'source-session' };
    expect(resolveReviewExecutionRunIntentInput({
      comparisonId: 'comparison-1', includeSessionTranscript: true, sourceSession,
    }, { engineId: 'coderabbit', instructions: 'Review.' })).toMatchObject({
      kind: 'review_start', input: {
        reviewers: [{ kind: 'engine', engineId: 'coderabbit' }], instructions: 'Review.',
        comparisonId: 'comparison-1', includeSessionTranscript: true, sourceSession,
      },
    });
  });

  it('preserves an explicit roster when adding missing instructions from the run', () => {
    const reviewers = [
      { kind: 'engine', engineId: 'engine-1', modelId: 'model-a' },
      { kind: 'engine', engineId: 'engine-1', modelId: 'model-b' },
      { kind: 'session', session: { serverId: 'home-1', sessionId: 'reviewer-session' } },
    ];
    const resolved = resolveReviewExecutionRunIntentInput({ reviewers }, { engineId: 'ignored-engine', instructions: 'Review.' });
    expect(resolved).toMatchObject({ kind: 'review_start', input: { reviewers, instructions: 'Review.' } });
    if (resolved.kind !== 'review_start') throw new Error('Expected mixed review start');
    expect(resolved.input).not.toHaveProperty('engineIds');
  });

  it('does not replace an explicitly invalid roster with a default engine', () => {
    expect(resolveReviewExecutionRunIntentInput({ reviewers: [] }, { engineId: 'coderabbit', instructions: 'Review.' }))
      .toEqual({ kind: 'invalid' });
  });
});
