import { describe, expect, it } from 'vitest';

import { createVoiceSessionBindingStore } from './voiceSessionBindingStore';

describe('createVoiceSessionBindingStore', () => {
  it('replaces stale bindings that reuse the same control session id', () => {
    const store = createVoiceSessionBindingStore();

    store.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-a',
      transcriptMode: 'synthetic',
      targetSessionId: 's1',
      updatedAt: 1,
    });

    store.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-b',
      transcriptMode: 'synthetic',
      targetSessionId: 's2',
      updatedAt: 2,
    });

    expect(store.getState().getByConversationSessionId('carrier-a')).toBeNull();
    expect(store.getState().getByConversationSessionId('carrier-b')).toEqual(
      expect.objectContaining({
        controlSessionId: 'voice-global',
        conversationSessionId: 'carrier-b',
        targetSessionId: 's2',
      }),
    );
    expect(store.getState().list()).toHaveLength(1);
  });
});
