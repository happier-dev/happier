import { describe, expect, it } from 'vitest';

import { selectPreferredElevenLabsVoiceId } from './selectPreferredElevenLabsVoiceId';

describe('selectPreferredElevenLabsVoiceId', () => {
  it('keeps the requested voice id when it is available on the account', () => {
    expect(
      selectPreferredElevenLabsVoiceId({
        requestedVoiceId: 'voice_b',
        availableVoices: [
          { voiceId: 'voice_a', name: 'Alpha', category: null, previewUrl: null, labels: null },
          { voiceId: 'voice_b', name: 'Beta', category: null, previewUrl: null, labels: null },
        ],
      }),
    ).toBe('voice_b');
  });

  it('falls back to the first available account voice when the requested voice is unavailable', () => {
    expect(
      selectPreferredElevenLabsVoiceId({
        requestedVoiceId: 'voice_missing',
        availableVoices: [
          { voiceId: 'voice_a', name: 'Alpha', category: null, previewUrl: null, labels: null },
          { voiceId: 'voice_b', name: 'Beta', category: null, previewUrl: null, labels: null },
        ],
      }),
    ).toBe('voice_a');
  });

  it('keeps the requested voice id when the account voice list is unavailable', () => {
    expect(
      selectPreferredElevenLabsVoiceId({
        requestedVoiceId: 'voice_missing',
        availableVoices: [],
      }),
    ).toBe('voice_missing');
  });
});
