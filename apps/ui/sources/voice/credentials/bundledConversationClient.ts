import {
  VoiceRealtimeJsonValueSchema,
} from '@happier-dev/protocol/voice/realtime/events';

import { storage } from '@/sync/domains/state/storage';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { readVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { getBundledVoiceProviderEntry } from '@/voice/registry/internalContributions';
import { getExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { resolveBundledVoiceProviderSettingsOwner } from '@/voice/settings/providerSettings';

export type BundledConversationVoiceCatalogItem = Readonly<{
  id: string;
  name: string;
  metadata?: unknown;
}>;

export type BundledConversationProviderClient = Readonly<{
  fetchVoiceCatalog(signal?: AbortSignal | null): Promise<readonly BundledConversationVoiceCatalogItem[]>;
}>;

type BundledVoiceSettingsConfig = Readonly<Record<string, unknown>>;

/** One contribution-owned catalog port for settings UI and Actions. */
export function createVoiceSettingsCatalogClient(providerId: string, readCurrentProviderConfig: () => BundledVoiceSettingsConfig): BundledConversationProviderClient | null {
  const settingsOperations = getExternalVoiceProviderRegistration(providerId)?.settingsOperations;
  return settingsOperations?.listCatalog ? Object.freeze({
    async fetchVoiceCatalog(signal?: AbortSignal | null) {
      const items = await settingsOperations.listCatalog!({ catalog: 'voices',
        providerConfig: VoiceRealtimeJsonValueSchema.parse(readCurrentProviderConfig()), signal: signal ?? new AbortController().signal });
      return items.flatMap(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const row = item as Readonly<Record<string, unknown>>;
        return typeof row.id === 'string' && typeof row.name === 'string' ? [{ id: row.id, name: row.name, metadata: row.metadata }] : [];
      });
    },
  }) : null;
}

type GenericSettingsOwner = Readonly<{
  currentSchemaVersion: number;
  defaultConfig: Readonly<Record<string, unknown>>;
  parseConfig(value: unknown): Readonly<Record<string, unknown>> | null;
  readLegacySecret?(value: unknown): unknown | null;
  migrateLegacy?(value: unknown): Readonly<{ config: BundledVoiceSettingsConfig; root?: unknown }> | null;
}>;

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSettingsConfig(value: unknown): value is BundledVoiceSettingsConfig {
  return isObject(value);
}

export function createBundledConversationUi(providerId: string): Readonly<{
  client: BundledConversationProviderClient | null;
  settingsDescriptor: unknown;
  settingsOwner: GenericSettingsOwner;
}> | null {
  const entry = getBundledVoiceProviderEntry(providerId);
  if (!entry || entry.kind !== 'voice.conversation-provider.v1') return null;
  const rawSettingsOwner = resolveBundledVoiceProviderSettingsOwner(entry);
  if (!rawSettingsOwner) return null;

  const settingsDescriptor = entry.providerSettings?.presentation;
  if (!settingsDescriptor) return null;
  if (!isSettingsConfig(rawSettingsOwner.defaultConfig)) return null;

  const settingsOwner: GenericSettingsOwner = Object.freeze({
    currentSchemaVersion: rawSettingsOwner.currentSchemaVersion,
    defaultConfig: rawSettingsOwner.defaultConfig,
    parseConfig(value: unknown) {
      const parsed = rawSettingsOwner.parseConfig(value);
      return isSettingsConfig(parsed) ? parsed : null;
    },
    ...('readLegacySecret' in rawSettingsOwner && typeof rawSettingsOwner.readLegacySecret === 'function'
      ? { readLegacySecret: rawSettingsOwner.readLegacySecret }
      : {}),
    ...(typeof rawSettingsOwner.migrateLegacy === 'function'
      ? {
          migrateLegacy(value: unknown) {
            const migrated = rawSettingsOwner.migrateLegacy(value);
            return migrated && isSettingsConfig(migrated.config)
              ? { ...migrated, config: migrated.config }
              : null;
          },
        }
      : {}),
  });
  if (!settingsOwner.parseConfig(settingsOwner.defaultConfig)) return null;

  const readCurrentProviderConfig = (): Readonly<Record<string, unknown>> => {
    const state = storage.getState() as Readonly<{
      settings?: Readonly<{ voice?: Pick<VoiceSettings, 'providers'> }>;
    }>;
    const current = state.settings?.voice
      ? readVoiceProviderSettingsConfig(state.settings.voice, providerId)
      : null;
    return settingsOwner.parseConfig(current) ?? settingsOwner.defaultConfig;
  };
  const publicClient = createVoiceSettingsCatalogClient(providerId, readCurrentProviderConfig);
  return Object.freeze({
    client: publicClient,
    settingsDescriptor,
    settingsOwner,
  });
}
