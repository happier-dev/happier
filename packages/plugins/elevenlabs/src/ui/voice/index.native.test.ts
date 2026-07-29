import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  BUNDLED_VOICE_UI_ENTRIES,
} from './index.native.js';

describe('ElevenLabs unsupported native entry', () => {
  it('projects metadata without exposing an executable registration or web SDK import', async () => {
    expect(BUNDLED_VOICE_UI_ENTRIES[0]?.supportedPlatforms).toEqual(['web']);

    const source = await readFile(new URL('./index.native.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("from './index.js'");
    expect(source).not.toContain('@elevenlabs/client');
    expect(source).not.toContain('createElevenLabsVoiceActivation');
    expect(source).not.toContain('BUNDLED_VOICE_PROVIDER_ACTIVATION_ENTRIES');
  });
});
