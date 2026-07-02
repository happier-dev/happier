import { describe, expect, it, vi } from 'vitest';

describe('projectRuntimeTranscriptEvent', () => {
  it('projects runtime user text evidence through the host session transcript port', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      event: {
        kind: 'transcript-user-text',
        sessionId: 'session-1',
        emittedAtMs: 1,
        text: 'terminal-origin prompt',
        localId: 'local-user-1',
        meta: { terminalOrigin: true },
      },
    })).resolves.toEqual({ projected: true, kind: 'transcript-user-text' });

    expect(session.sendUserTextMessage).toHaveBeenCalledWith('terminal-origin prompt', {
      localId: 'local-user-1',
      meta: { terminalOrigin: true },
    });
  });

  it('projects committed agent lifecycle markers through the durable transcript queue', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      event: {
        kind: 'transcript-agent-message-committed',
        sessionId: 'session-1',
        emittedAtMs: 1,
        provider: 'opencode',
        localId: 'turn-1:turn_failed',
        body: { type: 'turn_failed', id: 'turn-1' },
        meta: { source: 'runtime' },
      },
    })).resolves.toEqual({ projected: true, kind: 'transcript-agent-message-committed' });

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'turn_failed', id: 'turn-1' },
      {
        localId: 'turn-1:turn_failed',
        meta: { source: 'runtime' },
      },
    );
    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
  });

  it('fails closed for unknown event shapes and other sessions', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      event: { kind: 'provider-specific-row', sessionId: 'session-1', emittedAtMs: 1 },
    })).resolves.toEqual({ projected: false, reason: 'unsupported_event' });
    await expect(projectRuntimeTranscriptEvent({
      session,
      event: {
        kind: 'transcript-user-text',
        sessionId: 'session-2',
        emittedAtMs: 1,
        text: 'wrong session',
      },
    })).resolves.toEqual({ projected: false, reason: 'session_mismatch' });

    expect(session.sendUserTextMessage).not.toHaveBeenCalled();
    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
  });
});
