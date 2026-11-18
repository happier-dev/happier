import { describe, expect, it } from 'vitest';
import { createActionExecutor as createCoreActionExecutor, type ActionExecutorDeps } from './actionExecutor';
import { createInMemoryReviewRecordPortV1 } from '../reviews/reviewArtifactV1.testkit';

function createActionExecutor(deps: ActionExecutorDeps) {
  const records = createInMemoryReviewRecordPortV1();
  return createCoreActionExecutor({ reviewRecords: () => records, ...deps });
}

// Already admitted native leaves keep this test at the source-read owner;
// mixed Workflow composition has its own entry-point acceptance tests.
const reviewRound = { reviewId: 'transcript-review', roundOrdinal: 1 };
const engine = (engineId: string) => ({ value: engineId, engineId, label: engineId, enabled: true,
  capabilities: { structuredNarration: true, sessionTranscript: true } });

describe('review.start selected source transcript', () => {
  it('refuses transcript selection before reading or launching until private delivery is supported', async () => {
    let reads = 0;
    let starts = 0;
    const executor = createActionExecutor({
      reviewEnginesList: async () => ({ items: [engine('codex')] }),
      sessionTranscriptGet: async () => { reads++; return {}; },
      executionRunStart: async () => { starts++; return { runId: 'run' }; },
    });
    expect(await executor.execute('review.start', { sessionId: 'review-session', reviewRound,
      reviewers: [{ kind: 'engine', engineId: 'codex', includeSessionTranscript: true }],
      instructions: 'Review.', sourceSession: { serverId: 'home', sessionId: 'source' } },
    { surface: 'ui', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'review_transcript_unsupported' });
    expect(reads).toBe(0);
    expect(starts).toBe(0);
  });
});
