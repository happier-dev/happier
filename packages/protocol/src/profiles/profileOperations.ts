import type { ProfileCatalogSnapshotV1 } from './profileCatalogV1.js';
import { ProfileRecordV1Schema, parseProfileRecordForMutationV1, hasChangedReadonlyProfileDefinitionV1, type ProfileRecordV1, type ProfileRowMutationV1 } from './profileRecordSchemaV1.js';
import { isBuiltInAiLaunchProfileV1, isHistoricalBuiltInAiLaunchProfileIdV1, isLaunchProfileV2, readAiLaunchProfileEnabledV1, readAiLaunchProfileRecords, removeProfileEnabledPreferenceV1, type AiLaunchProfile } from './read.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { LaunchProfileV2Schema, StoredLaunchProfileV2Schema } from './v2/schema.js';
import { LaunchProfileIdV2Schema } from './v2/profileId.js';
import { AIBackendProfileSchema } from './backendProfileSchema.js';
import type { ArtifactSharingResourceV1 } from '../artifacts/artifactSharingV1.js';
import { formatSharedSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { accountSettingsParse } from '../account/settings/accountSettings.js';
import { mapAiLaunchProfileToListItemV1 } from './listProjection.js';
import { getBuiltInBackendProfile } from './builtInBackendProfiles.js';
import { AccountSettingsPersistedObjectSchema } from '../account/settings/accountSettingsPersistedObject.js';
import type { ArtifactRevisionV1 } from '../artifacts/artifactActionsV1.js';

/** Preserve the incumbent favorite order and the empty machine-environment identity. */
export function setProfileFavoriteIdsV1(ids: readonly string[], id: string, favorite: boolean): string[] {
  const otherIds = [...new Set(ids)].filter(current => current !== id);
  if (!favorite) return otherIds;
  return ids.includes(id) ? [...new Set(ids)] : [id, ...otherIds];
}

export function toggleFavoriteProfileId(ids: string[], id: string): string[] {
  return setProfileFavoriteIdsV1(ids, id, !ids.includes(id));
}

export function setProfileFavoritePreferenceV1(raw: Readonly<Record<string, unknown>>, id: string, favorite: boolean): Record<string, unknown> {
  return { ...raw, favoriteProfiles: setProfileFavoriteIdsV1(accountSettingsParse(raw).favoriteProfiles, id, favorite) };
}

export function setProfileEnabledOverrideV1(overrides: Readonly<Record<string, unknown>> | null | undefined,
  profile: Readonly<{ id: string; defaultEnabled?: boolean }>, enabled: boolean): Record<string, unknown> {
  const next = { ...overrides };
  if (enabled === (profile.defaultEnabled !== false)) delete next[profile.id];
  else next[profile.id] = enabled;
  return next;
}

export function setBuiltinProfileEnabledPreferenceV1(raw: Readonly<Record<string, unknown>>, id: string, enabled: boolean): Record<string, unknown> {
  const profile = getBuiltInBackendProfile(id);
  if (!profile && !isHistoricalBuiltInAiLaunchProfileIdV1(id)) throw new Error('profile_enablement_invalid');
  const overrides = AccountSettingsPersistedObjectSchema.safeParse(raw.profileEnabledById ?? {});
  if (!overrides.success) throw new Error('profile_enablement_invalid');
  return { ...raw, profileEnabledById: setProfileEnabledOverrideV1(overrides.data, profile ?? { id }, enabled) };
}

/** First membership captures the no-entity preference and retires its source in the same Settings CAS. */
export function prepareBuiltinProfileAttachmentV1(record: ProfileRecordV1, raw: Readonly<Record<string, unknown>>): Readonly<{
  record: ProfileRecordV1; nextSettings: Record<string, unknown>;
}> {
  const admitted = parseProfileRecordForMutationV1({ operation: 'attach-builtin', record });
  if (admitted.definition.kind !== 'legacy') throw new Error('profile_attachment_invalid');
  const overrides = AccountSettingsPersistedObjectSchema.parse(raw.profileEnabledById ?? {});
  const override = Object.hasOwn(overrides, admitted.id) ? overrides[admitted.id] : undefined;
  const enabled = readAiLaunchProfileEnabledV1(admitted.definition.profile,
    typeof override === 'boolean' ? { [admitted.id]: override } : {});
  return { record: { ...admitted, enabled }, nextSettings: removeProfileEnabledPreferenceV1(raw, admitted.id) };
}

export type ProfileOperationResult =
  | Readonly<{ status: 'updated'; id: string; revision: number }>
  | Readonly<{ status: 'conflict'; id: string; revision: number }>
  | Readonly<{ status: 'unavailable'; reason: string }>
  | Readonly<{ status: 'invalid'; reason: 'duplicate-id' | 'duplicate-name' | 'profile-not-found' | 'read-only' | 'legacy-creation-unsupported' | 'invalid-definition'; id?: string }>;
export type ProfileBuiltinEnabledInputV1 = Readonly<{ subject: Readonly<{ kind: 'builtin'; id: string }>; enabled: boolean; expectedSettingsVersion: number }>;
export type ProfileBuiltinEnabledResultV1 = Readonly<{ status: 'preference-updated'; id: string; enabled: boolean; settingsVersion: number }>;
export type ProfileRemovalResult = Exclude<ProfileOperationResult, Readonly<{ status: 'updated' }>>
  | Readonly<{ status: 'updated'; id: string; revision: number;
    authoringMemoryCleanup?: Readonly<{ status: 'unavailable'; reason: 'authoring_memory_cleanup_failed' }> }>;
export type ProfileDuplicateDraftResultV1 = Readonly<{ status: 'draft'; profile: AiLaunchProfile; secretBindings: ProfileRecordV1['secretBindings'] }>
  | Readonly<{ status: 'invalid'; reason: 'legacy-creation-unsupported' | 'invalid-definition'; id: string }>;

/** The private row owns selection encoding; absence in an effective editor maps to explicit None. */
export function applyProfileSecretBindingSelectionV1(bindings: ProfileRecordV1['secretBindings'], envName: string,
  selection: Readonly<{ kind: 'none' }> | Readonly<{ kind: 'reference'; reference: string }>): ProfileRecordV1['secretBindings'] {
  return { ...bindings, [envName]: selection.kind === 'none' ? null : selection.reference };
}

/** A detached authoring draft is not a new Artifact or an acknowledged private row. */
export function createProfileDuplicateDraftV1(input: Readonly<{
  profile: AiLaunchProfile; newProfileId: string; name: string; now: number;
  sourceRow?: Readonly<{ record: ProfileRecordV1; revision: number }>;
}>): ProfileDuplicateDraftResultV1 {
  if (!isLaunchProfileV2(input.profile)) return { status: 'invalid', reason: 'legacy-creation-unsupported', id: input.profile.id };
  const sourceRow = input.sourceRow;
  if ((input.profile.profileRecordRevision !== undefined && sourceRow?.revision !== input.profile.profileRecordRevision)
    || (sourceRow && (sourceRow.record.id !== input.profile.id
      || sourceRow.record.definition.kind === 'legacy'
      || (sourceRow.record.definition.kind === 'artifact' && sourceRow.record.definition.artifactId !== input.profile.artifactId)))) {
    return { status: 'invalid', reason: 'invalid-definition', id: input.profile.id };
  }
  const source = createStoredReadSchema(StoredLaunchProfileV2Schema).safeParse(input.profile);
  const newId = LaunchProfileIdV2Schema.safeParse(input.newProfileId);
  if (!source.success || !newId.success) return { status: 'invalid', reason: 'invalid-definition', id: input.newProfileId };
  const body = StoredLaunchProfileV2Schema.safeParse({ ...source.data,
    id: newId.data, createdAt: input.now, updatedAt: input.now });
  if (!body.success) return { status: 'invalid', reason: 'invalid-definition', id: input.newProfileId };
  const secretBindings: ProfileRecordV1['secretBindings'] = { ...input.profile.secretBindings };
  for (const [envName, binding] of Object.entries(sourceRow?.record.secretBindings ?? {})) {
    if (binding === null) secretBindings[envName] = null;
  }
  return { status: 'draft', profile: { ...body.data, name: input.name,
    ...(sourceRow ? { enabled: sourceRow.record.enabled, promptStack: [...sourceRow.record.promptStack] } : {}),
    ...(input.profile.secretBindings !== undefined ? { secretBindings: { ...input.profile.secretBindings } } : {}),
  }, secretBindings };
}
export type ProfileOperationsPorts = Readonly<{
  readCatalog: () => ProfileCatalogSnapshotV1;
  writeRecord: (input: Readonly<{ record: ProfileRecordV1; expectedRevision: number | 'absent'; operation: Exclude<ProfileRowMutationV1['operation'], 'remove' | 'import'>; savedSecretRevisions?: ProfileRowMutationV1['savedSecretRevisions'] }>) => Promise<ProfileOperationResult>;
  deleteRecord: (input: Readonly<{ id: string; expectedRevision: number; previousDefinition: ProfileRecordV1['definition'] }>) => Promise<ProfileOperationResult>;
  clearRememberedProfile?: (input: Readonly<{ id: string }>) => Promise<void>;
  builtinNames?: readonly string[];
  agentIds?: readonly string[];
  readVisibleProfiles?: () => readonly AiLaunchProfile[] | Readonly<{ status: 'unavailable'; reason: string }>;
  readEnabledPreferences?: () => Readonly<Record<string, boolean>>;
  setBuiltinEnabled?: (input: ProfileBuiltinEnabledInputV1) => Promise<ProfileBuiltinEnabledResultV1 | ProfileOperationResult>;
  artifactsById?: () => ReadonlyMap<string, ArtifactSharingResourceV1>;
  writeArtifactProfile?: (input: Readonly<{ profile: AiLaunchProfile; record: ProfileRecordV1; expectedRevision: number; expectedArtifactRevision: ArtifactRevisionV1 }>) => Promise<ProfileOperationResult>;
}>;

/** UI and automation mutate the same opened entity inventory; persistence stays transport-owned. */
export function createProfileOperations(ports: ProfileOperationsPorts) {
  const invalid = (reason: Extract<ProfileOperationResult, { status: 'invalid' }>['reason'], id?: string): ProfileOperationResult =>
    ({ status: 'invalid', reason, ...(id ? { id } : {}) });
  const rowInventory = () => {
    const catalog = ports.readCatalog();
    if (catalog.status !== 'ready') return { status: 'unavailable' as const,
      reason: catalog.status === 'unavailable' ? catalog.reason : `profile_catalog_${catalog.status}` };
    if (catalog.source !== 'destination') return { status: 'unavailable' as const, reason: 'profile_catalog_inactive' };
    const ids = new Set<string>();
    for (const { record } of catalog.records) {
      if (ids.has(record.id)) return invalid('duplicate-id', record.id);
      ids.add(record.id);
    }
    return { status: 'ready' as const, rows: catalog.records };
  };
  const inventory = () => {
    const rows = rowInventory();
    if (rows.status !== 'ready') return rows;
    const opened = readAiLaunchProfileRecords(rows.rows.map(entry => entry.record), {
      artifactsById: ports.artifactsById?.() ?? new Map(),
      recordRevisionsById: new Map(rows.rows.map(entry => [entry.record.id, entry.revision])),
      includeShared: true,
    });
    if (opened.diagnostics.length > 0) return { status: 'unavailable' as const, reason: 'profile_definition_unavailable' };
    return { status: 'ready' as const, rows: rows.rows,
      profiles: opened.entries.flatMap(entry => entry.kind === 'opaque' ? [] : [entry.profile]) };
  };
  const locationForProfile = (profile: AiLaunchProfile, rows: readonly Readonly<{ record: ProfileRecordV1; revision: number }>[]) => {
    if (profile.artifactId) {
      const resource = ports.artifactsById?.().get(profile.artifactId);
      if (!resource?.revision) return { status: 'unavailable' as const, reason: 'profile_artifact_revision_unavailable' };
      return { status: 'located' as const, location: { kind: 'artifact' as const, artifactId: resource.artifactId,
        headerVersion: resource.revision.headerVersion, bodyVersion: resource.revision.bodyVersion }, artifactAccess: resource.access };
    }
    const row = rows.find(row => row.record.id === profile.id);
    if (row) return { status: 'located' as const, location: { kind: 'account_row' as const, revision: row.revision } };
    if (isBuiltInAiLaunchProfileV1(profile)) return { status: 'located' as const, location: { kind: 'builtin' as const } };
    return { status: 'unavailable' as const, reason: 'profile_definition_unavailable' };
  };
  const current = (id: string, expectedRevision?: number | 'absent') => {
    const opened = rowInventory();
    if (opened.status !== 'ready') return opened;
    const row = opened.rows.find(entry => entry.record.id === id);
    if (!row) return invalid('profile-not-found', id);
    if (expectedRevision !== undefined && expectedRevision !== row.revision) return { status: 'conflict' as const, id, revision: row.revision };
    return { status: 'ready' as const, row };
  };
  const update = async (input: Readonly<{ id: string; expectedRevision?: number | 'absent'; savedSecretRevisions?: ProfileRowMutationV1['savedSecretRevisions'] }>, change: (record: ProfileRecordV1) => ProfileRecordV1): Promise<ProfileOperationResult> => {
    const admitted = current(input.id, input.expectedRevision);
    if (admitted.status === 'invalid' && admitted.reason === 'profile-not-found' && input.expectedRevision === 'absent') {
      const builtin = getBuiltInBackendProfile(input.id);
      if (builtin) {
        const record = ProfileRecordV1Schema.parse(change({ v: 1, id: builtin.id,
          definition: { kind: 'legacy', profile: builtin }, enabled: readAiLaunchProfileEnabledV1(builtin, ports.readEnabledPreferences?.() ?? {}),
          promptStack: [], secretBindings: {} }));
        return ports.writeRecord({ record, expectedRevision: 'absent', operation: 'attach-builtin',
          ...(input.savedSecretRevisions ? { savedSecretRevisions: input.savedSecretRevisions } : {}) });
      }
    }
    if (admitted.status === 'invalid' && admitted.reason === 'profile-not-found'
      && (input.expectedRevision === undefined || input.expectedRevision === 'absent')) {
      const opened = inventory();
      if (opened.status !== 'ready') return opened;
      const source = opened.profiles.find(profile => profile.id === input.id && profile.artifactId);
      if (!source?.artifactId) return admitted;
      if (opened.profiles.some(profile => profile.id !== source.id && profile.name.trim() === source.name.trim())) return invalid('duplicate-name', input.id);
      const record = ProfileRecordV1Schema.parse(change({ v: 1, id: input.id,
        definition: { kind: 'artifact', artifactId: source.artifactId }, enabled: true, promptStack: [], secretBindings: {} }));
      return ports.writeRecord({ record, expectedRevision: 'absent', operation: 'create',
        ...(input.savedSecretRevisions ? { savedSecretRevisions: input.savedSecretRevisions } : {}) });
    }
    if (admitted.status !== 'ready') return admitted;
    return ports.writeRecord({ record: ProfileRecordV1Schema.parse(change(admitted.row.record)),
      expectedRevision: admitted.row.revision, operation: 'update',
      ...(input.savedSecretRevisions ? { savedSecretRevisions: input.savedSecretRevisions } : {}) });
  };
  return {
    validateSelection: (input: Readonly<{ id: string | null }>) => {
      if (input.id === null) return { status: 'selected' as const, id: null };
      const opened = inventory();
      if (opened.status !== 'ready') return opened;
      const visible = ports.readVisibleProfiles?.() ?? opened.profiles;
      if ('status' in visible) return visible;
      const profile = visible.find(profile => profile.id === input.id);
      if (!profile) return invalid('profile-not-found', input.id);
      if (!readAiLaunchProfileEnabledV1(profile, ports.readEnabledPreferences?.() ?? {}))
        return { status: 'unavailable' as const, reason: 'profile_disabled' };
      return { status: 'selected' as const, id: input.id };
    },
    read: (input: Readonly<{ id: string }>) => {
      const admitted = rowInventory();
      if (admitted.status !== 'ready') return admitted;
      const row = admitted.rows.find(row => row.record.id === input.id);
      let profile: AiLaunchProfile | undefined;
      if (row) {
        const opened = readAiLaunchProfileRecords([row.record], { artifactsById: ports.artifactsById?.() ?? new Map(),
          recordRevisionsById: new Map([[row.record.id, row.revision]]) });
        if (opened.diagnostics.length > 0) return { status: 'unavailable' as const, reason: 'profile_definition_unavailable' };
        profile = opened.entries.find(entry => entry.kind !== 'opaque')?.profile;
      } else {
        const opened = inventory();
        if (opened.status !== 'ready') return opened;
        const visible = ports.readVisibleProfiles?.();
        if (visible && !('status' in visible)) profile = visible.find(profile => profile.id === input.id);
        else {
          // Actual granted resources are visible independently of remembered builtin evidence.
          profile = opened.profiles.find(profile => profile.id === input.id && profile.artifactId);
          if (!profile) return visible ?? { status: 'unavailable' as const, reason: 'profile_selection_evidence_unavailable' };
        }
      }
      if (!profile) return invalid('profile-not-found', input.id);
      const located = locationForProfile(profile, admitted.rows);
      if (located.status !== 'located') return located;
      if (located.location.kind === 'artifact') {
        if (!located.artifactAccess) return { status: 'unavailable' as const, reason: 'profile_artifact_access_unavailable' };
        const location = { ...located.location, access: located.artifactAccess };
        return row ? { status: 'present' as const, profile, location, ...row }
          : { status: 'present' as const, profile, location };
      }
      if (located.location.kind === 'account_row') {
        if (!row) return { status: 'unavailable' as const, reason: 'profile_definition_unavailable' };
        return { status: 'present' as const, profile, location: located.location, ...row };
      }
      return { status: 'present' as const, profile, location: located.location };
    },
    search: (input: Readonly<{ query?: string }> = {}) => {
      const opened = inventory();
      if (opened.status !== 'ready') return opened;
      const query = (input.query ?? '').trim().toLocaleLowerCase();
      const visible = ports.readVisibleProfiles?.() ?? opened.profiles;
      if ('status' in visible) return visible;
      const matches = visible.filter(profile => `${profile.name}\n${profile.description ?? ''}`.toLocaleLowerCase().includes(query));
      const ids = new Set(matches.map(profile => profile.id));
      const profiles = [];
      for (const profile of matches) {
        const item = mapAiLaunchProfileToListItemV1(profile, { agentIds: ports.agentIds ?? [] });
        const located = locationForProfile(profile, opened.rows);
        if (located.status !== 'located') return located;
        profiles.push({ profile: item, location: located.location });
      }
      return { status: 'listed' as const, records: opened.rows.filter(row => ids.has(row.record.id)),
        profiles, complete: true as const };
    },
    save: async (input: Readonly<{ profile: AiLaunchProfile; secretBindings?: ProfileRecordV1['secretBindings']; expectedRevision?: number | 'absent'; expectedArtifactRevision?: ArtifactRevisionV1; savedSecretRevisions?: ProfileRowMutationV1['savedSecretRevisions'] }>): Promise<ProfileOperationResult> => {
      const opened = inventory();
      if (opened.status !== 'ready') return opened;
      const id = input.profile.id;
      const existing = opened.rows.find(entry => entry.record.id === id);
      if (!existing && (getBuiltInBackendProfile(id) || isHistoricalBuiltInAiLaunchProfileIdV1(id))) return invalid('duplicate-id', id);
      if (!existing && opened.profiles.some(profile => profile.id === id
        && (!input.profile.artifactId || profile.artifactId !== input.profile.artifactId))) return invalid('duplicate-id', id);
      const expected = input.expectedRevision ?? input.profile.profileRecordRevision;
      if (expected === 'absent' ? existing !== undefined : expected !== undefined && expected !== existing?.revision)
        return { status: 'conflict', id, revision: existing?.revision ?? -1 };
      if (input.profile.viewOnly && existing?.record.definition.kind === 'artifact') return invalid('read-only', id);
      const name = input.profile.name.trim();
      const existingDefinition = existing?.record.definition;
      const existingName = existingDefinition && existingDefinition.kind !== 'artifact' ? existingDefinition.profile.name.trim() : undefined;
      if ((ports.builtinNames?.includes(name) && existingName !== name)
        || opened.profiles.some(profile => profile.id !== id && profile.name.trim() === name)) return invalid('duplicate-name', id);
      const existingInlineUpdate = existing !== undefined && typeof expected === 'number';
      const inlineSchema = existingInlineUpdate ? StoredLaunchProfileV2Schema : LaunchProfileV2Schema;
      const source = isLaunchProfileV2(input.profile)
        ? createStoredReadSchema(inlineSchema).safeParse({ ...input.profile, name: existingInlineUpdate ? input.profile.name : name })
        : createStoredReadSchema(AIBackendProfileSchema).safeParse({ ...input.profile, name });
      if (!source.success) return invalid('invalid-definition', id);
      if (!existing && input.profile.artifactId) {
        const shared = opened.profiles.find(profile => profile.id === id && profile.artifactId === input.profile.artifactId);
        if (!shared) return invalid('invalid-definition', id);
        const sharedBody = isLaunchProfileV2(shared)
          ? createStoredReadSchema(LaunchProfileV2Schema).safeParse(shared)
          : createStoredReadSchema(AIBackendProfileSchema).safeParse(shared);
        if (!sharedBody.success) return invalid('invalid-definition', id);
        if (JSON.stringify(sharedBody.data) !== JSON.stringify(source.data)) return shared.viewOnly
          ? invalid('read-only', id) : { status: 'unavailable', reason: 'profile_artifact_membership_required' };
      }
      if (!isLaunchProfileV2(input.profile) && existing?.record.definition.kind !== 'legacy' && !input.profile.artifactId) return invalid('legacy-creation-unsupported', id);
      if (existing?.record.definition.kind === 'artifact') {
        const admitted = current(id, typeof expected === 'number' ? expected : undefined);
        if (admitted.status !== 'ready') return admitted;
        if (opened.profiles.find(profile => profile.id === id)?.viewOnly) return invalid('read-only', id);
        const expectedArtifactRevision = input.expectedArtifactRevision ?? input.profile.revision;
        const resource = ports.artifactsById?.().get(existing.record.definition.artifactId);
        if (!expectedArtifactRevision || !resource?.revision) return { status: 'unavailable', reason: 'profile_artifact_revision_unavailable' };
        if (expectedArtifactRevision.headerVersion !== resource.revision.headerVersion
          || expectedArtifactRevision.bodyVersion !== resource.revision.bodyVersion) return { status: 'conflict', id, revision: existing.revision };
        if (!ports.writeArtifactProfile) return { status: 'unavailable', reason: 'profile_artifact_edit_unavailable' };
        if (input.secretBindings !== undefined) {
          const proposedBindings = input.secretBindings;
          const unchanged = (bindings: Readonly<Record<string, string | null>>) =>
            Object.keys(bindings).length === Object.keys(proposedBindings).length
            && Object.entries(proposedBindings).every(([key, value]) => Object.hasOwn(bindings, key) && bindings[key] === value);
          const effective = opened.profiles.find(profile => profile.id === id)?.secretBindings;
          if (!unchanged(existing.record.secretBindings) && (!effective || !unchanged(effective))) {
            return { status: 'unavailable', reason: 'profile_artifact_binding_edit_unavailable' };
          }
        }
        return ports.writeArtifactProfile({ profile: input.profile, record: existing.record, expectedRevision: existing.revision, expectedArtifactRevision });
      }
      const artifactId = !existing ? input.profile.artifactId : undefined;
      if (artifactId && !opened.profiles.some(profile => profile.id === id && profile.artifactId === artifactId)) return invalid('invalid-definition', id);
      const definition = artifactId ? { kind: 'artifact' as const, artifactId }
        : isLaunchProfileV2(input.profile)
        ? { kind: 'inline' as const, profile: inlineSchema.parse(source.data) }
        : { kind: 'legacy' as const, profile: AIBackendProfileSchema.parse(source.data) };
      const record = ProfileRecordV1Schema.parse({ v: 1, id, definition,
        enabled: existing?.record.enabled ?? input.profile.enabled ?? true,
        promptStack: existing?.record.promptStack ?? input.profile.promptStack ?? [],
        secretBindings: input.secretBindings ?? existing?.record.secretBindings ?? input.profile.secretBindings ?? {} });
      if (existing && hasChangedReadonlyProfileDefinitionV1(existing.record, record)) return invalid('read-only', id);
      return ports.writeRecord({ record, expectedRevision: existing?.revision ?? 'absent', operation: existing ? 'update' : 'create',
        ...(input.savedSecretRevisions ? { savedSecretRevisions: input.savedSecretRevisions } : {}) });
    },
    duplicate: async (input: Readonly<{ id: string; expectedRevision: number; newProfileId: string; name: string; now: number }>): Promise<ProfileOperationResult> => {
      const opened = inventory();
      if (opened.status !== 'ready') return opened;
      const admitted = current(input.id, input.expectedRevision);
      if (admitted.status !== 'ready') return admitted;
      const source = opened.profiles.find(profile => profile.id === input.id);
      if (!source || !isLaunchProfileV2(source)) return invalid('legacy-creation-unsupported', input.id);
      if (getBuiltInBackendProfile(input.newProfileId) || isHistoricalBuiltInAiLaunchProfileIdV1(input.newProfileId)
        || opened.profiles.some(profile => profile.id === input.newProfileId)) return invalid('duplicate-id', input.newProfileId);
      const name = input.name.trim();
      if (ports.builtinNames?.includes(name) || opened.profiles.some(profile => profile.name.trim() === name)) return invalid('duplicate-name', input.newProfileId);
      const draft = createProfileDuplicateDraftV1({ profile: source, sourceRow: admitted.row,
        newProfileId: input.newProfileId, name, now: input.now });
      if (draft.status !== 'draft') return draft;
      const profile = createStoredReadSchema(LaunchProfileV2Schema).parse(draft.profile);
      const record = ProfileRecordV1Schema.parse({ ...admitted.row.record, id: input.newProfileId,
        definition: { kind: 'inline', profile }, secretBindings: draft.secretBindings });
      return ports.writeRecord({ record, expectedRevision: 'absent', operation: 'create' });
    },
    setEnabled: async (input: Readonly<{ id: string; enabled: boolean; expectedRevision?: number }> | ProfileBuiltinEnabledInputV1): Promise<ProfileOperationResult | ProfileBuiltinEnabledResultV1> => {
      if ('subject' in input) {
        if (!isHistoricalBuiltInAiLaunchProfileIdV1(input.subject.id)) return invalid('invalid-definition', input.subject.id);
        const opened = rowInventory();
        if (opened.status !== 'ready') return opened;
        if (opened.rows.some(row => row.record.id === input.subject.id)) {
          return { status: 'unavailable', reason: 'builtin_preference_requires_absent_row' };
        }
        return ports.setBuiltinEnabled ? ports.setBuiltinEnabled(input) : { status: 'unavailable', reason: 'builtin_preference_unavailable' };
      }
      const admitted = current(input.id, input.expectedRevision);
      if (admitted.status === 'invalid' && admitted.reason === 'profile-not-found') {
        const opened = inventory();
        if (opened.status !== 'ready') return opened;
        const source = opened.profiles.find(profile => profile.id === input.id);
        if (!source && getBuiltInBackendProfile(input.id)) return { status: 'unavailable', reason: 'builtin_preference_revision_required' };
      } else if (admitted.status !== 'ready') return admitted;
      return update(input, record => ({ ...record, enabled: input.enabled }));
    },
    setSecretBindings: (input: Readonly<{ id: string; expectedRevision?: number | 'absent'; savedSecretRevisions?: ProfileRowMutationV1['savedSecretRevisions'] }>
      & (Readonly<{ secretBindings: ProfileRecordV1['secretBindings']; privateOverrides?: never }>
        | Readonly<{ privateOverrides: ProfileRecordV1['secretBindings']; secretBindings?: never }>)) =>
      update(input, record => ({ ...record, secretBindings: 'privateOverrides' in input
        ? { ...record.secretBindings, ...input.privateOverrides } : { ...input.secretBindings } })),
    setPromptStack: (input: Readonly<{ id: string; promptStack: ProfileRecordV1['promptStack']; expectedRevision?: number | 'absent' }>) =>
      update(input, record => ({ ...record, promptStack: [...input.promptStack] })),
    selectSecret: (input: Readonly<{ id: string; expectedRevision: number | 'absent'; envName: string;
      selection: Readonly<{ kind: 'none' }> | Readonly<{ kind: 'resource'; resourceId: string; expectedResourceRevision: number }> }>) => {
      const savedSecretRevisions = input.selection.kind === 'resource'
        ? [{ resourceId: input.selection.resourceId, expectedRevision: input.selection.expectedResourceRevision }] : [];
      return update({ id: input.id, expectedRevision: input.expectedRevision, savedSecretRevisions }, record => ({ ...record,
        secretBindings: applyProfileSecretBindingSelectionV1(record.secretBindings, input.envName,
          input.selection.kind === 'none' ? input.selection : { kind: 'reference', reference: formatSharedSavedSecretRefV1(input.selection.resourceId) }),
      }));
    },
    remove: async (input: Readonly<{ id: string; expectedRevision?: number }>): Promise<ProfileRemovalResult> => {
      const admitted = current(input.id, input.expectedRevision);
      if (admitted.status !== 'ready') return admitted;
      const receipt = await ports.deleteRecord({ id: input.id, expectedRevision: admitted.row.revision, previousDefinition: admitted.row.record.definition });
      if (receipt.status !== 'updated') return receipt;
      try {
        if (!ports.clearRememberedProfile) throw new Error('authoring_memory_cleanup_unavailable');
        await ports.clearRememberedProfile({ id: input.id });
        return receipt;
      } catch {
        return { ...receipt, authoringMemoryCleanup: { status: 'unavailable', reason: 'authoring_memory_cleanup_failed' } };
      }
    },
  };
}
export type ProfileOperations = ReturnType<typeof createProfileOperations>;
