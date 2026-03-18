import { describe, expect, it, vi } from 'vitest';

import { createVoiceSessionBindingStore } from './voiceSessionBindingStore';

describe('sendVoiceSessionComposerText', () => {
  it('routes synthetic voice conversation sessions through adapter text turns', async () => {
    const store = createVoiceSessionBindingStore();
    store.getState().bind({
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'synthetic',
      targetSessionId: 's1',
      updatedAt: 123,
    });

    const sendTextTurn = vi.fn(async () => {});
    const { sendVoiceSessionComposerText } = await import('./sendVoiceSessionComposerText');

    const result = await sendVoiceSessionComposerText({
      conversationSessionId: 'carrier-s1',
      text: 'hello',
      store,
      getAdapter: () => ({
        id: 'realtime_elevenlabs',
        start: vi.fn(),
        stop: vi.fn(),
        toggle: vi.fn(),
        interrupt: vi.fn(),
        sendContextUpdate: vi.fn(),
        getSnapshot: vi.fn(),
        sendTextTurn,
      }) as any,
    });

    expect(result).toEqual({ ok: true });
    expect(sendTextTurn).toHaveBeenCalledWith({
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      text: 'hello',
    });
  });

  it('routes native hidden voice sessions through adapter text turns too', async () => {
    const store = createVoiceSessionBindingStore();
    store.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'native_session',
      targetSessionId: null,
      updatedAt: 123,
    });

    const sendTextTurn = vi.fn(async () => {});
    const { sendVoiceSessionComposerText } = await import('./sendVoiceSessionComposerText');
    const result = await sendVoiceSessionComposerText({
      conversationSessionId: 'carrier-s1',
      text: 'hello',
      store,
      getAdapter: () => ({
        id: 'local_conversation',
        start: vi.fn(),
        stop: vi.fn(),
        toggle: vi.fn(),
        interrupt: vi.fn(),
        sendContextUpdate: vi.fn(),
        getSnapshot: vi.fn(),
        sendTextTurn,
      }) as any,
    });

    expect(result).toEqual({ ok: true });
    expect(sendTextTurn).toHaveBeenCalledWith({
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      text: 'hello',
    });
  });

  it('returns send_failed when the adapter text turn rejects', async () => {
    const store = createVoiceSessionBindingStore();
    store.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
      updatedAt: 123,
    });

    const sendTextTurn = vi.fn(async () => {
      throw new Error('send_failed');
    });
    const { sendVoiceSessionComposerText } = await import('./sendVoiceSessionComposerText');

    const result = await sendVoiceSessionComposerText({
      conversationSessionId: 'carrier-s1',
      text: 'hello',
      store,
      getAdapter: () => ({
        id: 'local_conversation',
        start: vi.fn(),
        stop: vi.fn(),
        toggle: vi.fn(),
        interrupt: vi.fn(),
        sendContextUpdate: vi.fn(),
        getSnapshot: vi.fn(),
        sendTextTurn,
      }) as any,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'send_failed',
      message: 'send_failed',
    });
  });
});
