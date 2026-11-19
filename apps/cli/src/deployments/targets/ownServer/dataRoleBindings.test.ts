import { afterEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { withConfiguredDaemonTestHome, writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import * as identityStore from '@/daemon/identity/store';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createScmBackendRegistry } from '@/scm/registry';
import { createDeploymentSourceMaterializationPort } from './exactCommitRelease';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { OwnServerDeploymentInputBasisV1Schema, DeploymentOwnServerContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { DeploymentBindingsSetInputV1Schema, DeploymentEnvironmentGetResultV1Schema, type DeploymentChildRpcV1 } from '@happier-dev/protocol';
import type { PrepareDataRoleBindingsForHost } from '../../secrets/prepareDeploymentBindingsForHost';
import { sealMachineSecretGrant, openMachineSecretGrant } from '../../secrets/machineSecretGrant';
import { createOwnServerDataRoleBindingsForHost } from './dataRoleBindings';

afterEach(() => vi.restoreAllMocks());

function setup() {
    const detail = createDeploymentEnvironmentDetailV1();
    const link = detail.targetLinks[0]!.targetLink;
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(38));
    const installation = { machineId: 'remote-runtime', installationId: 'remote-installation', publicKey: keys.publicKey };
    link.activeDeploymentId = 'serving';
    link.machines = [installation.machineId];
    link.members = [{ ...link.members[0]!, machineId: installation.machineId, installationId: installation.installationId }];
    const use = { purpose: 'dataRole' as const, service: 'database', role: 'readOnlyPassword' as const,
        source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1('role-secret'), resourceRevision: 1 } };
    const input = DeploymentBindingsSetInputV1Schema.parse({ serverId: 'home', environmentId: detail.environment.id,
        expectedRevision: detail.environment.revision, set: [use], remove: [] });
    const environment = DeploymentEnvironmentGetResultV1Schema.parse({ ok: true, environment: detail.environment,
        targetLinks: detail.targetLinks.map(row => row.targetLink) });
    if (!environment.ok) throw new Error('Expected prepared Environment');
    detail.content.template = { templateRef: { sourceId: 'catalog', itemId: 'postgres', version: '1', ref: { kind: 'version', version: '1' } },
        definition: { kind: 'stored', contentRevision: 1, composeDigest: 'sha256:' + 'a'.repeat(64) }, services: ['database'],
        data: [{ engine: 'postgres', service: 'database', version: '16', variables: { database: 'DB_NAME' } }] };
    const request: Parameters<PrepareDataRoleBindingsForHost>[0] = { input, context: {}, environment,
        content: { ...detail.content, bindings: [use] }, previousContent: detail.content, existingGrants: [], runtimeInstallations: [installation] };
    const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: input.environmentId,
        machineId: installation.machineId, installationId: installation.installationId, resourceId: 'role-secret', resourceRevision: 1 },
        installationPublicKey: keys.publicKey, content: { kind: 'secret', value: 'fixture-private-role-password' } });
    const jobs: DeploymentChildRpcV1[] = [];
    const owner = createOwnServerDataRoleBindingsForHost({ serverId: 'home', machineId: 'controller',
        async assertCurrent() {}, async open() { throw new Error('Remote setup must not open an Artifact locally'); },
        async readEnvironment() { throw new Error('Reuse prepared Environment'); },
        async readReceipt() { throw new Error('Remote runtime owns native receipt'); },
        async sendChild(job) { jobs.push(job); return { ok: true }; } });
    return { owner, request, grant, jobs, keys, use, installation };
}

describe('read-role binding producer', () => {
    it('runs the existing bootstrap and dedicated-role login through the mounted native service', async () => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-read-role-', env: {
            HAPPIER_SERVER_URL: 'https://home.test', HAPPIER_WEBAPP_URL: 'https://home.test',
        } }, async ({ homeDir }) => {
            await writeDaemonSettingsFixture(homeDir, { activeServerId: 'home', servers: { home: {
                id: 'home', name: 'Home', serverUrl: 'https://home.test', webappUrl: 'https://home.test',
                createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
                homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_data_role', revision: 1,
                    canonicalServerUrl: 'https://home.test', endpoints: [{ kind: 'https', url: 'https://home.test' }] },
            } } });
            const { request, grant, keys, installation } = setup();
            const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
            try {
                vi.spyOn(identityStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
                    installationId: installation.installationId, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
                    privateKey: Buffer.from(keys.secretKey).toString('base64url'), createdAt: 1 });
                const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
                    serverId: 'home', environmentId: request.input.environmentId });
                const document = 'services: {database: {image: "postgres:16"}}';
                const materializer = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit() {
                    return { environmentId: request.input.environmentId, environmentInstanceId: identity.environmentInstanceId,
                        deploymentId: 'serving', machineId: installation.machineId, installationId: installation.installationId,
                        deploymentRoot: join(configuration.happyHomeDir, 'deployments'), artifactDirectory: join(configuration.happyHomeDir, 'artifacts'),
                        definition: { kind: 'stored' as const, contentRevision: 1, document,
                            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['database'] },
                        async assertCurrent() {} };
                } });
                const release = await materializer.materialize({ environmentId: request.input.environmentId, deploymentId: 'serving' });
                await release.commit();
                const scripts: string[] = [];
                await fixture.registry.projectManagedServices.superviseProject({ kind: 'environment', serverId: identity.homeServerIdentityId,
                    machineId: installation.machineId, environmentId: request.input.environmentId, environmentInstanceId: identity.environmentInstanceId,
                    deploymentId: 'serving', release, composeService: 'database', serviceId: `${identity.environmentInstanceId}/database`,
                    specIdentity: 'serving-database', isCurrent: () => true, releaseObservation: async () => {}, nativeEffects: { keys: [] },
                    processSpec: { mode: { kind: 'native', observationOnly: true, builtinLifecycle: {
                        async inspect() { return { phase: 'running', readiness: 'not_reported', endpoint: null }; },
                        async stop() { return { status: 'stopped' }; },
                        nativeContainers: () => [{ id: 'exact-database-container', service: 'database', composeProject: 'database-project', configurationMatches: true }],
                        runtimeFacts: () => ({ configuration: null, observedAt: 1, freshness: 'current' }),
                        async nativeDocker() { return { engineId: 'fixture-docker', async run(args, _signal, bytes) {
                            expect(args).toEqual(['exec', '-i', 'exact-database-container', 'sh', '-s']);
                            const script = Buffer.from(bytes ?? []).toString(); scripts.push(script);
                            return { exitCode: 0, stdout: script.includes('CREATE ROLE') ? '' : '1\n', stdoutTruncated: false };
                        } }; },
                    } } } });
                const receipt = createDeploymentReceiptDetailV1();
                receipt.deployment = { ...receipt.deployment, id: 'serving', environmentId: request.input.environmentId,
                    targetLinkId: request.environment.environment.runtimeTargetLinkId! };
                const runtimeBindings = [{ purpose: 'variable' as const, name: 'DB_NAME', phase: 'runtime' as const, source: { kind: 'value' as const, value: 'app' } }];
                receipt.content.ownServer = { approvedInputBasis: OwnServerDeploymentInputBasisV1Schema.parse({ v: 1,
                    environmentId: request.input.environmentId, environmentRevision: request.input.expectedRevision,
                    targetLinkId: receipt.deployment.targetLinkId, targetLinkRevision: 1, sourceIntent: receipt.content.sourceIntent,
                    manifestFingerprint: release.manifestFingerprint, configInputDigests: [], physicalProjectName: 'database-project',
                    toolVersion: '2.35.1', services: ['database'], profiles: [], members: [{ machineId: installation.machineId, installationId: installation.installationId }], bindings: runtimeBindings, images: [] }) };
                const content = { ...request.content, template: {
                    templateRef: { sourceId: 'catalog', itemId: 'postgres', version: '1', ref: { kind: 'version' as const, version: '1' } },
                    definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` }, services: ['database'],
                    data: [{ engine: 'postgres' as const, service: 'database', version: '16', variables: { database: 'DB_NAME' } }],
                } };
                const owner = createOwnServerDataRoleBindingsForHost({ serverId: 'home', machineId: installation.machineId,
                    async assertCurrent() {}, async readReceipt() { return { ...receipt, content: DeploymentOwnServerContentV1Schema.parse(receipt.content) }; },
                    async readEnvironment() { throw new Error('Use prepared content'); }, async open() { throw new Error('Use prepared content'); },
                    async sendChild() { throw new Error('Local runtime must execute locally'); } });
                const prepared = await owner.prepare({ ...request, content });
                await prepared.complete([grant]);
                expect(scripts).toHaveLength(2);
                expect(scripts[0]).toContain('CREATE ROLE happier_ro');
                expect(scripts[1]).toContain('--username=happier_ro');
            } finally { await fixture.dispose(); }
        });
    });

    it('seals only the selected runtime recipient and awaits native setup before publication', async () => {
        const { owner, request, grant, jobs, keys, use, installation } = setup();
        const prepared = await owner.prepare(request);
        expect(prepared.operationalDestinations).toEqual([{ binding: use, installations: [installation] }]);
        expect(jobs).toEqual([]);
        await prepared.complete([grant]);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({ kind: 'dataRole', targetLinkId: request.environment.environment.runtimeTargetLinkId,
            deploymentId: 'serving', service: 'database', machineId: installation.machineId, use, grant });
        expect(JSON.stringify(jobs)).not.toContain('fixture-private-role-password');
        expect(openMachineSecretGrant({ grant, ...installation, installationPrivateSeed: keys.secretKey.slice(0, 32) }))
            .toEqual({ kind: 'secret', value: 'fixture-private-role-password' });
    });
    it('refuses a child job whose patch still holds a pending person choice before reading its Environment', async () => {
        const { owner, request, grant, jobs, keys, use } = setup();
        await (await owner.prepare(request)).complete([grant]);
        const sent = jobs[0]!;
        if (sent.kind !== 'dataRole' || !('set' in sent.input)) throw new Error('Expected a data-role patch job');
        vi.spyOn(identityStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'controller-installation', publicKey: Buffer.from(keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(keys.secretKey).toString('base64url'), createdAt: 1 });
        const pending = { ...use, source: { kind: 'secret' as const, ref: 'person_selects' as const } };
        await expect(owner.executeChild({ ...sent, machineId: 'controller', installationId: 'controller-installation',
            input: { ...sent.input, set: [pending] } }, {})).rejects.toMatchObject({ code: 'client_required' });
    });
    it('refuses an absent exact recipient grant before sending a child', async () => {
        const { owner, request, jobs } = setup();
        const prepared = await owner.prepare(request);
        await expect(prepared.complete([])).rejects.toMatchObject({ code: 'secret_missing' });
        expect(jobs).toEqual([]);
    });
    it('retains existing role destinations without rerunning setup for an unrelated variable save', async () => {
        const { owner, request, jobs, grant } = setup();
        const prepared = await owner.prepare({ ...request, previousContent: request.content,
            input: { ...request.input, set: [], remove: [] } });
        expect(prepared.operationalDestinations.length).toBeGreaterThan(0);
        await prepared.complete([grant]);
        expect(jobs).toEqual([]);
    });
});
