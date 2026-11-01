import { describe, expect, it } from 'vitest';

import { ReviewFollowUpIntentInputSchema } from './reviewFollowUpIntentInput';

describe('ReviewFollowUpIntentInputSchema', () => {
  it('accepts a parent run identity and refuses empty identity fields', () => {
    const parentRunRef = { runId: 'run_1', callId: 'call_1', backendId: 'coderabbit' };
    const input = {
      kind: 'review_follow_up.v1',
      parentRunRef,
      threadId: 'thread_1',
      messageMarkdown: 'Please follow up.',
      summary: 'Summary',
      overviewMarkdown: 'Overview',
    };
    expect(ReviewFollowUpIntentInputSchema.parse(input).parentRunRef).toEqual(parentRunRef);
    for (const field of ['runId', 'callId', 'backendId']) {
      expect(ReviewFollowUpIntentInputSchema.safeParse({
        ...input, parentRunRef: { ...parentRunRef, [field]: '' },
      }).success).toBe(false);
    }
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

    expect(parsed).toMatchObject({
      futureFollowUpField: { kind: 'review_follow_up.v2' },
      parentRunRef: { futureParentField: 'keep-me' },
    });
  });
});
