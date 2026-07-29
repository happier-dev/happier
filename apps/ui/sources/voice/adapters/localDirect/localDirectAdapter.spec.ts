import { beforeEach, describe, expect, it, vi } from 'vitest';

const toggleLocalVoiceTurn = vi.fn<(sessionId: string) => Promise<void>>(async (_sessionId: string) => {});
const stopLocalVoiceSession = vi.fn(async () => {});
const abortLocalVoiceTurn = vi.fn<(sessionId: string) => Promise<void>>(async (_sessionId: string) => {});
const setLocalVoiceMuted = vi.fn<(sessionId: string, muted: boolean) => Promise<void>>(async () => {});

vi.mock('@/voice/local/localVoiceRuntimeController', () => ({
  localVoiceRuntimeController: {
    toggleTurn: (sessionId: string) => toggleLocalVoiceTurn(sessionId),
    stopSession: () => stopLocalVoiceSession(),
    abortTurn: (sessionId: string) => abortLocalVoiceTurn(sessionId),
    setMuted: (sessionId: string, muted: boolean) => setLocalVoiceMuted(sessionId, muted),
  },
}));

describe('local direct voice adapter', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
    voiceConversationRuntimeMachine.reset();
  });

  it('projects a disconnected runtime snapshot as a disconnected local session snapshot', async () => {
    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    const adapter = createLocalDirectVoiceAdapter();

    expect(adapter.getSnapshot()).toEqual({
      adapterId: 'local_direct',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
  });

  it('owns session-scoped surface semantics and fails closed when unselected', async () => {
    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    const adapter = createLocalDirectVoiceAdapter();
    const selected = {
      providerId: 'local_direct',
      providers: {
        local_direct: { schemaVersion: 1, config: {} },
      },
    };

    expect(adapter.resolveSurfaceCapabilities?.(selected)).toEqual({
      allowsGlobalStart: false,
      controlSessionScope: 'surface',
      requiresVoiceAgentFeature: false,
      bargeInEnabled: false,
      cancelResponse: 'immediate',
    });
    expect(adapter.resolveSurfaceCapabilities?.({ ...selected, providerId: 'local_conversation' })).toBeNull();
  });

  it('projects an explicit connected runtime snapshot as a connected local session snapshot', async () => {
    const { transitionVoiceRuntimeToIdle } = await import('@/voice/runtime/machine/voiceConversationRuntimeHelpers');
    transitionVoiceRuntimeToIdle({ controlSessionId: 's1' });

    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    const adapter = createLocalDirectVoiceAdapter();

    expect(adapter.getSnapshot()).toEqual({
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });
  });

  it('delegates toggle to the local voice runtime controller', async () => {
    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    const adapter = createLocalDirectVoiceAdapter();

    await adapter.toggle({ sessionId: 's1' });
    expect(toggleLocalVoiceTurn).toHaveBeenCalledWith('s1');
  });

  it('keeps adapter toggle translation-only when another local session is already active', async () => {
    const { transitionVoiceRuntimeToIdle } = await import('@/voice/runtime/machine/voiceConversationRuntimeHelpers');
    transitionVoiceRuntimeToIdle({ controlSessionId: 's-active' });

    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    const adapter = createLocalDirectVoiceAdapter();

    await adapter.toggle({ sessionId: 's-next' });

    expect(stopLocalVoiceSession).not.toHaveBeenCalled();
    expect(toggleLocalVoiceTurn).toHaveBeenCalledWith('s-next');
  });

  it('stop stops the local voice session', async () => {
    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    const adapter = createLocalDirectVoiceAdapter();

    await adapter.stop({ sessionId: 's1' });
    expect(stopLocalVoiceSession).toHaveBeenCalledTimes(1);
  });

  it('interrupt aborts the current turn without hanging up the local voice session', async () => {
    abortLocalVoiceTurn.mockClear();
    stopLocalVoiceSession.mockClear();
    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    const adapter = createLocalDirectVoiceAdapter();

    await adapter.interrupt({ sessionId: 's1' });

    expect(abortLocalVoiceTurn).toHaveBeenCalledWith('s1');
    expect(stopLocalVoiceSession).not.toHaveBeenCalled();
  });

  it('forwards mute commands to the local voice runtime controller', async () => {
    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    const adapter = createLocalDirectVoiceAdapter();

    await adapter.setMuted({ sessionId: 's1', muted: true });

    expect(setLocalVoiceMuted).toHaveBeenCalledWith('s1', true);
  });
});
