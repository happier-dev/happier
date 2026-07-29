import type {
  BundledVoiceConversationClient,
  BundledVoiceConversationListedVoice,
  BundledVoiceConversationSettingsDescriptor,
  BundledVoiceSettingsConfig,
} from '@happier-dev/bundled-voice-runtime-contract';
import {
  PluginVoiceProviderContributionV1Schema,
  VoiceRealtimeJsonValueSchema,
} from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import {
  readVoiceProviderSettingsConfig,
  writeVoiceProviderSettingsConfig,
} from '@/sync/domains/settings/voiceSettings';
import { resolveUiVoicePromptStackBlocks } from '@/voice/agent/resolveUiVoicePromptStackBlocks';
import { getBundledVoiceUiEntry } from '@/voice/registry/internalContributions';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';
import { getExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { resolveBundledVoiceProviderSettingsOwner } from '@/voice/settings/providerSettings';
import {
  resolveDisabledVoiceActionIdsFromState,
} from '@/voice/tools/resolveDisabledVoiceActionIds';

import { createAccountVoiceOperationService } from './accountVoiceOperationService';
import { createBundledVoiceRecipientContract } from './voiceRecipientContract';

export type BundledConversationVoiceCatalogItem = BundledVoiceConversationListedVoice;

export type BundledConversationTtsConfigInput = Readonly<{
  voiceId?: string | null;
  modelId?: string | null;
  voiceSettings?: BundledVoiceSettingsConfig | null;
}>;

export type BundledConversationProviderClient = BundledVoiceConversationClient;

type Autoprovision = Readonly<{
  findExistingAgents(signal: AbortSignal): Promise<Array<{ agentId: string; name: string }>>;
  createAgent(
    params: { tts?: BundledConversationTtsConfigInput | null },
    signal: AbortSignal,
  ): Promise<{ agentId: string }>;
  updateAgent(
    params: { agentId: string; tts?: BundledConversationTtsConfigInput | null },
    signal: AbortSignal,
  ): Promise<void>;
}>;

export type BundledConversationSettings = Readonly<{
  billingMode: string;
  tts: Readonly<{
    voiceId: string;
    modelId: string | null;
    voiceSettings: Readonly<{
      stability: number | null;
      similarityBoost: number | null;
      style: number | null;
      useSpeakerBoost: boolean | null;
      speed: number | null;
    }>;
  }>;
  byo: Readonly<{ agentId: string | null }>;
}>;

type GenericSettingsOwner = Readonly<{
  currentSchemaVersion: number;
  defaultConfig: BundledVoiceSettingsConfig;
  parseConfig(value: unknown): BundledVoiceSettingsConfig | null;
  readLegacySecret?(value: unknown): unknown | null;
  migrateLegacy?(value: unknown): Readonly<{ config: BundledVoiceSettingsConfig; root?: unknown }> | null;
}>;

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSettingsConfig(value: unknown): value is BundledVoiceSettingsConfig {
  return isObject(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isBundledConversationSettings(value: unknown): value is BundledConversationSettings {
  if (!isObject(value) || !('billingMode' in value) || typeof value.billingMode !== 'string'
    || !('byo' in value) || !('tts' in value)) return false;
  const byo = value.byo;
  const tts = value.tts;
  if (!isObject(byo) || !('agentId' in byo)
    || (byo.agentId !== null && typeof byo.agentId !== 'string')) return false;
  if (!isObject(tts)
    || !('voiceId' in tts)
    || !('modelId' in tts)
    || !('voiceSettings' in tts)
    || typeof tts.voiceId !== 'string'
    || (tts.modelId !== null && typeof tts.modelId !== 'string')
    || !isObject(tts.voiceSettings)) return false;
  const voiceSettings = tts.voiceSettings;
  if (!('stability' in voiceSettings)
    || !('similarityBoost' in voiceSettings)
    || !('style' in voiceSettings)
    || !('useSpeakerBoost' in voiceSettings)
    || !('speed' in voiceSettings)) return false;
  return isNullableNumber(voiceSettings.stability)
    && isNullableNumber(voiceSettings.similarityBoost)
    && isNullableNumber(voiceSettings.style)
    && (voiceSettings.useSpeakerBoost === null || typeof voiceSettings.useSpeakerBoost === 'boolean')
    && isNullableNumber(voiceSettings.speed);
}

export function readBundledConversationProviderSettings(
  settings: Pick<VoiceSettings, 'providers'>,
  providerId: string,
): BundledConversationSettings | null {
  const entry = getBundledVoiceUiEntry(providerId);
  if (!entry || entry.kind !== 'voice.conversation-provider.v1') return null;
  const settingsOwner = resolveBundledVoiceProviderSettingsOwner(entry);
  if (!settingsOwner) return null;
  const parsed = readVoiceProviderSettingsConfig(settings, providerId);
  const config = settingsOwner.parseConfig(parsed) ?? settingsOwner.defaultConfig;
  return isBundledConversationSettings(config) ? config : null;
}

export function writeBundledConversationProviderSettings(
  settings: VoiceSettings,
  providerId: string,
  config: BundledConversationSettings,
): VoiceSettings {
  return writeVoiceProviderSettingsConfig(settings, providerId, config);
}

export function createBundledConversationUi(providerId: string): Readonly<{
  client: BundledConversationProviderClient | null;
  autoprovision: Autoprovision | null;
  settingsDescriptor: BundledVoiceConversationSettingsDescriptor;
  settingsOwner: GenericSettingsOwner;
}> | null {
  const entry = getBundledVoiceUiEntry(providerId);
  if (!entry || entry.kind !== 'voice.conversation-provider.v1') return null;
  const internal = entry.internal;
  const rawSettingsOwner = resolveBundledVoiceProviderSettingsOwner(entry);
  if (!rawSettingsOwner) return null;

  if (typeof internal.createSettingsSection !== 'function') return null;
  const settingsDescriptor = internal.createSettingsSection();
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

  const readCurrentProviderConfig = (): BundledVoiceSettingsConfig => {
    const state = storage.getState() as Readonly<{
      settings?: Readonly<{ voice?: Pick<VoiceSettings, 'providers'> }>;
    }>;
    const current = state.settings?.voice
      ? readVoiceProviderSettingsConfig(state.settings.voice, providerId)
      : null;
    return settingsOwner.parseConfig(current) ?? settingsOwner.defaultConfig;
  };
  const settingsOperations = getExternalVoiceProviderRegistration(providerId)?.settingsOperations;
  const publicClient: BundledConversationProviderClient | null = settingsOperations?.listCatalog
    ? Object.freeze({
        async fetchVoiceCatalog(signal?: AbortSignal | null) {
          const operationSignal = signal ?? new AbortController().signal;
          const items = await settingsOperations.listCatalog!({
            catalog: 'voices',
            providerConfig: VoiceRealtimeJsonValueSchema.parse(readCurrentProviderConfig()),
            signal: operationSignal,
          });
          return items.flatMap((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
            const row = item as Readonly<Record<string, unknown>>;
            return typeof row.id === 'string' && typeof row.name === 'string'
              ? [{ id: row.id, name: row.name, metadata: row.metadata }]
              : [];
          });
        },
      })
    : null;
  const accountOperationEntry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(
    (candidate) => candidate.uiEntry.providerId === providerId,
  ) ?? null;
  const accountOperationDeclaration = accountOperationEntry
    ? PluginVoiceProviderContributionV1Schema.safeParse(accountOperationEntry.uiEntry.declaration)
    : null;
  const recipientContract = accountOperationEntry
    && accountOperationDeclaration?.success
    && accountOperationDeclaration.data.kind === 'conversation'
    ? createBundledVoiceRecipientContract({
        pluginId: accountOperationEntry.uiEntry.pluginId,
        declaration: accountOperationDeclaration.data,
      })
    : null;
  const legacyClient = !publicClient
    && recipientContract
    && 'createAccountOperationClient' in internal
    && typeof internal.createAccountOperationClient === 'function'
    ? internal.createAccountOperationClient({
        createAccountOperations: (signal) => createAccountVoiceOperationService({
          providerId,
          recipientContract,
          signal,
          isCurrent: () => !signal.aborted,
        }),
      })
    : null;
  const client = publicClient ?? legacyClient;
  let autoprovision: Autoprovision | null = null;
  if (settingsOperations?.provision) {
    const provision = async (
      request: unknown,
      signal: AbortSignal,
    ): Promise<Readonly<Record<string, unknown>>> => {
      const state = storage.getState() as Readonly<{ settings?: unknown }>;
      const result = await settingsOperations.provision!({
        request: VoiceRealtimeJsonValueSchema.parse(request),
        providerConfig: VoiceRealtimeJsonValueSchema.parse(readCurrentProviderConfig()),
        disabledActionIds: resolveDisabledVoiceActionIdsFromState(state),
        extraSystemAppendBlocks: await resolveUiVoicePromptStackBlocks(),
        signal,
      });
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('voice_provider_response_invalid');
      }
      return result as Readonly<Record<string, unknown>>;
    };
    autoprovision = Object.freeze({
      async findExistingAgents(signal) {
        const response = await provision({ kind: 'list' }, signal);
        return Array.isArray(response.agents)
          ? response.agents.flatMap((value) => {
              if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
              const row = value as Readonly<Record<string, unknown>>;
              return typeof row.agentId === 'string' && typeof row.name === 'string'
                ? [{ agentId: row.agentId, name: row.name }]
                : [];
            })
          : [];
      },
      async createAgent(_params, signal) {
        const response = await provision({ kind: 'create' }, signal);
        if (typeof response.agentId !== 'string') throw new Error('voice_provider_response_invalid');
        return Object.freeze({ agentId: response.agentId });
      },
      async updateAgent(params, signal) {
        const response = await provision({ kind: 'update', agentId: params.agentId }, signal);
        if (response.updated !== true) throw new Error('voice_provider_response_invalid');
      },
    });
  }

  return Object.freeze({
    client,
    autoprovision,
    settingsDescriptor,
    settingsOwner,
  });
}
