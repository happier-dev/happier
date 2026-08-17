import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import {
  ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
  ElevenLabsVoiceProviderSettingsSchema,
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
    expect(typeof presentation.createSettingsSection).toBe('function');
  });

  it('retains only the released predecessor settings migration sidecar', () => {
    const migration = presentation.legacySettingsMigration!;
    const migrated = migration.migrateLegacy?.({
      assistantLanguage: 'fr',
      billingMode: 'byo',
      byo: { agentId: 'agent_1', apiKey: { _isSecretValue: true, value: 'xi_legacy' } },
      welcome: { enabled: true, mode: 'on_first_turn', templateId: 'hello' },
      tts: {
        voiceSettings: {
          style: 0.35,
          useSpeakerBoost: true,
          speed: 0.6,
        },
      },
    });
    expect(migrated).toMatchObject({
      config: { billingMode: 'byo', agentId: 'agent_1', tts: { voiceSettings: { speed: null } } },
      root: {
        assistantLanguage: 'fr',
        welcome: { enabled: true, mode: 'on_first_turn', templateId: 'hello' },
      },
    });
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(migrated?.config).success).toBe(true);
    expect(migrated?.config.tts.voiceSettings).not.toHaveProperty('style');
    expect(migrated?.config.tts.voiceSettings).not.toHaveProperty('useSpeakerBoost');
    expect(JSON.stringify(migrated?.config)).not.toContain('xi_legacy');
  });

  it('pins the released legacy default without changing the current default', () => {
    const migration = presentation.legacySettingsMigration!;

    expect(migration.defaultLegacyConfig).toMatchObject({
      tts: {
        voiceId: 'EST9Ui6982FZPSi7gCHi',
        modelId: null,
        voiceSettings: {
          stability: null,
          similarityBoost: null,
          style: null,
          useSpeakerBoost: null,
          speed: null,
        },
      },
    });
    expect(migration.migrateLegacy?.(migration.defaultLegacyConfig)).toMatchObject({
      config: {
        tts: { voiceId: 'EST9Ui6982FZPSi7gCHi' },
      },
    });
    expect(ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts.voiceId).toBe(
      'hpp4J3VqNfWAUOO0d1Us',
    );
  });

  it('projects canonical settings to the predecessor shape without plaintext export', () => {
    const encryptedCredential = {
      _isSecretValue: true as const,
      encryptedValue: { t: 'enc-v1' as const, c: 'ciphertext-only' },
    };
    const projected = presentation.legacySettingsMigration?.projectLegacy?.({
      ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
      billingMode: 'byo',
      agentId: 'agent_1',
    }, {
      root: {
        assistantLanguage: 'fr',
        welcome: { enabled: true, mode: 'on_first_turn', templateId: 'hello' },
      },
      resolveCredential: (providerId, slotId) => providerId === 'realtime_elevenlabs'
        && slotId === 'api_key' ? encryptedCredential : null,
    });
    expect(projected).toMatchObject({
      assistantLanguage: 'fr',
      billingMode: 'byo',
      byo: { agentId: 'agent_1', apiKey: encryptedCredential },
    });
    expect(JSON.stringify(projected)).not.toContain('value":"');
  });
});
