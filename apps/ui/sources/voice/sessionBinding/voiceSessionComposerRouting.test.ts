import { describe, expect, it } from 'vitest';

import { createVoiceSessionBindingStore } from './voiceSessionBindingStore';
import { resolveVoiceSessionComposerRouting } from './voiceSessionComposerRouting';

describe('resolveVoiceSessionComposerRouting', () => {
  it('returns a synthetic binding route for hidden voice conversation sessions backed by adapter text', () => {
    const store = createVoiceSessionBindingStore();
    store.getState().bind({
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'synthetic',
      targetSessionId: 's1',
      updatedAt: 123,
    });

    expect(resolveVoiceSessionComposerRouting({ conversationSessionId: 'carrier-s1', store })).toEqual({
      kind: 'adapter_text',
      binding: {
        adapterId: 'realtime_elevenlabs',
        controlSessionId: 'voice-global',
        conversationSessionId: 'carrier-s1',
        transcriptMode: 'synthetic',
        targetSessionId: 's1',
        updatedAt: 123,
      },
    });
  });

  it('routes native hidden voice sessions through the adapter text path', () => {
    const store = createVoiceSessionBindingStore();
    store.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'native_session',
      targetSessionId: null,
      updatedAt: 123,
    });

    expect(resolveVoiceSessionComposerRouting({ conversationSessionId: 'carrier-s1', store })).toEqual({
      kind: 'adapter_text',
      binding: {
        adapterId: 'local_conversation',
        controlSessionId: 'voice-global',
        conversationSessionId: 'carrier-s1',
        transcriptMode: 'native_session',
        targetSessionId: null,
        updatedAt: 123,
      },
    });
  });

  it('rehydrates routing from persisted voice binding metadata when runtime bindings are empty', async () => {
    const store = createVoiceSessionBindingStore();
    const { writeVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');

    expect(
      resolveVoiceSessionComposerRouting({
        conversationSessionId: 'carrier-s1',
        store,
        sessionMetadata: writeVoiceConversationBindingMetadata(
          { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
          {
            adapterId: 'realtime_elevenlabs',
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            transcriptMode: 'synthetic',
            targetSessionId: 's1',
            updatedAt: 123,
          },
        ),
      }),
    ).toEqual({
      kind: 'adapter_text',
      binding: {
        adapterId: 'realtime_elevenlabs',
        controlSessionId: 'voice-global',
        conversationSessionId: 'carrier-s1',
        transcriptMode: 'synthetic',
        targetSessionId: 's1',
        updatedAt: 123,
      },
    });
  });

  it('returns null for ordinary sessions', () => {
    const store = createVoiceSessionBindingStore();
    expect(resolveVoiceSessionComposerRouting({ conversationSessionId: 's1', store })).toBeNull();
  });
});
