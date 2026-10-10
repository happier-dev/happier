import { describe, expect, it, vi } from 'vitest';

import {
  AgentSessionRuntimeEventV1Schema,
  type AgentSessionRuntimeEventV1,
} from '@happier-dev/protocol';
import type { RuntimeTranscriptProjectionSession } from './projectRuntimeTranscriptEvent';

type EnqueueAgentMessageCommitted = NonNullable<
  RuntimeTranscriptProjectionSession['enqueueAgentMessageCommitted']
>;
type CommittedAgentMessageBody = Parameters<EnqueueAgentMessageCommitted>[1];
type CommittedToolCallBody = Extract<CommittedAgentMessageBody, { type: 'tool-call' }>;

function createCommittedAgentMessageCapture() {
  const bodies: CommittedAgentMessageBody[] = [];
  const enqueueAgentMessageCommitted = vi.fn<EnqueueAgentMessageCommitted>(async (_provider, body) => {
    bodies.push(body);
    return { persisted: true, delivered: false };
  });
  return { bodies, enqueueAgentMessageCommitted };
}

function findCanonicalDiffCall(bodies: readonly CommittedAgentMessageBody[]): CommittedToolCallBody {
  const body = bodies.find(
    (candidate): candidate is CommittedToolCallBody => candidate.type === 'tool-call' && candidate.name === 'Diff',
  );
  expect(body).toBeDefined();
  if (!body) throw new Error('Expected a committed canonical Diff tool call');
  return body;
}

let nextRuntimeEventSequence = 0;

function canonicalRuntimeEvent(input: Readonly<Record<string, unknown>>): AgentSessionRuntimeEventV1 {
  return AgentSessionRuntimeEventV1Schema.parse({
    sequence: ++nextRuntimeEventSequence,
    ...input,
  });
}

describe('projectRuntimeTranscriptEvent', () => {
  it('retains native MCP counts only with the host selected binding identities and removes native names', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const capture = createCommittedAgentMessageCapture();
    const event = canonicalRuntimeEvent({ kind: 'mcp-tool-usage', sessionId: 'session-1', turnId: 'turn',
      emittedAtMs: 200, window: { startMs: 100, endMs: 200 }, coverage: 'complete',
      servers: [{ serverName: 'private-server-name', toolCallCount: 0, schemaBytes: null }] });
    const session = { sessionId: 'session-1', enqueueAgentMessageCommitted: capture.enqueueAgentMessageCommitted };
    await projectRuntimeTranscriptEvent({ session, provider: 'claude', event, mcpBindingIdentities: {
      'private-server-name': { serverId: 'server', bindingId: 'binding', serverRevision: 10, bindingRevision: 20, catalogRevision: 40 },
    } });
    expect(capture.bodies).toMatchObject([{ type: 'event', data: { type: 'mcp-binding-usage', usage: {
      sessionId: 'session-1', turnId: 'turn', coverage: 'complete', window: { startMs: 100, endMs: 200 },
      bindings: [{ serverId: 'server', bindingId: 'binding', serverRevision: 10, bindingRevision: 20, catalogRevision: 40,
        toolCallCount: 0, schemaBytes: null }],
    } } }]);
    expect(JSON.stringify(capture.bodies)).not.toContain('private-server-name');
    const absent = createCommittedAgentMessageCapture();
    await projectRuntimeTranscriptEvent({ session: { ...session, enqueueAgentMessageCommitted: absent.enqueueAgentMessageCommitted },
      provider: 'claude', event });
    expect(absent.bodies).toEqual([]);
  });
  it('preserves provider message identities from live deltas through durable commit and cold reconciliation', async () => {
    const { createKeyedStreamedTranscriptBridge } = await import('@/api/session/createKeyedStreamedTranscriptBridge');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const { buildOpenCodeRuntimeTranscriptLocalId } = await import('../../../../../../../packages/plugins/opencode/src/agent/runtime/server/transcript/identity');
    const { openCodeTranscriptIdentityCodec } = await import('../../../../../../../packages/plugins/opencode/src/agent/runtime/server/transcript/committedIdentities');
    const stored = new Map<string, CommittedAgentMessageBody>();
    const liveIds: string[] = [];
    const session = {
      sessionId: 'session-1',
      sendAgentMessageEphemeral: (_provider: unknown, _body: unknown, opts: { localId: string }) => {
        liveIds.push(opts.localId);
        return { accepted: true as const, epoch: 0 };
      },
      enqueueAgentMessageCommitted: async (_provider: unknown, body: CommittedAgentMessageBody, opts: { localId: string }) => {
        stored.set(opts.localId, body);
        return { persisted: true, delivered: false };
      },
    };
    const bridge = createKeyedStreamedTranscriptBridge({ provider: 'opencode', createSessionForStream: () => session });
    const ids = ['assistant-one', 'assistant-two'].map((id) => buildOpenCodeRuntimeTranscriptLocalId('native-session', id));
    for (const [index, messageId] of ids.entries()) {
      for (const text of ['Live ', String(index)]) {
        await projectRuntimeTranscriptEvent({ session, provider: 'opencode', runtimeMessageDeltaBridge: bridge,
          event: canonicalRuntimeEvent({ kind: 'message-delta', sessionId: 'session-1', emittedAtMs: 1,
            turnId: 'same-host-turn', messageId, channel: 'assistant', text }) });
      }
    }
    expect(liveIds).toEqual(expect.arrayContaining(ids));
    await projectRuntimeTranscriptEvent({ session, provider: 'opencode', runtimeMessageDeltaBridge: bridge,
      event: canonicalRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', emittedAtMs: 2, turnId: 'same-host-turn' }) });
    expect([...stored.entries()]).toEqual(ids.map((id, index) => [id, { type: 'message', message: `Live ${index}` }]));
    const facts = ids.map((localId, index) => ({ localId, sourceMessageId: ['assistant-one', 'assistant-two'][index]!, role: 'assistant' as const }));
    expect(openCodeTranscriptIdentityCodec.reconcile({ providerSessionId: 'native-session', facts, metadata: {},
      baseline: { complete: true, rows: [...stored.keys()].map((localId) => ({ localId, role: 'agent' as const, meta: {} })) } })).toEqual({
      committedSourceMessageIds: ['assistant-one', 'assistant-two'], hostAuthoredUserMessageIds: [],
      coverage: { complete: true, unmappedUsers: 0, unmappedAgents: 0 },
    });
  });

  it('persists typed completion evidence when a turn completes without streamed output', async () => {
    const { createKeyedStreamedTranscriptBridge } = await import('@/api/session/createKeyedStreamedTranscriptBridge');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      requiresDurableTurnCompletionMarker: true as const,
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    };
    const runtimeMessageDeltaBridge = createKeyedStreamedTranscriptBridge({
      provider: 'claude',
      createSessionForStream: () => session,
    });

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'claude',
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'turn-complete', sessionId: 'session-1', emittedAtMs: 3, turnId: 'turn-empty',
      }),
    })).resolves.toEqual({ projected: true, kind: 'turn-complete' });

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'claude',
      { type: 'task_complete', id: 'turn-empty' },
      expect.objectContaining({
        localId: 'turn-empty:task_complete',
        meta: { source: 'runtime', runtimeEventKind: 'turn-complete', runtimeTurnId: 'turn-empty' },
      }),
    );
  });

  it('persists typed failure evidence when a Run turn fails without streamed output', async () => {
    const { createKeyedStreamedTranscriptBridge } = await import('@/api/session/createKeyedStreamedTranscriptBridge');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      requiresDurableTurnCompletionMarker: true as const,
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    };
    const runtimeMessageDeltaBridge = createKeyedStreamedTranscriptBridge({
      provider: 'claude',
      createSessionForStream: () => session,
    });

    await expect(projectRuntimeTranscriptEvent({
      session,
      provider: 'claude',
      runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'turn-failed', sessionId: 'session-1', emittedAtMs: 3, turnId: 'turn-empty',
        diagnostic: { code: 'provider_error', severity: 'error' },
      }),
    })).resolves.toEqual({ projected: true, kind: 'turn-failed' });

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'claude',
      { type: 'turn_failed', id: 'turn-empty' },
      expect.objectContaining({
        localId: 'turn-empty:turn_failed',
        meta: { source: 'runtime', runtimeEventKind: 'turn-failed', runtimeTurnId: 'turn-empty' },
      }),
    );
  });

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
      discardStream: vi.fn(),
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
    expect(runtimeMessageDeltaBridge.flushAll).toHaveBeenCalledWith(expect.objectContaining({ reason: 'tool-call-boundary' }));
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

  it('publishes normalized runtime tool changes with provider turn correlation readable by Protocol', async () => {
    const {
      extractCanonicalDiffFiles,
      readTurnChangeToolMetadata,
    } = await import('../../../../../../../packages/protocol/src/sessions/messages/canonicalTurnDiffTool');
    const { NormalizedToolTurnChangeTracker } = await import('@/agent/tools/diff/normalizedToolTurnChangeTracker');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const runtimeMessageDeltaBridge = {
      appendAssistantDelta: vi.fn(),
      appendThinkingDelta: vi.fn(),
      discardStream: vi.fn(),
      flushAll: vi.fn(async () => []),
    };
    const { bodies, enqueueAgentMessageCommitted } = createCommittedAgentMessageCapture();
    const session = { sessionId: 'session-1', enqueueAgentMessageCommitted };
    const normalizedToolTurnChangeTracker = new NormalizedToolTurnChangeTracker({ provider: 'codex' });

    await projectRuntimeTranscriptEvent({
      session,
      provider: 'codex',
      runtimeMessageDeltaBridge,
      normalizedToolTurnChangeTracker,
      toolNormalizationProtocol: 'codex',
      event: canonicalRuntimeEvent({
        kind: 'turn-start', sessionId: 'session-1', emittedAtMs: 1, turnId: 'host-turn-1',
        startedBy: 'provider',
      }),
    });
    await projectRuntimeTranscriptEvent({
      session,
      provider: 'codex',
      runtimeMessageDeltaBridge,
      normalizedToolTurnChangeTracker,
      toolNormalizationProtocol: 'codex',
      event: canonicalRuntimeEvent({
        kind: 'tool-call', sessionId: 'session-1', emittedAtMs: 2, turnId: 'host-turn-1',
        toolCallId: 'edit-1', toolName: 'Edit',
        input: { file_path: 'src/runtime-edit.ts', old_string: 'before', new_string: 'after' },
      }),
    });
    await projectRuntimeTranscriptEvent({
      session,
      provider: 'codex',
      runtimeMessageDeltaBridge,
      normalizedToolTurnChangeTracker,
      toolNormalizationProtocol: 'codex',
      event: canonicalRuntimeEvent({
        kind: 'tool-result', sessionId: 'session-1', emittedAtMs: 3, turnId: 'host-turn-1',
        toolCallId: 'edit-1', output: { status: 'completed' },
      }),
    });
    await projectRuntimeTranscriptEvent({
      session,
      provider: 'codex',
      runtimeMessageDeltaBridge,
      normalizedToolTurnChangeTracker,
      toolNormalizationProtocol: 'codex',
      event: canonicalRuntimeEvent({
        kind: 'turn-complete', sessionId: 'session-1', emittedAtMs: 4, turnId: 'host-turn-1',
        agentTurnId: 'provider-turn-1',
      }),
    });

    const canonicalDiffCall = findCanonicalDiffCall(bodies);
    const metadata = readTurnChangeToolMetadata(canonicalDiffCall.input);
    expect(metadata).toMatchObject({ turnId: 'host-turn-1', provider: 'codex' });
    expect(extractCanonicalDiffFiles(canonicalDiffCall.input, metadata!)).toEqual([
      expect.objectContaining({
        filePath: 'src/runtime-edit.ts',
        source: 'provider_tool',
        confidence: 'exact',
        provider: 'codex',
        agentTurnId: 'provider-turn-1',
        providerMessageId: 'edit-1',
        oldText: 'before',
        newText: 'after',
      }),
    ]);
  });

  it('publishes Codex app-server Patch changes with provider turn correlation readable by Protocol', async () => {
    const {
      extractCanonicalDiffFiles,
      readTurnChangeToolMetadata,
    } = await import('../../../../../../../packages/protocol/src/sessions/messages/canonicalTurnDiffTool');
    const { NormalizedToolTurnChangeTracker } = await import('@/agent/tools/diff/normalizedToolTurnChangeTracker');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const { bodies, enqueueAgentMessageCommitted } = createCommittedAgentMessageCapture();
    const common = {
      session: { sessionId: 'session-patch', enqueueAgentMessageCommitted },
      provider: 'codex' as const,
      runtimeMessageDeltaBridge: {
        appendAssistantDelta: vi.fn(),
        appendThinkingDelta: vi.fn(),
        discardStream: vi.fn(),
        flushAll: vi.fn(async () => []),
      },
      normalizedToolTurnChangeTracker: new NormalizedToolTurnChangeTracker({ provider: 'codex' }),
      toolNormalizationProtocol: 'codex' as const,
    };

    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'turn-start', sessionId: 'session-patch', emittedAtMs: 1, turnId: 'host-turn-patch',
        startedBy: 'provider',
      }),
    });
    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'tool-call', sessionId: 'session-patch', emittedAtMs: 2, turnId: 'host-turn-patch',
        agentTurnId: 'codex-turn-patch', toolCallId: 'patch_1', toolName: 'Patch',
        input: {
          auto_approved: true,
          changes: [{
            path: 'src/file.ts',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1,2 @@\n-old line\n+old line\n+new line\n',
          }],
        },
      }),
    });
    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'tool-result', sessionId: 'session-patch', emittedAtMs: 3, turnId: 'host-turn-patch',
        agentTurnId: 'codex-turn-patch', toolCallId: 'patch_1', output: { success: true },
      }),
    });
    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'turn-complete', sessionId: 'session-patch', emittedAtMs: 4, turnId: 'host-turn-patch',
        agentTurnId: 'codex-turn-patch',
      }),
    });

    const canonicalDiffCall = findCanonicalDiffCall(bodies);
    const metadata = readTurnChangeToolMetadata(canonicalDiffCall.input);
    expect(metadata).toMatchObject({
      turnId: 'host-turn-patch',
      provider: 'codex',
    });
    expect(extractCanonicalDiffFiles(canonicalDiffCall.input, metadata!)).toEqual([
      expect.objectContaining({
        filePath: 'src/file.ts',
        source: 'provider_tool',
        confidence: 'exact',
        provider: 'codex',
        agentTurnId: 'codex-turn-patch',
        providerMessageId: 'patch_1',
        oldText: 'old line\n',
        newText: 'old line\nnew line\n',
      }),
    ]);
  });

  it.each([
    { kind: 'turn-failed' as const, expectedStatus: 'interrupted' as const },
    { kind: 'turn-cancelled' as const, expectedStatus: 'aborted' as const },
  ])('publishes pending normalized changes at the $kind terminal boundary', async ({ kind, expectedStatus }) => {
    const { readTurnChangeToolMetadata } = await import('../../../../../../../packages/protocol/src/sessions/messages/canonicalTurnDiffTool');
    const { NormalizedToolTurnChangeTracker } = await import('@/agent/tools/diff/normalizedToolTurnChangeTracker');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const { bodies, enqueueAgentMessageCommitted } = createCommittedAgentMessageCapture();
    const common = {
      session: { sessionId: 'session-terminal', enqueueAgentMessageCommitted },
      provider: 'codex' as const,
      runtimeMessageDeltaBridge: {
        appendAssistantDelta: vi.fn(),
        appendThinkingDelta: vi.fn(),
        discardStream: vi.fn(),
        flushAll: vi.fn(async () => []),
      },
      normalizedToolTurnChangeTracker: new NormalizedToolTurnChangeTracker({ provider: 'codex' }),
      toolNormalizationProtocol: 'codex' as const,
    };

    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'turn-start', sessionId: 'session-terminal', emittedAtMs: 1, turnId: 'host-turn-terminal',
        startedBy: 'provider',
      }),
    });
    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'tool-call', sessionId: 'session-terminal', emittedAtMs: 2, turnId: 'host-turn-terminal',
        toolCallId: 'edit-terminal', toolName: 'Edit',
        input: { file_path: 'src/terminal.ts', old_string: 'before', new_string: 'after' },
      }),
    });
    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'tool-result', sessionId: 'session-terminal', emittedAtMs: 3, turnId: 'host-turn-terminal',
        toolCallId: 'edit-terminal', output: { status: 'completed' },
      }),
    });
    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind, sessionId: 'session-terminal', emittedAtMs: 4, turnId: 'host-turn-terminal',
        ...(kind === 'turn-failed'
          ? { diagnostic: { code: 'provider_error', severity: 'error' } }
          : { cause: 'user' }),
      }),
    });

    const canonicalDiffCall = findCanonicalDiffCall(bodies);
    expect(readTurnChangeToolMetadata(canonicalDiffCall.input)).toMatchObject({
      turnId: 'host-turn-terminal',
      turnStatus: expectedStatus,
    });
  });

  it('publishes provider-native file edit events through the same durable turn change set', async () => {
    const {
      extractCanonicalDiffFiles,
      readTurnChangeToolMetadata,
    } = await import('../../../../../../../packages/protocol/src/sessions/messages/canonicalTurnDiffTool');
    const { NormalizedToolTurnChangeTracker } = await import('@/agent/tools/diff/normalizedToolTurnChangeTracker');
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const runtimeMessageDeltaBridge = {
      appendAssistantDelta: vi.fn(),
      appendThinkingDelta: vi.fn(),
      discardStream: vi.fn(),
      flushAll: vi.fn(async () => []),
    };
    const { bodies, enqueueAgentMessageCommitted } = createCommittedAgentMessageCapture();
    const session = { sessionId: 'session-1', enqueueAgentMessageCommitted };
    const normalizedToolTurnChangeTracker = new NormalizedToolTurnChangeTracker({ provider: 'codex' });
    const common = {
      session,
      provider: 'codex' as const,
      runtimeMessageDeltaBridge,
      normalizedToolTurnChangeTracker,
      toolNormalizationProtocol: 'codex' as const,
    };

    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'turn-start', sessionId: 'session-1', emittedAtMs: 1, turnId: 'host-turn-1',
        startedBy: 'provider',
      }),
    });
    await expect(projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'file-edit', sessionId: 'session-1', emittedAtMs: 2, turnId: 'host-turn-1',
        agentTurnId: 'provider-turn-1', editId: 'native-edit-1', path: 'src/native-edit.ts',
        oldContent: 'before', newContent: 'after', description: 'native edit',
      }),
    })).resolves.toEqual({ projected: true, kind: 'file-edit' });
    await projectRuntimeTranscriptEvent({
      ...common,
      event: canonicalRuntimeEvent({
        kind: 'turn-complete', sessionId: 'session-1', emittedAtMs: 3, turnId: 'host-turn-1',
        agentTurnId: 'provider-turn-1',
      }),
    });

    expect(bodies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'file-edit',
        filePath: 'src/native-edit.ts',
        oldContent: 'before',
        newContent: 'after',
      }),
    ]));
    const canonicalDiffCall = findCanonicalDiffCall(bodies);
    const metadata = readTurnChangeToolMetadata(canonicalDiffCall.input);
    expect(extractCanonicalDiffFiles(canonicalDiffCall.input, metadata!)).toEqual([
      expect.objectContaining({
        filePath: 'src/native-edit.ts',
        source: 'provider_native',
        confidence: 'exact',
        provider: 'codex',
        agentTurnId: 'provider-turn-1',
        providerMessageId: 'native-edit-1',
        oldText: 'before',
        newText: 'after',
        description: 'native edit',
      }),
    ]);
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
      meta: {
        happierProvenanceV1: {
          v: 1,
          kind: 'host',
          producer: 'runtimeTranscript',
        },
      },
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

  it.each(['assistant', 'user'] as const)('does not release ordered %s output from local custody without server delivery', async (role) => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const session = {
      sessionId: 'session-1',
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueUserTextMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
    };
    const admission = { signal: new AbortController().signal, requireDelivery: true };
    await expect(projectRuntimeTranscriptEvent({
      session, provider: 'opencode', admission,
      event: canonicalRuntimeEvent({
        kind: 'transcript-message-committed', sessionId: 'session-1', emittedAtMs: 1,
        messageId: 'ordered-message', role, text: 'must precede acceptance',
      }),
    })).rejects.toMatchObject({ code: 'runtime_transcript_required_admission_failed' });
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
      discardStream: vi.fn(),
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
      discardStream: vi.fn(),
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
