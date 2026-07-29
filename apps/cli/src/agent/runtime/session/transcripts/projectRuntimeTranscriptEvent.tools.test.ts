import { describe, expect, it, vi } from 'vitest';

import type { EphemeralSendOutcome } from '@/api/session/client/transcript/ephemeralSendOutcome';

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
  ) => {
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
      flushAll: vi.fn(async () => undefined),
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
  it('projects a fully merged tool-progress snapshot ephemerally without a durable write', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const fixture = createRuntimeToolProjectionFixture();

    await expect(projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
      event: {
        kind: 'tool-progress',
        sessionId: 'session-1',
        emittedAtMs: 101,
        turnId: 'turn-1',
        sidechainId: 'sidechain-1',
        toolCallId: 'call-1',
        localId: 'acp-call-v1:bounded-call',
        progress: mergedToolProgress({ sidechainId: 'sidechain-1' }),
      },
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
        id: 'acp-call-v1:bounded-call',
        sidechainId: 'sidechain-1',
      },
      {
        localId: 'acp-call-v1:bounded-call',
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
      localId: 'acp-call-v1:bounded-call',
      progress: mergedToolProgress(),
    };

    await expect(projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      event: firstEvent,
    })).resolves.toEqual({ projected: false, reason: 'ephemeral_not_accepted' });
    expect(fixture.session.sendAgentMessageEphemeral).toHaveBeenCalledTimes(1);

    await expect(projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      event: {
        ...firstEvent,
        emittedAtMs: 102,
        progress: mergedToolProgress({ title: 'Read enriched README', observedAtMs: 102 }),
      },
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
      event: {
        kind: 'tool-progress',
        sessionId: 'session-1',
        emittedAtMs: 101,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        localId: 'acp-call-v1:bounded-call',
        progress: mergedToolProgress(),
      },
    })).rejects.toThrow('unexpected transcript port rejection');
  });

  it('promotes progress to a durable call before its distinct result using emitted bounded identities', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const fixture = createRuntimeToolProjectionFixture([
      { accepted: true, epoch: 1 },
      { accepted: true, epoch: 1 },
    ]);
    const hostileId = ' vendor-call \nnext\0byte ';
    const callLocalId = 'acp-call-v1:bounded-call';
    const resultLocalId = 'acp-result-v1:bounded-result';

    for (const [emittedAtMs, title] of [[101, 'Sparse'], [102, 'Enriched']] as const) {
      await projectRuntimeTranscriptEvent({
        session: fixture.session,
        provider: 'cursor',
        runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
        event: {
          kind: 'tool-progress',
          sessionId: 'session-1',
          emittedAtMs,
          turnId: 'turn-1',
          toolCallId: hostileId,
          localId: callLocalId,
          progress: mergedToolProgress({
            toolCallId: hostileId,
            localId: callLocalId,
            resultLocalId,
            title,
            observedAtMs: emittedAtMs,
          }),
        },
      });
    }
    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
      event: {
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs: 103,
        turnId: 'turn-1',
        toolCallId: hostileId,
        localId: callLocalId,
        toolName: 'Read',
        toolInput: { path: 'README.md' },
        toolSnapshot: mergedToolProgress({
          toolCallId: hostileId,
          localId: callLocalId,
          resultLocalId,
          status: 'completed',
          observedAtMs: 103,
        }),
      },
    });
    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      event: {
        kind: 'tool-result',
        sessionId: 'session-1',
        emittedAtMs: 104,
        turnId: 'turn-1',
        toolCallId: hostileId,
        localId: resultLocalId,
        output: { text: 'done' },
      },
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

    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      event: {
        kind: 'tool-progress',
        sessionId: 'session-1',
        emittedAtMs: 101,
        turnId: 'turn-1',
        toolCallId: 'plan-call',
        localId: 'acp-call-v1:plan',
        progress: { ...progress, toolCallId: 'plan-call', localId: 'acp-call-v1:plan' },
      },
    });
    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
      event: {
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs: 102,
        turnId: 'turn-1',
        toolCallId: 'plan-call',
        localId: 'acp-call-v1:plan',
        toolName: 'createPlan',
        toolInput: {},
        toolSnapshot: { ...progress, toolCallId: 'plan-call', localId: 'acp-call-v1:plan', status: 'cancelled' },
      },
    });
    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
      event: {
        kind: 'turn-complete',
        sessionId: 'session-1',
        emittedAtMs: 103,
        turnId: 'turn-1',
      },
    });

    expect(fixture.session.sendAgentMessageEphemeral).toHaveBeenCalledTimes(1);
    expect(fixture.durableRows.size).toBe(1);
    expect(fixture.durableRows.get('acp-call-v1:plan')).toMatchObject({
      type: 'tool-call',
      callId: 'plan-call',
    });
    expect([...fixture.durableRows.values()].some((body) => body.type === 'tool-result')).toBe(false);
  });

  it('derives bounded deterministic call and result identities when a generic runtime producer omits localId', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const fixture = createRuntimeToolProjectionFixture();
    const hostileId = ' generic \ncall\0id ';

    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'claude',
      runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
      event: {
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs: 101,
        turnId: 'turn-1',
        toolCallId: hostileId,
        toolName: 'Read',
        toolInput: { path: 'README.md' },
      },
    });
    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'claude',
      event: {
        kind: 'tool-result',
        sessionId: 'session-1',
        emittedAtMs: 102,
        turnId: 'turn-1',
        toolCallId: hostileId,
        output: 'done',
      },
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

  it('converges late call enrichment and materially richer result revisions through stable durable localIds', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const fixture = createRuntimeToolProjectionFixture();
    const callLocalId = 'acp-call-v1:revision-call';
    const resultLocalId = 'acp-result-v1:revision-result';

    const projectCall = async (title: string, emittedAtMs: number) => projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
      event: {
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        localId: callLocalId,
        toolName: 'Read',
        toolInput: { path: 'README.md' },
        toolSnapshot: mergedToolProgress({ title, status: 'completed', observedAtMs: emittedAtMs }),
      },
    });
    const projectResult = async (output: unknown, isError: boolean, emittedAtMs: number) => projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      event: {
        kind: 'tool-result',
        sessionId: 'session-1',
        emittedAtMs,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        localId: resultLocalId,
        output,
        isError,
      },
    });

    await projectCall('Initial title', 101);
    await projectResult({ text: 'partial' }, false, 102);
    await projectCall('Late richer title', 103);
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
      input: { _acp: { title: 'Late richer title' } },
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
    const localId = 'acp-call-v1:one-card';

    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      event: {
        kind: 'tool-progress',
        sessionId: 'session-1',
        emittedAtMs: 101,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        localId,
        progress: mergedToolProgress({ localId }),
      },
    });
    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
      event: {
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs: 102,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        localId,
        toolName: 'Read',
        toolInput: { path: 'README.md' },
        toolSnapshot: mergedToolProgress({ localId, status: 'completed', observedAtMs: 102 }),
      },
    });

    const ephemeralBody = fixture.session.sendAgentMessageEphemeral.mock.calls[0]?.[1];
    const durableBody = fixture.durableRows.get(localId);
    expect(ephemeralBody).toMatchObject({ type: 'tool-call', callId: 'call-1', id: localId });
    expect(durableBody).toMatchObject({ type: 'tool-call', callId: 'call-1', id: localId });
    expect(fixture.durableRows.size).toBe(1);
  });

  it('encodes cleared full-snapshot metadata so terminal promotion cannot retain stale progress fields', async () => {
    const { projectRuntimeTranscriptEvent } = await import('./projectRuntimeTranscriptEvent');
    const fixture = createRuntimeToolProjectionFixture();
    const localId = 'acp-call-v1:cleared-fields';

    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      event: {
        kind: 'tool-progress',
        sessionId: 'session-1',
        emittedAtMs: 101,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        localId,
        progress: mergedToolProgress({ localId }),
      },
    });
    await projectRuntimeTranscriptEvent({
      session: fixture.session,
      provider: 'cursor',
      runtimeMessageDeltaBridge: fixture.runtimeMessageDeltaBridge,
      event: {
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs: 102,
        turnId: 'turn-1',
        toolCallId: 'call-1',
        localId,
        toolName: 'Read',
        toolInput: { path: 'README.md' },
        toolSnapshot: {
          ...mergedToolProgress({ localId, status: 'completed', observedAtMs: 102 }),
          title: undefined,
          kind: undefined,
          locations: undefined,
        },
      },
    });

    const durableBody = fixture.durableRows.get(localId);
    expect(durableBody).toMatchObject({
      type: 'tool-call',
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
