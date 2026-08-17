import { describe, expect, it } from 'vitest';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol';

import { settingsParse } from '@/sync/domains/settings/settings';
import { upsertAccountVoiceCredential } from '@/voice/credentials/accountVoiceCredential';

import { createDefaultVoiceProviderRegistry } from './defaultRegistry';
import { createVoiceProviderRegistry } from './providerRegistry';
import { projectVoiceSpeechCredentialReadiness } from './speechCredentialReadiness';

describe('projectVoiceSpeechCredentialReadiness', () => {
  it('evaluates a conditional speech credential against the schema-validated current provider envelope', () => {
    const declaration = VoiceProviderContributionSchema.parse({
      id: 'conditional-stt',
      title: 'Conditional STT',
      kind: 'speech',
      roles: ['dictation_stt'],
      platforms: ['web'],
      credentials: {
        slot: { id: 'api_key', purpose: 'voice.speech.transcribe', title: 'API key' },
        requirement: { kind: 'when_setting_equals', settingId: 'billingMode', value: 'byo' },
        sources: [{
          kind: 'savedSecret',
          secretKinds: ['apiKey'],
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['CONDITIONAL_SPEECH_API_KEY'] },
          }],
        }],
      },
      settings: {
        schemaVersion: 1,
        fields: [
          {
            id: 'model',
            title: 'Model',
            schema: { type: 'string', minLength: 1, maxLength: 256 },
            default: 'synthetic-stt-v1',
            presentation: { control: 'text' },
          },
          {
            id: 'billingMode',
            title: 'Billing mode',
            schema: { type: 'string', enum: ['hosted', 'byo'] },
            default: 'hosted',
            presentation: { control: 'select', options: [
              { value: 'hosted', title: 'Hosted' },
              { value: 'byo', title: 'BYO' },
            ] },
          },
        ],
      },
    });
    if (declaration.kind !== 'speech') throw new Error('expected speech declaration');
    const providerId = 'acme.conditional/conditional-stt';
    const registry = createVoiceProviderRegistry({
      bundledContributions: [{ pluginId: 'acme.conditional', providerId, declaration }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: providerId,
        createSettingsSpec: () => ({
          titleKey: 'Conditional STT', subtitleKey: 'Acme', detailKey: 'Acme', iconName: 'extension',
          credential: { titleKey: 'API key', promptTitleKey: 'API key', promptBodyKey: 'API key' },
          fields: [
            { fieldId: 'model', titleKey: 'Model', subtitleKey: 'Model' },
            { fieldId: 'billingMode', titleKey: 'Billing mode', subtitleKey: 'Billing mode' },
          ],
          test: null,
        }),
      }],
    });
    const common = {
      registry,
      role: 'dictation_stt' as const,
      providerId,
      settings: settingsParse({}),
      executionMachineId: 'machine-a',
    };

    expect(projectVoiceSpeechCredentialReadiness({
      ...common,
      providerEnvelope: { schemaVersion: 1, config: { model: 'synthetic-stt-v1', billingMode: 'hosted' } },
    })).toBe('ready');
    expect(projectVoiceSpeechCredentialReadiness({
      ...common,
      providerEnvelope: { schemaVersion: 1, config: { model: 'synthetic-stt-v1', billingMode: 'byo' } },
    })).toBe('missing');
    expect(projectVoiceSpeechCredentialReadiness({
      ...common,
      providerEnvelope: { schemaVersion: 1, config: { model: 'synthetic-stt-v1', billingMode: 'invalid' } },
    })).toBe('unknown');
  });

  it('does not guess a role slot for an unrelated built-in credentialed speech contribution', () => {
    const registry = createVoiceProviderRegistry({
      builtIn: [{
        kind: 'voice.speech-engine.v1',
        pluginId: 'happier.voice.builtin',
        providerId: 'future_builtin_speech',
        role: 'stt',
        settingsSectionId: 'voice.fixture.future_builtin_speech',
        roles: ['dictation_stt', 'conversation_stt'],
        requirements: ['credential'],
      }],
    });

    expect(projectVoiceSpeechCredentialReadiness({
      registry,
      role: 'dictation_stt',
      providerId: 'future_builtin_speech',
      settings: settingsParse({}),
      executionMachineId: 'machine-a',
    })).toBe('unknown');
  });

  it('uses the qualified OpenAI-compatible STT identity without publishing a predecessor registry alias', () => {
    const registry = createDefaultVoiceProviderRegistry();
    const qualifiedProviderId = 'happier.voice.openai-compat/stt';

    expect(registry.get('openai_compat')).toBeNull();
    expect(registry.get(qualifiedProviderId)).not.toBeNull();
    expect(projectVoiceSpeechCredentialReadiness({
      registry,
      role: 'dictation_stt',
      providerId: 'openai_compat',
      settings: settingsParse({}),
      executionMachineId: 'machine-a',
    })).toBe('unknown');
    expect(projectVoiceSpeechCredentialReadiness({
      registry,
      role: 'dictation_stt',
      providerId: qualifiedProviderId,
      settings: settingsParse({}),
      executionMachineId: 'machine-a',
    })).toBe('ready');
  });

  it.each([
    ['conversation_stt', 'google_gemini', 'happier.voice.google/gemini-stt'],
    ['conversation_tts', 'google_cloud', 'happier.voice.google/google-cloud-tts'],
  ] as const)('requires qualified Google %s identity after settings ingress', (
    role,
    predecessorProviderId,
    qualifiedProviderId,
  ) => {
    const registry = createDefaultVoiceProviderRegistry();
    const missing = settingsParse({});

    expect(registry.get(predecessorProviderId)).toBeNull();
    expect(registry.get(qualifiedProviderId)).not.toBeNull();
    expect(projectVoiceSpeechCredentialReadiness({
      registry,
      role,
      providerId: predecessorProviderId,
      settings: missing,
      executionMachineId: 'machine-a',
    })).toBe('unknown');
    expect(projectVoiceSpeechCredentialReadiness({
      registry,
      role,
      providerId: qualifiedProviderId,
      settings: missing,
      executionMachineId: 'machine-a',
    })).toBe('missing');

    const entry = registry.get(qualifiedProviderId);
    if (!entry
      || entry.kind !== 'voice.speech-engine.v1'
      || entry.source.kind !== 'bundled'
      || entry.declaration?.kind !== 'speech') {
      throw new Error(`Expected bundled speech contribution ${qualifiedProviderId}`);
    }
    const ready = upsertAccountVoiceCredential({
      settings: missing,
      contribution: {
        pluginId: entry.source.pluginId,
        localId: entry.declaration.id,
      },
      credentialSlotId: 'api_key',
      machineId: 'machine-a',
      value: 'credential',
      generateId: () => 'credential-secret',
      now: 1,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
    }).settings;
    expect(projectVoiceSpeechCredentialReadiness({
      registry,
      role,
      providerId: qualifiedProviderId,
      settings: ready,
      executionMachineId: 'machine-a',
    })).toBe('ready');
    expect(projectVoiceSpeechCredentialReadiness({
      registry,
      role,
      providerId: qualifiedProviderId,
      settings: ready,
      executionMachineId: 'machine-a',
    })).toBe('ready');
  });
});
