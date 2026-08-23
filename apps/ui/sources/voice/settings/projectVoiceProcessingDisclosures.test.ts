import { describe, expect, it } from 'vitest';

import {
  readLocalConversationVoiceSettings,
  voiceSettingsDefaults,
  voiceSettingsParse,
  writeLocalConversationVoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { OPENAI_REALTIME_DEFAULT_SETTINGS } from '../../../../../packages/plugins/openai/src/protocol/voice/settings';
import { XAI_REALTIME_DEFAULT_SETTINGS } from '../../../../../packages/plugins/xai/src/protocol/voice/settings';
import { tLoose } from '@/text';
import { projectVoiceProcessingDisclosures } from './projectVoiceProcessingDisclosures';

/**
 * Resolves a projected disclosure exactly the way the Privacy view does, so the
 * assertions below read the copy a user actually sees rather than a key.
 */
function disclosureText(
  disclosure: string | Readonly<{ key: string; fallback: string }> | undefined,
): string {
  if (disclosure === undefined) return '';
  if (typeof disclosure === 'string') return disclosure;
  const translated = tLoose(disclosure.key);
  return translated === disclosure.key ? disclosure.fallback : translated;
}

describe('projectVoiceProcessingDisclosures', () => {
  it('projects the selected conversation and explicit Dictation providers from their registries', () => {
    const voice = voiceSettingsParse({
      ...voiceSettingsDefaults,
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'explicit',
        stt: {
          ...voiceSettingsDefaults.dictation.stt,
          provider: 'happier.voice.google/gemini-stt',
        },
      },
    });

    const disclosures = projectVoiceProcessingDisclosures(voice);

    expect(disclosures.map((entry) => entry.providerIds)).toEqual([
      ['happier.voice.elevenlabs/realtime-elevenlabs'],
      ['happier.voice.google/gemini-stt'],
    ]);
  });

  it.each([
    ['happier.voice.openai/realtime-openai', OPENAI_REALTIME_DEFAULT_SETTINGS],
    ['happier.voice.xai/realtime-grok', XAI_REALTIME_DEFAULT_SETTINGS],
  ] as const)('projects the complete selected %s processing boundary from the privacy owner', (providerId, config) => {
    const disclosures = projectVoiceProcessingDisclosures(voiceSettingsParse({
      providerId,
      providers: {
        [providerId]: { schemaVersion: 1, config },
      },
    }));

    const disclosure = disclosures.find((entry) => entry.providerIds.includes(providerId));
    const text = typeof disclosure?.disclosure === 'string'
      ? disclosure.disclosure
      : disclosure?.disclosure.fallback;
    expect(text).toMatch(/audio/iu);
    expect(text).toMatch(/context/iu);
    expect(text).toMatch(/client-tool definitions/iu);
    expect(text).toMatch(/delegated results/iu);
    expect(text).toMatch(/server and relay do not carry live audio/iu);
    expect(text).toMatch(/may retain/iu);
    expect(text).toMatch(/context-sharing controls are separate/iu);
  });

  it('merges one provider selected for the same role by Dictation and Local Voice', () => {
    const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = voiceSettingsParse({
      ...writeLocalConversationVoiceSettings(voiceSettingsDefaults, {
        ...local,
        stt: { ...local.stt, provider: 'happier.voice.google/gemini-stt' },
        tts: { ...local.tts, provider: 'happier.voice.google/google-cloud-tts' },
      }),
      providerId: 'local_conversation',
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'same_as_local',
      },
    });

    const disclosures = projectVoiceProcessingDisclosures(voice);

    // Gemini STT is selected twice (Dictation and Local Voice) but discloses once;
    // Google Cloud TTS is a distinct role and keeps its own disclosure.
    expect(disclosures.map((entry) => [entry.providerIds, entry.roles])).toEqual([
      [['happier.voice.google/gemini-stt'], ['stt']],
      [['happier.voice.google/google-cloud-tts'], ['tts']],
    ]);
  });

  it('tells an STT-only Google selection only that audio leaves for transcription', () => {
    const voice = voiceSettingsParse({
      ...voiceSettingsDefaults,
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'explicit',
        stt: {
          ...voiceSettingsDefaults.dictation.stt,
          provider: 'happier.voice.google/gemini-stt',
        },
      },
    });

    const google = projectVoiceProcessingDisclosures(voice)
      .filter((entry) => entry.providerIds.includes('happier.voice.google/gemini-stt'));

    expect(google.map((entry) => entry.roles)).toEqual([['stt']]);
    const text = disclosureText(google[0]?.disclosure);
    expect(text).toMatch(/transcription/iu);
    expect(text).toMatch(/audio/iu);
    // No speech synthesis happens for an STT-only selection, so the disclosure
    // must not claim reply text is transmitted to a synthesis service.
    expect(text).not.toMatch(/text-to-speech/iu);
    expect(text).not.toMatch(/text sent for speech/iu);
  });

  it('tells a TTS-only Google selection only that reply text leaves for speech', () => {
    const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = voiceSettingsParse({
      ...writeLocalConversationVoiceSettings(voiceSettingsDefaults, {
        ...local,
        stt: { ...local.stt, provider: 'device' },
        tts: { ...local.tts, provider: 'happier.voice.google/google-cloud-tts' },
      }),
      providerId: 'local_conversation',
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'same_as_local',
      },
    });

    const google = projectVoiceProcessingDisclosures(voice)
      .filter((entry) => entry.providerIds.includes('happier.voice.google/google-cloud-tts'));

    expect(google.map((entry) => entry.roles)).toEqual([['tts']]);
    const text = disclosureText(google[0]?.disclosure);
    expect(text).toMatch(/text-to-speech/iu);
    // No microphone audio reaches Google for a TTS-only selection.
    expect(text).not.toMatch(/audio/iu);
    expect(text).not.toMatch(/transcription/iu);
  });

  it('projects only the selected OpenAI-compatible Dictation STT role', () => {
    const voice = voiceSettingsParse({
      ...voiceSettingsDefaults,
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'explicit',
        stt: {
          ...voiceSettingsDefaults.dictation.stt,
          provider: 'happier.voice.openai-compat/stt',
        },
      },
    });

    const disclosures = projectVoiceProcessingDisclosures(voice);
    const openAiCompat = disclosures.filter((entry) => entry.providerIds.includes('happier.voice.openai-compat/stt'));

    expect(openAiCompat).toEqual([expect.objectContaining({
      roles: ['stt'],
      titleKey: 'settingsVoice.local.openaiCompatStt.provider.title',
      disclosure: {
        key: 'settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt',
        fallback: 'settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt',
      },
    })]);
    expect(openAiCompat.some((entry) => entry.roles.includes('tts'))).toBe(false);
    const text = disclosureText(openAiCompat[0]?.disclosure);
    expect(text).toMatch(/audio for transcription/iu);
    expect(text).not.toMatch(/speech synthesis/iu);
  });

  it('keeps selected device STT and TTS processing disclosures role-specific', () => {
    const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = voiceSettingsParse({
      ...writeLocalConversationVoiceSettings(voiceSettingsDefaults, {
        ...local,
        stt: { ...local.stt, provider: 'device' },
        tts: { ...local.tts, provider: 'device' },
      }),
      providerId: 'local_conversation',
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'same_as_local',
      },
    });

    const device = projectVoiceProcessingDisclosures(voice)
      .filter((entry) => entry.providerIds.includes('device'));

    expect(device).toEqual([
      expect.objectContaining({
        roles: ['stt'],
        titleKey: 'settingsVoice.local.deviceStt',
        disclosure: {
          key: 'settingsVoice.realtimeProviders.speechProcessing.deviceStt',
          fallback: 'settingsVoice.realtimeProviders.speechProcessing.deviceStt',
        },
      }),
      expect.objectContaining({
        roles: ['tts'],
        titleKey: 'settingsVoice.local.deviceTts',
        disclosure: {
          key: 'settingsVoice.realtimeProviders.speechProcessing.deviceTts',
          fallback: 'settingsVoice.realtimeProviders.speechProcessing.deviceTts',
        },
      }),
    ]);
  });
});
