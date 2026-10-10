import { describe, expect, it, vi } from 'vitest';
import { AIBackendProfileSchema, type SavedSecret } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { resolveSavedSecretReference, applySavedSecretCatalogPage, resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { createProfileOperations } from '@happier-dev/protocol/profiles/profileOperations';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { readAiLaunchProfileRecords } from '@happier-dev/protocol/profiles/read';
import { SavedSecretResourceMaterialV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { decryptSecretValueWithKeysV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { materializeSavedSecretResources } from '@/sync/engine/settings/materializeSavedSecretResources';

import {
    assertLaunchProfileReviewCurrent,
    isLaunchProfileReviewCurrent,
    LaunchProfileEnvironmentUnavailableError,
    LaunchProfileReviewChangedError,
    materializeLaunchProfileEnvironment as materializeLaunchProfileEnvironmentOwner,
} from './profileHelpers';

type TestProfileInput = Omit<Parameters<typeof materializeLaunchProfileEnvironmentOwner>[0], 'resolveSavedSecretReference'>
    & Partial<Pick<Parameters<typeof materializeLaunchProfileEnvironmentOwner>[0], 'resolveSavedSecretReference'>>;

function materializeLaunchProfileEnvironment(input: TestProfileInput) {
    return materializeLaunchProfileEnvironmentOwner({
        ...input,
        resolveSavedSecretReference: input.resolveSavedSecretReference
            ?? ((ref) => resolveSavedSecretReference(null, input.secrets, ref)),
    });
}

function profile(updatedAt = 1) {
    return AIBackendProfileSchema.parse({
        id: 'work',
        name: 'Work',
        environmentVariables: [{ name: 'PROFILE_MODE', value: 'reviewed' }],
        envVarRequirements: [{ name: 'RUNNER_PROFILE_TOKEN', required: true, kind: 'secret' }],
        createdAt: 1,
        updatedAt,
    });
}

describe('New Session launch Profile materialization', () => {
    it('does not open an inherited Artifact secret after actual select-none while retaining neighboring launch material', async () => {
        const defaults = { TOKEN: 'happier:shared-secret:v1:default', NEIGHBOR: 'happier:shared-secret:v1:neighbor' };
        const privateRef = 'happier:shared-secret:v1:private';
        const definition = AIBackendProfileSchema.parse({ id: 'work', name: 'Work', environmentVariables: [],
            envVarRequirements: [{ name: 'TOKEN', kind: 'secret', required: false },
                { name: 'NEIGHBOR', kind: 'secret', required: true }, { name: 'KEEP', kind: 'secret', required: true }],
            createdAt: 1, updatedAt: 1 });
        let record = ProfileRecordV1Schema.parse({ v: 1, id: 'work', enabled: true, promptStack: [],
            definition: { kind: 'artifact', artifactId: 'published-work' }, secretBindings: { KEEP: privateRef } });
        const artifact = { artifactId: 'published-work', access: 'view' as const, revision: { headerVersion: 1, bodyVersion: 1 },
            header: { kind: 'launch-profile.v1', profileId: 'work', name: 'Work' },
            body: JSON.stringify({ kind: 'launch-profile.v1', profile: definition, secretBindings: defaults }) };
        const artifactsById = new Map([[artifact.artifactId, artifact]]);
        const operations = createProfileOperations({ readCatalog: () => ({ status: 'ready', source: 'destination', authority: 'active',
            records: [{ record, revision: 4 }], diagnostics: [], referenceGuardRevision: 5, controlRevision: 1,
            control: { revision: 1, record: { v: 1, phase: 'active', sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory: [] } } }),
            artifactsById: () => artifactsById,
            writeRecord: async input => { record = ProfileRecordV1Schema.parse(input.record); return { status: 'updated', id: record.id, revision: 5 }; },
            deleteRecord: async input => ({ status: 'updated', id: input.id, revision: 5 }) });
        await expect(operations.selectSecret({ id: record.id, expectedRevision: 4, envName: 'TOKEN', selection: { kind: 'none' } }))
            .resolves.toMatchObject({ status: 'updated' });
        const selected = readAiLaunchProfileRecords([record], { artifactsById }).entries[0];
        if (!selected || selected.kind === 'opaque') throw new Error('profile_definition_unavailable');
        const scope = { serverId: 'material-home', accountId: 'material-account' };
        const material = await materializeSavedSecretResources({ resources: ['default', 'neighbor', 'private'].map(resourceId =>
            SavedSecretResourceMaterialV1Schema.parse({ resourceId, encryptionMode: 'plain', recipientEnvelope: null,
                storedContent: { t: 'plain', v: { v: 1, name: resourceId, kind: 'token', value: `${resourceId}-material` } },
                entry: { ref: `happier:shared-secret:v1:${resourceId}`, source: 'shared_resource', relationship: 'owner',
                    name: resourceId, kind: 'token', revision: 1, materialStatus: 'ready',
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } })),
            decryptDataKeyEnvelope: async () => null });
        applySavedSecretCatalogPage({ scope, ...material, observedAt: 1, current: true });
        try {
            expect(materializeLaunchProfileEnvironmentOwner({ profile: AIBackendProfileSchema.parse(selected.profile),
                selectedAgentProviderOwnedEnvironmentKeys: [], secrets: [], defaultBindings: selected.profile.secretBindings,
                resolveSavedSecretReference: ref => resolveSavedSecretReference(scope, [], ref),
                decryptSecretValue: value => value ? decryptSecretValueWithKeysV1(value, []) : null,
            })).toEqual({ ok: true, environmentVariables: { NEIGHBOR: 'neighbor-material', KEEP: 'private-material' } });
        } finally {
            resetSavedSecretCatalogSnapshotsForTests();
        }
    });
    it('refuses retained shared material without current catalog admission', () => {
        const ref = 'happier:shared-secret:v1:profile-token';
        expect(materializeLaunchProfileEnvironment({
            profile: profile(),
            selectedAgentProviderOwnedEnvironmentKeys: [],
            secrets: [{
                id: ref, name: 'Retained shared token', kind: 'token',
                encryptedValue: { _isSecretValue: true, value: 'stale-material' },
                createdAt: 1, updatedAt: 1,
            }],
            selectedSecretIds: { RUNNER_PROFILE_TOKEN: ref },
            machineEnvReadyByName: { RUNNER_PROFILE_TOKEN: false },
            resolveSavedSecretReference: (selectedRef) => resolveSavedSecretReference(
                { serverId: 'unloaded-home', accountId: 'owner' }, [], selectedRef,
            ),
            decryptSecretValue: (value) => value?.value ?? null,
        })).toEqual({ ok: false, reason: 'secret_requirement_unsatisfied' });
    });

    it('materializes the exact selected secret into the reviewed environment snapshot', () => {
        const result = materializeLaunchProfileEnvironment({
            profile: profile(),
            selectedAgentProviderOwnedEnvironmentKeys: [],
            secrets: [{
                id: 'secret-work',
                name: 'Work token',
                encryptedValue: { _isSecretValue: true, value: 'sealed-value' },
                createdAt: 1,
                updatedAt: 1,
                kind: 'token',
            }],
            selectedSecretIds: { RUNNER_PROFILE_TOKEN: 'secret-work' },
            machineEnvReadyByName: { RUNNER_PROFILE_TOKEN: false },
            decryptSecretValue: (value) => value?.value ?? null,
        });

        expect(result).toEqual({
            ok: true,
            environmentVariables: {
                PROFILE_MODE: 'reviewed',
                RUNNER_PROFILE_TOKEN: 'sealed-value',
            },
        });
    });

    it('materializes a whitespace-only Enter Once value without normalization', () => {
        expect(materializeLaunchProfileEnvironment({
            profile: profile(),
            selectedAgentProviderOwnedEnvironmentKeys: [],
            secrets: [],
            sessionOnlyValues: { RUNNER_PROFILE_TOKEN: '   ' },
            machineEnvReadyByName: { RUNNER_PROFILE_TOKEN: false },
            decryptSecretValue: () => null,
        })).toEqual({
            ok: true,
            environmentVariables: { PROFILE_MODE: 'reviewed', RUNNER_PROFILE_TOKEN: '   ' },
        });
    });

    it('fails closed when selected SavedSecret material cannot be decrypted', () => {
        const result = materializeLaunchProfileEnvironment({
            profile: profile(),
            selectedAgentProviderOwnedEnvironmentKeys: [],
            secrets: [{
                id: 'secret-work',
                name: 'Work token',
                encryptedValue: { _isSecretValue: true, value: 'sealed-value' },
                createdAt: 1,
                updatedAt: 1,
                kind: 'token',
            }],
            selectedSecretIds: { RUNNER_PROFILE_TOKEN: 'secret-work' },
            machineEnvReadyByName: { RUNNER_PROFILE_TOKEN: false },
            decryptSecretValue: () => null,
        });
        expect(result).toEqual({ ok: false, reason: 'secret_requirement_unsatisfied' });
        if (result.ok) throw new Error('Expected unresolved Profile environment');
        expect(new LaunchProfileEnvironmentUnavailableError(result.reason)).toMatchObject({
            name: 'LaunchProfileEnvironmentUnavailableError',
            code: 'runner_profile_environment_unavailable',
            reason: 'secret_requirement_unsatisfied',
        });
    });

    it('keeps provider-owned Profile secrets on the canonical broker path without decrypting them', () => {
        const decryptSecretValue = vi.fn((value: SavedSecret['encryptedValue'] | null | undefined) => value?.value ?? null);
        const result = materializeLaunchProfileEnvironment({
            profile: AIBackendProfileSchema.parse({
                id: 'azure-work',
                name: 'Azure work',
                environmentVariables: [
                    { name: 'AZURE_OPENAI_API_VERSION', value: '2024-02-15-preview' },
                    { name: 'HAPPIER_CODEX_PROVIDER_API_KEY', value: 'must-not-reach-runner' },
                    { name: 'PROFILE_MODE', value: 'reviewed' },
                ],
                envVarRequirements: [
                    { name: 'AZURE_OPENAI_API_KEY', required: true, kind: 'secret' },
                    { name: 'HAPPIER_CODEX_PROVIDER_API_KEY', required: true, kind: 'secret' },
                    { name: 'RUNNER_PROFILE_TOKEN', required: true, kind: 'secret' },
                ],
            }),
            selectedAgentProviderOwnedEnvironmentKeys: ['HAPPIER_CODEX_PROVIDER_API_KEY'],
            secrets: [
                {
                    id: 'azure-secret',
                    name: 'Azure key',
                    encryptedValue: { _isSecretValue: true, value: 'azure-direct-secret' },
                    createdAt: 1,
                    updatedAt: 1,
                    kind: 'token',
                },
                {
                    id: 'codex-provider-secret',
                    name: 'Codex provider key',
                    encryptedValue: { _isSecretValue: true, value: 'codex-direct-secret' },
                    createdAt: 1,
                    updatedAt: 1,
                    kind: 'token',
                },
                {
                    id: 'ordinary-secret',
                    name: 'Ordinary Profile token',
                    encryptedValue: { _isSecretValue: true, value: 'ordinary-profile-secret' },
                    createdAt: 1,
                    updatedAt: 1,
                    kind: 'token',
                },
            ],
            selectedSecretIds: {
                AZURE_OPENAI_API_KEY: 'azure-secret',
                HAPPIER_CODEX_PROVIDER_API_KEY: 'codex-provider-secret',
                RUNNER_PROFILE_TOKEN: 'ordinary-secret',
            },
            machineEnvReadyByName: {
                AZURE_OPENAI_API_KEY: false,
                HAPPIER_CODEX_PROVIDER_API_KEY: false,
                RUNNER_PROFILE_TOKEN: false,
            },
            decryptSecretValue,
        });

        expect(result).toEqual({
            ok: true,
            environmentVariables: {
                PROFILE_MODE: 'reviewed',
                RUNNER_PROFILE_TOKEN: 'ordinary-profile-secret',
            },
        });
        expect(decryptSecretValue).toHaveBeenCalledTimes(1);
        expect(decryptSecretValue).toHaveBeenCalledWith(expect.objectContaining({ value: 'ordinary-profile-secret' }));
    });

    it('classifies only its own deterministic preflight failures as Profile incompatibilities', async () => {
        const { resolveLaunchProfileIncompatibility } = await import('./profileHelpers');
        expect(resolveLaunchProfileIncompatibility(
            new LaunchProfileEnvironmentUnavailableError('secret_requirement_unsatisfied'),
        )).toBe('profile_environment_unavailable');
        expect(resolveLaunchProfileIncompatibility(new LaunchProfileReviewChangedError())).toBe('profile_changed');
        // A transport or transient failure keeps its ordinary retryable handling.
        expect(resolveLaunchProfileIncompatibility(new Error('network unreachable'))).toBeNull();
        expect(resolveLaunchProfileIncompatibility(null)).toBeNull();
    });

    it('fails currentness when the reviewed Profile changed before activation preparation', () => {
        expect(isLaunchProfileReviewCurrent(profile(1), profile(2))).toBe(false);
        expect(isLaunchProfileReviewCurrent(profile(1), profile(1))).toBe(true);
        expect(() => assertLaunchProfileReviewCurrent(profile(1), profile(2))).toThrow(
            expect.objectContaining({
                name: 'LaunchProfileReviewChangedError',
                code: 'runner_profile_selection_changed',
            }),
        );
    });
});
