import {
  DEFAULT_ELEVENLABS_VOICE_ID,
  ElevenLabsAgentIdSchema,
  ElevenLabsModelIdSchema,
  ElevenLabsVoiceIdSchema,
  ElevenLabsVoiceProviderSettingsLegacySchema,
  ElevenLabsVoiceProviderSettingsSchema,
} from '../../protocol/voice/index.js';
import { createElevenLabsSettingsSection } from './settings.js';

// `ui-web-v0.2.0` through `ui-web-v0.2.2-preview.1775585938.1` persisted this
// fully materialized nested-adapter default. It is only the default-selection
// classifier; the current manifest-derived default remains Bella.
const RELEASED_LEGACY_ELEVENLABS_DEFAULT_VOICE_ID = 'EST9Ui6982FZPSi7gCHi';
const defaultLegacyConfig = ElevenLabsVoiceProviderSettingsLegacySchema.parse({
  tts: { voiceId: RELEASED_LEGACY_ELEVENLABS_DEFAULT_VOICE_ID },
});
const legacySettingsMigration = Object.freeze({
  defaultLegacyConfig,
  legacyDefaultSelection: true as const,
  readLegacySecret(value: unknown) {
    const parsed = ElevenLabsVoiceProviderSettingsLegacySchema.safeParse(value);
    return parsed.success ? parsed.data.byo.apiKey : null;
  },
  preserveLegacyEnvelope(value: unknown) {
    const parsed = ElevenLabsVoiceProviderSettingsLegacySchema.safeParse(value);
    if (!parsed.success || parsed.data.byo.apiKey == null) return null;
    return Object.freeze({ schemaVersion: 1 as const, config: parsed.data });
  },
  migrateLegacy(value: unknown) {
    const parsed = ElevenLabsVoiceProviderSettingsLegacySchema.safeParse(value);
    if (!parsed.success) return null;
    const { assistantLanguage, welcome, byo, ...rest } = parsed.data;
    const legacySpeed = rest.tts.voiceSettings.speed;
    const {
      style: _legacyStyle,
      useSpeakerBoost: _legacyUseSpeakerBoost,
      ...supportedVoiceSettings
    } = rest.tts.voiceSettings;
    const legacyAgentId = byo.agentId === null ? null : ElevenLabsAgentIdSchema.safeParse(byo.agentId);
    const legacyVoiceId = ElevenLabsVoiceIdSchema.safeParse(rest.tts.voiceId);
    const legacyModelId = rest.tts.modelId === null ? null : ElevenLabsModelIdSchema.safeParse(rest.tts.modelId);
    const config = ElevenLabsVoiceProviderSettingsSchema.safeParse({
      ...rest,
      tts: {
        ...rest.tts,
        voiceId: legacyVoiceId.success ? legacyVoiceId.data : DEFAULT_ELEVENLABS_VOICE_ID,
        modelId: legacyModelId === null ? null : legacyModelId.success ? legacyModelId.data : null,
        voiceSettings: {
          ...supportedVoiceSettings,
          speed: legacySpeed !== null && (legacySpeed < 0.7 || legacySpeed > 1.2)
            ? null
            : legacySpeed,
        },
      },
      agentId: legacyAgentId === null ? '' : legacyAgentId.success ? legacyAgentId.data : '',
    });
    if (!config.success) return null;
    return Object.freeze({
      config: config.data,
      root: Object.freeze({ assistantLanguage, welcome }),
    });
  },
  projectLegacy(value: unknown, context: Readonly<{
    root: unknown;
    resolveCredential: (providerId: string, slotId: string) => unknown | null;
  }>) {
    const parsed = ElevenLabsVoiceProviderSettingsSchema.safeParse(value);
    if (!parsed.success) return null;
    const root = context.root && typeof context.root === 'object' && !Array.isArray(context.root)
      ? context.root as Readonly<Record<string, unknown>>
      : {};
    const credential = context.resolveCredential('realtime_elevenlabs', 'api_key');
    const legacy = ElevenLabsVoiceProviderSettingsLegacySchema.safeParse({
      ...parsed.data,
      assistantLanguage: root.assistantLanguage ?? null,
      welcome: root.welcome ?? {
        enabled: false,
        mode: 'immediate',
        templateId: null,
      },
      byo: { agentId: parsed.data.agentId || null, apiKey: credential },
    });
    return legacy.success ? legacy.data : null;
  },
  mergeLegacy(_currentValue: unknown, migratedValue: unknown) {
    const parsed = ElevenLabsVoiceProviderSettingsSchema.safeParse(migratedValue);
    return parsed.success ? parsed.data : null;
  },
});

export const VOICE_PROVIDER_PRESENTATIONS = Object.freeze([
  Object.freeze({
    providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
    settingsSectionId: 'voice.provider.realtime_elevenlabs',
    selectionOptions: [
      {
        id: 'happier',
        modeId: 'happier',
        order: 10,
        titleKey: 'settingsVoice.mode.happier',
        subtitleKey: 'settingsVoice.mode.happierSubtitle',
        configPatch: { billingMode: 'happier' },
      },
      {
        id: 'byo',
        modeId: 'byo',
        order: 20,
        titleKey: 'settingsVoice.mode.byo',
        subtitleKey: 'settingsVoice.mode.byoSubtitle',
        configPatch: { billingMode: 'byo' },
      },
    ],
    legacySettingsMigration,
    createSettingsSection: createElevenLabsSettingsSection,
  }),
]);
