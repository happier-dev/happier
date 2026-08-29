import {
  ingestPluginManifestV2,
  VoiceProviderContributionSchema,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import { activate } from './runtime.js';
import { VOICE_PROVIDER_PRESENTATIONS } from './index.js';

describe('xAI Realtime public Voice activation', () => {
  it('registers the schema-valid manifest-local contribution exactly once', () => {
    const ingested = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(ingested.ok).toBe(true);
    expect(PLUGIN_MANIFEST.contributes.voiceProviders[0]?.id).toBe('realtime-grok');
    expect(PLUGIN_MANIFEST.contributes.voiceProviders[0]?.platforms).toEqual([
      'web',
      'ios',
      'android',
    ]);

    const register = vi.fn();
    activate({ voiceProviders: { register } });

    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]?.[0]).toBe('realtime-grok');
  });

  it('keeps bundled UI data presentation-only and derives semantic facts from the declaration', () => {
    const entry = VOICE_PROVIDER_PRESENTATIONS[0];

    expect(Object.keys(entry).sort()).toEqual([
      'providerId',
      'selectionOptions',
      'settingsSectionId',
    ]);
    expect(entry.providerId).toBe('happier.voice.xai/realtime-grok');
    expect(entry).not.toHaveProperty('declaration');
    expect(entry).not.toHaveProperty('legacySettingsMigration');
    expect(PLUGIN_MANIFEST.contributes.voiceProviders[0]?.settings?.presentation)
      .toMatchObject({ kind: 'voice.provider-settings.v1', modes: ['byo'] });
  });

  it('declares one exact bounded xAI voices operation and rejects projection drift', () => {
    const declaration = VoiceProviderContributionSchema.parse(
      PLUGIN_MANIFEST.contributes.voiceProviders[0],
    );
    if (declaration.kind !== 'conversation' || !declaration.credentials?.hostMediated) {
      throw new Error('xai_voice_credential_mediation_missing');
    }
    expect(declaration.credentials.hostMediated.operations).toContainEqual(expect.objectContaining({
      id: 'voices',
      credentialSlotId: 'api_key',
      request: expect.objectContaining({
        origin: 'https://api.x.ai',
        pathTemplate: '/v1/tts/voices',
        method: 'GET',
        redirect: 'error',
      }),
    }));
    const source = declaration.credentials.sources[0];
    if (source?.kind !== 'savedSecret' || !source.operationProjections) {
      throw new Error('xai_voice_saved_secret_projection_missing');
    }
    expect(VoiceProviderContributionSchema.safeParse({
      ...declaration,
      credentials: {
        ...declaration.credentials,
        sources: [{
          ...source,
          operationProjections: source.operationProjections.map((projection) => (
            projection.operation === 'voices'
              ? { ...projection, operation: 'voices-list' }
              : projection
          )),
        }],
      },
    }).success).toBe(false);
  });
});
