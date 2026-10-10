import { describe, expect, it } from 'vitest';
import { SessionVoicePreferenceV1Schema, readSessionVoicePreferenceV1, writeSessionVoicePreferenceV1ToMetadata } from './sessionVoicePreferenceV1.js';
import * as voicePreferences from './sessionVoicePreferenceV1.js';

describe('stored Session voice preference', () => {
  it('admits only the built-in local model voice field, without exposing model or speed overrides', () => {
    const declaration = voicePreferences.BUILT_IN_LOCAL_NEURAL_VOICE_DECLARATION;
    expect(voicePreferences.readBuiltInSessionVoiceDeclarationV1('happier.voice.builtin/local-neural')).toBe(declaration);
    const input = {
      providerContributionId: 'happier.voice.builtin/local-neural', declaration,
      providerConfig: { voiceId: 'af_heart' },
      preference: { providerContributionId: 'happier.voice.builtin/local-neural', settingFieldPath: 'voiceId', value: 'am_adam' },
    };
    expect(voicePreferences.resolveDeclaredSessionVoicePreferenceV1({ ...input, catalog: [{ id: 'am_adam', name: 'Adam' }] }))
      .toMatchObject({ kind: 'selected', providerConfig: { voiceId: 'am_adam' } });
    expect(voicePreferences.resolveDeclaredSessionVoicePreferenceV1({ ...input, catalog: [] }))
      .toEqual({ kind: 'unavailable', reason: 'voice_missing' });
    for (const settingFieldPath of ['model', 'speed']) {
      expect(voicePreferences.admitDeclaredSessionVoicePreferenceV1({ ...input, preference: { ...input.preference, settingFieldPath } }))
        .toMatchObject({ kind: 'unavailable' });
    }
    expect(input.providerConfig).toEqual({ voiceId: 'af_heart' });
  });
  it('drops stored annotations while preserving declared JSON dictionaries and writes only known preference fields', () => {
    const preference = { providerContributionId: 'happier.voice.xai/realtime', settingFieldPath: 'voice', value: { kind: 'custom', id: 'voice', dictionary: { arbitrary: 'retained JSON' } } };
    const stored = { ...preference, futureAnnotation: true };
    expect(readSessionVoicePreferenceV1(stored)).toEqual(preference);
    expect(SessionVoicePreferenceV1Schema.safeParse(stored).success).toBe(false);
    const metadata = { work: { memoryEnabled: false, voicePreference: stored } };
    expect(writeSessionVoicePreferenceV1ToMetadata(metadata, readSessionVoicePreferenceV1(stored)))
      .toEqual({ work: { memoryEnabled: false, voicePreference: preference } });
    expect(readSessionVoicePreferenceV1({ ...stored, providerContributionId: 'unqualified' })).toBeNull();
    expect(readSessionVoicePreferenceV1({ ...stored, settingFieldPath: 'tts.__proto__.voice' })).toBeNull();
  });
});
