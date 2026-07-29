import { describe, expect, it } from 'vitest';

import { BUNDLED_VOICE_UI_ENTRIES } from './index.js';

describe('Google bundled voice UI contribution', () => {
  it('advertises only its executable speech roles and no conversation runtime', () => {
    const stt = BUNDLED_VOICE_UI_ENTRIES.find((entry) => entry.providerId === 'google_gemini');
    const tts = BUNDLED_VOICE_UI_ENTRIES.find((entry) => entry.providerId === 'google_cloud');

    expect(stt).toMatchObject({
      role: 'stt',
      roles: ['dictation_stt', 'conversation_stt'],
      requirements: ['execution_machine', 'credential', 'runtime'],
    });
    expect(tts).toMatchObject({
      role: 'tts',
      roles: ['conversation_tts'],
      requirements: ['execution_machine', 'credential', 'runtime'],
    });
  });

  it('owns executable settings factories behind the internal first-party boundary', () => {
    const stt = BUNDLED_VOICE_UI_ENTRIES.find((entry) => entry.providerId === 'google_gemini');
    const tts = BUNDLED_VOICE_UI_ENTRIES.find((entry) => entry.providerId === 'google_cloud');

    expect(typeof stt?.internal.createSettingsSpec).toBe('function');
    expect(typeof tts?.internal.createSettingsSpec).toBe('function');
    expect(stt?.internal.createSettingsSpec).toBe(tts?.internal.createSettingsSpec);

    const sttSettings = stt?.internal.createSettingsSpec('google_gemini');
    const ttsSettings = tts?.internal.createSettingsSpec('google_cloud');
    expect(sttSettings?.schemaVersion).toBe(2);
    expect(ttsSettings?.schemaVersion).toBe(2);
    expect(sttSettings).not.toHaveProperty('configKey');
    expect(ttsSettings).not.toHaveProperty('configKey');
    expect(sttSettings?.parseConfig({ model: 'gemini-test', language: 'fr' })).toEqual({
      model: 'gemini-test',
      language: 'fr',
    });
    expect(sttSettings?.parseConfig({ apiKey: { encrypted: true }, model: 'gemini-test' })).toBeNull();
    expect(sttSettings?.parseConfig({ model: '' })).toBeNull();
    expect(ttsSettings?.parseConfig({ voiceName: 'en-US-Test-A', format: 'wav' })).toEqual(expect.objectContaining({
      voiceName: 'en-US-Test-A',
      format: 'wav',
      speakingRate: null,
      pitch: null,
    }));
    expect(ttsSettings?.parseConfig({ speakingRate: 99 })).toBeNull();
    expect(ttsSettings?.parseConfig({ apiKey: 'secret', androidCertSha1: 'AA:BB' })).toBeNull();

    const legacyStt = { apiKey: { encrypted: true }, model: 'gemini-legacy', language: 'de', obsoleteField: true };
    expect(sttSettings?.readLegacySecret(legacyStt)).toEqual({ encrypted: true });
    expect(sttSettings?.migrateLegacy(legacyStt)).toEqual({ model: 'gemini-legacy', language: 'de' });
    expect(JSON.stringify(sttSettings?.migrateLegacy(legacyStt))).not.toContain('apiKey');

    const legacyTts = { apiKey: { encrypted: true }, androidCertSha1: 'AA:BB', voiceName: 'de-DE-Test-A' };
    expect(ttsSettings?.readLegacySecret(legacyTts)).toEqual({ encrypted: true });
    expect(ttsSettings?.classifyLegacyCredential(legacyTts)).toBe('needs_machine_credential');
    expect(ttsSettings?.migrateLegacy(legacyTts)).toEqual(expect.objectContaining({ voiceName: 'de-DE-Test-A' }));
    expect(JSON.stringify(ttsSettings?.migrateLegacy(legacyTts))).not.toMatch(/apiKey|androidCertSha1/);
  });
});
