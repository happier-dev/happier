import { describe, expect, it, vi } from 'vitest';

import {
  getStorage,
  registerLocalVoiceEngineHarnessHooks,
  submitMessage,
} from './localVoiceEngine.testHarness';

describe('runVoiceAgentTurnWithTools local effect custody', () => {
  registerLocalVoiceEngineHarnessHooks();

  async function prepareSession() {
    const storage = await getStorage();
    storage.__setState({
      settings: { ...storage.getState().settings },
      sessions: {
        ...storage.getState().sessions,
        s1: {
          id: 's1',
          presence: 'online',
          active: true,
          updatedAt: 1,
          agentState: null,
          metadata: { path: '/tmp/project-a', host: 'test-machine' },
        },
      },
      concurrentSessionListCacheByServerId: {
        'server-a': {
          serverName: null,
          sessions: { s1: { id: 's1', presence: 'online', active: true } },
        },
      },
    });
  }

  async function streamResponse(
    effectId: string,
    message: string,
    args: Readonly<Record<string, unknown>> = { message },
    replayCount = 1,
  ) {
    const { streamVoiceAgentTurn } = await import('@/voice/agent/streamVoiceAgentTurn');
    const handle = {
      backend: 'daemon' as const,
      rpcSessionId: 'sys_voice',
      voiceAgentId: 'run_1',
      agentBackendId: 'claude',
      client: {
        start: vi.fn(),
        sendTurn: vi.fn(),
        welcome: vi.fn(),
        startTurnStream: vi.fn(async () => ({ streamId: 'canonical-turn-1' })),
        readTurnStream: vi.fn(async () => ({
          streamId: 'canonical-turn-1',
          events: [
            ...Array.from({ length: replayCount }, () => ({
              t: 'voice_output' as const,
              output: {
                v: 1 as const,
                kind: 'side_effect' as const,
                turnId: 'canonical-turn-1',
                seq: 0,
                effectId,
                action: { t: 'sendSessionMessage' as const, args: { ...args, message } },
              },
            })),
            {
              t: 'voice_output' as const,
              output: {
                v: 1 as const,
                kind: 'turn_final' as const,
                turnId: 'canonical-turn-1',
                seq: 1,
                text: 'Working on it.',
              },
            },
          ],
          nextCursor: 2,
          done: true,
        })),
        cancelTurnStream: vi.fn(async () => ({ ok: true as const })),
        commit: vi.fn(),
        stop: vi.fn(),
      },
    };
    return await streamVoiceAgentTurn({
      sessionId: 'sys_voice',
      handle,
      userText: 'do it',
      displayUserText: 'do it',
    });
  }

  function createSessions(responses: ReadonlyArray<Readonly<{ assistantText: string; actions: ReadonlyArray<unknown> }>>) {
    let responseIndex = 0;
    return {
      sendTurn: vi.fn(async () => responses[responseIndex++] ?? { assistantText: 'Done.', actions: [] }),
    };
  }

  it('forwards accepted canonical output from every tool round', async () => {
    await prepareSession();
    const observedTurnIds: string[] = [];
    let turnIndex = 0;
    const sessions = {
      sendTurn: vi.fn(async (_sessionId: string, _userText: string, options?: {
        onOutputEvent?: (output: any) => void | Promise<void>;
      }) => {
        const currentTurn = turnIndex++;
        const turnId = `canonical-turn-${currentTurn}`;
        await options?.onOutputEvent?.({
          event: {
            v: 1,
            kind: 'display_status',
            turnId,
            seq: 0,
            statusId: `status-${currentTurn}`,
            text: `Working ${currentTurn}`,
          },
          effects: [{
            kind: 'display_status',
            statusId: `status-${currentTurn}`,
            text: `Working ${currentTurn}`,
          }],
        });
        return currentTurn === 0
          ? { assistantText: 'Checking.', actions: [{ t: 'listSessions', args: { limit: 1 } }] }
          : { assistantText: 'Done.', actions: [] };
      }),
    };
    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice',
      userText: 'check sessions',
      durableLocalId: 'test-durable-local-id',
      currentToolSessionId: 's1',
      voiceAgentSessions: sessions,
      onOutputEvent: async ({ event }) => {
        observedTurnIds.push(event.turnId);
      },
    });

    expect(sessions.sendTurn).toHaveBeenCalledTimes(2);
    expect(observedTurnIds).toEqual(['canonical-turn-0', 'canonical-turn-1']);
  });

  it('rejects a non-streaming effect that has no stable call identity', async () => {
    await prepareSession();
    submitMessage.mockResolvedValue(undefined);
    const sessions = createSessions([
      {
        assistantText: 'I will send it.',
        actions: [{ t: 'sendSessionMessage', args: { message: 'Must not send' } }],
      },
      { assistantText: 'I could not safely execute it.', actions: [] },
    ]);
    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice',
      userText: 'send it',
      durableLocalId: 'test-durable-local-id',
      currentToolSessionId: 's1',
      voiceAgentSessions: sessions,
    });

    expect(submitMessage).not.toHaveBeenCalled();
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({
      t: 'sendSessionMessage',
      result: { ok: false, errorCode: 'tool_call_identity_required' },
    });
  });

  it('retains and reports a completed canonical effect when abort fires at the handler completion boundary', async () => {
    await prepareSession();
    const controller = new AbortController();
    submitMessage.mockImplementation(async () => {
      controller.abort();
      return undefined;
    });
    const effectResponse = await streamResponse('effect-completed', 'Do it once');
    const sessions = createSessions([effectResponse]);
    const onToolResults = vi.fn(async () => undefined);
    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice',
      userText: 'do it',
      durableLocalId: 'test-durable-local-id',
      currentToolSessionId: 's1',
      voiceAgentSessions: sessions,
      signal: controller.signal,
      onToolResults,
    });

    expect(submitMessage).toHaveBeenCalledTimes(1);
    expect(onToolResults).toHaveBeenCalledWith({
      turnIndex: 0,
      toolResults: [expect.objectContaining({
        t: 'sendSessionMessage',
        result: expect.objectContaining({ ok: true }),
      })],
    });
    expect(result.toolResultBatches).toEqual([
      [expect.objectContaining({ t: 'sendSessionMessage', result: expect.objectContaining({ ok: true }) })],
    ]);
  });

  it('executes one action when a canonical stable effect is replayed in the same stream', async () => {
    await prepareSession();
    submitMessage.mockResolvedValue(undefined);
    const replayedWithinStream = await streamResponse('effect-same-stream', 'Do it once', undefined, 2);
    const sessions = createSessions([replayedWithinStream, { assistantText: 'Done.', actions: [] }]);
    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice',
      userText: 'do it',
      durableLocalId: 'test-durable-local-id',
      currentToolSessionId: 's1',
      voiceAgentSessions: sessions,
    });

    expect(replayedWithinStream.actions).toHaveLength(1);
    expect(submitMessage).toHaveBeenCalledTimes(1);
    expect(submitMessage).toHaveBeenCalledWith('s1', 'Do it once', undefined, undefined, {
      callerSurface: 'voice_turn',
      forceImmediate: true,
      hostAdmissionOrigin: 'voice',
    });
    expect(result.totalActions).toBe(1);
    expect(result.toolResultBatches).toHaveLength(1);
  });

  it('reuses a retained canonical effect outcome across replay without rerunning the handler', async () => {
    await prepareSession();
    submitMessage.mockResolvedValue(undefined);
    const firstEffect = await streamResponse('effect-replay', 'Do it once');
    const replayedEffect = await streamResponse('effect-replay', 'Do it once');
    const firstSessions = createSessions([firstEffect, { assistantText: 'Done.', actions: [] }]);
    const replaySessions = createSessions([replayedEffect, { assistantText: 'Done again.', actions: [] }]);
    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    const first = await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice', userText: 'first', durableLocalId: 'test-durable-local-id', currentToolSessionId: 's1', voiceAgentSessions: firstSessions,
    });
    const replay = await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice', userText: 'replay', durableLocalId: 'test-durable-local-id', currentToolSessionId: 's1', voiceAgentSessions: replaySessions,
    });

    expect(submitMessage).toHaveBeenCalledTimes(1);
    expect(replay.toolResultBatches[0]).toEqual(first.toolResultBatches[0]);
  });

  it('releases retained effect outcomes when the owning local Voice session stops', async () => {
    await prepareSession();
    submitMessage.mockResolvedValue(undefined);
    const firstEffect = await streamResponse('effect-after-stop', 'Do it once');
    const restartedEffect = await streamResponse('effect-after-stop', 'Do it once');
    const firstSessions = createSessions([firstEffect, { assistantText: 'Done.', actions: [] }]);
    const restartedSessions = createSessions([restartedEffect, { assistantText: 'Done after restart.', actions: [] }]);
    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice', userText: 'first', durableLocalId: 'test-durable-local-id', currentToolSessionId: 's1', voiceAgentSessions: firstSessions,
    });

    const { stopLocalVoiceAgent } = await import('./localVoiceEngine');
    await stopLocalVoiceAgent('sys_voice');

    await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice', userText: 'after restart', durableLocalId: 'test-durable-local-id', currentToolSessionId: 's1', voiceAgentSessions: restartedSessions,
    });

    expect(submitMessage).toHaveBeenCalledTimes(2);
  });

  it('fails closed when one canonical effect identity is reused with different arguments', async () => {
    await prepareSession();
    submitMessage.mockResolvedValue(undefined);
    const firstEffect = await streamResponse('effect-conflict', 'First mutation');
    const conflictingEffect = await streamResponse('effect-conflict', 'Different mutation');
    const sessions = createSessions([
      firstEffect,
      { assistantText: 'Done.', actions: [] },
      conflictingEffect,
      { assistantText: 'Conflict noted.', actions: [] },
    ]);
    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice', userText: 'first', durableLocalId: 'test-durable-local-id', currentToolSessionId: 's1', voiceAgentSessions: sessions,
    });
    const replay = await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice', userText: 'conflict', durableLocalId: 'test-durable-local-id', currentToolSessionId: 's1', voiceAgentSessions: sessions,
    });

    expect(submitMessage).toHaveBeenCalledTimes(1);
    expect(replay.toolResultBatches[0]?.[0]).toMatchObject({
      t: 'sendSessionMessage',
      result: { ok: false, errorCode: 'tool_call_identity_conflict' },
    });
  });

  it('reports outcome_unknown when an identified external effect handler cannot prove completion', async () => {
    await prepareSession();
    submitMessage.mockRejectedValue(new Error('transport closed after dispatch'));
    const effectResponse = await streamResponse('effect-unknown', 'Maybe sent');
    const sessions = createSessions([effectResponse, { assistantText: 'I cannot confirm it.', actions: [] }]);
    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice', userText: 'send it', durableLocalId: 'test-durable-local-id', currentToolSessionId: 's1', voiceAgentSessions: sessions,
    });

    expect(submitMessage).toHaveBeenCalledTimes(1);
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({
      t: 'sendSessionMessage',
      result: { ok: false, errorCode: 'outcome_unknown' },
    });
  });

  it('preserves a known pre-dispatch failure instead of misreporting outcome_unknown', async () => {
    await prepareSession();
    const effectResponse = await streamResponse(
      'effect-known-failure',
      'Cannot dispatch',
      { sessionId: 'missing-session', message: 'Cannot dispatch' },
    );
    const sessions = createSessions([effectResponse, { assistantText: 'That target is unavailable.', actions: [] }]);
    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice', userText: 'send it', durableLocalId: 'test-durable-local-id', currentToolSessionId: 's1', voiceAgentSessions: sessions,
    });

    expect(submitMessage).not.toHaveBeenCalled();
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({
      t: 'sendSessionMessage',
      result: { ok: false, errorCode: 'session_not_found' },
    });
  });
});
