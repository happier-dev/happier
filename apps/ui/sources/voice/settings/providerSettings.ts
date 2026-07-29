import type {
  SecretStringV1,
  VoiceProviderSettingsEnvelopeV1,
  VoiceProviderSettingsJsonValueV1,
} from '@happier-dev/protocol';
import { PluginVoiceProviderContributionV1Schema } from '@happier-dev/protocol';

import {
  VoiceLocalDirectSchema,
} from '@/voice/adapters/localDirect/settings';
import {
  normalizeLegacyLocalConversationInput,
  stripLegacyLocalConversationOwnership,
  VoiceLocalConversationSchema,
} from '@/voice/adapters/localConversation/settings';
import { getExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { createExternalVoiceProviderSettingsDescriptor } from '@/voice/settings/externalProviderSettings';

export type VoiceProviderLegacyRootMigration = Readonly<{
  assistantLanguage?: string | null;
  welcome?: Readonly<{ enabled: boolean; mode: 'immediate' | 'on_first_turn'; templateId: string | null }>;
  executionMachine?: Readonly<{ mode: 'auto' | 'fixed'; machineId: string | null; autoMachineId: string | null }>;
}>;

export type VoiceProviderLegacyProjectionContext = Readonly<{
  root: VoiceProviderLegacyRootMigration;
  resolveCredential: (providerId: string, slotId: string) => SecretStringV1 | null;
}>;

export type VoiceProviderSettingsOwner = Readonly<{
  providerId: string;
  currentSchemaVersion: number;
  defaultConfig: VoiceProviderSettingsJsonValueV1;
  defaultLegacyConfig: VoiceProviderSettingsJsonValueV1;
  legacyDefaultSelection: boolean;
  parseConfig: (config: unknown) => unknown | null;
  readLegacySecret?: (config: unknown) => unknown | null;
  migrateLegacy: (config: unknown) => Readonly<{
    config: unknown;
    root: VoiceProviderLegacyRootMigration;
  }> | null;
  projectLegacy: (
    config: unknown,
    context: VoiceProviderLegacyProjectionContext,
  ) => VoiceProviderSettingsJsonValueV1 | null;
  mergeLegacy: (currentConfig: unknown, migratedConfig: unknown) => unknown | null;
  preserveLegacyEnvelope?: (config: unknown) => Readonly<{
    schemaVersion: number;
    config: unknown;
  }> | null;
  projectAnalytics?: (config: unknown) => Readonly<Record<string, boolean | string>>;
}>;

export type VoiceProviderSettingsCatalog = Readonly<{
  get(providerId: string): VoiceProviderSettingsOwner | null;
  list(): readonly VoiceProviderSettingsOwner[];
  defaultEnvelopes(): Record<string, VoiceProviderSettingsEnvelopeV1>;
  projectAnalytics(providers: Readonly<Record<string, VoiceProviderSettingsEnvelopeV1>>): Record<string, boolean | string>;
}>;

/**
 * Resolves an active external provider through the one activation-owned
 * registration source. No migration or alias is inferred for the public V1
 * envelope; unavailable and future versions remain opaque and fail closed.
 */
export function resolveExternalVoiceProviderSettingsOwner(
  providerId: string,
): VoiceProviderSettingsOwner | null {
  const settings = getExternalVoiceProviderRegistration(providerId)?.descriptor?.providerSettings;
  if (!settings) return null;
  return Object.freeze({
    providerId,
    currentSchemaVersion: settings.schemaVersion,
    defaultConfig: cloneJson(settings.defaultConfig),
    defaultLegacyConfig: cloneJson(settings.defaultConfig),
    legacyDefaultSelection: false,
    parseConfig: settings.parseConfig,
    migrateLegacy: () => null,
    projectLegacy: () => null,
    mergeLegacy: () => null,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value: unknown): VoiceProviderSettingsJsonValueV1 {
  return JSON.parse(JSON.stringify(value)) as VoiceProviderSettingsJsonValueV1;
}

const PREDECESSOR_STT_PROVIDER_IDS = new Set(['device', 'openai_compat', 'google_gemini', 'local_neural']);
const PREDECESSOR_TTS_PROVIDER_IDS = new Set(['device', 'openai_compat', 'google_cloud', 'local_neural']);

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readSpeechProviderConfig(
  providers: unknown,
  providerId: string,
): Record<string, unknown> {
  const envelope = asRecord(asRecord(providers)[providerId]);
  return envelope.schemaVersion === 2 ? asRecord(envelope.config) : {};
}

function withoutKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = { ...asRecord(value) };
  for (const key of keys) delete result[key];
  return result;
}

function projectLegacyLocalSpeechSettings(
  config: unknown,
  resolveCredential: VoiceProviderLegacyProjectionContext['resolveCredential'],
): Record<string, VoiceProviderSettingsJsonValueV1> | null {
  const parsed = VoiceLocalDirectSchema.safeParse(config);
  if (!parsed.success) return null;
  const stt = parsed.data.stt;
  const tts = parsed.data.tts;
  if (!PREDECESSOR_STT_PROVIDER_IDS.has(stt.provider)
    || !PREDECESSOR_TTS_PROVIDER_IDS.has(tts.provider)) return null;

  return {
    ...parsed.data,
    stt: {
      ...withoutKeys(stt, ['providers']),
      openaiCompat: {
        ...stt.openaiCompat,
        apiKey: resolveCredential('openai_compat', 'stt_api_key'),
      },
      googleGemini: {
        ...readSpeechProviderConfig(stt.providers, 'google_gemini'),
        apiKey: resolveCredential('google_gemini', 'api_key'),
      },
      localNeural: withoutKeys(stt.localNeural, ['execution']),
    },
    tts: {
      ...withoutKeys(tts, ['providers']),
      openaiCompat: {
        ...tts.openaiCompat,
        apiKey: resolveCredential('openai_compat', 'tts_api_key'),
      },
      googleCloud: {
        ...readSpeechProviderConfig(tts.providers, 'google_cloud'),
        apiKey: resolveCredential('google_cloud', 'api_key'),
      },
      localNeural: withoutKeys(tts.localNeural, ['execution']),
    },
  } as Record<string, VoiceProviderSettingsJsonValueV1>;
}

function mergeLegacyLocalSpeechSettings(
  currentConfig: unknown,
  migratedConfig: unknown,
): ReturnType<typeof VoiceLocalDirectSchema.parse> | null {
  const current = VoiceLocalDirectSchema.safeParse(currentConfig);
  const migrated = VoiceLocalDirectSchema.safeParse(migratedConfig);
  if (!current.success || !migrated.success) return null;
  return VoiceLocalDirectSchema.parse({
    ...migrated.data,
    stt: {
      ...migrated.data.stt,
      openaiCompat: {
        ...migrated.data.stt.openaiCompat,
        insecureLocalOriginConsent: current.data.stt.openaiCompat.insecureLocalOriginConsent,
        insecureLocalConsentMachineId: current.data.stt.openaiCompat.insecureLocalConsentMachineId,
        apiKey: current.data.stt.openaiCompat.apiKey,
      },
      localNeural: {
        ...migrated.data.stt.localNeural,
        execution: current.data.stt.localNeural.execution,
      },
      providers: {
        ...current.data.stt.providers,
        ...migrated.data.stt.providers,
      },
    },
    tts: {
      ...migrated.data.tts,
      openaiCompat: {
        ...migrated.data.tts.openaiCompat,
        insecureLocalOriginConsent: current.data.tts.openaiCompat.insecureLocalOriginConsent,
        insecureLocalConsentMachineId: current.data.tts.openaiCompat.insecureLocalConsentMachineId,
        apiKey: current.data.tts.openaiCompat.apiKey,
      },
      localNeural: {
        ...migrated.data.tts.localNeural,
        execution: current.data.tts.localNeural.execution,
      },
      providers: {
        ...current.data.tts.providers,
        ...migrated.data.tts.providers,
      },
    },
  });
}

function createBuiltInOwners(): readonly VoiceProviderSettingsOwner[] {
  const defaultLocalDirect = VoiceLocalDirectSchema.parse({});
  const defaultLocalConversation = VoiceLocalConversationSchema.parse({});
  return Object.freeze([
    Object.freeze({
      providerId: 'local_direct',
      currentSchemaVersion: 1,
      defaultConfig: defaultLocalDirect,
      defaultLegacyConfig: defaultLocalDirect,
      legacyDefaultSelection: false,
      parseConfig(config: unknown) {
        const parsed = VoiceLocalDirectSchema.safeParse(config);
        return parsed.success ? parsed.data : null;
      },
      migrateLegacy(config: unknown) {
        const parsed = VoiceLocalDirectSchema.safeParse(config);
        return parsed.success ? Object.freeze({ config: parsed.data, root: Object.freeze({}) }) : null;
      },
      projectLegacy(config: unknown, context: VoiceProviderLegacyProjectionContext) {
        return projectLegacyLocalSpeechSettings(config, context.resolveCredential);
      },
      mergeLegacy(currentConfig: unknown, migratedConfig: unknown) {
        return mergeLegacyLocalSpeechSettings(currentConfig, migratedConfig);
      },
    }),
    Object.freeze({
      providerId: 'local_conversation',
      currentSchemaVersion: 1,
      defaultConfig: stripLegacyLocalConversationOwnership(defaultLocalConversation),
      defaultLegacyConfig: defaultLocalConversation,
      legacyDefaultSelection: false,
      parseConfig(config: unknown) {
        const parsed = VoiceLocalConversationSchema.safeParse(config);
        return parsed.success ? stripLegacyLocalConversationOwnership(parsed.data) : null;
      },
      migrateLegacy(config: unknown) {
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
      projectLegacy(config: unknown, context: VoiceProviderLegacyProjectionContext) {
        const parsed = VoiceLocalConversationSchema.safeParse(config);
        if (!parsed.success) return null;
        const localSpeech = projectLegacyLocalSpeechSettings(parsed.data, context.resolveCredential);
        if (!localSpeech) return null;
        const agent = parsed.data.agent;
        return {
          ...parsed.data,
          stt: localSpeech.stt,
          tts: localSpeech.tts,
          agent: {
            ...agent,
            machineTargetMode: context.root.executionMachine?.mode ?? 'auto',
            machineTargetId: context.root.executionMachine?.machineId ?? null,
            autoTargetMachineId: context.root.executionMachine?.autoMachineId ?? null,
            welcome: context.root.welcome ?? {
              enabled: false,
              mode: 'immediate',
              templateId: null,
            },
            openaiCompat: {
              ...agent.openaiCompat,
              chatApiKey: context.resolveCredential('openai_compat', 'chat_api_key'),
            },
          },
        } as VoiceProviderSettingsJsonValueV1;
      },
      mergeLegacy(currentConfig: unknown, migratedConfig: unknown) {
        const current = VoiceLocalConversationSchema.safeParse(currentConfig);
        const migrated = VoiceLocalConversationSchema.safeParse(migratedConfig);
        if (!current.success || !migrated.success) return null;
        const mergedSpeech = mergeLegacyLocalSpeechSettings(current.data, migrated.data);
        if (!mergedSpeech) return null;
        return stripLegacyLocalConversationOwnership(VoiceLocalConversationSchema.parse({
          ...migrated.data,
          stt: mergedSpeech.stt,
          tts: mergedSpeech.tts,
          agent: {
            ...migrated.data.agent,
            openaiCompat: {
              ...migrated.data.agent.openaiCompat,
              insecureLocalOriginConsent: current.data.agent.openaiCompat.insecureLocalOriginConsent,
              insecureLocalConsentMachineId: current.data.agent.openaiCompat.insecureLocalConsentMachineId,
              chatApiKey: current.data.agent.openaiCompat.chatApiKey,
            },
          },
        }));
      },
    }),
  ]);
}

function extractBundledOwner(raw: unknown): VoiceProviderSettingsOwner | null {
  if (!isRecord(raw) || typeof raw.providerId !== 'string') return null;
  const publicDeclaration = PluginVoiceProviderContributionV1Schema.safeParse(raw.declaration);
  if (publicDeclaration.success
    && publicDeclaration.data.kind === 'conversation'
    && publicDeclaration.data.settings !== undefined
    && (
      publicDeclaration.data.settings.fields.length > 0
      || publicDeclaration.data.settings.connectedServicesBinding !== undefined
    )) {
    const settings = createExternalVoiceProviderSettingsDescriptor(publicDeclaration.data.settings);
    const legacyMigration = isRecord(raw.internal) && isRecord(raw.internal.legacySettingsMigration)
      ? raw.internal.legacySettingsMigration
      : null;
    const migrateLegacy = legacyMigration && typeof legacyMigration.migrateLegacy === 'function'
      ? legacyMigration.migrateLegacy as VoiceProviderSettingsOwner['migrateLegacy']
      : null;
    const projectLegacy = legacyMigration && typeof legacyMigration.projectLegacy === 'function'
      ? legacyMigration.projectLegacy as VoiceProviderSettingsOwner['projectLegacy']
      : null;
    const mergeLegacy = legacyMigration && typeof legacyMigration.mergeLegacy === 'function'
      ? legacyMigration.mergeLegacy as VoiceProviderSettingsOwner['mergeLegacy']
      : null;
    const projectAnalytics = isRecord(raw.internal) && typeof raw.internal.projectSettingsAnalytics === 'function'
      ? raw.internal.projectSettingsAnalytics as NonNullable<VoiceProviderSettingsOwner['projectAnalytics']>
      : null;
    return Object.freeze({
      providerId: raw.providerId,
      currentSchemaVersion: settings.schemaVersion,
      defaultConfig: cloneJson(settings.defaultConfig),
      defaultLegacyConfig: cloneJson(legacyMigration && 'defaultLegacyConfig' in legacyMigration
        ? legacyMigration.defaultLegacyConfig
        : settings.defaultConfig),
      legacyDefaultSelection: legacyMigration?.legacyDefaultSelection === true,
      parseConfig: settings.parseConfig,
      ...(legacyMigration && typeof legacyMigration.readLegacySecret === 'function'
        ? { readLegacySecret: legacyMigration.readLegacySecret as NonNullable<VoiceProviderSettingsOwner['readLegacySecret']> }
        : {}),
      migrateLegacy(config) {
        const migrated = migrateLegacy?.(config) ?? null;
        if (!migrated) return null;
        const parsed = settings.parseConfig(migrated.config);
        return parsed === null ? null : Object.freeze({ ...migrated, config: parsed });
      },
      projectLegacy(config, context) {
        const parsed = settings.parseConfig(config);
        return parsed === null ? null : projectLegacy?.(parsed, context) ?? null;
      },
      mergeLegacy(currentConfig, migratedConfig) {
        const merged = mergeLegacy?.(currentConfig, migratedConfig) ?? migratedConfig;
        return settings.parseConfig(merged);
      },
      ...(legacyMigration && typeof legacyMigration.preserveLegacyEnvelope === 'function'
        ? {
            preserveLegacyEnvelope: legacyMigration.preserveLegacyEnvelope as NonNullable<
              VoiceProviderSettingsOwner['preserveLegacyEnvelope']
            >,
          }
        : {}),
      ...(projectAnalytics
        ? {
            projectAnalytics(config: unknown) {
              const parsed = settings.parseConfig(config);
              return parsed === null ? Object.freeze({}) : projectAnalytics(parsed);
            },
          }
        : {}),
    });
  }
  if (!isRecord(raw.internal)) return null;
  const providerSettings = raw.internal.providerSettings;
  if (!isRecord(providerSettings)
    || typeof providerSettings.schemaVersion !== 'number'
    || !Number.isInteger(providerSettings.schemaVersion)
    || providerSettings.schemaVersion < 1
    || typeof providerSettings.parseConfig !== 'function'
    || typeof providerSettings.migrateLegacy !== 'function'
    || typeof providerSettings.projectLegacy !== 'function'
    || typeof providerSettings.mergeLegacy !== 'function'
    || !('defaultConfig' in providerSettings)
    || !('defaultLegacyConfig' in providerSettings)) return null;
  const owner: VoiceProviderSettingsOwner = {
    providerId: raw.providerId,
    currentSchemaVersion: providerSettings.schemaVersion,
    defaultConfig: cloneJson(providerSettings.defaultConfig),
    defaultLegacyConfig: cloneJson(providerSettings.defaultLegacyConfig),
    legacyDefaultSelection: providerSettings.legacyDefaultSelection === true,
    parseConfig: providerSettings.parseConfig as VoiceProviderSettingsOwner['parseConfig'],
    ...(typeof providerSettings.readLegacySecret === 'function'
      ? { readLegacySecret: providerSettings.readLegacySecret as NonNullable<VoiceProviderSettingsOwner['readLegacySecret']> }
      : {}),
    migrateLegacy: providerSettings.migrateLegacy as VoiceProviderSettingsOwner['migrateLegacy'],
    projectLegacy: providerSettings.projectLegacy as VoiceProviderSettingsOwner['projectLegacy'],
    mergeLegacy: providerSettings.mergeLegacy as VoiceProviderSettingsOwner['mergeLegacy'],
    ...(typeof providerSettings.preserveLegacyEnvelope === 'function'
      ? { preserveLegacyEnvelope: providerSettings.preserveLegacyEnvelope as NonNullable<VoiceProviderSettingsOwner['preserveLegacyEnvelope']> }
      : {}),
    ...(typeof providerSettings.projectAnalytics === 'function'
      ? { projectAnalytics: providerSettings.projectAnalytics as NonNullable<VoiceProviderSettingsOwner['projectAnalytics']> }
      : {}),
  };
  return Object.freeze(owner);
}

export function resolveBundledVoiceProviderSettingsOwner(
  raw: unknown,
): VoiceProviderSettingsOwner | null {
  return extractBundledOwner(raw);
}

export function createVoiceProviderSettingsCatalog(input: Readonly<{
  bundledEntries: readonly unknown[];
}>): VoiceProviderSettingsCatalog {
  const owners = [...createBuiltInOwners()];
  for (const raw of input.bundledEntries) {
    const owner = extractBundledOwner(raw);
    if (owner) owners.push(owner);
  }
  owners.sort((left, right) => left.providerId.localeCompare(right.providerId));
  const byId = new Map<string, VoiceProviderSettingsOwner>();
  for (const owner of owners) {
    if (byId.has(owner.providerId)) throw new Error(`duplicate_voice_provider_settings_owner:${owner.providerId}`);
    byId.set(owner.providerId, owner);
  }
  const frozenOwners = Object.freeze([...owners]);
  const catalog: VoiceProviderSettingsCatalog = {
    get(providerId: string) {
      return byId.get(providerId) ?? null;
    },
    list() {
      return frozenOwners;
    },
    defaultEnvelopes() {
      return Object.fromEntries(frozenOwners.map((owner) => [
        owner.providerId,
        { schemaVersion: owner.currentSchemaVersion, config: cloneJson(owner.defaultConfig) },
      ]));
    },
    projectAnalytics(providers) {
      const result: Record<string, boolean | string> = {};
      for (const owner of frozenOwners) {
        if (!owner.projectAnalytics) continue;
        const envelope = providers[owner.providerId];
        if (!envelope || envelope.schemaVersion !== owner.currentSchemaVersion) continue;
        const config = owner.parseConfig(envelope.config);
        if (config === null) continue;
        Object.assign(result, owner.projectAnalytics(config));
      }
      return result;
    },
  };
  return Object.freeze(catalog);
}
