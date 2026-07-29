import {
  buildElevenLabsConversationAuthAudience,
  DEFAULT_ELEVENLABS_VOICE_ID,
  ElevenLabsAgentIdSchema,
  ElevenLabsModelIdSchema,
  ElevenLabsProvisionRequestSchema,
  ElevenLabsProvisionResponseSchema,
  ElevenLabsVoiceIdSchema,
  ElevenLabsVoiceProviderSettingsLegacySchema,
  ElevenLabsVoiceProviderSettingsSchema,
  type ElevenLabsVoiceUiEntry,
} from '../../protocol/voice/index.js';
import type {
  BundledVoiceConversationUiEntry,
  BundledVoiceUiEntry,
} from '@happier-dev/bundled-voice-runtime-contract';
import {
  PluginVoiceProviderContributionV1Schema,
  type PluginVoiceProviderContributionV1,
} from '@happier-dev/protocol';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { createElevenLabsSettingsSection } from './settings.js';
import {
  activate,
  createElevenLabsVoiceProviderRuntimeRegistration,
} from './runtime/createRuntimeContribution.js';
import { createElevenLabsEventMapper } from './runtime/elevenLabsEventMapper.js';

export { createElevenLabsProviderDiagnosticEvent } from './runtime/elevenLabsDiagnostics.js';

type ElevenLabsVoiceUiRuntimeEntry = ElevenLabsVoiceUiEntry
  & Omit<BundledVoiceConversationUiEntry, 'internal'>
  & Readonly<{
  internal: Readonly<{
    legacySettingsSchema: typeof ElevenLabsVoiceProviderSettingsLegacySchema;
    buildConversationAuthAudience: typeof buildElevenLabsConversationAuthAudience;
    provisionRequestSchema: typeof ElevenLabsProvisionRequestSchema;
    provisionResponseSchema: typeof ElevenLabsProvisionResponseSchema;
    legacySettingsMigration: Readonly<{
      defaultLegacyConfig: ReturnType<typeof ElevenLabsVoiceProviderSettingsLegacySchema.parse>;
      legacyDefaultSelection: true;
      readLegacySecret: (value: unknown) => unknown | null;
      preserveLegacyEnvelope: (value: unknown) => Readonly<{ schemaVersion: 1; config: unknown }> | null;
      migrateLegacy: (value: unknown) => Readonly<{
        config: ReturnType<typeof ElevenLabsVoiceProviderSettingsSchema.parse>;
        root: Readonly<{
          assistantLanguage: string | null;
          welcome: ReturnType<typeof ElevenLabsVoiceProviderSettingsLegacySchema.parse>['welcome'];
        }>;
      }> | null;
      projectLegacy: (
        value: unknown,
        context: Readonly<{
          root: Readonly<{
            assistantLanguage?: string | null;
            welcome?: ReturnType<typeof ElevenLabsVoiceProviderSettingsLegacySchema.parse>['welcome'];
          }>;
          resolveCredential: (providerId: string, slotId: string) => unknown | null;
        }>,
      ) => ReturnType<typeof ElevenLabsVoiceProviderSettingsLegacySchema.parse> | null;
      mergeLegacy: (
        currentValue: unknown,
        migratedValue: unknown,
      ) => ReturnType<typeof ElevenLabsVoiceProviderSettingsSchema.parse> | null;
    }>;
    projectSettingsAnalytics: (value: unknown) => Readonly<Record<string, boolean | string>>;
    createSettingsSection: typeof createElevenLabsSettingsSection;
    createTranscriptEventMapper: typeof createElevenLabsEventMapper;
    projectCredentialReadiness: typeof projectElevenLabsCredentialReadiness;
    resolveSurfaceCapabilities: NonNullable<
      BundledVoiceConversationUiEntry['internal']['resolveSurfaceCapabilities']
    >;
  }>;
  }>;

const defaultLegacyConfig = ElevenLabsVoiceProviderSettingsLegacySchema.parse({});
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
    // This v1 envelope is a retryable migration source, not canonical state.
    // Preserve every legacy-owned value until credential import succeeds; the
    // canonical v2 writer atomically removes both the secret and retired roots.
    return Object.freeze({ schemaVersion: 1 as const, config: parsed.data });
  },
  migrateLegacy(value: unknown) {
    const parsed = ElevenLabsVoiceProviderSettingsLegacySchema.safeParse(value);
    if (!parsed.success) return null;
    const { assistantLanguage, welcome, byo, ...rest } = parsed.data;
    const legacySpeed = rest.tts.voiceSettings.speed;
    const legacyAgentId = byo.agentId === null ? null : ElevenLabsAgentIdSchema.safeParse(byo.agentId);
    const legacyVoiceId = ElevenLabsVoiceIdSchema.safeParse(rest.tts.voiceId);
    const legacyModelId = rest.tts.modelId === null ? null : ElevenLabsModelIdSchema.safeParse(rest.tts.modelId);
    const config = ElevenLabsVoiceProviderSettingsSchema.safeParse({
      mode: 'default',
      ...rest,
      tts: {
        ...rest.tts,
        voiceId: legacyVoiceId.success ? legacyVoiceId.data : DEFAULT_ELEVENLABS_VOICE_ID,
        modelId: legacyModelId === null ? null : legacyModelId.success ? legacyModelId.data : null,
        voiceSettings: {
          ...rest.tts.voiceSettings,
          speed: legacySpeed !== null && (legacySpeed < 0.7 || legacySpeed > 1.2)
            ? null
            : legacySpeed,
        },
      },
      byo: { agentId: legacyAgentId === null ? null : legacyAgentId.success ? legacyAgentId.data : null },
    });
    if (!config.success) return null;
    return Object.freeze({
      config: config.data,
      root: Object.freeze({ assistantLanguage, welcome }),
    });
  },
  projectLegacy(value: unknown, context: Readonly<{
    root: Readonly<{
      assistantLanguage?: string | null;
      welcome?: ReturnType<typeof ElevenLabsVoiceProviderSettingsLegacySchema.parse>['welcome'];
    }>;
    resolveCredential: (providerId: string, slotId: string) => unknown | null;
  }>) {
    const parsed = ElevenLabsVoiceProviderSettingsSchema.safeParse(value);
    if (!parsed.success) return null;
    const credential = context.resolveCredential('realtime_elevenlabs', 'api_key');
    const legacy = ElevenLabsVoiceProviderSettingsLegacySchema.safeParse({
      ...parsed.data,
      assistantLanguage: context.root.assistantLanguage ?? null,
      welcome: context.root.welcome ?? {
        enabled: false,
        mode: 'immediate',
        templateId: null,
      },
      byo: {
        ...parsed.data.byo,
        apiKey: credential,
      },
    });
    return legacy.success ? legacy.data : null;
  },
  mergeLegacy(_currentValue: unknown, migratedValue: unknown) {
    const parsed = ElevenLabsVoiceProviderSettingsSchema.safeParse(migratedValue);
    return parsed.success ? parsed.data : null;
  },
});

function projectElevenLabsCredentialReadiness(
  providerConfig: unknown,
  context: Readonly<{
    accountProfile: unknown;
    savedSecret: Readonly<{ status: 'ready' | 'missing' }>;
  }>,
) {
  const parsed = ElevenLabsVoiceProviderSettingsSchema.safeParse(providerConfig);
  if (!parsed.success || parsed.data.billingMode !== 'byo') {
    return Object.freeze({
      status: 'unknown' as const,
      detailKey: 'settingsVoice.mode.happierSubtitle',
    });
  }
  return Object.freeze({
    status: context.savedSecret.status,
    detailKey: context.savedSecret.status === 'ready'
      ? 'settingsVoice.externalCredentials.ready'
      : 'settingsVoice.externalCredentials.missing',
  });
}

function projectSettingsAnalytics(value: unknown): Readonly<Record<string, boolean | string>> {
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
}

const parsedElevenLabsVoiceProviderDeclaration = PluginVoiceProviderContributionV1Schema.parse(
  PLUGIN_MANIFEST.contributes.voiceProviders[0],
);
if (parsedElevenLabsVoiceProviderDeclaration.kind !== 'conversation') {
  throw new Error('elevenlabs_voice_provider_must_be_conversation');
}
const elevenLabsVoiceProviderDeclaration: Extract<
  PluginVoiceProviderContributionV1,
  Readonly<{ kind: 'conversation' }>
> = parsedElevenLabsVoiceProviderDeclaration;

export const BUNDLED_VOICE_UI_ENTRIES: readonly ElevenLabsVoiceUiRuntimeEntry[] = Object.freeze([
  Object.freeze({
    kind: 'voice.conversation-provider.v1',
    pluginId: 'happier.voice.elevenlabs',
    providerId: 'realtime_elevenlabs',
    declaration: elevenLabsVoiceProviderDeclaration,
    settingsSectionId: 'voice.provider.realtime_elevenlabs',
    roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
    requirements: [],
    requirementsByMode: {
      happier: ['server_feature'],
      byo: ['credential'],
    },
    supportedPlatforms: PLUGIN_MANIFEST.contributes.voiceProviders[0].platforms,
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
    internal: Object.freeze({
      legacySettingsSchema: ElevenLabsVoiceProviderSettingsLegacySchema,
      buildConversationAuthAudience: buildElevenLabsConversationAuthAudience,
      provisionRequestSchema: ElevenLabsProvisionRequestSchema,
      provisionResponseSchema: ElevenLabsProvisionResponseSchema,
      legacySettingsMigration,
      projectSettingsAnalytics,
      createSettingsSection: createElevenLabsSettingsSection,
      createTranscriptEventMapper: createElevenLabsEventMapper,
      projectCredentialReadiness: projectElevenLabsCredentialReadiness,
      resolveSurfaceCapabilities(providerConfig: unknown) {
        if (!ElevenLabsVoiceProviderSettingsSchema.safeParse(providerConfig).success) return null;
        return Object.freeze({
          allowsGlobalStart: true,
          controlSessionScope: 'global' as const,
          requiresVoiceAgentFeature: false,
          bargeInEnabled: false,
          cancelResponse: 'unsupported' as const,
          interruptionPolicy: 'disabled' as const,
        });
      },
    }),
  } satisfies ElevenLabsVoiceUiRuntimeEntry),
]) satisfies readonly BundledVoiceUiEntry[];

export {
  activate,
  createElevenLabsVoiceProviderRuntimeRegistration,
};
