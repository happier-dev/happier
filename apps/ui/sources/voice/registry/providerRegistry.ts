import {
  createRecipientContractDigestV1,
  normalizeRecipientContractV1,
  PluginVoiceProviderContributionV1Schema,
  VoiceProviderSettingsJsonValueV1Schema,
  VoiceBundledUiDescriptorV1Schema,
  type RecipientContractV1,
  type VoiceBundledUiDescriptorV1,
} from '@happier-dev/protocol';
import type {
  BundledVoiceConversationUiEntry,
  BundledVoiceSpeechEngineUiEntry,
  BundledVoiceUiEntry,
} from '@happier-dev/bundled-voice-runtime-contract';
import { z } from 'zod';

import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import type { ExternalVoiceProviderSettingsDescriptor } from '@/voice/settings/externalProviderSettings';
import {
  createExternalVoiceProviderSettingsDescriptor,
  projectExternalVoiceProviderSettings,
} from '@/voice/settings/externalProviderSettings';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';

const VoiceProviderSettingsProjectionSchema = z.object({
  status: z.enum(['ready', 'needs_migration', 'invalid', 'unsupported_version']),
  modeId: z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u).nullable(),
  requirements: z.array(z.enum([
    'server_feature',
    'execution_machine',
    'credential',
    'endpoint',
    'runtime',
    'model',
  ])).max(6).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'Expected unique requirements' });
    }
  }).optional(),
}).strict();

const VoiceProviderSettingsJsonObjectV1Schema = z.record(
  z.string(),
  VoiceProviderSettingsJsonValueV1Schema,
);

export type VoiceProviderSettingsProjection = z.infer<typeof VoiceProviderSettingsProjectionSchema>;

export type VoiceProviderCredentialReadinessProjection = Readonly<{
  status: 'ready' | 'missing' | 'unknown';
  detailKey: string;
}>;

export type VoiceProviderCredentialReadinessContext = Readonly<{
  accountProfile: unknown;
  savedSecret: Readonly<{
    status: 'ready' | 'missing';
  }>;
}>;

type VoiceUiRuntimeContributionBase = Readonly<{
  projectSettings?: (envelope: Readonly<{ schemaVersion: number; config: unknown }> | null) => VoiceProviderSettingsProjection;
}>;

export type VoiceUiRuntimeContribution =
  | (Extract<VoiceBundledUiDescriptorV1, Readonly<{ kind: 'voice.conversation-provider.v1' }>>
    & VoiceUiRuntimeContributionBase
    & Readonly<{
      declaration?: BundledVoiceConversationUiEntry['declaration'];
      /** Trusted build-time first-party behavior; never projected from public plugin manifests. */
      internal?: Partial<BundledVoiceConversationUiEntry['internal']>;
    }>)
  | (Extract<VoiceBundledUiDescriptorV1, Readonly<{ kind: 'voice.speech-engine.v1' }>>
    & VoiceUiRuntimeContributionBase
    & Readonly<{
      /** Trusted build-time first-party behavior; never projected from public plugin manifests. */
      internal?: Partial<BundledVoiceSpeechEngineUiEntry['internal']>;
    }>)
  | (Extract<VoiceBundledUiDescriptorV1, Readonly<{ kind: 'voice.turn-support.v1' }>>
    & VoiceUiRuntimeContributionBase
    & Readonly<{
      internal?: never;
    }>);

export type VoiceProviderRegistryEntry = VoiceUiRuntimeContribution & Readonly<{
  source:
    | Readonly<{ kind: 'built_in' }>
    | Readonly<{ kind: 'bundled'; pluginId: string }>
    | Readonly<{ kind: 'external'; pluginId: string; localId: string }>;
  /**
   * Host-owned projection of the one currently earned public Voice credential
   * contract. External plugins receive mediated operation results, never this
   * binding or its SavedSecret value.
   */
  accountCredentialSlot?: Readonly<{
    id: string;
    scope: 'account';
    kind: 'apiKey';
    recipientContract: RecipientContractV1;
    recipientContractDigest: string;
  }>;
  /** Declarative, non-secret settings validated by the provider declaration. */
  providerSettings?: ExternalVoiceProviderSettingsDescriptor;
}>;

export type VoiceProviderRegistry = Readonly<{
  get: (providerId: string) => VoiceProviderRegistryEntry | null;
  list: () => readonly VoiceProviderRegistryEntry[];
  getRevision?: () => number;
  subscribe?: (listener: () => void) => () => void;
}>;

const INVALID_SETTINGS_PROJECTION = Object.freeze({
  status: 'invalid' as const,
  modeId: null,
});

/**
 * Sole executable-projector boundary. Bundled modules are trusted first-party
 * code, but their failures and malformed return values must not escape into a
 * generic settings surface or activate a provider.
 */
export function projectVoiceProviderSettings(
  entry: Pick<VoiceProviderRegistryEntry, 'projectSettings'>,
  envelope: Readonly<{ schemaVersion: number; config: unknown }> | null,
): VoiceProviderSettingsProjection | null {
  if (!entry.projectSettings) return null;
  try {
    const projection = VoiceProviderSettingsProjectionSchema.safeParse(entry.projectSettings(envelope));
    return projection.success ? deepFreeze(projection.data) : INVALID_SETTINGS_PROJECTION;
  } catch {
    return INVALID_SETTINGS_PROJECTION;
  }
}

export function projectVoiceProviderCredentialReadiness(
  entry: VoiceProviderRegistryEntry,
  envelope: Readonly<{ schemaVersion: number; config: unknown }> | null,
  context: VoiceProviderCredentialReadinessContext,
): VoiceProviderCredentialReadinessProjection | null {
  if (entry.kind !== 'voice.conversation-provider.v1') return null;
  const projectCredentialReadiness = entry.internal?.projectCredentialReadiness;
  const owner = entry.providerSettings ?? entry.internal?.providerSettings;
  if (!projectCredentialReadiness || !owner) return null;
  try {
    const rawConfig = envelope?.config ?? owner.defaultConfig;
    const config = owner.parseConfig(rawConfig);
    if (!config) return null;
    const projection = projectCredentialReadiness(config, context);
    if (!projection
      || (projection.status !== 'ready'
        && projection.status !== 'missing'
        && projection.status !== 'unknown')
      || typeof projection.detailKey !== 'string'
      || !projection.detailKey.trim()) return null;
    return Object.freeze({
      status: projection.status,
      detailKey: projection.detailKey,
    });
  } catch {
    return null;
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function isConfigPatchMatch(config: unknown, patch: unknown): boolean {
  if (Object.is(config, patch)) return true;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || !config || typeof config !== 'object' || Array.isArray(config)) return false;
  const configRecord = config as Readonly<Record<string, unknown>>;
  return Object.entries(patch as Readonly<Record<string, unknown>>)
    .every(([key, value]) => isConfigPatchMatch(configRecord[key], value));
}

function projectBundledAccountCredentialSlot(
  pluginId: string,
  declaration: Extract<
    NonNullable<BundledVoiceConversationUiEntry['declaration']>,
    Readonly<{ kind: 'conversation' }>
  >,
): NonNullable<VoiceProviderRegistryEntry['accountCredentialSlot']> | null {
  const mediation = declaration.accountMediation;
  if (!mediation || mediation.credentialSlots.length !== 1) return null;
  const slot = mediation.credentialSlots[0]!;
  if (
    slot.scope !== 'account'
    || mediation.operations.some((operation) => operation.credentialSlotId !== slot.id)
  ) return null;
  const recipientContract = createBundledVoiceRecipientContract({
    pluginId,
    declaration,
  });
  if (!recipientContract) return null;
  const normalizedRecipientContract = normalizeRecipientContractV1(recipientContract);
  if (normalizedRecipientContract.credentialSlot.id !== slot.id) return null;
  return Object.freeze({
    id: slot.id,
    scope: 'account' as const,
    kind: 'apiKey' as const,
    recipientContract: normalizedRecipientContract,
    recipientContractDigest: createRecipientContractDigestV1(normalizedRecipientContract),
  });
}

function createBundledDisclosureSettingsOverlay(
  declared: ExternalVoiceProviderSettingsDescriptor,
  internal: NonNullable<BundledVoiceConversationUiEntry['internal']['providerSettings']>,
): ExternalVoiceProviderSettingsDescriptor | null {
  if (
    declared.fields.length !== 0
    || declared.connectedServicesBinding !== null
    || declared.privacyDisclosure === null
    || internal.schemaVersion !== declared.schemaVersion
  ) return null;
  const parsedDefault = VoiceProviderSettingsJsonObjectV1Schema.safeParse(internal.defaultConfig);
  if (!parsedDefault.success) return null;
  return Object.freeze({
    schemaVersion: declared.schemaVersion,
    fields: Object.freeze([]),
    privacyDisclosure: declared.privacyDisclosure,
    connectedServicesBinding: null,
    defaultConfig: parsedDefault.data,
    parseConfig(config: unknown) {
      const parsed = VoiceProviderSettingsJsonValueV1Schema.safeParse(internal.parseConfig(config));
      return parsed.success ? parsed.data : null;
    },
  });
}

function normalizeContribution(
  raw: VoiceUiRuntimeContribution | BundledVoiceUiEntry,
  sourceKind: 'built_in' | 'bundled',
): VoiceProviderRegistryEntry {
  const projectSettings = 'projectSettings' in raw
    ? raw.projectSettings
    : undefined;
  const declaration = raw.kind === 'voice.conversation-provider.v1'
    && 'declaration' in raw
    ? raw.declaration
    : undefined;
  const publicDeclaration = PluginVoiceProviderContributionV1Schema.safeParse(
    declaration,
  );
  const descriptorCandidate = {
    kind: raw.kind,
    pluginId: raw.pluginId,
    providerId: raw.providerId,
    settingsSectionId: raw.settingsSectionId,
    roles: raw.roles,
    requirements: raw.requirements,
    ...('requirementsByMode' in raw && raw.requirementsByMode
      ? { requirementsByMode: raw.requirementsByMode }
      : {}),
    ...('supportedPlatforms' in raw && raw.supportedPlatforms
      ? { supportedPlatforms: raw.supportedPlatforms }
      : {}),
    ...('selectionOptions' in raw && raw.selectionOptions
      ? { selectionOptions: raw.selectionOptions }
      : {}),
    ...(raw.kind === 'voice.speech-engine.v1' ? { role: raw.role } : {}),
  };
  const descriptor = VoiceBundledUiDescriptorV1Schema.safeParse(descriptorCandidate);
  if (!descriptor.success) {
    throw Object.assign(new Error('invalid_voice_provider_descriptor'), {
      code: 'invalid_voice_provider_descriptor',
    });
  }
  if (projectSettings !== undefined && typeof projectSettings !== 'function') {
    throw Object.assign(new Error('invalid_voice_provider_settings_projector'), {
      code: 'invalid_voice_provider_settings_projector',
    });
  }
  const frozenDescriptor = deepFreeze(descriptor.data);
  const publicConversationDeclaration = publicDeclaration.success
    && publicDeclaration.data.kind === 'conversation'
    ? publicDeclaration.data
    : null;
  const declaredProviderSettings = publicConversationDeclaration?.settings
    ? createExternalVoiceProviderSettingsDescriptor(publicConversationDeclaration.settings)
    : null;
  const internalProviderSettings = raw.kind === 'voice.conversation-provider.v1'
    && 'internal' in raw
    ? raw.internal?.providerSettings ?? null
    : null;
  const hasDisclosureOnlyInternalSettings = Boolean(publicConversationDeclaration?.settings
    && publicConversationDeclaration.settings.fields.length === 0
    && !publicConversationDeclaration.settings.connectedServicesBinding
    && publicConversationDeclaration.settings.privacyDisclosure
    && declaredProviderSettings
    && internalProviderSettings);
  const disclosureOnlySettings = hasDisclosureOnlyInternalSettings
    && declaredProviderSettings
    && internalProviderSettings
    ? createBundledDisclosureSettingsOverlay(declaredProviderSettings, internalProviderSettings)
    : null;
  if (hasDisclosureOnlyInternalSettings && !disclosureOnlySettings) {
    throw Object.assign(new Error('invalid_voice_provider_settings'), {
      code: 'invalid_voice_provider_settings',
    });
  }
  const publicProviderSettings = hasDisclosureOnlyInternalSettings
    ? disclosureOnlySettings
    : declaredProviderSettings;
  const accountCredentialSlot = sourceKind === 'bundled' && publicConversationDeclaration
    ? projectBundledAccountCredentialSlot(raw.pluginId, publicConversationDeclaration)
    : null;
  const effectiveProjectSettings = publicProviderSettings && !disclosureOnlySettings
    ? (
        envelope: Readonly<{ schemaVersion: number; config: unknown }> | null,
      ) => {
        const projection = projectExternalVoiceProviderSettings(envelope, publicProviderSettings);
        if (projection.status !== 'ready') return projection;
        const parsedConfig = publicProviderSettings.parseConfig(envelope?.config);
        const selectedMode = frozenDescriptor.selectionOptions?.find(
          (option) => option.configPatch && isConfigPatchMatch(parsedConfig, option.configPatch),
        )?.modeId;
        return Object.freeze({
          ...projection,
          modeId: selectedMode ?? frozenDescriptor.selectionOptions?.[0]?.modeId ?? projection.modeId,
        });
      }
    : typeof projectSettings === 'function'
      ? projectSettings
      : null;
  const source = sourceKind === 'built_in'
    ? Object.freeze({ kind: 'built_in' as const })
    : Object.freeze({ kind: 'bundled' as const, pluginId: descriptor.data.pluginId });
  const common = {
    ...(effectiveProjectSettings
      ? { projectSettings: effectiveProjectSettings }
      : {}),
    ...(publicProviderSettings
      ? { providerSettings: publicProviderSettings }
      : {}),
    ...(accountCredentialSlot ? { accountCredentialSlot } : {}),
    source,
  };
  if (frozenDescriptor.kind === 'voice.conversation-provider.v1'
    && raw.kind === 'voice.conversation-provider.v1') {
    const internal = 'internal' in raw ? raw.internal : undefined;
    return Object.freeze({
      ...frozenDescriptor,
      ...common,
      ...(publicConversationDeclaration
        ? { declaration: publicConversationDeclaration }
        : {}),
      ...(internal === undefined ? {} : { internal }),
    });
  }
  if (frozenDescriptor.kind === 'voice.speech-engine.v1'
    && raw.kind === 'voice.speech-engine.v1') {
    const internal = 'internal' in raw ? raw.internal : undefined;
    return Object.freeze({
      ...frozenDescriptor,
      ...common,
      ...(internal === undefined ? {} : { internal }),
    });
  }
  if (frozenDescriptor.kind === 'voice.turn-support.v1'
    && raw.kind === 'voice.turn-support.v1') {
    return Object.freeze({
      ...frozenDescriptor,
      ...common,
    });
  }
  throw Object.assign(new Error('invalid_voice_provider_descriptor'), {
    code: 'invalid_voice_provider_descriptor',
  });
}

export function createVoiceProviderRegistry(input: Readonly<{
  builtIn?: readonly (VoiceUiRuntimeContribution | BundledVoiceUiEntry)[];
  bundled?: readonly (VoiceUiRuntimeContribution | BundledVoiceUiEntry)[];
  enabledPluginIds?: ReadonlySet<string> | null;
}>): VoiceProviderRegistry {
  const enabledPluginIds = input.enabledPluginIds ?? null;
  const normalized = [
    ...(input.builtIn ?? []).map((entry) => normalizeContribution(entry, 'built_in')),
    ...(input.bundled ?? [])
      .map((entry) => normalizeContribution(entry, 'bundled'))
      .filter((entry) => enabledPluginIds === null || enabledPluginIds.has(entry.pluginId)),
  ].sort((left, right) => left.providerId.localeCompare(right.providerId));

  const entries = new Map<string, VoiceProviderRegistryEntry>();
  for (const entry of normalized) {
    if (entries.has(entry.providerId)) {
      throw Object.assign(new Error(`duplicate_voice_provider_id:${entry.providerId}`), {
        code: 'duplicate_voice_provider_id',
      });
    }
    entries.set(entry.providerId, entry);
  }
  const list = Object.freeze([...entries.values()]);
  return Object.freeze({
    get(providerId: string): VoiceProviderRegistryEntry | null {
      const normalizedId = normalizeNonEmptyString(providerId);
      return normalizedId ? entries.get(normalizedId) ?? null : null;
    },
    list(): readonly VoiceProviderRegistryEntry[] {
      return list;
    },
    getRevision: () => 0,
    subscribe: () => () => {},
  });
}
