import { AIBackendProfileSchema } from './backendProfileSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import {
  projectHistoricalBuiltInAiLaunchProfileV1,
  getHistoricalBuiltInAiLaunchProfileV1,
  isHistoricalBuiltInAiLaunchProfileIdV1,
  type HistoricalAiBackendProfileV1,
} from './historicalCompatibilityV1.js';
export { isHistoricalBuiltInAiLaunchProfileIdV1 } from './historicalCompatibilityV1.js';
import { StoredLaunchProfileV2Schema, type LaunchProfileV2 } from './v2/schema.js';
import type { ProviderSettingsMigrationStateV1 } from '../providers/settings/v1.js';
import type { ArtifactSharingResourceV1 } from '../artifacts/artifactSharingV1.js';
import { LaunchProfileArtifactReferenceV1Schema, readLaunchProfileArtifactV1, readLaunchProfileArtifactForReferenceCensusV1 } from '../launchProfiles/launchProfileArtifactV1.js';
import { ProfileRecordV1Schema, StoredProfileRecordV1Schema, ProfileSecretBindingsV1Schema, ProfileRowRevisionV1Schema, resolveEffectiveProfileSecretBindingsV1, type ProfileRecordV1 } from './profileRecordSchemaV1.js';
export { resolveEffectiveProfileSecretBindingsV1 } from './profileRecordSchemaV1.js';
import { PromptStackEntryV1Schema, type PromptStackEntryV1 } from '../prompts/library/promptStacksV1.js';
import { CodingPromptBehaviorOverridesV1Schema, HistoricalCodingPromptBehaviorProfileOverrideV1Schema } from '../prompts/codingPromptBehaviorV1.js';
import { ArtifactRevisionV1Schema } from '../artifacts/artifactActionsV1.js';
import { listSavedSecretReferenceCarrierPathsV1 } from '../account/settings/savedSecretReferenceV1.js';
import type { ProfileTransferControlV1 } from './profileTransferV1.js';
import type { ProviderContributionV1 } from '../providers/contributions/v1.js';
import { listLegacyAiLaunchProfileUnpromotedCredentialEnvironmentVariableNamesV1 } from '../providers/migrations/legacyProfilesV1.js';
import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';

export type AiLaunchProfileSourceV1 = Readonly<{
  artifactId?: string;
  secretBindings?: Readonly<Record<string, string>>;
  shared?: boolean;
  viewOnly?: boolean;
  revision?: Readonly<{ headerVersion: number; bodyVersion: number }>;
  enabled?: boolean;
  promptStack?: readonly PromptStackEntryV1[];
  profileRecordRevision?: number;
}>;
export type AiLaunchProfile = (HistoricalAiBackendProfileV1 | LaunchProfileV2) & AiLaunchProfileSourceV1;

/** Opened public results are closed; stored compatibility remains body-owner defined. */
export const AiLaunchProfileV1Schema = lazyZodSchema(() => {
  const source = {
    artifactId: LaunchProfileArtifactReferenceV1Schema.shape.artifactId.optional(),
    secretBindings: ProfileSecretBindingsV1Schema.readonly().optional(),
    shared: z.boolean().optional(), viewOnly: z.boolean().optional(),
    revision: ArtifactRevisionV1Schema.readonly().optional(),
    enabled: z.boolean().optional(),
    promptStack: z.array(PromptStackEntryV1Schema).readonly().optional(),
    profileRecordRevision: ProfileRowRevisionV1Schema.optional(),
  };
  return z.union([
    AIBackendProfileSchema.safeExtend({ ...source,
      codingPromptBehaviorV1: HistoricalCodingPromptBehaviorProfileOverrideV1Schema.unwrap().strict().optional(),
      codingPromptBehaviorOverrides: CodingPromptBehaviorOverridesV1Schema.optional(),
    }).strict(),
    StoredLaunchProfileV2Schema.safeExtend(source).strict(),
  ]);
});

export function isLaunchProfileV2(profile: AiLaunchProfile): profile is LaunchProfileV2 {
  return 'v' in profile && profile.v === 2;
}

type ArtifactProfileSource = AiLaunchProfileSourceV1;
export type AiLaunchProfileCollectionEntry =
  | (Readonly<{ kind: 'legacy'; profile: HistoricalAiBackendProfileV1 & AiLaunchProfileSourceV1; raw: unknown }> & ArtifactProfileSource)
  | (Readonly<{ kind: 'slim'; profile: LaunchProfileV2 & AiLaunchProfileSourceV1; raw: unknown }> & ArtifactProfileSource)
  | Readonly<{ kind: 'opaque'; raw: unknown }>;

export type AiLaunchProfileReadDiagnostic = Readonly<{
  index: number;
  reason: 'future_version' | 'malformed' | 'artifact_unavailable' | 'identity_mismatch';
}>;

export type AiLaunchProfileCollectionReadResult = Readonly<{
  raw: unknown;
  entries: readonly AiLaunchProfileCollectionEntry[];
  diagnostics: readonly AiLaunchProfileReadDiagnostic[];
}>;

/** Ownership follows the opened definition, never an identity retained through conversion. */
export function isBuiltInAiLaunchProfileV1(profile: Readonly<{
  id: string;
  isBuiltIn?: boolean;
  artifactId?: string;
}>): boolean {
  return profile.isBuiltIn === true && profile.artifactId === undefined;
}

/** Entity enablement owns its row; only a builtin without membership reads Settings. */
export function readAiLaunchProfileEnabledV1(
  profile: Readonly<{ id: string; isBuiltIn?: boolean; artifactId?: string; enabled?: boolean; defaultEnabled?: boolean }>,
  enabledById: Readonly<Record<string, boolean>>,
): boolean {
  return profile.enabled ?? enabledById[profile.id] ?? profile.defaultEnabled ?? true;
}

/** Presence is not emptiness: explicit empty or malformed roots still require captured transfer. */
export function hasProfileTransferSourceV1(raw: unknown): boolean {
  if (!plainRecord(raw)) return true;
  if (['profiles', 'secretBindingsByProfileId'].some((key) => Object.hasOwn(raw, key))) return true;
  if (Object.hasOwn(raw, 'profileEnabledById')) {
    const enabled = raw.profileEnabledById;
    if (!plainRecord(enabled) || Object.entries(enabled).some(([id, value]) => !isHistoricalBuiltInAiLaunchProfileIdV1(id) || typeof value !== 'boolean')) return true;
  }
  if (!Object.hasOwn(raw, 'promptStacksV1')) return false;
  const stacks = raw.promptStacksV1;
  if (!plainRecord(stacks) || stacks.v !== 1 || !plainRecord(stacks.surfaces)) return true;
  return Object.hasOwn(stacks.surfaces, 'profilesById');
}

/** Select the sole reader without mistaking a native Account for an unactivated transfer. */
export function resolveProfileCatalogAuthorityV1(input: Readonly<{
  rawSettings: unknown;
  control: ProfileTransferControlV1 | null;
}>): 'destination' | 'legacy' {
  if (input.control?.phase === 'active') return 'destination';
  if (input.control?.phase === 'prepared') return 'legacy';
  return hasProfileTransferSourceV1(input.rawSettings) ? 'legacy' : 'destination';
}

/** Retire only the addressed no-entity enablement source; other preference bytes stay owned by Settings. */
export function removeProfileEnabledPreferenceV1(raw: Readonly<Record<string, unknown>>, profileId: string): Record<string, unknown> {
  const enabled = raw.profileEnabledById;
  if (!plainRecord(enabled) || !Object.hasOwn(enabled, profileId)) return { ...raw };
  const nextEnabled = { ...enabled };
  delete nextEnabled[profileId];
  return { ...raw, profileEnabledById: nextEnabled };
}

export function removeProfilePreferenceReferencesV1(
  raw: Readonly<Record<string, unknown>>,
  profileId: string,
  _definition: ProfileRecordV1['definition'] | undefined,
): Record<string, unknown> {
  return { ...removeProfileEnabledPreferenceV1(raw, profileId),
    ...(Array.isArray(raw.favoriteProfiles) ? { favoriteProfiles: raw.favoriteProfiles.filter((entry) => entry !== profileId) } : {}),
  };
}

export const PROFILE_TRANSFERRED_SOURCE_ROOTS_V1 = ['profiles', 'secretBindingsByProfileId'] as const;

/** Only private row inventory entries name logical Profiles; Artifact ids name resources. */
export function listTransferredProfileIdsV1(control: ProfileTransferControlV1): readonly string[] {
  return control.inventory.flatMap((entry) => entry.kind === 'account_row' ? [entry.id] : []);
}

/** Source cleanup only, after the captured complete transfer has become active. */
export function removeTransferredProfileSourcesV1(raw: Readonly<Record<string, unknown>>, transferredProfileIds: readonly string[]): Record<string, unknown> {
  const next = { ...raw };
  for (const root of PROFILE_TRANSFERRED_SOURCE_ROOTS_V1) delete next[root];
  const entityIds = new Set(transferredProfileIds);
  if (plainRecord(raw.profileEnabledById)) {
    next.profileEnabledById = Object.fromEntries(Object.entries(raw.profileEnabledById)
      .filter(([id]) => !entityIds.has(id)));
  }
  if (plainRecord(raw.promptStacksV1) && plainRecord(raw.promptStacksV1.surfaces)) {
    const surfaces = { ...raw.promptStacksV1.surfaces };
    delete surfaces.profilesById;
    next.promptStacksV1 = { ...raw.promptStacksV1, surfaces };
  }
  return next;
}

export function readAiLaunchProfileCollection(raw: unknown, options?: Readonly<{
  /** Already-authorized, opened documents; this reader never fetches foreign data. */
  artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1>;
  includeShared?: boolean;
}>): AiLaunchProfileCollectionReadResult {
  const entries: AiLaunchProfileCollectionEntry[] = [];
  const diagnostics: AiLaunchProfileReadDiagnostic[] = [];
  (Array.isArray(raw) ? raw : []).forEach((entry, index) => {
    const reference = createStoredReadSchema(LaunchProfileArtifactReferenceV1Schema).safeParse(entry);
    if (reference.success) {
      const resource = options?.artifactsById.get(reference.data.artifactId);
      const content = resource?.artifactId === reference.data.artifactId ? readLaunchProfileArtifactV1(resource) : null;
      if (!content) {
        diagnostics.push({ index, reason: 'artifact_unavailable' });
        entries.push({ kind: 'opaque', raw: entry });
      } else {
        const source = { artifactId: reference.data.artifactId, secretBindings: content.secretBindings,
          shared: resource?.access === 'view' || resource?.access === 'edit' || resource?.access === 'admin',
          viewOnly: resource?.access === 'view', ...(resource?.revision ? { revision: resource.revision } : {}) };
        if ('v' in content.profile) entries.push({ kind: 'slim', profile: { ...content.profile, ...source }, raw: entry, ...source });
        else entries.push({ kind: 'legacy', profile: { ...projectHistoricalBuiltInAiLaunchProfileV1(content.profile), ...source }, raw: entry, ...source });
      }
      return;
    }
    const slim = createStoredReadSchema(StoredLaunchProfileV2Schema).safeParse(entry);
    if (slim.success) {
      entries.push({ kind: 'slim', profile: slim.data, raw: entry });
      return;
    }
    const version = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Reflect.get(entry, 'v')
      : undefined;
    // A versioned row belongs to that version's schema. Never strip its version
    // and silently reinterpret malformed/future content as a legacy profile.
    const legacy = version === undefined ? createStoredReadSchema(AIBackendProfileSchema).safeParse(entry) : null;
    if (legacy?.success) {
      entries.push({
        kind: 'legacy',
        profile: projectHistoricalBuiltInAiLaunchProfileV1(legacy.data),
        raw: entry,
      });
      return;
    }
    diagnostics.push({ index, reason: typeof version === 'number' && version > 2 ? 'future_version' : 'malformed' });
    entries.push({ kind: 'opaque', raw: entry });
  });
  if (options?.includeShared) {
    const referenced = new Set((Array.isArray(raw) ? raw : []).flatMap((row) => {
      const reference = createStoredReadSchema(LaunchProfileArtifactReferenceV1Schema).safeParse(row);
      return reference.success ? [reference.data.artifactId] : [];
    }));
    for (const resource of options.artifactsById.values()) {
      if (resource.header.kind !== 'launch-profile.v1' || referenced.has(resource.artifactId) || !['view', 'edit', 'admin'].includes(resource.access ?? '')) continue;
      const shared = readAiLaunchProfileCollection([{ artifactId: resource.artifactId }], { artifactsById: options.artifactsById });
      entries.push(...shared.entries);
    }
  }
  return { raw, entries, diagnostics };
}

/** Effective reference admission uses the Artifact census owner, never a private-only approximation. */
export function readEffectiveProfileSecretBindingsV1(record: ProfileRecordV1, options: Readonly<{
  artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1>;
}>): Readonly<Record<string, string>> | null {
  if (record.definition.kind !== 'artifact') return resolveEffectiveProfileSecretBindingsV1({}, record.secretBindings);
  const artifactId = record.definition.artifactId;
  const resource = options.artifactsById.get(artifactId);
  const artifact = resource?.artifactId === artifactId ? readLaunchProfileArtifactForReferenceCensusV1(resource) : null;
  if (!artifact || artifact.profile.id !== record.id) return null;
  return resolveEffectiveProfileSecretBindingsV1(artifact.secretBindings, record.secretBindings);
}

/** One projection for opened private records; Artifact grants remain resource-owned. */
export function readAiLaunchProfileRecords(raw: readonly unknown[], options?: Readonly<{
  artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1>;
  includeShared?: boolean;
  recordRevisionsById?: ReadonlyMap<string, number>;
}>): AiLaunchProfileCollectionReadResult {
  const entries: AiLaunchProfileCollectionEntry[] = [];
  const diagnostics: AiLaunchProfileReadDiagnostic[] = [];
  const referencedArtifactIds = new Set<string>();
  raw.forEach((value, index) => {
    const parsed = StoredProfileRecordV1Schema.safeParse(value);
    if (!parsed.success) {
      const version = value && typeof value === 'object' ? Reflect.get(value, 'v') : undefined;
      diagnostics.push({ index, reason: typeof version === 'number' && version > 1 ? 'future_version' : 'malformed' });
      entries.push({ kind: 'opaque', raw: value });
      return;
    }
    const record = parsed.data;
    const definition = record.definition;
    if (definition.kind === 'artifact') referencedArtifactIds.add(definition.artifactId);
    const collection = readAiLaunchProfileCollection([
      definition.kind === 'artifact' ? { artifactId: definition.artifactId } : definition.profile,
    ], options ? { artifactsById: options.artifactsById } : undefined);
    const entry = collection.entries[0];
    if (!entry || entry.kind === 'opaque') {
      entries.push({ kind: 'opaque', raw: value });
      diagnostics.push(...collection.diagnostics.map((diagnostic) => ({ ...diagnostic, index })));
      return;
    }
    if (entry.profile.id !== record.id) {
      entries.push({ kind: 'opaque', raw: value });
      diagnostics.push({ index, reason: 'identity_mismatch' });
      return;
    }
    const profileRecordRevision = options?.recordRevisionsById?.get(record.id);
    const source = { enabled: record.enabled, promptStack: record.promptStack,
      secretBindings: resolveEffectiveProfileSecretBindingsV1(entry.profile.secretBindings ?? {}, record.secretBindings),
      ...(profileRecordRevision === undefined ? {} : { profileRecordRevision }) };
    if (entry.kind === 'legacy') entries.push({ ...entry, raw: value, profile: { ...entry.profile, ...source }, ...source });
    else entries.push({ ...entry, raw: value, profile: { ...entry.profile, ...source }, ...source });
  });
  if (options?.includeShared) {
    const shared = readAiLaunchProfileCollection([], { artifactsById: options.artifactsById, includeShared: true });
    for (const entry of shared.entries) {
      if (entry.kind !== 'opaque' && entry.artifactId && !referencedArtifactIds.has(entry.artifactId)) entries.push(entry);
    }
  }
  return { raw, entries, diagnostics };
}

export const LegacyProfileRecordPreparationDiagnosticV1Schema = lazyZodSchema(() => z.object({
  profileId: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  reason: z.enum(['future_version', 'malformed', 'artifact_unavailable', 'identity_mismatch',
    'duplicate_profile_id', 'unresolved_binding_profile', 'unresolved_stack_profile', 'unresolved_enabled_profile',
    'inline-secret-requires-promotion', 'unknown-secret-reference-carrier']),
}).strict());
export type LegacyProfileRecordPreparationDiagnosticV1 = z.infer<typeof LegacyProfileRecordPreparationDiagnosticV1Schema>;

export type LegacyProfileRecordPreparationV1 = Readonly<{
  status: 'complete' | 'partial';
  records: readonly ProfileRecordV1[];
  diagnostics: readonly Readonly<LegacyProfileRecordPreparationDiagnosticV1>[];
}>;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Read the complete opened predecessor inventory through one canonical attachment projection.
 * Provider routing conversion runs through migrateLegacyAiLaunchProfilesV1 first;
 * pending profiles remain explicit legacy definitions, never guessed V2 env rows.
 * This preparation neither activates authority nor removes source/history bytes.
 */
function readLegacyProfileRecords(raw: Readonly<Record<string, unknown>>, options: Readonly<{
  artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1>;
  providerContributions?: readonly Pick<ProviderContributionV1, 'legacyProfileMigrations'>[];
}> | undefined, forTransfer: boolean): LegacyProfileRecordPreparationV1 {
  const collection = readAiLaunchProfileCollection(raw.profiles, options);
  const diagnostics: Array<LegacyProfileRecordPreparationV1['diagnostics'][number]> = [...collection.diagnostics];
  if (raw.profiles !== undefined && !Array.isArray(raw.profiles)) diagnostics.push({ reason: 'malformed' });
  const bindings = raw.secretBindingsByProfileId === undefined ? {} : raw.secretBindingsByProfileId;
  if (!plainRecord(bindings)) diagnostics.push({ reason: 'malformed' });
  const enabled = raw.profileEnabledById === undefined ? {} : raw.profileEnabledById;
  if (!plainRecord(enabled)) diagnostics.push({ reason: 'malformed' });
  const stacks = raw.promptStacksV1;
  let byProfileStack: Record<string, unknown> = {};
  if (stacks !== undefined) {
    if (!plainRecord(stacks) || stacks.v !== 1 || !plainRecord(stacks.surfaces)
      || (stacks.surfaces.profilesById !== undefined && !plainRecord(stacks.surfaces.profilesById))) {
      diagnostics.push({ reason: 'malformed' });
    } else byProfileStack = stacks.surfaces.profilesById ?? {};
  }
  const records: ProfileRecordV1[] = [];
  const ids = new Set<string>();
  const rawIds = new Set(collection.entries.flatMap((entry) => {
    const id = readOwnStringId(entry.raw);
    return id ? [id] : [];
  }));
  const append = (profile: AiLaunchProfile, artifactId?: string, hasPersistedDefinition = true) => {
    if (ids.has(profile.id)) {
      diagnostics.push({ profileId: profile.id, reason: 'duplicate_profile_id' });
      return;
    }
    ids.add(profile.id);
    const rawBindings = plainRecord(bindings) && Object.hasOwn(bindings, profile.id) ? bindings[profile.id] : {};
    // Predecessor Settings only carried string references. Nullable NONE masks
    // belong to private entity overrides, not malformed retained source bytes.
    const sourceBindings = ProfileSecretBindingsV1Schema.safeParse(rawBindings);
    if (!sourceBindings.success) {
      diagnostics.push({ profileId: profile.id, reason: 'malformed' });
      return;
    }
    const canonicalBindings = sourceBindings.data;
    if (forTransfer && hasPersistedDefinition && !artifactId && listLegacyAiLaunchProfileUnpromotedCredentialEnvironmentVariableNamesV1({
      environmentVariables: isLaunchProfileV2(profile) ? profile.extraEnvironmentVariables : profile.environmentVariables,
      envVarRequirements: profile.envVarRequirements ?? [],
    }, options?.providerContributions ?? [], canonicalBindings).length > 0) {
      diagnostics.push({ profileId: profile.id, reason: 'inline-secret-requires-promotion' });
      return;
    }
    const rawStack = Object.hasOwn(byProfileStack, profile.id) ? byProfileStack[profile.id] : [];
    if (forTransfer && listSavedSecretReferenceCarrierPathsV1(rawStack).length > 0) {
      diagnostics.push({ profileId: profile.id, reason: 'unknown-secret-reference-carrier' });
      return;
    }
    const enabledValue = plainRecord(enabled) && Object.hasOwn(enabled, profile.id) ? enabled[profile.id]
      : isLaunchProfileV2(profile) ? true : profile.defaultEnabled;
    const definition = artifactId ? { kind: 'artifact' as const, artifactId }
      : isLaunchProfileV2(profile) ? { kind: 'inline' as const, profile }
        : { kind: 'legacy' as const, profile };
    const parsed = StoredProfileRecordV1Schema.safeParse({ v: 1, id: profile.id, definition,
      enabled: enabledValue, promptStack: rawStack, secretBindings: rawBindings });
    if (!parsed.success) {
      diagnostics.push({ profileId: profile.id, reason: 'malformed' });
      return;
    }
    records.push(ProfileRecordV1Schema.parse(parsed.data));
  };
  collection.entries.forEach((entry, index) => {
    if (entry.kind === 'opaque') return;
    if (forTransfer && entry.artifactId) {
      const resource = options?.artifactsById.get(entry.artifactId);
      if (!resource || !readLaunchProfileArtifactForReferenceCensusV1(resource)) {
        diagnostics.push({ profileId: entry.profile.id, index, reason: 'unknown-secret-reference-carrier' });
        return;
      }
    }
    if (forTransfer && listSavedSecretReferenceCarrierPathsV1(entry.raw).length > 0) {
      diagnostics.push({ profileId: entry.profile.id, index, reason: 'unknown-secret-reference-carrier' });
      return;
    }
    append(entry.profile, entry.artifactId);
  });
  if (plainRecord(enabled)) {
    for (const [profileId, value] of Object.entries(enabled)) {
      if (typeof value !== 'boolean') diagnostics.push({ profileId, reason: 'malformed' });
      else if (!rawIds.has(profileId) && !ids.has(profileId) && !isHistoricalBuiltInAiLaunchProfileIdV1(profileId)) {
        diagnostics.push({ profileId, reason: 'unresolved_enabled_profile' });
      }
    }
  }
  const attachedIds = new Set([
    ...Object.keys(plainRecord(bindings) ? bindings : {}),
    ...Object.keys(byProfileStack),
  ]);
  for (const profileId of attachedIds) {
    if (ids.has(profileId) || rawIds.has(profileId)) continue;
    const builtin = getHistoricalBuiltInAiLaunchProfileV1(profileId);
    // Reconstructed code-owned templates are not literal credential carriers in
    // Settings. Only the retained private bindings and stack are source bytes.
    if (builtin) append(projectHistoricalBuiltInAiLaunchProfileV1(builtin), undefined, false);
    else diagnostics.push({ profileId, reason: plainRecord(bindings) && Object.hasOwn(bindings, profileId)
      ? 'unresolved_binding_profile' : 'unresolved_stack_profile' });
  }
  return { status: diagnostics.length === 0 ? 'complete' : 'partial', records, diagnostics };
}

/** Inactive source read-through for display/repair, not destination authority. */
export function readLegacyProfileRecordsV1(raw: Readonly<Record<string, unknown>>, options?: Readonly<{
  artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1>;
}>): LegacyProfileRecordPreparationV1 {
  return readLegacyProfileRecords(raw, options, false);
}

/** Complete source eligibility before a write, never activation or source cleanup. */
export function prepareLegacyProfileRecordsV1(raw: Readonly<Record<string, unknown>>, options?: Readonly<{
  artifactsById: ReadonlyMap<string, ArtifactSharingResourceV1>;
  providerContributions?: readonly Pick<ProviderContributionV1, 'legacyProfileMigrations'>[];
}>): LegacyProfileRecordPreparationV1 {
  return readLegacyProfileRecords(raw, options, true);
}

/** Fetching stays in the mode-aware, grant-authorized Artifact store; all hosts share this inventory. */
export async function loadAiLaunchProfileArtifacts(raw: unknown, store: Readonly<{
  read: (artifactId: string, options?: Readonly<{ signal?: AbortSignal }>) => Promise<ArtifactSharingResourceV1 | null>;
  list?: (options: Readonly<{ limit: number; cursor?: string; signal?: AbortSignal }>) => Promise<Readonly<{
    items: readonly ArtifactSharingResourceV1[]; nextCursor?: string;
  }>>;
}>, signal?: AbortSignal): Promise<ReadonlyMap<string, ArtifactSharingResourceV1>> {
  const ids = new Set<string>();
  for (const row of Array.isArray(raw) ? raw : []) {
    const record = StoredProfileRecordV1Schema.safeParse(row);
    if (record.success) {
      if (record.data.definition.kind === 'artifact') ids.add(record.data.definition.artifactId);
      continue;
    }
    const reference = createStoredReadSchema(LaunchProfileArtifactReferenceV1Schema).safeParse(row);
    if (reference.success) ids.add(reference.data.artifactId);
  }
  if (store.list) {
    let cursor: string | undefined;
    do {
      signal?.throwIfAborted();
      // FIN's Artifact list owns the 500-row page boundary (not a collection cap).
      const page = await store.list({ limit: 500, ...(cursor ? { cursor } : {}), ...(signal ? { signal } : {}) });
      for (const item of page.items) {
        if (item.header.kind === 'launch-profile.v1' && ['view', 'edit', 'admin'].includes(item.access ?? '')) ids.add(item.artifactId);
      }
      if (page.nextCursor !== undefined && page.nextCursor === cursor) throw Object.assign(new Error('artifact_list_cursor_invalid'), { code: 'artifact_list_cursor_invalid' });
      cursor = page.nextCursor;
    } while (cursor);
  }
  const artifacts = new Map<string, ArtifactSharingResourceV1>();
  for (const id of ids) {
    signal?.throwIfAborted();
    const artifact = await store.read(id, signal ? { signal } : undefined);
    signal?.throwIfAborted();
    if (artifact?.artifactId === id) artifacts.set(id, artifact);
  }
  return artifacts;
}

function readOwnStringId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = Reflect.get(raw, 'id');
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Fail-safe UI pruning predicate. Migration completion is intentionally not a
 * deletion signal here: the daemon's whole-account CAS transform owns removal
 * of migrated bindings in the same atomic write as the provider connection.
 */
export function shouldPreserveLegacyAiLaunchProfileBindingV1(input: Readonly<{
  profileId: string;
  collection: AiLaunchProfileCollectionReadResult;
  migration?: ProviderSettingsMigrationStateV1 | null;
}>): boolean {
  if (isHistoricalBuiltInAiLaunchProfileIdV1(input.profileId)) return true;
  if (input.migration?.pendingCustomProfileIds.includes(input.profileId)) return true;
  return input.collection.entries.some((entry) => readOwnStringId(entry.raw) === input.profileId);
}
