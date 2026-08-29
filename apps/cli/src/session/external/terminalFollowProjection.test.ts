import {
  AgentSessionRuntimeEventSchema,
  type AgentSessionRuntimeEvent,
} from '@happier-dev/protocol/runtime';
import { describe, expect, it, vi } from 'vitest';

import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';

import { createExternalSessionTerminalFollowProjector } from './terminalFollowProjection';

describe('createExternalSessionTerminalFollowProjector', () => {
  it('threads terminal admission through the canonical durable projector', async () => {
    const projectRuntimeEvent = vi.fn(async () => ({ projected: true as const }));
    const publish = createExternalSessionTerminalFollowProjector({
      sessionId: 'session-1',
      agentId: 'claude',
      projectRuntimeEvent,
    });
    const admission = {
      signal: new AbortController().signal,
      deadlineAtMs: 25_000,
    };

    await publish({
      kind: 'data',
      phase: 'initial_replay',
      fromCursor: null,
      nextCursor: 'cursor-1',
      items: [{
        id: 'agent-1',
        timestampMs: 10,
        kind: 'agent',
        data: { role: 'agent', content: { type: 'text', text: 'durable output' } },
      }],
    }, admission);

    expect(projectRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'transcript-message-committed',
        messageId: 'agent-1',
      }),
      admission,
    );
  });

  it('projects canonical agent envelopes and suppresses explicitly classified host prompt echoes', async () => {
    const projected: AgentSessionRuntimeEvent[] = [];
    const projectRuntimeEvent = vi.fn(async (event: AgentSessionRuntimeEvent) => {
      projected.push(AgentSessionRuntimeEventSchema.parse(event));
      return { projected: true as const };
    });
    const publish = createExternalSessionTerminalFollowProjector({
      sessionId: 'session-1',
      agentId: 'antigravity',
      projectRuntimeEvent,
    });

    await publish({
      kind: 'data',
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      items: [
        {
          id: 'user-echo-1',
          timestampMs: 10,
          kind: 'user',
          userProjection: 'host_prompt_echo',
          data: { role: 'user', content: { type: 'text', text: 'inspect this' } },
        },
        {
          id: 'agent-1',
          localId: 'provider-fact-agent-1',
          timestampMs: 11,
          kind: 'agent',
          data: { role: 'agent', content: { type: 'text', text: 'I will inspect it.' } },
        },
        {
          id: 'reasoning-1',
          timestampMs: 12,
          kind: 'event',
          data: { role: 'agent', content: {
              type: 'reasoning',
              message: 'I should inspect the repository first.',
            } },
        },
      ],
    });

    expect(projectRuntimeEvent).toHaveBeenCalledTimes(2);
    expect(projected).toEqual([
      {
        kind: 'transcript-message-committed',
        sequence: 1,
        sessionId: 'session-1',
        emittedAtMs: 11,
        messageId: 'provider-fact-agent-1',
        role: 'assistant',
        text: 'I will inspect it.',
      },
      {
        kind: 'transcript-message-committed',
        sequence: 2,
        sessionId: 'session-1',
        emittedAtMs: 12,
        messageId: 'reasoning-1',
        role: 'reasoning',
        text: 'I should inspect the repository first.',
      },
    ]);
  });

  it('projects canonical tool calls and results through the runtime tool-event contract', async () => {
    const projected: AgentSessionRuntimeEvent[] = [];
    const publish = createExternalSessionTerminalFollowProjector({
      sessionId: 'session-1',
      agentId: 'codex',
      projectRuntimeEvent: async (event) => {
        projected.push(AgentSessionRuntimeEventSchema.parse(event));
        return { projected: true as const };
      },
    });

    await publish({
      kind: 'data',
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      items: [
        {
          id: 'tool-call-row-1',
          timestampMs: 11,
          kind: 'event',
          data: {
            role: 'agent',
            content: {
              type: 'codex',
              data: {
                type: 'tool-call',
                callId: 'tool-call-1',
                name: 'read_file',
                input: { path: '/workspace/file.ts' },
                sidechainId: 'sidechain-1',
              },
            },
          },
        },
        {
          id: 'tool-result-row-1',
          timestampMs: 12,
          kind: 'event',
          data: {
            role: 'agent',
            content: {
              type: 'codex',
              data: {
                type: 'tool-call-result',
                callId: 'tool-call-1',
                output: { error: 'permission denied' },
                isError: true,
                sidechainId: 'sidechain-1',
              },
            },
          },
        },
      ],
    });

    expect(projected).toEqual([
      {
        kind: 'tool-call',
        sequence: 1,
        sessionId: 'session-1',
        emittedAtMs: 11,
        turnId: 'tool-call-1',
        toolCallId: 'tool-call-1',
        toolName: 'read_file',
        input: { path: '/workspace/file.ts' },
        sidechainId: 'sidechain-1',
      },
      {
        kind: 'tool-result',
        sequence: 2,
        sessionId: 'session-1',
        emittedAtMs: 12,
        turnId: 'tool-call-1',
        toolCallId: 'tool-call-1',
        output: { error: 'permission denied' },
        isError: true,
        sidechainId: 'sidechain-1',
      },
    ]);
  });

  it('carries the top-level Protocol sidechainId across user, tool, and message projections', async () => {
    const projected: AgentSessionRuntimeEvent[] = [];
    const publish = createExternalSessionTerminalFollowProjector({
      sessionId: 'session-1',
      agentId: 'claude',
      projectRuntimeEvent: async (event) => {
        projected.push(AgentSessionRuntimeEventSchema.parse(event));
        return { projected: true as const };
      },
    });

    await publish({
      kind: 'data',
      phase: 'initial_replay',
      fromCursor: null,
      nextCursor: 'cursor-1',
      items: [
        {
          id: 'sidechain-user-row',
          localId: 'sidechain-user-fact',
          sidechainId: 'sidechain-top',
          userProjection: 'source_fact',
          timestampMs: 10,
          kind: 'user',
          data: {
            role: 'user',
            content: { type: 'text', text: 'sidechain prompt' },
          },
        },
        {
          id: 'sidechain-tool-row',
          sidechainId: 'sidechain-top',
          timestampMs: 11,
          kind: 'event',
          data: {
            role: 'agent',
            content: {
              type: 'codex',
              data: {
                type: 'tool-call',
                callId: 'tool-call-2',
                name: 'read_file',
                input: { path: '/workspace/file.ts' },
              },
            },
          },
        },
        {
          id: 'sidechain-message-row',
          sidechainId: 'sidechain-top',
          timestampMs: 12,
          kind: 'agent',
          data: {
            role: 'agent',
            content: {
              type: 'codex',
              data: { type: 'message', message: 'sidechain reply' },
            },
          },
        },
      ],
    });

    expect(projected).toEqual([
      expect.objectContaining({
        kind: 'transcript-message-committed',
        role: 'user',
        messageId: 'sidechain-user-fact',
        sidechainId: 'sidechain-top',
      }),
      expect.objectContaining({
        kind: 'tool-call',
        toolCallId: 'tool-call-2',
        sidechainId: 'sidechain-top',
      }),
      expect.objectContaining({
        kind: 'transcript-message-committed',
        role: 'assistant',
        text: 'sidechain reply',
        sidechainId: 'sidechain-top',
      }),
    ]);
  });

  it('prefers the top-level sidechainId over a nested provider body value', async () => {
    const projected: AgentSessionRuntimeEvent[] = [];
    const publish = createExternalSessionTerminalFollowProjector({
      sessionId: 'session-1',
      agentId: 'codex',
      projectRuntimeEvent: async (event) => {
        projected.push(AgentSessionRuntimeEventSchema.parse(event));
        return { projected: true as const };
      },
    });

    await publish({
      kind: 'data',
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      items: [{
        id: 'sidechain-precedence-row',
        sidechainId: 'sidechain-top',
        timestampMs: 11,
        kind: 'event',
        data: {
          role: 'agent',
          content: {
            type: 'codex',
            data: {
              type: 'tool-call',
              callId: 'tool-call-3',
              name: 'read_file',
              input: {},
              sidechainId: 'sidechain-nested',
            },
          },
        },
      }],
    });

    expect(projected).toEqual([
      expect.objectContaining({
        kind: 'tool-call',
        toolCallId: 'tool-call-3',
        sidechainId: 'sidechain-top',
      }),
    ]);
  });

  it('persists terminal-followed tool calls and results through the canonical writer without a delta bridge', async () => {
    const enqueueAgentMessageCommitted = vi.fn(async () => ({
      persisted: true as const,
      delivered: false as const,
    }));
    const session = {
      sessionId: 'session-1',
      enqueueAgentMessageCommitted,
    };
    const publish = createExternalSessionTerminalFollowProjector({
      sessionId: session.sessionId,
      agentId: 'codex',
      projectRuntimeEvent: async (event, admission) => await projectRuntimeTranscriptEvent({
        session,
        provider: 'codex',
        event,
        ...(admission === undefined ? {} : { admission }),
      }),
    });
    const admission = {
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 60_000,
    };

    await publish({
      kind: 'data',
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      items: [
        {
          id: 'tool-call-row-1',
          timestampMs: 11,
          kind: 'event',
          data: {
            role: 'agent',
            content: {
              type: 'codex',
              data: {
                type: 'tool-call',
                callId: 'tool-call-1',
                name: 'read_file',
                input: { path: '/workspace/file.ts' },
              },
            },
          },
        },
        {
          id: 'tool-result-row-1',
          timestampMs: 12,
          kind: 'event',
          data: {
            role: 'agent',
            content: {
              type: 'codex',
              data: {
                type: 'tool-call-result',
                callId: 'tool-call-1',
                output: { ok: true },
                isError: false,
              },
            },
          },
        },
      ],
    }, admission);

    expect(enqueueAgentMessageCommitted).toHaveBeenCalledTimes(2);
    expect(enqueueAgentMessageCommitted).toHaveBeenNthCalledWith(
      1,
      'codex',
      expect.objectContaining({
        type: 'tool-call',
        callId: 'tool-call-1',
        name: 'read_file',
        input: { path: '/workspace/file.ts' },
      }),
      expect.objectContaining({
        provenance: { kind: 'non_dependent', source: 'external' },
        admission,
      }),
    );
    expect(enqueueAgentMessageCommitted).toHaveBeenNthCalledWith(
      2,
      'codex',
      expect.objectContaining({
        type: 'tool-result',
        callId: 'tool-call-1',
        output: { ok: true },
        isError: false,
      }),
      expect.objectContaining({
        provenance: { kind: 'non_dependent', source: 'external' },
        admission,
      }),
    );
  });

  it('imports an explicitly source-authoritative user fact only during initial replay', async () => {
    const projected: AgentSessionRuntimeEvent[] = [];
    const publish = createExternalSessionTerminalFollowProjector({
      sessionId: 'session-1',
      agentId: 'claude',
      projectRuntimeEvent: async (event) => {
        projected.push(AgentSessionRuntimeEventSchema.parse(event));
        return { projected: true as const };
      },
    });
    const item = {
      id: 'claude:session.jsonl:000000000042',
      localId: 'claude-jsonl:main:user:user-1',
      timestampMs: 10,
      kind: 'user' as const,
      userProjection: 'source_fact' as const,
      data: { role: 'user', content: { type: 'text', text: 'typed outside Happier' } },
    };

    await publish({
      kind: 'data',
      phase: 'initial_replay',
      fromCursor: null,
      nextCursor: 'cursor-1',
      items: [item],
    });
    await expect(publish({
      kind: 'data',
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      items: [item],
    })).rejects.toThrow('external_session_terminal_transcript_item_invalid');

    expect(projected).toEqual([{
      kind: 'transcript-message-committed',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 10,
      messageId: 'claude-jsonl:main:user:user-1',
      role: 'user',
      text: 'typed outside Happier',
    }]);
  });

  it('projects terminal-origin user rows in replay and live phases and rejects missing classification', async () => {
    const projected: AgentSessionRuntimeEvent[] = [];
    const publish = createExternalSessionTerminalFollowProjector({
      sessionId: 'session-1',
      agentId: 'claude',
      projectRuntimeEvent: async (event) => {
        projected.push(AgentSessionRuntimeEventSchema.parse(event));
        return { projected: true as const };
      },
    });
    const terminalItem = {
      id: 'terminal-user-1',
      localId: 'terminal-local-1',
      timestampMs: 10,
      kind: 'user' as const,
      userProjection: 'terminal_origin' as const,
      data: { role: 'user', content: { type: 'text', text: 'typed in terminal' } },
    };

    await publish({
      kind: 'data',
      phase: 'initial_replay',
      fromCursor: null,
      nextCursor: 'cursor-1',
      items: [terminalItem],
    });
    await publish({
      kind: 'data',
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      items: [{ ...terminalItem, id: 'terminal-user-2', localId: 'terminal-local-2' }],
    });
    await expect(publish({
      kind: 'data',
      fromCursor: 'cursor-2',
      nextCursor: 'cursor-3',
      items: [{
        id: 'unclassified-user',
        timestampMs: 12,
        kind: 'user',
        data: { role: 'user', content: { type: 'text', text: 'unknown origin' } },
      }],
    })).rejects.toThrow('external_session_terminal_transcript_item_invalid');

    expect(projected.map((event) => event.kind === 'transcript-message-committed' ? event.role : null)).toEqual([
      'user',
      'user',
    ]);
  });

  it('suppresses host prompt echoes in replay and live phases without invoking the writer', async () => {
    const projectRuntimeEvent = vi.fn(async () => ({ projected: true as const }));
    const publish = createExternalSessionTerminalFollowProjector({
      sessionId: 'session-1',
      agentId: 'claude',
      projectRuntimeEvent,
    });
    const item = {
      id: 'echo-1',
      timestampMs: 10,
      kind: 'user' as const,
      userProjection: 'host_prompt_echo' as const,
      data: { role: 'user', content: { type: 'text', text: 'owned by Happier' } },
    };

    await publish({
      kind: 'data',
      phase: 'initial_replay',
      fromCursor: null,
      nextCursor: 'cursor-1',
      items: [item],
    });
    await publish({
      kind: 'data',
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      items: [item],
    });

    expect(projectRuntimeEvent).not.toHaveBeenCalled();
  });

  it('does not manufacture transcript rows for resync or termination control events', async () => {
    const projectRuntimeEvent = vi.fn(async () => ({ projected: true as const }));
    const publish = createExternalSessionTerminalFollowProjector({
      sessionId: 'session-1',
      agentId: 'antigravity',
      projectRuntimeEvent,
    });

    await publish({
      kind: 'resyncRequired',
      reason: 'cursorDiscontinuity',
      cursor: 'cursor-1',
    });
    await publish({
      kind: 'terminated',
      reason: 'disposed',
      cursor: 'cursor-2',
    });

    expect(projectRuntimeEvent).not.toHaveBeenCalled();
  });

  it('rejects unsupported provider records instead of dropping them while the cursor advances', async () => {
    const projectRuntimeEvent = vi.fn(async () => ({ projected: true as const }));
    const publish = createExternalSessionTerminalFollowProjector({
      sessionId: 'session-1',
      agentId: 'antigravity',
      projectRuntimeEvent,
    });

    await expect(publish({
      kind: 'data',
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      items: [{
        id: 'checkpoint-1',
        timestampMs: 10,
        kind: 'event',
        data: { role: 'agent', content: { type: 'antigravity_checkpoint', checkpointId: 'checkpoint-1' } },
      }],
    })).rejects.toThrow('external_session_terminal_transcript_item_invalid');

    expect(projectRuntimeEvent).not.toHaveBeenCalled();
  });

  it('reaches the canonical durable hosted transcript writer without duplicating the user echo', async () => {
    const enqueueAgentMessageCommitted = vi.fn(async () => ({
      persisted: true,
      delivered: true,
    }));
    const session = {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      enqueueAgentMessageCommitted,
    };
    const publish = createExternalSessionTerminalFollowProjector({
      sessionId: session.sessionId,
      agentId: 'antigravity',
      projectRuntimeEvent: async (event) => await projectRuntimeTranscriptEvent({
        session,
        provider: 'antigravity',
        event,
      }),
    });

    await publish({
      kind: 'data',
      phase: 'initial_replay',
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      items: [
        {
          id: 'user-echo-1',
          timestampMs: 10,
          kind: 'user',
          userProjection: 'host_prompt_echo',
          data: { role: 'user', content: { type: 'text', text: 'inspect this' } },
        },
        {
          id: 'agent-1',
          localId: 'provider-fact-agent-1',
          timestampMs: 11,
          kind: 'agent',
          data: { role: 'agent', content: { type: 'text', text: 'I will inspect it.' } },
        },
      ],
    });

    expect(session.sendUserTextMessage).not.toHaveBeenCalled();
    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'antigravity',
      { type: 'message', message: 'I will inspect it.' },
      {
        localId: 'provider-fact-agent-1',
        createdAt: 11,
        updatedAt: 11,
        provenance: { kind: 'non_dependent', source: 'external' },
      },
    );
  });

  it('rejects a semantic body that cannot form a strict canonical runtime event before invoking the writer', async () => {
    const projectRuntimeEvent = vi.fn(async () => ({ projected: true as const }));
    const publish = createExternalSessionTerminalFollowProjector({
      sessionId: 'session-1',
      agentId: 'antigravity',
      projectRuntimeEvent,
    });

    await expect(publish({
      kind: 'data',
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      items: [{
        id: 'reasoning-1',
        timestampMs: 11,
        kind: 'event',
        data: {
          role: 'agent',
          content: {
            type: 'reasoning',
            message: 'I should inspect the repository first.',
            sidechainId: 42,
          },
        },
      }],
    })).rejects.toThrow('external_session_terminal_transcript_item_invalid');

    expect(projectRuntimeEvent).not.toHaveBeenCalled();
  });

  it('fails the follow-local publication when an item cannot form a strict runtime transcript event', async () => {
    const projectRuntimeEvent = vi.fn(async () => ({ projected: true as const }));
    const publish = createExternalSessionTerminalFollowProjector({
      sessionId: 'session-1',
      agentId: 'antigravity',
      projectRuntimeEvent,
    });

    await expect(publish({
      kind: 'data',
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      items: [{
        id: 'invalid-1',
        kind: 'agent',
        timestampMs: 1,
        data: { role: 'agent', content: { type: 'text' } },
      }],
    })).rejects.toThrow('external_session_terminal_transcript_item_invalid');
    expect(projectRuntimeEvent).not.toHaveBeenCalled();
  });

  it('fails when the canonical runtime projector rejects an otherwise valid item', async () => {
    const projectRuntimeEvent = vi.fn(async () => ({
      projected: false as const,
      reason: 'session_mismatch',
    }));
    const publish = createExternalSessionTerminalFollowProjector({
      sessionId: 'session-1',
      agentId: 'antigravity',
      projectRuntimeEvent,
    });

    await expect(publish({
      kind: 'data',
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      items: [{
        id: 'agent-1',
        timestampMs: 11,
        kind: 'agent',
        data: { role: 'agent', content: { type: 'text', text: 'hello' } },
      }],
    })).rejects.toThrow('external_session_terminal_transcript_projection_rejected');
  });
});
