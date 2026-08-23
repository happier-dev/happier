import type { VoiceUiRuntimeContribution, VoiceProviderSettingsProjection } from './providerRegistry';
import { VoiceLocalConversationSchema } from '@/voice/adapters/localConversation/settings';
import { VoiceLocalDirectSchema } from '@/voice/adapters/localDirect/settings';

type SettingsSchema = Readonly<{ safeParse: (value: unknown) => Readonly<{ success: boolean }> }>;

function projectVersionOneSettings(
  envelope: Readonly<{ schemaVersion: number; config: unknown }> | null,
  schema: SettingsSchema,
): VoiceProviderSettingsProjection {
  if (!envelope) return { status: 'needs_migration', modeId: null };
  if (envelope.schemaVersion > 1) return { status: 'unsupported_version', modeId: null };
  if (envelope.schemaVersion < 1) return { status: 'needs_migration', modeId: null };
  return schema.safeParse(envelope.config).success
    ? { status: 'ready', modeId: null }
    : { status: 'invalid', modeId: null };
}

export const BUILT_IN_VOICE_UI_ENTRIES: readonly VoiceUiRuntimeContribution[] = Object.freeze([
  Object.freeze({
    kind: 'voice.conversation-provider.v1',
    pluginId: 'happier.voice.builtin',
    providerId: 'local_conversation',
    settingsSectionId: 'voice.provider.local_conversation',
    roles: ['conversation_stt', 'conversation_tts', 'vad', 'endpointing'],
    requirements: ['server_feature', 'runtime', 'model', 'execution_machine', 'endpoint', 'credential'],
    selectionOptions: [{
      id: 'local',
      modeId: null,
      order: 30,
      titleKey: 'settingsVoice.mode.local',
      subtitleKey: 'settingsVoice.mode.localSubtitle',
    }],
    projectSettings: (envelope: Readonly<{ schemaVersion: number; config: unknown }> | null) =>
      projectVersionOneSettings(envelope, VoiceLocalConversationSchema),
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
    kind: 'voice.conversation-provider.v1',
    pluginId: 'happier.voice.builtin',
    providerId: 'local_direct',
    settingsSectionId: 'voice.provider.local_direct',
    roles: ['conversation_stt', 'conversation_tts', 'vad', 'endpointing'],
    requirements: ['execution_machine'],
    projectSettings: (envelope: Readonly<{ schemaVersion: number; config: unknown }> | null) =>
      projectVersionOneSettings(envelope, VoiceLocalDirectSchema),
  } satisfies VoiceUiRuntimeContribution),
  Object.freeze({
    kind: 'voice.speech-engine.v1',
    pluginId: 'happier.voice.builtin',
    providerId: 'device',
    role: 'both',
    settingsSectionId: 'voice.speech.device',
    roles: ['dictation_stt', 'conversation_stt', 'conversation_tts'],
    requirements: [],
    localReadiness: { kind: 'device_speech' },
    processingDisclosures: {
      stt: {
        titleKey: 'settingsVoice.local.deviceStt',
        disclosureKey: 'settingsVoice.realtimeProviders.speechProcessing.deviceStt',
      },
      tts: {
        titleKey: 'settingsVoice.local.deviceTts',
        disclosureKey: 'settingsVoice.realtimeProviders.speechProcessing.deviceTts',
      },
    },
  } satisfies VoiceUiRuntimeContribution),
  Object.freeze({
    kind: 'voice.speech-engine.v1',
    pluginId: 'happier.voice.builtin',
    providerId: 'local_neural',
    role: 'both',
    settingsSectionId: 'voice.speech.local_neural',
    roles: ['dictation_stt', 'conversation_stt', 'conversation_tts'],
    requirements: ['runtime', 'model'],
  } satisfies VoiceUiRuntimeContribution),
  Object.freeze({
    kind: 'voice.turn-support.v1',
    pluginId: 'happier.voice.builtin',
    providerId: 'host_turn_detection',
    settingsSectionId: 'voice.turnDetection',
    roles: ['vad', 'endpointing'],
    requirements: ['runtime'],
  } satisfies VoiceUiRuntimeContribution),
]);
