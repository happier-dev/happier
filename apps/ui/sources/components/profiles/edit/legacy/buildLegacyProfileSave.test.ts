import { describe, expect, it } from 'vitest';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { createProfileDuplicateDraftV1, createProfileOperations } from '@happier-dev/protocol/profiles/profileOperations';
import { readAiLaunchProfileRecords } from '@happier-dev/protocol/profiles/read';
import { buildLegacyProfileSave } from './buildLegacyProfileSave';

describe('captured legacy clone editor preparation', () => {
    it('preserves an unchanged captured body on a name-only save and refuses normalized body edits at the owner', async () => {
        const source = ProfileRecordV1Schema.parse({ v: 1, id: 'source', enabled: false, promptStack: [], secretBindings: { MASKED: null },
            definition: { kind: 'legacy', profile: AIBackendProfileSchema.parse({ id: 'source', name: 'Original', authMode: 'machineLogin',
                requiresMachineLogin: 'claude', environmentVariables: [{ name: 'PUBLIC_CONFIG', value: 'kept' }],
                defaultPermissionMode: 'default', defaultPermissionModeByAgent: { claude: 'default' },
                defaultPersistenceModeByAgent: { claude: 'persisted' }, compatibility: { claude: true }, createdAt: 1, updatedAt: 2 }) } });
        const opened = readAiLaunchProfileRecords([source], { artifactsById: new Map(), recordRevisionsById: new Map([[source.id, 4]]) }).entries[0];
        if (!opened || opened.kind !== 'legacy') throw new Error('Expected a captured legacy source');
        const draft = createProfileDuplicateDraftV1({ profile: opened.profile, sourceRow: { record: source, revision: 4 },
            newProfileId: 'copy', name: 'Copy', now: 10 });
        if (draft.status !== 'draft' || 'v' in draft.profile) throw new Error('Expected a lossless legacy draft');
        const input = { profile: draft.profile, name: 'Named copy', environmentVariables: draft.profile.environmentVariables,
            envVarRequirements: draft.profile.envVarRequirements, authMode: draft.profile.authMode, machineLoginTargetKey: 'agent:claude',
            resolvedBackendEntries: [], supportedDirectBackendEntries: [], defaultPermissionModesByTargetKey: {},
            defaultTranscriptStorageModesByTargetKey: {}, compatibilityByTargetKey: {}, updatedAt: 20 };
        const unchanged = buildLegacyProfileSave({ ...input, preserveSourceDefinition: true });
        expect(unchanged).toEqual({ ...draft.profile, name: 'Named copy', updatedAt: 20 });
        const writes: unknown[] = [];
        const owner = createProfileOperations({ readCatalog: () => ({ status: 'ready', source: 'destination', authority: 'active',
            control: null, controlRevision: 'absent', referenceGuardRevision: 5, records: [{ record: source, revision: 4 }], diagnostics: [] }),
            writeRecord: async value => { writes.push(value); return { status: 'updated', id: value.record.id, revision: 0 }; },
            deleteRecord: async value => ({ status: 'updated', id: value.id, revision: 0 }) });
        expect(await owner.save({ profile: unchanged, expectedRevision: 'absent', secretBindings: draft.secretBindings,
            legacyCloneSource: draft.legacyCloneSource })).toMatchObject({ status: 'updated', id: 'copy' });
        const edited = buildLegacyProfileSave({ ...input, preserveSourceDefinition: false,
            environmentVariables: [{ name: 'PUBLIC_CONFIG', value: 'edited' }] });
        expect(await owner.save({ profile: edited, expectedRevision: 'absent', secretBindings: draft.secretBindings,
            legacyCloneSource: draft.legacyCloneSource })).toMatchObject({ status: 'invalid', reason: 'legacy-creation-unsupported' });
        expect(writes).toHaveLength(1);
    });
});
