import { describe, expect, it } from 'vitest';

import { readSharedMetadataActionConfirmationState, readSharedMetadataPresentationCompletedRequests } from './readSharedMetadataPendingRequestFacts.js';

describe('shared Action confirmation facts', () => {
  it('does not traverse unrelated session presentation when no Action confirmation state exists', () => {
    let presentationReads = 0;
    const metadata = {
      v: 1,
      get summary() {
        presentationReads += 1;
        return { text: 'Session summary', updatedAt: 1 };
      },
    };

    expect(readSharedMetadataActionConfirmationState(metadata, 1)).toBeNull();
    expect(presentationReads).toBe(0);
  });
});

describe('stored shared completion facts', () => {
  it('retains approval outcomes across additive Bot fields without exposing private or invalid known data', () => {
    const completedRequests = { request: { tool: 'Read', createdAt: 1, completedAt: 2, status: 'approved' } };
    expect(readSharedMetadataPresentationCompletedRequests({ v: 1,
      bot: { kind: 'bot', future: true }, future: true, work: { memoryEnabled: true },
      publicAgentState: { completedRequests },
    }, 1)).toEqual(completedRequests);
    expect(readSharedMetadataPresentationCompletedRequests({ v: 1,
      bot: { kind: 'ordinary' }, publicAgentState: { completedRequests },
    }, 1)).toBeNull();
    expect(readSharedMetadataPresentationCompletedRequests({ v: 1,
      bot: { kind: 'bot' }, publicAgentState: { completedRequests },
    }, 2)).toBeNull();
  });
});
