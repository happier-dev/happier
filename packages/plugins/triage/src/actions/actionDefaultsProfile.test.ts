import { describe, expect, it } from 'vitest';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import { createProfileOperations } from '@happier-dev/protocol/profiles/profileOperations';
import { createProfileActionExecuteV1, parseProfileActionRequestV1, type ProfileActionIdV1 } from '@happier-dev/protocol/profiles/profileActionsV1';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordSchemaV1';
import { LaunchProfileV2Schema } from '@happier-dev/protocol/profiles/v2/schema';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { saveTriageActionDefaultProfileV1 } from './actionDefaultsProfile.js';

function fixture(legacy = false) {
    const original = ProfileRecordV1Schema.parse({ v: 1, id: 'shared', enabled: true,
        definition: { kind: 'inline', profile: LaunchProfileV2Schema.parse({ v: 2, id: 'shared', name: 'Shared',
            createdAt: 1, updatedAt: 1, extraEnvironmentVariables: [{ name: 'FLAVOR', value: 'retained' }],
            preferredAgentTargetKey: 'agent:codex', defaultPermissionModeByTargetKey: { 'agent:codex': 'safe-yolo' },
            defaultPersistenceModeByTargetKey: { 'agent:codex': 'direct' }, compatibilityByTargetKey: { 'agent:codex': true } }) },
        secretBindings: { TOKEN: 'secret-token', OMITTED: null }, skillSeeds: ['skill-1'],
        promptStack: [{ id: 'prompt', ref: { kind: 'doc', artifactId: 'doc-1' }, enabled: true, placement: 'system_append' }] });
    if (original.definition.kind !== 'inline') throw new Error('Expected inline fixture');
    const sourceProfile = original.definition.profile;
    if (legacy) original.definition = ProfileRecordV1Schema.parse({ ...original, definition: { kind: 'legacy', profile: {
        id: original.id, name: 'Shared', environmentVariables: [{ name: 'FLAVOR', value: 'retained' }],
        envVarRequirements: [], authMode: 'machineLogin', requiresMachineLogin: 'codex', requiresMachineLoginTargetKey: 'agent:codex',
        defaultPermissionModeByTargetKey: {}, defaultPermissionModeByAgent: {}, defaultPersistenceModeByTargetKey: {},
        defaultPersistenceModeByAgent: {}, compatibilityByTargetKey: { 'agent:custom-acp': true }, compatibility: { customAcp: true },
        createdAt: 1, updatedAt: 1,
    } } }).definition;
    const rows = new Map([[original.id, { record: original, revision: 2 }]]);
    const artifacts = new Map<string, ArtifactSharingResourceV1>();
    const operations = createProfileOperations({
        artifactsById: () => artifacts,
        readCatalog: () => ({ status: 'ready', source: 'destination', authority: 'active', controlRevision: 1,
            control: { revision: 1, record: { v: 1, phase: 'active', sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory: [] } },
            records: [...rows.values()], diagnostics: [], referenceGuardRevision: 1 }),
        writeRecord: async input => {
            const previous = rows.get(input.record.id);
            if (input.expectedRevision !== (previous?.revision ?? 'absent')) return { status: 'conflict', id: input.record.id, revision: previous?.revision ?? -1 };
            const revision = (previous?.revision ?? 0) + 1;
            rows.set(input.record.id, { record: ProfileRecordV1Schema.parse(input.record), revision });
            return { status: 'updated', id: input.record.id, revision };
        },
        deleteRecord: async () => { throw new Error('Unexpected delete'); },
    });
    const host = createProfileActionExecuteV1({ operations });
    let serial = 0;
    // The host Action transport is a genuine boundary; retain its real parsers and Profile owner.
    const actions = { execute: async (id: string, input: unknown) => {
        const result = await host(parseProfileActionRequestV1(id as ProfileActionIdV1, input), {});
        if (!result.ok) throw new Error(result.errorCode);
        return result.result;
    } } as unknown as Pick<ActionsService, 'execute'>;
    return { rows, original, sourceProfile, artifacts, operations, deps: { actions, mintId: () => `owned-${++serial}` } };
}

describe('action-owned Profile defaults', () => {
    it('keeps a private managed-directory default tied to its fixed target', async () => {
        const f = fixture();
        const placement = { fixed: { serverId: 'server-1', machineId: 'machine-1' }, directoryIntent: { kind: 'managed' as const } };
        const result = await saveTriageActionDefaultProfileV1({ profileId: 'shared', placement, checkout: 'reuse_workspace' }, f.deps);
        expect(f.rows.get(result.profileId)?.record).toMatchObject({ definition: { kind: 'inline', profile: { placement } } });
        expect(f.rows.get('shared')?.record.definition).toEqual(f.original.definition);
    });

    it('retains selected Profile settings and attachments without mutating the reusable source', async () => {
        const f = fixture();
        const original = structuredClone(f.original);
        const result = await saveTriageActionDefaultProfileV1({ profileId: 'shared', placement: 'ask', checkout: 'create_worktree' }, f.deps);
        expect(result).toEqual({ profileId: 'owned-1' });
        expect(f.rows.get('shared')?.record).toEqual(original);
        expect(f.rows.get(result.profileId)?.record).toMatchObject({ secretBindings: f.original.secretBindings,
            skillSeeds: f.original.skillSeeds, promptStack: f.original.promptStack, definition: { kind: 'inline', profile: {
                ...f.sourceProfile, id: result.profileId, name: expect.any(String),
                createdAt: expect.any(Number), updatedAt: expect.any(Number), placement: 'ask', checkout: 'create_worktree',
            } } });
    });

    it('reuses the selected owned Profile on later saves', async () => {
        const f = fixture();
        const input = { profileId: 'shared', placement: 'ask' as const, checkout: 'create_worktree' as const };
        const first = await saveTriageActionDefaultProfileV1(input, f.deps);
        const next = await saveTriageActionDefaultProfileV1({ ...input, profileId: first.profileId,
            ownedProfileId: first.profileId, checkout: 'reuse_workspace' }, f.deps);
        expect(next).toEqual(first);
        expect(f.rows.size).toBe(2);
        expect(f.rows.get(first.profileId)?.record).toMatchObject({ definition: { profile: { checkout: 'reuse_workspace' } },
            secretBindings: f.original.secretBindings, promptStack: f.original.promptStack, skillSeeds: f.original.skillSeeds });
    });

    it('snapshots an explicitly reselected shared Profile after its defaults changed', async () => {
        const f = fixture();
        const input = { profileId: 'shared', placement: 'ask' as const, checkout: 'ask' as const };
        const first = await saveTriageActionDefaultProfileV1(input, f.deps);
        const firstSnapshot = structuredClone(f.rows.get(first.profileId)?.record);
        const changedSource = ProfileRecordV1Schema.parse({ ...f.original,
            definition: { kind: 'inline', profile: { ...f.sourceProfile,
                extraEnvironmentVariables: [{ name: 'FLAVOR', value: 'changed' }], updatedAt: 2 } },
            secretBindings: { TOKEN: 'changed-secret' },
        });
        f.rows.set('shared', { record: changedSource, revision: 3 });

        const next = await saveTriageActionDefaultProfileV1({ ...input, ownedProfileId: first.profileId }, f.deps);

        expect(next.profileId).not.toBe(first.profileId);
        expect(f.rows.get(next.profileId)?.record).toMatchObject({ secretBindings: { TOKEN: 'changed-secret' },
            definition: { kind: 'inline', profile: { extraEnvironmentVariables: [{ name: 'FLAVOR', value: 'changed' }] } } });
        expect(f.rows.get(first.profileId)?.record).toEqual(firstSnapshot);
        expect(f.rows.get('shared')?.record).toEqual(changedSource);
    });

    it('creates a modern Profile for machine defaults and replaces the snapshot when its source changes', async () => {
        const f = fixture();
        const first = await saveTriageActionDefaultProfileV1({ profileId: null, placement: 'automatic', checkout: 'ask' }, f.deps);
        expect(first).toEqual({ profileId: 'owned-1' });
        expect(f.rows.get(first.profileId)?.record).toMatchObject({ definition: { kind: 'inline', profile: { v: 2, placement: 'automatic', checkout: 'ask' } } });
        expect(await saveTriageActionDefaultProfileV1({ profileId: first.profileId, placement: 'automatic', checkout: 'ask',
            ownedProfileId: first.profileId }, f.deps)).toEqual(first);
        expect(f.rows.size).toBe(2);
        const next = await saveTriageActionDefaultProfileV1({ profileId: 'shared', placement: 'ask', checkout: 'ask',
            ownedProfileId: first.profileId }, f.deps);
        expect(next).toEqual({ profileId: 'owned-2' });
    });

    it('preserves legacy machine-login and backend compatibility while saving launch preferences', async () => {
        const f = fixture(true);
        const original = structuredClone(f.original);
        if (original.definition.kind !== 'legacy') throw new Error('Expected legacy source');
        const result = await saveTriageActionDefaultProfileV1({ profileId: 'shared', placement: 'ask', checkout: 'create_worktree' }, f.deps);
        expect(f.rows.get('shared')?.record).toEqual(original);
        expect(f.rows.get(result.profileId)?.record).toMatchObject({ secretBindings: f.original.secretBindings,
            promptStack: f.original.promptStack, skillSeeds: f.original.skillSeeds, definition: { kind: 'legacy', profile: {
                authMode: 'machineLogin', requiresMachineLogin: 'codex',
                requiresMachineLoginTargetKey: original.definition.profile.requiresMachineLoginTargetKey,
                compatibilityByTargetKey: { 'agent:custom-acp': true }, compatibility: { customAcp: true },
                environmentVariables: [{ name: 'FLAVOR', value: 'retained' }], placement: 'ask', checkout: 'create_worktree',
            } } });
    });

    it('surfaces the Profile owner refusal without replacing missing defaults', async () => {
        const f = fixture();
        await expect(saveTriageActionDefaultProfileV1({ profileId: 'missing', placement: 'ask', checkout: 'ask' }, f.deps))
            .rejects.toMatchObject({ code: 'profile-not-found' });
        expect(f.rows.size).toBe(1);
    });

    it.each([true, false])('detaches an Artifact Profile without rewriting its shared body (membership: %s)', async membership => {
        const f = fixture();
        const body = JSON.stringify({ kind: 'launch-profile.v1', profile: { ...f.sourceProfile, extraEnvironmentVariables: [] }, secretBindings: { TOKEN: 'secret-token' } });
        f.artifacts.set('shared-body', { artifactId: 'shared-body', access: 'edit', body,
            header: { kind: 'launch-profile.v1', profileId: 'shared', name: 'Shared' }, revision: { headerVersion: 2, bodyVersion: 3 } });
        if (membership) f.rows.set('shared', { record: { ...f.original, definition: { kind: 'artifact', artifactId: 'shared-body' } }, revision: 2 });
        else f.rows.delete('shared');
        const source = f.operations.read({ id: 'shared' });
        if (source.status !== 'present') throw new Error('Expected readable Artifact source');
        const result = await saveTriageActionDefaultProfileV1({ profileId: 'shared', placement: 'ask', checkout: 'ask' }, f.deps);
        expect(f.artifacts.get('shared-body')?.body).toBe(body);
        expect(f.rows.get(result.profileId)?.record).toMatchObject({ definition: { kind: 'inline', profile: {
            id: result.profileId, placement: 'ask', checkout: 'ask', preferredAgentTargetKey: source.profile.preferredAgentTargetKey,
        } }, secretBindings: membership ? f.original.secretBindings : { TOKEN: 'secret-token' } });
    });
});
