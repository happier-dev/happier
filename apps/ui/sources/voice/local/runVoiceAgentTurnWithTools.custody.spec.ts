import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  getStorage, registerLocalVoiceEngineHarnessHooks, warmLocalVoiceEngineHarnessGraph,
  localVoicePendingEnqueue, sessionRpcWithServerScope, readLocalVoiceHttpRequests,
  localVoiceHomeId, acknowledgeLocalVoicePendingEnqueue, loadLocalVoiceEngineWithCompatState,
} from './localVoiceEngine.testHarness';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExecutionRunTurnStreamStartV2RequestSchema, ExecutionRunTurnStreamStartResponseSchema,
  ExecutionRunTurnStreamReadRequestSchema, ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamCancelRequestSchema, ExecutionRunTurnStreamCancelResponseSchema,
  type ExecutionRunTurnStreamEvent } from '@happier-dev/protocol/execution/runs/streaming';
import type { VoiceAssistantAction } from '@happier-dev/protocol';
import { parseVoiceToolResultsFollowUp } from '@happier-dev/protocol/voice/toolResultsChannel';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';

const restoreHarness = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarness());
const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
const { voiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingRuntime');
const { runVoiceAgentTurnWithTools } = await import('./runVoiceAgentTurnWithTools');
const { getRetainedLocalVoiceEffectOutcomes, clearRetainedLocalVoiceEffectOutcomes } =
  await import('@/voice/tools/localVoiceEffectOutcomeCustody');

type Turn = (streamId: string) => readonly ExecutionRunTurnStreamEvent[];
let turns: Turn[];
let turnIndex = 0;
const outputs = new Map<string, readonly ExecutionRunTurnStreamEvent[]>();
let malformedReply = false;
const wireTurns: Array<ReturnType<typeof ExecutionRunTurnStreamStartV2RequestSchema.parse>> = [];

function finalEvent(streamId: string, seq = 0, text = 'Done.'): ExecutionRunTurnStreamEvent {
  return { t: 'voice_output', output: { v: 1, kind: 'turn_final', turnId: streamId, seq, text } };
}
function queueFinal(text = 'Done.') {
  turns.push(streamId => [finalEvent(streamId, 0, text)]);
}
function queueAction(effectId: string, action: VoiceAssistantAction, replayCount = 1) {
  turns.push(streamId => [
    ...Array.from({ length: replayCount }, (): ExecutionRunTurnStreamEvent => ({
      t: 'voice_output', output: { v: 1, kind: 'side_effect', turnId: streamId, seq: 0, effectId, action },
    })),
    finalEvent(streamId, 1, 'Working on it.'),
  ]);
}
function queueSend(effectId: string, message: string, args: Record<string, unknown> = {}, replayCount = 1) {
  queueAction(effectId, { t: 'sendSessionMessage', args: { ...args, message } }, replayCount);
}
function targetPendingRequests() {
  return readLocalVoiceHttpRequests().filter(request =>
    request.method === 'POST' && request.path === '/v2/sessions/s1/pending');
}

describe('runVoiceAgentTurnWithTools local effect custody', () => {
  registerLocalVoiceEngineHarnessHooks();
  beforeEach(() => {
    turns = []; turnIndex = 0; outputs.clear(); wireTurns.length = 0; malformedReply = false;
    // Configure only daemon wire leaves; retained ensure/list/get/stop and every
    // other Session method still use the incumbent authenticated boundary.
    const incumbent = sessionRpcWithServerScope.getMockImplementation();
    sessionRpcWithServerScope.mockImplementation(async request => {
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
        wireTurns.push(ExecutionRunTurnStreamStartV2RequestSchema.parse(request.payload));
        const streamId = 'canonical-turn-' + turnIndex++;
        const turn = turns.shift();
        if (!turn) throw new Error('Unexpected additional custody provider turn');
        outputs.set(streamId, turn(streamId));
        return ExecutionRunTurnStreamStartResponseSchema.parse({ streamId });
      }
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
        const input = ExecutionRunTurnStreamReadRequestSchema.parse(request.payload);
        if (malformedReply) {
          // Deliberately malformed daemon wire input: the actual client's strict
          // reader, rather than this fixture, must refuse an absent effect id.
          return { streamId: input.streamId, events: [{ t: 'voice_output', output: {
            v: 1, kind: 'side_effect', turnId: input.streamId, seq: 0,
            action: { t: 'sendSessionMessage', args: { message: 'Must not send' } },
          } }], nextCursor: 1, done: true };
        }
        const events = outputs.get(input.streamId);
        if (!events) throw new Error('Unknown custody stream');
        return ExecutionRunTurnStreamReadResponseSchema.parse({ streamId: input.streamId,
          events: input.cursor === 0 ? events : [], nextCursor: events.length, done: true });
      }
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) {
        ExecutionRunTurnStreamCancelRequestSchema.parse(request.payload);
        return ExecutionRunTurnStreamCancelResponseSchema.parse({ ok: true });
      }
      if (!incumbent) throw new Error('Retained daemon boundary unavailable');
      return incumbent(request);
    });
  });

  afterEach(async () => {
    await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
    clearRetainedLocalVoiceEffectOutcomes(VOICE_AGENT_GLOBAL_SESSION_ID);
  });

  async function prepareSession() {
    await loadLocalVoiceEngineWithCompatState();
    const storage = await getStorage();
    const settings = storage.getState().settings;
    const cfg = readLocalConversationVoiceSettings(settings.voice);
    storage.__setState({ settings: { ...settings, voice: { ...settings.voice, providers: {
      ...settings.voice.providers, local_conversation: { schemaVersion: 1, config: {
        ...cfg, conversationMode: 'agent', agent: { ...cfg.agent, agentSource: 'session', prewarmOnConnect: false },
        streaming: { ...cfg.streaming, enabled: true, ttsEnabled: false },
      } },
    } } } });
    const binding = await voiceSessionBindingManager.ensureBound({ adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, requestedTargetSessionId: 's1' });
    expect(binding?.targetSessionAddress).toEqual({ serverId: localVoiceHomeId, sessionId: 's1' });
    expect(readLocalConversationVoiceSettings(storage.getState().settings.voice).streaming.enabled).toBe(true);
  }

  function run(userText = 'do it', options: Partial<Parameters<typeof runVoiceAgentTurnWithTools>[0]> = {}) {
    return runVoiceAgentTurnWithTools({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, userText,
      durableLocalId: 'custody-input-' + wireTurns.length, currentToolSessionId: 's1',
      currentToolSessionAddress: { serverId: localVoiceHomeId, sessionId: 's1' },
      voiceAgentSessions, ...options });
  }

  it('reads Account settings from the bound Voice Home without a coding Session target', async () => {
    await prepareSession();
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const binding = voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID);
    if (!binding) throw new Error('Expected an admitted Voice conversation');
    voiceSessionBindingStore.getState().bind({ ...binding, targetSessionAddress: null });
    const storage = await getStorage();
    const expected = readLocalConversationVoiceSettings(storage.getState().settings.voice).handsFree.endpointing.minSpeechMs;
    queueAction('read-voice-setting', { t: 'settings_get', args: { anchor: 'voiceConversations.minSpeechMs' } });
    queueFinal();
    const result = await run('read the saved minimum speech duration', {
      currentToolSessionAddress: null, currentToolSessionId: null,
    });
    expect(result.toolResultBatches[0]?.[0]?.result).toMatchObject({
      ok: true, anchor: 'voiceConversations.minSpeechMs', value: expected,
    });
    expect(targetPendingRequests()).toEqual([]);
  });

  it('forwards accepted canonical output from every tool round', async () => {
    await prepareSession();
    turns.push(streamId => [
      { t: 'voice_output', output: { v: 1, kind: 'display_status', turnId: streamId, seq: 0, statusId: 'status-0', text: 'Working' } },
      { t: 'voice_output', output: { v: 1, kind: 'side_effect', turnId: streamId, seq: 1,
        effectId: 'read-sessions', action: { t: 'listSessions', args: { limit: 1 } } } },
      finalEvent(streamId, 2, 'Checking.'),
    ]);
    turns.push(streamId => [
      { t: 'voice_output', output: { v: 1, kind: 'display_status', turnId: streamId, seq: 0, statusId: 'status-1', text: 'Finishing' } },
      finalEvent(streamId, 1),
    ]);
    const observedTurnIds: string[] = [];
    const result = await run('check sessions', { onOutputEvent: async ({ event }) => {
      if (event.kind === 'display_status') observedTurnIds.push(event.turnId);
    } });
    expect(observedTurnIds).toEqual(['canonical-turn-0', 'canonical-turn-1']);
    expect(wireTurns).toHaveLength(2);
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({ t: 'listSessions' });
    expect(targetPendingRequests()).toEqual([]);
  });


  it('refuses a malformed canonical wire effect without a stable id before outward mutation', async () => {
    await prepareSession();
    queueFinal(); malformedReply = true;
    await expect(run('send it')).rejects.toThrow('invalid_rpc_response');
    expect(targetPendingRequests()).toEqual([]);
    expect(getRetainedLocalVoiceEffectOutcomes(VOICE_AGENT_GLOBAL_SESSION_ID).size).toBe(0);
  });

  it('retains and reports a completed canonical effect when abort fires at the handler completion boundary', async () => {
    await prepareSession();
    const controller = new AbortController();
    localVoicePendingEnqueue.mockImplementation(async request => {
      if (request.sessionId !== 's1') return acknowledgeLocalVoicePendingEnqueue(request);
      controller.abort();
      const { body } = request;
      return Response.json({ requestedAction: body.requestedAction, pending: { localId: body.localId } });
    });
    queueSend('effect-completed', 'Do it once');
    const onToolResults = vi.fn(async () => undefined);
    const result = await run('do it', { signal: controller.signal, onToolResults });
    expect(targetPendingRequests()).toHaveLength(1);
    expect(onToolResults).toHaveBeenCalledWith({ turnIndex: 0, toolResults: [expect.objectContaining({
      t: 'sendSessionMessage', result: expect.objectContaining({ ok: true }),
    })] });
    expect(result.toolResultBatches).toEqual([
      [expect.objectContaining({ t: 'sendSessionMessage', result: expect.objectContaining({ ok: true }) })],
    ]);
  });

  it('executes one action when a canonical stable effect is replayed in the same stream', async () => {
    await prepareSession(); queueSend('effect-same-stream', 'Do it once', {}, 2); queueFinal();
    const result = await run();
    expect(targetPendingRequests()).toHaveLength(1);
    expect(targetPendingRequests()[0]?.body).toMatchObject({
      content: { t: 'plain', v: { content: { text: 'Do it once' } } }, requestedAction: { v: 1, kind: 'steer_if_active' },
    });
    expect(result.totalActions).toBe(1); expect(result.toolResultBatches).toHaveLength(1);
  });

  it('reuses a retained canonical effect outcome across replay without rerunning the handler', async () => {
    await prepareSession();
    queueSend('effect-replay', 'Do it once'); queueFinal();
    const first = await run('first');
    queueSend('effect-replay', 'Do it once'); queueFinal('Done again.');
    const replay = await run('replay');
    expect(targetPendingRequests()).toHaveLength(1);
    expect(replay.toolResultBatches[0]).toEqual(first.toolResultBatches[0]);
  });

  it('retains more than 8,192 sequential stable local effect outcomes for the active session', async () => {
    await prepareSession();
    const retainedOutcomes = getRetainedLocalVoiceEffectOutcomes(VOICE_AGENT_GLOBAL_SESSION_ID);
    for (let index = 0; index < 8_192; index++) retainedOutcomes.set('effect-' + index, {
      fingerprint: 'settled-effect-' + index, outcome: Promise.resolve({ t: 'sendSessionMessage',
        args: { message: 'Message ' + index }, result: { ok: true } }),
    });
    queueSend('effect-8192', 'Message 8192'); queueFinal();
    const result = await run('send all');
    expect(result.toolResultBatches[0]?.at(-1)).toMatchObject({ t: 'sendSessionMessage', result: { ok: true } });
    expect(targetPendingRequests()).toHaveLength(1);
    expect(retainedOutcomes).toHaveLength(8_193);
  }, 180_000);

  it('releases retained effect outcomes when the owning local Voice session stops', async () => {
    await prepareSession(); queueSend('effect-after-stop', 'Do it once'); queueFinal();
    await run('first');
    const { stopLocalVoiceAgent } = await import('./localVoiceEngine');
    await stopLocalVoiceAgent(VOICE_AGENT_GLOBAL_SESSION_ID);
    expect(getRetainedLocalVoiceEffectOutcomes(VOICE_AGENT_GLOBAL_SESSION_ID).size).toBe(0);
    queueSend('effect-after-stop', 'Do it once'); queueFinal('Done after restart.');
    await run('after restart');
    expect(targetPendingRequests()).toHaveLength(2);
  });

  it('fails closed when one canonical effect identity is reused with different arguments', async () => {
    await prepareSession(); queueSend('effect-conflict', 'First mutation'); queueFinal();
    await run('first');
    queueSend('effect-conflict', 'Different mutation'); queueFinal('Conflict noted.');
    const replay = await run('conflict');
    expect(targetPendingRequests()).toHaveLength(1);
    expect(replay.toolResultBatches[0]?.[0]).toMatchObject({ t: 'sendSessionMessage',
      result: { ok: false, errorCode: 'tool_call_identity_conflict' } });
  });

  it.each([false, true])('reports pending admission as unknown when HTTP cannot prove completion (abort: %s)', async abortAfterDispatch => {
    await prepareSession();
    const controller = new AbortController();
    localVoicePendingEnqueue.mockImplementation(async request => {
      if (request.sessionId !== 's1') return acknowledgeLocalVoicePendingEnqueue(request);
      if (abortAfterDispatch) controller.abort();
      // The Home responded, but the write lacks an authoritative Pending row
      // receipt. The actual sender must retain unknown custody without turning
      // this request-level ambiguity into a whole-Home connectivity outage.
      return Response.json({ requestedAction: request.body.requestedAction });
    });
    queueSend('effect-unknown', 'Maybe sent');
    if (!abortAfterDispatch) queueFinal('I cannot confirm it.');
    const result = await run('send it', { signal: controller.signal });
    expect(targetPendingRequests()).toHaveLength(1);
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({ t: 'sendSessionMessage',
      result: { ok: true, status: 'outcomeUnknown', code: 'session_input_pending', localId: expect.any(String) } });
    queueSend('effect-unknown', 'Maybe sent'); queueFinal('No retry.');
    const replay = await run('retry');
    expect(targetPendingRequests()).toHaveLength(1);
    expect(replay.toolResultBatches[0]).toEqual(result.toolResultBatches[0]);
  });

  it('preserves a known pre-dispatch failure instead of misreporting outcome_unknown', async () => {
    await prepareSession(); queueSend('effect-known-failure', 'Cannot dispatch', { sessionId: 'missing-session' }); queueFinal();
    const result = await run('send it');
    expect(targetPendingRequests()).toEqual([]);
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({ t: 'sendSessionMessage',
      result: { ok: false, errorCode: 'admission_unavailable' } });
  });

  it('speaks only the outcome-informed follow-up when a requested send fails before dispatch', async () => {
    await prepareSession();
    queueSend('effect-truthful-failure', 'Cannot dispatch', { sessionId: 'missing-session' });
    queueFinal('I could not send it.');
    const spoken: string[] = [];
    const result = await run('send it', { onAssistantTurn: async ({ assistantText }) => {
      // The non-streaming TTS consumer awaits this callback before continuing.
      expect(parseVoiceToolResultsFollowUp(wireTurns.at(-1)?.message)).toMatchObject({
        toolResults: [expect.objectContaining({ t: 'sendSessionMessage', result: expect.objectContaining({ ok: false, errorCode: 'admission_unavailable' }) })],
      });
      expect(targetPendingRequests()).toEqual([]);
      spoken.push(assistantText);
    } });
    expect(spoken).toEqual(['I could not send it.']);
    expect(result.assistantTurns).toEqual(['I could not send it.']);
  });
});
