import { describe, expect, it } from 'vitest';

import {
  VoiceProviderIdSchema,
  VoiceCredentialBindingV1Schema,
  VoiceProviderSettingsEnvelopeV1Schema,
  VoiceProviderSettingsRecordV1Schema,
} from './providerSettings.js';

describe('voice realtime provider settings contracts', () => {
  it('binds Voice provider slots to SavedSecret ids without importing provider connections', () => {
    expect(VoiceCredentialBindingV1Schema.parse({
      providerId: 'realtime_openai',
      credentialBindings: { account: { api_key: 'saved-openai' } },
    })).toEqual({
      providerId: 'realtime_openai',
      credentialBindings: { account: { api_key: 'saved-openai' } },
    });
  });
  it('accepts existing segmented provider ids and rejects reserved object keys', () => {
    expect(VoiceProviderIdSchema.parse('realtime_elevenlabs')).toBe('realtime_elevenlabs');
    expect(VoiceProviderIdSchema.parse('acme.voice-v2')).toBe('acme.voice-v2');
    expect(VoiceProviderIdSchema.safeParse('constructor').success).toBe(false);
    expect(VoiceProviderIdSchema.safeParse('prototype').success).toBe(false);
    expect(VoiceProviderIdSchema.safeParse(' realtime_elevenlabs').success).toBe(false);
    expect(VoiceProviderIdSchema.safeParse('realtime_elevenlabs ').success).toBe(false);
  });

  it('accepts canonical qualified external provider ids without weakening legacy ids', () => {
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
    expect(VoiceProviderSettingsRecordV1Schema.parse({ future_vendor: envelope })).toEqual({
      future_vendor: envelope,
    });
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
