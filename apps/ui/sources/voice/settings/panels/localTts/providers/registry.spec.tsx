import { describe, expect, it, vi } from 'vitest';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

import { createLocalTtsProviderRegistry, listLocalTtsProviderSpecs } from './registry';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';

describe('local TTS provider registry', () => {
  it('contains every built-in TTS provider while provider settings remain an open id domain', () => {
    expect(new Set(listLocalTtsProviderSpecs().map((spec) => spec.id))).toEqual(
      new Set([
        'device',
        'happier.voice.openai-compat/tts',
        'happier.voice.google/google-cloud-tts',
        'local_neural',
      ]),
    );
  });

  it('removes bundled providers and fails lookup closed when their package contribution is disabled', () => {
    const registry = createLocalTtsProviderRegistry(createDefaultVoiceProviderRegistry({
      enabledPluginIds: new Set(['happier.voice.elevenlabs']),
    }));
    expect(registry.list.map((spec) => spec.id)).not.toContain('happier.voice.google/google-cloud-tts');
    expect(registry.get('happier.voice.google/google-cloud-tts')).toBeNull();
  });

  it('admits a second bundled TTS package from its registry contribution without host provider changes', () => {
    const fakeProviderId = 'acme.voice/speech';
    const declaration = VoiceProviderContributionSchema.parse({
      id: 'speech',
      title: 'Acme Speech',
      kind: 'speech',
      roles: ['conversation_tts'],
      platforms: ['web'],
      credentials: {
        slot: { id: 'api_key', purpose: 'voice.speech.synthesize', title: 'API key' },
        requirement: { kind: 'always' },
        sources: [{
          kind: 'savedSecret',
          secretKinds: ['apiKey'],
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['ACME_VOICE_API_KEY'] },
          }],
        }],
      },
      settings: {
        schemaVersion: 2,
        fields: [
          {
            id: 'voiceName',
            title: 'Voice',
            schema: { type: 'string', minLength: 1, maxLength: 256 },
            default: 'acme-v1',
            presentation: { control: 'text' },
          },
          {
            id: 'format',
            title: 'Audio format',
            schema: { type: 'string', enum: ['mp3', 'wav'] },
            default: 'mp3',
            presentation: {
              control: 'select',
              options: [{ value: 'mp3', title: 'MP3' }, { value: 'wav', title: 'WAV' }],
            },
          },
        ],
      },
    });
    if (declaration.kind !== 'speech') throw new Error('expected speech declaration');
    const registry = createLocalTtsProviderRegistry(createVoiceProviderRegistry({
      bundledContributions: [{
        pluginId: 'acme.voice',
        providerId: fakeProviderId,
        declaration,
      }],
      bundledPresentations: [{
        providerId: fakeProviderId,
        settingsSectionId: 'voice.tts.acme',
        createSettingsSpec: () => ({
            titleKey: 'acme.title',
            subtitleKey: 'acme.subtitle',
            detailKey: 'acme.detail',
            iconName: 'speaker-high',
            credential: { titleKey: 'acme.key', promptTitleKey: 'acme.key', promptBodyKey: 'acme.key' },
            fields: [
              {
                fieldId: 'voiceName',
                titleKey: 'acme.voice.title',
                subtitleKey: 'acme.voice.subtitle',
              },
              {
                fieldId: 'format',
                titleKey: 'acme.format.title',
                subtitleKey: 'acme.format.subtitle',
              },
            ],
            test: {
              missingValueMessageKey: 'acme.voice.missing',
            },
          }),
      }],
    }));

    expect(registry.get(fakeProviderId)?.id).toBe(fakeProviderId);
  });
});
