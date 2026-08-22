import { describe, expect, it, vi } from 'vitest';

import {
  AgentSessionRuntimeEventV1Schema,
  type AgentSessionRuntimeEventV1,
} from '@happier-dev/protocol';

let nextRuntimeEventSequence = 0;

function canonicalRuntimeEvent(input: Readonly<Record<string, unknown>>): AgentSessionRuntimeEventV1 {
  return AgentSessionRuntimeEventV1Schema.parse({
    sequence: ++nextRuntimeEventSequence,
    ...input,
  });
}

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
      event: canonicalRuntimeEvent({
        kind: 'message-delta',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'turn-1',
        channel: 'assistant',
        text: 'Hello ',
      }),
    })).resolves.toEqual({ projected: true, kind: 'message-delta' });
    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'message-delta',
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'turn-1',
        channel: 'assistant',
        text: 'world',
      }),
    })).resolves.toEqual({ projected: true, kind: 'message-delta' });
    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'turn-complete',
        sessionId: 'session-1',
        emittedAtMs: 3,
        turnId: 'turn-1',
      }),
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

  it('projects canonical assistant deltas through the same projection contract', async () => {
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
      event: canonicalRuntimeEvent({
        kind: 'message-delta',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'turn-1',
        channel: 'assistant',
        text: 'Claude delta shape',
      }),
    })).resolves.toEqual({ projected: true, kind: 'message-delta' });
    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'turn-complete',
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'turn-1',
      }),
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
      event: canonicalRuntimeEvent({
        kind: 'message-delta',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'turn-1',
        channel: 'reasoning',
        text: 'Internal chain of thought',
      }),
    })).resolves.toEqual({ projected: true, kind: 'message-delta' });
    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'turn-complete',
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'turn-1',
      }),
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
    const { createAcpToolIdentity } = await import('@/agent/acp/toolCalls');
    const runtimeMessageDeltaBridge = {
      appendAssistantDelta: vi.fn(),
      appendThinkingDelta: vi.fn(),
      flushAll: vi.fn(async () => []),
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
      event: canonicalRuntimeEvent({
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        toolName: 'Bash',
        input: { command: 'pwd' },
      }),
    })).resolves.toEqual({ projected: true, kind: 'tool-call' });
    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'codex',
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'tool-result',
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        output: { stdout: '/tmp/repo', exitCode: 0 },
      }),
    })).resolves.toEqual({ projected: true, kind: 'tool-result' });

    const toolIdentity = createAcpToolIdentity({
      sessionId: 'session-1',
      turnId: 'turn-1',
      sidechainId: null,
      toolCallId: 'call-1',
    });
    expect(runtimeMessageDeltaBridge.flushAll).toHaveBeenCalledWith({ reason: 'tool-call-boundary' });
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'codex',
      {
        type: 'tool-call',
        callId: 'call-1',
        name: 'Bash',
        input: { command: 'pwd' },
        id: toolIdentity.callLocalId,
      },
      {
        localId: toolIdentity.callLocalId,
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
        id: toolIdentity.resultLocalId,
      },
      {
        localId: toolIdentity.resultLocalId,
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

  it('projects a committed external tool call without a streamed delta bridge', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const { createAcpToolIdentity } = await import('@/agent/acp/toolCalls');
    const enqueueAgentMessageCommitted = vi.fn(async () => ({
      persisted: true as const,
      delivered: false as const,
    }));
    const session = {
      sessionId: 'session-1',
      enqueueAgentMessageCommitted,
    };
    const toolIdentity = createAcpToolIdentity({
      sessionId: 'session-1',
      turnId: 'external-call-1',
      sidechainId: null,
      toolCallId: 'external-call-1',
    });

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'codex',
      event: canonicalRuntimeEvent({
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'external-call-1',
        toolCallId: 'external-call-1',
        toolName: 'read_file',
        input: { path: '/tmp/a' },
      }),
    })).resolves.toEqual({ projected: true, kind: 'tool-call' });

    expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'codex',
      {
        type: 'tool-call',
        callId: 'external-call-1',
        name: 'read_file',
        input: { path: '/tmp/a' },
        id: toolIdentity.callLocalId,
      },
      {
        localId: toolIdentity.callLocalId,
        meta: {
          source: 'runtime',
          runtimeEventKind: 'tool-call',
          runtimeTurnId: 'external-call-1',
        },
        provenance: { kind: 'non_dependent', source: 'external' },
      },
    );
  });

  it('projects runtime user text evidence through the host session transcript port', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      enqueueUserTextMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      event: canonicalRuntimeEvent({
        kind: 'transcript-message-committed',
        sessionId: 'session-1',
        emittedAtMs: 1,
        text: 'terminal-origin prompt',
        messageId: 'runtime-user-1',
        role: 'user',
      }),
    })).resolves.toEqual({ projected: true, kind: 'transcript-message-committed' });

    expect(session.enqueueUserTextMessageCommitted).toHaveBeenCalledWith('terminal-origin prompt', {
      localId: 'runtime-user-1',
      createdAt: 1,
      updatedAt: 1,
      provenance: { kind: 'non_dependent', source: 'external' },
    });
  });

  it('fences terminal durable transcript admission after its supplied deadline', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const enqueueAgentMessageCommitted = vi.fn(async () => ({
      persisted: true as const,
      delivered: false as const,
    }));
    const controller = new AbortController();
    controller.abort();
    const session = {
      sessionId: 'session-1',
      enqueueAgentMessageCommitted,
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'claude',
      event: canonicalRuntimeEvent({
        kind: 'transcript-message-committed',
        sessionId: 'session-1',
        emittedAtMs: 1,
        messageId: 'terminal-agent-1',
        role: 'assistant',
        text: 'late terminal output',
      }),
      admission: {
        signal: controller.signal,
        deadlineAtMs: 2,
      },
    })).rejects.toMatchObject({
      code: 'runtime_transcript_required_admission_failed',
      reason: 'admission_expired',
      eventKind: 'transcript-message-committed',
    });
    expect(enqueueAgentMessageCommitted).not.toHaveBeenCalled();
  });

  it('maps a canonical durable admission expiry to the terminal resync reason', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const { CommittedTranscriptAdmissionExpiredError } = await import('@/api/session/transcriptPort');
    const session = {
      sessionId: 'session-1',
      enqueueAgentMessageCommitted: vi.fn(async () => {
        throw new CommittedTranscriptAdmissionExpiredError();
      }),
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'claude',
      event: canonicalRuntimeEvent({
        kind: 'transcript-message-committed',
        sessionId: 'session-1',
        emittedAtMs: 1,
        messageId: 'terminal-agent-expired-during-custody',
        role: 'assistant',
        text: 'terminal output that exceeded its admission window',
      }),
      admission: {
        signal: new AbortController().signal,
      },
    })).rejects.toMatchObject({
      code: 'runtime_transcript_required_admission_failed',
      reason: 'admission_expired',
      eventKind: 'transcript-message-committed',
    });
  });

  it('fails closed when runtime user text is rejected by durable custody', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      enqueueUserTextMessageCommitted: vi.fn(async () => ({ persisted: false as const, delivered: false as const })),
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      event: canonicalRuntimeEvent({
        kind: 'transcript-message-committed',
        sessionId: 'session-1',
        emittedAtMs: 1,
        text: 'terminal-origin prompt',
        messageId: 'runtime-user-1',
        role: 'user',
      }),
    })).rejects.toMatchObject({
      code: 'runtime_transcript_required_admission_failed',
      reason: 'durable_custody_rejected',
      eventKind: 'transcript-message-committed',
    });
  });

  it('projects canonical turn cancellations through the durable transcript queue', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    };
    const runtimeMessageDeltaBridge = {
      appendAssistantDelta: vi.fn(),
      appendThinkingDelta: vi.fn(),
      flushAll: vi.fn(async () => []),
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'opencode',
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        sessionId: 'session-1',
        emittedAtMs: 1,
        kind: 'turn-cancelled',
        turnId: 'turn-1',
        agentTurnId: 'agent-turn-1',
        cause: 'user',
      }),
    })).resolves.toEqual({ projected: true, kind: 'turn-cancelled' });

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'turn_cancelled', id: 'agent-turn-1' },
      {
        localId: 'agent-turn-1:turn_cancelled',
        meta: {
          source: 'runtime',
          runtimeEventKind: 'turn-cancelled',
          runtimeTurnId: 'turn-1',
        },
        createdAt: 1,
        updatedAt: 1,
        provenance: { kind: 'non_dependent', source: 'external' },
      },
    );
    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
  });

  it('rejects a final stable transcript event when the durable queue declines custody', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: false as const, delivered: false as const })),
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'opencode',
      event: canonicalRuntimeEvent({
        kind: 'transcript-message-committed',
        sessionId: 'session-1',
        emittedAtMs: 1,
        messageId: 'turn-1:assistant',
        role: 'assistant',
        text: 'Required final answer',
      }),
    })).rejects.toMatchObject({
      code: 'runtime_transcript_required_admission_failed',
      reason: 'durable_custody_rejected',
      eventKind: 'transcript-message-committed',
    });
  });

  it('rejects terminal settlement when a streamed final summary lacks durable custody', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
    };
    const runtimeMessageDeltaBridge = {
      appendAssistantDelta: vi.fn(),
      appendThinkingDelta: vi.fn(),
      flushAll: vi.fn(async () => [{
        assistant: { sawText: true, didDurablyFlush: false },
        assistantRoot: { sawText: true, didDurablyFlush: false },
        thinking: { sawText: false, didDurablyFlush: false },
        thinkingRoot: { sawText: false, didDurablyFlush: false },
        segments: [{
          kind: 'assistant' as const,
          sidechainId: null,
          sawText: true,
          didDurablyFlush: false,
          lastCommittedState: null,
        }],
      }]),
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'turn-complete',
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'turn-1',
      }),
    })).rejects.toMatchObject({
      code: 'runtime_transcript_required_admission_failed',
      reason: 'streamed_final_not_durable',
      eventKind: 'turn-complete',
    });
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
      event: canonicalRuntimeEvent({
        kind: 'transcript-message-committed',
        sessionId: 'session-2',
        emittedAtMs: 1,
        text: 'wrong session',
        messageId: 'wrong-session-user-1',
        role: 'user',
      }),
    })).resolves.toEqual({ projected: false, reason: 'session_mismatch' });

  });

  it('rejects a final stable transcript event when no durable queue is available', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
    };

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'opencode',
      event: canonicalRuntimeEvent({
        kind: 'transcript-message-committed',
        sessionId: 'session-1',
        emittedAtMs: 1,
        messageId: 'turn-1:turn-failed',
        role: 'assistant',
        text: 'Required final failure marker',
      }),
    })).rejects.toMatchObject({
      code: 'runtime_transcript_required_admission_failed',
      reason: 'durable_enqueue_unavailable',
      eventKind: 'transcript-message-committed',
    });

    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
  });
});
