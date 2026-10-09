import { describe, expect, it } from 'vitest';
import { createProfileDuplicateDraftV1, createProfileOperations, setBuiltinProfileEnabledPreferenceV1, setProfileFavoritePreferenceV1, type ProfileOperationsPorts } from './profileOperations.js';
import { ProfileRecordV1Schema, openProfileRecordContentV1, type ProfileRecordV1 } from './profileRecordV1.js';
import type { ProfileCatalogSnapshotV1 } from './profileCatalogV1.js';
import { EnvironmentVariableSchema, EnvVarRequirementSchema } from './environmentVariables.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { getBuiltInBackendProfile } from './builtInBackendProfiles.js';
import { AIBackendProfileSchema } from './backendProfileSchema.js';
import { isLaunchProfileV2, readAiLaunchProfileRecords } from './read.js';
import { listAccountSettingsSavedSecretReferences } from '../account/settings/savedSecretMutationOwner.js';

const profile = { v: 2 as const, id: 'a', name: 'Alpha', createdAt: 1, updatedAt: 1,
  extraEnvironmentVariables: [], defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {} };
const row = ProfileRecordV1Schema.parse({ v: 1, id: 'a', enabled: false, secretBindings: { TOKEN: 'secret-a' },
  promptStack: [{ id: 'stack', ref: { kind: 'doc', artifactId: 'doc-a' }, enabled: true, placement: 'system_append' }],
  definition: { kind: 'inline', profile } });
const activeAuthority = { source: 'destination' as const, authority: 'active' as const, controlRevision: 1, control: { revision: 1,
  record: { v: 1 as const, phase: 'active' as const, sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory: [] } } };

describe('Profile semantic operations', () => {
  it('sets favorite intent without toggling twice or erasing the default environment marker and neighboring preferences', () => {
    const raw = { favoriteProfiles: ['', 'kept', 'kept'], profileEnabledById: { kept: false }, futurePreference: { keep: true } };
    const next = setProfileFavoritePreferenceV1(raw, 'private', true);
    expect(next).toEqual({ ...raw, favoriteProfiles: ['private', '', 'kept'] });
    expect(setProfileFavoritePreferenceV1(next, 'private', true)).toEqual(next);
    expect(setProfileFavoritePreferenceV1(next, '', false)).toEqual({ ...raw, favoriteProfiles: ['private', 'kept'] });
  });
  it('preserves exact retained Profile favorite identities and neighboring entries beyond new authoring limits', () => {
    const retainedId = `legacy-${'x'.repeat(2048)}`;
    const raw = { favoriteProfiles: [retainedId, '', 'kept'], futurePreference: { keep: true } };
    expect(setProfileFavoritePreferenceV1(raw, 'new', true))
      .toEqual({ ...raw, favoriteProfiles: ['new', retainedId, '', 'kept'] });
    expect(setProfileFavoritePreferenceV1(raw, 'kept', false))
      .toEqual({ ...raw, favoriteProfiles: [retainedId, ''] });
  });
  it('writes builtin enablement sparsely while retaining compatible opaque preference entries', () => {
    const raw = { profileEnabledById: { 'azure-openai': false, kept: false, futureEntry: { keep: true } }, futurePreference: true };
    expect(setBuiltinProfileEnabledPreferenceV1(raw, 'azure-openai', true)).toEqual({
      ...raw, profileEnabledById: { kept: false, futureEntry: { keep: true } } });
    expect(() => setBuiltinProfileEnabledPreferenceV1({ profileEnabledById: [] }, 'azure-openai', false))
      .toThrowError('profile_enablement_invalid');
  });
  it('refuses populated staged rows before the destination control activates', async () => {
    let writes = 0;
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, source: 'legacy', authority: 'inactive',
      control: null, controlRevision: 'absent', status: 'ready', records: [{ record: row, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      writeRecord: async input => { writes++; return { status: 'updated', id: input.record.id, revision: 5 }; },
      deleteRecord: async input => { writes++; return { status: 'updated', id: input.id, revision: 5 }; } });
    expect(owner.read({ id: 'a' })).toMatchObject({ status: 'unavailable' });
    expect(owner.search()).toMatchObject({ status: 'unavailable' });
    expect(await owner.setEnabled({ id: 'a', enabled: true })).toMatchObject({ status: 'unavailable' });
    expect(await owner.remove({ id: 'a' })).toMatchObject({ status: 'unavailable' });
    expect(writes).toBe(0);
  });
  it('uses the admitted destination of a fresh Account without fabricating an active transfer control', async () => {
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, authority: 'inactive',
      control: null, controlRevision: 'absent', status: 'ready', records: [{ record: row, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      writeRecord: async input => ({ status: 'updated', id: input.record.id, revision: 5 }),
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }) });
    expect(owner.read({ id: 'a' })).toMatchObject({ status: 'present', revision: 4, record: row,
      profile: { ...profile, enabled: false, secretBindings: row.secretBindings, promptStack: row.promptStack }, location: { kind: 'account_row', revision: 4 } });
    expect(await owner.setEnabled({ id: 'a', enabled: true })).toMatchObject({ status: 'updated', revision: 5 });
  });
  it('changes builtin entity enablement through its row revision and refuses the stale preference path', async () => {
    const builtin = ProfileRecordV1Schema.parse({ ...row, id: 'azure-openai',
      definition: { kind: 'legacy', profile: getBuiltInBackendProfile('azure-openai') } });
    let rowWrites = 0;
    let captured: unknown;
    let preference: unknown;
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: builtin, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      readEnabledPreferences: () => ({ 'azure-openai': true }),
      writeRecord: async input => { rowWrites++; captured = input; return { status: 'updated', id: input.record.id, revision: 5 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }),
      setBuiltinEnabled: async input => { preference = input; return { status: 'preference-updated', id: input.subject.id, enabled: input.enabled, settingsVersion: 8 }; } });
    expect(owner.validateSelection({ id: 'azure-openai' })).toMatchObject({ status: 'unavailable', reason: 'profile_disabled' });
    expect(await owner.setEnabled({ id: 'azure-openai', enabled: true, expectedRevision: 4 }))
      .toEqual({ status: 'updated', id: 'azure-openai', revision: 5 });
    expect(await owner.setEnabled({ subject: { kind: 'builtin', id: 'azure-openai' }, enabled: true, expectedSettingsVersion: 7 }))
      .toMatchObject({ status: 'unavailable' });
    expect(preference).toBeUndefined();
    expect(rowWrites).toBe(1);
    expect(captured).toMatchObject({ operation: 'update', expectedRevision: 4,
      record: { definition: builtin.definition, enabled: true, promptStack: builtin.promptStack, secretBindings: builtin.secretBindings } });
    const noEntityOwner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 'absent' }),
      writeRecord: async input => { rowWrites++; return { status: 'updated', id: input.record.id, revision: 1 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 1 }),
      setBuiltinEnabled: async input => { preference = input; return { status: 'preference-updated', id: input.subject.id, enabled: input.enabled, settingsVersion: 8 }; } });
    expect(await noEntityOwner.setEnabled({ subject: { kind: 'builtin', id: 'azure-openai' }, enabled: true, expectedSettingsVersion: 7 }))
      .toEqual({ status: 'preference-updated', id: 'azure-openai', enabled: true, settingsVersion: 8 });
    expect(rowWrites).toBe(1);
    expect(preference).toMatchObject({ expectedSettingsVersion: 7, enabled: true });
  });
  it('changes enabled state on admitted inline and Artifact membership rows even when their retained identities were builtins', async () => {
    const converted = ProfileRecordV1Schema.parse({ ...row, id: 'azure-openai',
      definition: { kind: 'inline', profile: { ...profile, id: 'azure-openai' } } });
    const artifactMembership = ProfileRecordV1Schema.parse({ ...row, id: 'gemini-api-key',
      definition: { kind: 'artifact', artifactId: 'granted-builtin-body' } });
    let captured: unknown;
    let preferenceWrites = 0;
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: converted, revision: 4 }, { record: artifactMembership, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      writeRecord: async input => { captured = input; return { status: 'updated', id: input.record.id, revision: 5 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }),
      setBuiltinEnabled: async input => { preferenceWrites++; return { status: 'preference-updated', id: input.subject.id, enabled: input.enabled, settingsVersion: 8 }; } });
    expect(await owner.setEnabled({ id: converted.id, enabled: true, expectedRevision: 4 }))
      .toEqual({ status: 'updated', id: converted.id, revision: 5 });
    expect(captured).toMatchObject({ operation: 'update', expectedRevision: 4,
      record: { definition: converted.definition, enabled: true, promptStack: converted.promptStack, secretBindings: converted.secretBindings } });
    expect(await owner.setEnabled({ id: artifactMembership.id, enabled: true, expectedRevision: 4 }))
      .toEqual({ status: 'updated', id: artifactMembership.id, revision: 5 });
    expect(captured).toMatchObject({ operation: 'update', expectedRevision: 4,
      record: { definition: artifactMembership.definition, enabled: true, promptStack: artifactMembership.promptStack, secretBindings: artifactMembership.secretBindings } });
    expect(preferenceWrites).toBe(0);
  });
  it('validates the actual visible builtin choice and preference without inventing membership, while null needs no catalog', () => {
    let enabled = false;
    let catalogReads = 0;
    const builtin = getBuiltInBackendProfile('azure-openai');
    if (!builtin) throw new Error('canonical_builtin_missing');
    const owner = createProfileOperations({ readCatalog: () => { catalogReads++; return { ...activeAuthority, status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 'absent' }; },
      readVisibleProfiles: () => [builtin], readEnabledPreferences: () => ({ 'azure-openai': enabled }),
      writeRecord: async input => ({ status: 'updated', id: input.record.id, revision: 1 }),
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 1 }) });
    expect(owner.validateSelection({ id: null })).toEqual({ status: 'selected', id: null });
    expect(catalogReads).toBe(0);
    expect(owner.validateSelection({ id: 'azure-openai' })).toMatchObject({ status: 'unavailable', reason: 'profile_disabled' });
    enabled = true;
    expect(owner.validateSelection({ id: 'azure-openai' })).toEqual({ status: 'selected', id: 'azure-openai' });
    const visible = owner.read({ id: 'azure-openai' });
    expect(visible).toMatchObject({ status: 'present', profile: builtin, location: { kind: 'builtin' } });
    expect(visible).not.toHaveProperty('record');
    expect(visible).not.toHaveProperty('revision');
  });
  it('searches the same actual visible builtin projection without a private row revision', () => {
    const builtin = getBuiltInBackendProfile('azure-openai');
    if (!builtin) throw new Error('canonical_builtin_missing');
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 'absent' }),
      readVisibleProfiles: () => [builtin], agentIds: ['codex'],
      writeRecord: async input => ({ status: 'updated', id: input.record.id, revision: 1 }),
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 1 }) });
    expect(owner.search({ query: 'Azure' })).toMatchObject({ status: 'listed', records: [], complete: true,
      profiles: [{ profile: { id: 'azure-openai', name: 'Azure OpenAI', isBuiltIn: true }, location: { kind: 'builtin' } }] });
  });
  it('refuses selection and search when the captured visible inventory evidence is unavailable', () => {
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 'absent' }),
      readVisibleProfiles: () => ({ status: 'unavailable' as const, reason: 'profile_selection_memory_unavailable' }),
      writeRecord: async input => ({ status: 'updated', id: input.record.id, revision: 1 }),
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 1 }) });
    expect(owner.validateSelection({ id: 'azure-openai' }))
      .toEqual({ status: 'unavailable', reason: 'profile_selection_memory_unavailable' });
    expect(owner.search({ query: 'Azure' }))
      .toEqual({ status: 'unavailable', reason: 'profile_selection_memory_unavailable' });
    expect(owner.validateSelection({ id: null })).toEqual({ status: 'selected', id: null });
  });
  it('refuses an ordinary new definition using the immutable builtin identity', async () => {
    let writes = 0;
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 'absent' }),
      writeRecord: async input => { writes++; return { status: 'updated', id: input.record.id, revision: 1 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 1 }) });
    expect(await owner.save({ profile: { ...profile, id: 'azure-openai', name: 'Custom routing' }, expectedRevision: 'absent' }))
      .toMatchObject({ status: 'invalid', reason: 'duplicate-id' });
    expect(writes).toBe(0);
  });
  it('attaches builtin private bindings through the explicit absent-row transaction rather than legacy create or import', async () => {
    let captured: unknown;
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 'absent' }),
      readEnabledPreferences: () => ({ 'azure-openai': false }),
      writeRecord: async input => { captured = input; return { status: 'updated', id: input.record.id, revision: 1 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 1 }) });
    expect(await owner.setSecretBindings({ id: 'azure-openai', expectedRevision: 'absent',
      secretBindings: { TOKEN: 'happier:shared-secret:v1:secret-a' }, savedSecretRevisions: [{ resourceId: 'secret-a', expectedRevision: 7 }] }))
      .toEqual({ status: 'updated', id: 'azure-openai', revision: 1 });
    expect(captured).toMatchObject({ operation: 'attach-builtin', expectedRevision: 'absent', record: { id: 'azure-openai',
      definition: { kind: 'legacy', profile: AIBackendProfileSchema.parse(getBuiltInBackendProfile('azure-openai')) }, enabled: false, promptStack: [],
      secretBindings: { TOKEN: 'happier:shared-secret:v1:secret-a' } }, savedSecretRevisions: [{ resourceId: 'secret-a', expectedRevision: 7 }] });
  });
  it('keeps the current builtin definition immutable while its private attachment remains writable', async () => {
    const preset = getBuiltInBackendProfile('azure-openai');
    if (!preset) throw new Error('canonical_builtin_missing');
    const attachment = ProfileRecordV1Schema.parse({ ...row, id: preset.id, definition: { kind: 'legacy', profile: preset } });
    let captured: unknown;
    let writes = 0;
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: attachment, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      builtinNames: [preset.name],
      writeRecord: async input => { writes++; captured = input; return { status: 'updated', id: input.record.id, revision: 5 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }) });
    expect(await owner.save({ profile: { ...profile, id: preset.id, name: 'Replaced' }, expectedRevision: 4 }))
      .toMatchObject({ status: 'invalid', reason: 'read-only' });
    expect(await owner.save({ profile: { ...preset, name: 'Renamed' }, expectedRevision: 4 }))
      .toMatchObject({ status: 'invalid', reason: 'read-only' });
    expect(writes).toBe(0);
    expect(await owner.setSecretBindings({ id: preset.id, expectedRevision: 4, secretBindings: { TOKEN: 'secret-next' } }))
      .toMatchObject({ status: 'updated' });
    expect(captured).toMatchObject({ record: { definition: attachment.definition, secretBindings: { TOKEN: 'secret-next' } } });
    expect(await owner.save({ profile: preset, expectedRevision: 4, secretBindings: { TOKEN: 'secret-next' } }))
      .toEqual({ status: 'updated', id: preset.id, revision: 5 });
  });
  it('keeps a retained readonly blueprint immutable while saving unchanged definition with private bindings', async () => {
    const preset = getBuiltInBackendProfile('azure-openai');
    if (!preset) throw new Error('canonical_builtin_missing');
    const retained = ProfileRecordV1Schema.parse({ ...row, id: 'retired-blueprint',
      definition: { kind: 'legacy', profile: { ...preset, id: 'retired-blueprint' } } });
    if (retained.definition.kind !== 'legacy') throw new Error('legacy_fixture_required');
    const profile = retained.definition.profile;
    let captured: unknown;
    let writes = 0;
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready',
      records: [{ record: retained, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      writeRecord: async input => { writes++; captured = input; return { status: 'updated', id: input.record.id, revision: 5 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }) });
    expect(await owner.save({ profile: { ...profile, name: 'Replaced blueprint' }, expectedRevision: 4 }))
      .toMatchObject({ status: 'invalid', reason: 'read-only' });
    expect(writes).toBe(0);
    expect(await owner.save({ profile, expectedRevision: 4, secretBindings: { TOKEN: 'secret-next' } }))
      .toEqual({ status: 'updated', id: profile.id, revision: 5 });
    expect(captured).toMatchObject({ expectedRevision: 4, operation: 'update', record: {
      definition: retained.definition, enabled: retained.enabled, promptStack: retained.promptStack,
      secretBindings: { TOKEN: 'secret-next' } } });
    expect(writes).toBe(1);
  });
  it('preserves the durable deletion receipt when secondary memory cleanup fails and never clears after a failed row deletion', async () => {
    let deleted = false;
    let cleanupAttempts = 0;
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: row, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      writeRecord: async input => ({ status: 'updated', id: input.record.id, revision: 5 }),
      deleteRecord: async input => { expect(input).toMatchObject({ id: row.id, expectedRevision: 4, previousDefinition: row.definition });
        deleted = true; return { status: 'updated', id: input.id, revision: 5 }; },
      clearRememberedProfile: async () => { expect(deleted).toBe(true); cleanupAttempts++; throw new Error('private memory transport details'); } });
    expect(await owner.remove({ id: 'a', expectedRevision: 4 })).toEqual({ status: 'updated', id: 'a', revision: 5,
      authoringMemoryCleanup: { status: 'unavailable', reason: 'authoring_memory_cleanup_failed' } });
    expect(cleanupAttempts).toBe(1);
    const conflicted = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: row, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      writeRecord: async input => ({ status: 'updated', id: input.record.id, revision: 5 }),
      deleteRecord: async input => ({ status: 'conflict', id: input.id, revision: 6 }),
      clearRememberedProfile: async () => { cleanupAttempts++; } });
    expect(await conflicted.remove({ id: 'a', expectedRevision: 4 })).toEqual({ status: 'conflict', id: 'a', revision: 6 });
    expect(cleanupAttempts).toBe(1);
  });
  it('clears only the addressed remembered choice after deleting a builtin private attachment even when its preset remains discoverable', async () => {
    const attachment = ProfileRecordV1Schema.parse({ ...row, id: 'azure-openai', definition: { kind: 'legacy', profile: getBuiltInBackendProfile('azure-openai') } });
    let remembered = 'azure-openai';
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: attachment, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      writeRecord: async input => ({ status: 'updated', id: input.record.id, revision: 5 }),
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }),
      clearRememberedProfile: async (input: Readonly<{ id: string }>) => { if (remembered === input.id) remembered = ''; } });
    expect(await owner.remove({ id: remembered, expectedRevision: 4 })).toEqual({ status: 'updated', id: 'azure-openai', revision: 5 });
    expect(remembered).toBe('');
  });
  it('closes environment mutation ingress while retaining additive stored Profile reads', () => {
    const variable = { name: 'TOKEN', value: 'literal', futureAuthority: true };
    const requirement = { name: 'TOKEN', kind: 'secret', required: true, futureAuthority: true };
    expect(EnvironmentVariableSchema.safeParse(variable).success).toBe(false);
    expect(EnvVarRequirementSchema.safeParse(requirement).success).toBe(false);
    expect(createStoredReadSchema(EnvironmentVariableSchema).parse(variable)).toEqual({ name: 'TOKEN', value: 'literal' });
    expect(createStoredReadSchema(EnvVarRequirementSchema).parse(requirement)).toEqual({ name: 'TOKEN', kind: 'secret', required: true });
  });
  it('does not reinterpret a future version marker inside a retained legacy definition', () => {
    const future = { ...row, id: 'azure-openai', definition: { kind: 'legacy',
      profile: { ...getBuiltInBackendProfile('azure-openai'), v: 3 } } };
    expect(ProfileRecordV1Schema.safeParse(future).success).toBe(false);
    expect(openProfileRecordContentV1({ mode: 'plain', material: null, expectedId: 'azure-openai',
      content: { t: 'plain', v: future } })).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
  });

  it('selects a Resource through its canonical binding namespace rather than a colliding personal id', async () => {
    let captured: ProfileRecordV1 | undefined;
    const owner = createProfileOperations({
      readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: row, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      writeRecord: async input => { captured = input.record; return { status: 'updated', id: input.record.id, revision: 5 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }) });
    await owner.selectSecret({ id: 'a', expectedRevision: 4, envName: 'TOKEN',
      selection: { kind: 'resource', resourceId: 'secret-a', expectedResourceRevision: 7 } });
    expect(captured?.secretBindings.TOKEN).toBe('happier:shared-secret:v1:secret-a');
  });
  it('selects none without restoring an inherited Artifact secret or counting it as a current Profile dependency', async () => {
    const inheritedRef = 'happier:shared-secret:v1:secret-default';
    const neighborRef = 'happier:shared-secret:v1:secret-neighbor';
    const keptRef = 'happier:shared-secret:v1:secret-kept';
    let record = ProfileRecordV1Schema.parse({ ...row, definition: { kind: 'artifact', artifactId: 'published-a' },
      secretBindings: { KEEP: keptRef } });
    const artifact = { artifactId: 'published-a', header: { kind: 'launch-profile.v1', profileId: profile.id, name: profile.name },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile, secretBindings: { TOKEN: inheritedRef, NEIGHBOR: neighborRef } }),
      access: 'edit' as const, revision: { headerVersion: 2, bodyVersion: 3 } };
    const artifactsById = new Map([[artifact.artifactId, artifact]]);
    const owner = createProfileOperations({
      readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      artifactsById: () => artifactsById,
      writeRecord: async input => { record = ProfileRecordV1Schema.parse(input.record); return { status: 'updated', id: record.id, revision: 5 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }) });
    expect(await owner.selectSecret({ id: record.id, expectedRevision: 4, envName: 'TOKEN', selection: { kind: 'none' } }))
      .toEqual({ status: 'updated', id: record.id, revision: 5 });
    const opened = readAiLaunchProfileRecords([record], { artifactsById });
    expect(opened.diagnostics).toEqual([]);
    const selected = opened.entries[0];
    if (!selected || selected.kind === 'opaque') throw new Error('profile_definition_unavailable');
    expect(selected.profile.secretBindings).not.toHaveProperty('TOKEN');
    expect(selected.profile.secretBindings).toEqual({ NEIGHBOR: neighborRef, KEEP: keptRef });
    const catalogs = { profileRecords: [record], artifactsById };
    expect(listAccountSettingsSavedSecretReferences({}, inheritedRef, catalogs)).toEqual([]);
    expect(listAccountSettingsSavedSecretReferences({}, neighborRef, catalogs)).toHaveLength(1);
    expect(listAccountSettingsSavedSecretReferences({}, keptRef, catalogs)).toHaveLength(1);
    expect(record.secretBindings).toEqual({ KEEP: keptRef, TOKEN: null });
  });
  it('carries the captured SavedSecret resource revision into the same Profile transaction', async () => {
    let captured: unknown;
    const owner = createProfileOperations({
      readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: row, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      writeRecord: async input => { captured = input; return { status: 'updated', id: input.record.id, revision: 5 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }) });
    await owner.setSecretBindings({ id: 'a', expectedRevision: 4, secretBindings: { TOKEN: 'secret-next' },
      savedSecretRevisions: [{ resourceId: 'secret-next', expectedRevision: 7 }] });
    expect(captured).toMatchObject({ expectedRevision: 4, record: { secretBindings: { TOKEN: 'secret-next' } },
      savedSecretRevisions: [{ resourceId: 'secret-next', expectedRevision: 7 }] });
  });
  it('applies a vector binding delta in one row CAS without losing private none masks or inheriting removed Artifact defaults', async () => {
    const maskedRef = 'happier:shared-secret:v1:secret-masked';
    const tokenRef = 'happier:shared-secret:v1:secret-token';
    const neighborRef = 'happier:shared-secret:v1:secret-neighbor';
    const keptRef = 'happier:shared-secret:v1:secret-kept';
    const selectedRef = 'happier:shared-secret:v1:secret-selected';
    let record = ProfileRecordV1Schema.parse({ ...row, definition: { kind: 'artifact', artifactId: 'published-a' },
      secretBindings: { MASKED: null, KEEP: keptRef } });
    const artifact = { artifactId: 'published-a', header: { kind: 'launch-profile.v1', profileId: profile.id, name: profile.name },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile,
        secretBindings: { MASKED: maskedRef, TOKEN: tokenRef, NEIGHBOR: neighborRef } }),
      access: 'edit' as const, revision: { headerVersion: 2, bodyVersion: 3 } };
    const artifactsById = new Map([[artifact.artifactId, artifact]]);
    let writes = 0;
    const owner = createProfileOperations({
      readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      artifactsById: () => artifactsById,
      writeRecord: async input => {
        expect(input).toMatchObject({ expectedRevision: 4,
          savedSecretRevisions: [{ resourceId: 'secret-selected', expectedRevision: 7 }] });
        writes++; record = ProfileRecordV1Schema.parse(input.record);
        return { status: 'updated', id: record.id, revision: 5 };
      },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }) });
    const result = await owner.setSecretBindings({ id: record.id, expectedRevision: 4, privateOverrides: { TOKEN: null, EXTRA: selectedRef },
      savedSecretRevisions: [{ resourceId: 'secret-selected', expectedRevision: 7 }] });
    expect(result).toEqual({ status: 'updated', id: record.id, revision: 5 });
    expect(writes).toBe(1);
    expect(record.secretBindings).toEqual({ MASKED: null, KEEP: keptRef, TOKEN: null, EXTRA: selectedRef });
    const opened = readAiLaunchProfileRecords([record], { artifactsById }).entries[0];
    if (!opened || opened.kind === 'opaque') throw new Error('profile_definition_unavailable');
    expect(opened.profile.secretBindings).toEqual({ NEIGHBOR: neighborRef, KEEP: keptRef, EXTRA: selectedRef });
    const catalogs = { profileRecords: [record], artifactsById };
    expect(listAccountSettingsSavedSecretReferences({}, maskedRef, catalogs)).toEqual([]);
    expect(listAccountSettingsSavedSecretReferences({}, tokenRef, catalogs)).toEqual([]);
    expect(listAccountSettingsSavedSecretReferences({}, neighborRef, catalogs)).toHaveLength(1);
  });
  it('updates the Profile prompt stack in its row CAS without replacing its definition or private bindings', async () => {
    let captured: unknown;
    const owner = createProfileOperations({
      readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: row, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      writeRecord: async input => { captured = input; return { status: 'updated', id: input.record.id, revision: 5 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }) });
    const stack = [{ ...row.promptStack[0], enabled: false }];
    expect(await owner.updatePromptStack({ id: 'a', expectedRevision: 4,
      intent: { kind: 'set_enabled', entryId: row.promptStack[0]!.id, enabled: false } }))
      .toEqual({ status: 'updated', id: 'a', revision: 5 });
    expect(captured).toMatchObject({ expectedRevision: 4, record: { definition: row.definition,
      enabled: row.enabled, secretBindings: row.secretBindings, promptStack: stack } });
  });
  it('saves an editor binding and its captured Resource revision in one definition CAS', async () => {
    let captured: unknown;
    const owner = createProfileOperations({
      readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: row, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      writeRecord: async input => { captured = input; return { status: 'updated', id: input.record.id, revision: 5 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }) });
    await owner.save({ profile: { ...profile, name: 'Edited' }, expectedRevision: 4,
      secretBindings: { TOKEN: 'happier:shared-secret:v1:secret-next' },
      savedSecretRevisions: [{ resourceId: 'secret-next', expectedRevision: 7 }] });
    expect(captured).toMatchObject({ expectedRevision: 4, record: { definition: { profile: { name: 'Edited' } },
      secretBindings: { TOKEN: 'happier:shared-secret:v1:secret-next' } },
      savedSecretRevisions: [{ resourceId: 'secret-next', expectedRevision: 7 }] });
  });
  it('saves a detached current Profile draft with its copied private attachments instead of replacing them with defaults', async () => {
    let captured: unknown;
    const copy = { ...profile, id: 'copy', name: 'Alpha copy', enabled: row.enabled,
      promptStack: row.promptStack, secretBindings: row.secretBindings };
    const owner = createProfileOperations({
      readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: row, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      writeRecord: async input => { captured = input; return { status: 'updated', id: input.record.id, revision: 1 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }) });
    expect(await owner.save({ profile: copy, expectedRevision: 'absent' }))
      .toEqual({ status: 'updated', id: copy.id, revision: 1 });
    expect(captured).toMatchObject({ expectedRevision: 'absent', operation: 'create', record: { id: copy.id,
      enabled: row.enabled, promptStack: row.promptStack, secretBindings: row.secretBindings,
      definition: { kind: 'inline', profile: { id: copy.id, name: copy.name } } } });
  });
  it('updates an admitted retained inline identity at its captured revision but never creates that identity through absent new authoring', async () => {
    const id = ` retained-${'identity'.repeat(180)} `;
    const retainedEnvironment = Array.from({ length: 257 }, (_, index) => ({ name: `RETAINED_${index}`, value: `value-${index}` }));
    const retained = ProfileRecordV1Schema.parse({ ...row, id, secretBindings: { ...row.secretBindings, MASKED: null },
      definition: { kind: 'inline', profile: { ...profile, id, name: ' Retained ', extraEnvironmentVariables: retainedEnvironment } } });
    let captured: unknown;
    let writes = 0;
    const owner = createProfileOperations({
      readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: retained, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      writeRecord: async input => { writes++; captured = input; return { status: 'updated', id: input.record.id, revision: 5 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }) });
    const current = owner.read({ id });
    expect(current).toMatchObject({ status: 'present', profile: { id, name: ' Retained ' }, revision: 4 });
    if (current.status !== 'present') throw new Error('retained_profile_unavailable');
    expect(await owner.save({ profile: { ...current.profile, name: 'Edited retained', updatedAt: 10 }, expectedRevision: 4 }))
      .toEqual({ status: 'updated', id, revision: 5 });
    expect(captured).toMatchObject({ operation: 'update', expectedRevision: 4, record: {
      id, enabled: retained.enabled, promptStack: retained.promptStack, secretBindings: retained.secretBindings,
      definition: { kind: 'inline', profile: { id, name: 'Edited retained', updatedAt: 10, extraEnvironmentVariables: retainedEnvironment } } } });
    const empty = createProfileOperations({
      readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 'absent' }),
      writeRecord: async input => { writes++; return { status: 'updated', id: input.record.id, revision: 1 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 1 }) });
    expect(await empty.save({ profile: current.profile, expectedRevision: 'absent' }))
      .toMatchObject({ status: 'invalid', reason: 'invalid-definition' });
    expect(writes).toBe(1);
  });
  it('detaches an Artifact draft while preserving effective authentication and its paired private none masks separately', () => {
    const visibleRef = 'happier:shared-secret:v1:secret-visible';
    const hiddenRef = 'happier:shared-secret:v1:secret-hidden';
    const keptRef = 'happier:shared-secret:v1:secret-kept';
    const record = ProfileRecordV1Schema.parse({ ...row, definition: { kind: 'artifact', artifactId: 'published-a' },
      secretBindings: { MASKED: null, KEEP: keptRef } });
    const artifact = { artifactId: 'published-a', header: { kind: 'launch-profile.v1', profileId: profile.id, name: profile.name },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile, secretBindings: { TOKEN: visibleRef, MASKED: hiddenRef } }),
      access: 'view' as const, revision: { headerVersion: 2, bodyVersion: 3 } };
    const source = readAiLaunchProfileRecords([record], { artifactsById: new Map([[artifact.artifactId, artifact]]),
      recordRevisionsById: new Map([[record.id, 4]]) }).entries[0];
    if (!source || source.kind === 'opaque') throw new Error('profile_definition_unavailable');
    const draft = createProfileDuplicateDraftV1({ profile: source.profile, sourceRow: { record, revision: 4 },
      newProfileId: 'copy', name: 'Alpha copy', now: 10 });
    expect(draft).toMatchObject({ status: 'draft', profile: { id: 'copy', enabled: record.enabled,
      promptStack: record.promptStack, secretBindings: { TOKEN: visibleRef, KEEP: keptRef } },
      secretBindings: { TOKEN: visibleRef, KEEP: keptRef, MASKED: null } });
    if (draft.status !== 'draft') throw new Error('profile_draft_unavailable');
    for (const key of ['artifactId', 'viewOnly', 'shared', 'revision', 'profileRecordRevision']) {
      expect(draft.profile).not.toHaveProperty(key);
    }
  });
  it('duplicates only a captured unrepresentable MachineLogin definition losslessly with source revision admission', async () => {
    const legacy = AIBackendProfileSchema.parse({ id: 'machine-login', name: 'Machine login', authMode: 'machineLogin',
      requiresMachineLoginTargetKey: 'agent:claude', requiresMachineLogin: 'claude', isBuiltIn: true,
      environmentVariables: [{ name: 'PUBLIC_CONFIG', value: 'retained' }], defaultModelMode: 'retained-model',
      defaultPermissionModeByAgent: { claude: 'default' }, compatibility: { claude: true }, createdAt: 1, updatedAt: 2 });
    const retained = ProfileRecordV1Schema.parse({ ...row, id: legacy.id, definition: { kind: 'legacy', profile: legacy },
      secretBindings: { TOKEN: 'happier:shared-secret:v1:secret-kept', MASKED: null } });
    let captured: unknown;
    let writes = 0;
    const owner = createProfileOperations({
      readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: retained, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      writeRecord: async input => { writes++; captured = input; return { status: 'updated', id: input.record.id, revision: 0 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }) });
    expect(await owner.duplicate({ id: legacy.id, expectedRevision: 3, newProfileId: 'stale-copy', name: 'Stale copy', now: 10 }))
      .toMatchObject({ status: 'conflict', revision: 4 });
    expect(writes).toBe(0);
    const source = owner.read({ id: legacy.id });
    if (source.status !== 'present') throw new Error('legacy_source_unavailable');
    const draft = createProfileDuplicateDraftV1({ profile: source.profile, sourceRow: { record: retained, revision: 4 },
      newProfileId: 'copy', name: 'Machine login copy', now: 10 });
    expect(draft).toMatchObject({ status: 'draft', profile: { ...legacy, id: 'copy', name: 'Machine login copy',
      isBuiltIn: false, createdAt: 10, updatedAt: 10, enabled: retained.enabled, promptStack: retained.promptStack },
      secretBindings: retained.secretBindings, legacyCloneSource: { id: retained.id, revision: 4 } });
    expect(await owner.duplicate({ id: legacy.id, expectedRevision: 4, newProfileId: 'copy', name: 'Machine login copy', now: 10 }))
      .toEqual({ status: 'updated', id: 'copy', revision: 0 });
    expect(captured).toMatchObject({ operation: 'clone-legacy', expectedRevision: 'absent', legacyCloneSource: { id: retained.id, revision: 4 },
      record: { id: 'copy', enabled: retained.enabled, promptStack: retained.promptStack, secretBindings: retained.secretBindings,
        definition: { kind: 'legacy', profile: { ...legacy, id: 'copy', name: 'Machine login copy', isBuiltIn: false, createdAt: 10, updatedAt: 10 } } } });
    expect(await owner.save({ profile: { ...legacy, id: 'arbitrary', name: 'Arbitrary legacy' }, expectedRevision: 'absent' }))
      .toMatchObject({ status: 'invalid', reason: 'legacy-creation-unsupported' });
    expect(writes).toBe(1);
  });
  it('detaches a captured legacy Artifact without losing inherited bindings or private null masks', async () => {
    const inherited = 'happier:shared-secret:v1:inherited';
    const hidden = 'happier:shared-secret:v1:hidden';
    const legacy = AIBackendProfileSchema.parse({ id: 'artifact-machine-login', name: 'Machine login',
      authMode: 'machineLogin', requiresMachineLoginTargetKey: 'agent:claude',
      envVarRequirements: [{ name: 'TOKEN', kind: 'secret', required: true }], createdAt: 1, updatedAt: 2 });
    const record = ProfileRecordV1Schema.parse({ ...row, id: legacy.id,
      definition: { kind: 'artifact', artifactId: 'published-machine-login' }, secretBindings: { MASKED: null } });
    const artifact = { artifactId: 'published-machine-login',
      header: { kind: 'launch-profile.v1', profileId: legacy.id, name: legacy.name },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile: legacy, secretBindings: { TOKEN: inherited, MASKED: hidden } }),
      access: 'view' as const, revision: { headerVersion: 2, bodyVersion: 3 } };
    const artifactsById = new Map([[artifact.artifactId, artifact]]);
    const source = readAiLaunchProfileRecords([record], { artifactsById, recordRevisionsById: new Map([[record.id, 4]]) }).entries[0];
    if (!source || source.kind === 'opaque') throw new Error('profile_definition_unavailable');
    const draft = createProfileDuplicateDraftV1({ profile: source.profile, sourceRow: { record, revision: 4 }, artifactsById,
      newProfileId: 'artifact-copy', name: 'Machine login copy', now: 10 });
    expect(draft).toMatchObject({ status: 'draft', profile: { id: 'artifact-copy', enabled: record.enabled, promptStack: record.promptStack },
      secretBindings: { TOKEN: inherited, MASKED: null }, legacyCloneSource: { id: record.id, revision: 4,
        artifactRevision: { artifactId: artifact.artifactId, ...artifact.revision } } });
    if (draft.status !== 'draft') throw new Error('profile_draft_unavailable');
    for (const key of ['artifactId', 'viewOnly', 'shared', 'revision', 'profileRecordRevision']) expect(draft.profile).not.toHaveProperty(key);
    let captured: unknown;
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready',
      records: [{ record, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }), artifactsById: () => artifactsById,
      writeRecord: async input => { captured = input; return { status: 'updated', id: input.record.id, revision: 0 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }) });
    expect(await owner.save({ profile: draft.profile, secretBindings: draft.secretBindings, expectedRevision: 'absent',
      legacyCloneSource: draft.legacyCloneSource })).toMatchObject({ status: 'updated', id: 'artifact-copy' });
    expect(captured).toMatchObject({ operation: 'clone-legacy', record: { definition: { kind: 'legacy', profile: { id: 'artifact-copy' } },
      secretBindings: { TOKEN: inherited, MASKED: null } } });
  });
  it('creates only private membership for a shared view-only Profile and edits its private fields', async () => {
    let catalog: ProfileCatalogSnapshotV1 = { ...activeAuthority, status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 'absent' };
    const artifact = { artifactId: 'published-a', header: { kind: 'launch-profile.v1', profileId: 'a', name: 'Alpha' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile, secretBindings: {} }), access: 'view' as const,
      revision: { headerVersion: 2, bodyVersion: 3 } };
    const owner = createProfileOperations({ readCatalog: () => catalog, artifactsById: () => new Map([[artifact.artifactId, artifact]]),
      writeRecord: async input => { catalog = { ...activeAuthority, status: 'ready', records: [{ record: input.record, revision: 1 }], diagnostics: [], referenceGuardRevision: 1 };
        return { status: 'updated', id: input.record.id, revision: 1 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 2 }) });
    expect(await owner.setEnabled({ id: 'a', enabled: false })).toMatchObject({ status: 'updated' });
    expect(owner.read({ id: 'a' })).toMatchObject({ status: 'present', record: {
      enabled: false, definition: { kind: 'artifact', artifactId: 'published-a' }, promptStack: [], secretBindings: {} } });
    expect(await owner.save({ profile: { ...profile, artifactId: 'published-a', viewOnly: true } }))
      .toMatchObject({ status: 'invalid', reason: 'read-only' });
    expect(await owner.remove({ id: 'a' })).toMatchObject({ status: 'updated' });
  });

  it('searches a granted nonmember by its Artifact ownership even when its retained identity was a builtin', () => {
    const artifact = { artifactId: 'published-a', header: { kind: 'launch-profile.v1', profileId: 'azure-openai', name: 'Alpha' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile: { ...profile, id: 'azure-openai' }, secretBindings: {} }), access: 'view' as const,
      revision: { headerVersion: 2, bodyVersion: 3 } };
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 'absent' }),
      artifactsById: () => new Map([[artifact.artifactId, artifact]]), agentIds: ['codex'],
      writeRecord: async input => ({ status: 'updated', id: input.record.id, revision: 1 }),
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 1 }) });
    expect(owner.search({ query: 'alpha' })).toMatchObject({ status: 'listed', records: [], complete: true,
      profiles: [{ profile: { id: 'azure-openai', name: 'Alpha', supportedAgentIds: ['codex'] },
        location: { kind: 'artifact', artifactId: 'published-a', headerVersion: 2, bodyVersion: 3 } }] });
    const visible = owner.read({ id: 'azure-openai' });
    expect(visible).toMatchObject({ status: 'present', profile: { ...profile, id: 'azure-openai', artifactId: 'published-a', viewOnly: true },
      location: { kind: 'artifact', artifactId: 'published-a', headerVersion: 2, bodyVersion: 3, access: 'view' } });
    expect(visible).not.toHaveProperty('record');
    expect(visible).not.toHaveProperty('revision');
  });
  it('keeps the exact retained identity when saving an unchanged granted Artifact as private membership', async () => {
    const retainedId = ' retained-profile ';
    const inheritedRef = 'happier:shared-secret:v1:inherited-token';
    const replacementRef = 'happier:shared-secret:v1:replacement-token';
    const content = { kind: 'launch-profile.v1', profile: { ...profile, id: retainedId }, secretBindings: { TOKEN: inheritedRef } };
    const artifact = { artifactId: 'retained-published-profile',
      header: { kind: 'launch-profile.v1', profileId: retainedId, name: profile.name },
      body: JSON.stringify(content), access: 'view' as const, revision: { headerVersion: 2, bodyVersion: 3 } };
    const captured: Array<Parameters<ProfileOperationsPorts['writeRecord']>[0]> = [];
    let catalog: ProfileCatalogSnapshotV1 = { ...activeAuthority, status: 'ready', records: [],
      diagnostics: [], referenceGuardRevision: 'absent' };
    const owner = createProfileOperations({ readCatalog: () => catalog, artifactsById: () => new Map([[artifact.artifactId, artifact]]),
      writeRecord: async input => { captured.push(input);
        catalog = { ...catalog, records: [{ record: input.record, revision: 1 }], referenceGuardRevision: 1 };
        return { status: 'updated', id: input.record.id, revision: 1 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 2 }) });
    const opened = owner.read({ id: retainedId });
    if (opened.status !== 'present') throw new Error('Expected the real admitted Artifact projection');
    expect(opened.profile.secretBindings).toEqual({ TOKEN: inheritedRef });
    expect(await owner.save({ profile: opened.profile, expectedRevision: 'absent' }))
      .toEqual({ status: 'updated', id: retainedId, revision: 1 });
    expect(captured[0]).toMatchObject({ operation: 'create', expectedRevision: 'absent', record: {
      id: retainedId, definition: { kind: 'artifact', artifactId: artifact.artifactId }, secretBindings: {}, promptStack: [],
    } });
    expect(captured[0]?.record.secretBindings).toEqual({});
    artifact.body = JSON.stringify({ ...content, secretBindings: { TOKEN: replacementRef } });
    artifact.revision = { headerVersion: 2, bodyVersion: 4 };
    expect(owner.read({ id: retainedId })).toMatchObject({ status: 'present', revision: 1,
      record: { secretBindings: {} }, profile: { secretBindings: { TOKEN: replacementRef },
        revision: { headerVersion: 2, bodyVersion: 4 } } });
  });
  it('refuses a real retained Artifact body edit rather than normalizing it into reference-only membership', async () => {
    const retained = { ...profile, name: ' Alpha ' };
    const artifact = { artifactId: 'retained-body-profile',
      header: { kind: 'launch-profile.v1', profileId: retained.id, name: retained.name },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile: retained, secretBindings: {} }),
      access: 'view' as const, revision: { headerVersion: 2, bodyVersion: 3 } };
    let writes = 0;
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [],
      diagnostics: [], referenceGuardRevision: 'absent' }), artifactsById: () => new Map([[artifact.artifactId, artifact]]),
      writeRecord: async input => { writes++; return { status: 'updated', id: input.record.id, revision: 1 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 2 }) });
    const opened = owner.read({ id: retained.id });
    if (opened.status !== 'present') throw new Error('Expected the actual stored Artifact body');
    expect(opened.profile.name).toBe(retained.name);
    expect(await owner.save({ profile: { ...opened.profile, name: 'Alpha' }, expectedRevision: 'absent' }))
      .toMatchObject({ status: 'invalid', reason: 'read-only' });
    expect(writes).toBe(0);
    expect(artifact.body).toBe(JSON.stringify({ kind: 'launch-profile.v1', profile: retained, secretBindings: {} }));
  });
  it('saves unchanged granted Artifact membership when target-map insertion order differs', async () => {
    const retained = { ...profile, compatibilityByTargetKey: {
      'agent:happier.agent.claude/claude': true, 'agent:happier.agent.codex/codex': false,
    } };
    const body = JSON.stringify({ kind: 'launch-profile.v1', profile: retained, secretBindings: {} });
    const artifact = { artifactId: 'retained-map-order-profile',
      header: { kind: 'launch-profile.v1', profileId: retained.id, name: retained.name },
      body, access: 'view' as const, revision: { headerVersion: 2, bodyVersion: 3 } };
    let captured: unknown;
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [],
      diagnostics: [], referenceGuardRevision: 'absent' }), artifactsById: () => new Map([[artifact.artifactId, artifact]]),
      writeRecord: async input => { captured = input; return { status: 'updated', id: input.record.id, revision: 1 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 2 }) });
    const opened = owner.read({ id: retained.id });
    if (opened.status !== 'present' || !isLaunchProfileV2(opened.profile)) throw new Error('Expected the real V2 Artifact projection');
    const compatibilityByTargetKey = Object.fromEntries(Object.entries(opened.profile.compatibilityByTargetKey).reverse());
    expect(await owner.save({ profile: { ...opened.profile, compatibilityByTargetKey }, expectedRevision: 'absent' }))
      .toEqual({ status: 'updated', id: retained.id, revision: 1 });
    expect(captured).toMatchObject({ operation: 'create', expectedRevision: 'absent', record: {
      id: retained.id, definition: { kind: 'artifact', artifactId: artifact.artifactId }, secretBindings: {}, promptStack: [],
    } });
    expect(artifact.body).toBe(body);
  });
  it('attaches private fields to a granted Artifact with the explicit absent-membership guard', async () => {
    const artifact = { artifactId: 'published-a', header: { kind: 'launch-profile.v1', profileId: 'a', name: 'Alpha' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile, secretBindings: {} }), access: 'view' as const,
      revision: { headerVersion: 2, bodyVersion: 3 } };
    let captured: unknown;
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 'absent' }),
      artifactsById: () => new Map([[artifact.artifactId, artifact]]),
      writeRecord: async input => { captured = input; return { status: 'updated', id: input.record.id, revision: 1 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 1 }) });
    expect(await owner.setSecretBindings({ id: 'a', expectedRevision: 'absent', secretBindings: { TOKEN: 'secret-kept' } }))
      .toEqual({ status: 'updated', id: 'a', revision: 1 });
    expect(captured).toMatchObject({ operation: 'create', expectedRevision: 'absent',
      record: { definition: { kind: 'artifact', artifactId: artifact.artifactId }, secretBindings: { TOKEN: 'secret-kept' } } });
  });
  it('does not reuse a granted visible identity for an unrelated new definition or duplicate', async () => {
    const artifact = { artifactId: 'published-a', header: { kind: 'launch-profile.v1', profileId: 'a', name: 'Alpha' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile, secretBindings: {} }), access: 'view' as const,
      revision: { headerVersion: 2, bodyVersion: 3 } };
    const source = ProfileRecordV1Schema.parse({ ...row, id: 'b', definition: { kind: 'inline', profile: { ...profile, id: 'b', name: 'Beta' } } });
    let writes = 0;
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: source, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      artifactsById: () => new Map([[artifact.artifactId, artifact]]),
      writeRecord: async input => { writes++; return { status: 'updated', id: input.record.id, revision: 1 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 1 }) });
    expect(await owner.save({ profile: { ...profile, name: 'Unrelated' }, expectedRevision: 'absent' }))
      .toMatchObject({ status: 'invalid', reason: 'duplicate-id' });
    expect(await owner.duplicate({ id: 'b', expectedRevision: 4, newProfileId: 'a', name: 'Copy', now: 2 }))
      .toMatchObject({ status: 'invalid', reason: 'duplicate-id' });
    expect(writes).toBe(0);
  });

  it('never acknowledges an edited shared body by writing only a new membership', async () => {
    const artifact = { artifactId: 'published-a', header: { kind: 'launch-profile.v1', profileId: 'a', name: 'Alpha' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile, secretBindings: {} }), access: 'edit' as const,
      revision: { headerVersion: 2, bodyVersion: 3 } };
    let writes = 0;
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 'absent' }),
      artifactsById: () => new Map([[artifact.artifactId, artifact]]),
      writeRecord: async input => { writes++; return { status: 'updated', id: input.record.id, revision: 1 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 1 }) });
    expect(await owner.save({ profile: { ...profile, name: 'Changed', artifactId: artifact.artifactId } }))
      .toMatchObject({ status: 'unavailable', reason: 'profile_artifact_membership_required' });
    expect(writes).toBe(0);
  });
  it('requires the separately captured Artifact revision before editing an Artifact-owned Profile body', async () => {
    const artifact = { artifactId: 'published-a', header: { kind: 'launch-profile.v1', profileId: 'a', name: 'Alpha' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile, secretBindings: {} }), access: 'edit' as const,
      revision: { headerVersion: 2, bodyVersion: 3 } };
    const membership = ProfileRecordV1Schema.parse({ ...row, definition: { kind: 'artifact', artifactId: artifact.artifactId } });
    let writes = 0;
    let captured: unknown;
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready',
      records: [{ record: membership, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      artifactsById: () => new Map([[artifact.artifactId, artifact]]),
      writeRecord: async input => { writes++; return { status: 'updated', id: input.record.id, revision: 5 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }),
      writeArtifactProfile: async input => { writes++; captured = input; return { status: 'updated', id: input.record.id, revision: 4 }; } });
    const edited = { ...profile, name: 'Edited' };
    expect(await owner.save({ profile: edited, expectedRevision: 4 }))
      .toMatchObject({ status: 'unavailable', reason: 'profile_artifact_revision_unavailable' });
    expect(await owner.save({ profile: edited, expectedRevision: 4,
      expectedArtifactRevision: { headerVersion: 1, bodyVersion: 3 } }))
      .toMatchObject({ status: 'conflict', id: 'a', revision: 4 });
    expect(writes).toBe(0);
    expect(await owner.save({ profile: edited, expectedRevision: 4, expectedArtifactRevision: artifact.revision }))
      .toEqual({ status: 'updated', id: 'a', revision: 4 });
    expect(captured).toMatchObject({ expectedRevision: 4, expectedArtifactRevision: artifact.revision });
    expect(writes).toBe(1);
  });
  it('allows an Artifact body edit with unchanged effective bindings but refuses to ignore a private binding edit', async () => {
    const artifact = { artifactId: 'published-a', header: { kind: 'launch-profile.v1', profileId: 'a', name: 'Alpha' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile, secretBindings: { RESOURCE_DEFAULT: 'secret-default' } }), access: 'edit' as const,
      revision: { headerVersion: 2, bodyVersion: 3 } };
    const membership = ProfileRecordV1Schema.parse({ ...row, definition: { kind: 'artifact', artifactId: artifact.artifactId } });
    let writes = 0;
    const owner = createProfileOperations({ readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: membership, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      artifactsById: () => new Map([[artifact.artifactId, artifact]]),
      writeRecord: async input => { writes++; return { status: 'updated', id: input.record.id, revision: 5 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }),
      writeArtifactProfile: async input => { writes++; return { status: 'updated', id: input.record.id, revision: 4 }; } });
    expect(await owner.save({ profile: { ...profile, name: 'Edited' }, expectedRevision: 4, expectedArtifactRevision: artifact.revision,
      secretBindings: { RESOURCE_DEFAULT: 'secret-default', TOKEN: 'secret-a' } }))
      .toEqual({ status: 'updated', id: 'a', revision: 4 });
    expect(writes).toBe(1);
    expect(await owner.save({ profile: { ...profile, name: 'Edited' }, expectedRevision: 4, expectedArtifactRevision: artifact.revision,
      secretBindings: { RESOURCE_DEFAULT: 'secret-default', TOKEN: 'secret-next' } }))
      .toMatchObject({ status: 'unavailable', reason: 'profile_artifact_binding_edit_unavailable' });
    expect(writes).toBe(1);
  });

  it('edits known private membership without requiring an unrelated Artifact body', async () => {
    const missing = ProfileRecordV1Schema.parse({ ...row, id: 'missing', definition: { kind: 'artifact', artifactId: 'unavailable' } });
    const changes: ProfileRecordV1[] = [];
    const owner = createProfileOperations({
      readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: row, revision: 4 }, { record: missing, revision: 2 }], diagnostics: [], referenceGuardRevision: 5 }),
      writeRecord: async input => { changes.push(input.record); return { status: 'updated', id: input.record.id, revision: 5 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }) });
    expect(owner.read({ id: 'a' })).toMatchObject({ status: 'present', revision: 4 });
    expect(await owner.setEnabled({ id: 'a', enabled: true })).toMatchObject({ status: 'updated' });
    expect(changes[0]?.enabled).toBe(true);
    expect(await owner.save({ profile: { ...profile, name: 'Unique' } })).toMatchObject({ status: 'unavailable' });
    expect(await owner.remove({ id: 'missing' })).toMatchObject({ status: 'updated' });
  });

  it('preserves entity attachments and rejects a stale editor without writes', async () => {
    let captured: ProfileRecordV1 | undefined;
    const owner = createProfileOperations({
      readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: row, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      writeRecord: async (input) => { captured = input.record; return { status: 'updated', id: input.record.id, revision: 5 }; },
      deleteRecord: async (input) => ({ status: 'updated', id: input.id, revision: 5 }),
    });
    expect(await owner.save({ profile: { ...profile, name: 'Edited' }, expectedRevision: 3 }))
      .toEqual({ status: 'conflict', id: 'a', revision: 4 });
    expect(captured).toBeUndefined();
    expect(await owner.save({ profile: { ...profile, name: 'Edited' }, expectedRevision: 4 }))
      .toEqual({ status: 'updated', id: 'a', revision: 5 });
    expect(captured).toMatchObject({ enabled: false, promptStack: row.promptStack, secretBindings: { TOKEN: 'secret-a' },
      definition: { kind: 'inline', profile: { name: 'Edited' } } });
  });

  it('requires complete opened uniqueness and refuses an incomplete inventory', async () => {
    let writes = 0;
    let catalog: ProfileCatalogSnapshotV1 = { ...activeAuthority, status: 'ready', records: [{ record: row, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 };
    const owner = createProfileOperations({ readCatalog: () => catalog,
      writeRecord: async input => { writes++; return { status: 'updated', id: input.record.id, revision: 1 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 1 }) });
    expect(await owner.save({ profile: { ...profile, id: 'b' } })).toMatchObject({ status: 'invalid', reason: 'duplicate-name' });
    catalog = { ...catalog, status: 'partial', diagnostics: [{ id: 'unknown', revision: 1, reason: 'invalid-stored-content' }] };
    expect(await owner.setEnabled({ id: 'a', enabled: true })).toMatchObject({ status: 'unavailable' });
    expect(await owner.remove({ id: 'a' })).toMatchObject({ status: 'unavailable' });
    expect(writes).toBe(0);
  });

  it('updates a retained legacy record through its own representation and never creates a legacy definition', async () => {
    const legacy = ProfileRecordV1Schema.parse({ ...row, definition: { kind: 'legacy', profile: {
      id: 'a', name: 'Legacy', environmentVariables: [{ name: 'OPENAI_BASE_URL', value: 'http://localhost', isSecret: false }] } } });
    let captured: ProfileRecordV1 | undefined;
    const owner = createProfileOperations({
      readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [{ record: legacy, revision: 4 }], diagnostics: [], referenceGuardRevision: 5 }),
      writeRecord: async input => { captured = input.record; return { status: 'updated', id: input.record.id, revision: 5 }; },
      deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }) });
    if (legacy.definition.kind !== 'legacy') throw new Error('fixture');
    expect(await owner.save({ profile: { ...legacy.definition.profile, name: 'Renamed' } })).toMatchObject({ status: 'updated' });
    expect(captured?.definition.kind).toBe('legacy');
    expect(await owner.save({ profile: { ...legacy.definition.profile, id: 'new', name: 'New legacy' } }))
      .toMatchObject({ status: 'invalid', reason: 'legacy-creation-unsupported' });
  });
});
