import { describe, expect, it, vi } from 'vitest';

import { activate } from './index.js';
import {
  GOOGLE_CLOUD_TTS_RUNTIME,
  GOOGLE_GEMINI_STT_RUNTIME,
} from './voice/speech.js';

describe('Google plugin daemon activation', () => {
  it('registers the two declared speech leaves through the one public activation API', () => {
    const register = vi.fn();
    activate({ voiceProviders: { register } } as never);
    expect(register.mock.calls).toEqual([
      ['gemini-stt', GOOGLE_GEMINI_STT_RUNTIME],
      ['google-cloud-tts', GOOGLE_CLOUD_TTS_RUNTIME],
    ]);
  });
});
