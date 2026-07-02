import { describe, expect, it, vi } from 'vitest';

import { createCurrentSessionTranscriptPort } from './createCurrentSessionTranscriptPort';

describe('createCurrentSessionTranscriptPort', () => {
  it('routes transcript-vNext writes through the latest swapped session', async () => {
    const firstSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };
    const secondSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };

    let currentSession = firstSession;
    const port = createCurrentSessionTranscriptPort(() => currentSession as any);

    currentSession = secondSession;

    await port.sendAgentMessageCommitted(
      'gemini' as any,
      { type: 'thinking', text: 'final' } as any,
      { localId: 'commit_1' },
    );

    expect(firstSession.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(secondSession.sendAgentMessageCommitted).toHaveBeenCalledWith(
      'gemini',
      { type: 'thinking', text: 'final' },
      { localId: 'commit_1' },
    );
  });

  it('routes durable enqueue hooks through the latest swapped session', async () => {
    const firstSession = {
      sendAgentMessageCommitted: vi.fn(async () => {}),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false })),
    };
    const secondSession = {
      sendAgentMessageCommitted: vi.fn(async () => {}),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false })),
    };

    let currentSession = firstSession;
    const port = createCurrentSessionTranscriptPort(() => currentSession as any);

    currentSession = secondSession;

    await expect((port as any).enqueueAgentMessageCommitted(
      'opencode',
      { type: 'message', message: 'final' },
      { localId: 'commit_1' },
    )).resolves.toEqual({ persisted: true, delivered: false });

    expect(firstSession.enqueueAgentMessageCommitted).not.toHaveBeenCalled();
    expect(firstSession.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(secondSession.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(secondSession.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'message', message: 'final' },
      { localId: 'commit_1' },
    );
  });
});
