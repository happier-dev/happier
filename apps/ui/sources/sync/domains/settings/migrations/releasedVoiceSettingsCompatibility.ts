import type { VoiceProviderSettingsJsonValueV1 } from '@happier-dev/protocol';
import {
  DEFAULT_ELEVENLABS_VOICE_ID,
  ElevenLabsAgentIdSchema,
  ElevenLabsModelIdSchema,
  ElevenLabsVoiceIdSchema,
  ElevenLabsVoiceProviderSettingsLegacySchema,
  ElevenLabsVoiceProviderSettingsSchema,
} from '@happier-dev/plugins-elevenlabs/protocol/voice';

import { VoiceLocalDirectSchema } from '@/voice/adapters/localDirect/settings';
import {
  normalizeLegacyLocalConversationInput,
  stripLegacyLocalConversationOwnership,
  VoiceLocalConversationSchema,
} from '@/voice/adapters/localConversation/settings';
import {
  projectPredecessorSpeechProviderConfig,
  projectPredecessorSpeechProviderSelection,
} from './speechProviders';

export type ReleasedVoiceLegacyRootMigration = Readonly<{
  assistantLanguage?: string | null;
  welcome?: Readonly<{ enabled: boolean; mode: 'immediate' | 'on_first_turn'; templateId: string | null }>;
  executionMachine?: Readonly<{ mode: 'auto' | 'fixed'; machineId: string | null; autoMachineId: string | null }>;
}>;

export type ReleasedVoiceLegacyProjectionContext = Readonly<{
  root: ReleasedVoiceLegacyRootMigration;
  resolveCredential: (providerId: string, slotId: string) => unknown | null;
  resolveProviderConfig: (providerId: string) => Readonly<Record<string, unknown>> | null;
}>;

export type ReleasedVoiceSettingsCompatibility = Readonly<{
  defaultLegacyConfig: VoiceProviderSettingsJsonValueV1;
  legacyDefaultSelection: boolean;
  readLegacySecret?: (config: unknown) => unknown | null;
  preserveLegacyEnvelope?: (config: unknown) => Readonly<{ schemaVersion: number; config: unknown }> | null;
  migrateLegacy: (config: unknown) => Readonly<{
    config: unknown;
    root: ReleasedVoiceLegacyRootMigration;
  }> | null;
  projectLegacy: (
    config: unknown,
    context: ReleasedVoiceLegacyProjectionContext,
  ) => VoiceProviderSettingsJsonValueV1 | null;
  mergeLegacy: (currentConfig: unknown, migratedConfig: unknown) => unknown | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function withoutKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = { ...(isRecord(value) ? value : {}) };
  for (const key of keys) delete result[key];
  return result;
}

function projectLegacyLocalSpeechSettings(
  config: unknown,
  resolveProviderConfig: ReleasedVoiceLegacyProjectionContext['resolveProviderConfig'],
): Record<string, VoiceProviderSettingsJsonValueV1> | null {
  const parsed = VoiceLocalDirectSchema.safeParse(config);
  if (!parsed.success) return null;
  const stt = parsed.data.stt;
  const tts = parsed.data.tts;
  const predecessorSttProvider = projectPredecessorSpeechProviderSelection('stt', stt.provider);
  const predecessorTtsProvider = projectPredecessorSpeechProviderSelection('tts', tts.provider);
  if (!predecessorSttProvider || !predecessorTtsProvider) return null;
  const googleGemini = projectPredecessorSpeechProviderConfig(
    'happier.voice.google/gemini-stt',
    resolveProviderConfig('happier.voice.google/gemini-stt'),
  ) ?? {};
  const googleCloud = projectPredecessorSpeechProviderConfig(
    'happier.voice.google/google-cloud-tts',
    resolveProviderConfig('happier.voice.google/google-cloud-tts'),
  ) ?? {};
  const openAiCompatStt = projectPredecessorSpeechProviderConfig(
    'happier.voice.openai-compat/stt',
    resolveProviderConfig('happier.voice.openai-compat/stt'),
  ) ?? {};
  const openAiCompatTts = projectPredecessorSpeechProviderConfig(
    'happier.voice.openai-compat/tts',
    resolveProviderConfig('happier.voice.openai-compat/tts'),
  ) ?? {};

  return {
    ...parsed.data,
    stt: {
      ...stt,
      provider: predecessorSttProvider,
      googleGemini: { ...googleGemini, apiKey: null },
      openaiCompat: { ...openAiCompatStt, apiKey: null },
      localNeural: withoutKeys(stt.localNeural, ['execution']),
    },
    tts: {
      ...tts,
      provider: predecessorTtsProvider,
      googleCloud: { ...googleCloud, apiKey: null },
      openaiCompat: { ...openAiCompatTts, apiKey: null },
      localNeural: withoutKeys(tts.localNeural, ['execution']),
    },
  } as Record<string, VoiceProviderSettingsJsonValueV1>;
}

function mergeLegacyLocalSpeechSettings(currentConfig: unknown, migratedConfig: unknown) {
  const current = VoiceLocalDirectSchema.safeParse(currentConfig);
  const migrated = VoiceLocalDirectSchema.safeParse(migratedConfig);
  if (!current.success || !migrated.success) return null;
  return VoiceLocalDirectSchema.parse({
    ...migrated.data,
    stt: {
      ...migrated.data.stt,
      localNeural: {
        ...migrated.data.stt.localNeural,
        execution: current.data.stt.localNeural.execution,
      },
    },
    tts: {
      ...migrated.data.tts,
      localNeural: {
        ...migrated.data.tts.localNeural,
        execution: current.data.tts.localNeural.execution,
      },
    },
  });
}

const localDirectCompatibility: ReleasedVoiceSettingsCompatibility = Object.freeze({
  defaultLegacyConfig: VoiceLocalDirectSchema.parse({}),
  legacyDefaultSelection: false,
  migrateLegacy(config) {
    const parsed = VoiceLocalDirectSchema.safeParse(config);
    return parsed.success ? Object.freeze({ config: parsed.data, root: Object.freeze({}) }) : null;
  },
  projectLegacy(config, context) {
    return projectLegacyLocalSpeechSettings(config, context.resolveProviderConfig);
  },
  mergeLegacy: mergeLegacyLocalSpeechSettings,
});

const localConversationCompatibility: ReleasedVoiceSettingsCompatibility = Object.freeze({
  defaultLegacyConfig: VoiceLocalConversationSchema.parse({}),
  legacyDefaultSelection: false,
  migrateLegacy(config) {
    const parsed = VoiceLocalConversationSchema.safeParse(normalizeLegacyLocalConversationInput(config));
    if (!parsed.success) return null;
    return Object.freeze({
      config: stripLegacyLocalConversationOwnership(parsed.data),
      root: Object.freeze({
        welcome: parsed.data.agent.welcome,
        executionMachine: Object.freeze({
          mode: parsed.data.agent.machineTargetMode,
          machineId: parsed.data.agent.machineTargetId,
          autoMachineId: parsed.data.agent.autoTargetMachineId,
        }),
      }),
    });
  },
  projectLegacy(config, context) {
    const parsed = VoiceLocalConversationSchema.safeParse(config);
    if (!parsed.success) return null;
    const localSpeech = projectLegacyLocalSpeechSettings(parsed.data, context.resolveProviderConfig);
    if (!localSpeech) return null;
    return {
      ...parsed.data,
      stt: localSpeech.stt,
      tts: localSpeech.tts,
      agent: {
        ...parsed.data.agent,
        machineTargetMode: context.root.executionMachine?.mode ?? 'auto',
        machineTargetId: context.root.executionMachine?.machineId ?? null,
        autoTargetMachineId: context.root.executionMachine?.autoMachineId ?? null,
        welcome: context.root.welcome ?? { enabled: false, mode: 'immediate', templateId: null },
      },
    } as VoiceProviderSettingsJsonValueV1;
  },
  mergeLegacy(currentConfig, migratedConfig) {
    const current = VoiceLocalConversationSchema.safeParse(currentConfig);
    const migrated = VoiceLocalConversationSchema.safeParse(migratedConfig);
    if (!current.success || !migrated.success) return null;
    const mergedSpeech = mergeLegacyLocalSpeechSettings(current.data, migrated.data);
    if (!mergedSpeech) return null;
    return stripLegacyLocalConversationOwnership(VoiceLocalConversationSchema.parse({
      ...migrated.data,
      stt: mergedSpeech.stt,
      tts: mergedSpeech.tts,
      agent: { ...migrated.data.agent, providerChat: current.data.agent.providerChat },
    }));
  },
});

// Stable/preview releases persisted this fully materialized adapter default.
const RELEASED_LEGACY_ELEVENLABS_DEFAULT_VOICE_ID = 'EST9Ui6982FZPSi7gCHi';
const elevenLabsCompatibility: ReleasedVoiceSettingsCompatibility = Object.freeze({
  defaultLegacyConfig: ElevenLabsVoiceProviderSettingsLegacySchema.parse({
    tts: { voiceId: RELEASED_LEGACY_ELEVENLABS_DEFAULT_VOICE_ID },
  }),
  legacyDefaultSelection: true,
  readLegacySecret(value) {
    const parsed = ElevenLabsVoiceProviderSettingsLegacySchema.safeParse(value);
    return parsed.success ? parsed.data.byo.apiKey : null;
  },
  preserveLegacyEnvelope(value) {
    const parsed = ElevenLabsVoiceProviderSettingsLegacySchema.safeParse(value);
    return !parsed.success || parsed.data.byo.apiKey == null
      ? null
      : Object.freeze({ schemaVersion: 1, config: parsed.data });
  },
  migrateLegacy(value) {
    const parsed = ElevenLabsVoiceProviderSettingsLegacySchema.safeParse(value);
    if (!parsed.success) return null;
    const { assistantLanguage, welcome, byo, ...rest } = parsed.data;
    const { style: _style, useSpeakerBoost: _speakerBoost, ...supportedVoiceSettings } = rest.tts.voiceSettings;
    const legacyAgentId = byo.agentId === null ? null : ElevenLabsAgentIdSchema.safeParse(byo.agentId);
    const legacyVoiceId = ElevenLabsVoiceIdSchema.safeParse(rest.tts.voiceId);
    const legacyModelId = rest.tts.modelId === null ? null : ElevenLabsModelIdSchema.safeParse(rest.tts.modelId);
    const legacySpeed = rest.tts.voiceSettings.speed;
    const config = ElevenLabsVoiceProviderSettingsSchema.safeParse({
      ...rest,
      tts: {
        ...rest.tts,
        voiceId: legacyVoiceId.success ? legacyVoiceId.data : DEFAULT_ELEVENLABS_VOICE_ID,
        modelId: legacyModelId === null ? null : legacyModelId.success ? legacyModelId.data : null,
        voiceSettings: {
          ...supportedVoiceSettings,
          speed: legacySpeed !== null && (legacySpeed < 0.7 || legacySpeed > 1.2) ? null : legacySpeed,
        },
      },
      agentId: legacyAgentId === null ? '' : legacyAgentId.success ? legacyAgentId.data : '',
    });
    return config.success
      ? Object.freeze({ config: config.data, root: Object.freeze({ assistantLanguage, welcome }) })
      : null;
  },
  projectLegacy(value, context) {
    const parsed = ElevenLabsVoiceProviderSettingsSchema.safeParse(value);
    if (!parsed.success) return null;
    const credential = context.resolveCredential('realtime_elevenlabs', 'api_key');
    const legacy = ElevenLabsVoiceProviderSettingsLegacySchema.safeParse({
      ...parsed.data,
      assistantLanguage: context.root.assistantLanguage ?? null,
      welcome: context.root.welcome ?? { enabled: false, mode: 'immediate', templateId: null },
      byo: { agentId: parsed.data.agentId || null, apiKey: credential },
    });
    return legacy.success ? legacy.data : null;
  },
  mergeLegacy(_currentValue, migratedValue) {
    const parsed = ElevenLabsVoiceProviderSettingsSchema.safeParse(migratedValue);
    return parsed.success ? parsed.data : null;
  },
});

const RELEASED_COMPATIBILITY_BY_PROVIDER_ID = Object.freeze({
  local_direct: localDirectCompatibility,
  local_conversation: localConversationCompatibility,
  'happier.voice.elevenlabs/realtime-elevenlabs': elevenLabsCompatibility,
} satisfies Record<string, ReleasedVoiceSettingsCompatibility>);

/**
 * Fixed compatibility owner for parser blob 89eaf1dff3766e316f226970f970aa8fe24155cb.
 * Remove only after the released stable/preview readers and rollback path are unreachable.
 */
export function getReleasedVoiceSettingsCompatibility(
  providerId: string,
): ReleasedVoiceSettingsCompatibility | null {
  return Object.prototype.hasOwnProperty.call(RELEASED_COMPATIBILITY_BY_PROVIDER_ID, providerId)
    ? RELEASED_COMPATIBILITY_BY_PROVIDER_ID[
        providerId as keyof typeof RELEASED_COMPATIBILITY_BY_PROVIDER_ID
      ]
    : null;
}
