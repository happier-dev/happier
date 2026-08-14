import { describe, expect, it } from 'vitest';

import * as providerSettingsContract from './providerSettings.js';
import {
  VoiceProviderIdSchema,
  VoiceCredentialBindingV1Schema,
  VoiceProviderSettingsEnvelopeV1Schema,
  VoiceProviderSettingsRecordV1Schema,
} from './providerSettings.js';

describe('voice realtime provider settings contracts', () => {
  it('uses one qualified current Voice credential binding schema', () => {
    expect(VoiceCredentialBindingV1Schema.parse({
      contribution: {
        pluginId: 'happier.voice.openai',
        localId: 'realtime-openai',
      },
      credentialSlotId: 'api_key',
      credentialSource: { kind: 'savedSecret' },
      credentialBindings: { account: { api_key: 'saved-openai' } },
    })).toEqual({
      contribution: {
        pluginId: 'happier.voice.openai',
        localId: 'realtime-openai',
      },
      credentialSlotId: 'api_key',
      credentialSource: { kind: 'savedSecret' },
      credentialBindings: { account: { api_key: 'saved-openai' } },
    });
    expect(VoiceCredentialBindingV1Schema.safeParse({
      providerId: 'realtime_openai',
      credentialBindings: { account: { api_key: 'saved-openai' } },
    }).success).toBe(false);
    expect(providerSettingsContract)
      .not.toHaveProperty('QualifiedVoiceCredentialBindingV1Schema');
  });

  it('keeps a qualified Voice credential binding scoped to exactly its declared slot', () => {
    const binding = {
      contribution: {
        pluginId: 'happier.voice.openai',
        localId: 'realtime-openai',
      },
      credentialSlotId: 'api_key',
      credentialSource: { kind: 'savedSecret' },
      credentialBindings: { account: { api_key: 'saved-openai' } },
    };

    expect(VoiceCredentialBindingV1Schema.parse(binding)).toEqual(binding);
    expect(VoiceCredentialBindingV1Schema.safeParse({
      ...binding,
      credentialBindings: {
        account: {
          api_key: 'saved-openai',
          secondary_key: 'must-not-be-admitted',
        },
      },
    }).success).toBe(false);
    expect(VoiceCredentialBindingV1Schema.safeParse({
      ...binding,
      credentialBindings: {
        byMachineId: {
          machine_a: { secondary_key: 'must-not-be-admitted' },
        },
      },
    }).success).toBe(false);
  });
  it('accepts only canonical qualified contribution ids at current boundaries', () => {
    expect(VoiceProviderIdSchema.safeParse('realtime_elevenlabs').success).toBe(false);
    expect(VoiceProviderIdSchema.safeParse('acme.voice-v2').success).toBe(false);
    expect(VoiceProviderIdSchema.safeParse('constructor').success).toBe(false);
    expect(VoiceProviderIdSchema.safeParse('prototype').success).toBe(false);
    expect(VoiceProviderIdSchema.safeParse(' realtime_elevenlabs').success).toBe(false);
    expect(VoiceProviderIdSchema.safeParse('realtime_elevenlabs ').success).toBe(false);
  });

  it('accepts canonical qualified external provider ids', () => {
    expect(VoiceProviderIdSchema.parse('acme.synthetic-voice/conversation')).toBe('acme.synthetic-voice/conversation');
    expect(VoiceProviderSettingsRecordV1Schema.parse({
      'acme.synthetic-voice/conversation': { schemaVersion: 1, config: { mode: 'default' } },
    })).toHaveProperty('acme.synthetic-voice/conversation');
    expect(VoiceProviderIdSchema.safeParse('acme.synthetic-voice//conversation').success).toBe(false);
    expect(VoiceProviderIdSchema.safeParse('acme.synthetic-voice/../conversation').success).toBe(false);
  });

  it('preserves open versioned envelopes without interpreting provider config', () => {
    const envelope = {
      schemaVersion: 7,
      config: { future: ['value', 3, true, null] },
    };

    expect(VoiceProviderSettingsEnvelopeV1Schema.parse(envelope)).toEqual(envelope);
    expect(VoiceProviderSettingsRecordV1Schema.safeParse({ future_vendor: envelope }).success).toBe(false);
  });

  it('rejects invalid provider record keys and envelope versions', () => {
    expect(VoiceProviderSettingsRecordV1Schema.safeParse({
      'Invalid Provider': { schemaVersion: 1, config: {} },
    }).success).toBe(false);
    expect(VoiceProviderSettingsEnvelopeV1Schema.safeParse({
      schemaVersion: 0,
      config: {},
    }).success).toBe(false);
  });

  it('accepts only serializable JSON provider config', () => {
    expect(VoiceProviderSettingsEnvelopeV1Schema.safeParse({
      schemaVersion: 1,
      config: undefined,
    }).success).toBe(false);
    expect(VoiceProviderSettingsEnvelopeV1Schema.safeParse({
      schemaVersion: 1,
      config: { amount: Number.POSITIVE_INFINITY },
    }).success).toBe(false);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(VoiceProviderSettingsEnvelopeV1Schema.safeParse({
      schemaVersion: 1,
      config: cyclic,
    }).success).toBe(false);
  });
});
