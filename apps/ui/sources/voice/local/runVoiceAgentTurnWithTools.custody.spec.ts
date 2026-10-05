import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { attachVoiceAgentActionEffectId } from '@/voice/agent/types';

import {
  getStorage,
  installLocalVoiceActionHomeForTests,
  registerLocalVoiceEngineHarnessHooks,
  localVoicePendingEnqueue,
} from './localVoiceEngine.testHarness';

const actionHome = await installLocalVoiceActionHomeForTests();
const currentToolSessionAddress = { serverId: actionHome.homes.voice!.id, sessionId: 's1' };
// Load real owners after the transport fixtures, once per suite.
await Promise.all([import('./runVoiceAgentTurnWithTools'), import('@/voice/agent/streamVoiceAgentTurn'), import('./localVoiceEngine')]);
afterAll(() => actionHome.dispose());

describe('runVoiceAgentTurnWithTools local effect custody', () => {
  registerLocalVoiceEngineHarnessHooks({ resetModulesBetweenTests: false });
  beforeEach(() => actionHome.restore());
  afterEach(async () => {
    const { clearRetainedLocalVoiceEffectOutcomes } = await import('@/voice/tools/localVoiceEffectOutcomeCustody');
    clearRetainedLocalVoiceEffectOutcomes('sys_voice');
  });

  async function prepareSession() {
    const storage = await getStorage();
    storage.__setState({
      settings: { ...storage.getState().settings },
      sessions: {
        ...storage.getState().sessions,
        s1: {
          id: 's1',
          serverId: currentToolSessionAddress.serverId,
          presence: 'online',
          active: true,
          updatedAt: 1,
          agentState: null,
          metadata: { path: '/tmp/project-a', host: 'test-machine' },
        },
      },
      concurrentSessionListCacheByServerId: {
        [currentToolSessionAddress.serverId]: {
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
      currentToolSessionId: 's1', currentToolSessionAddress,
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
      currentToolSessionId: 's1', currentToolSessionAddress,
      voiceAgentSessions: sessions,
    });

    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({
      t: 'sendSessionMessage',
      result: { ok: false, errorCode: 'tool_call_identity_required' },
    });
  });

  it('retains and reports a completed canonical effect when abort fires at the handler completion boundary', async () => {
    await prepareSession();
    const controller = new AbortController();
    localVoicePendingEnqueue.mockImplementation(async ({ body }) => {
      controller.abort();
      return Response.json({ requestedAction: body.requestedAction, pending: { localId: body.localId } });
    });
    const effectResponse = await streamResponse('effect-completed', 'Do it once');
    const sessions = createSessions([effectResponse]);
    const onToolResults = vi.fn(async () => undefined);
    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice',
      userText: 'do it',
      durableLocalId: 'test-durable-local-id',
      currentToolSessionId: 's1', currentToolSessionAddress,
      voiceAgentSessions: sessions,
      signal: controller.signal,
      onToolResults,
    });

    expect(localVoicePendingEnqueue).toHaveBeenCalledTimes(1);
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
    const replayedWithinStream = await streamResponse('effect-same-stream', 'Do it once', undefined, 2);
    const sessions = createSessions([replayedWithinStream, { assistantText: 'Done.', actions: [] }]);
    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice',
      userText: 'do it',
      durableLocalId: 'test-durable-local-id',
      currentToolSessionId: 's1', currentToolSessionAddress,
      voiceAgentSessions: sessions,
    });

    expect(replayedWithinStream.actions).toHaveLength(1);
    expect(localVoicePendingEnqueue).toHaveBeenCalledTimes(1);
    expect(localVoicePendingEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      body: expect.objectContaining({
        content: expect.objectContaining({ t: 'plain', v: expect.objectContaining({ content: expect.objectContaining({ text: 'Do it once' }) }) }),
        requestedAction: { v: 1, kind: 'steer_if_active' },
      }),
    }));
    expect(result.totalActions).toBe(1);
    expect(result.toolResultBatches).toHaveLength(1);
  });

  it('reuses a retained canonical effect outcome across replay without rerunning the handler', async () => {
    await prepareSession();
    const firstEffect = await streamResponse('effect-replay', 'Do it once');
    const replayedEffect = await streamResponse('effect-replay', 'Do it once');
    const firstSessions = createSessions([firstEffect, { assistantText: 'Done.', actions: [] }]);
    const replaySessions = createSessions([replayedEffect, { assistantText: 'Done again.', actions: [] }]);
    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    const first = await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice', userText: 'first', durableLocalId: 'test-durable-local-id', currentToolSessionId: 's1', currentToolSessionAddress, voiceAgentSessions: firstSessions,
    });
    const replay = await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice', userText: 'replay', durableLocalId: 'test-durable-local-id', currentToolSessionId: 's1', currentToolSessionAddress, voiceAgentSessions: replaySessions,
    });

    expect(localVoicePendingEnqueue).toHaveBeenCalledTimes(1);
    expect(replay.toolResultBatches[0]).toEqual(first.toolResultBatches[0]);
  });

  it('retains more than 8,192 sequential stable local effect outcomes for the active session', async () => {
    await prepareSession();
    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');
    const { getRetainedLocalVoiceEffectOutcomes } = await import('@/voice/tools/localVoiceEffectOutcomeCustody');
    const retainedOutcomes = getRetainedLocalVoiceEffectOutcomes('sys_voice');
    for (let index = 0; index < 8_192; index += 1) {
      retainedOutcomes.set(`effect-${index}`, {
        fingerprint: `settled-effect-${index}`,
        outcome: Promise.resolve({
          t: 'sendSessionMessage',
          args: { message: `Message ${index}` },
          result: { ok: true },
        }),
      });
    }
    const finalAction = attachVoiceAgentActionEffectId(
      {
        t: 'sendSessionMessage',
        args: { message: 'Message 8192' },
      },
      'effect-8192',
    );
    const sessions = createSessions([
      { assistantText: 'Sending.', actions: [finalAction] },
      { assistantText: 'Done.', actions: [] },
    ]);

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice',
      userText: 'send all',
      durableLocalId: 'test-durable-local-id',
      currentToolSessionId: 's1', currentToolSessionAddress,
      voiceAgentSessions: sessions,
    });

    expect(result.toolResultBatches[0]?.at(-1)).toMatchObject({
      t: 'sendSessionMessage',
      result: { ok: true },
    });
    expect(localVoicePendingEnqueue).toHaveBeenCalledOnce();
    expect(retainedOutcomes).toHaveLength(8_193);
  }, 180_000);

  it('releases retained effect outcomes when the owning local Voice session stops', async () => {
    await prepareSession();
    const firstEffect = await streamResponse('effect-after-stop', 'Do it once');
    const restartedEffect = await streamResponse('effect-after-stop', 'Do it once');
    const firstSessions = createSessions([firstEffect, { assistantText: 'Done.', actions: [] }]);
    const restartedSessions = createSessions([restartedEffect, { assistantText: 'Done after restart.', actions: [] }]);
    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice', userText: 'first', durableLocalId: 'test-durable-local-id', currentToolSessionId: 's1', currentToolSessionAddress, voiceAgentSessions: firstSessions,
    });

    const { stopLocalVoiceAgent } = await import('./localVoiceEngine');
    await stopLocalVoiceAgent('sys_voice');

    await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice', userText: 'after restart', durableLocalId: 'test-durable-local-id', currentToolSessionId: 's1', currentToolSessionAddress, voiceAgentSessions: restartedSessions,
    });

    expect(localVoicePendingEnqueue).toHaveBeenCalledTimes(2);
  });

  it('fails closed when one canonical effect identity is reused with different arguments', async () => {
    await prepareSession();
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
      sessionId: 'sys_voice', userText: 'first', durableLocalId: 'test-durable-local-id', currentToolSessionId: 's1', currentToolSessionAddress, voiceAgentSessions: sessions,
    });
    const replay = await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice', userText: 'conflict', durableLocalId: 'test-durable-local-id', currentToolSessionId: 's1', currentToolSessionAddress, voiceAgentSessions: sessions,
    });

    expect(localVoicePendingEnqueue).toHaveBeenCalledTimes(1);
    expect(replay.toolResultBatches[0]?.[0]).toMatchObject({
      t: 'sendSessionMessage',
      result: { ok: false, errorCode: 'tool_call_identity_conflict' },
    });
  });

  it.each([false, true])('reports pending admission as unknown when HTTP cannot prove completion (abort: %s)', async (abortAfterDispatch) => {
    await prepareSession();
    const controller = new AbortController();
    localVoicePendingEnqueue.mockImplementation(async () => {
      if (abortAfterDispatch) controller.abort();
      throw new Error('transport closed after dispatch');
    });
    const effectResponse = await streamResponse('effect-unknown', 'Maybe sent');
    const sessions = createSessions([effectResponse, { assistantText: 'I cannot confirm it.', actions: [] }]);
    const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');

    const result = await runVoiceAgentTurnWithTools({
      sessionId: 'sys_voice', userText: 'send it', durableLocalId: 'test-durable-local-id', currentToolSessionId: 's1', currentToolSessionAddress, voiceAgentSessions: sessions, signal: controller.signal,
    });

    expect(localVoicePendingEnqueue).toHaveBeenCalledTimes(1);
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({
      t: 'sendSessionMessage',
      result: { ok: true, status: 'outcomeUnknown', code: 'session_input_pending', localId: expect.any(String) },
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
      sessionId: 'sys_voice', userText: 'send it', durableLocalId: 'test-durable-local-id', currentToolSessionId: 's1', currentToolSessionAddress, voiceAgentSessions: sessions,
    });

    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({
      t: 'sendSessionMessage',
      result: { ok: false, errorCode: 'session_not_found' },
    });
  });
});
