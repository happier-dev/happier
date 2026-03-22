import { describe, expect, it, vi } from 'vitest';

import { createCurrentSessionTranscriptPort } from './createCurrentSessionTranscriptPort';

describe('createCurrentSessionTranscriptPort', () => {
  it('routes transcript-vNext writes through the latest swapped session', async () => {
    const firstSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendTranscriptDraftDelta: vi.fn(),
    };
    const secondSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendTranscriptDraftDelta: vi.fn(),
    };

    let currentSession = firstSession;
    const port = createCurrentSessionTranscriptPort(() => currentSession as any);

    port.sendTranscriptDraftDelta('gemini' as any, {
      localId: 'draft_1',
      segmentKind: 'thinking',
      sidechainId: null,
      deltaText: 'draft',
      createdAtMs: 1,
    });

    currentSession = secondSession;

    await port.sendAgentMessageCommitted(
      'gemini' as any,
      { type: 'thinking', text: 'final' } as any,
      { localId: 'commit_1' },
    );

    expect(firstSession.sendTranscriptDraftDelta).toHaveBeenCalledTimes(1);
    expect(firstSession.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(secondSession.sendAgentMessageCommitted).toHaveBeenCalledWith(
      'gemini',
      { type: 'thinking', text: 'final' },
      { localId: 'commit_1' },
    );
  });
});
