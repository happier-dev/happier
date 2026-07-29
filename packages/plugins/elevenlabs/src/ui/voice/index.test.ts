import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import {
  ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
  ElevenLabsVoiceProviderSettingsSchema,
} from '../../protocol/voice/index.js';
import { BUNDLED_VOICE_UI_ENTRIES } from './index.js';

describe('ElevenLabs bundled voice UI contribution', () => {
  it('keeps released predecessor migration separate from the public current-settings owner', () => {
    const internal = BUNDLED_VOICE_UI_ENTRIES[0]?.internal;
    expect(internal).not.toHaveProperty('providerSettings');
    expect(BUNDLED_VOICE_UI_ENTRIES[0]).not.toHaveProperty('projectSettings');
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse({ billingMode: 'byo' }).success).toBe(false);
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse({
      ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
      extra: true,
    }).success).toBe(false);
    expect(internal.legacySettingsMigration.migrateLegacy({
      assistantLanguage: 'fr',
      billingMode: 'byo',
      byo: { agentId: 'agent_1', apiKey: { _isSecretValue: true, value: 'xi_legacy' } },
      welcome: { enabled: true, mode: 'on_first_turn', templateId: 'hello' },
    })).toMatchObject({
      config: { mode: 'default', billingMode: 'byo', byo: { agentId: 'agent_1' } },
      root: {
        assistantLanguage: 'fr',
        welcome: { enabled: true, mode: 'on_first_turn', templateId: 'hello' },
      },
    });
    expect(JSON.stringify(internal.legacySettingsMigration.migrateLegacy({
      billingMode: 'byo',
      byo: { agentId: 'agent_1', apiKey: { _isSecretValue: true, value: 'xi_legacy' } },
    })?.config)).not.toContain('xi_legacy');
  });

  it('resets a legacy speed outside the canonical provisioning range during migration', () => {
    const migrated = BUNDLED_VOICE_UI_ENTRIES[0]?.internal.legacySettingsMigration.migrateLegacy({
      billingMode: 'byo',
      tts: { voiceSettings: { speed: 0.6 } },
      byo: { agentId: 'agent_1', apiKey: null },
    });

    expect(migrated?.config.tts.voiceSettings.speed).toBeNull();
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(migrated?.config).success).toBe(true);
  });

  it('projects canonical settings and an encrypted SavedSecret value to remote-dev without plaintext export', () => {
    const internal = BUNDLED_VOICE_UI_ENTRIES[0]!.internal;
    const encryptedCredential = {
      _isSecretValue: true as const,
      encryptedValue: { t: 'enc-v1' as const, c: 'ciphertext-only' },
    };
    const projected = internal.legacySettingsMigration.projectLegacy({
      ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
      billingMode: 'byo',
      byo: { agentId: 'agent_1' },
    }, {
      root: {
        assistantLanguage: 'fr',
        welcome: { enabled: true, mode: 'on_first_turn', templateId: 'hello' },
      },
      resolveCredential: (providerId, slotId) => providerId === 'realtime_elevenlabs' && slotId === 'api_key'
        ? encryptedCredential
        : null,
    });

    expect(projected).toMatchObject({
      assistantLanguage: 'fr',
      billingMode: 'byo',
      welcome: { enabled: true, mode: 'on_first_turn', templateId: 'hello' },
      byo: { agentId: 'agent_1', apiKey: encryptedCredential },
    });
    expect(JSON.stringify(projected)).not.toContain('value":"');
  });

  it('resets invalid legacy agent, voice, and model identifiers during migration', () => {
    const migrated = BUNDLED_VOICE_UI_ENTRIES[0]?.internal.legacySettingsMigration.migrateLegacy({
      billingMode: 'byo',
      tts: { voiceId: '', modelId: 'x'.repeat(257) },
      byo: { agentId: 'bad id', apiKey: null },
    });

    expect(migrated?.config).toMatchObject({
      byo: { agentId: null },
      tts: { voiceId: 'EST9Ui6982FZPSi7gCHi', modelId: null },
    });
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(migrated?.config).success).toBe(true);
  });

  it('keeps only presentation and predecessor migration behind the internal first-party boundary', () => {
    const internal = BUNDLED_VOICE_UI_ENTRIES[0]?.internal;
    expect(typeof internal.createSettingsSection).toBe('function');
    expect(BUNDLED_VOICE_UI_ENTRIES[0]?.declaration).toEqual(
      PLUGIN_MANIFEST.contributes.voiceProviders[0],
    );
    expect(internal).not.toHaveProperty('createAccountOperationClient');
    expect(internal).not.toHaveProperty('createAutoprovision');
    expect(internal).not.toHaveProperty('createClient');
    expect(internal).not.toHaveProperty('createDaemonClient');
  });

  it('projects SavedSecret readiness only for BYO billing', () => {
    const projector = BUNDLED_VOICE_UI_ENTRIES[0]?.internal.projectCredentialReadiness;
    const readyContext = {
      accountProfile: {},
      savedSecret: { status: 'ready' as const },
    };
    expect(projector?.({
      ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
      billingMode: 'byo',
    }, readyContext)).toMatchObject({ status: 'ready' });
    expect(projector?.({
      ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
      billingMode: 'happier',
    }, readyContext)).toMatchObject({ status: 'unknown' });
  });

  it('projects a manifest-valid public Voice leaf without retaining the private adapter callback', async () => {
    const internal = BUNDLED_VOICE_UI_ENTRIES[0]?.internal;
    const voiceModule: Record<string, unknown> = await import('./index.js');

    expect(PLUGIN_MANIFEST.contributes).toMatchObject({
      voiceProviders: [expect.objectContaining({
        id: 'realtime-elevenlabs',
        platforms: ['web'],
        settings: expect.objectContaining({
          schemaVersion: 2,
          fields: [
            expect.objectContaining({ id: 'billingMode' }),
            expect.objectContaining({ id: 'tts' }),
            expect.objectContaining({ id: 'byo' }),
          ],
        }),
        capabilities: expect.objectContaining({
          turn: expect.objectContaining({ cancelResponse: false, bargeIn: false }),
        }),
      })],
    });
    expect(BUNDLED_VOICE_UI_ENTRIES[0]?.supportedPlatforms).toEqual(['web']);
    expect(voiceModule).toHaveProperty('activate');
    expect(voiceModule).not.toHaveProperty('BUNDLED_VOICE_PROVIDER_ACTIVATION_ENTRIES');
    expect(voiceModule).not.toHaveProperty('BUNDLED_VOICE_CONVERSATION_RUNTIME_ENTRIES');
    expect(internal).not.toHaveProperty('createAdapter');
  });
});
