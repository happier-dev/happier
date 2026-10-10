import { isVoiceProviderSettingsProjectionCurrent, projectVoiceProviderSettings, projectVoiceProviderDeclarationRegistryBase, type VoiceProviderSettingsProjection, type VoiceProviderSelectionOption } from '@happier-dev/protocol/voice/settings/providerRegistry';
export { isVoiceProviderSettingsProjectionCurrent, projectVoiceProviderSettings, projectVoiceProviderDeclarationRequirements, projectVoiceProviderDeclarationRegistryBase, createDeclaredSettingsProjector, type VoiceProviderSettingsProjection, type VoiceProviderSelectionOption } from '@happier-dev/protocol/voice/settings/providerRegistry';
import { buildQualifiedPluginContributionKey, createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { createRecipientContractDigestV1, normalizeRecipientContractV1, type RecipientContractV1 } from '@happier-dev/protocol/plugins/recipientContractV1';
import { VoiceProviderContributionSchema, type VoiceProviderContribution } from '@happier-dev/protocol/plugins/contributions/voice';
import type { VoiceReadinessRequirement, VoiceReadinessRole, VoiceRuntimePlatform } from '@happier-dev/protocol/voice/realtime/capabilities';
import type { VoiceServiceMark } from '@happier-dev/plugin-sdk/voice';

import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import type { ExternalVoiceProviderSettingsDescriptor } from '@/voice/settings/externalProviderSettings';
import {
  createExternalVoiceProviderSettingsDescriptor,
} from '@/voice/settings/externalProviderSettings';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import type { VoiceConnectedAccountTargetEligibility } from '@/voice/credentials/sourceEligibility';
import type { BundledVoiceManifestContribution } from './bundledVoiceManifestProjection';
import {
  indexVoiceProviderPresentations,
} from './bundledVoiceManifestProjection';
import type { VoiceProviderPresentation } from './voiceProviderPresentation';

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

type VoiceUiRuntimeContributionBase = Readonly<{
  pluginId: string;
  providerId: string;
  settingsSectionId: string;
  roles: readonly VoiceReadinessRole[];
  requirements: readonly VoiceReadinessRequirement[];
  requirementsByMode?: Readonly<Record<string, readonly VoiceReadinessRequirement[]>>;
  supportedPlatforms?: readonly VoiceRuntimePlatform[];
  selectionOptions?: readonly VoiceProviderSelectionOption[];
  presentation?: VoiceProviderPresentation;
  mark?: VoiceServiceMark;
  projectSettings?: (envelope: Readonly<{ schemaVersion: number; config: unknown }> | null) => VoiceProviderSettingsProjection;
  /** Trusted host-only readiness source; never projected from public plugin manifests. */
  localReadiness?: Readonly<{
    kind: 'device_speech';
  }>;
  /** Trusted host-owned processing truth for built-in speech roles. */
  processingDisclosures?: Readonly<Partial<Record<'stt' | 'tts', Readonly<{
    titleKey: string;
    disclosureKey: string;
    facts?: NonNullable<ExternalVoiceProviderSettingsDescriptor['privacyFacts']>;
  }>>>>;
}>;

export type VoiceUiRuntimeContribution =
  | (VoiceUiRuntimeContributionBase & Readonly<{
      kind: 'voice.conversation-provider.v1';
      declaration?: Extract<VoiceProviderContribution, Readonly<{ kind: 'conversation' }>>;
    }>)
  | (VoiceUiRuntimeContributionBase & Readonly<{
      kind: 'voice.speech-engine.v1';
      role: 'stt' | 'tts' | 'both';
      declaration?: Extract<VoiceProviderContribution, Readonly<{ kind: 'speech' }>>;
      catalogs?: Extract<VoiceProviderContribution, Readonly<{ kind: 'speech' }>>['catalogs'];
      limits?: Extract<VoiceProviderContribution, Readonly<{ kind: 'speech' }>>['limits'];
    }>)
  | (VoiceUiRuntimeContributionBase & Readonly<{
      kind: 'voice.turn-support.v1';
      internal?: never;
    }>);

export type VoiceProviderRegistryEntry = VoiceUiRuntimeContribution & Readonly<{
  supportedPlatforms: readonly VoiceRuntimePlatform[];
  mark?: VoiceServiceMark;
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

export function projectVoiceProviderAccountCredentialSlot(
  declaration: VoiceProviderContribution,
  recipientContract: RecipientContractV1 | null,
): NonNullable<VoiceProviderRegistryEntry['accountCredentialSlot']> | null {
  const credentials = declaration.credentials;
  if (!credentials?.hostMediated
    || !recipientContract
    || !credentials.sources.some((source) => (
      source.kind === 'savedSecret' && source.secretKinds.includes('apiKey')
    ))) return null;
  const slot = credentials.slot;
  if (credentials.hostMediated.operations.some((operation) => operation.credentialSlotId !== slot.id)) return null;
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

function normalizeBuiltInContribution(raw: VoiceUiRuntimeContribution): VoiceProviderRegistryEntry {
  const providerId = normalizeNonEmptyString(raw.providerId);
  const pluginId = normalizeNonEmptyString(raw.pluginId);
  const settingsSectionId = normalizeNonEmptyString(raw.settingsSectionId);
  if (
    !providerId
    || !pluginId
    || !settingsSectionId
    || raw.roles.length === 0
    || !raw.supportedPlatforms
    || raw.supportedPlatforms.length === 0
  ) {
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
  const declarationBase = projectVoiceProviderDeclarationRegistryBase({
    declaration,
    providerSettings,
    selectionOptions,
  });
  const accountCredentialSlot = projectVoiceProviderAccountCredentialSlot(
    declaration,
    createBundledVoiceRecipientContract({ pluginId: raw.pluginId, declaration }),
  );
  const common = {
    pluginId: raw.pluginId,
    providerId,
    settingsSectionId: presentation.settingsSectionId,
    ...declarationBase,
    ...(accountCredentialSlot ? { accountCredentialSlot } : {}),
    declaration,
    source: Object.freeze({ kind: 'bundled' as const, pluginId: raw.pluginId }),
  };
  if (declaration.kind === 'conversation') {
    return deepFreeze({
      kind: 'voice.conversation-provider.v1' as const,
      ...common,
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
