import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

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

  it('owns the Google speech processing disclosure in its UI locale contribution', () => {
    const english = PLUGIN_MANIFEST.contributes.ui.translations.find(
      (translation) => translation.locale === 'en',
    );
    const disclosure = english?.messages['settingsVoice.realtimeProviders.google.privacyDisclosure'];
    expect(disclosure).toMatch(/Google Gemini/iu);
    expect(disclosure).toMatch(/Google Cloud Text-to-Speech/iu);
    expect(disclosure).toMatch(/selected execution machine/iu);
    expect(disclosure).toMatch(/may retain/iu);
  });
});
