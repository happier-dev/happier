import { Ajv } from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VoiceProviderContribution } from '../../plugins/contributions/voiceProviders.js';
import { createVoiceProviderSettingsCatalog } from './providerSettings.js';
import { createVoiceSettingsOwner } from './voiceSettings.js';

// Bundled first-party declarations are generated in their admitted form (the
// generator's test loads them through VoiceProviderContributionSchema), so this
// fixture is written the same way rather than parsed here.
// Each test gets its own schema bounds: compiled validators are shared by content.
function bundledSpeechDeclaration(modelMaxLength: number): VoiceProviderContribution {
  return {
    id: 'catalog-stt',
    kind: 'speech',
    title: 'Catalog STT',
    platforms: ['web'],
    roles: ['dictation_stt'],
    credentials: {
      requirement: { kind: 'always' },
      slot: { id: 'api_key', purpose: 'voice.speech.transcribe', title: 'Key' },
      sources: [{ kind: 'savedSecret', secretKinds: ['apiKey'], rawGrants: [{ phase: 'speech', realm: 'daemon',
        request: { kind: 'httpHeaders', origin: 'https://stt.example.test', headerNames: ['x-api-key'] } }] }],
    },
    limits: { transcribe: { maxInputBytes: 1024 } },
    settings: {
      schemaVersion: 2,
      fields: [
        { id: 'model', title: 'Model', schema: { type: 'string', minLength: 1, maxLength: modelMaxLength }, default: 'base',
          presentation: { control: 'select' } },
        { id: 'language', title: 'Language', schema: { type: 'string', maxLength: 29 }, default: '',
          presentation: { control: 'text' } },
      ],
    },
  } as unknown as VoiceProviderContribution;
}

describe('createVoiceProviderSettingsCatalog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The catalog is created by the first Account settings parse at startup.
  it('creates bundled owners from their admitted declarations without compiling a JSON Schema', () => {
    const compile = vi.spyOn(Ajv.prototype, 'compile');

    const catalog = createVoiceProviderSettingsCatalog({
      bundledContributions: [{ pluginId: 'fixture.voice', providerId: 'fixture.voice/catalog-stt', declaration: bundledSpeechDeclaration(23) }],
    });
    expect(compile).not.toHaveBeenCalled();
    expect(catalog.defaultEnvelopes()['fixture.voice/catalog-stt'])
      .toEqual({ schemaVersion: 2, config: { model: 'base', language: '' } });

    const owner = catalog.get('fixture.voice/catalog-stt');
    expect(owner?.parseStoredConfig({ model: 'large', language: 'fr' })).toEqual({ model: 'large', language: 'fr' });
    expect(owner?.parseConfig({ model: '', language: '' })).toBeNull();
    expect(compile).toHaveBeenCalled();
  });

  // A default config was admitted with its declaration, so reading it back is the identity.
  it('admits every owner\'s default config unchanged', () => {
    const catalog = createVoiceProviderSettingsCatalog({
      bundledContributions: [{ pluginId: 'fixture.voice', providerId: 'fixture.voice/catalog-stt', declaration: bundledSpeechDeclaration(31) }],
    });
    expect(catalog.list().length).toBeGreaterThan(1);
    for (const owner of catalog.list()) expect(owner.parseStoredConfig(owner.defaultConfig)).toEqual(owner.defaultConfig);
  });

  // Startup parses Voice settings whose providers still hold their defaults (the
  // persistence owner's defaults, a fresh Account, every untouched provider).
  it('parses provider envelopes that hold their defaults without compiling a JSON Schema', () => {
    const owner = createVoiceSettingsOwner({
      bundledContributions: [{ pluginId: 'fixture.voice', providerId: 'fixture.voice/catalog-stt', declaration: bundledSpeechDeclaration(37) }],
    });
    const compile = vi.spyOn(Ajv.prototype, 'compile');

    const parsed = owner.voiceSettingsParse({ providers: owner.voiceSettingsDefaults.providers });
    expect(compile).not.toHaveBeenCalled();
    expect(parsed.providers).toEqual(owner.voiceSettingsDefaults.providers);

    const changed = owner.voiceSettingsParse({ providers: { ...owner.voiceSettingsDefaults.providers,
      'fixture.voice/catalog-stt': { schemaVersion: 2, config: { model: 'large', language: 'de' } } } });
    expect(changed.providers['fixture.voice/catalog-stt']).toEqual({ schemaVersion: 2, config: { model: 'large', language: 'de' } });
    expect(compile).toHaveBeenCalled();
  });
});
