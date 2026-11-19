import { expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { EnvironmentSecretBindingV1Schema, environmentSecretBindingIdentityV1, type EnvironmentSecretBindingV1 } from '@happier-dev/deployments/contracts/v1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { createSavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import { createMachineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createDeploymentExecEnvPortForHost } from './deploymentExecEnvPort';
import { prepareEnvironmentSecretBindings } from './environmentSecretBindingService';
import { prepareEnvironmentSecretBindingsForLaunch } from './prepareEnvironmentSecretBindingsForLaunch';

it.each(['plain', 'e2ee'] as const)('seals Domain credentials only to captured destinations in %s mode', async encryptionMode => {
    const seed = new Uint8Array(32).fill(52);
    const installation = { machineId: 'edge', installationId: 'edge-installation', publicKey: nacl.sign.keyPair.fromSeed(seed).publicKey };
    const binding = EnvironmentSecretBindingV1Schema.parse({ purpose: 'domainCredential', domainId: 'domain', role: 'privateKey',
        source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('domain-resource'), resourceRevision: 1 } });
    if (binding.purpose !== 'domainCredential') throw new Error('Invalid Domain fixture');
    const metadata = { resourceId: 'domain-resource', ownerAccountId: 'owner', displayName: 'Domain key', kind: 'password' as const,
        encryptionMode, revision: 1, materialStatus: 'ready' as const, capabilities: { use: true } };
    const content = { v: 1 as const, name: metadata.displayName, kind: 'password' as const, value: 'domain-private-key-sentinel' };
    const resourceDataKey = new Uint8Array(32).fill(13);
    const storedContent = encryptionMode === 'plain' ? { t: 'plain' as const, v: content }
        : sealSavedSecretResourceStoredContentV1({ resourceId: metadata.resourceId, mode: encryptionMode, resourceDataKey,
            content, randomBytes: n => new Uint8Array(n).fill(16) });
    const materializer = createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [],
        resourceCatalogState: 'ready', isCurrent: () => true, resources: [{ ...metadata, storedContent,
            ...(encryptionMode === 'e2ee' ? { resourceDataKey } : {}) }] });
    const input = { environmentId: 'environment', bindings: [binding], previousBindings: [], runtimeInstallations: [],
        existingGrants: [], materializer, assertCurrent: async () => {} };
    const prepared = await prepareEnvironmentSecretBindings({ ...input,
        domainDestinations: { status: 'complete', domains: [{ domainId: 'domain', installations: [installation] }] } });
    expect(prepared.requiredSecretUses).toEqual([{ resourceId: metadata.resourceId, resourceRevision: 1,
        machineId: installation.machineId, installationId: installation.installationId }]);
    const launchInput = { environmentId: input.environmentId, ...installation, installationPrivateSeed: seed,
        bindings: [binding], grants: prepared.grants, assertCurrent: input.assertCurrent };
    const opened = await prepareEnvironmentSecretBindingsForLaunch({ ...launchInput, use: binding });
    expect([...opened.operationalValues.values()]).toEqual([content.value]);
    opened.dispose();
    await expect(prepareEnvironmentSecretBindingsForLaunch({ ...launchInput, use: { ...binding, role: 'certificateChain' } }))
        .rejects.toMatchObject({ data: { code: 'secret_missing' } });
    await expect(prepareEnvironmentSecretBindings({ ...input, domainDestinations: { status: 'incomplete', domains: [] } }))
        .rejects.toMatchObject({ data: { code: 'secret_missing' } });
    await expect(prepareEnvironmentSecretBindings({ ...input, domainDestinations: { status: 'complete', domains: [] } }))
        .rejects.toMatchObject({ data: { code: 'secret_missing' } });
});

it('opens only the admitted E2EE operational slot within the current native operation, without client keys or app env', async () => {
    const seed = new Uint8Array(32).fill(39);
    const installation = { machineId: 'runtime', installationId: 'installed', publicKey: nacl.sign.keyPair.fromSeed(seed).publicKey };
    const ref = formatSharedSavedSecretRefV1('operational');
    const source = { kind: 'secret' as const, ref, resourceRevision: 1 };
    const bindings = [
        { purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword', source },
        { purpose: 'backupDestination', configKey: 'destination', role: 'sshPrivateKey', source },
        { purpose: 'domainCredential', domainId: 'domain', role: 'privateKey', source },
        { purpose: 'dataRole', service: 'postgres', role: 'readOnlyPassword', source },
        { purpose: 'dataRole', targetLinkId: 'managed-postgres', role: 'readOnlyPassword', source },
    ].map(binding => EnvironmentSecretBindingV1Schema.parse(binding)).filter((binding): binding is Exclude<EnvironmentSecretBindingV1, { purpose: 'variable' }> => binding.purpose !== 'variable');
    const key = new Uint8Array(32).fill(14);
    const secret = 'operational-secret-sentinel';
    const metadata = { resourceId: 'operational', ownerAccountId: 'owner', displayName: 'Operational', kind: 'password' as const,
        encryptionMode: 'e2ee' as const, revision: 1, materialStatus: 'ready' as const, capabilities: { use: true } };
    const materializer = createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [],
        resourceCatalogState: 'ready', isCurrent: () => true, resources: [{ ...metadata, resourceDataKey: key,
            storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: metadata.resourceId, mode: 'e2ee', resourceDataKey: key,
                content: { v: 1, name: metadata.displayName, kind: 'password', value: secret }, randomBytes: n => new Uint8Array(n).fill(15) }) }] });
    let current = true;
    const assertCurrent = async () => { if (!current) throw Object.assign(new Error('secret_missing'), { code: 'secret_missing' }); };
    const unrelatedBuilder = { ...installation, machineId: 'unrelated-builder', installationId: 'unrelated-installation' };
    const prepared = await prepareEnvironmentSecretBindings({ environmentId: 'environment', bindings, previousBindings: [],
        runtimeInstallations: [installation], buildInstallation: unrelatedBuilder, existingGrants: [], materializer, assertCurrent,
        domainDestinations: { status: 'complete', domains: [{ domainId: 'domain', installations: [installation] }] },
        operationalDestinations: bindings.filter(binding => binding.purpose === 'dataRole').map(binding => ({ binding, installations: [installation] })) });
    expect(prepared.grants).toHaveLength(1);
    expect(prepared).toHaveProperty('requiredSecretUses', [{
        resourceId: 'operational', resourceRevision: 1,
        machineId: installation.machineId, installationId: installation.installationId,
    }]);
    expect(JSON.stringify(prepared)).not.toContain(secret);
    const retained = await prepareEnvironmentSecretBindings({ environmentId: 'environment', bindings, previousBindings: bindings,
        runtimeInstallations: [installation], buildInstallation: unrelatedBuilder, existingGrants: prepared.grants, assertCurrent,
        domainDestinations: { status: 'complete', domains: [{ domainId: 'domain', installations: [installation] }] },
        operationalDestinations: bindings.filter(binding => binding.purpose === 'dataRole').map(binding => ({ binding, installations: [installation] })) });
    expect(retained.grants[0]).toBe(prepared.grants[0]);
    const launchInput = { environmentId: 'environment', machineId: installation.machineId, installationId: installation.installationId,
        installationPrivateSeed: seed, bindings, grants: prepared.grants, assertCurrent };
    const unsealedDomain = EnvironmentSecretBindingV1Schema.parse({ purpose: 'domainCredential', domainId: 'other-domain', role: 'privateKey', source });
    if (unsealedDomain.purpose !== 'domainCredential') throw new Error('Invalid fixture');
    await expect(prepareEnvironmentSecretBindingsForLaunch({ ...launchInput, use: unsealedDomain }))
        .rejects.toMatchObject({ data: { code: 'secret_missing' } });
    for (const address of [{ purpose: 'dataRole', service: 'other-postgres', role: 'readOnlyPassword', source },
        { purpose: 'dataRole', targetLinkId: 'other-managed-postgres', role: 'readOnlyPassword', source }]) {
        const use = EnvironmentSecretBindingV1Schema.parse(address);
        if (use.purpose !== 'dataRole') throw new Error('Invalid data role fixture');
        await expect(prepareEnvironmentSecretBindingsForLaunch({ ...launchInput, use }))
            .rejects.toMatchObject({ data: { code: 'secret_missing' } });
    }
    await expect(prepareEnvironmentSecretBindingsForLaunch({ ...launchInput, use: bindings[0], machineId: 'other-machine' }))
        .rejects.toMatchObject({ data: { code: 'secret_missing' } });
    await expect(prepareEnvironmentSecretBindingsForLaunch({ ...launchInput, use: bindings[0], installationId: 'replacement' }))
        .rejects.toMatchObject({ data: { code: 'secret_missing' } });
    await expect(prepareEnvironmentSecretBindingsForLaunch({ ...launchInput, use: bindings[0], phase: 'runtime' }))
        .rejects.toMatchObject({ data: { code: 'secret_missing' } });
    const native = createMachineNativeEffectAdmission();
    const keys = [{ kind: 'composeProject' as const, dockerEndpoint: 'engine', projectName: 'data' }];
    let effects = 0;
    await withTempDir('operational-secret-port-', async root => {
    const executable = { kind: 'systemTool', id: 'fixture.node' } as const;
    const service = createStablePluginExecService({ signal: new AbortController().signal,
        isOccurrenceCurrent: () => true, resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => root });
    await native.run({ operation: { operationId: 'scheduled-backup', kind: 'backup' }, keys }, async context => {
        // P30 retains the full-set context across nested run/verify/prune stages.
        for (const operation of ['run', 'verify', 'prune', 'sftp-key', 'domain-reload', 'query-self-hosted', 'query-managed']) {
            await native.runStage(context, async () => {
                const binding = bindings[operation === 'sftp-key' ? 1 : operation === 'domain-reload' ? 2 : operation === 'query-self-hosted' ? 3 : operation === 'query-managed' ? 4 : 0];
                const launch = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: 'environment',
                    machineId: installation.machineId, installationId: installation.installationId, installationPrivateSeed: seed,
                    bindings, use: binding,
                    grants: prepared.grants, assertCurrent });
                expect(Object.keys(launch.env)).toEqual([]);
                expect([...launch.operationalValues.keys()]).toEqual([environmentSecretBindingIdentityV1(binding)]);
                expect(launch.operationalValues.get(environmentSecretBindingIdentityV1(binding)) === secret).toBe(true);
                const bindingIdentity = environmentSecretBindingIdentityV1(binding);
                const path = join(root, `credential-${effects}`);
                // The executable/file system is the boundary fixture. P45 owns
                // the actual restic/Caddy/query adapters, not this custody hop.
                const port = createDeploymentExecEnvPortForHost({ bindingIdentity,
                    signal: new AbortController().signal, isCurrent: () => current,
                    async prepare() {
                        await launch.recheck();
                        writeFileSync(path, launch.operationalValues.get(bindingIdentity)!, { mode: 0o600 });
                        return { ...launch, env: { OPERATIONAL_SECRET_FILE: path },
                            dispose() { launch.dispose(); unlinkSync(path); } };
                    } });
                await expect(port.prepare({ bindingIdentity: environmentSecretBindingIdentityV1(unsealedDomain) }))
                    .rejects.toMatchObject({ data: { details: { reason: 'deployment_attachment_unavailable' } } });
                const deploymentEnv = await port.prepare({ bindingIdentity });
                expect(Object.keys(deploymentEnv)).toEqual(['dispose']);
                const result = await service.run({ executable, cwd: root, deploymentEnv,
                    args: ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.env.OPERATIONAL_SECRET_FILE,"utf8"))'] });
                expect(Buffer.from(result.stdout).toString()).toBe('[REDACTED]');
                expect(JSON.stringify(result)).not.toContain(secret);
                expect(existsSync(path), 'finite process settlement removes its protected credential file').toBe(false);
                effects++;
                launch.dispose();
                expect(launch.operationalValues.size).toBe(0);
            });
        }
        current = false;
        await expect(prepareEnvironmentSecretBindingsForLaunch({ environmentId: 'environment', machineId: installation.machineId,
            installationId: installation.installationId, installationPrivateSeed: seed, bindings,
            use: bindings[0], grants: prepared.grants,
             assertCurrent })).rejects.toMatchObject({ code: 'secret_missing' });
    });
    });
    expect(effects).toBe(7);
});
