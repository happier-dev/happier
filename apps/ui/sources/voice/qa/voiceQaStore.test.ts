import { afterEach, describe, expect, it } from 'vitest';

import { resetVoiceQaStoreForTests, useVoiceQaStore } from './voiceQaStore';

describe('voiceQaStore', () => {
  afterEach(() => {
    resetVoiceQaStoreForTests();
  });

  it('retains only the newest 500 diagnostic entries', () => {
    for (let index = 0; index <= 500; index += 1) {
      useVoiceQaStore.getState().appendSystem(`entry ${index}`);
    }

    const entries = useVoiceQaStore.getState().entries;
    expect(entries).toHaveLength(500);
    expect(entries[0]?.text).toBe('entry 1');
    expect(entries.at(-1)?.text).toBe('entry 500');
  });

  it('stores only typed metadata for realtime provider events', () => {
    useVoiceQaStore.getState().begin('realtime_conversation', 'qa-session');

    useVoiceQaStore.getState().appendRealtimeProviderEvent({
      providerId: 'realtime_elevenlabs',
      eventType: 'user_transcript',
      payloadBytes: null,
      redactionClass: 'transcript_redacted',
    });

    const entries = useVoiceQaStore.getState().entries;
    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'provider.event',
        text: [
          'provider=realtime_elevenlabs',
          'event=user_transcript',
          'bytes=unknown',
          'class=transcript_redacted',
        ].join(' '),
      }),
    ]);
    expect(entries[0]).not.toHaveProperty('raw');
  });
});
