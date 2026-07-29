import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// @ts-expect-error Raw native modules are deliberately private to the package implementation.
import type { HappierAudioStreamNativeModule } from './index';

describe('audio-stream-native public API', () => {
  it('does not expose the raw native module or its discovery helpers at the package root', () => {
    const publicIndex = readFileSync(new URL('index.ts', import.meta.url), 'utf8');
    expect(publicIndex).not.toMatch(/HAPPIER_AUDIO_STREAM_NATIVE_MODULE_NAME/);
    expect(publicIndex).not.toMatch(/getOptionalHappierAudioStreamNativeModule/);
    expect(publicIndex).not.toMatch(/supportsVoiceAudioSessionCoordination/);
    expect(publicIndex).not.toMatch(/HappierAudioStreamNativeModule/);
    const rawModuleTypeMustRemainUnusable: HappierAudioStreamNativeModule | null = null;
    expect(rawModuleTypeMustRemainUnusable).toBeNull();
  });
});
