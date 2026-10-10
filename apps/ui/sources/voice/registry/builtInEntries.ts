import type { VoiceUiRuntimeContribution } from './providerRegistry';
import { readBuiltInVoiceSettingsRegistryEntry } from '@happier-dev/protocol/voice/settings/builtInRegistry';

export const BUILT_IN_VOICE_UI_ENTRIES: readonly VoiceUiRuntimeContribution[] = Object.freeze([
  Object.freeze({
    pluginId: 'happier.voice.builtin',
    ...readBuiltInVoiceSettingsRegistryEntry('local_conversation'),
    settingsSectionId: 'voice.provider.local_conversation',
    presentation: { providerId: 'local_conversation', settingsSectionId: 'voice.provider.local_conversation' },
    mark: { kind: 'icon', name: 'desktop' },
  } satisfies VoiceUiRuntimeContribution),
  /**
   * `local_direct` is deliberately selection-less: it declares no
   * `selectionOptions`, so `projectVoiceProviderSelectionRows` emits no picker
   * row for it and `selectVoiceProviderOption` refuses every option id. That
   * matches the released contract — every released picker offered exactly one
   * "Local" row and wrote `local_conversation`; no picker in this repository's
   * history ever wrote `providerId: 'local_direct'`. The entry stays registered
   * because the released `voiceSettings` parse enum still accepts the id and
   * the released `voice.adapters.local_direct` block is the source the
   * credential/config compatibility migration reads.
   *
   * Current ceiling: nothing can select this provider, so its adapter,
   * `LocalDirectSection`, and QA branch are reachable only for a settings
   * document that already names it. Removal condition: retire this entry, its
   * adapter, and its panel once the released-data migration canonicalizes
   * `providerId: 'local_direct'` away and no supported released `voiceSettings`
   * shape can still carry it. Adding `selectionOptions` here instead would
   * introduce a second "Local" picker row that no released client ever had.
   */
  Object.freeze({
    pluginId: 'happier.voice.builtin',
    ...readBuiltInVoiceSettingsRegistryEntry('local_direct'),
    settingsSectionId: 'voice.provider.local_direct',
  } satisfies VoiceUiRuntimeContribution),
  Object.freeze({
    pluginId: 'happier.voice.builtin',
    ...readBuiltInVoiceSettingsRegistryEntry('device'),
    role: 'both',
    settingsSectionId: 'voice.speech.device',
    localReadiness: { kind: 'device_speech' },
    processingDisclosures: {
      stt: {
        titleKey: 'settingsVoice.local.deviceStt',
        disclosureKey: 'settingsVoice.realtimeProviders.speechProcessing.deviceStt',
        facts: {
          audioDestination: { key: 'settingsVoice.pages.privacy.deviceAudio', fallback: 'Your device’s speech service' },
          processor: { key: 'settingsVoice.pages.privacy.deviceProcessor', fallback: 'Your device or its speech service' },
          retention: { key: 'settingsVoice.pages.privacy.devicePolicy', fallback: 'Follows your device’s speech settings and terms.' },
        },
      },
      tts: {
        titleKey: 'settingsVoice.local.deviceTts',
        disclosureKey: 'settingsVoice.realtimeProviders.speechProcessing.deviceTts',
        facts: {
          audioDestination: { key: 'settingsVoice.pages.privacy.noMicrophoneAudio', fallback: 'No microphone audio; reply text only.' },
          processor: { key: 'settingsVoice.pages.privacy.deviceProcessor', fallback: 'Your device or its speech service' },
          retention: { key: 'settingsVoice.pages.privacy.devicePolicy', fallback: 'Follows your device’s speech settings and terms.' },
        },
      },
    },
  } satisfies VoiceUiRuntimeContribution),
  Object.freeze({
    pluginId: 'happier.voice.builtin',
    ...readBuiltInVoiceSettingsRegistryEntry('local_neural'),
    role: 'both',
    settingsSectionId: 'voice.speech.local_neural',
    processingDisclosures: {
      stt: {
        titleKey: 'settingsVoice.local.localNeuralStt.title',
        disclosureKey: 'settingsVoice.pages.privacy.localDisclosure',
        facts: {
          audioDestination: { key: 'settingsVoice.pages.privacy.localAudio', fallback: 'Your device or Voice computer' },
          processor: { key: 'settingsVoice.pages.privacy.localProcessor', fallback: 'Your selected speech model' },
          retention: { key: 'settingsVoice.pages.privacy.localRetention', fallback: 'Managed by your device/runtime. Diagnostics follow your recording settings.' },
        },
      },
      tts: {
        titleKey: 'settingsVoice.local.localNeuralTts.title',
        disclosureKey: 'settingsVoice.pages.privacy.localDisclosure',
        facts: {
          audioDestination: { key: 'settingsVoice.pages.privacy.noMicrophoneAudio', fallback: 'No microphone audio; reply text only.' },
          processor: { key: 'settingsVoice.pages.privacy.localProcessor', fallback: 'Your selected speech model' },
          retention: { key: 'settingsVoice.pages.privacy.localRetention', fallback: 'Managed by your device/runtime. Diagnostics follow your recording settings.' },
        },
      },
    },
  } satisfies VoiceUiRuntimeContribution),
  Object.freeze({
    pluginId: 'happier.voice.builtin',
    ...readBuiltInVoiceSettingsRegistryEntry('host_turn_detection'),
    settingsSectionId: 'voice.turnDetection',
  } satisfies VoiceUiRuntimeContribution),
]);
