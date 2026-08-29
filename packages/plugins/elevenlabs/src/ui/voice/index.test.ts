import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import {
  ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
} from '../../protocol/voice/index.js';
import { VOICE_PROVIDER_PRESENTATIONS } from './index.js';

describe('ElevenLabs bundled voice UI presentation', () => {
  const presentation = VOICE_PROVIDER_PRESENTATIONS[0]!;

  it('keeps semantic ownership in the manifest and presentation qualified', () => {
    expect(PLUGIN_MANIFEST.contributes.voiceProviders[0]).toMatchObject({
      id: 'realtime-elevenlabs',
      roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
      platforms: ['web', 'ios', 'android'],
    });
    expect(presentation.providerId).toBe('happier.voice.elevenlabs/realtime-elevenlabs');
    expect(presentation).not.toHaveProperty('declaration');
    expect(presentation).not.toHaveProperty('roles');
    expect(presentation).not.toHaveProperty('requirements');
    expect(presentation).not.toHaveProperty('providerSettings');
    expect(presentation).not.toHaveProperty('createSettingsSection');
    expect(PLUGIN_MANIFEST.contributes.voiceProviders[0]?.settings?.presentation)
      .toMatchObject({ kind: 'voice.provider-settings.v1', modes: ['happier', 'byo'] });
  });

  it('keeps released persistence history out of provider presentation', () => {
    expect(presentation).not.toHaveProperty('legacySettingsMigration');
    expect(ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts.voiceId).toBe(
      'hpp4J3VqNfWAUOO0d1Us',
    );
  });
});
