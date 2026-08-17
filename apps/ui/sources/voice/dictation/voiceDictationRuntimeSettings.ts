import {
  voiceSettingsParse,
  writeLocalConversationVoiceSettings,
  writeLocalDirectVoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import {
  resolveLocalVoiceAdapterSettings,
} from '@/voice/local/localVoiceSettings';
import {
  resolveVoiceSttCapturePlan,
  type VoiceSttCapturePlan,
} from '@/voice/runtime/input/resolveVoiceSttCapturePlan';

/**
 * Builds the per-attempt settings snapshot consumed by the existing canonical
 * capture and recorded-audio STT owners. This does not mutate account settings
 * or make Dictation a second speech runtime.
 */
export function createVoiceDictationRuntimeSettingsSnapshot(settings: any): any {
  const voice = voiceSettingsParse(settings?.voice);
  const dictation = voice.dictation;
  const local = resolveLocalVoiceAdapterSettings({ voice });
  const selectedStt = dictation.sttBinding === 'same_as_local'
    ? local.config.stt
    : dictation.stt;
  const runtimeConfig = {
    ...local.config,
    stt: selectedStt,
  };
  const runtimeVoice = local.adapterId === 'local_direct'
    ? writeLocalDirectVoiceSettings(
        { ...voice, providerId: 'local_direct' },
        runtimeConfig,
      )
    : writeLocalConversationVoiceSettings(
        { ...voice, providerId: 'local_conversation' },
        runtimeConfig,
      );

  return {
    ...(settings && typeof settings === 'object' ? settings : {}),
    voice: {
      ...runtimeVoice,
      // `null` means provider/device default. Dictation never silently reads
      // the conversational Voice language.
      assistantLanguage: dictation.language,
    },
  };
}

export function resolveVoiceDictationSttCapturePlan(settings: any): Readonly<{
  plan: VoiceSttCapturePlan;
  runtimeSettings: any;
}> {
  const runtimeSettings = createVoiceDictationRuntimeSettingsSnapshot(settings);
  const plan = resolveVoiceSttCapturePlan(runtimeSettings);
  return {
    // Dictation is one bounded utterance. Daemon local-neural execution uses
    // the retained single-shot upload/transcribe path after local recording;
    // the binary live-speech tunnel belongs to continuous conversation
    // capture and is not a prerequisite for Dictation.
    plan: plan.provider === 'local_neural' && plan.localNeuralExecution === 'daemon'
      ? { provider: 'recorded_audio' }
      : plan,
    runtimeSettings,
  };
}
