import {
  buildElevenLabsConversationAuthAudience,
  DEFAULT_ELEVENLABS_VOICE_ID,
  ElevenLabsProvisionRequestSchema,
  ElevenLabsProvisionResponseSchema,
  ElevenLabsVoiceProviderSettingsLegacySchema,
  ElevenLabsVoiceProviderSettingsSchema,
  type ElevenLabsVoiceUiEntry,
} from '../../protocol/voice/index.js';
import { createElevenLabsVoiceUiClient } from './client.js';
import { createElevenLabsSettingsSection } from './settings.js';
import { createElevenLabsAutoprovision } from './autoprovision.js';
import { createElevenLabsRuntimeContribution } from './runtime/createRuntimeContribution.js';

type ElevenLabsVoiceUiRuntimeEntry = ElevenLabsVoiceUiEntry & Readonly<{
  projectSettings: (envelope: Readonly<{ schemaVersion: number; config: unknown }> | null) => Readonly<{
    status: 'ready' | 'needs_migration' | 'invalid' | 'unsupported_version';
    modeId: 'happier' | 'byo' | null;
  }>;
  internal: Readonly<{
    settingsSchema: typeof ElevenLabsVoiceProviderSettingsSchema;
    legacySettingsSchema: typeof ElevenLabsVoiceProviderSettingsLegacySchema;
    defaultVoiceId: typeof DEFAULT_ELEVENLABS_VOICE_ID;
    buildConversationAuthAudience: typeof buildElevenLabsConversationAuthAudience;
    provisionRequestSchema: typeof ElevenLabsProvisionRequestSchema;
    provisionResponseSchema: typeof ElevenLabsProvisionResponseSchema;
    providerSettings: Readonly<{
      schemaVersion: 2;
      defaultConfig: ReturnType<typeof ElevenLabsVoiceProviderSettingsSchema.parse>;
      defaultLegacyConfig: ReturnType<typeof ElevenLabsVoiceProviderSettingsLegacySchema.parse>;
      legacyDefaultSelection: true;
      parseConfig: (value: unknown) => ReturnType<typeof ElevenLabsVoiceProviderSettingsSchema.parse> | null;
      readLegacySecret: (value: unknown) => unknown | null;
      preserveLegacyEnvelope: (value: unknown) => Readonly<{ schemaVersion: 1; config: unknown }> | null;
      migrateLegacy: (value: unknown) => Readonly<{
        config: ReturnType<typeof ElevenLabsVoiceProviderSettingsSchema.parse>;
        root: Readonly<{
          assistantLanguage: string | null;
          welcome: ReturnType<typeof ElevenLabsVoiceProviderSettingsLegacySchema.parse>['welcome'];
        }>;
      }> | null;
      projectAnalytics: (value: unknown) => Readonly<Record<string, boolean | string>>;
    }>;
    createSettingsSection: typeof createElevenLabsSettingsSection;
    createDaemonClient: typeof createElevenLabsVoiceUiClient;
    createAutoprovision: typeof createElevenLabsAutoprovision;
    createAdapter: typeof createElevenLabsRuntimeContribution;
  }>;
}>;

function projectSettings(
  envelope: Readonly<{ schemaVersion: number; config: unknown }> | null,
): ReturnType<ElevenLabsVoiceUiRuntimeEntry['projectSettings']> {
  if (!envelope || envelope.schemaVersion < 2) return { status: 'needs_migration', modeId: null };
  if (envelope.schemaVersion > 2) return { status: 'unsupported_version', modeId: null };
  const parsed = ElevenLabsVoiceProviderSettingsSchema.safeParse(envelope.config);
  return parsed.success
    ? { status: 'ready', modeId: parsed.data.billingMode }
    : { status: 'invalid', modeId: null };
}

const defaultProviderConfig = ElevenLabsVoiceProviderSettingsSchema.parse({});
const defaultLegacyConfig = ElevenLabsVoiceProviderSettingsLegacySchema.parse({});
const providerSettings = Object.freeze({
  schemaVersion: 2 as const,
  defaultConfig: defaultProviderConfig,
  defaultLegacyConfig,
  legacyDefaultSelection: true as const,
  parseConfig(value: unknown) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(record, 'assistantLanguage')
        || Object.prototype.hasOwnProperty.call(record, 'welcome')) return null;
    }
    const parsed = ElevenLabsVoiceProviderSettingsSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  readLegacySecret(value: unknown) {
    const parsed = ElevenLabsVoiceProviderSettingsLegacySchema.safeParse(value);
    return parsed.success ? parsed.data.byo.apiKey : null;
  },
  preserveLegacyEnvelope(value: unknown) {
    const parsed = ElevenLabsVoiceProviderSettingsLegacySchema.safeParse(value);
    if (!parsed.success || parsed.data.byo.apiKey == null) return null;
    // This v1 envelope is a retryable migration source, not canonical state.
    // Preserve every legacy-owned value until credential import succeeds; the
    // canonical v2 writer atomically removes both the secret and retired roots.
    return Object.freeze({ schemaVersion: 1 as const, config: parsed.data });
  },
  migrateLegacy(value: unknown) {
    const parsed = ElevenLabsVoiceProviderSettingsLegacySchema.safeParse(value);
    if (!parsed.success) return null;
    const { assistantLanguage, welcome, byo, ...rest } = parsed.data;
    const config = {
      ...rest,
      byo: { agentId: byo.agentId },
    };
    return Object.freeze({
      config,
      root: Object.freeze({ assistantLanguage, welcome }),
    });
  },
  projectAnalytics(value: unknown) {
    const parsed = ElevenLabsVoiceProviderSettingsSchema.safeParse(value);
    if (!parsed.success) return Object.freeze({});
    const config = parsed.data;
    const bucketUnitInterval = (candidate: number | null) => candidate == null
      ? 'default'
      : candidate < 0.33 ? 'low' : candidate < 0.67 ? 'medium' : 'high';
    const speed = config.tts.voiceSettings.speed;
    return Object.freeze({
      realtimeElevenLabsBillingMode: config.billingMode,
      realtimeElevenLabsTtsVoiceIdKind: config.tts.voiceId === DEFAULT_ELEVENLABS_VOICE_ID ? 'default' : 'custom',
      realtimeElevenLabsTtsModelIdKind: config.tts.modelId ? 'custom' : 'default',
      realtimeElevenLabsTtsStabilityBucket: bucketUnitInterval(config.tts.voiceSettings.stability),
      realtimeElevenLabsTtsSimilarityBoostBucket: bucketUnitInterval(config.tts.voiceSettings.similarityBoost),
      realtimeElevenLabsTtsStyleBucket: bucketUnitInterval(config.tts.voiceSettings.style),
      realtimeElevenLabsTtsUseSpeakerBoostState: config.tts.voiceSettings.useSpeakerBoost == null
        ? 'default'
        : config.tts.voiceSettings.useSpeakerBoost ? 'enabled' : 'disabled',
      realtimeElevenLabsTtsSpeedBucket: speed == null ? 'default' : speed < 0.9 ? 'slow' : speed <= 1.2 ? 'normal' : 'fast',
      realtimeElevenLabsByoAgentConfigured: Boolean(config.byo.agentId),
    });
  },
});

export const BUNDLED_VOICE_UI_ENTRIES: readonly ElevenLabsVoiceUiRuntimeEntry[] = Object.freeze([
  Object.freeze({
    kind: 'voice.conversation-provider.v1',
    pluginId: 'happier.voice.elevenlabs',
    providerId: 'realtime_elevenlabs',
    settingsSectionId: 'voice.provider.realtime_elevenlabs',
    roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
    requirements: [],
    requirementsByMode: {
      happier: ['server_feature'],
      byo: ['execution_machine', 'credential'],
    },
    supportedPlatforms: ['web', 'ios', 'android'],
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
    projectSettings,
    internal: Object.freeze({
      settingsSchema: ElevenLabsVoiceProviderSettingsSchema,
      legacySettingsSchema: ElevenLabsVoiceProviderSettingsLegacySchema,
      defaultVoiceId: DEFAULT_ELEVENLABS_VOICE_ID,
      buildConversationAuthAudience: buildElevenLabsConversationAuthAudience,
      provisionRequestSchema: ElevenLabsProvisionRequestSchema,
      provisionResponseSchema: ElevenLabsProvisionResponseSchema,
      providerSettings,
      createSettingsSection: createElevenLabsSettingsSection,
      createDaemonClient: createElevenLabsVoiceUiClient,
      createAutoprovision: createElevenLabsAutoprovision,
      createAdapter: createElevenLabsRuntimeContribution,
    }),
  } satisfies ElevenLabsVoiceUiRuntimeEntry),
]);
