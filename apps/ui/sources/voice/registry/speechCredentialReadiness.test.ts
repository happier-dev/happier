import { describe, expect, it } from 'vitest';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol';

import { settingsParse } from '@/sync/domains/settings/settings';
import {
  applyAccountVoiceCredentialSourceSelection,
  saveAndUseAccountVoiceCredential,
  upsertAccountVoiceCredential,
} from '@/voice/credentials/accountVoiceCredential';

import { createDefaultVoiceProviderRegistry } from './defaultRegistry';
import { createVoiceProviderRegistry } from './providerRegistry';
import { projectVoiceSpeechCredentialReadiness } from './speechCredentialReadiness';

describe('projectVoiceSpeechCredentialReadiness', () => {
  it('validates an optional credential when the user selected one while allowing no selection', () => {
    const declaration = VoiceProviderContributionSchema.parse({
      id: 'optional-stt',
      title: 'Optional STT',
      kind: 'speech',
      roles: ['dictation_stt'],
      platforms: ['web'],
      credentials: {
        slot: { id: 'api_key', purpose: 'voice.speech.optional', title: 'API key' },
        requirement: { kind: 'optional' },
        sources: [{
          kind: 'savedSecret',
          secretKinds: ['apiKey'],
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['OPTIONAL_SPEECH_API_KEY'] },
          }],
        }],
      },
      settings: {
        schemaVersion: 1,
        fields: [{
          id: 'model',
          title: 'Model',
          schema: { type: 'string', minLength: 1, maxLength: 64 },
          default: 'optional-stt-1',
          presentation: { control: 'text' },
        }],
      },
    });
    if (declaration.kind !== 'speech') throw new Error('expected speech declaration');
    const contribution = { pluginId: 'acme.optional', localId: declaration.id } as const;
    const providerId = 'acme.optional/optional-stt';
    const registry = createVoiceProviderRegistry({
      bundledContributions: [{ pluginId: contribution.pluginId, providerId, declaration }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: providerId,
        createSettingsSpec: () => ({
          titleKey: 'Optional STT', subtitleKey: 'Acme', detailKey: 'Acme', iconName: 'extension',
          credential: { titleKey: 'API key', promptTitleKey: 'API key', promptBodyKey: 'API key' },
          fields: [{ fieldId: 'model', titleKey: 'Model', subtitleKey: 'Model' }],
          test: null,
        }),
      }],
    });
    const common = {
      registry,
      role: 'dictation_stt' as const,
      providerId,
      executionMachineId: 'machine-a',
    };
    expect(projectVoiceSpeechCredentialReadiness({
      ...common,
      settings: settingsParse({}),
    })).toBe('ready');

    const selected = saveAndUseAccountVoiceCredential({
      settings: settingsParse({}),
      contribution,
      credentialSlotId: 'api_key',
      expectedSettingsVersion: 0,
      currentDeclaration: declaration,
      machineId: 'machine-a',
      value: 'credential',
      generateId: () => 'optional-secret',
      now: 1,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
    }).settings;
    expect(projectVoiceSpeechCredentialReadiness({
      ...common,
      settings: selected,
    })).toBe('unknown');
    expect(projectVoiceSpeechCredentialReadiness({
      ...common,
      settings: selected,
      rawAuthorization: {
        contribution,
        machineId: 'machine-a',
        realm: 'daemon',
        phase: 'speech',
        status: 'approval_required',
      },
    })).toBe('approval_required');
    expect(projectVoiceSpeechCredentialReadiness({
      ...common,
      settings: settingsParse({ ...selected, secrets: [] }),
      rawAuthorization: {
        contribution,
        machineId: 'machine-a',
        realm: 'daemon',
        phase: 'speech',
        status: 'ready',
      },
    })).toBe('missing');
  });

  it('requires inspected raw authorization for the slot-purpose-selected Connected Account without materializing it', () => {
    const declaration = VoiceProviderContributionSchema.parse({
      id: 'connected-stt',
      title: 'Connected STT',
      kind: 'speech',
      roles: ['dictation_stt'],
      platforms: ['web'],
      credentials: {
        slot: { id: 'account', purpose: 'voice.speech.binding', title: 'Account' },
        requirement: { kind: 'always' },
        sources: [{
          kind: 'connectedAccount',
          service: { pluginId: 'acme.identity', localId: 'oauth' },
          operationProjections: [{
            kind: 'materializedHttpHeaders',
            operation: 'transcribe',
            phase: 'speech',
            request: { kind: 'httpHeaders', origin: 'https://speech.example', headerNames: ['authorization'] },
            requiredHeaderNames: ['authorization'],
            allowedHeaderNames: ['authorization'],
          }],
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['SPEECH_TOKEN'] },
          }],
        }],
        hostMediated: { operations: [{
          id: 'transcribe',
          purpose: 'voice.speech.operation',
          credentialSlotId: 'account',
          effect: 'read',
          request: {
            origin: 'https://speech.example', pathTemplate: '/transcribe', queryTemplate: [], headerTemplate: [],
            bodyTemplate: { kind: 'json', value: {} }, method: 'POST', redirect: 'error', maxBodyBytes: 1024,
            contentTypes: ['application/json'], credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
          },
          parameters: { schema: { type: 'object', properties: {}, additionalProperties: false }, mapping: [] },
          response: { maxBytes: 1024, contentTypes: ['application/json'] },
        }] },
      },
      settings: {
        schemaVersion: 1,
        fields: [{
          id: 'model',
          title: 'Model',
          schema: { type: 'string', minLength: 1, maxLength: 64 },
          default: 'connected-stt-1',
          presentation: { control: 'text' },
        }],
      },
    });
    if (declaration.kind !== 'speech') throw new Error('expected speech declaration');
    const contribution = { pluginId: 'acme.speech', localId: declaration.id } as const;
    const providerId = 'acme.speech/connected-stt';
    const registry = createVoiceProviderRegistry({
      bundledContributions: [{ pluginId: contribution.pluginId, providerId, declaration }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: 'voice.connected-stt',
        createSettingsSpec: () => ({
          titleKey: 'Connected STT',
          subtitleKey: 'Acme',
          detailKey: 'Acme',
          iconName: 'cloud',
          credential: {
            titleKey: 'Account',
            promptTitleKey: 'Connect',
            promptBodyKey: 'Connect an account',
          },
          fields: [{ fieldId: 'model', titleKey: 'Model', subtitleKey: 'Model' }],
          test: null,
        }),
      }],
    });
    const target = {
      kind: 'account' as const,
      account: {
        service: { pluginId: 'acme.identity', localId: 'oauth' },
        accountId: 'account-a',
      },
    };
    const settings = applyAccountVoiceCredentialSourceSelection({
      settings: settingsParse({}),
      mutation: {
        contribution,
        credentialSlotId: 'account',
        selection: { kind: 'connectedAccount', target },
        expectedSettingsVersion: 0,
      },
      currentDeclaration: declaration,
    }).settings;

    expect(projectVoiceSpeechCredentialReadiness({
      registry,
      role: 'dictation_stt',
      providerId,
      settings,
      executionMachineId: 'machine-a',
    })).toBe('unknown');
    expect(projectVoiceSpeechCredentialReadiness({
      registry,
      role: 'dictation_stt',
      providerId,
      settings,
      executionMachineId: 'machine-a',
      rawAuthorization: {
        contribution,
        machineId: 'machine-a',
        realm: 'daemon',
        phase: 'speech',
        status: 'approval_required',
      },
    })).toBe('approval_required');
    expect(projectVoiceSpeechCredentialReadiness({
      registry,
      role: 'dictation_stt',
      providerId,
      settings,
      executionMachineId: 'machine-a',
      rawAuthorization: {
        contribution,
        machineId: 'machine-a',
        realm: 'daemon',
        phase: 'speech',
        status: 'ready',
      },
    })).toBe('ready');
    expect(projectVoiceSpeechCredentialReadiness({
      registry,
      role: 'dictation_stt',
      providerId,
      settings: settingsParse({
        ...settings,
        connectedAccountPurposeBindingsV1: [],
      }),
      executionMachineId: 'machine-a',
      rawAuthorization: {
        contribution,
        machineId: 'machine-a',
        realm: 'daemon',
        phase: 'speech',
        status: 'ready',
      },
    })).toBe('unknown');
  });

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
    const ready = saveAndUseAccountVoiceCredential({
      settings: missing,
      contribution: {
        pluginId: entry.source.pluginId,
        localId: entry.declaration.id,
      },
      credentialSlotId: 'api_key',
      expectedSettingsVersion: 0,
      currentDeclaration: entry.declaration,
      machineId: 'machine-a',
      value: 'credential',
      generateId: () => 'credential-secret',
      now: 1,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
    }).settings;
    const rawAuthorization = {
      contribution: { pluginId: entry.source.pluginId, localId: entry.declaration.id },
      machineId: 'machine-a',
      realm: 'daemon' as const,
      phase: 'speech' as const,
      status: 'ready' as const,
    };
    expect(projectVoiceSpeechCredentialReadiness({
      registry,
      role,
      providerId: qualifiedProviderId,
      settings: ready,
      executionMachineId: 'machine-a',
      rawAuthorization,
    })).toBe('ready');
    expect(projectVoiceSpeechCredentialReadiness({
      registry,
      role,
      providerId: qualifiedProviderId,
      settings: ready,
      executionMachineId: 'machine-a',
      rawAuthorization,
    })).toBe('ready');
  });
});
