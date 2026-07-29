import { describe, expect, it, vi } from 'vitest';

import { activate } from './index.js';
import { GOOGLE_VOICE_SPEECH_RUNTIME } from './voice/speech.js';

describe('Google plugin daemon activation', () => {
  it('registers the declared speech leaf through the public activation API', () => {
    const registerSpeech = vi.fn();
    activate({ voiceProviders: { registerSpeech } } as never);
    expect(registerSpeech).toHaveBeenCalledWith('speech', GOOGLE_VOICE_SPEECH_RUNTIME);
  });
});
