import { describe, expect, it, vi } from 'vitest';

import { VoiceProviderContributionSchema } from '@happier-dev/protocol';

import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { readBundledSpeechSettingsDescriptorFromEntry } from './descriptor';

const GOOGLE_GEMINI_STT_ID = 'happier.voice.google/gemini-stt';
const GOOGLE_CLOUD_TTS_ID = 'happier.voice.google/google-cloud-tts';

describe('bundled speech settings descriptor projection', () => {
  it('derives independent Google STT settings, credential, and catalog facts from its manifest declaration', () => {
    const entry = createDefaultVoiceProviderRegistry().get(GOOGLE_GEMINI_STT_ID);
    const descriptor = readBundledSpeechSettingsDescriptorFromEntry(GOOGLE_GEMINI_STT_ID, entry);
    if (!descriptor) throw new Error('Google Gemini STT descriptor missing');

    expect(readBundledSpeechSettingsDescriptorFromEntry('google_gemini', entry)).toBeNull();

    expect(descriptor).toMatchObject({
      providerId: GOOGLE_GEMINI_STT_ID,
      contribution: { pluginId: 'happier.voice.google', localId: 'gemini-stt' },
      role: 'stt',
      schemaVersion: 2,
      defaultConfig: { model: 'gemini-2.5-flash', language: '' },
      credential: {
        slotId: 'api_key',
        purpose: 'voice.speech.transcribe',
      },
    });
    expect(descriptor?.fields).toEqual([
      expect.objectContaining({
        key: 'model',
        kind: 'remote_select',
        catalog: 'models',
        allowCustom: true,
        nullable: false,
      }),
      expect.objectContaining({ key: 'language', kind: 'language', nullable: false }),
    ]);
    expect(descriptor?.parseConfig(descriptor.defaultConfig)).toEqual(descriptor.defaultConfig);
  });

  it('derives the separate Google TTS settings, credential, catalog, and numeric constraints from its declaration', () => {
    const entry = createDefaultVoiceProviderRegistry().get(GOOGLE_CLOUD_TTS_ID);
    const descriptor = readBundledSpeechSettingsDescriptorFromEntry(GOOGLE_CLOUD_TTS_ID, entry);
    if (!descriptor) throw new Error('Google Cloud TTS descriptor missing');

    expect(readBundledSpeechSettingsDescriptorFromEntry('google_cloud', entry)).toBeNull();

    expect(descriptor).toMatchObject({
      providerId: GOOGLE_CLOUD_TTS_ID,
      contribution: { pluginId: 'happier.voice.google', localId: 'google-cloud-tts' },
      role: 'tts',
      schemaVersion: 2,
      credential: {
        slotId: 'api_key',
        purpose: 'voice.speech.synthesize',
      },
    });
    expect(descriptor?.fields).toEqual([
      expect.objectContaining({ key: 'languageCode', kind: 'language', nullable: false }),
      expect.objectContaining({
        key: 'voiceName',
        kind: 'remote_select',
        catalog: 'voices',
        allowCustom: true,
        nullable: false,
      }),
      expect.objectContaining({
        key: 'format',
        kind: 'enum',
        options: [{ id: 'mp3', title: 'MP3' }, { id: 'wav', title: 'WAV' }],
      }),
      expect.objectContaining({ key: 'speakingRate', kind: 'number', min: 0.25, max: 4, nullable: false }),
      expect.objectContaining({ key: 'pitch', kind: 'number', min: -20, max: 20, nullable: false }),
    ]);
  });

  it('projects bounded manifest text controls through presentation-only prompt metadata', () => {
    const declaration = VoiceProviderContributionSchema.parse({
      id: 'stt',
      title: 'OpenAI-compatible Speech-to-Text',
      kind: 'speech',
      roles: ['dictation_stt', 'conversation_stt'],
      platforms: ['web', 'ios', 'android'],
      credentials: {
        slot: { id: 'api_key', purpose: 'voice.speech.transcribe', title: 'API key' },
        requirement: { kind: 'optional' },
        sources: [{
          kind: 'savedSecret',
          secretKinds: ['apiKey'],
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['VOICE_API_KEY'] },
          }],
        }],
      },
      settings: {
        schemaVersion: 2,
        fields: [{
          id: 'baseUrl',
          title: 'Endpoint',
          schema: { type: 'string', minLength: 0, maxLength: 2048 },
          default: '',
          presentation: { control: 'text' },
        }, {
          id: 'insecureLocalOriginConsent', title: 'Confirmed origin',
          schema: { type: 'string', minLength: 0, maxLength: 512 }, default: '',
          presentation: { control: 'text', hidden: true },
        }, {
          id: 'insecureLocalConsentMachineId', title: 'Confirmed machine',
          schema: { type: 'string', minLength: 0, maxLength: 512 }, default: '',
          presentation: { control: 'text', hidden: true },
        }, {
          id: 'model', title: 'Model',
          schema: { type: 'string', minLength: 1, maxLength: 256 }, default: 'whisper-1',
          presentation: { control: 'text' },
        }],
      },
    });
    if (declaration.kind !== 'speech') throw new Error('expected speech declaration');
    const createSettingsSpec = vi.fn(() => ({
      titleKey: 'settingsVoice.local.openaiCompatStt.provider.title',
      subtitleKey: 'settingsVoice.local.openaiCompatStt.provider.subtitle',
      detailKey: 'settingsVoice.local.openaiCompatStt.provider.detail',
      iconName: 'cloud',
      credential: {
        titleKey: 'settingsVoice.local.sttApiKey',
        promptTitleKey: 'settingsVoice.local.sttApiKeyTitle',
        promptBodyKey: 'settingsVoice.local.sttApiKeyDescription',
      },
      fields: [{
        fieldId: 'baseUrl',
        titleKey: 'settingsVoice.local.sttBaseUrl',
        subtitleKey: 'settingsVoice.local.sttBaseUrlDescription',
        promptTitleKey: 'settingsVoice.local.sttBaseUrlTitle',
        promptBodyKey: 'settingsVoice.local.sttBaseUrlDescription',
      }, {
        fieldId: 'model',
        titleKey: 'Model',
        subtitleKey: 'Model',
      }],
      test: null,
    }));
    const providerId = 'happier.voice.openai-compat/stt';
    const registry = createVoiceProviderRegistry({
      bundledContributions: [{
        pluginId: 'happier.voice.openai-compat',
        providerId,
        declaration,
      }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: 'voice.stt.openai_compat',
        createSettingsSpec,
      }],
    });
    const descriptor = readBundledSpeechSettingsDescriptorFromEntry(
      providerId,
      registry.get(providerId),
    );

    expect(descriptor?.fields).toEqual([
      expect.objectContaining({
        key: 'baseUrl',
        kind: 'text',
        maxLength: 2048,
        nullable: false,
        promptTitleKey: 'settingsVoice.local.sttBaseUrlTitle',
        promptBodyKey: 'settingsVoice.local.sttBaseUrlDescription',
      }),
      expect.objectContaining({ key: 'model', kind: 'text' }),
    ]);
    expect(descriptor?.endpointConsent).toEqual({
      baseUrlFieldId: 'baseUrl',
      originConsentFieldId: 'insecureLocalOriginConsent',
      machineConsentFieldId: 'insecureLocalConsentMachineId',
    });
    expect(createSettingsSpec).toHaveBeenCalledOnce();
    expect(createSettingsSpec).toHaveBeenCalledWith();
  });

  it('projects every public bounded control for a credential-less speech contribution', () => {
    const declaration = VoiceProviderContributionSchema.parse({
      id: 'speech',
      title: 'External Speech',
      kind: 'speech',
      roles: ['dictation_stt', 'conversation_stt'],
      platforms: ['web'],
      settings: {
        schemaVersion: 2,
        fields: [
          {
            id: 'endpoint',
            title: 'Endpoint',
            schema: { type: 'string', minLength: 0, maxLength: 2048 },
            default: '',
            presentation: { control: 'text' },
          },
          {
            id: 'model', title: 'Model',
            schema: { type: 'string', minLength: 1, maxLength: 256 },
            default: 'model-a', presentation: { control: 'text' },
          },
          {
            id: 'instructions',
            title: 'Instructions',
            schema: { type: 'string', minLength: 0, maxLength: 10_000 },
            default: '',
            presentation: { control: 'textarea' },
          },
          {
            id: 'temperature',
            title: 'Temperature',
            schema: { type: 'number', minimum: 0, maximum: 2 },
            default: 1,
            presentation: { control: 'number', step: 0.1 },
          },
          {
            id: 'mode',
            title: 'Mode',
            schema: { type: 'string', enum: ['fast', 'accurate'] },
            default: 'fast',
            presentation: {
              control: 'select',
              options: [{ value: 'fast', title: 'Fast' }, { value: 'accurate', title: 'Accurate' }],
            },
          },
          {
            id: 'enhance',
            title: 'Enhance speech',
            schema: { type: 'boolean' },
            default: false,
            presentation: { control: 'switch' },
          },
          {
            id: 'metadata',
            title: 'Metadata',
            schema: { type: 'object', additionalProperties: true },
            default: {},
            presentation: { control: 'json' },
          },
        ],
      },
    });
    if (declaration.kind !== 'speech') throw new Error('expected speech declaration');
    const providerId = 'acme.external/speech';
    const registry = createVoiceProviderRegistry({
      bundledContributions: [{ pluginId: 'acme.external', providerId, declaration }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: providerId,
        createSettingsSpec: () => ({
          titleKey: 'External Speech',
          subtitleKey: 'External Speech',
          detailKey: 'External Speech',
          iconName: 'extension',
          fields: declaration.settings!.fields.map((field) => ({
            fieldId: field.id,
            titleKey: typeof field.title === 'string' ? field.title : field.title.key,
            subtitleKey: typeof field.title === 'string' ? field.title : field.title.key,
          })),
          test: null,
        }),
      }],
    });

    const descriptor = readBundledSpeechSettingsDescriptorFromEntry(providerId, registry.get(providerId));

    expect(descriptor).toMatchObject({
      providerId,
      credential: null,
      fields: [
        { key: 'endpoint', kind: 'text', minLength: 0, maxLength: 2048 },
        { key: 'model', kind: 'text', minLength: 1, maxLength: 256 },
        { key: 'instructions', kind: 'textarea', minLength: 0, maxLength: 10_000 },
        { key: 'temperature', kind: 'number', min: 0, max: 2, step: 0.1 },
        { key: 'mode', kind: 'enum' },
        { key: 'enhance', kind: 'switch' },
        { key: 'metadata', kind: 'json' },
      ],
    });
  });
});
