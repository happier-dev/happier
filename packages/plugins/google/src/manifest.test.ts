import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('Google voice plugin manifest', () => {
  it('declares the public daemon speech facet consumed by the Voice host', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST.contributes.voiceProviders).toEqual([expect.objectContaining({
      id: 'speech',
      kind: 'speech',
      roles: ['dictation_stt', 'conversation_stt', 'conversation_tts'],
    })]);
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('voiceSpeechEngines');
  });

  it('activates the public registration from the package root', () => {
    expect(PLUGIN_MANIFEST.entrypoints).toEqual({ daemon: './dist/index.js' });
    expect(PLUGIN_MANIFEST.hostAccess).toEqual({ required: [], optional: [] });
  });

  it('does not advertise generic settings that the executable voice path cannot consume safely', () => {
    expect(PLUGIN_MANIFEST.contributes.settings).toBeUndefined();
    expect(PLUGIN_MANIFEST.contributes.voiceProviders).toHaveLength(1);
  });

  it('does not retain the private voice-agent declaration', () => {
    const serialized = JSON.stringify(PLUGIN_MANIFEST);
    expect(serialized).not.toContain('voice.agent.v1');
    expect(serialized).not.toContain('google_gemini');
    expect(serialized).not.toContain('google_cloud');
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
