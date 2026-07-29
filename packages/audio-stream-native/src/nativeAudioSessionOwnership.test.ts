import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function readPackageFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, `${new URL('..', import.meta.url).href}/`), 'utf8');
}

describe('native audio-session ownership', () => {
  it('requires the coordinator to configure native capture instead of self-acquiring a legacy session', () => {
    expect(fileURLToPath(new URL('..', import.meta.url))).toContain('audio-stream-native');

    const iosSource = readPackageFile('ios/HappierAudioStreamNativeModule.swift');
    expect(iosSource).not.toMatch(/legacySessionOwned|ensureLegacyDictationSession/);
    expect(iosSource).toMatch(
      /AsyncFunction\("start"\)[\s\S]*?guard self\.audioSessionConfigured else \{[\s\S]*?audio_session_not_configured/,
    );

    const androidSource = readPackageFile(
      'android/src/main/java/dev/happier/audio/HappierAudioStreamNativeModule.kt',
    );
    expect(androidSource).not.toMatch(/legacySessionOwned|ensureLegacyDictationSession/);
    expect(androidSource).toMatch(
      /AsyncFunction\("start"\)[\s\S]*?captureStartAdmission\.run \{/,
    );
  });

  it('restores the Android communication route and observes route selection changes', () => {
    const androidSource = readPackageFile(
      'android/src/main/java/dev/happier/audio/HappierAudioStreamNativeModule.kt',
    );

    expect(androidSource).toMatch(/AudioSessionPriorState/);
    expect(androidSource).toMatch(/communicationDeviceId/);
    expect(androidSource).toMatch(/setCommunicationDevice/);
    expect(androidSource).toMatch(/clearCommunicationDevice/);
    expect(androidSource).toMatch(/addOnCommunicationDeviceChangedListener/);
    expect(androidSource).toMatch(/removeOnCommunicationDeviceChangedListener/);
  });
});
