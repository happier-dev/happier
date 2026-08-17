import { describe, expect, it, vi } from 'vitest';

import { activate } from './index.js';
import {
  OPENAI_COMPAT_STT_RUNTIME,
  OPENAI_COMPAT_TTS_RUNTIME,
} from './voice/speech.js';

describe('OpenAI-compatible speech daemon activation', () => {
  it('registers exactly the two declared speech leaves through the public registration API', () => {
    const register = vi.fn();

    activate({ voiceProviders: { register } } as never);

    expect(register.mock.calls).toEqual([
      ['stt', OPENAI_COMPAT_STT_RUNTIME],
      ['tts', OPENAI_COMPAT_TTS_RUNTIME],
    ]);
  });
});
