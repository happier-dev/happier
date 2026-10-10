import { describe, expect, it } from 'vitest';
import { BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS } from '@/voice/registry/generatedBundledVoiceEntries';
import { createExternalVoiceProviderSettingsDescriptor } from './externalProviderSettings';
import { resolveSessionVoicePreference } from './resolveSessionVoicePreference';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';

function provider(pluginId: string, kind: 'conversation' | 'speech' = 'conversation') {
  const entry = BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS.find((entry) => entry.pluginId === pluginId && entry.declaration.kind === kind
    && (kind !== 'speech' || entry.declaration.roles.includes('conversation_tts')));
  if (!entry) throw new Error(`Missing declaration ${pluginId}`);
  const settings = createExternalVoiceProviderSettingsDescriptor(entry.declaration.settings);
  return { providerContributionId: entry.providerId, declaration: entry.declaration, providerConfig: settings.defaultConfig };
}

describe('Session voice preference through provider declarations', () => {
  it('inherits Account settings and applies the declared OpenAI string without touching sibling settings', () => {
    const input = provider('happier.voice.openai');
    expect(resolveSessionVoicePreference({ ...input, preference: null })).toMatchObject({ kind: 'inherited', providerConfig: input.providerConfig });
    const preference = { providerContributionId: input.providerContributionId, settingFieldPath: 'voice', value: 'my-custom-voice' };
    expect(resolveSessionVoicePreference({ ...input, preference })).toMatchObject({ kind: 'selected', providerConfig: { ...input.providerConfig, voice: 'my-custom-voice' } });
  });
  it.each(['catalog', 'custom'] as const)('preserves xAI %s value shape and accepts supported custom voices absent from rows', (kind) => {
    const input = provider('happier.voice.xai');
    const value = { kind, id: kind === 'catalog' ? 'eve' : 'custom-voice' };
    const preference = { providerContributionId: input.providerContributionId, settingFieldPath: 'voice', value };
    expect(resolveSessionVoicePreference({ ...input, preference, catalog: [{ id: 'eve', name: 'Eve' }] }))
      .toMatchObject({ kind: 'selected', providerConfig: { ...input.providerConfig, voice: value } });
  });
  it('uses Google voices catalog field binding and accepts custom values without a fetched catalog', () => {
    const input = provider('happier.voice.google', 'speech');
    const preference = { providerContributionId: input.providerContributionId, settingFieldPath: 'voiceName', value: 'en-US-Custom' };
    expect(resolveSessionVoicePreference({ ...input, preference, catalog: null })).toMatchObject({
      kind: 'selected', providerConfig: { ...input.providerConfig, voiceName: 'en-US-Custom' }, field: { path: 'voiceName' },
    });
  });
  it('preserves provider-declared empty and nullable voice defaults rather than treating them as Follow account', () => {
    const google = provider('happier.voice.google', 'speech');
    expect(resolveSessionVoicePreference({ ...google, preference: { providerContributionId: google.providerContributionId,
      settingFieldPath: 'voiceName', value: '' }, catalog: null })).toMatchObject({ kind: 'selected',
      providerConfig: { ...google.providerConfig, voiceName: '' }, inUseVoice: null });
    expect(resolveSessionVoicePreference({ ...google, preference: { providerContributionId: google.providerContributionId,
      settingFieldPath: 'voiceName', value: null }, catalog: null })).toMatchObject({ kind: 'unavailable', reason: 'invalid_value' });
    const elevenlabs = provider('happier.voice.elevenlabs');
    expect(resolveSessionVoicePreference({ ...elevenlabs, preference: { providerContributionId: elevenlabs.providerContributionId,
      settingFieldPath: 'tts.voiceId', value: null }, catalog: null })).toMatchObject({ kind: 'unavailable', reason: 'invalid_value' });
  });
  it('preserves null when the normalized provider voice declaration explicitly permits it', () => {
    const input = provider('happier.voice.elevenlabs');
    const declaration = VoiceProviderContributionSchema.parse({ ...input.declaration, settings: { ...input.declaration.settings,
      fields: input.declaration.settings?.fields.map(field => field.id === 'tts'
        ? { ...field, schema: { ...field.schema, properties: { ...field.schema.properties,
          voiceId: { anyOf: [{ type: 'string', minLength: 1, maxLength: 256 }, { type: 'null' }] },
        } } } : field),
    } });
    expect(resolveSessionVoicePreference({ ...input, declaration, preference: { providerContributionId: input.providerContributionId,
      settingFieldPath: 'tts.voiceId', value: null }, catalog: null })).toMatchObject({ kind: 'selected', inUseVoice: null });
  });
  it('uses the declared ElevenLabs nested voice field while retaining model and speed, and rejects missing catalog rows', () => {
    const input = provider('happier.voice.elevenlabs');
    const preference = { providerContributionId: input.providerContributionId, settingFieldPath: 'tts.voiceId', value: 'selected-voice' };
    const selected = resolveSessionVoicePreference({ ...input, preference, catalog: [{ id: 'selected-voice', name: 'Selected voice' }] });
    expect(selected).toMatchObject({ kind: 'selected', field: { path: 'tts.voiceId' },
      inUseVoice: { ...preference, displayName: 'Selected voice' } });
    if (selected.kind !== 'selected') throw new Error('Expected selected voice');
    const original = input.providerConfig;
    if (!original || typeof original !== 'object' || Array.isArray(original)) throw new Error('Expected settings object');
    const tts = original.tts;
    if (!tts || typeof tts !== 'object' || Array.isArray(tts)) throw new Error('Expected TTS settings');
    expect(selected.providerConfig).toEqual({ ...original, tts: { ...tts, voiceId: 'selected-voice' } });
    expect(resolveSessionVoicePreference({ ...input, preference, catalog: null })).toMatchObject({ kind: 'unavailable', reason: 'voice_missing' });
    expect(resolveSessionVoicePreference({ ...input, preference, catalog: [] })).toMatchObject({ kind: 'unavailable', reason: 'voice_missing' });
  });
  it('refuses a foreign contribution and arbitrary model/speed fields instead of switching provider', () => {
    const input = provider('happier.voice.xai');
    expect(resolveSessionVoicePreference({ ...input, preference: { providerContributionId: 'happier.voice.openai/openai_realtime', settingFieldPath: 'voice', value: 'marin' } }))
      .toMatchObject({ kind: 'unavailable', reason: 'provider_mismatch' });
    for (const [settingFieldPath, value] of [['outputSpeed', 1.2], ['model', { kind: 'pinned', id: 'other' }]] as const) {
      expect(resolveSessionVoicePreference({ ...input, preference: { providerContributionId: input.providerContributionId, settingFieldPath, value } }))
        .toMatchObject({ kind: 'unavailable', reason: 'voice_missing' });
    }
  });
});
