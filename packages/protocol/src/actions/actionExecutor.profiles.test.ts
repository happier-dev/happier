import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import type { ActionId } from './actionIds.js';
import { createProfileOperations, type ProfileOperationsPorts } from '../profiles/profileOperations.js';
import { createProfileActionExecuteV1, PROFILE_ACTION_OUTPUT_SCHEMAS_V1 } from '../profiles/profileActionsV1.js';
import { LaunchProfileV2Schema } from '../profiles/v2/schema.js';
import type { ProfileRecordV1 } from '../profiles/profileRecordV1.js';
import { ProfileRecordV1Schema } from '../profiles/profileRecordSchemaV1.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { mapAiLaunchProfileToListItemV1 } from '../profiles/listProjection.js';
import type { ArtifactSharingResourceV1 } from '../artifacts/artifactSharingV1.js';
import { formatSharedSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { getBuiltInBackendProfile } from '../profiles/builtInBackendProfiles.js';
import { AiLaunchProfileV1Schema } from '../profiles/read.js';

const activeAuthority = { source: 'destination' as const, authority: 'active' as const, controlRevision: 1, control: { revision: 1,
  record: { v: 1 as const, phase: 'active' as const, sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory: [] } } };

/** Persistence is the only replaced boundary; both editor and Action use real domain decisions. */
function catalogStore(artifacts: ReadonlyMap<string, ArtifactSharingResourceV1> = new Map(),
  writeArtifactProfile?: ProfileOperationsPorts['writeArtifactProfile']) {
  const rows = new Map<string, { record: ProfileRecordV1; revision: number }>();
  const writes: Parameters<ProfileOperationsPorts['writeRecord']>[0][] = [];
  const operations = createProfileOperations({
    readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [...rows.values()], diagnostics: [], referenceGuardRevision: 0 }),
    artifactsById: () => artifacts,
    writeArtifactProfile,
    agentIds: ['codex'],
    writeRecord: async input => {
      const { record, expectedRevision } = input;
      const current = rows.get(record.id);
      if (expectedRevision === 'absent' ? current !== undefined : current?.revision !== expectedRevision) {
        return { status: 'conflict', id: record.id, revision: current?.revision ?? -1 };
      }
      const revision = (current?.revision ?? -1) + 1;
      rows.set(record.id, { record, revision });
      writes.push(input);
      return { status: 'updated', id: record.id, revision };
    },
    deleteRecord: async ({ id, expectedRevision }) => {
      const current = rows.get(id);
      if (current?.revision !== expectedRevision) return { status: 'conflict', id, revision: current?.revision ?? -1 };
      rows.delete(id);
      return { status: 'updated', id, revision: expectedRevision + 1 };
    },
  });
  return { rows, writes, operations };
}

const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
const authored = LaunchProfileV2Schema.parse({ v: 2, id: 'profile-1', name: 'Private', createdAt: 1, updatedAt: 1 });

async function artifactEditStore() {
  const profile = { ...authored, id: 'published', name: 'Published' };
  const openedRevision = { headerVersion: 2, bodyVersion: 3 };
  const currentRevision = { headerVersion: 2, bodyVersion: 4 };
  const currentProfile = { ...profile, description: 'Changed on another client' };
  let storedBody = JSON.stringify({ kind: 'launch-profile.v1', profile: currentProfile, secretBindings: {} });
  let capturedRevision: unknown;
  const resource: ArtifactSharingResourceV1 = { artifactId: 'published-artifact', access: 'edit', revision: openedRevision,
    header: { kind: 'launch-profile.v1', profileId: profile.id, name: profile.name },
    body: JSON.stringify({ kind: 'launch-profile.v1', profile, secretBindings: {} }) };
  const openedArtifacts = new Map([[resource.artifactId, resource]]);
  const store = catalogStore(openedArtifacts, async input => {
    // Genuine Artifact persistence CAS: the stored body advanced independently of the opened snapshot.
    capturedRevision = 'expectedArtifactRevision' in input ? input.expectedArtifactRevision : undefined;
    if (capturedRevision !== undefined && JSON.stringify(capturedRevision) !== JSON.stringify(currentRevision))
      return { status: 'conflict', id: input.record.id, revision: input.expectedRevision };
    storedBody = JSON.stringify({ kind: 'launch-profile.v1', profile: input.profile, secretBindings: {} });
    return { status: 'updated', id: input.record.id, revision: input.expectedRevision };
  });
  await store.operations.setEnabled({ id: profile.id, enabled: true });
  const executor = createActionExecutor({ isActionApprovalRequired: () => false,
    profileActionExecute: createProfileActionExecuteV1({ operations: store.operations }) });
  return { executor, profile, currentProfile, openedRevision, currentRevision,
    refreshOpenedResource: () => { openedArtifacts.set(resource.artifactId, { ...resource,
      revision: currentRevision, body: storedBody }); },
    storedBody: () => storedBody, capturedRevision: () => capturedRevision };
}

describe('Profile entity Actions', () => {
  it('F8 edits only the captured private Profile stack through Actions and refuses a stale revision', async () => {
    const store = catalogStore();
    const neighbor = { id: 'skill', ref: { kind: 'bundle' as const, artifactId: 'skill-artifact' }, enabled: true,
      placement: 'skill_instructions' as const };
    const record = ProfileRecordV1Schema.parse({ v: 1, id: authored.id, definition: { kind: 'inline', profile: authored },
      enabled: false, secretBindings: { TOKEN: formatSharedSavedSecretRefV1('resource') }, promptStack: [neighbor] });
    store.rows.set(authored.id, { record, revision: 4 });
    const executor = createActionExecutor({
      profileActionExecute: createProfileActionExecuteV1({ operations: store.operations }) });
    const entry = { id: 'doc', ref: { kind: 'doc', artifactId: 'doc-artifact' }, enabled: true, placement: 'system_append' };
    expect(await executor.execute('launch_profiles.prompt_stack.update', { id: authored.id, expectedRevision: 4,
      intent: { kind: 'attach', entry } }, context)).toMatchObject({ ok: true, result: { status: 'updated', revision: 5 } });
    expect(await executor.execute('launch_profiles.prompt_stack.update', { id: authored.id, expectedRevision: 5,
      intent: { kind: 'set_enabled', entryId: 'doc', enabled: false } }, context))
      .toMatchObject({ ok: true, result: { status: 'updated', revision: 6 } });
    expect(store.rows.get(authored.id)?.record).toEqual({ ...record, promptStack: [neighbor, { ...entry, enabled: false }] });
    expect(await executor.execute('launch_profiles.prompt_stack.update', { id: authored.id, expectedRevision: 4,
      intent: { kind: 'detach', entryId: 'skill' } }, context)).toMatchObject({ ok: true, result: { status: 'conflict', revision: 6 } });
    expect(store.writes).toHaveLength(2);
    expect(await executor.execute('launch_profiles.prompt_stack.update', { id: authored.id,
      intent: { kind: 'detach', entryId: 'skill' } }, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(store.writes).toHaveLength(2);
  });
  it('saves an admitted converted row without rewriting its retained identity or metadata and cannot mint it at an unknown numeric revision', async () => {
    const id = ` ${'converted-profile-'.repeat(20)} `;
    const record = ProfileRecordV1Schema.parse({ v: 1, id, definition: { kind: 'inline', profile: {
      ...authored, id, name: 'Converted', description: 'Retained metadata',
      extraEnvironmentVariables: [{ name: 'PRIVATE_CONFIG', value: 'retained' }], placement: 'ask', checkout: 'create_worktree',
    } }, enabled: false, promptStack: [], secretBindings: { TOKEN: formatSharedSavedSecretRefV1('private-resource'), NONE: null } });
    if (record.definition.kind !== 'inline') throw new Error('Canonical converted inline fixture failed');
    const profile = { ...record.definition.profile, name: 'Edited converted', updatedAt: 2 };
    const store = catalogStore();
    store.rows.set(id, { record, revision: 7 });
    const executor = createActionExecutor({ isActionApprovalRequired: () => false,
      profileActionExecute: createProfileActionExecuteV1({ operations: store.operations }) });
    expect(await executor.execute('launch_profiles.save', { id, expectedRevision: 7, profile }, context))
      .toEqual({ ok: true, result: { status: 'updated', id, revision: 8 } });
    const expected = { ...record, definition: { kind: 'inline', profile } };
    expect(store.rows.get(id)).toEqual({ record: expected, revision: 8 });
    expect(store.writes).toEqual([{ record: expected, expectedRevision: 7, operation: 'update' }]);
    expect(await executor.execute('launch_profiles.create', { profile, expectedRevision: 'absent' }, context))
      .toMatchObject({ ok: false });
    const unknownId = ` ${'unknown-converted-'.repeat(20)} `;
    const refused = await executor.execute('launch_profiles.save', { id: unknownId, expectedRevision: 7,
      profile: { ...profile, id: unknownId } }, context);
    expect(refused.ok).toBe(true);
    if (!refused.ok) throw new Error('Existing-save ingress incorrectly refused retained identity before the owner');
    expect(refused.result).toMatchObject({ status: 'conflict', id: unknownId, revision: -1 });
    expect(store.rows.has(unknownId)).toBe(false);
    expect(store.rows.size).toBe(1);
    expect(store.writes).toHaveLength(1);
  });

  it('reads an actual visible builtin without manufacturing a private record or revision', async () => {
    const builtin = getBuiltInBackendProfile('azure-openai');
    if (!builtin) throw new Error('Canonical current builtin is unavailable');
    const operations = createProfileOperations({
      readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 0 }),
      readVisibleProfiles: () => [builtin],
      readEnabledPreferences: () => ({ [builtin.id]: true }),
      writeRecord: async () => { throw new Error('Reading a builtin must not write a private row'); },
      deleteRecord: async () => { throw new Error('Reading a builtin must not delete a private row'); },
    });
    const executor = createActionExecutor({ isActionApprovalRequired: () => false,
      profileActionExecute: createProfileActionExecuteV1({ operations }) });
    const result = await executor.execute('launch_profiles.read', { id: builtin.id }, context);
    expect(result).toMatchObject({ ok: true, result: { status: 'present', profile: AiLaunchProfileV1Schema.parse(builtin), location: { kind: 'builtin' } } });
    if (!result.ok) throw new Error('Builtin read failed');
    expect(result.result).not.toHaveProperty('record');
    expect(result.result).not.toHaveProperty('revision');
    expect(PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.read'].safeParse(result.result).success).toBe(true);
  });

  it('attaches private secret references only for actual current builtins and visible granted Profiles', async () => {
    const profile = { ...authored, id: 'granted-profile', name: 'Granted' };
    const artifact: ArtifactSharingResourceV1 = { artifactId: 'artifact-granted',
      header: { kind: 'launch-profile.v1', profileId: profile.id, name: profile.name },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile, secretBindings: {} }), access: 'view',
      revision: { headerVersion: 2, bodyVersion: 3 } };
    const store = catalogStore(new Map([[artifact.artifactId, artifact]]));
    const executor = createActionExecutor({ isActionApprovalRequired: () => false,
      profileActionExecute: createProfileActionExecuteV1({ operations: store.operations,
        selectSecret: input => store.operations.selectSecret(input) }) });
    const input = { expectedRevision: 'absent', envName: 'TOKEN',
      selection: { kind: 'resource', resourceId: 'resource-a', expectedResourceRevision: 7 } };
    for (const id of ['unknown-profile', 'anthropic']) {
      expect(await executor.execute('launch_profiles.secrets.select', { ...input, id }, context))
        .toMatchObject({ ok: true, result: { status: 'invalid', reason: 'profile-not-found', id } });
    }
    expect(store.rows.size).toBe(0);
    expect(store.writes).toEqual([]);
    expect(await executor.execute('launch_profiles.secrets.select', { ...input, id: 'azure-openai' }, context))
      .toMatchObject({ ok: true, result: { status: 'updated', id: 'azure-openai' } });
    expect(store.rows.get('azure-openai')?.record).toMatchObject({
      definition: { kind: 'legacy', profile: { id: 'azure-openai' } },
      secretBindings: { TOKEN: formatSharedSavedSecretRefV1('resource-a') },
    });
    expect(store.writes[0]).toMatchObject({ operation: 'attach-builtin', expectedRevision: 'absent',
      savedSecretRevisions: [{ resourceId: 'resource-a', expectedRevision: 7 }] });
    expect(await executor.execute('launch_profiles.secrets.select', { ...input, id: profile.id }, context))
      .toMatchObject({ ok: true, result: { status: 'updated', id: profile.id } });
    expect(store.rows.get(profile.id)?.record).toMatchObject({
      definition: { kind: 'artifact', artifactId: artifact.artifactId },
      secretBindings: { TOKEN: formatSharedSavedSecretRefV1('resource-a') },
    });
    expect(store.writes[1]).toMatchObject({ operation: 'create', expectedRevision: 'absent',
      savedSecretRevisions: [{ resourceId: 'resource-a', expectedRevision: 7 }] });
  });

  it('refuses an Artifact body edit when only the private membership revision was captured', async () => {
    const store = await artifactEditStore();
    const before = store.storedBody();
    expect(await store.executor.execute('launch_profiles.save', { id: store.profile.id, expectedRevision: 0,
      profile: { ...store.profile, name: 'Edited' } }, context))
      .toMatchObject({ ok: true, result: { status: 'unavailable' } });
    expect(store.storedBody()).toBe(before);
  });

  it('carries the captured Artifact revision into persistence instead of replacing a newer shared body', async () => {
    const store = await artifactEditStore();
    const before = store.storedBody();
    const profile = { ...store.profile, name: 'Edited' };
    expect(await store.executor.execute('launch_profiles.save', { id: profile.id, expectedRevision: 0,
      expectedArtifactRevision: store.openedRevision, profile }, context))
      .toMatchObject({ ok: true, result: { status: 'conflict' } });
    expect(store.storedBody()).toBe(before);
    expect(store.capturedRevision()).toEqual(store.openedRevision);
    store.refreshOpenedResource();
    expect(await store.executor.execute('launch_profiles.save', { id: profile.id, expectedRevision: 0,
      expectedArtifactRevision: store.currentRevision, profile: { ...store.currentProfile, name: 'Edited' } }, context))
      .toMatchObject({ ok: true, result: { status: 'updated' } });
    expect(store.capturedRevision()).toEqual(store.currentRevision);
    expect(JSON.parse(store.storedBody()).profile.name).toBe('Edited');
    expect(JSON.parse(store.storedBody()).profile.description).toBe(store.currentProfile.description);
  });

  it('finds a granted Profile without manufacturing a private membership or row revision', async () => {
    const profile = { ...authored, id: 'granted', name: 'Granted' };
    const artifact: ArtifactSharingResourceV1 = { artifactId: 'artifact-granted',
      header: { kind: 'launch-profile.v1', profileId: profile.id, name: profile.name },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile, secretBindings: {} }), access: 'view',
      revision: { headerVersion: 2, bodyVersion: 3 } };
    const store = catalogStore(new Map([[artifact.artifactId, artifact]]));
    const executor = createActionExecutor({ isActionApprovalRequired: () => false,
      profileActionExecute: createProfileActionExecuteV1({ operations: store.operations }) });
    const result = await executor.execute('launch_profiles.search', { query: 'grant' }, context);
    expect(result).toEqual({ ok: true, result: { status: 'listed', complete: true, records: [], profiles: [{
      profile: mapAiLaunchProfileToListItemV1(profile, { agentIds: ['codex'] }),
      location: { kind: 'artifact', artifactId: artifact.artifactId, headerVersion: 2, bodyVersion: 3 },
    }] } });
    if (!result.ok) throw new Error('Search failed');
    expect(PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.search'].safeParse(result.result).success).toBe(true);
    const read = await executor.execute('launch_profiles.read', { id: profile.id }, context);
    expect(read).toMatchObject({ ok: true, result: { status: 'present',
      profile: { ...profile, artifactId: artifact.artifactId, shared: true, viewOnly: true, revision: artifact.revision },
      location: { kind: 'artifact', artifactId: artifact.artifactId, ...artifact.revision, access: artifact.access } } });
    if (!read.ok) throw new Error('Granted Profile read failed');
    expect(read.result).not.toHaveProperty('record');
    expect(read.result).not.toHaveProperty('revision');
    expect(PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.read'].safeParse(read.result).success).toBe(true);
    expect(store.rows.size).toBe(0);
    expect(store.writes).toEqual([]);
  });

  it('recognizes the Profile edit contract and refuses an unsupported editor host truthfully', async () => {
    const executor = createActionExecutor({ isActionApprovalRequired: () => false });
    await expect(executor.execute('launch_profiles.edit' as ActionId, { id: 'profile-1', expectedRevision: 1 },
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });

  it('requires approval for publication and credential/reference mutations', () => {
    expect(getActionSpec('launch_profiles.publish').safety).toBe('danger');
    for (const id of ['launch_profiles.delete', 'launch_profiles.secrets.select', 'launch_profiles.legacy.convert',
      'launch_profiles.legacy.resolve_conflict'] as const) {
      expect(getActionSpec(id as ActionId).safety).toBe('danger');
      expect(resolveActionApprovalRouting({ actionId: id, spec: getActionSpec(id),
        context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(true);
    }
  });

  it('executes the same row save contract as the editor and keeps stale drafts from overwriting', async () => {
    const fromAction = catalogStore();
    const fromEditor = catalogStore();
    const executor = createActionExecutor({ isActionApprovalRequired: () => false,
      profileActionExecute: createProfileActionExecuteV1({ operations: fromAction.operations }) });
    const expected = await fromEditor.operations.save({ profile: authored });
    expect(await executor.execute('launch_profiles.create', { profile: authored, expectedRevision: 'absent' }, context))
      .toEqual({ ok: true, result: expected });
    expect([...fromAction.rows.values()]).toEqual([...fromEditor.rows.values()]);

    const profile = { ...authored, name: 'Edited', updatedAt: 2 };
    const saved = await fromEditor.operations.save({ profile, expectedRevision: 0 });
    expect(await executor.execute('launch_profiles.save', { id: profile.id, profile, expectedRevision: 0 }, context))
      .toEqual({ ok: true, result: saved });
    expect([...fromAction.rows.values()]).toEqual([...fromEditor.rows.values()]);
    expect(await executor.execute('launch_profiles.save', { id: profile.id,
      profile: { ...profile, name: 'Stale' }, expectedRevision: 0 }, context))
      .toMatchObject({ ok: true, result: { status: 'conflict', id: profile.id, revision: 1 } });
    expect(fromAction.rows.get(profile.id)?.record.definition).toEqual({ kind: 'inline', profile });
    expect(await executor.execute('launch_profiles.create', { profile: authored, expectedRevision: 'absent' }, context))
      .toMatchObject({ ok: true, result: { status: 'conflict', id: profile.id, revision: 1 } });
  });

  it('reads and searches destination rows, then disables, duplicates and removes through the real owner', async () => {
    const store = catalogStore();
    await store.operations.save({ profile: authored });
    const executor = createActionExecutor({ isActionApprovalRequired: () => false,
      profileActionExecute: createProfileActionExecuteV1({ operations: store.operations }) });
    const read = await executor.execute('launch_profiles.read', { id: authored.id }, context);
    expect(read).toMatchObject({ ok: true, result: { status: 'present', revision: 0, record: { id: authored.id },
      profile: { ...authored, enabled: true, promptStack: [], secretBindings: {}, profileRecordRevision: 0 },
      location: { kind: 'account_row', revision: 0 } } });
    if (!read.ok) throw new Error('Private Profile read failed');
    expect(PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.read'].safeParse(read.result).success).toBe(true);
    expect(await executor.execute('launch_profiles.search', { query: 'priv' }, context))
      .toMatchObject({ ok: true, result: { status: 'listed', complete: true, records: [{ revision: 0 }] } });
    await executor.execute('launch_profiles.enabled.set', { id: authored.id, expectedRevision: 0, enabled: false }, context);
    expect(store.rows.get(authored.id)?.record.enabled).toBe(false);
    expect(await executor.execute('launch_profiles.duplicate', { id: authored.id, expectedRevision: 1,
      newProfileId: 'copy-1', name: 'Copy', now: 3 }, context))
      .toMatchObject({ ok: true, result: { status: 'updated', id: 'copy-1' } });
    expect(store.rows.get('copy-1')?.record).toMatchObject({ id: 'copy-1', enabled: false,
      definition: { kind: 'inline', profile: { id: 'copy-1', name: 'Copy' } } });
    await executor.execute('launch_profiles.delete', { id: authored.id, expectedRevision: 1 }, context);
    expect([...store.rows.keys()]).toEqual(['copy-1']);
  });

  it('rejects raw credentials and arbitrary operations before the semantic service', async () => {
    const store = catalogStore();
    const executor = createActionExecutor({ isActionApprovalRequired: () => false,
      profileActionExecute: createProfileActionExecuteV1({ operations: store.operations }) });
    expect(getActionSpec('launch_profiles.secrets.select').inputSchema.safeParse({ id: authored.id,
      expectedRevision: 0, envName: 'API_KEY', selection: { kind: 'resource', resourceId: 'saved-secret:secret-1',
        expectedResourceRevision: 1 } }).success).toBe(true);
    expect(await executor.execute('launch_profiles.secrets.select', { id: authored.id, expectedRevision: 0,
      envName: 'API_KEY', selection: { kind: 'resource', resourceId: 'saved-secret:secret-1',
        expectedResourceRevision: 1, value: 'credential-must-not-cross' } }, context)).toMatchObject({ ok: false });
    expect(await executor.execute('launch_profiles.save', { operation: 'save', payload: {} }, context))
      .toMatchObject({ ok: false });
    expect(await executor.execute('launch_profiles.save', { id: authored.id, expectedRevision: 0,
      profile: { ...authored, v: 3 } }, context)).toMatchObject({ ok: false });
    expect(store.rows.size).toBe(0);
  });

  it('keeps private profile definitions out of shared Action observations', async () => {
    const store = catalogStore();
    const observations: unknown[] = [];
    const executor = createActionExecutor({ isActionApprovalRequired: () => false,
      profileActionExecute: createProfileActionExecuteV1({ operations: store.operations }),
      interceptActionExecution: async ({ input }) => ({ status: 'continue', input }),
      observeActionExecution: async observation => { observations.push(observation); } });
    const profile = { ...authored, extraEnvironmentVariables: [{ name: 'PRIVATE_CONFIG', value: 'PRIVATE_PROFILE_SENTINEL' }] };
    expect(await executor.execute('launch_profiles.create', { profile, expectedRevision: 'absent' }, context))
      .toMatchObject({ ok: true, result: { status: 'updated' } });
    expect(await executor.execute('launch_profiles.read', { id: profile.id }, context))
      .toMatchObject({ ok: true, result: { status: 'present', record: { definition: { profile } } } });
    expect(observations.length).toBeGreaterThan(0);
    expect(JSON.stringify(observations)).not.toContain('PRIVATE_PROFILE_SENTINEL');
  });
});
