import { RuntimeEventV1Schema, type RuntimeEventV1 } from '@happier-dev/protocol/runtime';
import { describe, expect, it, vi } from 'vitest';

import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';

import { createExternalSessionTerminalFollowProjector } from './terminalFollowProjection';

describe('createExternalSessionTerminalFollowProjector', () => {
  it('projects authoritative agent items through strict runtime events and treats user rows as echoes', async () => {
    const projected: RuntimeEventV1[] = [];
    const projectRuntimeEvent = vi.fn(async (event: RuntimeEventV1) => {
      projected.push(RuntimeEventV1Schema.parse(event));
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
          data: { type: 'text', text: 'inspect this' },
        },
        {
          id: 'agent-1',
          timestampMs: 11,
          kind: 'agent',
          data: { type: 'text', text: 'I will inspect it.' },
        },
        {
          id: 'tool-1',
          timestampMs: 12,
          kind: 'event',
          data: {
            type: 'tool-call',
            callId: 'tool-1',
            name: 'read',
            input: { path: 'README.md' },
            id: 'tool-1',
          },
        },
      ],
    });

    expect(projectRuntimeEvent).toHaveBeenCalledTimes(2);
    expect(projected).toEqual([
      {
        kind: 'transcript-agent-message-committed',
        sessionId: 'session-1',
        emittedAtMs: 11,
        agentId: 'antigravity',
        localId: 'agent-1',
        body: { type: 'message', message: 'I will inspect it.' },
      },
      {
        kind: 'transcript-agent-message-committed',
        sessionId: 'session-1',
        emittedAtMs: 12,
        agentId: 'antigravity',
        localId: 'tool-1',
        body: {
          type: 'tool-call',
          callId: 'tool-1',
          name: 'read',
          input: { path: 'README.md' },
          id: 'tool-1',
        },
      },
    ]);
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

  it('does not manufacture transcript rows for provider progress records without a canonical transcript role', async () => {
    const projectRuntimeEvent = vi.fn(async () => ({ projected: true as const }));
    const publish = createExternalSessionTerminalFollowProjector({
      sessionId: 'session-1',
      agentId: 'antigravity',
      projectRuntimeEvent,
    });

    await publish({
      kind: 'data',
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      items: [{
        id: 'checkpoint-1',
        timestampMs: 10,
        kind: 'event',
        data: { type: 'antigravity_checkpoint', checkpointId: 'checkpoint-1' },
      }],
    });

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
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      items: [
        {
          id: 'user-echo-1',
          timestampMs: 10,
          kind: 'user',
          data: { type: 'text', text: 'inspect this' },
        },
        {
          id: 'agent-1',
          timestampMs: 11,
          kind: 'agent',
          data: { type: 'text', text: 'I will inspect it.' },
        },
      ],
    });

    expect(session.sendUserTextMessage).not.toHaveBeenCalled();
    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'antigravity',
      { type: 'message', message: 'I will inspect it.' },
      {
        localId: 'agent-1',
        provenance: { kind: 'non_dependent', source: 'external' },
      },
    );
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
        data: { type: 'text' },
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
        data: { type: 'text', text: 'hello' },
      }],
    })).rejects.toThrow('external_session_terminal_transcript_projection_rejected');
  });
});
