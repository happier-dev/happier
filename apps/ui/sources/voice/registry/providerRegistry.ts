import {
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
  createRecipientContractDigestV1,
  normalizeRecipientContractV1,
  VoiceProviderContributionSchema,
  VoiceProviderSettingsJsonValueV1Schema,
  type RecipientContractV1,
  type VoiceProviderContribution,
  type VoiceReadinessRequirement,
  type VoiceReadinessRole,
  type VoiceRuntimePlatform,
} from '@happier-dev/protocol';
import { z } from 'zod';

import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import type { ExternalVoiceProviderSettingsDescriptor } from '@/voice/settings/externalProviderSettings';
import {
  createExternalVoiceProviderSettingsDescriptor,
  projectExternalVoiceProviderSettings,
} from '@/voice/settings/externalProviderSettings';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import type { VoiceConnectedAccountTargetEligibility } from '@/voice/credentials/sourceEligibility';
import type { BundledVoiceManifestContribution } from './bundledVoiceManifestProjection';
import {
  indexVoiceProviderPresentations,
} from './bundledVoiceManifestProjection';
import type { VoiceProviderPresentation } from './voiceProviderPresentation';

const VoiceProviderSettingsProjectionSchema = z.object({
  status: z.enum([
    'ready',
    'missing_required_setting',
    'needs_migration',
    'invalid',
    'unsupported_version',
  ]),
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

export function isVoiceProviderSettingsProjectionCurrent(
  projection: VoiceProviderSettingsProjection | null | undefined,
): projection is VoiceProviderSettingsProjection & Readonly<{
  status: 'ready' | 'missing_required_setting';
}> {
  return projection?.status === 'ready' || projection?.status === 'missing_required_setting';
}

export type VoiceProviderCredentialReadinessProjection = Readonly<{
  status: 'ready' | 'missing' | 'unknown';
  detailKey: string;
}>;

export type VoiceProviderCredentialReadinessContext = Readonly<{
  sourceSelection: Readonly<{
    kind: 'none' | 'savedSecret' | 'connectedAccount';
    connectedAccountEligibility: VoiceConnectedAccountTargetEligibility;
  }> | null;
  savedSecret: Readonly<{
    /**
     * `unknown` when the account-settings snapshot could not be resolved at
     * all. It is not absence: reporting `missing` there accuses a SavedSecret
     * that may be stored and working.
     */
    status: 'ready' | 'missing' | 'unknown';
  }>;
}>;

type VoiceProviderSelectionOption = Readonly<{
  id: string;
  modeId: string | null;
  order: number;
  titleKey: string;
  subtitleKey: string;
  configPatch?: Readonly<Record<string, unknown>>;
}>;

type VoiceUiRuntimeContributionBase = Readonly<{
  pluginId: string;
  providerId: string;
  settingsSectionId: string;
  roles: readonly VoiceReadinessRole[];
  requirements: readonly VoiceReadinessRequirement[];
  requirementsByMode?: Readonly<Record<string, readonly VoiceReadinessRequirement[]>>;
  supportedPlatforms?: readonly VoiceRuntimePlatform[];
  selectionOptions?: readonly VoiceProviderSelectionOption[];
  projectSettings?: (envelope: Readonly<{ schemaVersion: number; config: unknown }> | null) => VoiceProviderSettingsProjection;
  /** Trusted host-only readiness source; never projected from public plugin manifests. */
  localReadiness?: Readonly<{
    kind: 'device_speech';
  }>;
  /** Trusted host-owned processing truth for built-in speech roles. */
  processingDisclosures?: Readonly<Partial<Record<'stt' | 'tts', Readonly<{
    titleKey: string;
    disclosureKey: string;
  }>>>>;
}>;

export type VoiceUiRuntimeContribution =
  | (VoiceUiRuntimeContributionBase & Readonly<{
      kind: 'voice.conversation-provider.v1';
      declaration?: Extract<VoiceProviderContribution, Readonly<{ kind: 'conversation' }>>;
      presentation?: VoiceProviderPresentation;
    }>)
  | (VoiceUiRuntimeContributionBase & Readonly<{
      kind: 'voice.speech-engine.v1';
      role: 'stt' | 'tts' | 'both';
      declaration?: Extract<VoiceProviderContribution, Readonly<{ kind: 'speech' }>>;
      catalogs?: Extract<VoiceProviderContribution, Readonly<{ kind: 'speech' }>>['catalogs'];
      limits?: Extract<VoiceProviderContribution, Readonly<{ kind: 'speech' }>>['limits'];
      presentation?: VoiceProviderPresentation;
    }>)
  | (VoiceUiRuntimeContributionBase & Readonly<{
      kind: 'voice.turn-support.v1';
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
  const credentials = entry.declaration?.credentials;
  if (!credentials || credentials.requirement.kind === 'optional') return null;
  try {
    if (credentials.requirement.kind === 'when_setting_equals') {
      const owner = entry.providerSettings;
      const config = owner?.parseConfig(envelope?.config ?? owner.defaultConfig);
      if (!config || (config as Readonly<Record<string, unknown>>)[credentials.requirement.settingId]
        !== credentials.requirement.value) return null;
    }
    if (!context.sourceSelection) {
      return Object.freeze({
        status: 'unknown',
        detailKey: 'voice.readiness.credential_unknown',
      });
    }
    const status: VoiceProviderCredentialReadinessProjection['status'] = context.sourceSelection.kind === 'savedSecret'
      ? context.savedSecret.status
      : context.sourceSelection.kind === 'connectedAccount'
        ? context.sourceSelection.connectedAccountEligibility === 'usable'
          ? 'ready'
          // A bound account whose descriptor is unavailable is unverified, not
          // absent. Reporting it as missing would tell the user to add a
          // credential that already exists.
          : context.sourceSelection.connectedAccountEligibility === 'unknown'
            ? 'unknown'
            : 'missing'
        : 'missing';
    return Object.freeze({
      status,
      detailKey: status === 'ready'
        ? 'settingsVoice.externalCredentials.ready'
        : status === 'unknown'
          ? 'voice.readiness.credential_unknown'
          : 'settingsVoice.externalCredentials.missing',
    });
  } catch {
    return Object.freeze({
      status: 'unknown',
      detailKey: 'voice.readiness.credential_unknown',
    });
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
  declaration: Extract<VoiceProviderContribution, Readonly<{ kind: 'conversation' }>>,
): NonNullable<VoiceProviderRegistryEntry['accountCredentialSlot']> | null {
  const credentials = declaration.credentials;
  if (!credentials?.hostMediated
    || !credentials.sources.some((source) => (
      source.kind === 'savedSecret' && source.secretKinds.includes('apiKey')
    ))) return null;
  const slot = credentials.slot;
  if (credentials.hostMediated.operations.some((operation) => operation.credentialSlotId !== slot.id)) return null;
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

function isNonEmptySetting(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== null && value !== undefined;
}

function projectDeclaredSettingsReadiness(
  declaration: VoiceProviderContribution,
  config: Readonly<Record<string, unknown>>,
): 'ready' | 'missing_required_setting' {
  const readiness = declaration.settings?.readiness ?? [];
  for (const requirement of readiness) {
    if (requirement.when
      && config[requirement.when.settingId] !== requirement.when.equals) continue;
    if (!isNonEmptySetting(config[requirement.settingId])) return 'missing_required_setting';
  }
  return 'ready';
}

export function projectVoiceProviderDeclarationRequirements(
  declaration: VoiceProviderContribution,
): readonly VoiceReadinessRequirement[] {
  const requirements: VoiceReadinessRequirement[] = [];
  if (declaration.kind === 'speech') requirements.push('execution_machine');
  if (declaration.kind === 'conversation'
    && declaration.execution?.kind === 'experimental_agent_session_realtime') {
    requirements.push('execution_machine', 'runtime');
  }
  if (declaration.kind === 'speech'
    && declaration.settings?.fields.some((field) => field.id === 'baseUrl')) {
    requirements.push('endpoint');
  }
  if (declaration.credentials && declaration.credentials.requirement.kind !== 'optional') {
    requirements.push('credential');
  }
  return Object.freeze(requirements);
}

function deriveRequirementsByMode(
  declaration: Extract<VoiceProviderContribution, Readonly<{ kind: 'conversation' }>>,
  selectionOptions: readonly VoiceProviderSelectionOption[],
): Readonly<Record<string, readonly VoiceReadinessRequirement[]>> | undefined {
  const requirement = declaration.credentials?.requirement;
  if (requirement?.kind !== 'when_setting_equals') return undefined;
  return Object.freeze(Object.fromEntries(selectionOptions.flatMap((option) => option.modeId
    ? [[option.modeId, Object.freeze([
        ...(option.configPatch?.[requirement.settingId] === requirement.value ? ['credential' as const] : []),
      ])] as const]
    : [])));
}

/**
 * The one declaration-driven settings projector. Bundled and external
 * descriptors share it so a declared `settings.readiness` rule and the selected
 * mode are answered from the manifest, never from where the contribution came
 * from.
 */
export function createDeclaredSettingsProjector(
  declaration: VoiceProviderContribution,
  providerSettings: ExternalVoiceProviderSettingsDescriptor,
  selectionOptions: readonly VoiceProviderSelectionOption[],
) {
  return (envelope: Readonly<{ schemaVersion: number; config: unknown }> | null) => {
    const projection = projectExternalVoiceProviderSettings(envelope, providerSettings);
    if (!isVoiceProviderSettingsProjectionCurrent(projection)) return projection;
    const parsedConfig = providerSettings.parseConfig(envelope?.config);
    const parsedConfigObject = VoiceProviderSettingsJsonObjectV1Schema.safeParse(parsedConfig);
    if (!parsedConfigObject.success) return INVALID_SETTINGS_PROJECTION;
    const selectedMode = selectionOptions.find(
      (option) => option.configPatch && isConfigPatchMatch(parsedConfigObject.data, option.configPatch),
    )?.modeId ?? selectionOptions[0]?.modeId ?? projection.modeId;
    return Object.freeze({
      ...projection,
      status: projection.status === 'ready'
        ? projectDeclaredSettingsReadiness(declaration, parsedConfigObject.data)
        : projection.status,
      modeId: selectedMode,
    });
  };
}

function normalizeBuiltInContribution(raw: VoiceUiRuntimeContribution): VoiceProviderRegistryEntry {
  const providerId = normalizeNonEmptyString(raw.providerId);
  const pluginId = normalizeNonEmptyString(raw.pluginId);
  const settingsSectionId = normalizeNonEmptyString(raw.settingsSectionId);
  if (!providerId || !pluginId || !settingsSectionId || raw.roles.length === 0) {
    throw Object.assign(new Error('invalid_voice_provider_descriptor'), {
      code: 'invalid_voice_provider_descriptor',
    });
  }
  return deepFreeze({
    ...raw,
    providerId,
    pluginId,
    settingsSectionId,
    source: Object.freeze({ kind: 'built_in' as const }),
  }) as VoiceProviderRegistryEntry;
}

function normalizeBundledContribution(
  raw: BundledVoiceManifestContribution,
  presentation: VoiceProviderPresentation,
): VoiceProviderRegistryEntry {
  const declaration = VoiceProviderContributionSchema.parse(raw.declaration);
  const providerId = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
    pluginId: raw.pluginId,
    localId: declaration.id,
  }));
  if (providerId !== raw.providerId || presentation.providerId !== providerId) {
    throw Object.assign(new Error('invalid_voice_provider_presentation_identity'), {
      code: 'invalid_voice_provider_presentation_identity',
    });
  }
  const providerSettings = declaration.settings
    ? createExternalVoiceProviderSettingsDescriptor(declaration.settings)
    : null;
  const selectionOptions = declaration.kind === 'conversation'
    ? deepFreeze([...(presentation.selectionOptions ?? [])])
    : Object.freeze([]);
  const requirements = projectVoiceProviderDeclarationRequirements(declaration);
  const common = {
    pluginId: raw.pluginId,
    providerId,
    settingsSectionId: presentation.settingsSectionId,
    roles: deepFreeze([...declaration.roles]),
    requirements,
    supportedPlatforms: deepFreeze([...declaration.platforms]),
    ...(selectionOptions.length > 0 ? { selectionOptions } : {}),
    ...(providerSettings
      ? {
          providerSettings,
          projectSettings: createDeclaredSettingsProjector(
            declaration,
            providerSettings,
            selectionOptions,
          ),
        }
      : {}),
    declaration,
    source: Object.freeze({ kind: 'bundled' as const, pluginId: raw.pluginId }),
  };
  if (declaration.kind === 'conversation') {
    const requirementsByMode = deriveRequirementsByMode(declaration, selectionOptions);
    const accountCredentialSlot = projectBundledAccountCredentialSlot(raw.pluginId, declaration);
    return deepFreeze({
      kind: 'voice.conversation-provider.v1' as const,
      ...common,
      ...(requirementsByMode ? { requirementsByMode } : {}),
      ...(accountCredentialSlot ? { accountCredentialSlot } : {}),
      presentation,
    }) as VoiceProviderRegistryEntry;
  }
  if (declaration.kind === 'speech') {
    const hasStt = declaration.roles.some((role) => role.endsWith('_stt'));
    const hasTts = declaration.roles.some((role) => role.endsWith('_tts'));
    return deepFreeze({
      kind: 'voice.speech-engine.v1' as const,
      ...common,
      role: hasStt && hasTts ? 'both' : hasTts ? 'tts' : 'stt',
      catalogs: declaration.catalogs,
      limits: declaration.limits,
      presentation,
    }) as VoiceProviderRegistryEntry;
  }
  throw Object.assign(new Error('invalid_voice_provider_descriptor'), {
    code: 'invalid_voice_provider_descriptor',
  });
}

export function createVoiceProviderRegistry(input: Readonly<{
  builtIn?: readonly VoiceUiRuntimeContribution[];
  bundledContributions?: readonly BundledVoiceManifestContribution[];
  bundledPresentations?: readonly VoiceProviderPresentation[];
  enabledPluginIds?: ReadonlySet<string> | null;
}>): VoiceProviderRegistry {
  const enabledPluginIds = input.enabledPluginIds ?? null;
  const bundledPresentations = indexVoiceProviderPresentations(input.bundledPresentations ?? []);
  const normalized = [
    ...(input.builtIn ?? []).map(normalizeBuiltInContribution),
    ...(input.bundledContributions ?? [])
      .map((entry) => {
        const presentation = bundledPresentations.get(entry.providerId);
        if (!presentation) {
          throw Object.assign(new Error(`missing_voice_provider_presentation:${entry.providerId}`), {
            code: 'missing_voice_provider_presentation',
          });
        }
        return normalizeBundledContribution(entry, presentation);
      })
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
