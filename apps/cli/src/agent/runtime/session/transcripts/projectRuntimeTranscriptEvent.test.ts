import { describe, expect, it, vi } from 'vitest';

describe('projectRuntimeTranscriptEvent', () => {
  it('projects public runtime message deltas through the canonical streamed transcript writer', async () => {
    const { createKeyedStreamedTranscriptBridge } = await import('@/api/session/createKeyedStreamedTranscriptBridge');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    };
    const runtimeMessageDeltaBridge = createKeyedStreamedTranscriptBridge({
      provider: 'cursor',
      createSessionForStream: () => session,
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
      liveSnapshotIntervalMs: null,
    });

    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: {
        kind: 'message-delta',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'turn-1',
        delta: { text: 'Hello ' },
      },
    })).resolves.toEqual({ projected: true, kind: 'message-delta' });
    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: {
        kind: 'message-delta',
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'turn-1',
        delta: { text: 'world' },
      },
    })).resolves.toEqual({ projected: true, kind: 'message-delta' });
    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: {
        kind: 'turn-complete',
        sessionId: 'session-1',
        emittedAtMs: 3,
        turnId: 'turn-1',
      },
    })).resolves.toEqual({ projected: true, kind: 'turn-complete' });

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'cursor',
      { type: 'message', message: 'Hello world' },
      expect.objectContaining({
        meta: expect.objectContaining({
          happierStreamSegmentV1: expect.objectContaining({
            segmentKind: 'assistant',
            segmentState: 'complete',
          }),
        }),
      }),
    );
  });

  it('extracts provider message-shaped runtime deltas through the same projection contract', async () => {
    const { createKeyedStreamedTranscriptBridge } = await import('@/api/session/createKeyedStreamedTranscriptBridge');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    };
    const runtimeMessageDeltaBridge = createKeyedStreamedTranscriptBridge({
      provider: 'claude',
      createSessionForStream: () => session,
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
      liveSnapshotIntervalMs: null,
    });

    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: {
        kind: 'message-delta',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'turn-1',
        delta: { provider: 'claude', message: 'Claude delta shape' },
      },
    })).resolves.toEqual({ projected: true, kind: 'message-delta' });
    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: {
        kind: 'turn-complete',
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'turn-1',
      },
    })).resolves.toEqual({ projected: true, kind: 'turn-complete' });

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'claude',
      { type: 'message', message: 'Claude delta shape' },
      expect.any(Object),
    );
  });

  it('routes runtime thinking deltas to thinking transcript segments instead of assistant text', async () => {
    const { createKeyedStreamedTranscriptBridge } = await import('@/api/session/createKeyedStreamedTranscriptBridge');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    };
    const runtimeMessageDeltaBridge = createKeyedStreamedTranscriptBridge({
      provider: 'antigravity',
      createSessionForStream: () => session,
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
      liveSnapshotIntervalMs: null,
    });

    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: {
        kind: 'message-delta',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'turn-1',
        delta: { text: 'Internal chain of thought', thinking: true },
      },
    })).resolves.toEqual({ projected: true, kind: 'message-delta' });
    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: {
        kind: 'turn-complete',
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'turn-1',
      },
    })).resolves.toEqual({ projected: true, kind: 'turn-complete' });

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'antigravity',
      { type: 'thinking', text: 'Internal chain of thought' },
      expect.objectContaining({
        meta: expect.objectContaining({
          happierStreamSegmentV1: expect.objectContaining({
            segmentKind: 'thinking',
            segmentState: 'complete',
          }),
        }),
      }),
    );
    expect(session.enqueueAgentMessageCommitted).not.toHaveBeenCalledWith(
      'antigravity',
      { type: 'message', message: 'Internal chain of thought' },
      expect.any(Object),
    );
  });

  it('projects canonical runtime tool events through the durable transcript queue', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const runtimeMessageDeltaBridge = {
      appendAssistantDelta: vi.fn(),
      appendThinkingDelta: vi.fn(),
      flushAll: vi.fn(async () => undefined),
    };
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'codex',
      runtimeMessageDeltaBridge,
      event: {
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        localId: 'acp-call-v1:test-call',
        toolName: 'Bash',
        toolInput: { command: 'pwd' },
      },
    })).resolves.toEqual({ projected: true, kind: 'tool-call' });
    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'codex',
      runtimeMessageDeltaBridge,
      event: {
        kind: 'tool-result',
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        localId: 'acp-result-v1:test-result',
        output: { stdout: '/tmp/repo', exitCode: 0 },
      },
    })).resolves.toEqual({ projected: true, kind: 'tool-result' });

    expect(runtimeMessageDeltaBridge.flushAll).toHaveBeenCalledWith({ reason: 'tool-call-boundary' });
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'codex',
      {
        type: 'tool-call',
        callId: 'call-1',
        name: 'Bash',
        input: { command: 'pwd' },
        id: 'acp-call-v1:test-call',
      },
      {
        localId: 'acp-call-v1:test-call',
        meta: {
          source: 'runtime',
          runtimeEventKind: 'tool-call',
          runtimeTurnId: 'turn-1',
        },
        provenance: { kind: 'non_dependent', source: 'external' },
      },
    );
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'codex',
      {
        type: 'tool-result',
        callId: 'call-1',
        output: { stdout: '/tmp/repo', exitCode: 0 },
        id: 'acp-result-v1:test-result',
      },
      {
        localId: 'acp-result-v1:test-result',
        meta: {
          source: 'runtime',
          runtimeEventKind: 'tool-result',
          runtimeTurnId: 'turn-1',
        },
        provenance: { kind: 'non_dependent', source: 'external' },
      },
    );
    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
  });

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
        localId: ' opaque-local-user-1 ',
        meta: { terminalOrigin: true },
      },
    })).resolves.toEqual({ projected: true, kind: 'transcript-user-text' });

    expect(session.sendUserTextMessage).toHaveBeenCalledWith('terminal-origin prompt', {
      localId: ' opaque-local-user-1 ',
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
        agentId: 'opencode',
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
        provenance: { kind: 'non_dependent', source: 'external' },
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
        localId: 'wrong-session-user-1',
      },
    })).resolves.toEqual({ projected: false, reason: 'session_mismatch' });

    expect(session.sendUserTextMessage).not.toHaveBeenCalled();
    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
  });
});
