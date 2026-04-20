import { describe, expect, it } from 'vitest';

import { VOICE_RUNTIME_CONFIG_DEFAULTS } from './voiceRuntimeConfigDefaults';

describe('voiceRuntimeConfigDefaults', () => {
  it('aligns daemon TTS default codec with the active wav controller contract', () => {
    expect(VOICE_RUNTIME_CONFIG_DEFAULTS.daemonInference.tts.defaultCodec).toEqual({
      codec: 'wav',
      mimeType: 'audio/wav',
    });
  });
});
