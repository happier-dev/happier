import { afterAll, describe, expect, it } from 'vitest';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExecutionRunTurnStreamStartRequestSchema, ExecutionRunTurnStreamStartV2RequestSchema } from '@happier-dev/protocol/execution/runs/streaming';
import {
  getStorage, loadLocalVoiceEngineWithCompatState, localVoiceAgentRpc, localVoiceSpeechOutputBoundary,
  registerLocalVoiceEngineHarnessHooks, sessionRpcWithServerScope, warmLocalVoiceEngineHarnessGraph,
} from '@/voice/local/localVoiceEngine.testHarness';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';

const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarnessModuleLoader());

async function selectAgentMode() {
  await loadLocalVoiceEngineWithCompatState();
  const storage = await getStorage();
  const state = storage.getState();
  const config = readLocalConversationVoiceSettings(state.settings.voice);
  storage.__setState({ settings: { ...state.settings, voice: { ...state.settings.voice,
    providerId: 'local_conversation', providers: { ...state.settings.voice.providers,
      local_conversation: { schemaVersion: 1, config: { ...config, conversationMode: 'agent',
        agent: { ...config.agent, prewarmOnConnect: false } } } } } } });
}

function admittedProviderText() {
  const request = [...localVoiceAgentRpc.requests].reverse().find(request =>
    request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START
    || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2);
  if (!request) throw new Error('No actual Agent turn was admitted');
  return (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2
    ? ExecutionRunTurnStreamStartV2RequestSchema : ExecutionRunTurnStreamStartRequestSchema).parse(request.input).message;
}

describe('createLocalVoiceAdapter', () => {
  registerLocalVoiceEngineHarnessHooks();

  it('uses the Session Agent admitted by Start when the first Send is delayed', async () => {
    await selectAgentMode();
    const { createLocalVoiceAdapter } = await import('./createLocalVoiceAdapter');
    const adapter = createLocalVoiceAdapter('local_conversation', { contextUpdates: true, textTurns: true });
    await adapter.toggle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    const storage = await getStorage();
    const carrier = storage.getState().sessions['voice-home-session'];
    storage.__setState({ sessions: { ...storage.getState().sessions, 'voice-home-session': {
      ...carrier, metadataLayoutVersion: 1,
      ownerMetadataView: { ...carrier.metadata, flavor: 'claude' },
    } } });
    await adapter.sendTextTurn?.({ controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-home-session', text: 'Inspect this', localId: 'admitted-agent-turn',
      deliveryCommand: 'interrupt_and_send', onAccepted: async () => {} });
    const request = localVoiceAgentRpc.requests.find(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
      || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1);
    expect(request?.input).toMatchObject({ start: { backendTarget: { kind: 'backend', backendId: 'codex' } } });
  });

  it('refuses an unreadable retained Session Agent before opening the microphone', async () => {
    await selectAgentMode();
    const { createLocalVoiceAdapter } = await import('./createLocalVoiceAdapter');
    const { speechRecStart, localVoiceHomeId } = await import('@/voice/local/localVoiceEngine.testHarness');
    const adapter = createLocalVoiceAdapter('local_conversation', { contextUpdates: true, textTurns: true });
    await adapter.toggle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    await adapter.stop({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    const storage = await getStorage();
    const carrier = storage.getState().sessions['voice-home-session'];
    storage.__setState({ sessions: { ...storage.getState().sessions, 'voice-home-session': {
      ...carrier, metadata: { ...carrier.metadata, voiceConversationBindingV1: {
        v: 1, adapterId: 'local_conversation', controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        transcriptMode: 'native_session', targetSessionId: 'missing-coding-root',
        targetServerId: localVoiceHomeId, updatedAt: Date.now(),
      } },
    } } });
    speechRecStart.mockClear();
    localVoiceAgentRpc.requests.length = 0;
    await expect(adapter.start({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      requestedTargetSessionAddress: null,
    })).rejects.toMatchObject({ code: 'VOICE_AGENT_SELECTION_UNAVAILABLE' });
    expect(adapter.getSnapshot()).toMatchObject({ errorCode: 'provider_setup_required',
      errorMessage: 'VOICE_AGENT_SELECTION_UNAVAILABLE', errorRecoveryAction: 'open_settings' });
    expect(speechRecStart).not.toHaveBeenCalled();
    expect(localVoiceAgentRpc.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
      || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1)).toHaveLength(0);
  });

  it('exposes the requested adapter id on the disconnected snapshot', async () => {
    const { createLocalVoiceAdapter } = await import('./createLocalVoiceAdapter');
    const adapter = createLocalVoiceAdapter('local_direct', { contextUpdates: false, textTurns: false });
    expect(adapter.id).toBe('local_direct');
    expect(adapter.getSnapshot()).toMatchObject({ adapterId: 'local_direct', status: 'disconnected' });
  });

  it('admits enabled context to the real Agent turn and ignores disabled context', async () => {
    await selectAgentMode();
    const { createLocalVoiceAdapter } = await import('./createLocalVoiceAdapter');
    const enabled = createLocalVoiceAdapter('local_conversation', { contextUpdates: true, textTurns: true });
    await enabled.toggle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    enabled.sendContextUpdate({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, update: 'ENABLED_CONTEXT_SENTINEL' });
    const disabled = createLocalVoiceAdapter('local_direct', { contextUpdates: false, textTurns: false });
    disabled.sendContextUpdate({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, update: 'DISABLED_CONTEXT_SENTINEL' });
    await enabled.sendTextTurn?.({ controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-home-session', text: 'Inspect this', localId: 'enabled-context-turn',
      deliveryCommand: 'interrupt_and_send', onAccepted: async () => {} });
    expect(admittedProviderText()).toContain('ENABLED_CONTEXT_SENTINEL');
    expect(admittedProviderText()).not.toContain('DISABLED_CONTEXT_SENTINEL');
  });

  it('exposes optional text turns and observes actual durable acceptance', async () => {
    await selectAgentMode();
    const { createLocalVoiceAdapter } = await import('./createLocalVoiceAdapter');
    const withText = createLocalVoiceAdapter('local_conversation', { contextUpdates: true, textTurns: true });
    await withText.toggle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    let accepted = false;
    await withText.sendTextTurn?.({ controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-home-session', text: 'hi', localId: 'voice-local-1',
      deliveryCommand: 'interrupt_and_send', onAccepted: async () => { accepted = true; } });
    expect(accepted).toBe(true);
    expect(admittedProviderText()).toContain('hi');
    expect(localVoiceAgentRpc.readRetainedRun()?.status).toBe('running');
    const withoutText = createLocalVoiceAdapter('local_direct', { contextUpdates: false, textTurns: false });
    expect('sendTextTurn' in withoutText).toBe(false);
  });

  it('retains actual acceptance before a later response transport failure', async () => {
    await selectAgentMode();
    const { createLocalVoiceAdapter } = await import('./createLocalVoiceAdapter');
    const adapter = createLocalVoiceAdapter('local_conversation', { contextUpdates: true, textTurns: true });
    await adapter.toggle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    const fallback = sessionRpcWithServerScope.getMockImplementation();
    const responseFailure = new Error('assistant_stream_failed');
    let acceptedBeforeFailure = false;
    let accepted = false;
    sessionRpcWithServerScope.mockImplementation(async request => {
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
        acceptedBeforeFailure = accepted;
        throw responseFailure;
      }
      if (!fallback) throw new Error('Missing daemon transport responder');
      return fallback(request);
    });
    await expect(adapter.sendTextTurn?.({ controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-home-session', text: 'keep this prompt', localId: 'voice-local-accepted',
      deliveryCommand: 'interrupt_and_send', onAccepted: async () => { accepted = true; } })).rejects.toThrow(responseFailure);
    expect(accepted).toBe(true);
    expect(acceptedBeforeFailure).toBe(true);
    expect(adapter.getSnapshot()).toMatchObject({ errorMessage: 'send_failed', mode: 'idle' });
  });

  it('shares real lifecycle outcomes across disabled capabilities', async () => {
    await loadLocalVoiceEngineWithCompatState();
    const storage = await getStorage();
    storage.__setState({ settings: { ...storage.getState().settings,
      voice: { ...storage.getState().settings.voice, providerId: 'local_direct' } } });
    const { createLocalVoiceAdapter } = await import('./createLocalVoiceAdapter');
    const adapter = createLocalVoiceAdapter('local_direct', { contextUpdates: false, textTurns: false });
    await adapter.toggle({ sessionId: 's1' });
    expect(adapter.getSnapshot()).toMatchObject({ sessionId: 's1', status: 'connected', mode: 'listening' });
    await adapter.setMuted({ sessionId: 's1', muted: true });
    expect(adapter.getSnapshot().micMuted).toBe(true);
    await adapter.stop({ sessionId: 's1' });
    expect(adapter.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
    expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
    await adapter.interrupt({ sessionId: 's1' });
    expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
    await adapter.bargeIn?.({ sessionId: 's1' });
    expect(adapter.getSnapshot()).toMatchObject({ status: 'connected', mode: 'listening' });
    await adapter.stop({ sessionId: 's1' });
    expect(adapter.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
  });
});
