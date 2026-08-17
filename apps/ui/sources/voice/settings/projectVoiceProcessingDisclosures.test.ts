import { describe, expect, it } from 'vitest';

import {
  readLocalConversationVoiceSettings,
  voiceSettingsDefaults,
  voiceSettingsParse,
  writeLocalConversationVoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { OPENAI_REALTIME_DEFAULT_SETTINGS } from '../../../../../packages/plugins/openai/src/protocol/voice/settings';
import { XAI_REALTIME_DEFAULT_SETTINGS } from '../../../../../packages/plugins/xai/src/protocol/voice/settings';
import { projectVoiceProcessingDisclosures } from './projectVoiceProcessingDisclosures';

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

  it('deduplicates Local Voice STT and TTS declarations that share one disclosure', () => {
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

    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]?.providerIds).toEqual([
      'happier.voice.google/gemini-stt',
      'happier.voice.google/google-cloud-tts',
    ]);
    expect(disclosures[0]?.disclosure).toEqual({
      key: 'settingsVoice.realtimeProviders.google.privacyDisclosure',
      fallback: 'settingsVoice.realtimeProviders.google.privacyDisclosure',
    });
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
        key: 'settingsVoice.realtimeProviders.speechProcessing.openAiCompat',
        fallback: 'settingsVoice.realtimeProviders.speechProcessing.openAiCompat',
      },
    })]);
    expect(openAiCompat.some((entry) => entry.roles.includes('tts'))).toBe(false);
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
