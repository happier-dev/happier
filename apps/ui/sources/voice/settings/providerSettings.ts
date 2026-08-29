import type {
  SecretStringV1,
  VoiceProviderSettingsEnvelopeV1,
  VoiceProviderSettingsJsonValueV1,
} from '@happier-dev/protocol';
import {
  VoiceProviderContributionSchema,
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
} from '@happier-dev/protocol';

import {
  VoiceLocalDirectSchema,
} from '@/voice/adapters/localDirect/settings';
import {
  stripLegacyLocalConversationOwnership,
  VoiceLocalConversationSchema,
} from '@/voice/adapters/localConversation/settings';
import { getExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import type { BundledVoiceManifestContribution } from '@/voice/registry/bundledVoiceManifestProjection';
import { createExternalVoiceProviderSettingsDescriptor } from '@/voice/settings/externalProviderSettings';
import {
  getReleasedVoiceSettingsCompatibility,
  type ReleasedVoiceLegacyProjectionContext,
  type ReleasedVoiceLegacyRootMigration,
} from '@/sync/domains/settings/migrations/releasedVoiceSettingsCompatibility';

export type VoiceProviderLegacyRootMigration = ReleasedVoiceLegacyRootMigration;

export type VoiceProviderLegacyProjectionContext = Omit<ReleasedVoiceLegacyProjectionContext, 'resolveCredential'> & Readonly<{
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

function createBuiltInOwners(): readonly VoiceProviderSettingsOwner[] {
  const defaultLocalDirect = VoiceLocalDirectSchema.parse({});
  const defaultLocalConversation = VoiceLocalConversationSchema.parse({});
  const localDirectCompatibility = getReleasedVoiceSettingsCompatibility('local_direct');
  const localConversationCompatibility = getReleasedVoiceSettingsCompatibility('local_conversation');
  if (!localDirectCompatibility || !localConversationCompatibility) {
    throw new Error('released_voice_settings_compatibility_owner_missing');
  }
  return Object.freeze([
    Object.freeze({
      providerId: 'local_direct',
      currentSchemaVersion: 1,
      defaultConfig: defaultLocalDirect,
      defaultLegacyConfig: localDirectCompatibility.defaultLegacyConfig,
      legacyDefaultSelection: localDirectCompatibility.legacyDefaultSelection,
      parseConfig(config: unknown) {
        const parsed = VoiceLocalDirectSchema.safeParse(config);
        return parsed.success ? parsed.data : null;
      },
      migrateLegacy: localDirectCompatibility.migrateLegacy,
      projectLegacy: localDirectCompatibility.projectLegacy,
      mergeLegacy: localDirectCompatibility.mergeLegacy,
    }),
    Object.freeze({
      providerId: 'local_conversation',
      currentSchemaVersion: 1,
      defaultConfig: stripLegacyLocalConversationOwnership(defaultLocalConversation),
      defaultLegacyConfig: localConversationCompatibility.defaultLegacyConfig,
      legacyDefaultSelection: localConversationCompatibility.legacyDefaultSelection,
      parseConfig(config: unknown) {
        const parsed = VoiceLocalConversationSchema.safeParse(config);
        return parsed.success ? stripLegacyLocalConversationOwnership(parsed.data) : null;
      },
      migrateLegacy: localConversationCompatibility.migrateLegacy,
      projectLegacy: localConversationCompatibility.projectLegacy,
      mergeLegacy: localConversationCompatibility.mergeLegacy,
    }),
  ]);
}

function extractBundledOwner(raw: unknown): VoiceProviderSettingsOwner | null {
  if (!isRecord(raw) || typeof raw.pluginId !== 'string') return null;
  const publicDeclaration = VoiceProviderContributionSchema.safeParse(raw.declaration);
  if (publicDeclaration.success
    && publicDeclaration.data.settings !== undefined) {
    const providerId = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
      pluginId: raw.pluginId,
      localId: publicDeclaration.data.id,
    }));
    const settings = createExternalVoiceProviderSettingsDescriptor(publicDeclaration.data.settings);
    const releasedCompatibility = getReleasedVoiceSettingsCompatibility(providerId);
    return Object.freeze({
      providerId,
      currentSchemaVersion: settings.schemaVersion,
      defaultConfig: cloneJson(settings.defaultConfig),
      defaultLegacyConfig: cloneJson(releasedCompatibility
        ? releasedCompatibility.defaultLegacyConfig
        : settings.defaultConfig),
      legacyDefaultSelection: releasedCompatibility?.legacyDefaultSelection === true,
      parseConfig: settings.parseConfig,
      ...(releasedCompatibility?.readLegacySecret
        ? { readLegacySecret: releasedCompatibility.readLegacySecret }
        : {}),
      migrateLegacy(config) {
        const migrated = releasedCompatibility?.migrateLegacy(config) ?? null;
        if (!migrated) return null;
        const parsed = settings.parseConfig(migrated.config);
        return parsed === null ? null : Object.freeze({ ...migrated, config: parsed });
      },
      projectLegacy(config, context) {
        const parsed = settings.parseConfig(config);
        return parsed === null ? null : releasedCompatibility?.projectLegacy(parsed, context) ?? null;
      },
      mergeLegacy(currentConfig, migratedConfig) {
        const merged = releasedCompatibility?.mergeLegacy(currentConfig, migratedConfig) ?? migratedConfig;
        return settings.parseConfig(merged);
      },
      ...(releasedCompatibility?.preserveLegacyEnvelope
        ? {
            preserveLegacyEnvelope: releasedCompatibility.preserveLegacyEnvelope,
          }
        : {}),
    });
  }
  return null;
}

export function resolveBundledVoiceProviderSettingsOwner(
  raw: Readonly<{
    pluginId: string;
    declaration?: import('@happier-dev/protocol').VoiceProviderContribution;
  }>,
): VoiceProviderSettingsOwner | null {
  return extractBundledOwner(raw);
}

export function createVoiceProviderSettingsCatalog(input: Readonly<{
  bundledContributions: readonly BundledVoiceManifestContribution[];
}>): VoiceProviderSettingsCatalog {
  const owners = [...createBuiltInOwners()];
  for (const contribution of input.bundledContributions) {
    const owner = extractBundledOwner(contribution);
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
