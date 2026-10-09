import {
  SAVED_SECRET_COLLECTION_MAX_ENTRIES,
  SavedSecretSchema,
  AIBackendProfileSchema,
  type SavedSecret,
} from '../../profiles/backendProfileSchema.js';
import type { SecretStringV1 } from '../../crypto/settingsSecretStringSchemasV1.js';
import {
  ACCOUNT_SETTINGS_MAX_SAVED_SECRETS_BYTES,
  inspectAccountSettingValueBounds,
} from './catalog/accountSettingBounds.js';
import {
  QualifiedConnectedAccountPurposeBindingTargetV1Schema,
  QualifiedConnectedAccountPurposeBindingsV1Schema,
  qualifiedPurposeKey,
  type QualifiedConnectedAccountPurposeBindingTargetV1,
  type QualifiedConnectedAccountPurposeBindingV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '../../connect/connectedAccountPurposeBindings.js';
import {
  QualifiedConnectedAccountPurposeV1Schema,
  type QualifiedConnectedAccountPurposeV1,
} from '../../connect/connectedAccountPurposes.js';
import {
  PluginContributionIdentityV1Schema,
  parseQualifiedPluginContributionKey,
  type PluginContributionIdentityV1,
} from '../../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { PluginCredentialAccessSlotIdSchema } from '../../plugins/permissions/grants.js';
import { PluginSettingFieldIdV2Schema } from '../../plugins/contributions/settings.js';
import {
  deriveVoiceCredentialBindingIdentityV1,
  type VoiceProviderContribution,
} from '../../plugins/contributions/voiceProviders.js';
import { ProviderMachineIdSchema } from '../../providers/ids.js';
import { SavedSecretSlotBindingsV1Schema } from '../../providers/settings/v1.js';
import {
  LegacyVoiceCredentialBindingV1Schema,
  classifyLegacyVoiceCredentialCandidateV1,
  listLegacyVoiceCredentialMigrationCandidatesV1,
  type LegacyVoiceCredentialMigrationCandidateV1,
  VoiceCredentialBindingV1Schema,
  type VoiceCredentialBindingV1,
} from '../../voice/realtime/providerSettings.js';
import { resolvePredecessorVoiceProviderContributionIdentityV1 } from '../../voice/providerContributionIdentity.js';
import {
  SAVED_SECRET_REF_MAX_LENGTH_V1,
  SHARED_SAVED_SECRET_REF_V1_PREFIX,
  formatSharedSavedSecretRefV1,
  parseSavedSecretRefV1,
  listSavedSecretReferenceCarrierPathsV1,
  formatSavedSecretReferencePathSegmentV1 as pathSegment,
  type SavedSecretRefV1,
} from './savedSecretReferenceV1.js';
import {
  CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY,
  parseConnectedAccountServiceConfigurationsV1,
  type ConnectedAccountServiceConfigurationEntryV1,
} from './connectedAccountServiceConfigurationsV1.js';
import { StoredProfileRecordV1Schema, type ProfileRecordV1 } from '../../profiles/profileRecordSchemaV1.js';
import { resolveProfileCatalogAuthorityV1, removeTransferredProfileSourcesV1, listTransferredProfileIdsV1, readEffectiveProfileSecretBindingsV1 } from '../../profiles/read.js';
import type { ProfileTransferControlV1 } from '../../profiles/profileTransferSchemaV1.js';
import { computeCanonicalDomainSeparatedHexDigest } from '../../crypto/canonicalDigest.js';
import { readLaunchProfileArtifactForReferenceCensusV1, LaunchProfileArtifactReferenceV1Schema } from '../../launchProfiles/launchProfileArtifactV1.js';
import type { ArtifactSharingResourceV1 } from '../../artifacts/artifactSharingV1.js';
import type { ProfileCatalogRecordV1 } from '../../profiles/profileCatalogV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { ACCOUNT_SETTING_DEFINITIONS } from './accountSettings.js';
import { readRemoteHostCatalogRecordV1, type RemoteHostRecordV1 } from '../../remoteHosts/remoteHostRecordV1.js';
import { AcpCatalogRecordV1Schema, listAcpCatalogSavedSecretRefsV1, rewriteAcpCatalogSavedSecretRefsV1, type AcpCatalogRecordV1 } from '../../acp/catalog/catalogRowsV1.js';
import { ProviderConnectionsCatalogV1Schema, listProviderConnectionsCatalogSavedSecretRefsV1, rewriteProviderConnectionsCatalogSavedSecretRefsV1, type ProviderConnectionsCatalogV1 } from '../../providers/connections/connectionRowsV1.js';
import { ConnectedConfigurationCatalogV1Schema, ConnectedPurposeCatalogV1Schema, listConnectedConfigurationCatalogSavedSecretRefsV1, rewriteConnectedConfigurationCatalogSavedSecretRefsV1, type ConnectedConfigurationCatalogV1, type ConnectedPurposeCatalogV1 } from '../../connect/connectedAccountConfigurationRowsV1.js';
import { McpServerCatalogV1Schema, listMcpServerCatalogSavedSecretRefsV1, rewriteMcpServerCatalogSavedSecretRefsV1, type McpServerCatalogV1 } from '../../mcp/servers/serverRowsV1.js';
import { NotificationChannelCatalogRecordV1Schema, type NotificationChannelCatalogRecordV1 } from './notificationChannelSchemasV1.js';
import { listNotificationChannelSavedSecretReferenceSlotsV1, rewriteNotificationChannelSavedSecretRefsV1 } from './notificationChannelRecordV1.js';

export { CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY } from './connectedAccountServiceConfigurationsV1.js';

const SECRETS_KEY = 'secrets';
const PROFILE_BINDINGS_KEY = 'secretBindingsByProfileId';
const PROVIDER_SETTINGS_KEY = 'providerSettingsV1';
const VOICE_SETTINGS_KEYS = ['voice', 'voiceSettingsV1'] as const;
const MCP_SETTINGS_KEY = 'mcpServersSettingsV1';
const ACP_SETTINGS_KEY = 'acpCatalogSettingsV1';
export const PLUGIN_SECRET_BINDINGS_SETTINGS_KEY = 'pluginSecretBindingsV1';
const MAX_PLUGIN_SECRET_BINDINGS = 256;
const MAX_PLUGIN_SECRET_BINDINGS_BYTES = 64 * 1024;
export type AccountSettingsSavedSecretReferenceOwner =
  | 'profile'
  | 'provider'
  | 'voice'
  | 'mcp'
  | 'acp'
  | 'plugin'
  | 'connectedAccountConfiguration'
  | 'remoteHost'
  | 'notificationChannel'
  | 'unknown';

export type AccountSettingsSavedSecretReference = Readonly<{
  owner: AccountSettingsSavedSecretReferenceOwner;
  path: string;
}>;

export {
  SAVED_SECRET_REF_MAX_LENGTH_V1,
  SHARED_SAVED_SECRET_REF_V1_PREFIX,
  formatSharedSavedSecretRefV1,
  parseSavedSecretRefV1,
  type SavedSecretRefV1,
} from './savedSecretReferenceV1.js';

function isStrictSharedSavedSecretRefV1(value: string | null): boolean {
  if (value === null) return false;
  try {
    return parseSavedSecretRefV1(value).kind === 'shared_resource';
  } catch {
    return false;
  }
}

export type RekeyPersonalSavedSecretInput = Readonly<{
  secretId: string;
  expectedUpdatedAt: number;
  newSecretId: string;
}>;

export type PromotePersonalSavedSecretReferenceInput = Readonly<{
  secretId: string;
  expectedUpdatedAt: number;
  sharedSecretRef: string;
}>;

/** Opened complete inventories; their revisions/coverage are admitted by the transaction owner. */
export type SavedSecretReferenceCatalogsV1 = Readonly<{
  profileRecords: readonly ProfileRecordV1[];
  artifactsById?: ReadonlyMap<string, ArtifactSharingResourceV1>;
  profileControl?: ProfileTransferControlV1 | null;
  /** Partial display projections cannot establish that an SSH resource is unreferenced. */
  remoteHostRecords?: readonly RemoteHostRecordV1[] | null;
  /** Undefined retains the genuine inactive source adapter; null is an authoritative tombstone. */
  mcp?: McpServerCatalogV1 | null;
  acp?: AcpCatalogRecordV1 | null;
  providerConnections?: ProviderConnectionsCatalogV1 | null;
  connectedConfigurations?: ConnectedConfigurationCatalogV1 | null;
  connectedPurposes?: ConnectedPurposeCatalogV1 | null;
  notificationChannels?: NotificationChannelCatalogRecordV1 | null;
}>;

export type SavedSecretClassifiedSourceCatalogsV1 = Omit<SavedSecretReferenceCatalogsV1, 'profileRecords'> & Readonly<{
  profileRows: readonly ProfileCatalogRecordV1[];
}>;

export type SavedSecretReferenceRewriteResultV1 = Readonly<{
  settings: Readonly<Record<string, unknown>>;
  profileRecords?: readonly ProfileRecordV1[];
  remoteHostRecords?: readonly RemoteHostRecordV1[] | null;
  mcp?: McpServerCatalogV1 | null;
  acp?: AcpCatalogRecordV1 | null;
  providerConnections?: ProviderConnectionsCatalogV1 | null;
  connectedConfigurations?: ConnectedConfigurationCatalogV1 | null;
  connectedPurposes?: ConnectedPurposeCatalogV1 | null;
  notificationChannels?: NotificationChannelCatalogRecordV1 | null;
}>;

export type SavedSecretImportSourceV1 =
  | Readonly<{ kind: 'personal-saved-secret'; secretId: string }>
  | Readonly<{ kind: 'profile-environment-variable'; profileId: string; envName: string }>
  | Readonly<{ kind: 'notification-channel-signing-secret'; channelId: string }>
  | Readonly<{ kind: 'remote-host-ssh-credential'; hostId: string; slot: 'password' | 'identityPrivateKey' }>
  | Readonly<{ kind: 'legacy-inference-openai-key' }>;

export type SavedSecretLegacyInferenceCredentialV1 = Readonly<{
  source: Extract<SavedSecretImportSourceV1, { kind: 'legacy-inference-openai-key' }>;
  value: string; displayName: string; kind: 'apiKey';
}>;

export type SavedSecretLegacyChatCredentialV1 = Readonly<{
  source: Readonly<{ kind: 'personal-saved-secret'; secretId: 'voice:openai_compat:chat_api_key' }>
    // Structural source provenance only; this is not a transferable import
    // source or proof that the referenced Resource is owned and usable.
    | Readonly<{ kind: 'existing-resource-reference'; resourceRef: string }>;
  encryptedValue: SecretStringV1; displayName: string; kind: 'apiKey';
}>;

/** Original non-Chat Voice carriers; Resource descriptors still require authority admission. */
export type SavedSecretLegacyVoiceCredentialV1 = Readonly<{
  source: Extract<SavedSecretImportSourceV1, { kind: 'personal-saved-secret' }>
    | Readonly<{ kind: 'existing-resource-reference'; resourceRef: string }>;
  encryptedValue: SecretStringV1; displayName: string; kind: 'apiKey';
  candidate: LegacyVoiceCredentialMigrationCandidateV1;
}>;

/** Import retries identify the same Account/source, never mutable labels or secret bytes. */
function readSavedSecretImportSourcePartsV1(value: SavedSecretImportSourceV1): readonly string[] {
  const source = ownRecord(value);
  const parts = source?.kind === 'personal-saved-secret'
    && hasOnlyOwnKeys(source, ['kind', 'secretId']) && typeof source.secretId === 'string' && source.secretId.length > 0
    ? [source.kind, source.secretId]
    : source?.kind === 'profile-environment-variable' && hasOnlyOwnKeys(source, ['kind', 'profileId', 'envName'])
      && typeof source.profileId === 'string' && source.profileId.length > 0 && typeof source.envName === 'string' && source.envName.length > 0
      ? [source.kind, source.profileId, source.envName]
      : source?.kind === 'remote-host-ssh-credential' && hasOnlyOwnKeys(source, ['kind', 'hostId', 'slot'])
        && typeof source.hostId === 'string' && source.hostId.length > 0
        && (source.slot === 'password' || source.slot === 'identityPrivateKey') ? [source.kind, source.hostId, source.slot]
      : source?.kind === 'notification-channel-signing-secret' && hasOnlyOwnKeys(source, ['kind', 'channelId'])
        && typeof source.channelId === 'string' && source.channelId.length > 0 ? [source.kind, source.channelId]
        : source?.kind === 'legacy-inference-openai-key' && hasOnlyOwnKeys(source, ['kind']) ? [source.kind] : null;
  if (!parts) {
    invalidReferenceRoot('SavedSecret import source identity is invalid');
  }
  return parts;
}

export function deriveSavedSecretImportResourceIdV1(input: Readonly<{
  accountId: string; source: SavedSecretImportSourceV1;
}>): string {
  if (typeof input.accountId !== 'string' || input.accountId.length === 0) invalidReferenceRoot('SavedSecret import Account identity is invalid');
  const parts = readSavedSecretImportSourcePartsV1(input.source);
  const hex = computeCanonicalDomainSeparatedHexDigest('happier.saved-secret.v1.import', [input.accountId, ...parts]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The retired bare root has no binding slot; preserve its material before removing only that source. */
export function promoteLegacyInferenceSavedSecretReferenceV1(
  settings: Readonly<Record<string, unknown>>,
  input: Readonly<{ source: Extract<SavedSecretImportSourceV1, { kind: 'legacy-inference-openai-key' }>; sharedSecretRef: string }>,
): SavedSecretReferenceRewriteResultV1 & Readonly<{ value: string }> {
  if (input.source.kind !== 'legacy-inference-openai-key') invalidReferenceRoot('Legacy inference credential source identity is invalid');
  readSavedSecretImportSourcePartsV1(input.source);
  validateKnownSavedSecretReferenceRoots(settings);
  parseSharedSavedSecretPromotionRef(input.sharedSecretRef);
  const candidate = readSavedSecretTransferSourceV1(settings).inferenceCredential;
  if (!candidate) invalidReferenceRoot('Legacy inference credential source is invalid');
  const next = { ...settings };
  delete next.inferenceOpenAIKey;
  return Object.freeze({ value: candidate.value, settings: Object.freeze(next) });
}

/**
 * Prepares the exact original non-Chat Voice source for the full S2 candidate.
 * Material/Resource authority and transaction admission remain with its caller.
 * An already-Shared descriptor is read-only: there is no create-free cleanup port.
 */
export function promoteLegacyVoiceSavedSecretReferenceV1(
  settings: Readonly<Record<string, unknown>>,
  input: Readonly<{ credential: SavedSecretLegacyVoiceCredentialV1; sharedSecretRef: string }>,
  catalogs: SavedSecretReferenceCatalogsV1,
): SavedSecretReferenceRewriteResultV1 & Readonly<{ encryptedValue: SecretStringV1 }> {
  const request = ownRecord(input);
  const credentialProof = ownRecord(request?.credential);
  if (!credentialProof || !ownRecord(credentialProof.candidate) || !ownRecord(credentialProof.source)) {
    invalidReferenceRoot('Legacy Voice source proof is invalid');
  }
  const voice = ownRecord(settings.voice);
  const candidates = listLegacyVoiceCredentialMigrationCandidatesV1(voice?.providerId);
  const selected = candidates.find(candidate => candidate.providerId === input.credential.candidate.providerId
    && candidate.slotId === input.credential.candidate.slotId
    && JSON.stringify(candidate.path) === JSON.stringify(input.credential.candidate.path)
    && JSON.stringify(candidate.canonicalPath) === JSON.stringify(input.credential.candidate.canonicalPath));
  if (!selected || selected.providerId === 'openai_compat') invalidReferenceRoot('Legacy Voice source descriptor is invalid');
  const targetRef = parseSharedSavedSecretPromotionRef(input.sharedSecretRef);
  const rawSecrets = settings[SECRETS_KEY];
  if (rawSecrets !== undefined && !Array.isArray(rawSecrets)) invalidReferenceRoot('Legacy Voice personal sources are invalid');
  const personalSources: readonly unknown[] = Array.isArray(rawSecrets) ? rawSecrets : [];
  const classify = (candidate: LegacyVoiceCredentialMigrationCandidateV1) => classifyLegacyVoiceCredentialCandidateV1({
    candidate, rawAdapters: voice?.adapters, personalSources, credentialBindings: voice?.credentialBindings,
  });
  const classified = classify(selected);
  if (classified.kind === 'absent' || classified.kind === 'unsupported') invalidReferenceRoot('Legacy Voice source is invalid');
  const source = input.credential.source;
  const sameSource = (candidate: ReturnType<typeof classify>): boolean => source.kind === 'personal-saved-secret'
    ? (candidate.kind === 'existing-personal' || candidate.kind === 'inline-personal-alias') && candidate.secretId === source.secretId
    : candidate.kind === 'existing-resource-reference' && candidate.resourceRef === source.resourceRef;
  if (source.kind === 'personal-saved-secret') readSavedSecretImportSourcePartsV1(source);
  else if (source.kind !== 'existing-resource-reference' || !hasOnlyOwnKeys(source, ['kind', 'resourceRef'])) {
    invalidReferenceRoot('Legacy Voice source identity is invalid');
  }
  const originalEnvelope = JSON.stringify(input.credential.encryptedValue);
  if (!sameSource(classified) || JSON.stringify(classified.rawSecret) !== originalEnvelope) {
    throw new AccountSettingsSavedSecretMutationError('saved_secret_conflict', 'Legacy Voice source changed before preparation');
  }
  if (source.kind === 'existing-resource-reference') {
    if (targetRef !== source.resourceRef) {
      throw new AccountSettingsSavedSecretMutationError('saved_secret_conflict', 'An existing Voice Resource cannot be retargeted by import');
    }
    return Object.freeze({ settings, encryptedValue: classified.rawSecret });
  }
  const origins = candidates.flatMap(candidate => {
    if (candidate.providerId === 'openai_compat') return [];
    const current = classify(candidate);
    if (!sameSource(current) || current.kind === 'absent' || current.kind === 'unsupported') return [];
    if (JSON.stringify(current.rawSecret) !== originalEnvelope) {
      throw new AccountSettingsSavedSecretMutationError('saved_secret_conflict', 'Legacy Voice origins disagree on source material');
    }
    return [{ candidate, binding: current.binding }];
  });
  validateKnownSavedSecretReferenceRoots(readReferenceSourceSettings(settings, catalogs));
  let result: SavedSecretReferenceRewriteResultV1;
  if (classified.kind === 'existing-personal') {
    const retained = readSavedSecretTransferSourceV1(settings).secrets.find(secret => secret.id === source.secretId);
    if (!retained) invalidReferenceRoot('Legacy Voice personal source is invalid');
    result = promotePersonalSavedSecretReference(settings, { secretId: retained.id,
      expectedUpdatedAt: retained.updatedAt, sharedSecretRef: targetRef }, catalogs);
  } else {
    if (listAccountSettingsSavedSecretReferences(settings, targetRef, catalogs).length > 0) {
      throw new AccountSettingsSavedSecretMutationError('saved_secret_conflict', 'Legacy Voice destination is already bound');
    }
    result = { settings };
  }
  let nextSettings = result.settings;
  for (const origin of origins) {
    const contribution = resolvePredecessorVoiceProviderContributionIdentityV1(origin.candidate.providerId)
      ?? parseQualifiedPluginContributionKey(origin.candidate.providerId);
    if (!contribution) invalidReferenceRoot('Legacy Voice contribution identity is invalid');
    const target = { contribution, credentialSlotId: origin.candidate.slotId, machineId: null };
    let state = readVoiceCredentialTarget(nextSettings, target);
    if (state.exactSecretId !== null && state.exactSecretId !== source.secretId && state.exactSecretId !== targetRef) {
      throw new AccountSettingsSavedSecretMutationError('saved_secret_conflict', 'Canonical Voice target already owns another reference');
    }
    if (!state.binding) {
      const byMachineId = Object.fromEntries(Object.entries(origin.binding?.credentialBindings.byMachineId ?? {})
        .flatMap(([machineId, slots]) => {
          const reference = slots[origin.candidate.slotId];
          return reference === undefined ? [] : [[machineId, { [origin.candidate.slotId]: reference === source.secretId ? targetRef : reference }]];
        }));
      const binding = VoiceCredentialBindingV1Schema.parse({ contribution, credentialSlotId: origin.candidate.slotId,
        credentialSource: { kind: 'savedSecret' }, credentialBindings: {
          ...(Object.keys(byMachineId).length > 0 ? { byMachineId } : {}),
        }, ...(origin.binding?.approvedRecipientContractDigest === undefined ? {} : {
          approvedRecipientContractDigest: origin.binding.approvedRecipientContractDigest,
        }) });
      nextSettings = { ...nextSettings, voiceSettingsV1: { ...state.root,
        credentialBindings: [...state.credentialBindings, binding] } };
      state = readVoiceCredentialTarget(nextSettings, target);
    }
    nextSettings = writeVoiceCredentialTarget({ settings: nextSettings, target, state, secretId: targetRef });
    nextSettings = removeLegacyVoiceOriginScalarV1(nextSettings, origin.candidate.path);
  }
  return Object.freeze({ ...result, settings: Object.freeze(nextSettings), encryptedValue: classified.rawSecret });
}

function removeLegacyVoiceOriginScalarV1(
  settings: Readonly<Record<string, unknown>>,
  path: readonly string[],
): Readonly<Record<string, unknown>> {
  const remove = (value: unknown, index: number): Readonly<Record<string, unknown>> => {
    const record = ownRecord(value);
    if (!record) invalidReferenceRoot('Legacy Voice origin disappeared during preparation');
    const next = { ...record };
    const key = path[index]!;
    if (index === path.length - 1) delete next[key];
    else next[key] = remove(record[key], index + 1);
    return next;
  };
  const voice = ownRecord(settings.voice);
  if (!voice) invalidReferenceRoot('Legacy Voice origin disappeared during preparation');
  return { ...settings, voice: { ...voice, adapters: remove(voice.adapters, 0) } };
}

/** Only the classified exact legacy carrier moves; raw unrelated config remains its owner. */
export function promoteProfileEnvironmentVariableSavedSecretReferenceV1(
  settings: Readonly<Record<string, unknown>>,
  input: Readonly<{
    source: Extract<SavedSecretImportSourceV1, { kind: 'profile-environment-variable' }>;
    sharedSecretRef: string;
  }>,
  catalogs?: SavedSecretReferenceCatalogsV1 | SavedSecretClassifiedSourceCatalogsV1,
): SavedSecretReferenceRewriteResultV1 & Readonly<{ value: string; profileRows?: readonly ProfileCatalogRecordV1[] }> {
  // Validate the canonical source identity and complete reference roots before constructing a rewrite.
  readSavedSecretImportSourcePartsV1(input.source);
  const capturedRows = catalogs && 'profileRows' in catalogs ? catalogs.profileRows : undefined;
  const referenceCatalogs: SavedSecretReferenceCatalogsV1 | undefined = catalogs ? {
    ...catalogs,
    profileRecords: 'profileRows' in catalogs ? catalogs.profileRows.map(row => row.record) : catalogs.profileRecords,
  } : undefined;
  validateKnownSavedSecretReferenceRoots(readReferenceSourceSettings(settings, referenceCatalogs));
  const targetRef = parseSharedSavedSecretPromotionRef(input.sharedSecretRef);
  const profiles = settings.profiles;
  if (!Array.isArray(profiles)) invalidReferenceRoot('Legacy Profile credential source is invalid');
  const matches = profiles.flatMap((candidate, index) => ownRecord(candidate)?.id === input.source.profileId ? [{ candidate, index }] : []);
  if (matches.length !== 1) invalidReferenceRoot('Legacy Profile credential source identity is ambiguous');
  const selected = ownRecord(matches[0]!.candidate);
  const profile = AIBackendProfileSchema.safeParse(selected);
  if (!selected || !profile.success || !Array.isArray(selected.environmentVariables)) {
    invalidReferenceRoot('Legacy Profile credential source is invalid');
  }
  const entries = selected.environmentVariables;
  const variables = entries.flatMap((candidate, index) => ownRecord(candidate)?.name === input.source.envName ? [{ candidate, index }] : []);
  const variable = variables.length === 1 ? ownRecord(variables[0]!.candidate) : null;
  const value = variable?.value;
  const bindings = ownRecord(settings[PROFILE_BINDINGS_KEY]) ?? {};
  const profileBindings = ownRecord(bindings[input.source.profileId]) ?? {};
  if (typeof value !== 'string' || value.length === 0 || value.includes('${') || profileBindings[input.source.envName] !== undefined) {
    invalidReferenceRoot('Legacy Profile credential source is not an unbound literal');
  }
  if (readSavedSecrets(settings).some(secret => secret.id === targetRef)
    || listAccountSettingsSavedSecretReferences(settings, targetRef, referenceCatalogs).length > 0) {
    throw new AccountSettingsSavedSecretMutationError('saved_secret_conflict', 'SavedSecret import target is already referenced');
  }
  const nextProfiles = [...profiles];
  nextProfiles[matches[0]!.index] = { ...selected, environmentVariables: entries.map((entry, index) => index === variables[0]!.index
    ? { ...variable, value: `\${${input.source.envName}}` } : entry) };
  const profileRows = capturedRows?.map(row => {
    if (!Number.isSafeInteger(row.revision) || row.revision < 0) invalidReferenceRoot('Profile source revision is invalid');
    const record = row.record;
    if (record.id !== input.source.profileId) return row;
    if (record.definition.kind !== 'legacy') invalidReferenceRoot('Staged Profile source carrier is not the captured legacy definition');
    const matches = record.definition.profile.environmentVariables.filter(entry => entry.name === input.source.envName);
    if (matches.length !== 1 || matches[0]!.value !== value || Object.hasOwn(record.secretBindings, input.source.envName)) {
      invalidReferenceRoot('Staged Profile credential source changed or is ambiguous');
    }
    return { ...row, record: { ...record, definition: { ...record.definition, profile: { ...record.definition.profile,
      environmentVariables: record.definition.profile.environmentVariables.map(entry => entry.name === input.source.envName
        ? { ...entry, value: `\${${input.source.envName}}` } : entry),
    } }, secretBindings: { ...record.secretBindings, [input.source.envName]: targetRef } } };
  });
  const profileRecords = profileRows?.map(row => row.record) ?? referenceCatalogs?.profileRecords;
  return { settings: { ...settings, profiles: nextProfiles, [PROFILE_BINDINGS_KEY]: {
    ...bindings, [input.source.profileId]: { ...profileBindings, [input.source.envName]: targetRef },
  } }, value, ...(profileRecords ? { profileRecords } : {}), ...(profileRows ? { profileRows } : {}) };
}

export function rekeyPersonalSavedSecret(
  settings: Readonly<Record<string, unknown>>,
  input: RekeyPersonalSavedSecretInput,
  catalogs?: SavedSecretReferenceCatalogsV1,
): SavedSecretReferenceRewriteResultV1 {
  return rewritePersonalSavedSecret(settings, input, {
    kind: 'personal',
    ref: input.newSecretId,
  }, catalogs);
}

export function promotePersonalSavedSecretReference(
  settings: Readonly<Record<string, unknown>>,
  input: PromotePersonalSavedSecretReferenceInput,
  catalogs?: SavedSecretReferenceCatalogsV1,
): SavedSecretReferenceRewriteResultV1 {
  return rewritePersonalSavedSecret(settings, input, {
    kind: 'shared_resource',
    ref: input.sharedSecretRef,
  }, catalogs);
}

export type AccountSettingsSavedSecretMutation =
  | Readonly<{
      kind: 'add';
      secret: SavedSecret;
    }>
  | Readonly<{
      kind: 'rename';
      secretId: string;
      expectedUpdatedAt: number;
      name: string;
      updatedAt: number;
    }>
  | Readonly<{
      kind: 'rotateGlobal';
      secretId: string;
      expectedUpdatedAt: number;
      encryptedValue: SecretStringV1;
      updatedAt: number;
    }>
  | Readonly<{
      kind: 'delete';
      secretId: string;
      expectedUpdatedAt: number;
    }>
  | Readonly<{
      kind: 'replaceVoiceCredentialSecret';
      target: VoiceCredentialSecretTarget;
      expectedSecretId: string | null;
      expectedSecretUpdatedAt: number | null;
      secret: SavedSecret;
      approvedRecipientContractDigest?: string;
    }>
  | Readonly<{
      /**
       * Points a Voice credential slot at a SavedSecret the account already
       * stores. No secret material is carried, created, or removed: the
       * mutation only moves the reference, and an unknown id fails closed.
       */
      kind: 'bindVoiceCredentialSavedSecret';
      target: VoiceCredentialSecretTarget;
      expectedSecretId: string | null;
      expectedSecretUpdatedAt: number | null;
      secretId: string;
      approvedRecipientContractDigest?: string;
    }>
  | Readonly<{
      kind: 'approveVoiceCredentialRecipientContract';
      target: VoiceCredentialSecretTarget;
      expectedSecretId: string;
      expectedSecretUpdatedAt: number;
      approvedRecipientContractDigest: string;
    }>
  | Readonly<{
      kind: 'removeVoiceCredentialSecret';
      target: VoiceCredentialSecretTarget;
      expectedSecretId: string;
      expectedSecretUpdatedAt: number;
    }>
  | Readonly<{
      kind: 'replacePluginSecret';
      target: PluginAccountSecretBindingTarget;
      expectedSecretId: string | null;
      expectedSecretUpdatedAt: number | null;
      secret: SavedSecret;
    }>
  | Readonly<{
      kind: 'bindPluginSecret';
      target: PluginAccountSecretBindingTarget;
      expectedSecretId: string | null;
      expectedSecretUpdatedAt: number | null;
      secretId: string;
    }>
  | Readonly<{
      kind: 'removePluginSecret';
      target: PluginAccountSecretBindingTarget;
      expectedSecretId: string;
      expectedSecretUpdatedAt: number | null;
    }>
  | Readonly<{
      /** Removes only the plugin binding; the SavedSecret remains user-owned. */
      kind: 'unbindPluginSecret';
      target: PluginAccountSecretBindingTarget;
      expectedSecretId: string;
      expectedSecretUpdatedAt: number | null;
    }>;

export type PluginAccountSecretBindingTarget = Readonly<{
  pluginId: string;
  localId: string;
}>;

export type PluginAccountSecretBinding = Readonly<{
  pluginId: string;
  custody: 'account';
  localId: string;
  savedSecretId: string;
  createdForBinding: boolean;
}>;

export type AccountSettingsPluginSecretResolution = Readonly<{
  binding: PluginAccountSecretBinding;
  secret: SavedSecret;
}>;

export type VoiceCredentialSecretTarget = Readonly<{
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  machineId: string | null;
}>;

export type AccountSettingsVoiceCredentialSecretResolution = Readonly<{
  exactSecretId: string | null;
  reference: Readonly<{
    secretId: string;
    source: 'account' | 'machine_override';
  }> | null;
  approvedRecipientContractDigest: string | null;
}>;

export type VoiceCredentialSourceSelection =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'savedSecret' }>
  | Readonly<{
      kind: 'connectedAccount';
      target: QualifiedConnectedAccountPurposeBindingTargetV1;
    }>;

export type AccountSettingsVoiceCredentialSourceMutation = Readonly<{
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  selection: VoiceCredentialSourceSelection;
  expectedSettingsVersion: number;
  savedSecretMutation?: Extract<
    AccountSettingsSavedSecretMutation,
    Readonly<{ kind: 'replaceVoiceCredentialSecret' }>
    | Readonly<{ kind: 'bindVoiceCredentialSavedSecret' }>
  >;
}>;

export type AccountSettingsVoiceCredentialSourceMutationResult =
  | Readonly<{
      status: 'applied';
      settingsVersion: number;
      selection: VoiceCredentialSourceSelection;
      binding: QualifiedConnectedAccountPurposeBindingV1 | null;
    }>
  | Readonly<{
      status: 'conflict';
      currentSettingsVersion: number;
    }>
  /**
   * The Account Settings one-shot write may have reached storage, but the
   * SavedSecret source owner cannot truthfully attribute a readback to it.
   */
  | Readonly<{
      status: 'outcomeUnknown';
      lastKnownSettingsVersion: number;
      safeSnapshotVersion?: number;
    }>;

export type AccountSettingsVoiceCredentialSourceResolution = Readonly<{
  selection: VoiceCredentialSourceSelection;
  binding: QualifiedConnectedAccountPurposeBindingV1 | null;
  savedSecret: Readonly<{
    secretId: string;
    source: 'account' | 'machine_override';
  }> | null;
  /** The recipient contract the user approved for this target, when recorded. */
  approvedRecipientContractDigest: string | null;
}>;

export class AccountSettingsSavedSecretMutationError extends Error {
  readonly code:
    | 'saved_secret_invalid'
    | 'saved_secret_conflict'
    | 'saved_secret_not_found'
    | 'saved_secret_in_use'
    | 'saved_secret_referenced_by_connected_account_configuration'
    | 'saved_secret_reference_invalid'
    | 'saved_secret_ref_collision_migration_required'
    | 'saved_secret_collection_full';
  readonly references: readonly AccountSettingsSavedSecretReference[];

  constructor(
    code: AccountSettingsSavedSecretMutationError['code'],
    message: string,
    references: readonly AccountSettingsSavedSecretReference[] = [],
  ) {
    super(message);
    this.name = 'AccountSettingsSavedSecretMutationError';
    this.code = code;
    this.references = Object.freeze([...references]);
  }
}

type MutableRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

function hasOnlyOwnKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function readSavedSecrets(
  settings: Readonly<Record<string, unknown>>,
): readonly SavedSecret[] {
  const raw = settings[SECRETS_KEY];
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw)) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Account Settings SavedSecret collection is invalid',
    );
  }
  try {
    const validated = raw.map((entry) => {
      SavedSecretSchema.parse(entry);
      return entry as SavedSecret;
    });
    if (new Set(validated.map((entry) => entry.id)).size !== validated.length) {
      throw new Error('duplicate SavedSecret identity');
    }
    return Object.freeze(validated);
  } catch {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Account Settings SavedSecret collection is invalid',
    );
  }
}

/** Transfer recognizes individual supported items; future items remain owned by their source. */
export function readSavedSecretTransferSourceV1(settings: Readonly<Record<string, unknown>>): Readonly<{
  secrets: readonly SavedSecret[]; complete: boolean; inferenceCredential?: SavedSecretLegacyInferenceCredentialV1;
  legacyChatCredential?: SavedSecretLegacyChatCredentialV1;
  legacyVoiceCredentials?: readonly SavedSecretLegacyVoiceCredentialV1[];
}> {
  const inferenceValue = settings.inferenceOpenAIKey;
  const inference = ACCOUNT_SETTING_DEFINITIONS.inferenceOpenAIKey.parseMutationValue(inferenceValue);
  const inferenceCredential: SavedSecretLegacyInferenceCredentialV1 | undefined = inference.success
    && typeof inference.data === 'string' && inference.data.length > 0
    ? Object.freeze({ source: { kind: 'legacy-inference-openai-key' as const }, value: inference.data,
      displayName: 'OpenAI API key for inference', kind: 'apiKey' as const }) : undefined;
  const raw = settings[SECRETS_KEY];
  const voice = readLegacyVoiceTransferCredentialsV1(settings, raw);
  const sourceComplete = inference.success && voice.complete;
  const source = { ...(inferenceCredential ? { inferenceCredential } : {}),
    ...(voice.chatCredential ? { legacyChatCredential: voice.chatCredential } : {}),
    ...(voice.credentials.length > 0 ? { legacyVoiceCredentials: voice.credentials } : {}) };
  if (raw === undefined) return { secrets: [], complete: sourceComplete, ...source };
  if (!Array.isArray(raw)) return { secrets: [], complete: false, ...source };
  const secrets = raw.flatMap(value => {
    const parsed = SavedSecretSchema.safeParse(value);
    return parsed.success ? [value as SavedSecret] : [];
  });
  const identities = raw.flatMap(value => typeof ownRecord(value)?.id === 'string' ? [ownRecord(value)!.id] : []);
  if (new Set(identities).size !== identities.length) {
    throw new AccountSettingsSavedSecretMutationError('saved_secret_invalid', 'Account Settings SavedSecret identities are ambiguous');
  }
  return { secrets, complete: sourceComplete && secrets.length === raw.length, ...source };
}

/** Receipt of the exact predecessor carrier, not a synthesized Settings record. */
function readLegacyVoiceTransferCredentialsV1(
  settings: Readonly<Record<string, unknown>>,
  rawSecrets: unknown,
): Readonly<{ complete: boolean; chatCredential?: SavedSecretLegacyChatCredentialV1;
  credentials: readonly SavedSecretLegacyVoiceCredentialV1[] }> {
  const voice = ownRecord(settings.voice);
  const secrets: readonly unknown[] = Array.isArray(rawSecrets) ? rawSecrets : [];
  const credentials: SavedSecretLegacyVoiceCredentialV1[] = [];
  const materialsBySource = new Map<string, string>();
  let chatCredential: SavedSecretLegacyChatCredentialV1 | undefined;
  let complete = true;
  for (const candidate of listLegacyVoiceCredentialMigrationCandidatesV1(voice?.providerId)) {
    const classified = classifyLegacyVoiceCredentialCandidateV1({ candidate, rawAdapters: voice?.adapters,
      personalSources: secrets, credentialBindings: voice?.credentialBindings });
    if (classified.kind === 'absent') continue;
    if (classified.kind === 'unsupported' || (rawSecrets !== undefined && !Array.isArray(rawSecrets))) {
      complete = false;
      continue;
    }
    // Non-Chat inline origins need their descriptor even when the personal record
    // is also inventoried. Chat retains its separate ordered Provider ACK recipe.
    if (classified.kind === 'existing-personal' && candidate.providerId === 'openai_compat') continue;
    const source: SavedSecretLegacyVoiceCredentialV1['source'] = classified.kind === 'existing-resource-reference'
      ? { kind: 'existing-resource-reference', resourceRef: classified.resourceRef }
      : { kind: 'personal-saved-secret', secretId: classified.secretId };
    const identity = JSON.stringify(source);
    const material = JSON.stringify(classified.parsedSecret);
    const previous = materialsBySource.get(identity);
    if (previous !== undefined) {
      if (previous !== material) complete = false;
      continue;
    }
    materialsBySource.set(identity, material);
    if (candidate.providerId === 'openai_compat' && candidate.slotId === 'chat_api_key') {
      const chatSource: SavedSecretLegacyChatCredentialV1['source'] = source.kind === 'existing-resource-reference'
        ? source : { kind: 'personal-saved-secret', secretId: 'voice:openai_compat:chat_api_key' };
      chatCredential = Object.freeze({ source: chatSource, encryptedValue: classified.rawSecret,
        displayName: 'Voice: openai_compat', kind: 'apiKey' });
    } else {
      credentials.push(Object.freeze({ source, encryptedValue: classified.rawSecret, candidate,
        displayName: `Voice: ${candidate.providerId}`, kind: 'apiKey' }));
    }
  }
  return { complete, credentials: Object.freeze(credentials), ...(chatCredential ? { chatCredential } : {}) };
}

function pluginSecretBindingError(message: string): never {
  throw new AccountSettingsSavedSecretMutationError(
    'saved_secret_reference_invalid',
    message,
  );
}

function parsePluginAccountSecretBindingTarget(
  value: unknown,
): PluginAccountSecretBindingTarget {
  const raw = ownRecord(value);
  const pluginId = PluginIdSchema.safeParse(raw?.pluginId);
  const localId = PluginSettingFieldIdV2Schema.safeParse(raw?.localId);
  if (
    !raw
    || !hasOnlyOwnKeys(raw, ['pluginId', 'localId'])
    || !pluginId.success
    || !localId.success
  ) {
    pluginSecretBindingError('Plugin SavedSecret binding target is invalid');
  }
  return Object.freeze({ pluginId: pluginId.data, localId: localId.data });
}

/**
 * A JSON tuple keeps plugin ids and local ids collision-safe even though both
 * can contain the separators used elsewhere in contribution identifiers.
 */
export function qualifyPluginAccountSecretBindingKey(
  target: PluginAccountSecretBindingTarget,
): string {
  const parsed = parsePluginAccountSecretBindingTarget(target);
  return JSON.stringify([parsed.pluginId, 'account', parsed.localId]);
}

function parsePluginAccountSecretBinding(
  key: string,
  value: unknown,
): PluginAccountSecretBinding {
  const raw = ownRecord(value);
  if (
    !raw
    || !hasOnlyOwnKeys(raw, [
      'pluginId',
      'custody',
      'localId',
      'savedSecretId',
      'createdForBinding',
    ])
    || raw.custody !== 'account'
    || typeof raw.savedSecretId !== 'string'
    || raw.savedSecretId.length === 0
    || typeof raw.createdForBinding !== 'boolean'
  ) {
    pluginSecretBindingError('Plugin SavedSecret binding is invalid');
  }
  const target = parsePluginAccountSecretBindingTarget({
    pluginId: raw.pluginId,
    localId: raw.localId,
  });
  if (key !== qualifyPluginAccountSecretBindingKey(target)) {
    pluginSecretBindingError('Plugin SavedSecret binding key is not canonical');
  }
  return Object.freeze({
    pluginId: target.pluginId,
    custody: 'account',
    localId: target.localId,
    savedSecretId: raw.savedSecretId,
    createdForBinding: raw.createdForBinding,
  });
}

function canonicalPluginSecretBindingsJson(
  bindings: Readonly<Record<string, PluginAccountSecretBinding>>,
): string {
  const ordered = Object.fromEntries(
    Object.entries(bindings)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, binding]) => [
        key,
        {
          pluginId: binding.pluginId,
          custody: binding.custody,
          localId: binding.localId,
          savedSecretId: binding.savedSecretId,
          createdForBinding: binding.createdForBinding,
        },
      ]),
  );
  return JSON.stringify(ordered);
}

function readPluginAccountSecretBindings(
  settings: Readonly<Record<string, unknown>>,
): Readonly<Record<string, PluginAccountSecretBinding>> {
  const raw = settings[PLUGIN_SECRET_BINDINGS_SETTINGS_KEY];
  if (raw === undefined) return Object.freeze({});
  const root = ownRecord(raw);
  if (!root) {
    pluginSecretBindingError('Plugin SavedSecret bindings are invalid');
  }
  const entries = Object.entries(root);
  if (entries.length > MAX_PLUGIN_SECRET_BINDINGS) {
    pluginSecretBindingError('Plugin SavedSecret bindings exceed the entry limit');
  }
  const bindings = Object.fromEntries(entries.map(([key, value]) => [
    key,
    parsePluginAccountSecretBinding(key, value),
  ])) as Record<string, PluginAccountSecretBinding>;
  if (
    new TextEncoder().encode(canonicalPluginSecretBindingsJson(bindings)).byteLength
      > MAX_PLUGIN_SECRET_BINDINGS_BYTES
  ) {
    pluginSecretBindingError('Plugin SavedSecret bindings exceed the byte limit');
  }
  return Object.freeze(bindings);
}

function withPluginAccountSecretBindings(
  settings: Readonly<Record<string, unknown>>,
  bindings: Readonly<Record<string, PluginAccountSecretBinding>>,
): Readonly<Record<string, unknown>> {
  if (Object.keys(bindings).length === 0) {
    const { [PLUGIN_SECRET_BINDINGS_SETTINGS_KEY]: _removed, ...withoutBindings } = settings;
    return Object.freeze(withoutBindings);
  }
  // Re-parse through the strict bounded reader before committing the root.
  const canonical = JSON.parse(canonicalPluginSecretBindingsJson(bindings)) as Record<
    string,
    PluginAccountSecretBinding
  >;
  readPluginAccountSecretBindings({
    [PLUGIN_SECRET_BINDINGS_SETTINGS_KEY]: canonical,
  });
  return Object.freeze({
    ...settings,
    [PLUGIN_SECRET_BINDINGS_SETTINGS_KEY]: canonical,
  });
}

function readPluginAccountSecretBindingTarget(
  settings: Readonly<Record<string, unknown>>,
  target: PluginAccountSecretBindingTarget,
): Readonly<{
  target: PluginAccountSecretBindingTarget;
  key: string;
  binding: PluginAccountSecretBinding | null;
}> {
  const parsedTarget = parsePluginAccountSecretBindingTarget(target);
  const key = qualifyPluginAccountSecretBindingKey(parsedTarget);
  const bindings = readPluginAccountSecretBindings(settings);
  return Object.freeze({
    target: parsedTarget,
    key,
    binding: Object.prototype.hasOwnProperty.call(bindings, key)
      ? bindings[key]!
      : null,
  });
}

function writePluginAccountSecretBinding(input: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  target: PluginAccountSecretBindingTarget;
  binding: PluginAccountSecretBinding | null;
}>): Readonly<Record<string, unknown>> {
  const targetState = readPluginAccountSecretBindingTarget(
    input.settings,
    input.target,
  );
  const bindings = { ...readPluginAccountSecretBindings(input.settings) };
  if (input.binding) {
    bindings[targetState.key] = input.binding;
  } else {
    delete bindings[targetState.key];
  }
  return withPluginAccountSecretBindings(input.settings, bindings);
}

function assertPluginSecretBindingExpectation(
  secrets: readonly SavedSecret[],
  binding: PluginAccountSecretBinding | null,
  expectedSecretId: string | null,
  expectedSecretUpdatedAt: number | null,
): void {
  if (expectedSecretId === null) {
    if (expectedSecretUpdatedAt === null && binding === null) return;
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_conflict',
      'Plugin SavedSecret binding changed before the mutation settled',
    );
  }
  if (!binding || binding.savedSecretId !== expectedSecretId) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_conflict',
      'Plugin SavedSecret binding changed before the mutation settled',
    );
  }
  if (isStrictSharedSavedSecretRefV1(expectedSecretId)) {
    if (expectedSecretUpdatedAt !== null) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_conflict',
        'Shared Plugin SavedSecret binding has no personal record revision',
      );
    }
    return;
  }
  assertVoiceCredentialSecretExpectation(
    secrets,
    expectedSecretId,
    expectedSecretUpdatedAt,
  );
}

function removeUnreferencedBindingCreatedSecret(input: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  secrets: readonly SavedSecret[];
  binding: PluginAccountSecretBinding | null;
  catalogs?: SavedSecretReferenceCatalogsV1;
}>): readonly SavedSecret[] {
  if (!input.binding?.createdForBinding) return input.secrets;
  const stillReferenced = listAccountSettingsSavedSecretReferences(
    input.settings,
    input.binding.savedSecretId,
    input.catalogs,
  ).length > 0;
  return stillReferenced
    ? input.secrets
    : input.secrets.filter((secret) => secret.id !== input.binding!.savedSecretId);
}

/**
 * The Account-erasure arm for one plugin's declared Account secrets. It is
 * intentionally a Settings-owned pure operation: callers submit its complete
 * result through the incumbent whole-document Account Settings CAS rather
 * than changing the bindings or SavedSecrets through a Data store.
 */
export type AccountSettingsPluginSecretBindingsEraseResult = Readonly<{
  settings: Readonly<Record<string, unknown>>;
  removedBindingCount: number;
  removedSavedSecretCount: number;
}>;

export function eraseAccountSettingsPluginSecretBindings(
  settings: Readonly<Record<string, unknown>>,
  pluginId: string,
): AccountSettingsPluginSecretBindingsEraseResult {
  const parsedPluginId = PluginIdSchema.safeParse(pluginId);
  if (!parsedPluginId.success) {
    pluginSecretBindingError('Plugin SavedSecret erase target is invalid');
  }

  const secrets = readSavedSecrets(settings);
  const bindings = readPluginAccountSecretBindings(settings);
  // Validate every known reference root before any candidate binding is
  // removed. A malformed root must not turn an erase into a guessed delete.
  validateKnownSavedSecretReferenceRoots(settings);

  const removedBindings = Object.values(bindings).filter((binding) => (
    binding.pluginId === parsedPluginId.data
  ));
  if (removedBindings.length === 0) {
    return Object.freeze({
      settings,
      removedBindingCount: 0,
      removedSavedSecretCount: 0,
    });
  }

  const retainedBindings = Object.fromEntries(
    Object.entries(bindings).filter(([, binding]) => (
      binding.pluginId !== parsedPluginId.data
    )),
  ) as Record<string, PluginAccountSecretBinding>;
  const withoutBindings = withPluginAccountSecretBindings(settings, retainedBindings);
  const candidateSecretIds = new Set(
    removedBindings
      .filter((binding) => binding.createdForBinding)
      .map((binding) => binding.savedSecretId),
  );
  const removableSecretIds = new Set<string>();
  for (const secretId of candidateSecretIds) {
    if (
      secrets.some((secret) => secret.id === secretId)
      && listAccountSettingsSavedSecretReferences(withoutBindings, secretId).length === 0
    ) {
      removableSecretIds.add(secretId);
    }
  }
  const retainedSecrets = secrets.filter((secret) => !removableSecretIds.has(secret.id));
  const nextSettings = removableSecretIds.size === 0
    ? withoutBindings
    : Object.freeze({
      ...withoutBindings,
      secrets: Object.freeze(retainedSecrets),
    });
  return Object.freeze({
    settings: nextSettings,
    removedBindingCount: removedBindings.length,
    removedSavedSecretCount: removableSecretIds.size,
  });
}

/**
 * Resolves only a safe Account SavedSecret reference for one host-stamped
 * plugin/id pair. A missing binding is ordinary absence; malformed or dangling
 * bindings fail closed before a caller can disclose material.
 */
export function resolveAccountSettingsPluginSecret(
  settings: Readonly<Record<string, unknown>>,
  target: PluginAccountSecretBindingTarget,
): AccountSettingsPluginSecretResolution | null {
  const targetState = readPluginAccountSecretBindingTarget(settings, target);
  if (!targetState.binding) return null;
  const secret = readSavedSecrets(settings).find((candidate) => (
    candidate.id === targetState.binding!.savedSecretId
  ));
  if (!secret) {
    pluginSecretBindingError('Plugin SavedSecret binding points at a missing SavedSecret');
  }
  return Object.freeze({ binding: targetState.binding, secret });
}

/**
 * Resolves the strict host-owned plugin binding without claiming its target is
 * a personal Account Settings row. Shared material is authorized and opened by
 * the unified Saved Secret catalog/materializer at the operation boundary.
 */
export function resolveAccountSettingsPluginSecretBinding(
  settings: Readonly<Record<string, unknown>>,
  target: PluginAccountSecretBindingTarget,
): PluginAccountSecretBinding | null {
  const targetState = readPluginAccountSecretBindingTarget(settings, target);
  if (!targetState.binding) return null;
  try {
    parseSavedSecretRefV1(targetState.binding.savedSecretId);
  } catch {
    pluginSecretBindingError('Plugin SavedSecret binding reference is invalid');
  }
  return targetState.binding;
}

function collectSlotBindingReferences(input: Readonly<{
  value: unknown;
  secretId: string;
  owner: 'provider' | 'voice';
  path: string;
  output: AccountSettingsSavedSecretReference[];
}>): void {
  const root = ownRecord(input.value);
  if (!root) return;
  const account = ownRecord(root.account);
  if (account) {
    for (const [slotId, candidate] of Object.entries(account)) {
      if (candidate === input.secretId) {
        input.output.push(Object.freeze({
          owner: input.owner,
          path: `${input.path}.account${pathSegment(slotId)}`,
        }));
      }
    }
  }
  const byMachineId = ownRecord(root.byMachineId);
  if (!byMachineId) return;
  for (const [machineId, rawBindings] of Object.entries(byMachineId)) {
    const bindings = ownRecord(rawBindings);
    if (!bindings) continue;
    for (const [slotId, candidate] of Object.entries(bindings)) {
      if (candidate === input.secretId) {
        input.output.push(Object.freeze({
          owner: input.owner,
          path: `${input.path}.byMachineId${pathSegment(machineId)}${pathSegment(slotId)}`,
        }));
      }
    }
  }
}

function collectValueRefMapReferences(input: Readonly<{
  value: unknown;
  secretId: string;
  owner: 'mcp' | 'acp';
  path: string;
  output: AccountSettingsSavedSecretReference[];
}>): void {
  const valueRefMap = ownRecord(input.value);
  if (!valueRefMap) return;
  for (const [key, candidate] of Object.entries(valueRefMap)) {
    const valueRef = ownRecord(candidate);
    if (valueRef?.t === 'savedSecret' && valueRef.secretId === input.secretId) {
      input.output.push(Object.freeze({
        owner: input.owner,
        path: `${input.path}${pathSegment(key)}`,
      }));
    }
  }
}

function collectMcpReferences(
  settings: Readonly<Record<string, unknown>>,
  secretId: string,
  output: AccountSettingsSavedSecretReference[],
): void {
  const root = ownRecord(settings[MCP_SETTINGS_KEY]);
  if (!root) return;
  if (Array.isArray(root.servers)) {
    root.servers.forEach((candidate, index) => {
      const server = ownRecord(candidate);
      if (!server) return;
      collectValueRefMapReferences({
        value: server.env,
        secretId,
        owner: 'mcp',
        path: `${MCP_SETTINGS_KEY}.servers[${index}].env`,
        output,
      });
      const remote = ownRecord(server.remote);
      collectValueRefMapReferences({
        value: remote?.headers,
        secretId,
        owner: 'mcp',
        path: `${MCP_SETTINGS_KEY}.servers[${index}].remote.headers`,
        output,
      });
    });
  }
  if (Array.isArray(root.bindings)) {
    root.bindings.forEach((candidate, index) => {
      const binding = ownRecord(candidate);
      const overrides = ownRecord(binding?.overrides);
      if (!overrides) return;
      collectValueRefMapReferences({
        value: overrides.envPatch,
        secretId,
        owner: 'mcp',
        path: `${MCP_SETTINGS_KEY}.bindings[${index}].overrides.envPatch`,
        output,
      });
      const remote = ownRecord(overrides.remote);
      collectValueRefMapReferences({
        value: remote?.headersPatch,
        secretId,
        owner: 'mcp',
        path: `${MCP_SETTINGS_KEY}.bindings[${index}].overrides.remote.headersPatch`,
        output,
      });
    });
  }
}

function collectAcpReferences(
  settings: Readonly<Record<string, unknown>>,
  secretId: string,
  output: AccountSettingsSavedSecretReference[],
): void {
  const root = ownRecord(settings[ACP_SETTINGS_KEY]);
  if (!root || !Array.isArray(root.backends)) return;
  root.backends.forEach((candidate, index) => {
    const backend = ownRecord(candidate);
    if (!backend) return;
    collectValueRefMapReferences({
      value: backend.env,
      secretId,
      owner: 'acp',
      path: `${ACP_SETTINGS_KEY}.backends[${index}].env`,
      output,
    });
  });
}

function collectProviderReferences(
  settings: Readonly<Record<string, unknown>>,
  secretId: string,
  output: AccountSettingsSavedSecretReference[],
): void {
  const provider = ownRecord(settings[PROVIDER_SETTINGS_KEY]);
  const bindingsByConnectionId = ownRecord(provider?.secretBindingsByConnectionId);
  if (!bindingsByConnectionId) return;
  for (const [connectionId, bindings] of Object.entries(bindingsByConnectionId)) {
    collectSlotBindingReferences({
      value: bindings,
      secretId,
      owner: 'provider',
      path: `${PROVIDER_SETTINGS_KEY}.secretBindingsByConnectionId${pathSegment(connectionId)}`,
      output,
    });
  }
}

function collectVoiceReferences(
  settings: Readonly<Record<string, unknown>>,
  secretId: string,
  output: AccountSettingsSavedSecretReference[],
): void {
  for (const rootKey of VOICE_SETTINGS_KEYS) {
    const voice = ownRecord(settings[rootKey]);
    if (!Array.isArray(voice?.credentialBindings)) continue;
    voice.credentialBindings.forEach((candidate, index) => {
      const binding = ownRecord(candidate);
      if (!binding) return;
      collectSlotBindingReferences({
        value: binding.credentialBindings,
        secretId,
        owner: 'voice',
        path: `${rootKey}.credentialBindings[${index}].credentialBindings`,
        output,
      });
    });
  }
}

type VoiceCredentialTarget = VoiceCredentialSecretTarget;

type VoiceCredentialTargetState = Readonly<{
  root: Readonly<Record<string, unknown>>;
  credentialBindings: readonly Readonly<Record<string, unknown>>[];
  bindingIndex: number;
  binding: Readonly<Record<string, unknown>> | null;
  exactSecretId: string | null;
}>;

function sameContribution(
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function parseQualifiedVoiceCredentialTarget(
  target: VoiceCredentialSecretTarget,
): VoiceCredentialSecretTarget {
  const raw = ownRecord(target);
  const contribution = PluginContributionIdentityV1Schema.safeParse(
    raw?.contribution,
  );
  if (
    !raw
    || !hasOnlyOwnKeys(raw, ['contribution', 'credentialSlotId', 'machineId'])
    || !contribution.success
    || !PluginCredentialAccessSlotIdSchema.safeParse(
      raw.credentialSlotId,
    ).success
    || (
      raw.machineId !== null
      && !ProviderMachineIdSchema.safeParse(raw.machineId).success
    )
  ) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Qualified Voice credential target is invalid',
    );
  }
  return Object.freeze({
    contribution: contribution.data,
    credentialSlotId: raw.credentialSlotId as string,
    machineId: raw.machineId as string | null,
  });
}

function parseCanonicalVoiceCredentialBinding(
  candidate: unknown,
): VoiceCredentialBindingV1 {
  const parsed = VoiceCredentialBindingV1Schema.safeParse(candidate);
  if (!parsed.success) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Voice credential reference is invalid',
    );
  }
  return parsed.data;
}

function parseVoiceCredentialBindingForReferenceEnumeration(
  candidate: unknown,
): Readonly<Record<string, unknown>> {
  const legacy = LegacyVoiceCredentialBindingV1Schema.safeParse(candidate);
  return legacy.success
    ? legacy.data
    : parseCanonicalVoiceCredentialBinding(candidate);
}

function readCanonicalVoiceCredentialBindings(settings: Readonly<Record<string, unknown>>) {
  const rawRoot = settings.voiceSettingsV1;
  const root = rawRoot === undefined ? {} : ownRecord(rawRoot);
  if (!root || (root.credentialBindings !== undefined && !Array.isArray(root.credentialBindings))) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Voice credential references are invalid',
    );
  }
  const credentialBindings = (root.credentialBindings ?? []) as readonly unknown[];
  return { root, bindings: credentialBindings.map(parseCanonicalVoiceCredentialBinding) };
}

function readVoiceCredentialTarget(
  settings: Readonly<Record<string, unknown>>,
  target: VoiceCredentialTarget,
): VoiceCredentialTargetState {
  const qualifiedTarget = parseQualifiedVoiceCredentialTarget(target);
  const { root, bindings: parsed } = readCanonicalVoiceCredentialBindings(settings);
  const matchingIndexes = parsed.flatMap((binding, index) => (
    PluginContributionIdentityV1Schema.safeParse(binding.contribution).success
    && sameContribution(
      PluginContributionIdentityV1Schema.parse(binding.contribution),
      qualifiedTarget.contribution,
    )
    && binding.credentialSlotId === qualifiedTarget.credentialSlotId
      ? [index]
      : []
  ));
  if (matchingIndexes.length > 1) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Voice credential target is duplicated',
    );
  }
  const bindingIndex = matchingIndexes[0] ?? -1;
  const binding = bindingIndex >= 0 ? parsed[bindingIndex]! : null;
  const slotBindings = ownRecord(binding?.credentialBindings);
  const account = ownRecord(slotBindings?.account);
  const byMachineId = ownRecord(slotBindings?.byMachineId);
  const machineId = qualifiedTarget.machineId;
  const credentialSlotId = qualifiedTarget.credentialSlotId;
  const machineBindings = machineId
    ? ownRecord(byMachineId?.[machineId])
    : null;
  const candidate = machineId
    ? machineBindings?.[credentialSlotId]
    : account?.[credentialSlotId];
  if (candidate !== undefined && typeof candidate !== 'string') {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Voice credential target reference is invalid',
    );
  }
  return Object.freeze({
    root,
    credentialBindings: Object.freeze(parsed),
    bindingIndex,
    binding,
    exactSecretId: typeof candidate === 'string' ? candidate : null,
  });
}

function readSelectedVoiceCredentialSlotReference(
  binding: Readonly<Record<string, unknown>> | null,
  credentialSlotId: string,
  machineId: string | null,
) {
  const slotBindings = ownRecord(binding?.credentialBindings) ?? {};
  const account = ownRecord(slotBindings.account);
  const byMachineId = ownRecord(slotBindings.byMachineId);
  const machine = machineId === null ? null : ownRecord(byMachineId?.[machineId]);
  const machineSecretId = machine?.[credentialSlotId];
  const accountSecretId = account?.[credentialSlotId];
  return machineId !== null && typeof machineSecretId === 'string'
    ? Object.freeze({ secretId: machineSecretId, source: 'machine_override' as const })
    : typeof accountSecretId === 'string'
      ? Object.freeze({ secretId: accountSecretId, source: 'account' as const })
      : null;
}

/**
 * Resolves the current SavedSecret reference at the qualified Voice target.
 * A concrete machine uses its exact override before the account default;
 * `machineId: null` deliberately ignores every machine override.
 */
export function resolveAccountSettingsVoiceCredentialSecret(
  settings: Readonly<Record<string, unknown>>,
  target: VoiceCredentialSecretTarget,
): AccountSettingsVoiceCredentialSecretResolution {
  const qualifiedTarget = parseQualifiedVoiceCredentialTarget(target);
  const state = readVoiceCredentialTarget(settings, qualifiedTarget);
  const candidate = readSelectedVoiceCredentialSlotReference(state.binding, qualifiedTarget.credentialSlotId, qualifiedTarget.machineId);
  const reference = candidate
    && (
      isStrictSharedSavedSecretRefV1(candidate.secretId)
      || readSavedSecrets(settings).some((secret) => secret.id === candidate.secretId)
    )
    ? candidate
    : null;
  const digest = state.binding?.approvedRecipientContractDigest;
  return Object.freeze({
    exactSecretId: state.exactSecretId,
    reference,
    approvedRecipientContractDigest:
      typeof digest === 'string' ? digest : null,
  });
}

function writeVoiceCredentialTarget(input: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  target: VoiceCredentialTarget;
  state: VoiceCredentialTargetState;
  secretId: string | null;
  approvedRecipientContractDigest?: string;
}>): Readonly<Record<string, unknown>> {
  if (
    !VoiceCredentialBindingV1Schema.shape.approvedRecipientContractDigest
      .safeParse(input.approvedRecipientContractDigest).success
  ) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Voice credential recipient contract digest is invalid',
    );
  }
  const existingSlotBindings = ownRecord(input.state.binding?.credentialBindings) ?? {};
  const account = { ...(ownRecord(existingSlotBindings.account) ?? {}) };
  const byMachineId = { ...(ownRecord(existingSlotBindings.byMachineId) ?? {}) };
  const qualifiedTarget = parseQualifiedVoiceCredentialTarget(input.target);
  const machineId = qualifiedTarget.machineId;
  const credentialSlotId = qualifiedTarget.credentialSlotId;
  if (machineId) {
    const machine = {
      ...(ownRecord(byMachineId[machineId]) ?? {}),
    };
    if (input.secretId) {
      machine[credentialSlotId] = input.secretId;
    } else {
      delete machine[credentialSlotId];
    }
    if (Object.keys(machine).length > 0) {
      byMachineId[machineId] = machine;
    } else {
      delete byMachineId[machineId];
    }
  } else if (input.secretId) {
    account[credentialSlotId] = input.secretId;
  } else {
    delete account[credentialSlotId];
  }
  const nextSlotBindings: MutableRecord = { ...existingSlotBindings };
  if (Object.keys(account).length > 0) nextSlotBindings.account = account;
  else delete nextSlotBindings.account;
  if (Object.keys(byMachineId).length > 0) nextSlotBindings.byMachineId = byMachineId;
  else delete nextSlotBindings.byMachineId;

  const credentialBindings = [...input.state.credentialBindings];
  const nextBinding = {
    ...(input.state.binding ?? {}),
    contribution: qualifiedTarget.contribution,
    credentialSlotId: qualifiedTarget.credentialSlotId,
    credentialSource: input.state.binding?.credentialSource
      ?? { kind: 'none' },
    credentialBindings: nextSlotBindings,
    ...(input.approvedRecipientContractDigest === undefined
      ? {}
      : {
          approvedRecipientContractDigest:
            input.approvedRecipientContractDigest,
        }),
  };
  if (input.state.bindingIndex >= 0) {
    credentialBindings[input.state.bindingIndex] = nextBinding;
  } else {
    credentialBindings.push(nextBinding);
  }
  return Object.freeze({
    ...input.settings,
    voiceSettingsV1: {
      ...input.state.root,
      credentialBindings,
    },
  });
}

function parseVoiceCredentialSourceMutationIdentity(input: Readonly<{
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  purpose: QualifiedConnectedAccountPurposeV1;
}>): Readonly<{
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  purpose: QualifiedConnectedAccountPurposeV1;
}> {
  const contribution = PluginContributionIdentityV1Schema.safeParse(
    input.contribution,
  );
  const purpose = QualifiedConnectedAccountPurposeV1Schema.safeParse(
    input.purpose,
  );
  if (
    !contribution.success
    || !purpose.success
    || !PluginCredentialAccessSlotIdSchema.safeParse(
      input.credentialSlotId,
    ).success
    || !sameContribution(contribution.data, purpose.data.consumer)
  ) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Voice credential source identity is invalid',
    );
  }
  return Object.freeze({
    contribution: contribution.data,
    credentialSlotId: input.credentialSlotId,
    purpose: purpose.data,
  });
}

function parseVoiceCredentialSourceSelection(
  selection: VoiceCredentialSourceSelection,
): VoiceCredentialSourceSelection {
  const raw = ownRecord(selection);
  if (!raw || typeof raw.kind !== 'string') {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Voice credential source selection is invalid',
    );
  }
  if (
    (raw.kind === 'none' || raw.kind === 'savedSecret')
    && Object.keys(raw).length === 1
  ) {
    return Object.freeze({ kind: raw.kind });
  }
  if (raw.kind === 'connectedAccount' && Object.keys(raw).length === 2) {
    const target = QualifiedConnectedAccountPurposeBindingTargetV1Schema
      .safeParse(raw.target);
    if (target.success) {
      return Object.freeze({
        kind: 'connectedAccount',
        target: target.data,
      });
    }
  }
  throw new AccountSettingsSavedSecretMutationError(
    'saved_secret_invalid',
    'Voice credential source selection is invalid',
  );
}

/**
 * Reads the one persisted Connected Account purpose-binding root used by the
 * combined Voice credential-source mutation. An omitted root predates the
 * feature and initializes empty; any present noncanonical value is evidence
 * that must be preserved and rejected before a caller can write Settings.
 */
export function readAccountSettingsConnectedAccountPurposeBindings(
  settings: Readonly<Record<string, unknown>>,
  catalogs?: Pick<SavedSecretReferenceCatalogsV1, 'connectedPurposes'>,
): QualifiedConnectedAccountPurposeBindingsV1 {
  if (catalogs?.connectedPurposes !== undefined) {
    const parsed = ConnectedPurposeCatalogV1Schema.safeParse(catalogs.connectedPurposes ?? { v: 1, bindings: [] });
    if (!parsed.success) invalidReferenceRoot('Connected Account purpose inventory is invalid');
    return parsed.data;
  }
  const raw = settings.connectedAccountPurposeBindingsV1;
  if (raw === undefined) {
    return QualifiedConnectedAccountPurposeBindingsV1Schema.parse({
      v: 1,
      bindings: [],
    });
  }
  const parsed = QualifiedConnectedAccountPurposeBindingsV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Connected Account purpose bindings are invalid',
    );
  }
  return parsed.data;
}

function readQualifiedPurposeBindings(
  settings: Readonly<Record<string, unknown>>,
  catalogs?: Pick<SavedSecretReferenceCatalogsV1, 'connectedPurposes'>,
): readonly QualifiedConnectedAccountPurposeBindingV1[] {
  return Object.freeze(
    readAccountSettingsConnectedAccountPurposeBindings(settings, catalogs).bindings,
  );
}

function findQualifiedPurposeBinding(
  bindings: readonly QualifiedConnectedAccountPurposeBindingV1[],
  purpose: QualifiedConnectedAccountPurposeV1,
): QualifiedConnectedAccountPurposeBindingV1 | null {
  const key = qualifiedPurposeKey(purpose);
  return bindings.find((candidate) => (
    qualifiedPurposeKey(candidate.purpose) === key
  )) ?? null;
}

function writeVoiceCredentialSource(input: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  kind: VoiceCredentialSourceSelection['kind'];
}>): Readonly<Record<string, unknown>> {
  const target = Object.freeze({
    contribution: input.contribution,
    credentialSlotId: input.credentialSlotId,
    machineId: null,
  });
  const state = readVoiceCredentialTarget(input.settings, target);
  const credentialBindings = [...state.credentialBindings];
  const nextBinding = {
    ...(state.binding ?? {}),
    contribution: input.contribution,
    credentialSlotId: input.credentialSlotId,
    credentialSource: { kind: input.kind },
    credentialBindings: ownRecord(state.binding?.credentialBindings) ?? {},
  };
  if (state.bindingIndex >= 0) {
    credentialBindings[state.bindingIndex] = nextBinding;
  } else {
    credentialBindings.push(nextBinding);
  }
  return Object.freeze({
    ...input.settings,
    voiceSettingsV1: {
      ...state.root,
      credentialBindings,
    },
  });
}

function writeVoicePurposeBinding(input: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  purpose: QualifiedConnectedAccountPurposeV1;
  selection: VoiceCredentialSourceSelection;
  catalogs?: Pick<SavedSecretReferenceCatalogsV1, 'connectedPurposes'>;
}>): Readonly<{
  settings: Readonly<Record<string, unknown>>;
  binding: QualifiedConnectedAccountPurposeBindingV1 | null;
  connectedPurposes?: ConnectedPurposeCatalogV1;
}> {
  const current = readAccountSettingsConnectedAccountPurposeBindings(input.settings, input.catalogs);
  const existing = current.bindings;
  const purposeKey = qualifiedPurposeKey(input.purpose);
  const withoutPurpose = existing.filter((candidate) => (
    qualifiedPurposeKey(candidate.purpose) !== purposeKey
  ));
  // The same document holds Agent Team resource defaults; they are kept, and
  // the written purpose keeps exactly one default.
  const teamResourceSelections = (current.teamResourceSelections ?? []).filter((candidate) => (
    qualifiedPurposeKey(candidate.purpose) !== purposeKey
  ));
  const binding = input.selection.kind === 'connectedAccount'
    ? Object.freeze({
        purpose: input.purpose,
        target: input.selection.target,
      })
    : null;
  const destination = input.catalogs?.connectedPurposes !== undefined;
  const next = (destination ? ConnectedPurposeCatalogV1Schema : QualifiedConnectedAccountPurposeBindingsV1Schema).parse({
    v: 1,
    bindings: binding ? [...withoutPurpose, binding] : withoutPurpose,
    ...(teamResourceSelections.length > 0 ? { teamResourceSelections } : {}),
  });
  return Object.freeze({
    settings: destination ? input.settings : Object.freeze({
      ...input.settings,
      connectedAccountPurposeBindingsV1: next,
    }),
    binding,
    ...(destination ? { connectedPurposes: next } : {}),
  });
}

/**
 * Pure Account Settings owner seam. The caller must admit the returned object
 * through the existing outer Account Settings V2 version CAS; this function
 * deliberately owns no retry or persistence path.
 */
export function applyAccountSettingsVoiceCredentialSourceMutation(
  settings: Readonly<Record<string, unknown>>,
  mutation: AccountSettingsVoiceCredentialSourceMutation,
  currentDeclaration: VoiceProviderContribution,
  catalogs?: SavedSecretReferenceCatalogsV1 | Pick<SavedSecretReferenceCatalogsV1, 'connectedPurposes'>,
): Readonly<{
  settings: Readonly<Record<string, unknown>>;
  selection: VoiceCredentialSourceSelection;
  binding: QualifiedConnectedAccountPurposeBindingV1 | null;
  connectedPurposes?: ConnectedPurposeCatalogV1;
}> {
  const rawMutation = ownRecord(mutation);
  if (
    !rawMutation
    || !hasOnlyOwnKeys(rawMutation, [
      'contribution',
      'credentialSlotId',
      'selection',
      'expectedSettingsVersion',
      'savedSecretMutation',
    ])
  ) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Voice credential source mutation is invalid',
    );
  }
  if (!Number.isInteger(mutation.expectedSettingsVersion)
    || mutation.expectedSettingsVersion < 0) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Voice credential source mutation settings version is invalid',
    );
  }
  let derivedIdentity: ReturnType<typeof deriveVoiceCredentialBindingIdentityV1>;
  try {
    derivedIdentity = deriveVoiceCredentialBindingIdentityV1({
      pluginId: mutation.contribution.pluginId,
      contribution: currentDeclaration,
    });
  } catch {
    derivedIdentity = null;
  }
  if (!derivedIdentity
    || !sameContribution(derivedIdentity.contribution, mutation.contribution)
    || derivedIdentity.credentialSlotId !== mutation.credentialSlotId) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Voice credential source mutation does not match the current declaration',
    );
  }
  const identity = parseVoiceCredentialSourceMutationIdentity(derivedIdentity);
  const selection = parseVoiceCredentialSourceSelection(mutation.selection);
  if (selection.kind === 'savedSecret'
    && currentDeclaration.credentials?.sources.some((source) => (
      source.kind === 'savedSecret'
    )) !== true) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Voice SavedSecret source is not declared by the current contribution',
    );
  }
  if (selection.kind === 'connectedAccount') {
    const selectedService = selection.target.kind === 'account'
      ? selection.target.account.service
      : selection.target.service;
    const declared = currentDeclaration.credentials?.sources.some((source) => (
      source.kind === 'connectedAccount'
      && sameContribution(
        typeof source.service === 'string'
          ? {
              pluginId: mutation.contribution.pluginId,
              localId: source.service,
            }
          : source.service,
        selectedService,
      )
    )) === true;
    if (!declared) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'Voice Connected Account source is not declared by the current contribution',
      );
    }
  }
  if (mutation.savedSecretMutation) {
    if (mutation.savedSecretMutation.kind !== 'replaceVoiceCredentialSecret'
      && mutation.savedSecretMutation.kind !== 'bindVoiceCredentialSavedSecret') {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'Voice credential source mutation may only carry a SavedSecret replacement or binding',
      );
    }
    if (selection.kind !== 'savedSecret') {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'A Voice SavedSecret replacement may only accompany SavedSecret selection',
      );
    }
    const target = parseQualifiedVoiceCredentialTarget(
      mutation.savedSecretMutation.target,
    );
    if (
      !sameContribution(target.contribution, identity.contribution)
      || target.credentialSlotId !== identity.credentialSlotId
    ) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'Voice SavedSecret replacement target does not match its source selection',
      );
    }
  }

  let withSecret = settings;
  if (mutation.savedSecretMutation?.kind === 'replaceVoiceCredentialSecret') {
    if (catalogs !== undefined) {
      if (!('profileRecords' in catalogs) || !Array.isArray(catalogs.profileRecords)) {
        invalidReferenceRoot('Voice SavedSecret replacement requires the complete opened reference inventory');
      }
      listSavedSecretReferenceCatalogRefsV1(catalogs);
    }
    withSecret = applyAccountSettingsSavedSecretMutation(settings, mutation.savedSecretMutation, catalogs).settings;
  } else if (mutation.savedSecretMutation) {
    // Binding selects an existing resource and retains every old personal secret;
    // it needs no deletion census or fabricated Profile inventory.
    withSecret = applyAccountSettingsSavedSecretMutation(settings, mutation.savedSecretMutation).settings;
  }
  const withSource = writeVoiceCredentialSource({
    settings: withSecret,
    contribution: identity.contribution,
    credentialSlotId: identity.credentialSlotId,
    kind: selection.kind,
  });
  const withPurpose = writeVoicePurposeBinding({
    settings: withSource,
    purpose: identity.purpose,
    selection,
    catalogs,
  });
  return Object.freeze({
    settings: withPurpose.settings,
    selection,
    binding: withPurpose.binding,
    ...(withPurpose.connectedPurposes === undefined ? {} : { connectedPurposes: withPurpose.connectedPurposes }),
  });
}

export function resolveAccountSettingsVoiceCredentialSource(
  settings: Readonly<Record<string, unknown>>,
  input: Readonly<{
    contribution: PluginContributionIdentityV1;
    credentialSlotId: string;
    purpose: QualifiedConnectedAccountPurposeV1;
    machineId: string | null;
  }>,
  catalogs?: Pick<SavedSecretReferenceCatalogsV1, 'connectedPurposes'>,
): AccountSettingsVoiceCredentialSourceResolution {
  const rawInput = ownRecord(input);
  if (
    !rawInput
    || !hasOnlyOwnKeys(rawInput, [
      'contribution',
      'credentialSlotId',
      'purpose',
      'machineId',
    ])
  ) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Voice credential source resolution input is invalid',
    );
  }
  const identity = parseVoiceCredentialSourceMutationIdentity(input);
  const target = parseQualifiedVoiceCredentialTarget({
    contribution: identity.contribution,
    credentialSlotId: identity.credentialSlotId,
    machineId: input.machineId,
  });
  const state = readVoiceCredentialTarget(settings, target);
  const source = ownRecord(state.binding?.credentialSource) ?? { kind: 'none' };
  const purposeBinding = findQualifiedPurposeBinding(
    readQualifiedPurposeBindings(settings, catalogs),
    identity.purpose,
  );
  const rawDigest = state.binding?.approvedRecipientContractDigest;
  const approvedRecipientContractDigest = typeof rawDigest === 'string' ? rawDigest : null;
  if (source.kind === 'connectedAccount') {
    if (!purposeBinding) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_reference_invalid',
        'Selected Voice Connected Account binding is missing',
      );
    }
    return Object.freeze({
      selection: Object.freeze({
        kind: 'connectedAccount',
        target: purposeBinding.target,
      }),
      binding: purposeBinding,
      savedSecret: null,
      approvedRecipientContractDigest,
    });
  }
  if (purposeBinding) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Dormant Voice Connected Account binding remained effective',
    );
  }
  if (source.kind === 'none') {
    return Object.freeze({
      selection: Object.freeze({ kind: 'none' }),
      binding: null,
      savedSecret: null,
      approvedRecipientContractDigest,
    });
  }
  if (source.kind !== 'savedSecret') {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Voice credential source discriminant is invalid',
    );
  }
  const selected = readSelectedVoiceCredentialSlotReference(state.binding, identity.credentialSlotId, input.machineId);
  const secrets = readSavedSecrets(settings);
  const selectedIsSharedReference = selected
    ? isStrictSharedSavedSecretRefV1(selected.secretId)
    : false;
  const savedSecret = selected
    && (
      selectedIsSharedReference
      || secrets.some((candidate) => candidate.id === selected.secretId)
    )
    ? selected
    : null;
  return Object.freeze({
    selection: Object.freeze({ kind: 'savedSecret' }),
    binding: null,
    savedSecret,
    approvedRecipientContractDigest,
  });
}

export function resolveSavedSecretCatalogVoiceCredentialSourceV1(
  settings: Readonly<Record<string, unknown>>,
  input: Parameters<typeof resolveAccountSettingsVoiceCredentialSource>[1],
  catalogs: Pick<SavedSecretReferenceCatalogsV1, 'connectedPurposes'>,
): AccountSettingsVoiceCredentialSourceResolution {
  return resolveAccountSettingsVoiceCredentialSource(settings, input, catalogs);
}

export function applySavedSecretCatalogVoiceCredentialSourceMutationV1(
  settings: Readonly<Record<string, unknown>>,
  mutation: AccountSettingsVoiceCredentialSourceMutation,
  declaration: VoiceProviderContribution,
  catalogs: SavedSecretReferenceCatalogsV1 | Pick<SavedSecretReferenceCatalogsV1, 'connectedPurposes'>,
): ReturnType<typeof applyAccountSettingsVoiceCredentialSourceMutation> {
  if (mutation.savedSecretMutation?.kind === 'replaceVoiceCredentialSecret' && catalogs === undefined) {
    invalidReferenceRoot('Voice SavedSecret replacement requires the complete opened reference inventory');
  }
  return applyAccountSettingsVoiceCredentialSourceMutation(settings, mutation, declaration, catalogs);
}

/**
 * Resource-use admission for next selected Voice credentials, not a deletion
 * census. Requested refs admit same-ref reselection only while actually selected.
 */
export function listSavedSecretVoiceCredentialMutationReferencesV1(
  currentSettings: Readonly<Record<string, unknown>>,
  nextSettings: Readonly<Record<string, unknown>>,
  options: Readonly<{ requestedReferences?: readonly string[] }> = {},
): readonly string[] {
  const requested = options.requestedReferences ?? [];
  if (!Array.isArray(requested) || requested.some(reference => typeof reference !== 'string')) {
    invalidReferenceRoot('Voice requested SavedSecret references are invalid');
  }
  for (const reference of requested) {
    try { parseSavedSecretRefV1(reference); } catch { invalidReferenceRoot('Voice requested SavedSecret references are invalid'); }
  }
  const index = (settings: Readonly<Record<string, unknown>>) => {
    const bindings = new Map<string, VoiceCredentialBindingV1>();
    for (const binding of readCanonicalVoiceCredentialBindings(settings).bindings) {
      const key = JSON.stringify([binding.contribution.pluginId, binding.contribution.localId, binding.credentialSlotId]);
      if (bindings.has(key)) invalidReferenceRoot('Voice credential target is duplicated');
      bindings.set(key, binding);
    }
    return bindings;
  };
  const current = index(currentSettings);
  const next = index(nextSettings);
  const required = new Set<string>();
  const selected = new Set<string>();
  for (const [key, binding] of next) {
    if (binding.credentialSource.kind !== 'savedSecret') continue;
    const previous = current.get(key);
    const machineIds = new Set([
      ...Object.keys(previous?.credentialBindings.byMachineId ?? {}),
      ...Object.keys(binding.credentialBindings.byMachineId ?? {}),
    ]);
    for (const machineId of [null, ...machineIds]) {
      const reference = readSelectedVoiceCredentialSlotReference(binding, binding.credentialSlotId, machineId)?.secretId;
      if (!reference || !isStrictSharedSavedSecretRefV1(reference)) continue;
      selected.add(reference);
      const previousReference = previous?.credentialSource.kind === 'savedSecret'
        ? readSelectedVoiceCredentialSlotReference(previous, previous.credentialSlotId, machineId)?.secretId : undefined;
      if (reference !== previousReference) required.add(reference);
    }
  }
  for (const reference of requested) {
    if (selected.has(reference)) required.add(reference);
  }
  return Object.freeze([...required]);
}

function readConnectedAccountConfigurationEntries(
  settings: Readonly<Record<string, unknown>>,
): readonly ConnectedAccountServiceConfigurationEntryV1[] {
  const rawStore = settings[CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY];
  if (rawStore === undefined) return Object.freeze([]);
  try {
    return Object.freeze(
      parseConnectedAccountServiceConfigurationsV1(rawStore).entries,
    );
  } catch {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Connected Account service configuration references are invalid',
    );
  }
}

function collectConnectedAccountReferences(
  settings: Readonly<Record<string, unknown>>,
  secretId: string,
  output: AccountSettingsSavedSecretReference[],
): void {
  readConnectedAccountConfigurationEntries(settings).forEach((entry, index) => {
    for (const [fieldId, candidate] of Object.entries(entry.secretRefs)) {
      if (candidate === secretId) {
        output.push(Object.freeze({
          owner: 'connectedAccountConfiguration',
          path: `${CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY}.entries[${index}].secretRefs${pathSegment(fieldId)}`,
        }));
      }
    }
  });
}

function invalidReferenceRoot(message: string): never {
  throw new AccountSettingsSavedSecretMutationError(
    'saved_secret_reference_invalid',
    message,
  );
}

function validateStringMap(value: unknown, message: string): void {
  if (value === undefined) return;
  const record = ownRecord(value);
  if (!record) invalidReferenceRoot(message);
  if (Object.values(record).some((candidate) => typeof candidate !== 'string')) {
    invalidReferenceRoot(message);
  }
}

function validateSlotBindings(value: unknown, message: string): void {
  const root = ownRecord(value);
  if (!root) invalidReferenceRoot(message);
  validateStringMap(root.account, message);
  if (root.byMachineId === undefined) return;
  const byMachineId = ownRecord(root.byMachineId);
  if (!byMachineId) invalidReferenceRoot(message);
  Object.values(byMachineId).forEach((bindings) => {
    validateStringMap(bindings, message);
  });
}

function validateValueRefMap(
  value: unknown,
  message: string,
  allowNull: boolean,
): void {
  if (value === undefined) return;
  const record = ownRecord(value);
  if (!record) invalidReferenceRoot(message);
  Object.values(record).forEach((candidate) => {
    if (candidate === null && allowNull) return;
    const valueRef = ownRecord(candidate);
    if (
      !valueRef
      || (
        valueRef.t === 'savedSecret'
          ? typeof valueRef.secretId !== 'string'
          : valueRef.t === 'literal'
            ? typeof valueRef.v !== 'string'
            : true
      )
    ) {
      invalidReferenceRoot(message);
    }
  });
}

function validateKnownSavedSecretReferenceRoots(
  settings: Readonly<Record<string, unknown>>,
): void {
  // The plugin binding root is part of the same reference census as every
  // incumbent SavedSecret consumer. It contains only safe IDs, never raw
  // material, but it must still fail closed before a delete can proceed.
  readPluginAccountSecretBindings(settings);

  if (settings[PROFILE_BINDINGS_KEY] !== undefined) {
    const profiles = ownRecord(settings[PROFILE_BINDINGS_KEY]);
    if (!profiles) invalidReferenceRoot('Profile SavedSecret references are invalid');
    Object.values(profiles).forEach((bindings) => {
      validateStringMap(bindings, 'Profile SavedSecret reference is invalid');
    });
  }

  if (settings[PROVIDER_SETTINGS_KEY] !== undefined) {
    const provider = ownRecord(settings[PROVIDER_SETTINGS_KEY]);
    if (!provider) invalidReferenceRoot('Provider SavedSecret references are invalid');
    if (provider.secretBindingsByConnectionId !== undefined) {
      const connections = ownRecord(provider.secretBindingsByConnectionId);
      if (!connections) invalidReferenceRoot('Provider SavedSecret references are invalid');
      Object.values(connections).forEach((bindings) => {
        validateSlotBindings(bindings, 'Provider SavedSecret reference is invalid');
      });
    }
  }

  for (const rootKey of VOICE_SETTINGS_KEYS) {
    if (settings[rootKey] === undefined) continue;
    const voice = ownRecord(settings[rootKey]);
    if (!voice) invalidReferenceRoot('Voice SavedSecret references are invalid');
    if (voice.credentialBindings === undefined) continue;
    if (!Array.isArray(voice.credentialBindings)) {
      invalidReferenceRoot('Voice SavedSecret references are invalid');
    }
    voice.credentialBindings.forEach((candidate) => {
      const binding = parseVoiceCredentialBindingForReferenceEnumeration(candidate);
      validateSlotBindings(
        binding.credentialBindings,
        'Voice SavedSecret reference is invalid',
      );
    });
  }

  if (settings[MCP_SETTINGS_KEY] !== undefined) {
    const mcp = ownRecord(settings[MCP_SETTINGS_KEY]);
    if (!mcp) invalidReferenceRoot('MCP SavedSecret references are invalid');
    if (mcp.servers !== undefined && !Array.isArray(mcp.servers)) {
      invalidReferenceRoot('MCP SavedSecret references are invalid');
    }
    if (Array.isArray(mcp.servers)) {
      mcp.servers.forEach((candidate) => {
        const server = ownRecord(candidate);
        if (!server) invalidReferenceRoot('MCP SavedSecret reference is invalid');
        validateValueRefMap(
          server.env,
          'MCP SavedSecret reference is invalid',
          false,
        );
        if (server.remote !== undefined) {
          const remote = ownRecord(server.remote);
          if (!remote) invalidReferenceRoot('MCP SavedSecret reference is invalid');
          validateValueRefMap(
            remote.headers,
            'MCP SavedSecret reference is invalid',
            false,
          );
        }
      });
    }
    if (mcp.bindings !== undefined && !Array.isArray(mcp.bindings)) {
      invalidReferenceRoot('MCP SavedSecret references are invalid');
    }
    if (Array.isArray(mcp.bindings)) {
      mcp.bindings.forEach((candidate) => {
        const binding = ownRecord(candidate);
        if (!binding) invalidReferenceRoot('MCP SavedSecret reference is invalid');
        if (binding.overrides === undefined) return;
        const overrides = ownRecord(binding.overrides);
        if (!overrides) invalidReferenceRoot('MCP SavedSecret reference is invalid');
        validateValueRefMap(
          overrides.envPatch,
          'MCP SavedSecret reference is invalid',
          true,
        );
        if (overrides.remote !== undefined) {
          const remote = ownRecord(overrides.remote);
          if (!remote) invalidReferenceRoot('MCP SavedSecret reference is invalid');
          validateValueRefMap(
            remote.headersPatch,
            'MCP SavedSecret reference is invalid',
            true,
          );
        }
      });
    }
  }

  if (settings[ACP_SETTINGS_KEY] !== undefined) {
    const acp = ownRecord(settings[ACP_SETTINGS_KEY]);
    if (!acp) invalidReferenceRoot('ACP SavedSecret references are invalid');
    if (acp.backends !== undefined && !Array.isArray(acp.backends)) {
      invalidReferenceRoot('ACP SavedSecret references are invalid');
    }
    if (Array.isArray(acp.backends)) {
      acp.backends.forEach((candidate) => {
        const backend = ownRecord(candidate);
        if (!backend) invalidReferenceRoot('ACP SavedSecret reference is invalid');
        validateValueRefMap(
          backend.env,
          'ACP SavedSecret reference is invalid',
          false,
        );
      });
    }
  }
}

function collectPluginSecretReferences(
  settings: Readonly<Record<string, unknown>>,
  secretId: string,
  output: AccountSettingsSavedSecretReference[],
): void {
  const bindings = readPluginAccountSecretBindings(settings);
  for (const [key, binding] of Object.entries(bindings)) {
    if (binding.savedSecretId === secretId) {
      output.push(Object.freeze({
        owner: 'plugin',
        path: `${PLUGIN_SECRET_BINDINGS_SETTINGS_KEY}${pathSegment(key)}`,
      }));
    }
  }
}

/** Preserve identifiable future bindings instead of treating their inventory as empty. */
function collectUnknownSavedSecretReferences(
  value: unknown,
  secretId: string,
  output: AccountSettingsSavedSecretReference[],
  initialPath = '',
): void {
  const knownPaths = new Set(output.map((reference) => reference.path));
  for (const path of listSavedSecretReferenceCarrierPathsV1(value, { secretId, initialPath })) {
    if (knownPaths.has(path)) continue;
    knownPaths.add(path);
    output.push(Object.freeze({ owner: 'unknown', path }));
  }
}

function readReachedProfileArtifact(artifactId: string, catalogs?: SavedSecretReferenceCatalogsV1) {
  const resource = catalogs?.artifactsById?.get(artifactId);
  const artifact = resource && resource.artifactId === artifactId
    ? readLaunchProfileArtifactForReferenceCensusV1(resource) : null;
  if (!artifact) invalidReferenceRoot('Reached Profile Artifact reference inventory is unavailable');
  return artifact;
}

function readEffectiveProfileSavedSecretBindings(record: ProfileRecordV1, catalogs?: SavedSecretReferenceCatalogsV1): Readonly<Record<string, string>> {
  const bindings = readEffectiveProfileSecretBindingsV1(record, { artifactsById: catalogs?.artifactsById ?? new Map() });
  if (!bindings) invalidReferenceRoot('Reached Profile Artifact reference inventory is unavailable');
  return bindings;
}

function readReferenceSourceSettings(settings: Readonly<Record<string, unknown>>, catalogs?: SavedSecretReferenceCatalogsV1) {
  const control = catalogs?.profileControl;
  const source = control && resolveProfileCatalogAuthorityV1({ rawSettings: settings, control }) === 'destination'
    ? removeTransferredProfileSourcesV1(settings, listTransferredProfileIdsV1(control)) : settings;
  const activeRoots = new Set<string>([
    ...(catalogs?.mcp === undefined ? [] : [MCP_SETTINGS_KEY]),
    ...(catalogs?.acp === undefined ? [] : [ACP_SETTINGS_KEY]),
    ...(catalogs?.providerConnections === undefined ? [] : [PROVIDER_SETTINGS_KEY]),
    ...(catalogs?.connectedConfigurations === undefined ? [] : [CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY]),
    ...(catalogs?.connectedPurposes === undefined ? [] : ['connectedAccountPurposeBindingsV1']),
    ...(catalogs?.remoteHostRecords === undefined ? [] : ['remoteHostsV1']),
    ...(catalogs?.notificationChannels === undefined ? [] : ['notificationChannelsV1']),
  ]);
  return activeRoots.size ? Object.fromEntries(Object.entries(source).filter(([key]) => !activeRoots.has(key))) : source;
}

export type SavedSecretCatalogReferenceV1 = AccountSettingsSavedSecretReference & Readonly<{ secretId: string }>;

/** Domain schemas enumerate admitted slots; original carrier paths cannot silently disappear. */
export function listSavedSecretReferenceCatalogRefsV1(catalogs: SavedSecretReferenceCatalogsV1): readonly SavedSecretCatalogReferenceV1[] {
  const output: SavedSecretCatalogReferenceV1[] = [];
  const add = (value: unknown, references: readonly Readonly<{ path: string; secretId: string }>[],
    owner: AccountSettingsSavedSecretReferenceOwner, prefix: string): void => {
    const known = new Set(references.map(reference => reference.path));
    if (listSavedSecretReferenceCarrierPathsV1(value).some(path => !known.has(path))) {
      invalidReferenceRoot(`${prefix} SavedSecret reference inventory is incomplete`);
    }
    output.push(...references.map(reference => Object.freeze({ ...reference, owner, path: `${prefix}.${reference.path}` })));
  };
  const ids = new Set<string>();
  for (const record of catalogs.profileRecords) {
    if (!StoredProfileRecordV1Schema.safeParse(record).success || ids.has(record.id)) invalidReferenceRoot('Profile SavedSecret reference inventory is invalid');
    ids.add(record.id);
    for (const [fieldId, secretId] of Object.entries(readEffectiveProfileSavedSecretBindings(record, catalogs))) {
      output.push(Object.freeze({ owner: 'profile', path: `profileRows${pathSegment(record.id)}.secretBindings${pathSegment(fieldId)}`, secretId }));
    }
  }
  if (catalogs.remoteHostRecords !== undefined && catalogs.remoteHostRecords !== null) {
    const inventory = readRemoteHostCatalogRecordV1({ v: 1, hosts: catalogs.remoteHostRecords });
    if (inventory.status !== 'ready') invalidReferenceRoot('Remote host SavedSecret reference inventory is invalid');
    for (const host of inventory.hosts) for (const slot of ['passwordSecretRef', 'identityPrivateKeySecretRef'] as const) {
      const secretId = host.ssh[slot];
      if (typeof secretId === 'string') output.push(Object.freeze({ owner: 'remoteHost', path: `remoteHostRows${pathSegment(host.id)}.ssh.${slot}`, secretId }));
    }
  }
  if (catalogs.notificationChannels !== undefined && catalogs.notificationChannels !== null) {
    const parsed = NotificationChannelCatalogRecordV1Schema.safeParse(catalogs.notificationChannels);
    if (!parsed.success) invalidReferenceRoot('Notification channel SavedSecret reference inventory is invalid');
    add(catalogs.notificationChannels, listNotificationChannelSavedSecretReferenceSlotsV1(parsed.data), 'notificationChannel', 'notificationChannelsCatalog');
  }
  if (catalogs.mcp) {
    const parsed = McpServerCatalogV1Schema.safeParse(catalogs.mcp);
    if (!parsed.success) invalidReferenceRoot('MCP SavedSecret reference inventory is invalid');
    add(catalogs.mcp, listMcpServerCatalogSavedSecretRefsV1(parsed.data), 'mcp', 'mcpCatalog');
  }
  if (catalogs.acp) {
    const parsed = AcpCatalogRecordV1Schema.safeParse(catalogs.acp);
    if (!parsed.success) invalidReferenceRoot('ACP SavedSecret reference inventory is invalid');
    add(catalogs.acp, listAcpCatalogSavedSecretRefsV1(parsed.data), 'acp', 'acpCatalog');
  }
  if (catalogs.providerConnections) {
    const parsed = ProviderConnectionsCatalogV1Schema.safeParse(catalogs.providerConnections);
    if (!parsed.success) invalidReferenceRoot('Provider SavedSecret reference inventory is invalid');
    add(catalogs.providerConnections, listProviderConnectionsCatalogSavedSecretRefsV1(parsed.data), 'provider', 'providerConnectionsCatalog');
  }
  if (catalogs.connectedConfigurations) {
    const parsed = ConnectedConfigurationCatalogV1Schema.safeParse(catalogs.connectedConfigurations);
    if (!parsed.success) invalidReferenceRoot('Connected Account configuration SavedSecret reference inventory is invalid');
    add(catalogs.connectedConfigurations, listConnectedConfigurationCatalogSavedSecretRefsV1(parsed.data), 'connectedAccountConfiguration', 'connectedConfigurationsCatalog');
  }
  if (catalogs.connectedPurposes) {
    if (!ConnectedPurposeCatalogV1Schema.safeParse(catalogs.connectedPurposes).success) invalidReferenceRoot('Connected Account purpose inventory is invalid');
    add(catalogs.connectedPurposes, [], 'connectedAccountConfiguration', 'connectedPurposesCatalog');
  }
  return Object.freeze(output);
}

function readRawProfileArtifactDefaults(settings: Readonly<Record<string, unknown>>, catalogs?: SavedSecretReferenceCatalogsV1) {
  const output: Array<Readonly<{ profileId: string; bindings: Readonly<Record<string, string>> }>> = [];
  if (!Array.isArray(settings.profiles)) return output;
  const referenceSchema = createStoredReadSchema(LaunchProfileArtifactReferenceV1Schema);
  for (const source of settings.profiles) {
    const reference = referenceSchema.safeParse(source);
    if (!reference.success) continue;
    const artifact = readReachedProfileArtifact(reference.data.artifactId, catalogs);
    output.push({ profileId: artifact.profile.id, bindings: artifact.secretBindings });
  }
  return output;
}

export function listAccountSettingsSavedSecretReferences(
  settings: Readonly<Record<string, unknown>>,
  secretId: string,
  catalogs?: SavedSecretReferenceCatalogsV1,
): readonly AccountSettingsSavedSecretReference[] {
  if (!secretId) return Object.freeze([]);
  settings = readReferenceSourceSettings(settings, catalogs);
  validateKnownSavedSecretReferenceRoots(settings);
  const output: AccountSettingsSavedSecretReference[] = [];
  const profiles = ownRecord(settings[PROFILE_BINDINGS_KEY]);
  if (profiles) {
    for (const [profileId, rawBindings] of Object.entries(profiles)) {
      const bindings = ownRecord(rawBindings);
      if (!bindings) continue;
      for (const [fieldId, candidate] of Object.entries(bindings)) {
        if (candidate === secretId) {
          output.push(Object.freeze({
            owner: 'profile',
            path: `${PROFILE_BINDINGS_KEY}${pathSegment(profileId)}${pathSegment(fieldId)}`,
          }));
        }
      }
    }
  }
  for (const artifact of readRawProfileArtifactDefaults(settings, catalogs)) {
    const overrides = ownRecord(profiles?.[artifact.profileId]);
    for (const [fieldId, reference] of Object.entries(artifact.bindings)) {
      if (reference === secretId && !Object.hasOwn(overrides ?? {}, fieldId)) {
        output.push(Object.freeze({ owner: 'profile', path: `${PROFILE_BINDINGS_KEY}${pathSegment(artifact.profileId)}${pathSegment(fieldId)}` }));
      }
    }
  }
  collectProviderReferences(settings, secretId, output);
  collectVoiceReferences(settings, secretId, output);
  collectMcpReferences(settings, secretId, output);
  collectAcpReferences(settings, secretId, output);
  collectPluginSecretReferences(settings, secretId, output);
  collectConnectedAccountReferences(settings, secretId, output);
  if (catalogs) {
    for (const reference of listSavedSecretReferenceCatalogRefsV1(catalogs)) {
      if (reference.secretId === secretId) output.push(Object.freeze({ owner: reference.owner, path: reference.path }));
    }
  }
  collectUnknownSavedSecretReferences(settings, secretId, output);
  for (const record of catalogs?.profileRecords ?? []) {
    collectUnknownSavedSecretReferences(record, secretId, output, `profileRows${pathSegment(record.id)}`);
  }
  return Object.freeze(output);
}

/** The same slot owners rewrite opened catalogs, including inherited Profile bindings. */
export function rewriteSavedSecretReferenceCatalogsV1(catalogs: SavedSecretReferenceCatalogsV1,
  sourceRef: string, targetRef: string): SavedSecretReferenceCatalogsV1 {
  listSavedSecretReferenceCatalogRefsV1(catalogs);
  const profileRecords = catalogs.profileRecords.map(record => {
    let secretBindings = rewriteStringMapReferences(record.secretBindings, sourceRef, targetRef);
    for (const [fieldId, reference] of Object.entries(readEffectiveProfileSavedSecretBindings(record, catalogs))) {
      if (reference === sourceRef && secretBindings[fieldId] !== targetRef) secretBindings = { ...secretBindings, [fieldId]: targetRef };
    }
    return secretBindings === record.secretBindings ? record : Object.freeze({ ...record, secretBindings });
  });
  return Object.freeze({ ...catalogs, profileRecords,
    ...(catalogs.mcp ? { mcp: rewriteMcpServerCatalogSavedSecretRefsV1(catalogs.mcp, sourceRef, targetRef) } : {}),
    ...(catalogs.acp ? { acp: rewriteAcpCatalogSavedSecretRefsV1(catalogs.acp, sourceRef, targetRef) } : {}),
    ...(catalogs.providerConnections ? { providerConnections: rewriteProviderConnectionsCatalogSavedSecretRefsV1(catalogs.providerConnections, sourceRef, targetRef) } : {}),
    ...(catalogs.connectedConfigurations ? { connectedConfigurations: rewriteConnectedConfigurationCatalogSavedSecretRefsV1(catalogs.connectedConfigurations, sourceRef, targetRef) } : {}),
    ...(catalogs.notificationChannels ? { notificationChannels: rewriteNotificationChannelSavedSecretRefsV1(catalogs.notificationChannels, sourceRef, targetRef) } : {}),
  });
}

function rewriteStringMapReferences(
  value: Readonly<Record<string, string>>,
  sourceRef: string,
  targetRef: string,
): Readonly<Record<string, string>>;
function rewriteStringMapReferences(
  value: Readonly<Record<string, string | null>>, sourceRef: string, targetRef: string,
): Readonly<Record<string, string | null>>;
function rewriteStringMapReferences(value: unknown, sourceRef: string, targetRef: string): unknown;
function rewriteStringMapReferences(
  value: unknown,
  sourceRef: string,
  targetRef: string,
): unknown {
  const record = ownRecord(value);
  if (!record) return value;
  let changed = false;
  const rewritten = Object.fromEntries(Object.entries(record).map(([key, candidate]) => {
    if (candidate !== sourceRef) return [key, candidate];
    changed = true;
    return [key, targetRef];
  }));
  return changed ? rewritten : value;
}

function rewriteSlotBindingReferences(
  value: unknown,
  sourceRef: string,
  targetRef: string,
): unknown {
  const root = ownRecord(value);
  if (!root) return value;
  const account = rewriteStringMapReferences(root.account, sourceRef, targetRef);
  const byMachineId = ownRecord(root.byMachineId);
  const rewrittenByMachineId = byMachineId
    ? Object.fromEntries(Object.entries(byMachineId).map(([machineId, bindings]) => [
        machineId,
        rewriteStringMapReferences(bindings, sourceRef, targetRef),
      ]))
    : root.byMachineId;
  if (account === root.account && rewrittenByMachineId === root.byMachineId) return value;
  return {
    ...root,
    ...(root.account === undefined ? {} : { account }),
    ...(root.byMachineId === undefined ? {} : { byMachineId: rewrittenByMachineId }),
  };
}

function rewriteValueRefMapReferences(
  value: unknown,
  sourceRef: string,
  targetRef: string,
): unknown {
  const record = ownRecord(value);
  if (!record) return value;
  let changed = false;
  const rewritten = Object.fromEntries(Object.entries(record).map(([key, candidate]) => {
    const valueRef = ownRecord(candidate);
    if (valueRef?.t !== 'savedSecret' || valueRef.secretId !== sourceRef) {
      return [key, candidate];
    }
    changed = true;
    return [key, { ...valueRef, secretId: targetRef }];
  }));
  return changed ? rewritten : value;
}

function rewriteKnownSavedSecretReferences(
  settings: Readonly<Record<string, unknown>>,
  sourceRef: string,
  targetRef: string,
): Readonly<Record<string, unknown>> {
  const next: Record<string, unknown> = { ...settings };

  const profiles = ownRecord(settings[PROFILE_BINDINGS_KEY]);
  if (profiles) {
    next[PROFILE_BINDINGS_KEY] = Object.fromEntries(
      Object.entries(profiles).map(([profileId, bindings]) => [
        profileId,
        rewriteStringMapReferences(bindings, sourceRef, targetRef),
      ]),
    );
  }

  const provider = ownRecord(settings[PROVIDER_SETTINGS_KEY]);
  const connections = ownRecord(provider?.secretBindingsByConnectionId);
  if (provider && connections) {
    next[PROVIDER_SETTINGS_KEY] = {
      ...provider,
      secretBindingsByConnectionId: Object.fromEntries(
        Object.entries(connections).map(([connectionId, bindings]) => [
          connectionId,
          rewriteSlotBindingReferences(bindings, sourceRef, targetRef),
        ]),
      ),
    };
  }

  for (const rootKey of VOICE_SETTINGS_KEYS) {
    const voice = ownRecord(settings[rootKey]);
    if (!voice || !Array.isArray(voice.credentialBindings)) continue;
    next[rootKey] = {
      ...voice,
      credentialBindings: voice.credentialBindings.map((candidate) => {
        const binding = ownRecord(candidate)!;
        return {
          ...binding,
          credentialBindings: rewriteSlotBindingReferences(
            binding.credentialBindings,
            sourceRef,
            targetRef,
          ),
        };
      }),
    };
  }

  const mcp = ownRecord(settings[MCP_SETTINGS_KEY]);
  if (mcp) {
    next[MCP_SETTINGS_KEY] = {
      ...mcp,
      ...(Array.isArray(mcp.servers) ? {
        servers: mcp.servers.map((candidate) => {
          const server = ownRecord(candidate)!;
          const remote = ownRecord(server.remote);
          return {
            ...server,
            ...(server.env === undefined ? {} : {
              env: rewriteValueRefMapReferences(server.env, sourceRef, targetRef),
            }),
            ...(remote ? {
              remote: {
                ...remote,
                ...(remote.headers === undefined ? {} : {
                  headers: rewriteValueRefMapReferences(
                    remote.headers,
                    sourceRef,
                    targetRef,
                  ),
                }),
              },
            } : {}),
          };
        }),
      } : {}),
      ...(Array.isArray(mcp.bindings) ? {
        bindings: mcp.bindings.map((candidate) => {
          const binding = ownRecord(candidate)!;
          const overrides = ownRecord(binding.overrides);
          if (!overrides) return candidate;
          const remote = ownRecord(overrides.remote);
          return {
            ...binding,
            overrides: {
              ...overrides,
              ...(overrides.envPatch === undefined ? {} : {
                envPatch: rewriteValueRefMapReferences(
                  overrides.envPatch,
                  sourceRef,
                  targetRef,
                ),
              }),
              ...(remote ? {
                remote: {
                  ...remote,
                  ...(remote.headersPatch === undefined ? {} : {
                    headersPatch: rewriteValueRefMapReferences(
                      remote.headersPatch,
                      sourceRef,
                      targetRef,
                    ),
                  }),
                },
              } : {}),
            },
          };
        }),
      } : {}),
    };
  }

  const acp = ownRecord(settings[ACP_SETTINGS_KEY]);
  if (acp && Array.isArray(acp.backends)) {
    next[ACP_SETTINGS_KEY] = {
      ...acp,
      backends: acp.backends.map((candidate) => {
        const backend = ownRecord(candidate)!;
        return {
          ...backend,
          ...(backend.env === undefined ? {} : {
            env: rewriteValueRefMapReferences(backend.env, sourceRef, targetRef),
          }),
        };
      }),
    };
  }

  const pluginBindings = ownRecord(settings[PLUGIN_SECRET_BINDINGS_SETTINGS_KEY]);
  if (pluginBindings) {
    next[PLUGIN_SECRET_BINDINGS_SETTINGS_KEY] = Object.fromEntries(
      Object.entries(pluginBindings).map(([key, candidate]) => {
        const binding = ownRecord(candidate)!;
        return [key, binding.savedSecretId === sourceRef
          ? { ...binding, savedSecretId: targetRef }
          : candidate];
      }),
    );
  }

  const connectedAccountConfigurations = ownRecord(
    settings[CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY],
  );
  if (connectedAccountConfigurations && Array.isArray(connectedAccountConfigurations.entries)) {
    next[CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY] = {
      ...connectedAccountConfigurations,
      entries: connectedAccountConfigurations.entries.map((candidate) => {
        const entry = ownRecord(candidate)!;
        return {
          ...entry,
          secretRefs: rewriteStringMapReferences(entry.secretRefs, sourceRef, targetRef),
        };
      }),
    };
  }

  return Object.freeze(next);
}

function invalidPersonalSavedSecretTarget(message: string): never {
  throw new AccountSettingsSavedSecretMutationError('saved_secret_invalid', message);
}

function assertCanonicalNewPersonalSavedSecretId(newSecretId: unknown): asserts newSecretId is string {
  if (
    typeof newSecretId !== 'string'
    || newSecretId.length === 0
    || newSecretId.length > SAVED_SECRET_REF_MAX_LENGTH_V1
    || newSecretId.trim() !== newSecretId
    || /[\u0000-\u001f\u007f]/u.test(newSecretId)
    || newSecretId.startsWith(SHARED_SAVED_SECRET_REF_V1_PREFIX)
  ) {
    invalidPersonalSavedSecretTarget('Replacement personal SavedSecret id is invalid');
  }
}

function parseSharedSavedSecretPromotionRef(sharedSecretRef: unknown): string {
  if (typeof sharedSecretRef !== 'string') {
    invalidReferenceRoot('Shared SavedSecret reference is invalid');
  }
  try {
    const parsed = parseSavedSecretRefV1(sharedSecretRef);
    if (parsed.kind !== 'shared_resource') {
      invalidReferenceRoot('Promotion target must be a shared SavedSecret reference');
    }
    return formatSharedSavedSecretRefV1(parsed.resourceId);
  } catch (error) {
    if (error instanceof AccountSettingsSavedSecretMutationError) throw error;
    invalidReferenceRoot('Shared SavedSecret reference is invalid');
  }
}

function isSharedSavedSecretCollision(value: string): boolean {
  // The spelling alone cannot distinguish a retained opaque personal identity
  // from a Resource reference, including malformed reserved-prefix identities.
  return value.startsWith(SHARED_SAVED_SECRET_REF_V1_PREFIX);
}

/**
 * Lists only proven personal import source references, including after readback.
 * Independent same-spelling catalog Resource references remain in the full
 * census. This proof does not admit a transfer or prove record currentness.
 */
export function listSavedSecretPersonalImportSourceReferencesV1(
  settings: Readonly<Record<string, unknown>>,
  personalSecretId: string,
  catalogs: SavedSecretReferenceCatalogsV1,
): readonly AccountSettingsSavedSecretReference[] {
  const references = listAccountSettingsSavedSecretReferences(settings, personalSecretId, catalogs);
  if (!isSharedSavedSecretCollision(personalSecretId)) return references;
  return classifyReservedPersonalSourceReferences(settings, personalSecretId, catalogs, references).personalSourceReferences;
}

function classifyReservedPersonalSourceReferences(
  settings: Readonly<Record<string, unknown>>,
  personalSecretId: string,
  catalogs: SavedSecretReferenceCatalogsV1,
  references: readonly AccountSettingsSavedSecretReference[],
): Readonly<{
  personalSourceReferences: readonly AccountSettingsSavedSecretReference[];
  retainedResourceReferences: readonly AccountSettingsSavedSecretReference[];
}> {
  // Opened catalog slots already use the Resource namespace. A same-spelling
  // personal source cannot grant authority to rewrite those independent refs.
  const retainedResourceReferences = listSavedSecretReferenceCatalogRefsV1(catalogs)
    .filter(reference => reference.secretId === personalSecretId);
  const unclassified = references.some(reference => reference.owner === 'voice'
    || reference.owner === 'plugin' || reference.owner === 'unknown');
  const referenceSource = readReferenceSourceSettings(settings, catalogs);
  const inheritedArtifactReference = readRawProfileArtifactDefaults(referenceSource, catalogs).some(artifact => {
    const bindings = ownRecord(ownRecord(referenceSource[PROFILE_BINDINGS_KEY])?.[artifact.profileId]);
    return Object.entries(artifact.bindings).some(([fieldId, reference]) => reference === personalSecretId
      && !Object.hasOwn(bindings ?? {}, fieldId));
  });
  if (unclassified || inheritedArtifactReference) {
    throw new AccountSettingsSavedSecretMutationError('saved_secret_ref_collision_migration_required',
      'A reserved-prefix personal source has references without proven predecessor provenance');
  }
  const retainedReferencePaths = new Set(retainedResourceReferences.map(reference => JSON.stringify([reference.owner, reference.path])));
  return Object.freeze({ retainedResourceReferences,
    personalSourceReferences: references.filter(reference => !retainedReferencePaths.has(JSON.stringify([reference.owner, reference.path]))),
  });
}

function rewritePersonalSavedSecret(
  settings: Readonly<Record<string, unknown>>,
  input: RekeyPersonalSavedSecretInput | PromotePersonalSavedSecretReferenceInput,
  target: Readonly<{ kind: 'personal' | 'shared_resource'; ref: string }>,
  catalogs?: SavedSecretReferenceCatalogsV1,
): SavedSecretReferenceRewriteResultV1 {
  const rawInput = ownRecord(input);
  const allowedKeys = target.kind === 'personal'
    ? ['secretId', 'expectedUpdatedAt', 'newSecretId']
    : ['secretId', 'expectedUpdatedAt', 'sharedSecretRef'];
  if (
    !rawInput
    || !hasOnlyOwnKeys(rawInput, allowedKeys)
    || typeof rawInput.secretId !== 'string'
    || rawInput.secretId.length === 0
    || typeof rawInput.expectedUpdatedAt !== 'number'
    || !Number.isFinite(rawInput.expectedUpdatedAt)
  ) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'SavedSecret reference rewrite input is invalid',
    );
  }

  const transferSource = target.kind === 'shared_resource' ? readSavedSecretTransferSourceV1(settings) : null;
  const secrets = transferSource?.secrets ?? readSavedSecrets(settings);
  // The census validates every known root before any replacement object is
  // constructed. This keeps malformed or unknown owner representations from
  // producing a partially rewritten Settings document.
  const sourceReferences = listAccountSettingsSavedSecretReferences(
    settings,
    rawInput.secretId,
    catalogs,
  );
  const current = findSecret(
    secrets,
    rawInput.secretId,
    rawInput.expectedUpdatedAt,
  );
  const referenceSource = readReferenceSourceSettings(settings, catalogs);
  const sourceQualifiedCollision = isSharedSavedSecretCollision(current.secret.id)
    && (target.kind === 'shared_resource' || catalogs !== undefined);
  let retainedResourceReferences: readonly AccountSettingsSavedSecretReference[] = [];
  if (sourceQualifiedCollision) {
    if (!catalogs) {
      throw new AccountSettingsSavedSecretMutationError('saved_secret_ref_collision_migration_required',
        'A reserved-prefix personal source requires the complete opened reference inventory');
    }
    retainedResourceReferences = classifyReservedPersonalSourceReferences(settings, current.secret.id, catalogs,
      sourceReferences).retainedResourceReferences;
  }

  let targetRef: string;
  if (target.kind === 'personal') {
    assertCanonicalNewPersonalSavedSecretId(target.ref);
    if (
      secrets.some((candidate) => candidate.id === target.ref)
      || listAccountSettingsSavedSecretReferences(settings, target.ref, catalogs).length > 0
    ) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_conflict',
        'Replacement personal SavedSecret identity is already in use',
      );
    }
    targetRef = target.ref;
  } else {
    targetRef = parseSharedSavedSecretPromotionRef(target.ref);
    if (secrets.some((candidate) => candidate.id === targetRef)) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_ref_collision_migration_required',
        'Promotion target collides with a personal SavedSecret identity',
      );
    }
  }

  const targetReferencesBefore = listAccountSettingsSavedSecretReferences(
    settings,
    targetRef,
    catalogs,
  ).length;
  let withRewrittenReferences = rewriteKnownSavedSecretReferences(
    referenceSource,
    current.secret.id,
    targetRef,
  );
  for (const artifact of readRawProfileArtifactDefaults(referenceSource, catalogs)) {
    const currentBindings = ownRecord(ownRecord(settings[PROFILE_BINDINGS_KEY])?.[artifact.profileId]);
    const inherited = Object.entries(artifact.bindings).filter(([fieldId, reference]) => reference === current.secret.id
      && !Object.hasOwn(currentBindings ?? {}, fieldId));
    if (inherited.length === 0) continue;
    const allBindings = ownRecord(withRewrittenReferences[PROFILE_BINDINGS_KEY]);
    withRewrittenReferences = { ...withRewrittenReferences, [PROFILE_BINDINGS_KEY]: { ...allBindings,
      [artifact.profileId]: { ...ownRecord(allBindings?.[artifact.profileId]), ...Object.fromEntries(inherited.map(([fieldId]) => [fieldId, targetRef])) },
    } };
  }
  const nextSecrets = target.kind === 'personal'
    ? secrets.map((candidate, index) => (
        index === current.index ? { ...candidate, id: targetRef } : candidate
      ))
    : (settings[SECRETS_KEY] as readonly unknown[]).filter(candidate => candidate !== current.secret);
  // Inactive source bytes that the opened Profile control superseded are not
  // rebound or reactivated by a SavedSecret transfer.
  for (const key of Object.keys(settings)) {
    if (settings[key] !== referenceSource[key]) withRewrittenReferences = { ...withRewrittenReferences, [key]: settings[key] };
  }
  const nextSettings = Object.freeze({
    ...withRewrittenReferences,
    secrets: Object.freeze(nextSecrets),
  });
  const nextCatalogs = sourceQualifiedCollision ? catalogs
    : catalogs ? rewriteSavedSecretReferenceCatalogsV1(catalogs, current.secret.id, targetRef) : undefined;

  if (target.kind === 'personal') readSavedSecrets(nextSettings);
  else readSavedSecretTransferSourceV1(nextSettings);
  const remainingSourceReferences = listAccountSettingsSavedSecretReferences(
    nextSettings,
    current.secret.id,
    nextCatalogs,
  );
  const targetReferencesAfter = listAccountSettingsSavedSecretReferences(
    nextSettings,
    targetRef,
    nextCatalogs,
  ).length;
  const retainedReferencePaths = new Set(retainedResourceReferences.map(reference => JSON.stringify([reference.owner, reference.path])));
  if (
    remainingSourceReferences.length !== retainedResourceReferences.length
    || remainingSourceReferences.some(reference => !retainedReferencePaths.has(JSON.stringify([reference.owner, reference.path])))
    || targetReferencesAfter - targetReferencesBefore !== sourceReferences.length - retainedResourceReferences.length
  ) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'SavedSecret reference rewrite did not cover every canonical owner',
      remainingSourceReferences,
    );
  }
  return Object.freeze({ settings: nextSettings, ...(nextCatalogs ? {
    profileRecords: nextCatalogs.profileRecords,
    ...(nextCatalogs.remoteHostRecords === undefined ? {} : { remoteHostRecords: nextCatalogs.remoteHostRecords }),
    ...(nextCatalogs.mcp === undefined ? {} : { mcp: nextCatalogs.mcp }),
    ...(nextCatalogs.acp === undefined ? {} : { acp: nextCatalogs.acp }),
    ...(nextCatalogs.providerConnections === undefined ? {} : { providerConnections: nextCatalogs.providerConnections }),
    ...(nextCatalogs.connectedConfigurations === undefined ? {} : { connectedConfigurations: nextCatalogs.connectedConfigurations }),
    ...(nextCatalogs.connectedPurposes === undefined ? {} : { connectedPurposes: nextCatalogs.connectedPurposes }),
    ...(nextCatalogs.notificationChannels === undefined ? {} : { notificationChannels: nextCatalogs.notificationChannels }),
  } : {}) });
}

function findSecret(
  secrets: readonly SavedSecret[],
  secretId: string,
  expectedUpdatedAt: number,
): Readonly<{ index: number; secret: SavedSecret }> {
  const index = secrets.findIndex((candidate) => candidate.id === secretId);
  if (index < 0) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_not_found',
      'SavedSecret does not exist',
    );
  }
  const secret = secrets[index]!;
  if (secret.updatedAt !== expectedUpdatedAt) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_conflict',
      'SavedSecret changed before the mutation settled',
    );
  }
  return Object.freeze({ index, secret });
}

/**
 * Verifies the caller's view of the record a Voice slot currently points at.
 *
 * The slot identity itself is compared separately (`exactSecretId`); this pins
 * the *record*. Three expectations are representable, and each is checked:
 *
 * - `null`/`null` — the slot points at nothing.
 * - id + `updatedAt` — the slot points at that record, unchanged.
 * - id + `null` — the slot points at a record the account no longer stores.
 *   A binding-loss event leaves exactly this state, and rejecting it as an
 *   ambiguous half-specification made the slot permanently unusable: binding,
 *   replacing, and removing all failed, so the user could never repair it.
 *   It is a checkable assertion, not a relaxation — the record must really be
 *   absent, otherwise the caller read a different snapshot and this conflicts.
 */
function assertVoiceCredentialSecretExpectation(
  secrets: readonly SavedSecret[],
  expectedSecretId: string | null,
  expectedSecretUpdatedAt: number | null,
): void {
  if (expectedSecretId === null) {
    if (expectedSecretUpdatedAt === null) return;
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_conflict',
      'Target-local Voice SavedSecret source changed',
    );
  }
  if (expectedSecretUpdatedAt !== null) {
    findSecret(secrets, expectedSecretId, expectedSecretUpdatedAt);
    return;
  }
  if (secrets.some((candidate) => candidate.id === expectedSecretId)) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_conflict',
      'Target-local Voice SavedSecret source changed',
    );
  }
}

function savedSecretsRootBytes(secrets: unknown): number {
  try {
    const serialized = JSON.stringify(secrets);
    return serialized === undefined ? 0 : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Applies one SavedSecret mutation and enforces the collection's capacity in the
 * same step.
 *
 * The canonical Account-Settings reader exposes at most
 * `SAVED_SECRET_COLLECTION_MAX_ENTRIES` records. A write that stores more is not
 * a larger collection; it is a collection whose overflow no reader can resolve,
 * so a still-referenced Provider secret would silently stop satisfying its slot
 * at spawn. The capacity is therefore refused at the write, not truncated at the
 * read. A collection that is ALREADY oversized (from a write this owner did not
 * make) can still shrink, so the only recovery path stays open.
 *
 * The same contract applies to the root's serialized size, which is the harsher
 * half: the reader truncates an over-count collection to its first entries, but
 * recovers an over-size root to `[]`, so one accepted large secret can hide
 * every other credential the Account already had. Both arms therefore consult
 * the canonical Account bound rather than a local copy of it.
 */
export function applyAccountSettingsSavedSecretMutation(
  settings: Readonly<Record<string, unknown>>,
  mutation: AccountSettingsSavedSecretMutation,
  catalogs?: SavedSecretReferenceCatalogsV1,
): Readonly<{
  settings: Readonly<Record<string, unknown>>;
}> {
  const result = applySavedSecretMutation(settings, mutation, catalogs);
  const nextSecrets = result.settings.secrets;
  const currentSecrets = settings.secrets;
  const nextCount = Array.isArray(nextSecrets) ? nextSecrets.length : 0;
  const currentCount = Array.isArray(currentSecrets) ? currentSecrets.length : 0;
  if (nextCount > SAVED_SECRET_COLLECTION_MAX_ENTRIES && nextCount > currentCount) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_collection_full',
      'Account Settings cannot hold another SavedSecret',
    );
  }
  const nextBoundIssue = inspectAccountSettingValueBounds(
    nextSecrets,
    ACCOUNT_SETTINGS_MAX_SAVED_SECRETS_BYTES,
  );
  if (nextBoundIssue && savedSecretsRootBytes(nextSecrets) > savedSecretsRootBytes(currentSecrets)) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_collection_full',
      'Account Settings cannot hold a SavedSecret collection this large',
    );
  }
  return result;
}

function applySavedSecretMutation(
  settings: Readonly<Record<string, unknown>>,
  mutation: AccountSettingsSavedSecretMutation,
  catalogs?: SavedSecretReferenceCatalogsV1,
): Readonly<{
  settings: Readonly<Record<string, unknown>>;
}> {
  const mutationKind = (mutation as Readonly<{ kind?: unknown }>).kind;
  if (
    mutationKind !== 'add'
    && mutationKind !== 'rename'
    && mutationKind !== 'rotateGlobal'
    && mutationKind !== 'delete'
    && mutationKind !== 'replaceVoiceCredentialSecret'
    && mutationKind !== 'bindVoiceCredentialSavedSecret'
    && mutationKind !== 'approveVoiceCredentialRecipientContract'
    && mutationKind !== 'removeVoiceCredentialSecret'
    && mutationKind !== 'replacePluginSecret'
    && mutationKind !== 'bindPluginSecret'
    && mutationKind !== 'removePluginSecret'
    && mutationKind !== 'unbindPluginSecret'
  ) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'SavedSecret mutation kind is invalid',
    );
  }
  const secrets = readSavedSecrets(settings);
  if (mutation.kind === 'add') {
    const parsed = SavedSecretSchema.safeParse(mutation.secret);
    if (!parsed.success) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'SavedSecret is invalid',
      );
    }
    if (secrets.some((candidate) => candidate.id === parsed.data.id)) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_conflict',
        'SavedSecret identity already exists',
      );
    }
    return Object.freeze({
      settings: Object.freeze({
        ...settings,
        secrets: Object.freeze([mutation.secret, ...secrets]),
      }),
    });
  }
  if (mutation.kind === 'replacePluginSecret') {
    const replacementSecret = SavedSecretSchema.safeParse(mutation.secret);
    if (!replacementSecret.success) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'Plugin SavedSecret replacement is invalid',
      );
    }
    if (secrets.some((candidate) => candidate.id === replacementSecret.data.id)) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_conflict',
        'Plugin SavedSecret identity already exists',
      );
    }
    const targetState = readPluginAccountSecretBindingTarget(settings, mutation.target);
    assertPluginSecretBindingExpectation(
      secrets,
      targetState.binding,
      mutation.expectedSecretId,
      mutation.expectedSecretUpdatedAt,
    );
    const rebound = writePluginAccountSecretBinding({
      settings,
      target: targetState.target,
      binding: Object.freeze({
        pluginId: targetState.target.pluginId,
        custody: 'account',
        localId: targetState.target.localId,
        savedSecretId: replacementSecret.data.id,
        createdForBinding: true,
      }),
    });
    const retained = removeUnreferencedBindingCreatedSecret({
      settings: rebound,
      secrets,
      binding: targetState.binding,
      catalogs,
    });
    return Object.freeze({
      settings: Object.freeze({
        ...rebound,
        secrets: Object.freeze([mutation.secret, ...retained]),
      }),
    });
  }
  if (mutation.kind === 'bindPluginSecret') {
    let selectedRef: SavedSecretRefV1;
    try {
      selectedRef = parseSavedSecretRefV1(mutation.secretId);
    } catch {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'Plugin SavedSecret id is invalid',
      );
    }
    const targetState = readPluginAccountSecretBindingTarget(settings, mutation.target);
    assertPluginSecretBindingExpectation(
      secrets,
      targetState.binding,
      mutation.expectedSecretId,
      mutation.expectedSecretUpdatedAt,
    );
    if (
      selectedRef.kind === 'personal'
      && !secrets.some((candidate) => candidate.id === mutation.secretId)
    ) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_not_found',
        'The selected Plugin SavedSecret does not exist',
      );
    }
    const rebound = writePluginAccountSecretBinding({
      settings,
      target: targetState.target,
      binding: Object.freeze({
        pluginId: targetState.target.pluginId,
        custody: 'account',
        localId: targetState.target.localId,
        savedSecretId: mutation.secretId,
        createdForBinding: false,
      }),
    });
    const retained = removeUnreferencedBindingCreatedSecret({
      settings: rebound,
      secrets,
      binding: targetState.binding,
      catalogs,
    });
    return Object.freeze({
      settings: Object.freeze({
        ...rebound,
        secrets: Object.freeze(retained),
      }),
    });
  }
  if (mutation.kind === 'removePluginSecret') {
    const targetState = readPluginAccountSecretBindingTarget(settings, mutation.target);
    assertPluginSecretBindingExpectation(
      secrets,
      targetState.binding,
      mutation.expectedSecretId,
      mutation.expectedSecretUpdatedAt,
    );
    const unbound = writePluginAccountSecretBinding({
      settings,
      target: targetState.target,
      binding: null,
    });
    const retained = removeUnreferencedBindingCreatedSecret({
      settings: unbound,
      secrets,
      binding: targetState.binding,
      catalogs,
    });
    return Object.freeze({
      settings: Object.freeze({
        ...unbound,
        secrets: Object.freeze(retained),
      }),
    });
  }
  if (mutation.kind === 'unbindPluginSecret') {
    const targetState = readPluginAccountSecretBindingTarget(settings, mutation.target);
    assertPluginSecretBindingExpectation(
      secrets,
      targetState.binding,
      mutation.expectedSecretId,
      mutation.expectedSecretUpdatedAt,
    );
    const unbound = writePluginAccountSecretBinding({
      settings,
      target: targetState.target,
      binding: null,
    });
    return Object.freeze({
      settings: Object.freeze({
        ...unbound,
        secrets: Object.freeze(secrets),
      }),
    });
  }
  if (mutation.kind === 'replaceVoiceCredentialSecret') {
    const replacementSecret = SavedSecretSchema.safeParse(mutation.secret);
    if (!replacementSecret.success) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'Target-local Voice SavedSecret replacement is invalid',
      );
    }
    if (secrets.some((candidate) => candidate.id === replacementSecret.data.id)) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_conflict',
        'Target-local Voice SavedSecret identity already exists',
      );
    }
    const targetState = readVoiceCredentialTarget(settings, mutation.target);
    if (targetState.exactSecretId !== mutation.expectedSecretId) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_conflict',
        'Target-local Voice credential changed',
      );
    }
    assertVoiceCredentialSecretExpectation(
      secrets,
      mutation.expectedSecretId,
      mutation.expectedSecretUpdatedAt,
    );
    const rebound = writeVoiceCredentialTarget({
      settings,
      target: mutation.target,
      state: targetState,
      secretId: replacementSecret.data.id,
      ...(mutation.approvedRecipientContractDigest === undefined
        ? {}
        : {
            approvedRecipientContractDigest:
              mutation.approvedRecipientContractDigest,
          }),
    });
    const keepPrevious = mutation.expectedSecretId !== null
      && listAccountSettingsSavedSecretReferences(
        rebound,
        mutation.expectedSecretId,
        catalogs,
      ).length > 0;
    return Object.freeze({
      settings: Object.freeze({
        ...rebound,
        secrets: Object.freeze([
          mutation.secret,
          ...secrets.filter((candidate) => (
            keepPrevious || candidate.id !== mutation.expectedSecretId
          )),
        ]),
      }),
    });
  }
  if (mutation.kind === 'bindVoiceCredentialSavedSecret') {
    const targetState = readVoiceCredentialTarget(settings, mutation.target);
    if (targetState.exactSecretId !== mutation.expectedSecretId) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_conflict',
        'Target-local Voice credential changed',
      );
    }
    if (!isStrictSharedSavedSecretRefV1(mutation.expectedSecretId)) {
      assertVoiceCredentialSecretExpectation(
        secrets,
        mutation.expectedSecretId,
        mutation.expectedSecretUpdatedAt,
      );
    }
    if (!secrets.some((candidate) => candidate.id === mutation.secretId)
      && !isStrictSharedSavedSecretRefV1(mutation.secretId)) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_not_found',
        'The selected SavedSecret does not exist',
      );
    }
    const bound = writeVoiceCredentialTarget({
      settings,
      target: mutation.target,
      state: targetState,
      secretId: mutation.secretId,
      ...(mutation.approvedRecipientContractDigest === undefined
        ? {}
        : {
            approvedRecipientContractDigest:
              mutation.approvedRecipientContractDigest,
          }),
    });
    // The previously bound record is left in place: it is a user-curated
    // SavedSecret the account still owns, not a slot-local value this binding
    // replaced. Deleting it here would destroy a secret the user can still
    // select elsewhere or re-select for this slot.
    return Object.freeze({
      settings: Object.freeze({
        ...bound,
        secrets: Object.freeze([...secrets]),
      }),
    });
  }
  if (mutation.kind === 'approveVoiceCredentialRecipientContract') {
    if (
      !VoiceCredentialBindingV1Schema.shape.approvedRecipientContractDigest
        .safeParse(mutation.approvedRecipientContractDigest).success
    ) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'Voice credential recipient contract digest is invalid',
      );
    }
    const targetState = readVoiceCredentialTarget(settings, mutation.target);
    if (targetState.exactSecretId !== mutation.expectedSecretId) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_conflict',
        'Target-local Voice credential changed',
      );
    }
    if (!isStrictSharedSavedSecretRefV1(mutation.expectedSecretId)) {
      findSecret(
        secrets,
        mutation.expectedSecretId,
        mutation.expectedSecretUpdatedAt,
      );
    }
    const approved = writeVoiceCredentialTarget({
      settings,
      target: mutation.target,
      state: targetState,
      secretId: mutation.expectedSecretId,
      approvedRecipientContractDigest:
        mutation.approvedRecipientContractDigest,
    });
    return Object.freeze({
      settings: Object.freeze({
        ...approved,
        secrets: Object.freeze([...secrets]),
      }),
    });
  }
  if (mutation.kind === 'removeVoiceCredentialSecret') {
    const targetState = readVoiceCredentialTarget(settings, mutation.target);
    if (targetState.exactSecretId !== mutation.expectedSecretId) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_conflict',
        'Target-local Voice credential changed',
      );
    }
    if (!isStrictSharedSavedSecretRefV1(mutation.expectedSecretId)) {
      findSecret(
        secrets,
        mutation.expectedSecretId,
        mutation.expectedSecretUpdatedAt,
      );
    }
    const unbound = writeVoiceCredentialTarget({
      settings,
      target: mutation.target,
      state: targetState,
      secretId: null,
    });
    const keepSecret = listAccountSettingsSavedSecretReferences(
      unbound,
      mutation.expectedSecretId,
      catalogs,
    ).length > 0;
    return Object.freeze({
      settings: Object.freeze({
        ...unbound,
        secrets: keepSecret
          ? Object.freeze([...secrets])
          : Object.freeze(
              secrets.filter(
                (candidate) => candidate.id !== mutation.expectedSecretId,
              ),
            ),
      }),
    });
  }

  const current = findSecret(
    secrets,
    mutation.secretId,
    mutation.expectedUpdatedAt,
  );
  if (mutation.kind === 'delete') {
    const references = listAccountSettingsSavedSecretReferences(
      settings,
      mutation.secretId,
      catalogs,
    );
    if (references.length > 0) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_in_use',
        'SavedSecret is still referenced by Account Settings',
        references,
      );
    }
    return Object.freeze({
      settings: Object.freeze({
        ...settings,
        secrets: Object.freeze(
          secrets.filter((candidate) => candidate.id !== mutation.secretId),
        ),
      }),
    });
  }

  if (mutation.kind === 'rotateGlobal') {
    const connectedAccountReferences: AccountSettingsSavedSecretReference[] = [];
    collectConnectedAccountReferences(
      settings,
      mutation.secretId,
      connectedAccountReferences,
    );
    if (connectedAccountReferences.length > 0) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_referenced_by_connected_account_configuration',
        'Replace this SavedSecret from the exact Connected Account configuration that references it',
        connectedAccountReferences,
      );
    }
  }

  if (
    !Number.isFinite(mutation.updatedAt)
    || mutation.updatedAt <= current.secret.updatedAt
  ) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'SavedSecret update time must advance',
    );
  }
  const replacement = mutation.kind === 'rename'
    ? {
        ...current.secret,
        name: mutation.name.trim(),
        updatedAt: mutation.updatedAt,
      }
    : {
        ...current.secret,
        encryptedValue: mutation.encryptedValue,
        updatedAt: mutation.updatedAt,
      };
  if (!SavedSecretSchema.safeParse(replacement).success) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'SavedSecret replacement is invalid',
    );
  }
  const nextSecrets = [...secrets];
  nextSecrets[current.index] = replacement;
  const withSecret = Object.freeze({
    ...settings,
    secrets: Object.freeze(nextSecrets),
  });
  if (mutation.kind === 'rename') {
    return Object.freeze({
      settings: withSecret,
    });
  }
  return Object.freeze({
    settings: withSecret,
  });
}
