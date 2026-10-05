import { describe, expect, it } from 'vitest';

import {
  readLocalConversationVoiceSettings,
  readLocalDirectVoiceSettings,
  voiceSettingsParse,
  writeLocalConversationVoiceSettings,
  writeLocalDirectVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';

import { projectConversationLanguage, projectConversationLanguagePreference } from './conversationLanguage';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { projectBundledVoiceManifestContributions } from '@/voice/registry/bundledVoiceManifestProjection';
import { PLUGIN_MANIFEST as OPENAI_MANIFEST } from '../../../../../../packages/plugins/openai/src/manifest';
import { PLUGIN_MANIFEST as ELEVENLABS_MANIFEST } from '../../../../../../packages/plugins/elevenlabs/src/manifest';
import { VOICE_PROVIDER_PRESENTATIONS as OPENAI_PRESENTATIONS } from '../../../../../../packages/plugins/openai/src/ui/voice/entries';
import { VOICE_PROVIDER_PRESENTATIONS as ELEVENLABS_PRESENTATIONS } from '../../../../../../packages/plugins/elevenlabs/src/ui/voice/entries';

const sourceRegistry = createVoiceProviderRegistry({ bundledContributions: [
  ...projectBundledVoiceManifestContributions(OPENAI_MANIFEST),
  ...projectBundledVoiceManifestContributions(ELEVENLABS_MANIFEST),
], bundledPresentations: [...OPENAI_PRESENTATIONS, ...ELEVENLABS_PRESENTATIONS] });

function localDirect(stt: Record<string, unknown>, tts: Record<string, unknown> = {}, root: Partial<VoiceSettings> = {}) {
  const voice = voiceSettingsParse({ providerId: 'local_direct', ...root });
  const cfg = readLocalDirectVoiceSettings(voice);
  return writeLocalDirectVoiceSettings(voice, {
    ...cfg,
    stt: { ...cfg.stt, ...stt } as typeof cfg.stt,
    tts: { ...cfg.tts, ...tts } as typeof cfg.tts,
  });
}

describe('Conversations language: I speak / Reply in / Voice', () => {
  it('does not admit a present null service envelope as an absent default configuration', () => {
    const providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
    const descriptor = sourceRegistry.get(providerId)?.providerSettings;
    if (!descriptor) throw new Error('Missing actual service settings');
    expect(descriptor.parseConfig(descriptor.defaultConfig)).not.toBeNull();
    const voice = voiceSettingsParse({ providerId, providers: { [providerId]: { schemaVersion: descriptor.schemaVersion, config: null } } });
    expect(voice.providers[providerId]?.config).toBeNull();
    expect(projectConversationLanguagePreference(voice, sourceRegistry)).toEqual({ kind: 'unavailable' });
  });
  it('does not infer another adapter language or voice for an unavailable selected envelope', () => {
    const voice = voiceSettingsParse({
      providerId: 'local_direct', assistantLanguage: 'es',
      providers: {
        local_direct: { schemaVersion: 99, config: { future: true } },
        local_conversation: { schemaVersion: 1, config: {
          stt: { provider: 'local_neural', localNeural: { language: 'fr' } },
          tts: { provider: 'local_neural', localNeural: { voiceId: 'other-adapter-voice' } },
        } },
      },
    });
    expect(projectConversationLanguage(voice)).toEqual({ mode: 'unavailable' });
  });
  it('projects each admitted service language fact from its actual contribution', () => {
    expect(projectConversationLanguage(voiceSettingsParse({ providerId: 'happier.voice.elevenlabs/realtime-elevenlabs', assistantLanguage: 'fr' }), sourceRegistry))
      .toMatchObject({ mode: 'service', language: { kind: 'single_language' } });
    expect(projectConversationLanguage(voiceSettingsParse({ providerId: 'happier.voice.openai/realtime-openai', assistantLanguage: 'fr' }), sourceRegistry))
      .toMatchObject({ mode: 'service', language: { kind: 'automatic_recognition' } });
  });
  it('reads the recognition language from the speech model, not from the reply language', () => {
    const voice = localDirect(
      { provider: 'local_neural', localNeural: { ...readLocalDirectVoiceSettings(voiceSettingsParse({})).stt.localNeural, language: 'fr' } },
      {},
      { assistantLanguage: 'de' },
    );
    expect(projectConversationLanguage(voice)).toMatchObject({
      mode: 'local',
      recognition: { kind: 'explicit', language: 'fr' },
    });
  });

  it('shows the engine default when recognition has no explicit language, never the reply language', () => {
    const neural = localDirect({ provider: 'local_neural' }, {}, { assistantLanguage: 'de' });
    expect(projectConversationLanguage(neural)).toMatchObject({ recognition: { kind: 'engine_default' } });

    const device = localDirect({ provider: 'device' }, {}, { assistantLanguage: 'es' });
    expect(projectConversationLanguage(device)).toMatchObject({ recognition: { kind: 'engine_default' } });

    expect(projectConversationLanguage(localDirect({ provider: 'device' }))).toMatchObject({ recognition: { kind: 'engine_default' } });
  });

  it('reads the Voice agent route from its own owner and names the output voice of the Speak engine', () => {
    const base = voiceSettingsParse({ providerId: 'local_conversation' });
    const cfg = readLocalConversationVoiceSettings(base);
    const voice = writeLocalConversationVoiceSettings(base, {
      ...cfg,
      tts: { ...cfg.tts, provider: 'local_neural', localNeural: { ...cfg.tts.localNeural, voiceId: 'af_heart' } } as typeof cfg.tts,
    });
    expect(projectConversationLanguage(voice)).toMatchObject({
      mode: 'local',
      outputVoice: { kind: 'engine_voice', voiceId: 'af_heart' },
    });
    expect(projectConversationLanguage(localDirect({}, { provider: 'device' }))).toMatchObject({ outputVoice: { kind: 'device' } });
  });

  it('has nothing to set while conversations are off, and only the reply language for a realtime service', () => {
    expect(projectConversationLanguage(voiceSettingsParse({ providerId: null }))).toEqual({ mode: 'off' });
    expect(projectConversationLanguage(voiceSettingsParse({ providerId: 'happier.voice.elevenlabs/realtime-elevenlabs' })))
      .toMatchObject({ mode: 'service' });
  });
});
