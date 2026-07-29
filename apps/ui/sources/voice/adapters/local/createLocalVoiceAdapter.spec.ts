import { beforeEach, describe, expect, it, vi } from 'vitest';

const toggleLocalVoiceTurn = vi.fn<(sessionId: string) => Promise<void>>(async () => {});
const stopLocalVoiceSession = vi.fn(async () => {});
const abortLocalVoiceTurn = vi.fn<(sessionId: string) => Promise<void>>(async () => {});
const appendLocalVoiceAgentContextUpdate = vi.fn();
const sendLocalVoiceAgentTextTurn = vi.fn<(params: { controlSessionId: string; text: string }) => Promise<void>>(async () => {});
const setLocalVoiceMuted = vi.fn<(sessionId: string, muted: boolean) => Promise<void>>(async () => {});

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

describe('createLocalVoiceAdapter', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
    voiceConversationRuntimeMachine.reset();
  });

  it('exposes the requested adapter id on the snapshot', async () => {
    const { createLocalVoiceAdapter } = await import('./createLocalVoiceAdapter');
    const adapter = createLocalVoiceAdapter('local_direct', { contextUpdates: false, textTurns: false });

    expect(adapter.id).toBe('local_direct');
    expect(adapter.getSnapshot()).toMatchObject({ adapterId: 'local_direct', status: 'disconnected' });
  });

  it('routes context updates to the agent buffer only when enabled', async () => {
    const { createLocalVoiceAdapter } = await import('./createLocalVoiceAdapter');

    const enabled = createLocalVoiceAdapter('local_conversation', { contextUpdates: true, textTurns: true });
    enabled.sendContextUpdate({ sessionId: 's1', update: 'ctx' });
    expect(appendLocalVoiceAgentContextUpdate).toHaveBeenCalledWith('s1', 'ctx');

    appendLocalVoiceAgentContextUpdate.mockClear();
    const disabled = createLocalVoiceAdapter('local_direct', { contextUpdates: false, textTurns: false });
    disabled.sendContextUpdate({ sessionId: 's1', update: 'ctx' });
    expect(appendLocalVoiceAgentContextUpdate).not.toHaveBeenCalled();
  });

  it('only exposes sendTextTurn when text turns are enabled', async () => {
    const { createLocalVoiceAdapter } = await import('./createLocalVoiceAdapter');

    const withText = createLocalVoiceAdapter('local_conversation', { contextUpdates: true, textTurns: true });
    expect(withText.sendTextTurn).toBeTypeOf('function');
    await withText.sendTextTurn?.({ controlSessionId: 's1', conversationSessionId: 'voice-home', text: 'hi', localId: 'voice-local-1', deliveryCommand: 'interrupt_and_send' });
    expect(sendLocalVoiceAgentTextTurn).toHaveBeenCalledWith({
      controlSessionId: 's1',
      text: 'hi',
      durableDispatch: { localId: 'voice-local-1', deliveryCommand: 'interrupt_and_send' },
    });

    const withoutText = createLocalVoiceAdapter('local_direct', { contextUpdates: false, textTurns: false });
    expect('sendTextTurn' in withoutText).toBe(false);
  });

  it('shares the lifecycle delegation across capability flags', async () => {
    const { createLocalVoiceAdapter } = await import('./createLocalVoiceAdapter');
    const adapter = createLocalVoiceAdapter('local_direct', { contextUpdates: false, textTurns: false });

    await adapter.toggle({ sessionId: 's1' });
    await adapter.stop({ sessionId: 's1' });
    await adapter.interrupt({ sessionId: 's1' });
    await adapter.bargeIn?.({ sessionId: 's1' });
    await adapter.setMuted({ sessionId: 's1', muted: true });

    expect(toggleLocalVoiceTurn).toHaveBeenCalledTimes(2);
    expect(toggleLocalVoiceTurn).toHaveBeenCalledWith('s1');
    expect(stopLocalVoiceSession).toHaveBeenCalledTimes(1);
    expect(abortLocalVoiceTurn).toHaveBeenCalledWith('s1');
    expect(setLocalVoiceMuted).toHaveBeenCalledWith('s1', true);
  });
});
