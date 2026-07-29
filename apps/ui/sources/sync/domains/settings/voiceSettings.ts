import {
  VoiceProviderIdSchema,
  VoiceCredentialBindingV1Schema,
  VoiceProviderSettingsEnvelopeV1Schema,
  VoiceProviderSettingsRecordV1Schema,
  VoiceSpeechDiagnosticsSettingsV1Schema,
  SecretStringV1Schema,
  type VoiceProviderId,
  type VoiceCredentialBindingV1,
  type VoiceProviderSettingsEnvelopeV1,
  type VoiceProviderSettingsJsonValueV1,
  type VoiceSpeechDiagnosticsSettingsV1,
} from '@happier-dev/protocol';
import { z } from 'zod';
import {
  LEGACY_BUILT_IN_VOICE_ADAPTER_IDS,
  readLegacyVoiceSettingsMigrationSource,
} from '@/voice/settings/migrations/legacyAdapters';
import { VoiceWelcomeSchema } from '@/voice/settings/welcome';
import { BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES } from '@/voice/registry/generatedBundledVoiceEntries';
import {
  createVoiceProviderSettingsCatalog,
  resolveExternalVoiceProviderSettingsOwner,
  type VoiceProviderLegacyRootMigration,
} from '@/voice/settings/providerSettings';
import {
  VoiceLocalDirectSchema,
  type VoiceLocalDirectSettings,
} from '@/voice/adapters/localDirect/settings';
import { VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS } from '@/voice/adapters/local/settings';
import {
  normalizeLegacyLocalConversationInput,
  stripLegacyLocalConversationOwnership,
  VoiceLocalConversationSchema,
  type VoiceLocalConversationSettings,
} from '@/voice/adapters/localConversation/settings';
import {
  VoiceDictationSettingsSchema,
  type VoiceDictationSettings,
} from '@/voice/dictation/voiceDictationSettings';

export { VoiceProviderIdSchema, type VoiceProviderId };

export const VOICE_LEGACY_CREDENTIAL_RECOVERY_MARKER = 'happierLegacyCredentialRecoveryV1' as const;

const VoiceCredentialBindingsSchema = z.array(VoiceCredentialBindingV1Schema).max(64)
  .superRefine((bindings, ctx) => {
    const providers = new Set<string>();
    bindings.forEach((binding, index) => {
      if (providers.has(binding.providerId)) {
        ctx.addIssue({ code: 'custom', path: [index, 'providerId'], message: 'Duplicate Voice credential binding' });
      }
      providers.add(binding.providerId);
    });
  });

export type { VoiceCredentialBindingV1 };

const VoicePrivacySchema = z.object({
  shareSessionSummary: z.boolean().default(true),
  shareRecentMessages: z.boolean().default(true),
  recentMessagesCount: z.number().int().min(0).max(50).default(3),
  shareToolNames: z.boolean().default(true),
  sharePermissionRequests: z.boolean().default(true),
  // Allow voice tools to list non-sensitive device inventory (recent workspaces, machines, servers).
  // When disabled, inventory/discovery voice tools should fail closed.
  shareDeviceInventory: z.boolean().default(true),
  // Privacy hardening: do not share file paths or tool arguments with voice providers by default.
  shareFilePaths: z.boolean().default(false),
  shareToolArgs: z.boolean().default(false),
});

const VoiceUiUpdatesSchema = z.object({
  activeSession: z.enum(['none', 'activity', 'summaries', 'snippets']).default('summaries'),
  otherSessions: z.enum(['none', 'activity', 'summaries', 'snippets']).default('activity'),
  snippetsMaxMessages: z.number().int().min(1).max(10).default(3),
  includeUserMessagesInSnippets: z.boolean().default(false),
  otherSessionsSnippetsMode: z.enum(['never', 'on_demand_only', 'auto']).default('on_demand_only'),
});

const VoiceUiSchema = z.object({
  scopeDefault: z.enum(['session', 'global']).default('global'),
  surfaceLocation: z.enum(['sidebar', 'session', 'auto']).default('auto'),
  activityFeedEnabled: z.boolean().default(false),
  activityFeedAutoExpandOnStart: z.boolean().default(false),
  updates: VoiceUiUpdatesSchema.prefault({}),
});

export const VoiceExecutionMachineSettingsSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const raw = input as Record<string, unknown>;
  const normalizeId = (value: unknown): unknown => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    ...raw,
    mode: typeof raw.mode === 'string' ? raw.mode.trim() : raw.mode,
    machineId: normalizeId(raw.machineId),
    autoMachineId: normalizeId(raw.autoMachineId),
  };
}, z.object({
  mode: z.enum(['auto', 'fixed']).default('auto'),
  machineId: z.string().nullable().default(null),
  autoMachineId: z.string().nullable().default(null),
}));

export { type VoiceProviderSettingsEnvelopeV1 };

export {
  VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS,
  VoiceWelcomeSchema,
  VoiceLocalDirectSchema,
  type VoiceLocalDirectSettings,
  VoiceLocalConversationSchema,
  type VoiceLocalConversationSettings,
  VoiceDictationSettingsSchema,
  type VoiceDictationSettings,
};

const providerSettingsCatalog = createVoiceProviderSettingsCatalog({
  bundledEntries: BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES,
});

export function getCanonicalVoiceProviderSettingsOwner(providerId: string) {
  return providerSettingsCatalog.get(providerId);
}

function createDefaultProviderEnvelopes(): Record<string, VoiceProviderSettingsEnvelopeV1> {
  return providerSettingsCatalog.defaultEnvelopes();
}

const CanonicalVoiceSettingsSchema = z.object({
  providerId: VoiceProviderIdSchema.nullable().default(null),
  assistantLanguage: z.string().nullable().default(null),
  dictation: VoiceDictationSettingsSchema.prefault({}),
  welcome: VoiceWelcomeSchema.prefault({}),
  executionMachine: VoiceExecutionMachineSettingsSchema.prefault({}),
  ui: VoiceUiSchema.prefault({}),
  privacy: VoicePrivacySchema.prefault({}),
  diagnostics: VoiceSpeechDiagnosticsSettingsV1Schema.prefault({}),
  credentialBindings: VoiceCredentialBindingsSchema.default([]),
  providers: VoiceProviderSettingsRecordV1Schema.default(createDefaultProviderEnvelopes),
});

type CanonicalVoiceSettings = z.infer<typeof CanonicalVoiceSettingsSchema>;
export type VoiceSettings = CanonicalVoiceSettings;

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function isBoundedJsonValue(value: unknown): boolean {
  const seen = new Set<object>();
  let entries = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return true;
    if (typeof candidate === 'number') return Number.isFinite(candidate);
    if (typeof candidate !== 'object' || depth > 32 || seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      entries += candidate.length;
      return entries <= 4096 && candidate.every((entry) => visit(entry, depth + 1));
    }
    const record = candidate as Record<string, unknown>;
    const keys = Object.keys(record);
    entries += keys.length;
    return entries <= 4096 && keys.every((key) => visit(record[key], depth + 1));
  };
  if (!visit(value, 0)) return false;
  try {
    return utf8ByteLength(JSON.stringify(value)) <= 65_536;
  } catch {
    return false;
  }
}

const OBJECT_PROTOTYPE_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype));

export function isReservedVoiceSettingsRootKey(key: string): boolean {
  return OBJECT_PROTOTYPE_KEYS.has(key)
    || key === 'prototype'
    // Bounded migration input, never a forward-compatible output namespace.
    || key === 'adapters';
}

function preserveBoundedUnknownVoiceFields(
  target: VoiceSettings,
  raw: Readonly<Record<string, unknown>>,
): VoiceSettings {
  const known = CanonicalVoiceSettingsSchema.shape;
  const preserved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isReservedVoiceSettingsRootKey(key) || Object.prototype.hasOwnProperty.call(known, key)) continue;
    if (!isBoundedJsonValue(value)) continue;
    const candidate = { ...preserved, [key]: value };
    if (!isBoundedJsonValue(candidate)) continue;
    preserved[key] = JSON.parse(JSON.stringify(value)) as unknown;
  }
  return Object.assign(target, preserved);
}

function preserveMalformedLegacyCredentialFields(
  rawAdapters: unknown,
  options?: Readonly<{ preserveValidSecrets?: boolean }>,
): Record<string, unknown> | null {
  if (!rawAdapters || typeof rawAdapters !== 'object' || Array.isArray(rawAdapters)) return null;
  const paths = [
    ['realtime_elevenlabs', 'byo', 'apiKey'],
    ['local_direct', 'stt', 'googleGemini', 'apiKey'],
    ['local_direct', 'tts', 'googleCloud', 'apiKey'],
    ['local_direct', 'stt', 'openaiCompat', 'apiKey'],
    ['local_direct', 'tts', 'openaiCompat', 'apiKey'],
    ['local_conversation', 'agent', 'openaiCompat', 'chatApiKey'],
  ] as const;
  let preserved: Record<string, unknown> = {};
  for (const path of paths) {
    let current: unknown = rawAdapters;
    for (const segment of path) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    if (current == null
      || (!options?.preserveValidSecrets && SecretStringV1Schema.safeParse(current).success)
      || !isBoundedJsonValue(current)) continue;
    const preservedCredential = JSON.parse(JSON.stringify(current)) as unknown;
    const candidate = JSON.parse(JSON.stringify(preserved)) as Record<string, unknown>;
    let target = candidate;
    path.forEach((segment, index) => {
      if (index === path.length - 1) target[segment] = preservedCredential;
      else {
        const child = target[segment];
        target[segment] = child && typeof child === 'object' && !Array.isArray(child) ? child : {};
        target = target[segment] as Record<string, unknown>;
      }
    });
    if (isBoundedJsonValue(candidate)) preserved = candidate;
  }
  return Object.keys(preserved).length > 0 ? preserved : null;
}

function parseKnownProviderConfig(providerId: string, config: unknown): unknown | null {
  return (providerSettingsCatalog.get(providerId)
    ?? resolveExternalVoiceProviderSettingsOwner(providerId))?.parseConfig(config) ?? config;
}

function parseProviderEnvelopes(raw: unknown): Record<string, VoiceProviderSettingsEnvelopeV1> {
  const result = createDefaultProviderEnvelopes();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [rawProviderId, candidate] of Object.entries(raw as Record<string, unknown>)) {
    const providerId = VoiceProviderIdSchema.safeParse(rawProviderId);
    if (!providerId.success) continue;
    const envelope = VoiceProviderSettingsEnvelopeV1Schema.safeParse(candidate);
    if (!envelope.success || !isBoundedJsonValue(envelope.data.config)) {
      delete result[providerId.data];
      continue;
    }
    const configCopy = JSON.parse(JSON.stringify(envelope.data.config)) as VoiceProviderSettingsJsonValueV1;
    if (envelope.data.schemaVersion !== 1) {
      result[providerId.data] = { schemaVersion: envelope.data.schemaVersion, config: configCopy };
      continue;
    }
    const config = parseKnownProviderConfig(providerId.data, configCopy);
    // The generic envelope owner must preserve valid JSON even when a bundled
    // provider rejects its config. Runtime/readiness then fail closed instead
    // of silently substituting a runnable default for corrupted future data.
    result[providerId.data] = {
      schemaVersion: 1,
      config: (config ?? configCopy) as VoiceProviderSettingsJsonValueV1,
    };
  }
  return result;
}

function readLegacyAdapters(raw: Record<string, unknown>): Record<string, unknown> | null {
  return readLegacyVoiceSettingsMigrationSource(raw).adapters;
}

function migrateLegacyProviderEnvelopes(
  raw: Record<string, unknown>,
  providers: Record<string, VoiceProviderSettingsEnvelopeV1>,
  recoveryCarrier: boolean,
): ReadonlyMap<string, VoiceProviderLegacyRootMigration> {
  const rootMigrations = new Map<string, VoiceProviderLegacyRootMigration>();
  const adapters = readLegacyAdapters(raw);
  if (!adapters || recoveryCarrier) return rootMigrations;
  const rawProviders = raw.providers && typeof raw.providers === 'object' && !Array.isArray(raw.providers)
    ? raw.providers as Record<string, unknown>
    : null;
  const ownsCanonical = (providerId: string) => Boolean(
    rawProviders && Object.prototype.hasOwnProperty.call(rawProviders, providerId),
  );

  for (const owner of providerSettingsCatalog.list()) {
    const migrated = owner.migrateLegacy(adapters[owner.providerId] ?? {});
    if (!migrated) continue;
    if (!ownsCanonical(owner.providerId)) {
      rootMigrations.set(owner.providerId, migrated.root);
      const preserved = owner.preserveLegacyEnvelope?.(adapters[owner.providerId] ?? {}) ?? null;
      providers[owner.providerId] = preserved && isBoundedJsonValue(preserved.config)
        ? {
            schemaVersion: preserved.schemaVersion,
            config: preserved.config as VoiceProviderSettingsJsonValueV1,
          }
        : {
            schemaVersion: owner.currentSchemaVersion,
            config: migrated.config as VoiceProviderSettingsJsonValueV1,
          };
    }
  }
  for (const [rawProviderId, config] of Object.entries(adapters)) {
    if (ownsCanonical(rawProviderId) || providerSettingsCatalog.get(rawProviderId)) continue;
    const providerId = VoiceProviderIdSchema.safeParse(rawProviderId);
    if (!providerId.success || !isBoundedJsonValue(config)) continue;
    providers[providerId.data] = {
      schemaVersion: 1,
      config: JSON.parse(JSON.stringify(config)) as VoiceProviderSettingsJsonValueV1,
    };
  }
  return rootMigrations;
}

function reclaimLegacyProviderEnvelopes(
  providers: Record<string, VoiceProviderSettingsEnvelopeV1>,
): ReadonlyMap<string, VoiceProviderLegacyRootMigration> {
  const rootMigrations = new Map<string, VoiceProviderLegacyRootMigration>();
  for (const owner of providerSettingsCatalog.list()) {
    const envelope = providers[owner.providerId];
    // Current invalid envelopes remain inert and future envelopes remain opaque.
    // Only an older schema is a migration input owned by the restored provider.
    if (!envelope || envelope.schemaVersion >= owner.currentSchemaVersion) continue;
    const migrated = owner.migrateLegacy(envelope.config);
    if (!migrated || !isBoundedJsonValue(migrated.config)) continue;
    const preserved = owner.preserveLegacyEnvelope?.(envelope.config) ?? null;
    providers[owner.providerId] = preserved && isBoundedJsonValue(preserved.config)
      ? {
          schemaVersion: preserved.schemaVersion,
          config: preserved.config as VoiceProviderSettingsJsonValueV1,
        }
      : {
          schemaVersion: owner.currentSchemaVersion,
          config: migrated.config as VoiceProviderSettingsJsonValueV1,
        };
    rootMigrations.set(owner.providerId, migrated.root);
  }
  return rootMigrations;
}

function hasOnlyKnownDefaultKeys(raw: unknown, defaultValue: unknown): boolean {
  if (!raw || typeof raw !== 'object') return true;
  if (Array.isArray(raw)) {
    if (!Array.isArray(defaultValue)) return true;
    return raw.every((entry, index) => hasOnlyKnownDefaultKeys(entry, defaultValue[index]));
  }
  if (!defaultValue || typeof defaultValue !== 'object' || Array.isArray(defaultValue)) return true;
  const rawRecord = raw as Record<string, unknown>;
  const defaultRecord = defaultValue as Record<string, unknown>;
  return Object.keys(rawRecord).every((key) =>
    Object.prototype.hasOwnProperty.call(defaultRecord, key)
    && hasOnlyKnownDefaultKeys(rawRecord[key], defaultRecord[key]));
}

function isCompleteUntouchedHostedDefault(raw: Record<string, unknown>): boolean {
  if (typeof raw.providerId !== 'string') return false;
  const selectedOwner = providerSettingsCatalog.get(raw.providerId);
  if (!selectedOwner?.legacyDefaultSelection) return false;
  const adapters = readLegacyAdapters(raw);
  if (!adapters || !raw.ui || !raw.privacy) return false;
  if (!readLegacyVoiceSettingsMigrationSource(raw).hasCompleteBuiltInAdapterBlock) return false;
  if (Object.keys(adapters).some((providerId) => !LEGACY_BUILT_IN_VOICE_ADAPTER_IDS.includes(
    providerId as (typeof LEGACY_BUILT_IN_VOICE_ADAPTER_IDS)[number],
  ))) return false;
  return LEGACY_BUILT_IN_VOICE_ADAPTER_IDS.every((providerId) => {
    const owner = providerSettingsCatalog.get(providerId);
    if (!owner) return false;
    const candidate = adapters[owner.providerId];
    const migrated = owner.migrateLegacy(candidate ?? {});
    const defaultMigrated = owner.migrateLegacy(owner.defaultLegacyConfig);
    return migrated !== null
      && defaultMigrated !== null
      && hasOnlyKnownDefaultKeys(candidate, owner.defaultLegacyConfig)
      && JSON.stringify(migrated.config) === JSON.stringify(defaultMigrated.config);
  });
}

export const VoiceSettingsSchema = CanonicalVoiceSettingsSchema;

export function readVoiceProviderSettingsConfig(
  settings: Pick<CanonicalVoiceSettings, 'providers'>,
  providerId: string,
): unknown | null {
  const owner = providerSettingsCatalog.get(providerId)
    ?? resolveExternalVoiceProviderSettingsOwner(providerId);
  const envelope = settings.providers?.[providerId];
  if (!owner || envelope?.schemaVersion !== owner.currentSchemaVersion) return null;
  return owner.parseConfig(envelope.config);
}

export function readLocalDirectVoiceSettings(settings: Pick<CanonicalVoiceSettings, 'providers'>): VoiceLocalDirectSettings {
  const envelope = settings.providers?.local_direct;
  if (envelope?.schemaVersion === 1) {
    const parsed = VoiceLocalDirectSchema.safeParse(envelope.config);
    if (parsed.success) return parsed.data;
  }
  return VoiceLocalDirectSchema.parse({});
}

export function readLocalConversationVoiceSettings(settings: Pick<CanonicalVoiceSettings, 'providers'>): VoiceLocalConversationSettings {
  const envelope = settings.providers?.local_conversation;
  if (envelope?.schemaVersion === 1) {
    const parsed = VoiceLocalConversationSchema.safeParse(envelope.config);
    if (parsed.success) return stripLegacyLocalConversationOwnership(parsed.data);
  }
  return stripLegacyLocalConversationOwnership(VoiceLocalConversationSchema.parse({}));
}

export function writeVoiceProviderSettingsConfig(settings: VoiceSettings, providerId: string, config: unknown): VoiceSettings {
  const owner = providerSettingsCatalog.get(providerId)
    ?? resolveExternalVoiceProviderSettingsOwner(providerId);
  if (!owner) throw new Error(`voice_provider_settings_owner_unavailable:${providerId}`);
  const parsed = owner.parseConfig(config);
  if (parsed === null) throw new Error(`invalid_voice_provider_settings:${providerId}`);
  return {
    ...settings,
    providers: {
      ...(settings.providers ?? createDefaultProviderEnvelopes()),
      [providerId]: { schemaVersion: owner.currentSchemaVersion, config: parsed as VoiceProviderSettingsJsonValueV1 },
    },
  };
}

export function writeLocalDirectVoiceSettings(settings: VoiceSettings, config: VoiceLocalDirectSettings): VoiceSettings {
  return writeVoiceProviderSettingsConfig(settings, 'local_direct', VoiceLocalDirectSchema.parse(config));
}

export function writeLocalConversationVoiceSettings(settings: VoiceSettings, config: VoiceLocalConversationSettings): VoiceSettings {
  return writeVoiceProviderSettingsConfig(settings, 'local_conversation', stripLegacyLocalConversationOwnership(VoiceLocalConversationSchema.parse(config)));
}

export function readVoiceDiagnosticsSettings(
  settings: Pick<CanonicalVoiceSettings, 'diagnostics'>,
): VoiceSpeechDiagnosticsSettingsV1 {
  return VoiceSpeechDiagnosticsSettingsV1Schema.parse(settings.diagnostics ?? {});
}

export function writeVoiceDiagnosticsSettings(
  settings: VoiceSettings,
  diagnostics: VoiceSpeechDiagnosticsSettingsV1,
): VoiceSettings {
  return {
    ...settings,
    diagnostics: VoiceSpeechDiagnosticsSettingsV1Schema.parse(diagnostics),
  };
}

export const voiceSettingsDefaults: VoiceSettings = VoiceSettingsSchema.parse({});

export function readVoiceSettingsInput(settings: unknown): unknown {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return settings;
  return Object.hasOwn(settings, 'voice')
    ? (settings as Readonly<{ voice?: unknown }>).voice
    : settings;
}

// Tolerant parsing: keep valid sub-fields, drop invalid ones to defaults.
export function voiceSettingsParse(
  input: unknown,
  options?: Readonly<{ allowLegacyCredentialRecoveryCarrier?: boolean }>,
): VoiceSettings {
  // Important: `voiceSettingsDefaults` contains nested objects. We must not shallow-clone and then
  // mutate nested fields, otherwise parsing can accidentally mutate global defaults.
  const base = CanonicalVoiceSettingsSchema.parse({});
  if (!input || typeof input !== 'object') return base;

  const raw = input as Record<string, unknown>;
  const recoveryCarrier = options?.allowLegacyCredentialRecoveryCarrier === true
    && raw[VOICE_LEGACY_CREDENTIAL_RECOVERY_MARKER] === true;

  if (raw.providerId === 'off') base.providerId = null;
  else {
    const legacyProviderId = typeof raw.providerId === 'string' ? raw.providerId.trim() : raw.providerId;
    const providerId = VoiceProviderIdSchema.safeParse(legacyProviderId);
    if (providerId.success) base.providerId = providerId.data;
  }

  const canonicalAssistantLanguage = z.string().nullable().safeParse(raw.assistantLanguage);
  if (canonicalAssistantLanguage.success) base.assistantLanguage = canonicalAssistantLanguage.data;

  const canonicalDictation = VoiceDictationSettingsSchema.safeParse(raw.dictation);
  if (canonicalDictation.success) base.dictation = canonicalDictation.data;

  const canonicalWelcome = VoiceWelcomeSchema.safeParse(raw.welcome);
  if (canonicalWelcome.success) base.welcome = canonicalWelcome.data;

  const canonicalExecutionMachine = VoiceExecutionMachineSettingsSchema.safeParse(raw.executionMachine);
  if (canonicalExecutionMachine.success) base.executionMachine = canonicalExecutionMachine.data;

  const canonicalDiagnostics = VoiceSpeechDiagnosticsSettingsV1Schema.safeParse(raw.diagnostics);
  if (canonicalDiagnostics.success) base.diagnostics = canonicalDiagnostics.data;

  const canonicalCredentialBindings = VoiceCredentialBindingsSchema.safeParse(raw.credentialBindings);
  if (canonicalCredentialBindings.success) base.credentialBindings = canonicalCredentialBindings.data;

  base.providers = parseProviderEnvelopes(raw.providers);
  const legacyRootMigrations = new Map(reclaimLegacyProviderEnvelopes(base.providers));
  for (const [providerId, migration] of migrateLegacyProviderEnvelopes(raw, base.providers, recoveryCarrier)) {
    if (!legacyRootMigrations.has(providerId)) legacyRootMigrations.set(providerId, migration);
  }

  if (!canonicalWelcome.success) {
    const selectedWelcome = base.providerId === null
      ? null
      : legacyRootMigrations.get(base.providerId)?.welcome ?? null;
    if (selectedWelcome) base.welcome = VoiceWelcomeSchema.parse(selectedWelcome);
  }
  if (!canonicalAssistantLanguage.success) {
    const migratedLanguage = [...legacyRootMigrations.values()]
      .map((migration) => migration.assistantLanguage)
      .find((value): value is string => typeof value === 'string');
    if (migratedLanguage) base.assistantLanguage = migratedLanguage;
  }
  if (!canonicalExecutionMachine.success) {
    const migratedMachine = [...legacyRootMigrations.values()]
      .map((migration) => migration.executionMachine)
      .find((value) => value !== undefined);
    if (migratedMachine) base.executionMachine = VoiceExecutionMachineSettingsSchema.parse(migratedMachine);
  }

  if (isCompleteUntouchedHostedDefault(raw)) base.providerId = null;

  if (raw.ui && typeof raw.ui === 'object') {
    const u = raw.ui as Record<string, unknown>;

    const scopeDefault = z.enum(['session', 'global']).safeParse(u.scopeDefault);
    if (scopeDefault.success) base.ui.scopeDefault = scopeDefault.data;

    const surfaceLocation = z.enum(['sidebar', 'session', 'auto']).safeParse(u.surfaceLocation);
    if (surfaceLocation.success) base.ui.surfaceLocation = surfaceLocation.data;

    const activityFeedEnabled = z.boolean().safeParse(u.activityFeedEnabled);
    if (activityFeedEnabled.success) base.ui.activityFeedEnabled = activityFeedEnabled.data;

    const activityFeedAutoExpandOnStart = z.boolean().safeParse(u.activityFeedAutoExpandOnStart);
    if (activityFeedAutoExpandOnStart.success) base.ui.activityFeedAutoExpandOnStart = activityFeedAutoExpandOnStart.data;

    if (u.updates && typeof u.updates === 'object') {
      const upd = u.updates as Record<string, unknown>;
      const activeSession = z.enum(['none', 'activity', 'summaries', 'snippets']).safeParse(upd.activeSession);
      if (activeSession.success) base.ui.updates.activeSession = activeSession.data;

      const otherSessions = z.enum(['none', 'activity', 'summaries', 'snippets']).safeParse(upd.otherSessions);
      if (otherSessions.success) base.ui.updates.otherSessions = otherSessions.data;

      const snippetsMaxMessages = z.number().int().safeParse(upd.snippetsMaxMessages);
      if (snippetsMaxMessages.success) {
        base.ui.updates.snippetsMaxMessages = Math.max(1, Math.min(10, snippetsMaxMessages.data));
      }

      const includeUserMessagesInSnippets = z.boolean().safeParse(upd.includeUserMessagesInSnippets);
      if (includeUserMessagesInSnippets.success) {
        base.ui.updates.includeUserMessagesInSnippets = includeUserMessagesInSnippets.data;
      }

      const otherSessionsSnippetsMode = z.enum(['never', 'on_demand_only', 'auto']).safeParse(upd.otherSessionsSnippetsMode);
      if (otherSessionsSnippetsMode.success) {
        base.ui.updates.otherSessionsSnippetsMode = otherSessionsSnippetsMode.data;
      }
    }
  }

  // privacy
  if (raw.privacy && typeof raw.privacy === 'object') {
    const p = raw.privacy as Record<string, unknown>;
    const parseBool = (k: keyof VoiceSettings['privacy']) => z.boolean().safeParse(p[k as string]);
    const parseInt = (k: keyof VoiceSettings['privacy']) => z.number().int().safeParse(p[k as string]);

    const s1 = parseBool('shareSessionSummary');
    if (s1.success) base.privacy.shareSessionSummary = s1.data;
    const s2 = parseBool('shareRecentMessages');
    if (s2.success) base.privacy.shareRecentMessages = s2.data;
    const s3 = parseInt('recentMessagesCount');
    if (s3.success) {
      const clamped = Math.max(0, Math.min(50, s3.data));
      base.privacy.recentMessagesCount = clamped;
    }
    const s4 = parseBool('shareToolNames');
    if (s4.success) base.privacy.shareToolNames = s4.data;
    const s5 = parseBool('sharePermissionRequests');
    if (s5.success) base.privacy.sharePermissionRequests = s5.data;
    const s6 = parseBool('shareDeviceInventory');
    if (s6.success) base.privacy.shareDeviceInventory = s6.data;
    const s7 = parseBool('shareFilePaths');
    if (s7.success) base.privacy.shareFilePaths = s7.data;
    const s8 = parseBool('shareToolArgs');
    if (s8.success) base.privacy.shareToolArgs = s8.data;
  }

  // Privacy hardening: never allow sharing file paths or tool args over voice transport.
  // This is intentionally enforced even if a persisted config attempts to enable it.
  base.privacy.shareFilePaths = false;
  base.privacy.shareToolArgs = false;

  const result = preserveBoundedUnknownVoiceFields(base, raw);
  const malformedLegacyCredentials = preserveMalformedLegacyCredentialFields(raw.adapters, {
    preserveValidSecrets: recoveryCarrier,
  });
  if (malformedLegacyCredentials) {
    Object.assign(result as VoiceSettings & { adapters?: unknown }, { adapters: malformedLegacyCredentials });
  } else {
    delete (result as VoiceSettings & Record<string, unknown>)[VOICE_LEGACY_CREDENTIAL_RECOVERY_MARKER];
  }
  if (!recoveryCarrier) {
    delete (result as VoiceSettings & Record<string, unknown>)[VOICE_LEGACY_CREDENTIAL_RECOVERY_MARKER];
  }
  return result;
}
