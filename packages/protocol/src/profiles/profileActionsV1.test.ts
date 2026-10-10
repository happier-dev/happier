import { describe, expect, it } from 'vitest';
import { createProfileActionExecuteV1, parseProfileActionRequestV1, PROFILE_ACTION_INPUT_SCHEMAS_V1, PROFILE_ACTION_OUTPUT_SCHEMAS_V1 } from './profileActionsV1.js';
import { createProfileOperations } from './profileOperations.js';
import { LaunchProfileV2Schema } from './v2/schema.js';
import type { ProfileRecordV1 } from './profileRecordV1.js';
import { ProfileRecordV1Schema } from './profileRecordSchemaV1.js';
import { getBuiltInBackendProfile } from './builtInBackendProfiles.js';
import { readAiLaunchProfileRecords } from './read.js';
import type { ArtifactSharingResourceV1 } from '../artifacts/artifactSharingV1.js';
import { SAVED_SECRET_REF_MAX_LENGTH_V1, SHARED_SAVED_SECRET_REF_V1_PREFIX, formatSharedSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';

const activeAuthority = { source: 'destination' as const, authority: 'active' as const, controlRevision: 1, control: { revision: 1,
  record: { v: 1 as const, phase: 'active' as const, sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory: [] } } };

describe('Profile Action host demand', () => {
  it('applies a captured binding batch in one row CAS and refuses stale or invalid batches without partial changes', async () => {
    const profile = LaunchProfileV2Schema.parse({ v: 2, id: 'batch-profile', name: 'Batch', createdAt: 1, updatedAt: 1 });
    let record = ProfileRecordV1Schema.parse({ v: 1, id: profile.id, definition: { kind: 'inline', profile },
      enabled: false, promptStack: [], secretBindings: { FIRST: formatSharedSavedSecretRefV1('original'), KEEP: null } });
    let revision = 4;
    const writes: ProfileRecordV1[] = [];
    const operations = createProfileOperations({
      readCatalog: () => ({ status: 'ready', records: [{ record, revision }], diagnostics: [], referenceGuardRevision: 1, ...activeAuthority }),
      writeRecord: async input => {
        expect(input.expectedRevision).toBe(4);
        expect(input.savedSecretRevisions).toEqual([{ resourceId: 'replacement', expectedRevision: 7 }]);
        writes.push(input.record); record = input.record; revision++;
        return { status: 'updated', id: record.id, revision };
      },
      deleteRecord: async () => { throw new Error('Unexpected deletion'); },
    });
    const input = { id: profile.id, expectedRevision: 4, selections: [
      { envName: 'FIRST', selection: { kind: 'resource', resourceId: 'replacement', expectedResourceRevision: 7 } },
      { envName: 'SECOND', selection: { kind: 'resource', resourceId: 'replacement', expectedResourceRevision: 7 } },
      { envName: 'THIRD', selection: { kind: 'none' } },
    ] };
    const execute = createProfileActionExecuteV1({ operations, selectSecret: value => operations.selectSecret(value) });
    expect(await execute(parseProfileActionRequestV1('launch_profiles.secrets.select', input), {}))
      .toEqual({ ok: true, result: { status: 'updated', id: profile.id, revision: 5 } });
    expect(writes).toHaveLength(1);
    expect(record.secretBindings).toEqual({ FIRST: formatSharedSavedSecretRefV1('replacement'), SECOND: formatSharedSavedSecretRefV1('replacement'), THIRD: null, KEEP: null });
    expect(await execute(parseProfileActionRequestV1('launch_profiles.secrets.select', input), {}))
      .toMatchObject({ ok: true, result: { status: 'conflict', revision: 5 } });
    expect(() => parseProfileActionRequestV1('launch_profiles.secrets.select', { ...input, selections: [
      input.selections[0], { envName: 'INVALID NAME', selection: { kind: 'none' } },
    ] })).toThrow();
    expect(await execute(parseProfileActionRequestV1('launch_profiles.secrets.select', { ...input,
      expectedRevision: 5, selections: [input.selections[0],
        { envName: 'SECOND', selection: { kind: 'resource', resourceId: 'replacement', expectedResourceRevision: 8 } }],
    }), {})).toMatchObject({ ok: true, result: { status: 'invalid', reason: 'invalid_parameters' } });
    expect(writes).toHaveLength(1);
  });

  it('saves the editor projection and private binding changes together through the row owner', async () => {
    const profile = LaunchProfileV2Schema.parse({ v: 2, id: 'edited-profile', name: 'Edited', createdAt: 1, updatedAt: 2 });
    const previous = ProfileRecordV1Schema.parse({ v: 1, id: profile.id, definition: { kind: 'inline', profile },
      enabled: false, promptStack: [], secretBindings: { TOKEN: formatSharedSavedSecretRefV1('old-resource') } });
    const writes: ProfileRecordV1[] = [];
    const operations = createProfileOperations({
      readCatalog: () => ({ status: 'ready', records: [{ record: previous, revision: 4 }], diagnostics: [], referenceGuardRevision: 1, ...activeAuthority }),
      writeRecord: async ({ record, expectedRevision }) => {
        expect(expectedRevision).toBe(4);
        writes.push(record);
        return { status: 'updated', id: record.id, revision: 5 };
      },
      deleteRecord: async () => { throw new Error('Unexpected deletion'); },
    });
    const request = parseProfileActionRequestV1('launch_profiles.save', { id: profile.id, expectedRevision: 4,
      profile: { ...profile, enabled: false, profileRecordRevision: 4, promptStack: [], secretBindings: {} },
      secretBindings: { TOKEN: null } });
    expect(await createProfileActionExecuteV1({ operations })(request, {})).toMatchObject({ ok: true,
      result: { status: 'updated', revision: 5 } });
    expect(writes).toEqual([{ ...previous, secretBindings: { TOKEN: null } }]);
  });

  it('admits a captured first Artifact membership and an evidence-bearing legacy draft save', () => {
    const profile = LaunchProfileV2Schema.parse({ v: 2, id: 'received-profile', name: 'Received', createdAt: 1, updatedAt: 1 });
    expect(parseProfileActionRequestV1('launch_profiles.save', { id: profile.id, expectedRevision: 'absent',
      profile: { ...profile, artifactId: 'received-artifact', revision: { headerVersion: 2, bodyVersion: 3 }, shared: true },
      expectedArtifactRevision: { headerVersion: 2, bodyVersion: 3 } }).input).toMatchObject({ expectedRevision: 'absent' });
    const legacy = getBuiltInBackendProfile('azure-openai');
    if (!legacy) throw new Error('Canonical builtin unavailable');
    expect(parseProfileActionRequestV1('launch_profiles.save', { id: 'legacy-copy', expectedRevision: 'absent',
      profile: { ...legacy, id: 'legacy-copy', isBuiltIn: false },
      legacyCloneSource: { id: 'legacy-source', revision: 6 } }).input).toMatchObject({ legacyCloneSource: { revision: 6 } });
  });

  it('admits retained existing inline saves while keeping new Profile authoring strict', () => {
    const id = ` ${'converted-profile-'.repeat(20)} `;
    const record = ProfileRecordV1Schema.parse({ v: 1, id, definition: { kind: 'inline', profile: {
      v: 2, id, name: 'Converted', description: 'Retained metadata', createdAt: 1, updatedAt: 1,
      extraEnvironmentVariables: [{ name: 'PRIVATE_CONFIG', value: 'retained' }], placement: 'ask', checkout: 'create_worktree',
    } }, enabled: false, promptStack: [], secretBindings: { TOKEN: formatSharedSavedSecretRefV1('private-resource'), NONE: null } });
    if (record.definition.kind !== 'inline') throw new Error('Canonical converted inline fixture failed');
    const profile = { ...record.definition.profile, name: 'Edited converted', updatedAt: 2 };
    const input = { id, expectedRevision: 7, profile };
    const parsed = PROFILE_ACTION_INPUT_SCHEMAS_V1['launch_profiles.save'].safeParse(input);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parseProfileActionRequestV1('launch_profiles.save', input).input).toEqual(input);
    expect(PROFILE_ACTION_INPUT_SCHEMAS_V1['launch_profiles.create']
      .safeParse({ profile, expectedRevision: 'absent' }).success).toBe(false);
  });

  it('accepts actual visible builtin, inline and Artifact read projections and rejects unknown source fields', () => {
    const schema = PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.read'];
    const builtin = getBuiltInBackendProfile('azure-openai');
    if (!builtin) throw new Error('Canonical current builtin is unavailable');
    const profile = LaunchProfileV2Schema.parse({ v: 2, id: 'inline-profile', name: 'Inline', createdAt: 1, updatedAt: 1 });
    const inline = ProfileRecordV1Schema.parse({ v: 1, id: profile.id, definition: { kind: 'inline', profile },
      enabled: false, promptStack: [], secretBindings: { TOKEN: formatSharedSavedSecretRefV1('private-resource') } });
    const sharedProfile = { ...profile, id: 'granted-profile', name: 'Granted' };
    const artifact: ArtifactSharingResourceV1 = { artifactId: 'granted-artifact', access: 'view',
      header: { kind: 'launch-profile.v1', profileId: sharedProfile.id, name: sharedProfile.name },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile: sharedProfile,
        secretBindings: { SHARED_TOKEN: formatSharedSavedSecretRefV1('shared-resource') } }),
      revision: { headerVersion: 2, bodyVersion: 3 } };
    const membership = ProfileRecordV1Schema.parse({ ...inline, id: sharedProfile.id,
      definition: { kind: 'artifact', artifactId: artifact.artifactId } });
    const artifactsById = new Map([[artifact.artifactId, artifact]]);
    const opened = readAiLaunchProfileRecords([inline, membership], { artifactsById,
      recordRevisionsById: new Map([[inline.id, 4], [membership.id, 5]]) });
    const nonmember = readAiLaunchProfileRecords([], { artifactsById, includeShared: true }).entries[0];
    const inlineEntry = opened.entries[0];
    const memberEntry = opened.entries[1];
    if (!inlineEntry || inlineEntry.kind === 'opaque' || !memberEntry || memberEntry.kind === 'opaque'
      || !nonmember || nonmember.kind === 'opaque') throw new Error('Canonical opened Profile fixture failed');
    expect(inlineEntry.profile).toMatchObject({ enabled: false, promptStack: [],
      secretBindings: inline.secretBindings, profileRecordRevision: 4 });
    expect(memberEntry.profile).toMatchObject({ artifactId: artifact.artifactId, shared: true, viewOnly: true,
      revision: artifact.revision, enabled: false, promptStack: [], profileRecordRevision: 5,
      secretBindings: { ...inline.secretBindings, SHARED_TOKEN: formatSharedSavedSecretRefV1('shared-resource') } });
    const artifactLocation = { kind: 'artifact', artifactId: artifact.artifactId, ...artifact.revision, access: artifact.access };
    const results = [
      { status: 'present', profile: builtin, location: { kind: 'builtin' } },
      { status: 'present', profile: inlineEntry.profile, record: inline, revision: 4,
        location: { kind: 'account_row', revision: 4 } },
      { status: 'present', profile: nonmember.profile, location: artifactLocation },
      { status: 'present', profile: memberEntry.profile, record: membership, revision: 5, location: artifactLocation },
    ];
    for (const result of results) {
      expect.soft(schema.safeParse(result).success).toBe(true);
      expect.soft(schema.safeParse({ ...result, profile: { ...result.profile, futureAuthority: 'unadmitted' } }).success).toBe(false);
    }
    const grant = { status: 'present', profile: nonmember.profile, location: artifactLocation };
    expect(schema.safeParse({ ...grant, record: membership }).success).toBe(false);
    expect(schema.safeParse({ ...grant, revision: 5 }).success).toBe(false);
  });

  it('retains the durable delete acknowledgment with only a closed authoring-memory cleanup diagnostic', () => {
    const schema = PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.delete'];
    const acknowledgment = { status: 'updated', id: 'profile', revision: 4 };
    expect(schema.safeParse(acknowledgment).success).toBe(true);
    const cleanup = { status: 'unavailable', reason: 'authoring_memory_cleanup_failed' };
    expect(schema.safeParse({ ...acknowledgment, authoringMemoryCleanup: cleanup }).success).toBe(true);
    expect(schema.safeParse({ ...acknowledgment, authoringMemoryCleanup: { ...cleanup, detail: 'private context' } }).success).toBe(false);
    expect(schema.safeParse({ ...acknowledgment, authoringMemoryCleanup: { ...cleanup, status: 'failed' } }).success).toBe(false);
    expect(schema.safeParse({ ...acknowledgment, authoringMemoryCleanup: { ...cleanup, reason: 'different_failure' } }).success).toBe(false);
    expect(PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.save']
      .safeParse({ ...acknowledgment, authoringMemoryCleanup: cleanup }).success).toBe(false);
  });

  it('admits captured expected absence on existing secret-selection identities without inferring membership', () => {
    const input = { id: 'azure-openai', expectedRevision: 'absent', envName: 'TOKEN',
      selection: { kind: 'resource', resourceId: 'resource-a', expectedResourceRevision: 7 } };
    expect(parseProfileActionRequestV1('launch_profiles.secrets.select', input).input).toEqual(input);
    for (const id of ['granted-profile', 'unknown-profile', 'anthropic']) {
      expect(parseProfileActionRequestV1('launch_profiles.secrets.select', { ...input, id }).input).toEqual({ ...input, id });
    }
    const deselection = { ...input, selection: { kind: 'none' } };
    expect(parseProfileActionRequestV1('launch_profiles.secrets.select', deselection).input).toEqual(deselection);
    expect(() => parseProfileActionRequestV1('launch_profiles.secrets.select', {
      ...input, subject: { kind: 'builtin', id: 'azure-openai' },
    })).toThrow();
    expect(() => parseProfileActionRequestV1('launch_profiles.secrets.select', {
      ...input, expectedRevision: 'unobserved',
    })).toThrow();
  });

  it('admits captured row presence or absence and strict Artifact body pins when opening the existing editor', () => {
    const schema = PROFILE_ACTION_INPUT_SCHEMAS_V1['launch_profiles.edit'];
    const pin = { headerVersion: 2, bodyVersion: 3 };
    const inputs = [
      { id: 'azure-openai', expectedRevision: 'absent' },
      { id: 'inline-profile', expectedRevision: 4 },
      { id: 'granted-profile', expectedRevision: 'absent', expectedArtifactRevision: pin },
      { id: 'granted-profile', expectedRevision: 5, expectedArtifactRevision: pin },
    ];
    for (const input of inputs) {
      const parsed = schema.safeParse(input);
      expect.soft(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parseProfileActionRequestV1('launch_profiles.edit', input)).toEqual({ actionId: 'launch_profiles.edit', input });
      }
    }
    const addressed = { id: 'granted-profile', expectedRevision: 'absent', expectedArtifactRevision: pin };
    for (const input of [
      { ...addressed, expectedRevision: 'unobserved' },
      { ...addressed, expectedRevision: -1 },
      { ...addressed, expectedArtifactRevision: { headerVersion: 2 } },
      { ...addressed, expectedArtifactRevision: { ...pin, bodyVersion: 3.5 } },
      { ...addressed, expectedArtifactRevision: { ...pin, access: 'view' } },
      { ...addressed, subject: { kind: 'artifact', id: 'granted-profile' } },
    ]) expect(schema.safeParse(input).success).toBe(false);
    const absentRow = { id: 'inline-profile', expectedRevision: 'absent' };
    const profile = LaunchProfileV2Schema.parse({ v: 2, id: absentRow.id, name: 'Inline', createdAt: 1, updatedAt: 1 });
    expect(PROFILE_ACTION_INPUT_SCHEMAS_V1['launch_profiles.save'].safeParse({ ...absentRow, profile }).success).toBe(true);
    expect(PROFILE_ACTION_INPUT_SCHEMAS_V1['launch_profiles.duplicate']
      .safeParse({ ...absentRow, newProfileId: 'copy', name: 'Copy', now: 2 }).success).toBe(false);
    expect(PROFILE_ACTION_INPUT_SCHEMAS_V1['launch_profiles.delete'].safeParse(absentRow).success).toBe(false);
    expect(PROFILE_ACTION_INPUT_SCHEMAS_V1['launch_profiles.enabled.set'].safeParse({ ...absentRow, enabled: false }).success).toBe(false);
  });

  it('changes builtin enablement through the captured preference version without requiring a Profile binding row', async () => {
    let settingsVersion = 4;
    let enabled = true;
    const operations = createProfileOperations({
      readCatalog: () => ({ status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 1, ...activeAuthority }),
      writeRecord: async () => { throw new Error('Builtin preference must not create a row'); },
      deleteRecord: async () => { throw new Error('Builtin preference must not delete a row'); },
      setBuiltinEnabled: async input => {
        if (input.expectedSettingsVersion !== settingsVersion) return { status: 'conflict', id: input.subject.id, revision: settingsVersion };
        enabled = input.enabled;
        settingsVersion++;
        return { status: 'preference-updated', id: input.subject.id, enabled, settingsVersion };
      },
    });
    const execute = createProfileActionExecuteV1({ operations });
    const request = parseProfileActionRequestV1('launch_profiles.enabled.set', {
      subject: { kind: 'builtin', id: 'anthropic' }, expectedSettingsVersion: 4, enabled: false,
    });
    const result = await execute(request, {});
    expect(result).toEqual({ ok: true, result: { status: 'preference-updated', id: 'anthropic', enabled: false, settingsVersion: 5 } });
    if (!result.ok) throw new Error('Builtin preference update failed');
    expect(PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.enabled.set'].safeParse(result.result).success).toBe(true);
    expect(await execute(parseProfileActionRequestV1('launch_profiles.enabled.set', {
      subject: { kind: 'builtin', id: 'anthropic' }, expectedSettingsVersion: 4, enabled: true,
    }), {})).toMatchObject({ ok: true, result: { status: 'conflict' } });
    expect(enabled).toBe(false);
    expect(() => parseProfileActionRequestV1('launch_profiles.enabled.set', {
      subject: { kind: 'builtin', id: 'custom-profile' }, expectedSettingsVersion: 5, enabled: true,
    })).toThrow();
  });

  it('returns the actual host draft address so discard can target the opened editor', async () => {
    const execute = createProfileActionExecuteV1({
      operations: async () => { throw new Error('Editing is owned by the navigation host'); },
      edit: async ({ id }) => ({ status: 'opened', id, draftId: 'host-draft' }),
      discardDraft: async ({ draftId }) => ({ status: 'discarded', draftId }),
    });
    const opened = await execute({ actionId: 'launch_profiles.edit', input: { id: 'profile', expectedRevision: 2 } }, {});
    expect(opened).toEqual({ ok: true, result: { status: 'opened', id: 'profile', draftId: 'host-draft' } });
    if (!opened.ok) throw new Error('Editor navigation failed');
    expect(PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.edit'].safeParse(opened.result).success).toBe(true);
    expect(await execute({ actionId: 'launch_profiles.draft.discard', input: { draftId: 'host-draft' } }, {}))
      .toEqual({ ok: true, result: { status: 'discarded', draftId: 'host-draft' } });
  });

  it('admits immutable Resource ids only when their canonical shared binding fits the reference contract', () => {
    const input = (resourceId: string) => ({ id: 'profile', expectedRevision: 1, envName: 'TOKEN',
      selection: { kind: 'resource', resourceId, expectedResourceRevision: 2 } });
    const maximumId = 'r'.repeat(SAVED_SECRET_REF_MAX_LENGTH_V1 - SHARED_SAVED_SECRET_REF_V1_PREFIX.length);
    expect(parseProfileActionRequestV1('launch_profiles.secrets.select', input(maximumId)).input).toEqual(input(maximumId));
    expect(() => parseProfileActionRequestV1('launch_profiles.secrets.select', input(`${maximumId}r`))).toThrow();
    expect(() => parseProfileActionRequestV1('launch_profiles.secrets.select', input(formatSharedSavedSecretRefV1('resource')))).toThrow();
  });

  it('preserves the existing machine-environment favorite sentinel without reading Profile rows', async () => {
    let favorite = false;
    const execute = createProfileActionExecuteV1({
      operations: async () => { throw new Error('Profile catalog is unavailable'); },
      favorite: async input => { favorite = input.favorite; return { status: 'updated', ...input }; },
    });
    const request = parseProfileActionRequestV1('launch_profiles.favorite.set', { id: '', favorite: true });
    expect(await execute(request, {})).toEqual({ ok: true, result: { status: 'updated', id: '', favorite: true } });
    expect(favorite).toBe(true);
  });

  it('permits clearing selection while rows are locked and loads the real owner only for a row operation', async () => {
    let selected: string | null = 'old-profile';
    let unlocked = false;
    let stored: ProfileRecordV1 | undefined;
    const operations = createProfileOperations({
      readCatalog: () => ({ ...activeAuthority, status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 'absent' }),
      writeRecord: async ({ record }) => { stored = record; return { status: 'updated', id: record.id, revision: 0 }; },
      deleteRecord: async ({ id, expectedRevision }) => ({ status: 'updated', id, revision: expectedRevision + 1 }),
    });
    const execute = createProfileActionExecuteV1({
      // The host supplier opens Account rows through the external persistence/crypto boundary.
      operations: async () => { if (!unlocked) throw new Error('account rows locked'); return operations; },
      select: async ({ id }) => { selected = id; return { status: 'selected', id }; },
    });
    expect(await execute({ actionId: 'launch_profiles.select', input: { id: null } }, {}))
      .toEqual({ ok: true, result: { status: 'selected', id: null } });
    expect(selected).toBeNull();
    unlocked = true;
    const profile = LaunchProfileV2Schema.parse({ v: 2, id: 'new-profile', name: 'New', createdAt: 1, updatedAt: 1 });
    expect(await execute({ actionId: 'launch_profiles.create', input: { profile, expectedRevision: 'absent' } }, {}))
      .toEqual({ ok: true, result: { status: 'updated', id: profile.id, revision: 0 } });
    expect(stored?.definition).toEqual({ kind: 'inline', profile });
  });
});
