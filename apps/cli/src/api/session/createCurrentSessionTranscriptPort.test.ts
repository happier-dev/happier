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
    const port = createCurrentSessionTranscriptPort(() => currentSession);

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

  it('routes ephemeral stream segment writes through the latest swapped session', () => {
    const firstSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageEphemeral: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };
    const secondSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageEphemeral: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };

    let currentSession = firstSession;
    const port = createCurrentSessionTranscriptPort(() => currentSession as any);

    currentSession = secondSession;

    expect(port.sendAgentMessageEphemeral).toBeTypeOf('function');
    port.sendAgentMessageEphemeral?.(
      'codex',
      { type: 'message', message: 'live' },
      { localId: 'segment-1', createdAt: 1_000, updatedAt: 1_025 },
    );

    expect(firstSession.sendAgentMessageEphemeral).not.toHaveBeenCalled();
    expect(secondSession.sendAgentMessageEphemeral).toHaveBeenCalledWith(
      'codex',
      { type: 'message', message: 'live' },
      { localId: 'segment-1', createdAt: 1_000, updatedAt: 1_025 },
    );
  });

  it('does not advertise ephemeral stream segment writes when the current session lacks support', () => {
    const session = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };

    const port = createCurrentSessionTranscriptPort(() => session);

    expect(port.sendAgentMessageEphemeral).toBeUndefined();
  });
});
