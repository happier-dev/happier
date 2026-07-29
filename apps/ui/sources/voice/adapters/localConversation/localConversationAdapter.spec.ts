import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

const toggleLocalVoiceTurn = vi.fn<(sessionId: string) => Promise<void>>(async (_sessionId: string) => {});
const stopLocalVoiceSession = vi.fn(async () => {});
const abortLocalVoiceTurn = vi.fn<(sessionId: string) => Promise<void>>(async (_sessionId: string) => {});
const appendLocalVoiceAgentContextUpdate = vi.fn();
const sendLocalVoiceAgentTextTurn = vi.fn<(params: { controlSessionId: string; text: string }) => Promise<void>>(async () => {});
const setLocalVoiceMuted = vi.fn<(sessionId: string, muted: boolean) => Promise<void>>(async () => {});

const state: any = {
  settings: {
    voice: {
      providerId: 'local_conversation',
      providers: {
        local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent', agent: { backend: 'openai_compat' } } },
      },
    },
  },
};

function resetMockVoiceSettings(): void {
  state.settings.voice.providerId = 'local_conversation';
  state.settings.voice.providers.local_conversation.config = {
    conversationMode: 'agent',
    agent: { backend: 'openai_compat' },
  };
}

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: { getState: () => state },
});
});

vi.mock('@/voice/local/localVoiceRuntimeController', () => ({
  localVoiceRuntimeController: {
    toggleTurn: (sessionId: string) => toggleLocalVoiceTurn(sessionId),
    stopSession: () => stopLocalVoiceSession(),
    abortTurn: (sessionId: string) => abortLocalVoiceTurn(sessionId),
    appendAgentContextUpdate: (sessionId: string, update: string) => appendLocalVoiceAgentContextUpdate(sessionId, update),
    sendAgentTextTurn: (params: { controlSessionId: string; text: string }) => sendLocalVoiceAgentTextTurn(params),
    setMuted: (sessionId: string, muted: boolean) => setLocalVoiceMuted(sessionId, muted),
  },
}));

describe('local conversation voice adapter', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    resetMockVoiceSettings();
    const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
    voiceConversationRuntimeMachine.reset();
  });

  afterAll(() => {
    vi.resetModules();
  });

  it('delegates toggle to the local voice runtime controller', async () => {
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.toggle({ sessionId: 's1' });
    expect(toggleLocalVoiceTurn).toHaveBeenCalledWith('s1');
  });

  it('owns global surface semantics for configured agent mode and fails closed when unselected', async () => {
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    expect(adapter.resolveSurfaceCapabilities?.(state.settings.voice)).toEqual({
      allowsGlobalStart: true,
      controlSessionScope: 'global',
      requiresVoiceAgentFeature: false,
      bargeInEnabled: true,
      cancelResponse: 'immediate',
    });
    expect(adapter.resolveSurfaceCapabilities?.({
      ...state.settings.voice,
      providerId: 'local_direct',
    })).toBeNull();
  });

  it('keeps adapter toggle translation-only when another local session is already active', async () => {
    const { transitionVoiceRuntimeToIdle } = await import('@/voice/runtime/machine/voiceConversationRuntimeHelpers');
    transitionVoiceRuntimeToIdle({ controlSessionId: 's-active' });

    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.toggle({ sessionId: 's1' });

    expect(stopLocalVoiceSession).not.toHaveBeenCalled();
    expect(toggleLocalVoiceTurn).toHaveBeenCalledWith('s1');
  });

  it('sends context updates to the local agent buffer', async () => {
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    adapter.sendContextUpdate({ sessionId: 's1', update: 'context' });
    expect(appendLocalVoiceAgentContextUpdate).toHaveBeenCalledWith('s1', 'context');
  });

  it('projects a disconnected runtime snapshot as a disconnected local session snapshot', async () => {
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    expect(adapter.getSnapshot()).toMatchObject({
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
  });

  it('projects an explicit connected runtime snapshot as a connected local session snapshot', async () => {
    const { transitionVoiceRuntimeToIdle } = await import('@/voice/runtime/machine/voiceConversationRuntimeHelpers');
    transitionVoiceRuntimeToIdle({ controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID });

    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    expect(adapter.getSnapshot()).toMatchObject({
      status: 'connected',
      mode: 'idle',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      canStop: true,
    });
  });

  it('projects the machine micMuted flag through the local session snapshot', async () => {
    const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
    voiceConversationRuntimeMachine.transitionToListening({ controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
    voiceConversationRuntimeMachine.setMuted(true);

    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    expect(adapter.getSnapshot()).toMatchObject({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      micMuted: true,
    });
  });

  it('interrupt aborts the current turn without hanging up the local voice session', async () => {
    abortLocalVoiceTurn.mockClear();
    stopLocalVoiceSession.mockClear();
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.interrupt({ sessionId: 's1' });

    expect(abortLocalVoiceTurn).toHaveBeenCalledWith('s1');
    expect(stopLocalVoiceSession).not.toHaveBeenCalled();
  });

  it('routes typed sends through the local voice text turn path without adapter-level mode gating', async () => {
    sendLocalVoiceAgentTextTurn.mockClear();
    state.settings.voice.providers.local_conversation.config.conversationMode = 'direct_session';
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.sendTextTurn?.({
      controlSessionId: 's1',
      conversationSessionId: 'voice-home',
      text: 'hello from composer',
      localId: 'voice-local-1',
      deliveryCommand: 'interrupt_and_send',
    });

    expect(sendLocalVoiceAgentTextTurn).toHaveBeenCalledWith({
      controlSessionId: 's1',
      text: 'hello from composer',
      durableDispatch: {
        localId: 'voice-local-1',
        deliveryCommand: 'interrupt_and_send',
      },
    });
  });

  it('forwards mute commands through the resolved conversation session id', async () => {
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.setMuted({ sessionId: 's1', muted: true });

    expect(setLocalVoiceMuted).toHaveBeenCalledWith('s1', true);
  });
});
