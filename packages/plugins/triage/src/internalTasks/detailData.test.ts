import { describe, expect, it } from 'vitest';

import { readInternalTaskDetailDataV1 } from './detailData.js';

describe('readInternalTaskDetailDataV1', () => {
  it('reads a Task’s live claim so its release can be observed', () => {
    expect(readInternalTaskDetailDataV1({ state: 'started', claim: { attemptBinding: { sessionId: 's-1', runId: 'r-1' }, claimedAt: 40 } }))
      .toEqual({ state: 'started', claim: { attemptBinding: { sessionId: 's-1', runId: 'r-1' }, claimedAt: 40 } });
  });

  it('keeps no claim fact from a malformed attempt binding', () => {
    expect(readInternalTaskDetailDataV1({ state: 'started', claim: { attemptBinding: { runId: 'r-1' }, claimedAt: 40 } }))
      .toEqual({ state: 'started' });
  });
});
