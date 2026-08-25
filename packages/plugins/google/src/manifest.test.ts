import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';
import {
  GOOGLE_CLOUD_TTS_VOICE_PROVIDER_DECLARATION,
  GOOGLE_GEMINI_STT_VOICE_PROVIDER_DECLARATION,
} from './voice/declarations.js';

describe('Google voice plugin manifest', () => {
  it('declares the public daemon speech facet consumed by the Voice host', () => {
    expect(parsePluginManifest(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST.contributes.voiceProviders).toEqual([
      expect.objectContaining({
        id: 'gemini-stt',
        kind: 'speech',
        roles: ['dictation_stt', 'conversation_stt'],
        catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }],
        limits: { transcribe: { maxInputBytes: 8 * 1024 * 1024 } },
      }),
      expect.objectContaining({
        id: 'google-cloud-tts',
        kind: 'speech',
        roles: ['conversation_tts'],
        settings: expect.objectContaining({
          readiness: [{ kind: 'setting_nonempty', settingId: 'voiceName' }],
        }),
        catalogs: [{ kind: 'voices', settingFieldId: 'voiceName', allowCustom: true }],
        limits: { synthesize: { maxInputCharacters: 1_666, maxOutputBytes: 3_000_000 } },
      }),
    ]);
    expect(PLUGIN_MANIFEST.contributes.voiceProviders.map((contribution) => ({
      id: contribution.id,
      purpose: contribution.credentials?.slot.purpose,
      rawGrants: contribution.credentials?.sources[0]?.rawGrants,
    }))).toEqual([
      {
        id: 'gemini-stt',
        purpose: 'voice.speech.transcribe',
        rawGrants: [{
          realm: 'daemon',
          phase: 'speech',
          request: {
            kind: 'httpHeaders',
            origin: 'https://generativelanguage.googleapis.com',
            headerNames: ['x-goog-api-key'],
          },
        }],
      },
      {
        id: 'google-cloud-tts',
        purpose: 'voice.speech.synthesize',
        rawGrants: [{
          realm: 'daemon',
          phase: 'speech',
          request: {
            kind: 'httpHeaders',
            origin: 'https://texttospeech.googleapis.com',
            headerNames: ['x-goog-api-key'],
          },
        }],
      },
    ]);
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('voiceSpeechEngines');
  });

  it('activates the public registration from the package root', () => {
    expect(PLUGIN_MANIFEST.entrypoints).toEqual({ daemon: './.happier-plugin/daemon.js' });
    expect(PLUGIN_MANIFEST.hostAccess).toEqual({ required: [], optional: [] });
  });

  it('does not advertise generic settings that the executable voice path cannot consume safely', () => {
    expect(PLUGIN_MANIFEST.contributes.settings).toBeUndefined();
    expect(PLUGIN_MANIFEST.contributes.voiceProviders).toHaveLength(2);
  });

  it('does not retain the private voice-agent declaration', () => {
    const serialized = JSON.stringify(PLUGIN_MANIFEST);
    expect(serialized).not.toContain('voice.agent.v1');
    expect(serialized).not.toContain('google_gemini');
    expect(serialized).not.toContain('google_cloud');
    expect(serialized).not.toContain('speechProviderIds');
    expect(serialized).not.toContain('catalogProviders');
    expect(serialized).not.toContain('speechTarget');
    expect(serialized).not.toContain('schemas');
  });

  /**
   * Gemini STT and Cloud TTS are separately selectable providers, so one shared
   * "audio and text" disclosure told an STT-only user that reply text is transmitted
   * and a TTS-only user that microphone audio is. Each declaration therefore owns a
   * role-specific key, and this plugin — not a host locale file — owns the copy behind
   * both keys in every locale the plugin ships.
   */
  it('owns role-specific Google speech processing disclosures in its UI locale contributions', () => {
    const sttKey = 'settingsVoice.realtimeProviders.google.sttPrivacyDisclosure';
    const ttsKey = 'settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure';
    expect(GOOGLE_GEMINI_STT_VOICE_PROVIDER_DECLARATION.settings.privacyDisclosure.key).toBe(sttKey);
    expect(GOOGLE_CLOUD_TTS_VOICE_PROVIDER_DECLARATION.settings.privacyDisclosure.key).toBe(ttsKey);

    const missing = PLUGIN_MANIFEST.contributes.ui.translations.flatMap((translation) => {
      const stt = translation.messages[sttKey];
      const tts = translation.messages[ttsKey];
      if (typeof stt !== 'string' || stt.trim().length === 0) return [`${translation.locale}: ${sttKey}`];
      if (typeof tts !== 'string' || tts.trim().length === 0) return [`${translation.locale}: ${ttsKey}`];
      // A re-merged combined disclosure would make the two roles indistinguishable.
      return stt === tts ? [`${translation.locale}: shared combined disclosure`] : [];
    });
    expect(missing).toEqual([]);

    const english = PLUGIN_MANIFEST.contributes.ui.translations.find(
      (translation) => translation.locale === 'en',
    );
    const stt = english?.messages[sttKey];
    const tts = english?.messages[ttsKey];
    // Transcription copy must not promise speech synthesis...
    expect(stt).toMatch(/Google Gemini/iu);
    expect(stt).toMatch(/transcription/iu);
    expect(stt).not.toMatch(/Text-to-Speech/iu);
    // ...and speech copy must not claim microphone audio is transmitted.
    expect(tts).toMatch(/Google Cloud Text-to-Speech/iu);
    expect(tts).not.toMatch(/audio/iu);
    for (const value of [stt, tts]) {
      expect(value).toMatch(/selected execution machine/iu);
      expect(value).toMatch(/may retain/iu);
    }
  });
});
