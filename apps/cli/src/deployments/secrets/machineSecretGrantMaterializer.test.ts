import { afterEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { createSavedSecretMaterializerV1, type SavedSecretCatalogResourceInputV1 } from '@/settings/secrets/savedSecretCatalog';
import { prepareEnvironmentSecretBindings } from './environmentSecretBindingService';
import { prepareEnvironmentSecretBindingsForLaunch } from './prepareEnvironmentSecretBindingsForLaunch';
import * as custody from './machineSecretGrant';
import { projectDeploymentFailure } from '@/deployments/deploymentFailure';

afterEach(() => vi.restoreAllMocks());

const seed = new Uint8Array(32).fill(42);
const installation = { machineId: 'runtime', installationId: 'installed', publicKey: nacl.sign.keyPair.fromSeed(seed).publicKey };
const assertCurrent = async () => {};
const ref = formatSharedSavedSecretRefV1('credential');
const binding: EnvironmentSecretBindingV1 = { purpose: 'variable', phase: 'runtime', name: 'PASSWORD',
    grantRef: '00000000-0000-4000-8000-000000000001', source: { kind: 'secret', ref, resourceRevision: 3 } };

function resource(mode: 'plain' | 'e2ee'): SavedSecretCatalogResourceInputV1 {
    const key = new Uint8Array(32).fill(9);
    const content = { v: 1 as const, name: 'Database credential', kind: 'password' as const, value: 'materializer-sentinel-83bf' };
    return {
        resourceId: 'credential', ownerAccountId: 'resource-owner', displayName: content.name,
        kind: content.kind, encryptionMode: mode, revision: 3, materialStatus: 'ready', capabilities: { use: true },
        ...(mode === 'e2ee' ? { resourceDataKey: key } : {}),
        storedContent: mode === 'plain' ? { t: 'plain', v: content }
            : sealSavedSecretResourceStoredContentV1({ resourceId: 'credential', mode, resourceDataKey: key,
                content, randomBytes: length => new Uint8Array(length).fill(17) }),
    };
}

function materializer(row: SavedSecretCatalogResourceInputV1) {
    return createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [],
        resources: [row], resourceCatalogState: 'ready', isCurrent: () => true });
}

async function prepare(row: SavedSecretCatalogResourceInputV1, bindings = [binding]) {
    return prepareEnvironmentSecretBindings({ environmentId: 'environment', bindings, previousBindings: [],
        runtimeInstallations: [installation], existingGrants: [], materializer: materializer(row), assertCurrent });
}

describe('exact installation grant materialization through Saved Secrets', () => {
    it('names unavailable bound secrets without disclosing their references or values', async () => {
        const emptyGrant = custody.sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: 'environment',
            machineId: installation.machineId, installationId: installation.installationId, resourceId: 'credential', resourceRevision: 3 },
            installationPublicKey: installation.publicKey, content: { kind: 'secret', value: '' } });
        for (const grants of [[], [emptyGrant]]) {
            const error = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: 'environment', machineId: installation.machineId,
                installationId: installation.installationId, installationPrivateSeed: seed, phase: 'runtime',
                bindings: [binding], grants, assertCurrent }).catch(error => error);
            expect(error).toMatchObject({ data: { code: 'secret_missing', details: { missingRequiredSecretNames: ['PASSWORD'], deployable: false } } });
            expect(projectDeploymentFailure('secret_missing', error)).toMatchObject({ ok: false, errorCode: 'secret_missing',
                details: { missingRequiredSecretNames: ['PASSWORD'], deployable: false } });
            expect(JSON.stringify(error)).not.toMatch(/credential|materializer-sentinel/);
        }
    });

    it('reports required project declarations that have no runtime secret binding', async () => {
        await expect(prepareEnvironmentSecretBindingsForLaunch({ environmentId: 'environment', machineId: installation.machineId,
            installationId: installation.installationId, installationPrivateSeed: seed, phase: 'runtime',
            requirements: [{ name: 'MISSING', kind: 'secret', required: true }, { name: 'OPTIONAL', kind: 'secret', required: false },
                { name: 'CONFIG', kind: 'config', required: true }],
            bindings: [], grants: [], assertCurrent })).rejects.toMatchObject({ data: { code: 'secret_missing',
                details: { missingRequiredSecretNames: ['MISSING'], deployable: false } } });
    });

    it('refuses wrong-mode, inaccessible, stale and missing-key material with the deployment secret refusal', async () => {
        const plain = resource('plain');
        const encrypted = resource('e2ee');
        for (const row of [
            { ...plain, encryptionMode: 'e2ee' as const },
            { ...encrypted, encryptionMode: 'plain' as const },
            { ...plain, capabilities: { use: false } },
            { ...plain, revision: 4 },
            { ...encrypted, resourceDataKey: undefined },
        ]) {
            await expect(prepare(row)).rejects.toMatchObject({ data: { code: 'secret_missing' } });
        }
    });

    it.each(['plain', 'e2ee'] as const)('opens one %s revision for two exact names, without Account keys on the target', async mode => {
        const row = resource(mode);
        const second: EnvironmentSecretBindingV1 = { ...binding, name: 'PASSWORD_ALIAS',
            grantRef: '00000000-0000-4000-8000-000000000002' };
        const bindings = [binding, second];
        const prepared = await prepare(row, bindings);
        expect(prepared.grants).toHaveLength(1);
        expect(prepared.referencedSavedSecretRevisions).toEqual([{ resourceId: 'credential', revision: 3,
            requiredBindings: [{ purpose: 'variable', phase: 'runtime' }] }]);
        expect(JSON.stringify(prepared)).not.toContain('materializer-sentinel-83bf');
        // Call-through instrumentation measures the explicit once-per-revision
        // cost contract; the opener and all crypto/domain logic stay real.
        const opens = vi.spyOn(custody, 'openMachineSecretGrant');
        const launch = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: 'environment', machineId: installation.machineId,
            installationId: installation.installationId, installationPrivateSeed: seed, phase: 'runtime',
            bindings, grants: prepared.grants, assertCurrent });
        expect(launch.env).toEqual({ PASSWORD: 'materializer-sentinel-83bf', PASSWORD_ALIAS: 'materializer-sentinel-83bf' });
        expect(opens).toHaveBeenCalledTimes(1);
        expect(launch.secretValues).toEqual(['materializer-sentinel-83bf']);
        expect(launch.refs).toEqual([{ resourceId: 'credential', resourceRevision: 3 }]);
        launch.dispose();
        expect(Object.keys(launch.env)).toEqual([]);
        await expect(launch.recheck()).rejects.toMatchObject({ data: { code: 'secret_missing' } });
    });

    it('keeps non-secret variable names inside the installation envelope while the daemon still injects them', async () => {
        const bindings: EnvironmentSecretBindingV1[] = [
            { purpose: 'variable', phase: 'runtime', name: 'PUBLIC_ENDPOINT', grantRef: '00000000-0000-4000-8000-000000000003',
                source: { kind: 'value', value: 'https://api.example.test' } },
            { purpose: 'variable', phase: 'runtime', name: 'PUBLIC_REGION', grantRef: '00000000-0000-4000-8000-000000000004',
                source: { kind: 'value', value: 'eu-west-1' } },
        ];
        const prepared = await prepareEnvironmentSecretBindings({ environmentId: 'environment', bindings, previousBindings: [],
            runtimeInstallations: [installation], existingGrants: [], assertCurrent });

        expect(JSON.stringify(prepared.grants)).not.toContain('PUBLIC_ENDPOINT');
        expect(JSON.stringify(prepared.grants)).not.toContain('PUBLIC_REGION');

        const launch = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: 'environment', machineId: installation.machineId,
            installationId: installation.installationId, installationPrivateSeed: seed, phase: 'runtime',
            bindings, grants: prepared.grants, assertCurrent });
        expect(launch.env).toEqual({ PUBLIC_ENDPOINT: 'https://api.example.test', PUBLIC_REGION: 'eu-west-1' });
        launch.dispose();
    });

    it('rejects replaced installation, withdrawn grants and tampered ciphertext before returning an overlay', async () => {
        const row = resource('e2ee');
        const prepared = await prepare(row);
        const input = { environmentId: 'environment', machineId: installation.machineId,
            installationId: installation.installationId, installationPrivateSeed: seed, phase: 'runtime' as const,
            bindings: [binding], grants: prepared.grants, assertCurrent };
        for (const changed of [
            { installationId: 'replacement' },
            { environmentId: 'another-environment' },
            { installationPrivateSeed: new Uint8Array(32).fill(4) },
            // Withdrawal deletes the installation row. The authenticated private
            // reader can return an empty set; this owner still knows the binding.
            { grants: [] },
            { grants: prepared.grants.map(grant => ({ ...grant, sealedContent: grant.sealedContent.slice(0, -8) })) },
        ]) {
            await expect(prepareEnvironmentSecretBindingsForLaunch({ ...input, ...changed }))
                .rejects.toMatchObject({ data: { code: 'secret_missing' } });
        }
    });
});
