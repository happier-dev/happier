import { describe, expect, it } from 'vitest';

import { ExecutionRunStructuredRunRefSchema } from '@happier-dev/protocol';

import { ReviewFollowUpIntentInputSchema } from './reviewFollowUpIntentInput';

describe('ReviewFollowUpIntentInputSchema', () => {
  it('reuses the shared execution-run structured run ref contract for parentRunRef', () => {
    expect(ReviewFollowUpIntentInputSchema.shape.parentRunRef).toBe(ExecutionRunStructuredRunRefSchema);
  });

  it('preserves additive fields on follow-up intent payloads and the shared parent run ref', () => {
    const parsed = ReviewFollowUpIntentInputSchema.parse({
      kind: 'review_follow_up.v1',
      parentRunRef: {
        runId: 'run_1',
        callId: 'call_1',
        backendId: 'coderabbit',
        backendTarget: {
          kind: 'builtInAgent',
          agentId: 'coderabbit',
        },
        retentionPolicy: 'resumable',
        futureParentField: 'keep-me',
      },
      threadId: 'thread_1',
      findingIds: ['finding_1'],
      messageMarkdown: 'Please follow up.',
      summary: 'Summary',
      overviewMarkdown: 'Overview',
      findings: [],
      questions: [],
      assumptions: [],
      futureFollowUpField: {
        kind: 'review_follow_up.v2',
      },
    });

    expect((parsed as any).futureFollowUpField).toEqual({
      kind: 'review_follow_up.v2',
    });
    expect((parsed.parentRunRef as any).futureParentField).toBe('keep-me');
  });
});
