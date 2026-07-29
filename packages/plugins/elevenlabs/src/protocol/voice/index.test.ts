import { describe, expect, it } from 'vitest';

import {
  BUNDLED_VOICE_UI_ENTRIES,
} from '../../ui/voice/index.js';
import {
  ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
  ElevenLabsProvisionToolSchema,
  ElevenLabsVoiceProviderSettingsSchema,
} from './index.js';

describe('ElevenLabs versioned credential boundary', () => {
  it('uses the provisioning speed bounds as the canonical settings contract', () => {
    const config = (speed: number) => ({
      ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
      tts: {
        ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts,
        voiceSettings: {
          ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts.voiceSettings,
          speed,
        },
      },
    });

    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(config(0.6)).success).toBe(false);
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(config(0.7)).success).toBe(true);
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(config(1.2)).success).toBe(true);
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(config(1.3)).success).toBe(false);
  });

  it('validates canonical agent, voice, and model identifiers before persistence', () => {
    const withByo = (agentId: string) => ({
      ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
      byo: { agentId },
    });
    const withTts = (tts: Readonly<{ voiceId?: string; modelId?: string | null }>) => ({
      ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
      tts: { ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts, ...tts },
    });
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(withByo('bad id')).success).toBe(false);
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(withTts({ voiceId: '' })).success).toBe(false);
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(withTts({ modelId: 'x'.repeat(257) })).success).toBe(false);
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(withByo('  agent_1  ')).success).toBe(false);

    expect(ElevenLabsVoiceProviderSettingsSchema.parse({
      ...withByo('agent_1'),
      tts: { ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts, voiceId: 'voice_1', modelId: 'model_1' },
    })).toMatchObject({
      byo: { agentId: 'agent_1' },
      tts: { voiceId: 'voice_1', modelId: 'model_1' },
    });
  });

  it('keeps v1 secrets migration-readable while the v2 canonical schema rejects them', () => {
    const legacy = {
      billingMode: 'byo',
      byo: {
        agentId: 'agent_1',
        apiKey: { _isSecretValue: true, value: 'xi_secret' },
      },
    };

    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(legacy).success).toBe(false);
    const legacyMigration = BUNDLED_VOICE_UI_ENTRIES[0].internal.legacySettingsMigration;
    expect(legacyMigration.readLegacySecret(legacy)).toEqual(legacy.byo.apiKey);
    expect(legacyMigration.migrateLegacy(legacy)?.config.byo).toEqual({ agentId: 'agent_1' });
    expect(JSON.stringify(ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS)).not.toContain('apiKey');
  });

  it('rejects non-JSON tool parameters before public account operations', () => {
    const base = {
      name: 'sendMessage',
      description: 'Send a message.',
    };

    expect(ElevenLabsProvisionToolSchema.safeParse({
      ...base,
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
      },
    }).success).toBe(true);
    expect(ElevenLabsProvisionToolSchema.safeParse({
      ...base,
      parameters: {
        type: 'object',
        properties: {
          message: undefined,
        },
      },
    }).success).toBe(false);
  });
});
