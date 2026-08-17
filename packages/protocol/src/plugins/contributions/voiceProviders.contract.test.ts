import { describe, expect, it } from 'vitest';

import {
  resolveVoiceSpeechEndpointPolicy,
  resolveVoiceSpeechSettingsCorrespondence,
  deriveVoiceCredentialBindingIdentityV1,
  VoiceCredentialSlotIdSchema,
  VoiceProviderContributionSchema,
  VoiceProviderSettingsSchema,
  normalizeVoiceProviderContribution,
} from './voiceProviders.js';
import { PluginContributesV2Schema } from './v2.js';

const credential = Object.freeze({
  slot: {
    id: 'api_key',
    purpose: 'voice.speech',
    title: 'API key',
  },
  requirement: { kind: 'always' as const },
  sources: [{
    kind: 'savedSecret' as const,
    secretKinds: ['apiKey' as const],
    rawGrants: [{
      realm: 'daemon' as const,
      phase: 'speech' as const,
      request: {
        kind: 'httpHeaders' as const,
        origin: 'https://speech.googleapis.com',
        headerNames: ['authorization'],
      },
    }],
  }],
});

const reservedSttSettings = Object.freeze({
  schemaVersion: 2 as const,
  fields: Object.freeze([Object.freeze({
    id: 'model',
    title: 'Model',
    schema: Object.freeze({ type: 'string' as const, minLength: 1, maxLength: 512 }),
    default: 'speech-default',
    presentation: Object.freeze({ control: 'text' as const }),
  })]),
});

const hostOperation = Object.freeze({
  id: 'catalog',
  purpose: 'voice.catalog',
  credentialSlotId: 'api_key',
  effect: 'read' as const,
  request: {
    origin: 'https://speech.googleapis.com',
    pathTemplate: '/v1/catalog',
    queryTemplate: [],
    headerTemplate: [],
    bodyTemplate: { kind: 'none' as const },
    method: 'GET' as const,
    credential: { kind: 'httpHeader' as const, name: 'authorization', format: 'bearer' as const },
    redirect: 'error' as const,
    maxBodyBytes: 0,
    contentTypes: [],
  },
  parameters: {
    schema: { type: 'object' as const, properties: {}, additionalProperties: false },
    mapping: [],
  },
  response: { maxBytes: 1024, contentTypes: ['application/json'] },
});

describe('canonical Voice provider declarations', () => {
  it('uses the final contribution union at the active manifest-family owner', () => {
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        id: 'gemini-stt',
        title: 'Gemini speech-to-text',
        kind: 'speech',
        roles: ['dictation_stt', 'conversation_stt'],
        platforms: ['web', 'ios', 'android'],
        credentials: credential,
        settings: reservedSttSettings,
      }],
    }).success).toBe(true);
    expect(PluginContributesV2Schema.safeParse({
      voiceProviders: [{
        id: 'legacy-speech',
        title: 'Legacy speech',
        kind: 'speech',
        roles: ['conversation_tts'],
        platforms: ['web'],
        speechProviderIds: ['nested-provider'],
      }],
    }).success).toBe(false);
  });

  it('derives the one qualified contribution, slot, and semantic purpose from the manifest declaration', () => {
    expect(deriveVoiceCredentialBindingIdentityV1({
      pluginId: 'happier.voice.google',
      contribution: {
        id: 'gemini-stt',
        title: 'Gemini speech-to-text',
        kind: 'speech',
        roles: ['dictation_stt', 'conversation_stt'],
        platforms: ['web'],
        credentials: credential,
        settings: reservedSttSettings,
      },
    })).toEqual({
      contribution: {
        pluginId: 'happier.voice.google',
        localId: 'gemini-stt',
      },
      credentialSlotId: 'api_key',
      purpose: {
        consumer: {
          pluginId: 'happier.voice.google',
          localId: 'gemini-stt',
        },
        purpose: 'voice.speech',
      },
    });

    expect(deriveVoiceCredentialBindingIdentityV1({
      pluginId: 'happier.voice.google',
      contribution: {
        id: 'credential-free',
        title: 'Credential free speech',
        kind: 'speech',
        roles: ['conversation_tts'],
        platforms: ['web'],
        settings: {
          schemaVersion: 2,
          fields: [{
            id: 'voiceName', title: 'Voice',
            schema: { type: 'string', minLength: 1, maxLength: 512 },
            default: 'voice-default', presentation: { control: 'text' },
          }],
        },
      },
    })).toBeNull();
  });

  it('requires settings for speech and derives request fields through one catalog-aware owner', () => {
    expect(VoiceProviderContributionSchema.safeParse({
      id: 'missing-settings', title: 'Missing settings', kind: 'speech',
      roles: ['dictation_stt'], platforms: ['web'],
    }).success).toBe(false);

    const declaration = VoiceProviderContributionSchema.parse({
      id: 'catalog-speech', title: 'Catalog speech', kind: 'speech',
      roles: ['dictation_stt', 'conversation_tts'], platforms: ['web'],
      settings: {
        schemaVersion: 2,
        fields: [{
          id: 'catalogModel', title: 'Model',
          schema: { type: 'string', maxLength: 512 }, default: '',
          presentation: { control: 'select' },
        }, {
          id: 'catalogVoice', title: 'Voice',
          schema: { type: 'string', minLength: 1, maxLength: 512 }, default: 'voice-default',
          presentation: { control: 'select' },
        }],
        readiness: [{ kind: 'setting_nonempty', settingId: 'catalogModel' }],
      },
      catalogs: [
        { kind: 'models', settingFieldId: 'catalogModel', allowCustom: true },
        { kind: 'voices', settingFieldId: 'catalogVoice', allowCustom: true },
      ],
    });
    const mutable = { catalogModel: '  model-selected  ', catalogVoice: 'voice-selected' };
    const resolved = resolveVoiceSpeechSettingsCorrespondence({
      contribution: declaration,
      settings: mutable,
    });

    expect(resolved.transcribe).toEqual({ model: 'model-selected' });
    expect(resolved.synthesize).toEqual({ model: 'model-selected', voiceName: 'voice-selected' });
    expect(resolved.settings).toEqual(mutable);
    expect(Object.isFrozen(resolved.settings)).toBe(true);
    mutable.catalogModel = 'mutated-after-snapshot';
    expect(resolved.settings.catalogModel).toBe('  model-selected  ');
    expect(resolveVoiceSpeechSettingsCorrespondence({
      contribution: declaration,
      settings: { catalogModel: '   ', catalogVoice: 'voice-selected' },
    })).toMatchObject({
      transcribe: null,
      synthesize: { model: null, voiceName: 'voice-selected' },
    });
  });

  it('maps reserved speech fields without fallback and makes absent optional TTS model null', () => {
    const stt = VoiceProviderContributionSchema.parse({
      id: 'reserved-stt', title: 'Reserved STT', kind: 'speech',
      roles: ['dictation_stt'], platforms: ['web'], settings: reservedSttSettings,
    });
    const tts = VoiceProviderContributionSchema.parse({
      id: 'reserved-tts', title: 'Reserved TTS', kind: 'speech',
      roles: ['conversation_tts'], platforms: ['web'],
      settings: {
        schemaVersion: 2,
        fields: [{
          id: 'voiceName', title: 'Voice',
          schema: { type: 'string', minLength: 1, maxLength: 512 },
          default: 'voice-default', presentation: { control: 'text' },
        }],
      },
    });

    expect(resolveVoiceSpeechSettingsCorrespondence({
      contribution: stt,
      settings: {},
    })).toMatchObject({
      settings: { model: 'speech-default' },
      transcribe: { model: 'speech-default' },
    });
    expect(resolveVoiceSpeechSettingsCorrespondence({
      contribution: tts,
      settings: { voiceName: 'reserved-voice' },
    }).synthesize).toEqual({ model: null, voiceName: 'reserved-voice' });
  });

  it('derives machine-bound exact endpoint consent from reserved speech settings', () => {
    expect(resolveVoiceSpeechEndpointPolicy({
      settings: {
        baseUrl: 'http://localhost:11434/v1/',
        insecureLocalOriginConsent: 'http://localhost:11434',
        insecureLocalConsentMachineId: 'machine-a',
      },
      machineId: 'machine-a',
    })).toEqual({
      normalizedBaseUrl: 'http://localhost:11434/v1/',
      origin: 'http://localhost:11434',
      insecureHttpConfirmed: true,
    });
    expect(resolveVoiceSpeechEndpointPolicy({
      settings: {
        baseUrl: 'http://localhost:11434/v1',
        insecureLocalOriginConsent: 'http://localhost:11434',
        insecureLocalConsentMachineId: 'machine-a',
      },
      machineId: 'machine-b',
    })?.insecureHttpConfirmed).toBe(false);
    expect(() => resolveVoiceSpeechEndpointPolicy({
      settings: { baseUrl: 'http://localhost:11434/v1' },
      machineId: 'machine-a',
    })).toThrow('voice_speech_endpoint_policy_invalid');
  });

  it('requires unconditional readiness when a required speech string permits blank values', () => {
    const blankCapable = {
      id: 'blank-capable', title: 'Blank capable', kind: 'speech' as const,
      roles: ['dictation_stt' as const], platforms: ['web' as const],
      settings: {
        schemaVersion: 2 as const,
        fields: [{
          id: 'model', title: 'Model', schema: { type: 'string' as const, maxLength: 512 },
          default: '', presentation: { control: 'text' as const },
        }],
      },
    };
    expect(VoiceProviderContributionSchema.safeParse(blankCapable).success).toBe(false);
    expect(VoiceProviderContributionSchema.safeParse({
      ...blankCapable,
      settings: {
        ...blankCapable.settings,
        readiness: [{ kind: 'setting_nonempty', settingId: 'model' }],
      },
    }).success).toBe(true);
  });
  it('accepts the approved split Google speech contributions and keeps one qualified local identity', () => {
    const stt = normalizeVoiceProviderContribution({
      id: 'gemini-stt',
      title: 'Gemini speech-to-text',
      kind: 'speech',
      roles: ['dictation_stt', 'conversation_stt'],
      platforms: ['web', 'ios', 'android'],
      credentials: credential,
      settings: {
        schemaVersion: 2,
        fields: [{
          id: 'model',
          title: 'Model',
          schema: { type: 'string', maxLength: 512 },
          default: 'gemini-2.5-flash',
          presentation: { control: 'select' },
        }],
        readiness: [{ kind: 'setting_nonempty', settingId: 'model' }],
      },
      catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }],
      limits: { transcribe: { maxInputBytes: 10_000_000 } },
    });
    const tts = VoiceProviderContributionSchema.parse({
      id: 'google-cloud-tts',
      title: 'Google Cloud text-to-speech',
      kind: 'speech',
      roles: ['conversation_tts'],
      platforms: ['web', 'ios', 'android'],
      credentials: credential,
      settings: {
        schemaVersion: 2,
        fields: [{
          id: 'voice',
          title: 'Voice',
          schema: { type: 'string', maxLength: 512 },
          default: 'en-US-Neural2-A',
          presentation: { control: 'select' },
        }],
        readiness: [{ kind: 'setting_nonempty', settingId: 'voice' }],
      },
      catalogs: [{ kind: 'voices', settingFieldId: 'voice', allowCustom: false }],
      limits: { synthesize: { maxInputCharacters: 5_000, maxOutputBytes: 8_000_000 } },
    });

    expect(stt.id).toBe('gemini-stt');
    expect(tts.id).toBe('google-cloud-tts');
    expect(stt).not.toHaveProperty('providerId');
    expect(tts).not.toHaveProperty('providerId');
  });

  it('uses a Voice-domain nominal slot id and rejects poison, whitespace, and over-bound ids', () => {
    expect(VoiceCredentialSlotIdSchema.parse('api-key')).toBe('api-key');
    for (const invalid of [' api-key', 'api key', '__proto__', 'constructor', 'A'.repeat(129)]) {
      expect(VoiceCredentialSlotIdSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('rejects raw grants that differ only by destination order without reordering accepted requests', () => {
    const contribution = {
      id: 'speech',
      title: 'Speech',
      kind: 'speech' as const,
      roles: ['conversation_tts' as const],
      platforms: ['web' as const],
      credentials: {
        slot: credential.slot,
        requirement: credential.requirement,
        sources: [{
          kind: 'savedSecret' as const,
          secretKinds: ['apiKey' as const],
          rawGrants: [{
            realm: 'daemon' as const,
            phase: 'speech' as const,
            request: { kind: 'environment' as const, keys: ['B', 'A'] },
          }, {
            realm: 'daemon' as const,
            phase: 'speech' as const,
            request: { kind: 'environment' as const, keys: ['A', 'B'] },
          }],
        }],
      },
      settings: {
        schemaVersion: 2,
        fields: [{
          id: 'voiceName', title: 'Voice', schema: { type: 'string', minLength: 1, maxLength: 512 },
          default: 'voice-default', presentation: { control: 'text' },
        }],
      },
    };

    expect(VoiceProviderContributionSchema.safeParse(contribution).success).toBe(false);
    const accepted = VoiceProviderContributionSchema.parse({
      ...contribution,
      credentials: {
        ...contribution.credentials,
        sources: [{
          ...contribution.credentials.sources[0],
          rawGrants: [contribution.credentials.sources[0].rawGrants[0]],
        }],
      },
    });
    expect(accepted.credentials?.sources[0]?.rawGrants?.[0]?.request).toEqual({
      kind: 'environment', keys: ['B', 'A'],
    });
  });

  it('rejects mixed identities, wrong-realm speech grants, duplicate catalogs, and first-over-cap sources', () => {
    const base = {
      id: 'speech',
      title: 'Speech',
      kind: 'speech' as const,
      roles: ['conversation_tts' as const],
      platforms: ['web' as const],
      credentials: credential,
      settings: {
        schemaVersion: 2,
        fields: [{
          id: 'voiceName', title: 'Voice', schema: { type: 'string', minLength: 1, maxLength: 512 },
          default: 'voice-default', presentation: { control: 'text' },
        }],
      },
    };

    expect(VoiceProviderContributionSchema.safeParse({ ...base, providerId: 'nested' }).success).toBe(false);
    expect(VoiceProviderContributionSchema.safeParse({
      ...base,
      credentials: {
        ...credential,
        sources: [{
          ...credential.sources[0],
          rawGrants: [{
            realm: 'web',
            phase: 'speech',
            request: { kind: 'environment', keys: ['GOOGLE_API_KEY'] },
          }],
        }],
      },
    }).success).toBe(false);
    expect(VoiceProviderContributionSchema.safeParse({
      ...base,
      settings: {
        schemaVersion: 2,
        fields: [{
          id: 'voice', title: 'Voice', schema: { type: 'string', maxLength: 512 },
          default: 'a', presentation: { control: 'select' },
        }],
      },
      catalogs: [
        { kind: 'voices', settingFieldId: 'voice', allowCustom: false },
        { kind: 'voices', settingFieldId: 'voice', allowCustom: false },
      ],
    }).success).toBe(false);

    const connected = (localId: string) => ({
      kind: 'connectedAccount' as const,
      service: { pluginId: 'happier.voice.google', localId },
      rawGrants: [{
        realm: 'daemon' as const,
        phase: 'speech' as const,
        request: { kind: 'httpHeaders' as const, origin: 'https://example.com', headerNames: ['authorization'] },
      }],
    });
    expect(VoiceProviderContributionSchema.safeParse({
      ...base,
      credentials: {
        ...credential,
        sources: [credential.sources[0], ...['a', 'b', 'c', 'd', 'e'].map(connected)],
      },
    }).success).toBe(false);
  });

  it('preserves settings v1, requires exact static options, and enforces one speech-phase projection per operation', () => {
    expect(VoiceProviderSettingsSchema.safeParse({
      schemaVersion: 1,
      fields: [],
      privacyDisclosure: 'A bounded privacy disclosure.',
    }).success).toBe(true);
    expect(VoiceProviderSettingsSchema.safeParse({
      schemaVersion: 2,
      fields: [{
        id: 'model',
        title: 'Model',
        schema: { type: 'string', enum: ['a', 'b'] },
        default: 'a',
        presentation: {
          control: 'select',
          options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'A again' }],
        },
      }],
    }).success).toBe(false);

    const projection = {
      kind: 'recipientCredential' as const,
      operation: 'catalog',
      phase: 'speech' as const,
      format: 'bearer' as const,
    };
    const contribution = {
      id: 'speech',
      title: 'Speech',
      kind: 'speech' as const,
      roles: ['conversation_tts' as const],
      platforms: ['web' as const],
      credentials: {
        slot: credential.slot,
        requirement: credential.requirement,
        sources: [{
          kind: 'savedSecret' as const,
          secretKinds: ['apiKey' as const],
          operationProjections: [projection],
        }],
        hostMediated: { operations: [hostOperation] },
      },
      settings: {
        schemaVersion: 2,
        fields: [{
          id: 'voiceName', title: 'Voice', schema: { type: 'string', minLength: 1, maxLength: 512 },
          default: 'voice-default', presentation: { control: 'text' },
        }],
      },
    };
    expect(VoiceProviderContributionSchema.safeParse(contribution).success).toBe(true);
    expect(VoiceProviderContributionSchema.safeParse({
      ...contribution,
      credentials: {
        ...contribution.credentials,
        sources: [{
          ...contribution.credentials.sources[0],
          operationProjections: [projection, projection],
        }],
      },
    }).success).toBe(false);
    expect(VoiceProviderContributionSchema.safeParse({
      ...contribution,
      credentials: {
        ...contribution.credentials,
        sources: [{
          ...contribution.credentials.sources[0],
          operationProjections: [{ ...projection, phase: 'settings' }],
        }],
      },
    }).success).toBe(false);
  });

  it('bounds Voice action nonempty conditions to declared string settings', () => {
    const action = {
      id: 'update-agent',
      title: 'Update agent',
      placement: { kind: 'afterField' as const, fieldId: 'agentId' },
      enabledWhen: { kind: 'setting_nonempty' as const, settingId: 'agentId' },
      confirmation: { kind: 'none' as const },
      patchFieldIds: ['agentId'],
    };
    const settings = {
      schemaVersion: 2 as const,
      fields: [{
        id: 'agentId',
        title: 'Agent ID',
        schema: { type: 'string' as const, minLength: 0, maxLength: 256 },
        default: '',
        presentation: { control: 'text' as const },
      }],
      actions: [action],
    };

    expect(VoiceProviderSettingsSchema.safeParse(settings).success).toBe(true);
    expect(VoiceProviderSettingsSchema.safeParse({
      ...settings,
      actions: [{ ...action, enabledWhen: { ...action.enabledWhen, settingId: 'missing' } }],
    }).success).toBe(false);
    expect(VoiceProviderSettingsSchema.safeParse({
      ...settings,
      fields: [{
        ...settings.fields[0],
        schema: { type: 'number' as const, minimum: 0, maximum: 10 },
        default: 0,
        presentation: { control: 'number' as const },
      }],
    }).success).toBe(false);
  });
});
