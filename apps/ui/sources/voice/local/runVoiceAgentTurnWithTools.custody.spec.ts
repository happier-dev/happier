import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  getStorage, registerLocalVoiceEngineHarnessHooks, warmLocalVoiceEngineHarnessGraph,
  localVoicePendingEnqueue, sessionRpcWithServerScope, readLocalVoiceHttpRequests,
  localVoiceHomeId, acknowledgeLocalVoicePendingEnqueue, loadLocalVoiceEngineWithCompatState,
  setLocalVoiceHttpResponder,
  machineRpcWithServerScope,
} from './localVoiceEngine.testHarness';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { createSessionFixture } from '@/dev/testkit';
import { ExecutionRunTurnStreamStartV2RequestSchema, ExecutionRunTurnStreamStartResponseSchema,
  ExecutionRunTurnStreamReadRequestSchema, ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamCancelRequestSchema, ExecutionRunTurnStreamCancelResponseSchema,
  type ExecutionRunTurnStreamEvent } from '@happier-dev/protocol/execution/runs/streaming';
import type { VoiceAssistantAction } from '@happier-dev/protocol/voice/actions';
import { parseVoiceToolResultsFollowUp } from '@happier-dev/protocol/voice/toolResultsChannel';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';

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

  it('presents the created Session outcome instead of the model follow-up narration', async () => {
    await prepareSession();
    queueAction('create-outcome', { t: 'spawnSession', args: {
      executionTarget: { serverId: localVoiceHomeId, machineId: 'machine-1' },
      directory: { kind: 'path', path: '/project' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    } });
    queueFinal('I found the Session creation action.');
    const result = await run('create a Session');
    expect(result.totalActions).toBe(1);
    expect(result.toolResultBatches[0]?.[0]?.result, JSON.stringify(result.toolResultBatches))
      .toMatchObject({ ok: true, type: 'success' });
    expect(result.assistantTurns).toHaveLength(1);
    expect(result.assistantTurns[0]).toBe(t('newSession.sessionStartedMessage'));
    expect(result.assistantTurns[0]).not.toContain('creation action');
  });

  it('retains the created working Session through a cold Home continuation and sends the next implicit message there', async () => {
    await prepareSession();
    const storage = await getStorage();
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    const originalBinding = await voiceSessionBindingManager.syncTargetSession({
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, targetSessionAddress: null,
    });
    if (!originalBinding) throw new Error('Expected Home conversation binding');
    const target = { serverId: localVoiceHomeId, sessionId: 'created-coding-session' };
    const incumbent = machineRpcWithServerScope.getMockImplementation();
    let creationCount = 0;
    machineRpcWithServerScope.mockImplementation(async request => {
      if (request.method !== RPC_METHODS.SESSION_SPAWN_NEW) {
        if (!incumbent) throw new Error('Expected Machine boundary');
        return incumbent(request);
      }
      const input = SessionSpawnNewInputV2Schema.parse(request.payload);
      creationCount += 1;
      storage.getState().applySessions([createSessionFixture({ id: target.sessionId, serverId: target.serverId,
        active: true, activeAt: Date.now(),
        metadata: { machineId: input.executionTarget.machineId, path: '/project', host: 'test', flavor: 'claude' },
      })]);
      return SessionSpawnNewResultV1Schema.parse({ type: 'success', disposition: 'created', sessionId: target.sessionId,
        executionTarget: input.executionTarget, organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'notRequested' },
      });
    });
    queueAction('create-working-session', { t: 'spawnSession', args: {
      executionTarget: { serverId: localVoiceHomeId, machineId: 'machine-1' },
      directory: { kind: 'path', path: '/project' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    } });
    queueFinal();
    const created = await run('create a Session', { currentToolSessionAddress: null, currentToolSessionId: null });
    expect(created.toolResultBatches[0]?.[0]?.result).toMatchObject({ ok: true, type: 'success', sessionId: target.sessionId });
    await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
    clearRetainedLocalVoiceEffectOutcomes(VOICE_AGENT_GLOBAL_SESSION_ID);

    // Reload discards every device-only target and binding. The next Start
    // hydrates the same conversation from the real metadata HTTP owner.
    voiceSessionBindingStore.setState({ bindingsByConversationSessionId: {}, runtimeBindingsByConversationSessionId: {},
      persistedBindingsByConversationSessionId: {} });
    useVoiceTargetStore.setState({ primaryActionSessionAddress: null, lastFocusedSessionAddress: null });
    storage.setState(current => ({ sessions: Object.fromEntries(Object.entries(current.sessions)
      .filter(([id]) => id !== originalBinding.conversationSessionId)), sessionListRowsByServerId: {} }));
    const restored = await voiceSessionBindingManager.ensureBound({ adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, requestedTargetServerId: localVoiceHomeId,
      conversationSelection: { kind: 'continue', conversationSessionAddress: originalBinding.conversationSessionAddress },
    });
    expect(restored?.targetSessionAddress).toEqual(target);
    expect(creationCount).toBe(1);

    localVoicePendingEnqueue.mockImplementation(async request => acknowledgeLocalVoicePendingEnqueue(request));
    queueSend('follow-up-current-session', 'create another file');
    queueFinal();
    const followUp = await run('ask it to create another file', {
      currentToolSessionAddress: restored?.targetSessionAddress,
      currentToolSessionId: restored?.targetSessionAddress?.sessionId ?? null,
    });
    expect(followUp.toolResultBatches[0]?.[0]?.result).toMatchObject({ ok: true });
    expect(readLocalVoiceHttpRequests().filter(request => request.method === 'POST'
      && request.path === `/v2/sessions/${target.sessionId}/pending`)).toHaveLength(1);
    expect(creationCount).toBe(1);
  });

  it.each([
    { name: 'person direct write ON', turnOrigin: 'person', canApproveRequests: true, lookup: false, expected: 'executed' },
    { name: 'person lookup then write ON', turnOrigin: 'person', canApproveRequests: true, lookup: true, expected: 'executed' },
    { name: 'unsolicited follow-up turn ON', turnOrigin: 'synthetic', canApproveRequests: true, lookup: true, expected: 'approval' },
    { name: 'person lookup then write OFF', turnOrigin: 'person', canApproveRequests: false, lookup: true, expected: 'approval' },
  ] as const)('preserves approval authority for the whole turn: $name', async ({ turnOrigin, canApproveRequests, lookup, expected }) => {
    await prepareSession();
    const storage = await getStorage();
    storage.__setState({ settings: { ...storage.getState().settings,
      voice: { ...storage.getState().settings.voice, canApproveRequests } } });
    const settings = storage.getState().settings;
    const { setVoiceSessionSnapshot, resetVoiceSessionStoreForTests } = await import('@/voice/session/voiceSessionStore');
    setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      status: 'connected', mode: 'listening', canStop: true });
    let created!: () => void;
    const approval = new Promise<'approval'>(resolve => { created = () => resolve('approval'); });
    setLocalVoiceHttpResponder(async request => {
      if (request.path === '/v2/account/settings' && request.method === 'GET') {
        return Response.json({ version: 1, content: { t: 'plain', v: settings } });
      }
      if (request.path === '/v1/artifacts' && request.method === 'POST') created();
      return undefined;
    });
    if (lookup) queueAction('read-before-write', { t: 'settings_get', args: { anchor: 'voiceConversations.minSpeechMs' } });
    queueAction('origin-setting', { t: 'settings_set', args: { anchor: 'voiceConversations.minSpeechMs', value: 1100 } });
    queueFinal();
    const controller = new AbortController();
    const pending = run('set minimum speech to 1100', { signal: controller.signal,
      turnOrigin,
      playHostText: async () => ({ status: 'completed' as const }) });
    try {
      const result = await Promise.race([approval, pending.then(() => 'executed' as const)]);
      expect(result).toBe(expected);
      if (expected === 'executed') {
        const outcome = await pending;
        expect(outcome.toolResultBatches[lookup ? 1 : 0]?.[0]?.result, JSON.stringify(outcome.toolResultBatches))
          .toMatchObject({ ok: true, value: 1100 });
      }
    } finally {
      controller.abort(); await pending.catch(() => {}); resetVoiceSessionStoreForTests();
    }
  });

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

  it('acknowledges delegated delivery without predicting approval', async () => {
    await prepareSession();
    const input = { sessionId: 's1', message: 'Write the requested file.', reply: 'none' };
    queueSend('delegated-write', input.message, { sessionId: input.sessionId, reply: input.reply });
    queueFinal('The session needs your approval before running a terminal command.');
    const spoken: string[] = [];
    const streamed: string[] = [];
    const result = await run('ask the session to write the file', {
      onAssistantTurn: async ({ assistantText }) => { spoken.push(assistantText); },
      onOutputEvent: async output => {
        for (const effect of output.effects) if (effect.kind === 'speak') streamed.push(effect.text);
      },
    });
    expect(targetPendingRequests()).toHaveLength(1);
    expect(result.toolResultBatches[0]?.[0]?.result).toMatchObject({ ok: true, status: 'accepted' });
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatch(/sent/i);
    expect([...spoken, ...streamed].join(' ')).not.toMatch(/approv|permission|terminal command/i);
    expect(result.assistantTurns).toEqual(spoken);
  });

  it.each([false, true])('refuses the Voice carrier as a message target with working target bound=%s', async (bound) => {
    await prepareSession();
    const binding = await voiceSessionBindingManager.syncTargetSession({
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      targetSessionAddress: bound ? { serverId: localVoiceHomeId, sessionId: 's1' } : null,
    });
    if (!binding) throw new Error('Expected Voice conversation binding');
    const currentToolSessionAddress = binding.targetSessionAddress;
    const options = { currentToolSessionAddress, currentToolSessionId: currentToolSessionAddress?.sessionId ?? null };
    queueSend('self-carrier-send', 'Create another file', {
      sessionId: binding.conversationSessionId, reply: 'none',
    });
    queueFinal();
    const rejected = await run('ask it to create another file', options);
    expect(rejected.toolResultBatches[0]?.[0]?.result).toMatchObject({
      ok: false, errorCode: 'voice_conversation_target_forbidden',
    });
    expect(readLocalVoiceHttpRequests().filter(request => request.method === 'POST'
      && request.path === `/v2/sessions/${binding.conversationSessionId}/pending`)).toHaveLength(0);

    queueSend('valid-working-target-send', 'Create another file', bound ? {} : { sessionId: 's1' });
    queueFinal();
    const accepted = await run('ask the coding Session to create another file', options);
    expect(accepted.toolResultBatches[0]?.[0]?.result).toMatchObject({ ok: true, status: 'accepted' });
    expect(targetPendingRequests()).toHaveLength(1);
  });

  it.each([
    { name: 'ordinary direct native Session', carrier: false },
    { name: 'qualified carrier self selector', carrier: true },
  ])('admits the exact resolved message recipient for $name', async ({ carrier }) => {
    await prepareSession();
    const binding = await voiceSessionBindingManager.syncTargetSession({
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      targetSessionAddress: { serverId: localVoiceHomeId, sessionId: 's1' },
    });
    if (!binding) throw new Error('Expected Voice conversation binding');
    const { createVoiceToolHandlers } = await import('@/voice/tools/handlers');
    const tools = createVoiceToolHandlers({
      voiceSessionBinding: carrier ? binding : { ...binding, transcriptMode: 'native_session', conversationSessionId: 's1',
        conversationSessionAddress: { serverId: localVoiceHomeId, sessionId: 's1' } },
      currentSessionAddress: { serverId: localVoiceHomeId, sessionId: 's1' },
      resolveSessionId: () => 's1',
    });
    const sessionId = carrier ? { selector: 'self', of: binding.conversationSessionId } : 's1';
    const result = JSON.parse(await tools.sendSessionMessage!({ sessionId, message: 'Create another file' }, {
      serverId: localVoiceHomeId, callId: 'direct-session-send',
    }));
    expect(result).toMatchObject(carrier
      ? { ok: false, errorCode: 'voice_conversation_target_forbidden' }
      : { ok: true, status: 'accepted' });
    expect(readLocalVoiceHttpRequests().filter(request => request.method === 'POST'
      && request.path === `/v2/sessions/${binding.conversationSessionId}/pending`)).toHaveLength(0);
    expect(targetPendingRequests()).toHaveLength(carrier ? 0 : 1);
  });

  it('keeps sending in one conversation after an invented target id is corrected', async () => {
    await prepareSession();
    queueSend('first-target-send', 'Reply MAPLE.', { sessionId: 's1', reply: 'none' }); queueFinal();
    const first = await run('tell the other session to reply maple');
    expect(first.toolResultBatches[0]?.[0]?.result).toMatchObject({ ok: true, status: 'accepted' });
    expect(targetPendingRequests()).toHaveLength(1);

    // RUN98: the provider combined the real target's prefix with its carrier's
    // suffix. This is an unknown Session, not an unavailable messaging Action.
    queueSend('invented-target-send', 'Reply CEDAR.', { sessionId: 'cmw8g2fvf002nmcyaoup36tyj', reply: 'none' });
    queueSend('corrected-target-send', 'Reply CEDAR.', { sessionId: 's1', reply: 'none' }); queueFinal();
    const second = await run('tell that session to reply cedar');
    // This headless fixture has no complete mounted Session corpus, so absence
    // cannot be claimed. The target lookup remains incomplete, not unavailable.
    expect(second.toolResultBatches[0]?.[0]?.result).toMatchObject({ ok: false, errorCode: 'session_lookup_incomplete' });
    expect(second.toolResultBatches[1]?.[0]?.result).toMatchObject({ ok: true, status: 'accepted' });
    expect(targetPendingRequests()).toHaveLength(2);
    expect(new Set(wireTurns.map(turn => turn.runId)).size).toBe(1);
  });

  it('preserves a known pre-dispatch failure instead of misreporting outcome_unknown', async () => {
    await prepareSession(); queueSend('effect-known-failure', 'Cannot dispatch', { sessionId: 'missing-session' }); queueFinal();
    const result = await run('send it');
    expect(targetPendingRequests()).toEqual([]);
    expect(result.toolResultBatches[0]?.[0]).toMatchObject({ t: 'sendSessionMessage',
      result: { ok: false, errorCode: 'session_lookup_incomplete' } });
  });

  it('speaks only the outcome-informed follow-up when a requested send fails before dispatch', async () => {
    await prepareSession();
    queueSend('effect-truthful-failure', 'Cannot dispatch', { sessionId: 'missing-session' });
    queueFinal('Sent. The session needs approval.');
    const spoken: string[] = [];
    const result = await run('send it', { onAssistantTurn: async ({ assistantText }) => {
      // The non-streaming TTS consumer awaits this callback before continuing.
      expect(parseVoiceToolResultsFollowUp(wireTurns.at(-1)?.message)).toMatchObject({
        toolResults: [expect.objectContaining({ t: 'sendSessionMessage', result: expect.objectContaining({ ok: false, errorCode: 'session_lookup_incomplete' }) })],
      });
      expect(targetPendingRequests()).toEqual([]);
      spoken.push(assistantText);
    } });
    expect(spoken).toEqual([t('session.askRecord.notSent')]);
    expect(result.assistantTurns).toEqual(spoken);
  });
});
