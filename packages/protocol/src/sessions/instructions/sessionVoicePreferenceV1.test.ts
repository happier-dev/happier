import { describe, expect, it } from 'vitest';
import { SessionVoicePreferenceV1Schema, readSessionVoicePreferenceV1, writeSessionVoicePreferenceV1ToMetadata } from './sessionVoicePreferenceV1.js';

describe('stored Session voice preference', () => {
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
