import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { captureDeploymentBindingSavedSecretRevisionsV1, type EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createSavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import { prepareEnvironmentSecretBindings } from './environmentSecretBindingService';
import { prepareEnvironmentSecretBindingsForLaunch } from './prepareEnvironmentSecretBindingsForLaunch';

const variable = (name: string, phase: 'build' | 'runtime',
    source: Extract<EnvironmentSecretBindingV1, { purpose: 'variable' }>['source']) => ({
    purpose: 'variable' as const, name, phase, grantRef: crypto.randomUUID(), source,
});

// This is the P42 custody hop, not another program journey. The real P40
// transaction/Action/daemon assertions belong in deploymentComposeJourney.
describe('S0 exact installation secret custody', () => {
    const seed = new Uint8Array(32).fill(37);
    const publicKey = tweetnacl.sign.keyPair.fromSeed(seed).publicKey;
    const secret = 's0-runtime-secret-sentinel-48b19';
    const ref = formatSharedSavedSecretRefV1('runtime-credential');
    const bindings: readonly EnvironmentSecretBindingV1[] = [
        variable('S0_SECRET', 'runtime', { kind: 'secret', ref, resourceRevision: 1 }),
        variable('PORT', 'runtime', { kind: 'value', value: '3000' }),
    ];
    const installation = { machineId: 's0-guest', installationId: 's0-installation', publicKey };
    // This callback is the admitted storage/transport boundary. The program
    // journey exercises the real authority/CAS producer rather than mocking it.
    const assertCurrent = async () => {};

    function materializer() {
        const resourceDataKey = new Uint8Array(32).fill(11);
        return createSavedSecretMaterializerV1({
            accountSettings: {}, settingsSecretsReadKeys: [], resourceCatalogState: 'ready', isCurrent: () => true,
            resources: [{
                resourceId: 'runtime-credential', ownerAccountId: 'environment-owner', displayName: 'Runtime credential',
                kind: 'password', encryptionMode: 'e2ee', revision: 1, materialStatus: 'ready', capabilities: { use: true },
                resourceDataKey,
                storedContent: sealSavedSecretResourceStoredContentV1({
                    resourceId: 'runtime-credential', mode: 'e2ee', resourceDataKey,
                    content: { v: 1, name: 'Runtime credential', kind: 'password', value: secret },
                    randomBytes: (length) => new Uint8Array(length).fill(13),
                }),
            }],
        });
    }

    it('projects required secret uses from binding phase and current destinations, independently of stored resource grants', async () => {
        const second = { machineId: 'second-runtime', installationId: 'second-installed',
            publicKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(38)).publicKey };
        const runtime = bindings[0];
        if (runtime.purpose !== 'variable' || runtime.source.kind !== 'secret') throw new Error('Expected runtime secret fixture');
        const build = { ...runtime, phase: 'build' as const };
        for (const binding of [runtime, build]) {
            const prepared = await prepareEnvironmentSecretBindings({ environmentId: 'staging', bindings: [binding], previousBindings: [],
                runtimeInstallations: [installation, second], buildInstallation: installation,
                existingGrants: [], materializer: materializer(), assertCurrent });
            const destinations = binding.phase === 'runtime' ? [installation, second] : [installation];
            expect(prepared).toHaveProperty('requiredSecretUses', destinations.map(destination => ({
                resourceId: 'runtime-credential', resourceRevision: 1,
                machineId: destination.machineId, installationId: destination.installationId,
            })));
            expect(JSON.stringify(prepared)).not.toContain(secret);
        }
    });

    it('retains exact author-free grants and deploys unattended without Account keys', async () => {
        const prepared = await prepareEnvironmentSecretBindings({
            environmentId: 'staging', bindings, previousBindings: [], runtimeInstallations: [installation],
            existingGrants: [], materializer: materializer(), assertCurrent,
        });
        expect(prepared.referencedSavedSecretRevisions).toEqual(captureDeploymentBindingSavedSecretRevisionsV1(bindings));
        expect(JSON.stringify(prepared)).not.toContain(secret);
        const unattended = await prepareEnvironmentSecretBindings({
            environmentId: 'staging', bindings, previousBindings: bindings, runtimeInstallations: [installation],
            existingGrants: prepared.grants, assertCurrent,
        });
        expect(unattended.grants).toEqual(prepared.grants);
        expect(unattended.grants.every((grant, index) => grant === prepared.grants[index])).toBe(true);
        // Name, retention and author attribution are absent from delivery identity.
        // The program journey exercises an unrelated Environment edit; the
        // personal Source owner cannot be removed as a distinct binding author.
        for (const _launch of ['deploy', 'unattended-redeploy', 'rollback']) {
            const launch = await prepareEnvironmentSecretBindingsForLaunch({
                environmentId: 'staging', machineId: installation.machineId, installationId: installation.installationId,
                installationPrivateSeed: seed, phase: 'runtime', bindings, grants: unattended.grants, assertCurrent,
            });
            expect(launch.env.S0_SECRET).toBe(secret);
            expect(launch.env.PORT).toBe('3000');
            expect(Object.getPrototypeOf(launch.env)).toBeNull();
            expect(launch.secretValues).toEqual([secret]);
            expect(launch.refs).toEqual([{ resourceId: 'runtime-credential', resourceRevision: 1 }]);
            launch.dispose();
            expect(launch.env.S0_SECRET).toBeUndefined();
        }
    });

    it('refuses a stale exact revision, unavailable resource and substituted installation', async () => {
        const prepared = await prepareEnvironmentSecretBindings({
            environmentId: 'staging', bindings, previousBindings: [], runtimeInstallations: [installation],
            existingGrants: [], materializer: materializer(), assertCurrent,
        });
        const input = { environmentId: 'staging', machineId: installation.machineId,
            installationId: installation.installationId, installationPrivateSeed: seed,
            phase: 'runtime' as const, bindings, grants: prepared.grants, assertCurrent };
        await expect(prepareEnvironmentSecretBindingsForLaunch({ ...input, installationId: 'replacement' }))
            .rejects.toMatchObject({ data: { code: 'secret_missing' } });
        await expect(prepareEnvironmentSecretBindingsForLaunch({ ...input, grants: [] }))
            .rejects.toMatchObject({ data: { code: 'secret_missing' } });
        await expect(prepareEnvironmentSecretBindingsForLaunch({ ...input, bindings: [
            variable('S0_SECRET', 'runtime', { kind: 'secret', ref, resourceRevision: 2 }),
        ] })).rejects.toMatchObject({ data: { code: 'secret_missing' } });
    });

    it('retains the installation seal when an admitted binding changes its variable name without Account material', async () => {
        const prepared = await prepareEnvironmentSecretBindings({
            environmentId: 'staging', bindings, previousBindings: [], runtimeInstallations: [installation],
            existingGrants: [], materializer: materializer(), assertCurrent,
        });
        const renamed = bindings.map(binding => binding.purpose === 'variable' && binding.name === 'S0_SECRET'
            ? { ...binding, name: 'RENAMED_SECRET' } : binding);
        const unattended = await prepareEnvironmentSecretBindings({
            environmentId: 'staging', bindings: renamed, previousBindings: bindings, runtimeInstallations: [installation],
            existingGrants: prepared.grants, assertCurrent,
        });
        expect(unattended.grants).toEqual(prepared.grants);
        expect(unattended.grants.every((grant, index) => grant === prepared.grants[index])).toBe(true);
        const launch = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: 'staging',
            machineId: installation.machineId, installationId: installation.installationId, installationPrivateSeed: seed,
            phase: 'runtime', bindings: renamed, grants: unattended.grants, assertCurrent });
        try {
            expect(launch.env.RENAMED_SECRET).toBe(secret);
            expect(launch.env).not.toHaveProperty('S0_SECRET');
            expect(launch.env.PORT).toBe('3000');
        } finally { launch.dispose(); }
    });

    it('selects A/B runtime and builder C bindings while deduplicating coincident resource seals', async () => {
        const installed = (machineId: string, byte: number) => {
            const privateSeed = new Uint8Array(32).fill(byte);
            return { machineId, installationId: `installed-${machineId}`, publicKey: tweetnacl.sign.keyPair.fromSeed(privateSeed).publicKey, privateSeed };
        };
        const a = installed('A', 41), b = installed('B', 42), c = installed('C', 43);
        const source = { kind: 'secret' as const, ref, resourceRevision: 1 };
        const runtime = variable('RUNTIME_SECRET', 'runtime', source);
        const build = variable('BUILD_SECRET', 'build', source);
        const registry = { purpose: 'registry' as const, targetLinkId: 'runtime-link', registryOrigin: 'https://registry.example.test', access: 'pushPull' as const, source };
        const rows: EnvironmentSecretBindingV1[] = [runtime, build, registry,
            variable('BUILD_PUBLIC', 'build', { kind: 'value', value: 'public-value' })];
        const destinations = { runtimeInstallations: [a, b], buildInstallation: c };
        const prepared = await prepareEnvironmentSecretBindings({ environmentId: 'staging', bindings: rows, previousBindings: [],
            ...destinations, existingGrants: [], materializer: materializer(), assertCurrent });
        expect(prepared.grants).toHaveLength(4);
        expect(prepared.referencedSavedSecretRevisions).toEqual(captureDeploymentBindingSavedSecretRevisionsV1(rows));
        const secretGrant = (machineId: string) => {
            const grant = prepared.grants.find(grant => grant.machineId === machineId && grant.kind === 'secret');
            if (!grant) throw new Error('Missing exact grant');
            return grant;
        };
        for (const target of [a, b, c]) {
            const launchInput = { environmentId: 'staging', machineId: target.machineId, installationId: target.installationId,
                installationPrivateSeed: target.privateSeed, bindings: rows, grants: prepared.grants, assertCurrent };
            const launch = await prepareEnvironmentSecretBindingsForLaunch({ ...launchInput, phase: target === c ? 'build' : 'runtime' });
            expect(Object.keys(launch.env).sort()).toEqual(target === c ? ['BUILD_PUBLIC', 'BUILD_SECRET'] : ['RUNTIME_SECRET']);
            launch.dispose();
        }
        const unchanged = await prepareEnvironmentSecretBindings({ environmentId: 'staging', bindings: rows, previousBindings: rows,
            ...destinations, existingGrants: prepared.grants, assertCurrent });
        expect(unchanged.grants.every((grant, index) => grant === prepared.grants[index])).toBe(true);
        const pullRows = rows.map(row => row.purpose === 'registry' ? { ...row, access: 'pull' as const } : row);
        const pullOnly = await prepareEnvironmentSecretBindings({ environmentId: 'staging', bindings: pullRows, previousBindings: rows,
            ...destinations, existingGrants: prepared.grants, materializer: materializer(), assertCurrent });
        const pullBuilderGrant = pullOnly.grants.find(grant => grant.machineId === 'C' && grant.kind === 'secret');
        if (!pullBuilderGrant) throw new Error('Missing exact pull grant');
        expect(pullBuilderGrant).toBe(secretGrant('C'));
        expect(pullOnly.grants.find(grant => grant.machineId === 'A')).toBe(secretGrant('A'));
        expect(pullOnly.grants.find(grant => grant.machineId === 'B')).toBe(secretGrant('B'));
        const coincident = await prepareEnvironmentSecretBindings({ environmentId: 'staging', bindings: rows, previousBindings: rows,
            runtimeInstallations: [a, b], buildInstallation: a, previousDestinations: destinations,
            existingGrants: prepared.grants, materializer: materializer(), assertCurrent });
        expect(coincident.grants).toHaveLength(3);
        expect(coincident.grants.some(grant => grant.machineId === 'C')).toBe(false);
        expect(coincident.grants.find(grant => grant.machineId === 'B')).toBe(secretGrant('B'));
        expect(coincident.grants.find(grant => grant.machineId === 'A' && grant.kind === 'secret')?.sealedContent)
            .toBe(secretGrant('A').sealedContent);
        for (const phase of ['build', 'runtime'] as const) {
            const launch = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: 'staging', machineId: a.machineId,
                installationId: a.installationId, installationPrivateSeed: a.privateSeed, phase, bindings: rows,
                grants: coincident.grants, assertCurrent });
            expect(Object.keys(launch.env).sort()).toEqual(phase === 'build' ? ['BUILD_PUBLIC', 'BUILD_SECRET'] : ['RUNTIME_SECRET']);
            launch.dispose();
        }
        let checks = 0;
        await expect(prepareEnvironmentSecretBindings({ environmentId: 'staging', bindings: rows, previousBindings: [],
            ...destinations, existingGrants: [], materializer: materializer(), async assertCurrent() {
                if (++checks > 1) throw Object.assign(new Error('Stale B installation'), { code: 'secret_missing' });
            } })).rejects.toMatchObject({ code: 'secret_missing' });
        const cancelled = new AbortController();
        await expect(prepareEnvironmentSecretBindings({ environmentId: 'staging', bindings: rows, previousBindings: [],
            ...destinations, existingGrants: [], materializer: materializer(), async assertCurrent() {
                if (!cancelled.signal.aborted) { cancelled.abort(); return; }
                throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
            } })).rejects.toMatchObject({ code: 'cancelled' });
        expect(prepared.grants).toHaveLength(4);
    });

    it('preserves accepted resource seals across placement and binding selection changes', async () => {
        const a = { machineId: 'A', installationId: 'installed-A', publicKey };
        const b = { machineId: 'B', installationId: 'installed-B',
            publicKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(39)).publicKey };
        const source = (resourceId: string) => ({ kind: 'secret' as const,
            ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 });
        const rows: EnvironmentSecretBindingV1[] = [
            variable('BUILD_ONLY', 'build', source('build-only')),
            variable('RUNTIME_ONLY', 'runtime', source('runtime-only')),
            variable('SHARED_BUILD', 'build', source('shared')),
            variable('SHARED_RUNTIME', 'runtime', source('shared')),
            { purpose: 'registry', targetLinkId: 'runtime-link', registryOrigin: 'https://registry.example.test',
                access: 'pushPull', source: source('shared') },
        ];
        const resources = ['build-only', 'runtime-only', 'shared'].map(resourceId => ({ resourceId,
            ownerAccountId: 'owner', displayName: resourceId, kind: 'token' as const, encryptionMode: 'plain' as const,
            revision: 1, materialStatus: 'ready' as const, capabilities: { use: true },
            storedContent: { t: 'plain' as const, v: { v: 1 as const, name: resourceId, kind: 'token' as const, value: `value-${resourceId}` } } }));
        const resolve = createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [], resources,
            resourceCatalogState: 'ready', isCurrent: () => true });
        const previousDestinations = { runtimeInstallations: [a], buildInstallation: a };
        const initial = await prepareEnvironmentSecretBindings({ environmentId: 'staging', bindings: rows, previousBindings: [],
            ...previousDestinations, existingGrants: [], materializer: resolve, assertCurrent });
        const moved = await prepareEnvironmentSecretBindings({ environmentId: 'staging', bindings: rows, previousBindings: rows,
            runtimeInstallations: [a], buildInstallation: b, previousDestinations,
            existingGrants: initial.grants, materializer: resolve, assertCurrent });
        const oldShared = initial.grants.find(grant => grant.kind === 'secret' && grant.resourceId === 'shared');
        expect(moved.grants.find(grant => grant.machineId === a.machineId && grant.kind === 'secret' && grant.resourceId === 'shared'))
            .toBe(oldShared);
        const runtime = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: 'staging', machineId: a.machineId,
            installationId: a.installationId, installationPrivateSeed: seed, phase: 'runtime', bindings: rows,
            grants: initial.grants, assertCurrent });
        expect(runtime.env).toEqual({ RUNTIME_ONLY: 'value-runtime-only', SHARED_RUNTIME: 'value-shared' });
        runtime.dispose();
        // Binding withdrawal changes current admission, not resource ciphertext.
        const changed = await prepareEnvironmentSecretBindings({ environmentId: 'staging',
            bindings: rows.filter(row => row.purpose !== 'variable' || row.name !== 'SHARED_BUILD'), previousBindings: rows,
            ...previousDestinations, previousDestinations, existingGrants: initial.grants, materializer: resolve, assertCurrent });
        expect(changed.grants.find(grant => grant.kind === 'secret' && grant.resourceId === 'shared')?.sealedContent)
            .toBe(oldShared?.sealedContent);
    });

    it('retains 200 binding uses across 100 exact revisions without resealing an admitted rename', async () => {
        const otherSeed = new Uint8Array(32).fill(61);
        const other = { machineId: 'second-runtime', installationId: 'second-installed', publicKey: tweetnacl.sign.keyPair.fromSeed(otherSeed).publicKey };
        const resources = Array.from({ length: 100 }, (_, index) => ({ resourceId: `resource-${index}`, ownerAccountId: 'owner',
            displayName: `Resource ${index}`, kind: 'password' as const, encryptionMode: 'plain' as const,
            revision: 1, materialStatus: 'ready' as const, capabilities: { use: true },
            storedContent: { t: 'plain' as const, v: { v: 1 as const, name: `Resource ${index}`, kind: 'password' as const, value: `cost-sentinel-${index}` } } }));
        const rows: EnvironmentSecretBindingV1[] = Array.from({ length: 200 }, (_, index) => variable(
            `SECRET_${index}`, 'runtime', { kind: 'secret',
                ref: formatSharedSavedSecretRefV1(`resource-${index % 100}`), resourceRevision: 1 }));
        const resolver = createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [], resources,
            resourceCatalogState: 'ready', isCurrent: () => true });
        const common = { environmentId: 'scale', runtimeInstallations: [installation, other], assertCurrent };
        const prepared = await prepareEnvironmentSecretBindings({ ...common, bindings: rows, previousBindings: [],
            existingGrants: [], materializer: resolver });
        expect(prepared.referencedSavedSecretRevisions).toHaveLength(100);
        expect(prepared.grants).toHaveLength(200);
        let materialReads = 0;
        const retained = await prepareEnvironmentSecretBindings({ ...common, bindings: rows, previousBindings: rows,
            existingGrants: prepared.grants, materializer: async () => { materialReads++; return resolver; } });
        expect(materialReads).toBe(0);
        expect(retained.grants.every((grant, index) => grant === prepared.grants[index])).toBe(true);
        const changed = rows.map((row, index) => index === 0 && row.purpose === 'variable' ? { ...row, name: 'RENAMED_SECRET' } : row);
        const updated = await prepareEnvironmentSecretBindings({ ...common, bindings: changed, previousBindings: rows,
            existingGrants: prepared.grants, materializer: resolver });
        expect(updated.grants.every((grant, index) => grant === prepared.grants[index])).toBe(true);
    });
});
