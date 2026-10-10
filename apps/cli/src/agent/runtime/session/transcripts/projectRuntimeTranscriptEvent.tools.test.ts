import { describe, expect, it, vi } from 'vitest';

import {
  AgentSessionRuntimeEventV1Schema,
  type AgentSessionRuntimeEventV1,
} from '@happier-dev/protocol';

import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import { NormalizedToolTurnChangeTracker } from '@/agent/tools/diff/normalizedToolTurnChangeTracker';
import { createAcpToolIdentity } from '@/agent/acp/toolCalls';
import type { EphemeralSendOutcome } from '@/api/session/client/transcript/ephemeralSendOutcome';

let nextRuntimeEventSequence = 0;

function canonicalRuntimeEvent(input: Readonly<Record<string, unknown>>): AgentSessionRuntimeEventV1 {
  return AgentSessionRuntimeEventV1Schema.parse({
    sequence: ++nextRuntimeEventSequence,
    ...input,
  });
}

function toolIdentity(params: Readonly<{
  toolCallId: string;
  sidechainId?: string | null;
}>): ReturnType<typeof createAcpToolIdentity> {
  return createAcpToolIdentity({
    sessionId: 'session-1',
    turnId: 'turn-1',
    sidechainId: params.sidechainId ?? null,
    toolCallId: params.toolCallId,
  });
}

function createRuntimeToolProjectionFixture(
  ephemeralOutcomes: EphemeralSendOutcome[] = [{ accepted: true, epoch: 1 }],
) {
  const durableWrites: Array<Readonly<{
    localId: string;
    body: Record<string, unknown>;
  }>> = [];
  const durableRows = new Map<string, Record<string, unknown>>();
  const sendOrder: string[] = [];
  const sendAgentMessageEphemeral = vi.fn(async (
    _provider: string,
    body: Record<string, unknown>,
    opts: { localId: string },
  ) => {
    sendOrder.push(`ephemeral:${opts.localId}`);
    return ephemeralOutcomes.shift() ?? {
      accepted: false as const,
      epoch: 0,
      reason: 'transport_unavailable' as const,
    };
  });
  const enqueueAgentMessageCommitted = vi.fn(async (
    _provider: string,
    body: Record<string, unknown>,
    opts: { localId: string },
  ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>> => {
    sendOrder.push(`durable:${opts.localId}`);
    durableWrites.push({ localId: opts.localId, body });
    durableRows.set(opts.localId, body);
    return { persisted: true as const, delivered: true as const };
  });
  return {
    durableRows,
    durableWrites,
    sendOrder,
    runtimeMessageDeltaBridge: {
      appendAssistantDelta: vi.fn(),
      appendThinkingDelta: vi.fn(),
      discardStream: vi.fn(),
      flushAll: vi.fn(async () => []),
    },
    session: {
      sessionId: 'session-1',
      sendUserTextMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      sendAgentMessageEphemeral,
      getEphemeralStreamConnectionEpoch: vi.fn(() => 1),
      enqueueAgentMessageCommitted,
    },
  };
}

function mergedToolProgress(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    sidechainId: null,
    toolCallId: 'call-1',
    localId: 'acp-call-v1:bounded-call',
    resultLocalId: 'acp-result-v1:bounded-result',
    toolName: 'Read',
    title: 'Read README',
    kind: 'read',
    status: 'running',
    rawInput: { path: 'README.md' },
    locations: [{ path: 'README.md', line: 2 }],
    observedAtMs: 101,
    ...overrides,
  };
}

describe('projectRuntimeTranscriptEvent tool lifecycle', () => {
  it.each([{}, { sidechainId: 'child-1' }, { sidechainId: 'child-1', turnId: 'old-turn', agentTurnId: 'native-child' }])(
    'retains session-scoped tools without flushing or changing the foreground turn: %j', async (scope) => {
      const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
      const fixture = createRuntimeToolProjectionFixture();
      const tracker = new NormalizedToolTurnChangeTracker({ provider: 'codex' });
      tracker.beginTurn({ turnId: 'foreground', agentTurnId: 'native-foreground', sequence: 1 });
      const project = (event: Record<string, unknown>) => projectRuntimeTranscriptEvent({
        session: fixture.session, provider: 'codex', runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
        normalizedToolTurnChangeTracker: tracker, event: {
          sessionId: 'session-1', emittedAtMs: 10, sequence: ++nextRuntimeEventSequence, ...scope, ...event,
        },
      });
      await expect(project({ kind: 'tool-call', toolCallId: 'call-1', toolName: 'Write', input: { file_path: 'child.ts', content: 'child' } })).resolves.toEqual({ projected: true, kind: 'tool-call' });
      await expect(project({ kind: 'tool-result', toolCallId: 'call-1', output: {} })).resolves.toEqual({ projected: true, kind: 'tool-result' });
      await expect(project({ kind: 'file-edit', editId: 'edit-1', path: 'child.ts', oldContent: '', newContent: 'child' })).resolves.toEqual({ projected: true, kind: 'file-edit' });
      const identity = createAcpToolIdentity({ sessionId: 'session-1', turnId: 'turnId' in scope ? scope.turnId ?? null : null,
        sidechainId: 'sidechainId' in scope ? scope.sidechainId ?? null : null, toolCallId: 'call-1' });
      expect(fixture.durableRows.get(identity.callLocalId)).toMatchObject({ type: 'tool-call', callId: 'call-1', ...('sidechainId' in scope ? { sidechainId: scope.sidechainId } : {}) });
      expect(fixture.durableRows.get(identity.resultLocalId)).toMatchObject({ type: 'tool-result', callId: 'call-1' });
      expect(fixture.runtimeMessageDeltaBridge.flushAll).not.toHaveBeenCalled();
      expect(tracker.completeTurn({ sessionId: 'session-1', turnId: 'foreground', agentTurnId: 'native-foreground', sequence: 20, status: 'completed' })).toBeNull();
    },
  );

  it('keeps foreground change attribution when a child reports its own native turn', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const fixture = createRuntimeToolProjectionFixture();
    const tracker = new NormalizedToolTurnChangeTracker({ provider: 'codex' });
    tracker.beginTurn({ turnId: 'foreground', agentTurnId: 'native-foreground', sequence: 1 });
    await projectRuntimeTranscriptEvent({
      session: fixture.session, provider: 'codex', normalizedToolTurnChangeTracker: tracker,
      event: canonicalRuntimeEvent({ sessionId: 'session-1', emittedAtMs: 1, kind: 'tool-call',
        turnId: 'origin', agentTurnId: 'native-child', sidechainId: 'child-1', toolCallId: 'child-call', toolName: 'Read', input: {} }),
    });
    tracker.observeFileEdit({ editId: 'foreground-edit', filePath: 'foreground.ts', oldContent: '', newContent: 'foreground' });
    expect(tracker.completeTurn({ sessionId: 'session-1', turnId: 'foreground', sequence: 20, status: 'completed' })).toMatchObject({
      turnId: 'foreground', files: [{ filePath: 'foreground.ts', agentTurnId: 'native-foreground' }],
    });
  });

  it('keeps child deltas separate and open across foreground cancellation', async () => {
    vi.useFakeTimers();
    try {
      const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
      const fixture = createRuntimeToolProjectionFixture();
      const bridge = createKeyedStreamedTranscriptBridge({ provider: 'codex', initialCheckpointDelayMs: 60_000,
        createSessionForStream: () => fixture.session });
      const project = (event: Record<string, unknown>) => projectRuntimeTranscriptEvent({
        session: fixture.session, provider: 'codex', runtimeMessageDeltaBridge: bridge,
        event: { sessionId: 'session-1', emittedAtMs: 1, sequence: ++nextRuntimeEventSequence, ...event },
      });
      await project({ kind: 'message-delta', turnId: 'turn-1', channel: 'assistant', text: 'Foreground' });
      await project({ kind: 'message-delta', turnId: 'turn-1', sidechainId: 'child-1', channel: 'assistant', text: 'Before ' });
      await project({ kind: 'turn-cancelled', turnId: 'turn-1', cause: 'user' });
      expect([...fixture.durableRows.values()].filter((body) => body.type === 'message')).toEqual([
        { type: 'message', message: 'Foreground' },
      ]);
      await project({ kind: 'message-delta', turnId: 'turn-1', sidechainId: 'child-1', channel: 'assistant', text: 'after' });
      await bridge.flushAll({ reason: 'turn-end' });
      expect([...fixture.durableRows.values()].filter((body) => body.type === 'message')).toEqual([
        { type: 'message', message: 'Foreground' },
        { type: 'message', message: 'Before after', sidechainId: 'child-1' },
      ]);
    } finally { vi.useRealTimers(); }
  });

  it('retires only the matching child stream after authoritative text commits durably', async () => {
    vi.useFakeTimers();
    try {
      const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
      const fixture = createRuntimeToolProjectionFixture();
      const bridge = createKeyedStreamedTranscriptBridge({ provider: 'codex', initialCheckpointDelayMs: 60_000,
        createSessionForStream: () => fixture.session });
      const project = (event: Record<string, unknown>) => projectRuntimeTranscriptEvent({
        session: fixture.session, provider: 'codex', runtimeMessageDeltaBridge: bridge,
        event: { sessionId: 'session-1', sidechainId: 'child-1', emittedAtMs: 1, sequence: ++nextRuntimeEventSequence, ...event },
      });
      await project({ kind: 'message-delta', messageId: 'child-message-1', channel: 'assistant', text: 'Partial' });
      await project({ kind: 'message-delta', messageId: 'child-message-2', channel: 'assistant', text: 'Sibling' });
      await project({ kind: 'transcript-message-committed', messageId: 'child-message-1', role: 'assistant', text: 'Authoritative full text' });
      await bridge.flushAll({ reason: 'turn-end' });
      expect(fixture.durableRows.get('child-message-1')).toEqual({ type: 'message', message: 'Authoritative full text', sidechainId: 'child-1' });
      expect(fixture.durableRows.get('child-message-2')).toEqual({ type: 'message', message: 'Sibling', sidechainId: 'child-1' });
    } finally { vi.useRealTimers(); }
  });

  it('projects a fully merged tool-progress snapshot ephemerally without a durable write', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const fixture = createRuntimeToolProjectionFixture();

    await expect(projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'tool-progress',
        sessionId: 'session-1',
        emittedAtMs: 101,
        turnId: 'turn-1',
        sidechainId: 'sidechain-1',
        toolCallId: 'call-1',
        progress: mergedToolProgress({ sidechainId: 'sidechain-1' }),
      }),
    })).resolves.toEqual({ projected: true, kind: 'tool-progress' });

    expect(fixture.session.sendAgentMessageEphemeral).toHaveBeenCalledWith(
      'cursor',
      {
        type: 'tool-call',
        callId: 'call-1',
        name: 'Read',
        input: {
          path: 'README.md',
          locations: [{ path: 'README.md', line: 2 }],
          _acp: {
            title: 'Read README',
            kind: 'read',
            status: 'running',
            rawInput: { path: 'README.md' },
            locations: [{ path: 'README.md', line: 2 }],
            content: null,
          },
        },
        id: toolIdentity({ toolCallId: 'call-1', sidechainId: 'sidechain-1' }).callLocalId,
        sidechainId: 'sidechain-1',
      },
      {
        localId: toolIdentity({ toolCallId: 'call-1', sidechainId: 'sidechain-1' }).callLocalId,
        createdAt: 101,
        updatedAt: 101,
        meta: {
          source: 'runtime',
          runtimeEventKind: 'tool-progress',
          runtimeTurnId: 'turn-1',
          runtimeToolSnapshotV1: { v: 1, mode: 'full' },
        },
      },
    );
    expect(fixture.session.enqueueAgentMessageCommitted).not.toHaveBeenCalled();
  });

  it('reports locally rejected progress and retries only when the next full progress snapshot arrives', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const fixture = createRuntimeToolProjectionFixture([
      { accepted: false, epoch: 1, reason: 'disconnected' },
      { accepted: true, epoch: 2 },
    ]);
    const firstEvent = {
      kind: 'tool-progress',
      sessionId: 'session-1',
      emittedAtMs: 101,
      turnId: 'turn-1',
      toolCallId: 'call-1',
      progress: mergedToolProgress(),
    };

    await expect(projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      event: canonicalRuntimeEvent(firstEvent),
    })).resolves.toEqual({ projected: false, reason: 'ephemeral_not_accepted' });
    expect(fixture.session.sendAgentMessageEphemeral).toHaveBeenCalledTimes(1);

    await expect(projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      event: canonicalRuntimeEvent({
        ...firstEvent,
        emittedAtMs: 102,
        progress: mergedToolProgress({ title: 'Read enriched README', observedAtMs: 102 }),
      }),
    })).resolves.toEqual({ projected: true, kind: 'tool-progress' });
    expect(fixture.session.sendAgentMessageEphemeral).toHaveBeenCalledTimes(2);
    expect(fixture.session.enqueueAgentMessageCommitted).not.toHaveBeenCalled();
  });

  it('does not silently swallow a transcript port that violates the outcome contract by rejecting', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const fixture = createRuntimeToolProjectionFixture();
    fixture.session.sendAgentMessageEphemeral.mockImplementationOnce(async () => {
      throw new Error('unexpected transcript port rejection');
    });

    await expect(projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      event: canonicalRuntimeEvent({
        kind: 'tool-progress',
        sessionId: 'session-1',
        emittedAtMs: 101,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        progress: mergedToolProgress(),
      }),
    })).rejects.toThrow('unexpected transcript port rejection');
  });

  it('rejects a stable tool fact when the durable queue returns no custody', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const fixture = createRuntimeToolProjectionFixture();
    fixture.session.enqueueAgentMessageCommitted.mockResolvedValueOnce({
      persisted: false,
      delivered: false,
    });

    await expect(projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      event: canonicalRuntimeEvent({
        kind: 'tool-result',
        sessionId: 'session-1',
        emittedAtMs: 103,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        output: { text: 'required tool result' },
      }),
    })).rejects.toMatchObject({
      code: 'runtime_transcript_required_admission_failed',
      reason: 'durable_custody_rejected',
      eventKind: 'tool-result',
    });
  });

  it('promotes progress to a durable call before its distinct result using emitted bounded identities', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const fixture = createRuntimeToolProjectionFixture([
      { accepted: true, epoch: 1 },
      { accepted: true, epoch: 1 },
    ]);
    const hostileId = 'vendor-call\nnext\0byte';
    const identity = toolIdentity({ toolCallId: hostileId });
    const callLocalId = identity.callLocalId;
    const resultLocalId = identity.resultLocalId;

    for (const [emittedAtMs, title] of [[101, 'Sparse'], [102, 'Enriched']] as const) {
      await projectRuntimeTranscriptEvent({
        session: fixture.session,
        provider: 'cursor',
        runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
        event: canonicalRuntimeEvent({
          kind: 'tool-progress',
          sessionId: 'session-1',
          emittedAtMs,
          turnId: 'turn-1',
          toolCallId: hostileId,
          progress: mergedToolProgress({
            toolCallId: hostileId,
            title,
            observedAtMs: emittedAtMs,
          }),
        }),
      });
    }
    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs: 103,
        turnId: 'turn-1',
        toolCallId: hostileId,
        toolName: 'Read',
        input: { path: 'README.md' },
      }),
    });
    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      event: canonicalRuntimeEvent({
        kind: 'tool-result',
        sessionId: 'session-1',
        emittedAtMs: 104,
        turnId: 'turn-1',
        toolCallId: hostileId,
        output: { text: 'done' },
      }),
    });

    expect(fixture.sendOrder).toEqual([
      `ephemeral:${callLocalId}`,
      `ephemeral:${callLocalId}`,
      `durable:${callLocalId}`,
      `durable:${resultLocalId}`,
    ]);
    expect(fixture.durableWrites).toHaveLength(2);
    expect(fixture.durableWrites[0]).toMatchObject({
      localId: callLocalId,
      body: { type: 'tool-call', callId: hostileId, id: callLocalId },
    });
    expect(fixture.durableWrites[1]).toMatchObject({
      localId: resultLocalId,
      body: { type: 'tool-result', callId: hostileId, id: resultLocalId },
    });
    expect(callLocalId).not.toContain(hostileId);
    expect(resultLocalId).not.toContain(hostileId);
  });

  it('keeps a result-less Create Plan terminal durable while progress remains reload-ephemeral only', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const fixture = createRuntimeToolProjectionFixture();
    const progress = mergedToolProgress({ toolName: 'createPlan', kind: 'other', title: 'Create Plan' });
    const planCallLocalId = toolIdentity({ toolCallId: 'plan-call' }).callLocalId;

    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      event: canonicalRuntimeEvent({
        kind: 'tool-progress',
        sessionId: 'session-1',
        emittedAtMs: 101,
        turnId: 'turn-1',
        toolCallId: 'plan-call',
        progress: { ...progress, toolCallId: 'plan-call', localId: 'acp-call-v1:plan' },
      }),
    });
    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs: 102,
        turnId: 'turn-1',
        toolCallId: 'plan-call',
        toolName: 'createPlan',
        input: {},
      }),
    });
    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'turn-complete',
        sessionId: 'session-1',
        emittedAtMs: 103,
        turnId: 'turn-1',
      }),
    });

    expect(fixture.session.sendAgentMessageEphemeral).toHaveBeenCalledTimes(1);
    expect(fixture.durableRows.size).toBe(1);
    expect(fixture.durableRows.get(planCallLocalId)).toMatchObject({
      type: 'tool-call',
      callId: 'plan-call',
    });
    expect([...fixture.durableRows.values()].some((body) => body.type === 'tool-result')).toBe(false);
  });

  it('derives bounded deterministic call and result identities from canonical tool events', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const fixture = createRuntimeToolProjectionFixture();
    const hostileId = 'generic \ncall\0id';

    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'claude',
      runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs: 101,
        turnId: 'turn-1',
        toolCallId: hostileId,
        toolName: 'Read',
        input: { path: 'README.md' },
      }),
    });
    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'claude',
      event: canonicalRuntimeEvent({
        kind: 'tool-result',
        sessionId: 'session-1',
        emittedAtMs: 102,
        turnId: 'turn-1',
        toolCallId: hostileId,
        output: 'done',
      }),
    });

    const [call, result] = fixture.durableWrites;
    expect(call?.localId).toMatch(/^acp-call-v1:/);
    expect(result?.localId).toMatch(/^acp-result-v1:/);
    expect(call?.localId).not.toBe(result?.localId);
    expect(call?.localId).not.toContain(hostileId);
    expect(result?.localId).not.toContain(hostileId);
    expect(call?.body.id).toBe(call?.localId);
    expect(result?.body.id).toBe(result?.localId);
  });

  it('keeps canonical tool revisions at stable durable localIds', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const fixture = createRuntimeToolProjectionFixture();
    const identity = toolIdentity({ toolCallId: 'call-1' });
    const callLocalId = identity.callLocalId;
    const resultLocalId = identity.resultLocalId;

    const projectCall = async (input: Record<string, unknown>, emittedAtMs: number) => projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        toolName: 'Read',
        input,
      }),
    });
    const projectResult = async (output: unknown, isError: boolean, emittedAtMs: number) => projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      event: canonicalRuntimeEvent({
        kind: 'tool-result',
        sessionId: 'session-1',
        emittedAtMs,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        output,
        isError,
      }),
    });

    await projectCall({ path: 'README.md', revision: 'initial' }, 101);
    await projectResult({ text: 'partial' }, false, 102);
    await projectCall({ path: 'README.md', revision: 'later' }, 103);
    await projectResult({ text: 'final', exitCode: 1 }, true, 104);

    expect(fixture.sendOrder).toEqual([
      `durable:${callLocalId}`,
      `durable:${resultLocalId}`,
      `durable:${callLocalId}`,
      `durable:${resultLocalId}`,
    ]);
    expect(fixture.durableRows.size).toBe(2);
    expect(fixture.durableRows.get(callLocalId)).toMatchObject({
      type: 'tool-call',
      id: callLocalId,
      input: { path: 'README.md', revision: 'later' },
    });
    expect(fixture.durableRows.get(resultLocalId)).toMatchObject({
      type: 'tool-result',
      id: resultLocalId,
      output: { text: 'final', exitCode: 1 },
      isError: true,
    });
    expect(fixture.session.sendAgentMessageEphemeral).not.toHaveBeenCalled();
  });

  it('uses one call identity across ephemeral promotion so a durable boundary can replace the live card', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const fixture = createRuntimeToolProjectionFixture();
    const localId = toolIdentity({ toolCallId: 'call-1' }).callLocalId;

    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      event: canonicalRuntimeEvent({
        kind: 'tool-progress',
        sessionId: 'session-1',
        emittedAtMs: 101,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        progress: mergedToolProgress({ localId }),
      }),
    });
    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
      event: canonicalRuntimeEvent({
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs: 102,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        toolName: 'Read',
        input: { path: 'README.md' },
      }),
    });

    const ephemeralBody = fixture.session.sendAgentMessageEphemeral.mock.calls[0]?.[1];
    const durableBody = fixture.durableRows.get(localId);
    expect(ephemeralBody).toMatchObject({ type: 'tool-call', callId: 'call-1', id: localId });
    expect(durableBody).toMatchObject({ type: 'tool-call', callId: 'call-1', id: localId });
    expect(fixture.durableRows.size).toBe(1);
  });

  it('encodes cleared canonical progress metadata without retaining stale fields', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const fixture = createRuntimeToolProjectionFixture();
    const localId = toolIdentity({ toolCallId: 'call-1' }).callLocalId;

    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      event: canonicalRuntimeEvent({
        kind: 'tool-progress',
        sessionId: 'session-1',
        emittedAtMs: 101,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        progress: mergedToolProgress({ localId }),
      }),
    });
    const {
      title: _title,
      kind: _kind,
      locations: _locations,
      ...clearedProgress
    } = mergedToolProgress({ localId, status: 'completed', observedAtMs: 102 });
    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      event: canonicalRuntimeEvent({
        kind: 'tool-progress',
        sessionId: 'session-1',
        emittedAtMs: 102,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        progress: clearedProgress,
      }),
    });

    const ephemeralBody = fixture.session.sendAgentMessageEphemeral.mock.calls[1]?.[1];
    expect(ephemeralBody).toMatchObject({
      type: 'tool-call',
      id: localId,
      input: {
        _acp: {
          title: null,
          kind: null,
          locations: null,
        },
      },
    });
  });
});
