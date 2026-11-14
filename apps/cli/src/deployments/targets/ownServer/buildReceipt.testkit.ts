import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { create as createTar } from 'tar';
import nacl from 'tweetnacl';
import axios from 'axios';
import { onTestFailed, vi } from 'vitest';
import { ArtifactJsonUpdateHttpInputV1Schema, DeploymentActionInputSchemasV1, DeploymentChildRpcV1Schema, DeploymentReceiptListResultV1Schema, DeploymentTransitionInputV1Schema } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1, createDeploymentReceiptHeaderV1, createDeploymentSecretVariableBindingV1, createDeploymentVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentOwnServerContentV1Schema, type DeploymentOwnServerContentV1, type DeploymentEnvironmentDetailV1, type DeploymentImageV1,
    type MachineSecretGrantV1, type EnvironmentSecretBindingV1, createDeploymentReceiptArtifactHeaderV1,
    DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { configuration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import * as installationStore from '@/daemon/identity/store';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { prepareEnvironmentSecretBindings } from '@/deployments/secrets/environmentSecretBindingService';
import { createSavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import { withNativeComposeBuildFixture, withNativeComposeBuildAdmission } from '@/daemon/local/services/launch/nativeComposeBuild.testkit';
import { resolveEnvironmentComposeProjectName } from '@/workspaces/projectSetup/projectNativeResolution';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import { createDeploymentSourceMaterializationPort, resolveDeploymentSourcePathForHost } from './exactCommitRelease';
import { adoptOwnServerImageArchives } from './releaseProvenance';
import { resolveOwnServerDeploymentEnvironmentInstanceIdForHost, resolveOwnServerDeploymentIdentityForHost } from './paths';
import type { OwnServerDeploymentRequest, OwnServerDeploymentTargetHostInput, OwnServerDeploymentReceipt } from './ownServerDeploymentTarget';
import { resolvePrivateServiceReferenceForHost } from './privateServiceReference';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import type { ProjectNativeRuntimeFacts } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';

const digest = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Real child/storage/artifact/writer composition over the native build fixture.
 * Only HTTP and the installed identity file are substituted here. */
export async function withOwnServerBuildChildHttpFixture(run: (value: Readonly<{
    build(): Promise<unknown>;
    reads: { environments: number; receipts: number };
    receipt: OwnServerDeploymentReceipt;
    activity: readonly string[];
}>) => Promise<void>, options?: Readonly<{ editApprovedInputBeforePublish?: boolean }>) {
    const activity: string[] = ['fixture:start'];
    // Keep timeout evidence at the system boundary without recording payloads,
    // headers, credentials or opened secret material.
    onTestFailed(() => { console.error('[Build child HTTP boundary]', JSON.stringify(activity)); });
    await withOwnServerBuildFixture(async ({ host, request, receipt, environment, nativeRequests }) => {
        activity.push('fixture:ready');
        const reads = { environments: 0, receipts: 0 };
        const failures: unknown[] = [];
        let editedApprovedInput = false;
        const readPath = (actionId: 'deployments.environments.get' | 'deployments.receipts.get' | 'deployments.receipts.list') => {
            const transport = getActionSpec(actionId).serverTransport;
            if (!transport) throw new Error('Deployment read transport required');
            const bound = bindHomeDomainHttpRequestV1({ transport, inputSchema: DeploymentActionInputSchemasV1[actionId], input: {
                serverId: host.serverId, environmentId: environment.environment.id,
                ...(actionId === 'deployments.receipts.get' ? { deploymentId: receipt.deployment.id } : {}),
            } });
            return new URL(bound.path, host.serverHttpBaseUrl).pathname;
        };
        const paths = { environment: readPath('deployments.environments.get'), receipt: readPath('deployments.receipts.get'),
            history: readPath('deployments.receipts.list') };
        const identityKeys = nacl.sign.keyPair();
        const identity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'installation-c', createdAt: 1, publicKey: Buffer.from(identityKeys.publicKey).toString('base64url'),
            privateKey: Buffer.from(identityKeys.secretKey).toString('base64url') });
        const artifact = (id: string, header: unknown, content: unknown, headerVersion: number, bodyVersion: number) => ({
            id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent(header),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }), headerVersion, bodyVersion,
            seq: 1, createdAt: 1, updatedAt: 1 });
        const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
            try {
            const path = new URL(url).pathname;
            activity.push(`GET ${path}`);
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            const id = decodeURIComponent(path.split('/').at(-1)!);
            if (id === receipt.deployment.contentArtifactId) return { status: 200, data: artifact(id,
                createDeploymentReceiptArtifactHeaderV1('Build', receipt.content), receipt.content,
                receipt.deployment.contentHeaderVersion, receipt.deployment.contentBodyVersion) };
            if (id === environment.environment.contentArtifactId) return { status: 200, data: artifact(id,
                { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Build' }, environment.content,
                environment.environment.contentHeaderVersion, environment.environment.contentBodyVersion) };
            const link = environment.targetLinks.find(row => row.targetLink.contentArtifactId === id);
            if (link) return { status: 200, data: artifact(id, { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: 'Build' },
                link.content, link.targetLink.contentHeaderVersion, link.targetLink.contentBodyVersion) };
            throw new Error(`Unexpected build artifact request: ${path}`);
            } catch (error) { failures.push(error); throw error; }
        });
        const http = vi.spyOn(axios, 'request').mockImplementation(async input => {
            try {
            const path = new URL(input.url!).pathname;
            activity.push(`${input.method} ${path}`);
            if (input.method === 'GET' && path === paths.receipt) {
                reads.receipts++;
                if (options?.editApprovedInputBeforePublish && !editedApprovedInput
                    && nativeRequests.some(call => call.args.includes('--metadata-file'))) {
                    receipt.content.ownServer!.approvedInputBasis.bindings.push(createDeploymentVariableBindingV1({ phase: 'build', name: 'EDITED',
                        source: { kind: 'value', value: 'unreviewed' } }));
                    editedApprovedInput = true;
                }
                return { status: 200, data: { ok: true, deployment: receipt.deployment } };
            }
            if (input.method === 'GET' && path === paths.environment) {
                reads.environments++;
                return { status: 200, data: { ok: true, environment: environment.environment,
                    targetLinks: environment.targetLinks.map(row => row.targetLink) } };
            }
            if (input.method === 'GET' && path === paths.history) return { status: 200,
                data: DeploymentReceiptListResultV1Schema.parse({ ok: true, items: [], nextCursor: null }) };
            if (input.method === 'POST' && path.endsWith('/transitions')) {
                const transition = DeploymentTransitionInputV1Schema.parse(input.data);
                const mutation = ArtifactJsonUpdateHttpInputV1Schema.parse(transition.contentUpdate);
                if (transition.expectedRevision !== receipt.deployment.revision
                    || mutation.expectedHeaderVersion !== undefined && mutation.expectedHeaderVersion !== receipt.deployment.contentHeaderVersion
                    || mutation.expectedBodyVersion !== undefined && mutation.expectedBodyVersion !== receipt.deployment.contentBodyVersion) {
                    return { status: 409, data: { ok: false, error: 'deployment_conflict' } };
                }
                if (mutation.body === undefined) throw new Error('Expected build publication body');
                const opened = decodePlainArtifactStoredContent(mutation.body);
                if (!opened || typeof opened !== 'object' || !('body' in opened) || typeof opened.body !== 'string') {
                    throw new Error('Expected plain build publication');
                }
                receipt.content = DeploymentOwnServerContentV1Schema.parse(JSON.parse(opened.body));
                receipt.deployment.revision++;
                receipt.deployment.state = transition.state;
                receipt.deployment.contentHeaderVersion += Number(mutation.header !== undefined);
                receipt.deployment.contentBodyVersion++;
                return { status: 200, data: { ok: true, environmentId: environment.environment.id,
                    revision: environment.environment.revision, deploymentId: receipt.deployment.id,
                    deploymentRevision: receipt.deployment.revision, state: transition.state } };
            }
            throw new Error(`Unexpected build storage request: ${path}`);
            } catch (error) { failures.push(error); throw error; }
        });
        const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
            const path = new URL(url).pathname;
            activity.push(`POST ${path}`);
            const error = new Error(`Unexpected build artifact write: ${path}`);
            failures.push(error);
            throw error;
        });
        try {
            const credentials = { token: `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`, encryption: null };
            const deps = createDaemonDeploymentActionDeps({ ...host, credentials,
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }) });
            const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'build', actionId: request.actionId,
                input: request.input, machineId: host.machineId, installationId: 'installation-c',
                deploymentId: receipt.deployment.id, actionOperationId: receipt.deployment.actionOperationId });
            await run({ build: async () => {
                const result = await deps.deploymentChild(job, request.context);
                if (failures.length) throw failures[0];
                return result;
            }, reads, receipt, activity });
            if (options?.editApprovedInputBeforePublish) assert.equal(editedApprovedInput, true);
        } finally { post.mockRestore(); http.mockRestore(); get.mockRestore(); identity.mockRestore(); }
    });
}

/** Consume the native owner's real selected-output/build-dependency producer,
 * rather than declaring a second dependency model in the approval fixture. */
export async function withNativeDependencyBuildReceipt(run: (content: DeploymentOwnServerContentV1) => Promise<void>,
    options?: Readonly<{ effectivePlatforms?: boolean; publication?: boolean }>) {
    await withNativeComposeBuildFixture(async ({ project, source, commitSha, bindings, readRuntimeProjection }) => {
        const runtime = options?.effectivePlatforms ? await readRuntimeProjection() : undefined;
        const selection = runtime ? { servicePlatforms: runtime.servicePlatforms } : {};
        const description = await project.describeBuild(selection);
        const secretBinding = bindings.find(binding => binding.purpose === 'variable' && binding.name === 'BUILD_SECRET');
        if (secretBinding?.purpose !== 'variable' || secretBinding.source.kind !== 'secret') throw new Error('Native secret fixture required');
        const secretSource = secretBinding.source;
        const root = await mkdtemp(join(tmpdir(), 'happier-build-dependency-receipt-'));
        try {
            await withNativeComposeBuildAdmission(project, async context => {
                const { images } = await project.prepareImages({ context, platforms: ['linux/amd64'], ...selection,
                    build: { noCacheServices: ['base'], secretVariableNames: ['BUILD_SECRET'] } });
                const archives = await project.exportImages({ images, context });
                const imageArchives = options?.publication ? [] : await adoptOwnServerImageArchives({ archives, serverId: 'home',
                    admission: { deploymentRoot: root, environmentInstanceId: source.environmentInstanceId,
                        deploymentId: source.deploymentId, machineId: source.machineId, installationId: source.installationId },
                        signal: new AbortController().signal, assertCurrent: source.assertCurrent });
                if (options?.publication) {
                    await project.dispose();
                    for (const archive of archives) await assert.rejects(readFile(archive.path), { code: 'ENOENT' });
                }
                const receipt = createDeploymentReceiptDetailV1();
                const receiptBindings = bindings.map(binding => binding.purpose === 'registry'
                    ? { ...binding, targetLinkId: receipt.deployment.targetLinkId } : binding);
                if (receipt.content.sourceIntent.kind !== 'repository') throw new Error('Repository fixture required');
                const sourceIntent = { ...receipt.content.sourceIntent, sha: commitSha,
                    compose: { path: 'compose.yaml', profiles: [], services: [...description.services] } };
                const member = { machineId: source.machineId, installationId: source.installationId };
                const projection = { ...description.basis, services: [...description.services], profiles: [], ...selection };
                await run(DeploymentOwnServerContentV1Schema.parse({ ...receipt.content, sourceIntent,
                    machines: [source.machineId], buildMachineId: source.machineId, machineResults: [], images,
                    ownServer: { approvedInputBasis: { v: 1, environmentId: source.environmentId, environmentRevision: 1,
                        targetLinkId: receipt.deployment.targetLinkId, targetLinkRevision: 1, sourceIntent, ...projection,
                        members: [member], bindings: receiptBindings, images: [], buildServices: [...description.buildServices],
                        runtimeProjections: [{ ...member, ...projection, platform: runtime?.platform ?? 'linux/amd64' }] }, imageArchives,
                        buildSecretRevisions: description.buildSecretVariables.map(({ service, names }) => ({
                            service, ...member, bindings: names.includes(secretBinding.name)
                                ? [{ ref: secretSource.ref, resourceRevision: secretSource.resourceRevision }] : [],
                        })) } }));
            });
        } finally { await rm(root, { recursive: true, force: true }); }
    }, { environmentInstanceId: resolveOwnServerDeploymentEnvironmentInstanceIdForHost('home', 'environment'),
        ...(options?.publication ? { publication: 'ok' as const } : options?.effectivePlatforms ? { effectivePlatforms: true } : { selectedSubset: true }) });
}

export async function withOwnServerBuildFixture(run: (value: Readonly<{
    host: OwnServerDeploymentTargetHostInput; request: OwnServerDeploymentRequest;
    receipt: Omit<OwnServerDeploymentReceipt, 'content'> & { content: DeploymentOwnServerContentV1 };
    environment: DeploymentEnvironmentDetailV1; history: OwnServerDeploymentReceipt[];
    referenceEnvironment: DeploymentEnvironmentDetailV1;
    boundaryActivity: Readonly<{ environmentReads: number; receiptReads: number; acquisitions: number; transitions: number }>;
    nativeRequests: Parameters<ProjectNativeToolchainIo['run']>[0][]; root: string; sourceTargetPath: string;
    deploymentRoot: string; environmentInstanceId: string;
    custody: Readonly<{ bindings: readonly EnvironmentSecretBindingV1[]; grants: readonly MachineSecretGrantV1[];
        installations: readonly Readonly<{ machineId: string; installationId: string; seed: Uint8Array }>[] }>;
}>) => Promise<void>, options: Readonly<{ mode?: 'source' | 'mixed' | 'prebuilt' | 'stored' | 'closure'; secretRevision?: number;
    deploymentId?: string; buildSecret?: boolean; revokeAfter?: 'config' | 'build'; registryAccess?: 'pull' | 'pushPull'; failBuild?: boolean;
    coldImages?: boolean; buildReference?: boolean; changingBuildReference?: boolean; secretBuildArgument?: boolean;
    referenceBindAddress?: string; referencePublishedPort?: number; referenceIroh?: boolean; referenceDualPublication?: boolean; referenceNetworkObserved?: boolean }> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'happier-build-receipt-'));
    const homeServerIdentityId = 'srv_build_receipt';
    const previousConfiguration = { happyHomeDir: configuration.happyHomeDir, settingsFile: configuration.settingsFile,
        serversDir: configuration.serversDir, activeServerId: configuration.activeServerId };
    Object.assign(configuration, { happyHomeDir: root, settingsFile: join(root, 'settings.json'), serversDir: join(root, 'servers') });
    const isStored = options.mode === 'stored' || options.mode === 'closure';
    const mounted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
        controller: pluginReloadController, runtimeOptions: { pluginIds: isStored ? [] : ['happier.scm.backend.git'] } });
    let releaseReferenceBoundary = () => {};
    try {
        // The real identity/path owner resolves this fixture's exact Home, not a process-global alias.
        const profile = await addServerProfile({ name: 'home', serverUrl: 'https://home.test', webappUrl: 'https://home.test' });
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
            v: 1, homeServerIdentityId, canonicalServerUrl: profile.serverUrl, revision: 1,
            endpoints: [{ kind: 'https', url: profile.serverUrl }],
        } });
        const repository = join(root, 'repository');
        const executionDirectory = join(root, 'build-cwd');
        await mkdir(repository); await mkdir(executionDirectory);
        const sourceBuildServices = options.mode === 'prebuilt' || isStored ? [] : options.mode === 'mixed' ? ['app'] : ['app', 'worker'];
        const secretRevision = options.secretRevision ?? 2;
        const usesBuildSecret = options.buildSecret !== false;
        const model = { services: {
            app: { image: 'example/app:reviewed', ...(sourceBuildServices.includes('app') ? {
                build: { context: '.', ...(options.secretBuildArgument ? { args: { CANARY: '${BUILD_TOKEN}' } } : {}), ...(usesBuildSecret ? { secrets: ['token'] } : {}) } } : {}),
                environment: { RUNTIME_TOKEN: '${RUNTIME_TOKEN:?required}' },
                ...(options.mode === 'closure' ? { depends_on: ['worker'] } : {}) },
            worker: { image: 'example/worker:reviewed', ...(sourceBuildServices.includes('worker') ? { build: { context: '.' } } : {}) },
        }, secrets: { token: { environment: 'BUILD_TOKEN' } } };
        const document = JSON.stringify(model);
        await writeFile(join(repository, 'compose.yaml'), document);
        await writeFile(join(repository, 'Dockerfile'), 'FROM scratch\n');
        const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
        git('init', '--quiet'); git('config', 'user.name', 'Build Receipt Fixture');
        git('config', 'user.email', 'build-receipt@example.test'); git('add', 'compose.yaml', 'Dockerfile');
        git('commit', '--quiet', '-m', 'Reviewed build source');
        const environment = createDeploymentEnvironmentDetailV1();
        environment.environment.buildMachineId = 'builder-c';
        const link = environment.targetLinks[0].targetLink;
        link.machines.push('machine-b');
        link.members.push({ machineId: 'machine-b', installationId: 'installation-b', state: 'active' });
        delete link.activeDeploymentId;
        const receipt = createDeploymentReceiptDetailV1();
        receipt.deployment.id = options.deploymentId ?? receipt.deployment.id;
        receipt.deployment.state = 'running';
        receipt.deployment = createDeploymentReceiptHeaderV1({ ...receipt.deployment, acceptedExecution: { v: 1,
            controller: { machineId: environment.environment.controllerMachineId, installationId: 'installation-a' },
            builder: { machineId: 'builder-c', installationId: 'installation-c' }} });
        receipt.content.images = []; receipt.content.machineResults = [];
        receipt.content.machines = link.machines; receipt.content.buildMachineId = 'builder-c';
        if (receipt.content.sourceIntent.kind !== 'repository') throw new Error('Repository source fixture required');
        receipt.content.sourceIntent.sha = git('rev-parse', 'HEAD');
        receipt.content.sourceIntent.compose.services = ['app', 'worker'];
        if (isStored) receipt.content.sourceIntent = { kind: 'stored', contentRevision: 1,
            document, composeDigest: digest(document), profiles: [], services: options.mode === 'closure' ? ['app'] : ['app', 'worker'] };
        environment.content.definition = receipt.content.sourceIntent.kind === 'stored'
            ? structuredClone(receipt.content.sourceIntent)
            : { kind: 'repository', ref: 'main', compose: structuredClone(receipt.content.sourceIntent.compose) };
        const buildBinding = createDeploymentSecretVariableBindingV1({ phase: 'build', name: 'BUILD_TOKEN',
            resourceId: 'build-token', resourceRevision: secretRevision });
        environment.content.bindings = [...(usesBuildSecret ? [buildBinding] : []),
            createDeploymentSecretVariableBindingV1({ phase: 'runtime', name: 'RUNTIME_TOKEN',
                resourceId: 'build-token', resourceRevision: secretRevision })];
        if (options.buildReference) {
            environment.content.bindings.push(createDeploymentVariableBindingV1({ phase: 'build', name: 'BUILD_DATABASE_URL',
                source: { kind: 'reference', environmentId: 'source-database', export: 'database', via: 'privateNetwork' } }));
        }
        const referenceEnvironment = createDeploymentEnvironmentDetailV1();
        referenceEnvironment.environment.id = 'source-database';
        referenceEnvironment.environment.runtimeTargetLinkId = 'source-link';
        referenceEnvironment.content.ownServer = { rollout: 'recreate', autoRestorePreviousRelease: false,
            serviceExports: [{ key: 'database', service: 'db', containerPort: 5432, scheme: 'postgres',
                ...(options.referenceDualPublication ? { exposure: 'privateNetwork' as const, privateNetwork: 'network', transport: { kind: 'iroh' as const } } : options.referenceIroh ? { exposure: 'loopback' as const, transport: { kind: 'iroh' as const } }
                    : { exposure: 'privateNetwork' as const, privateNetwork: 'network' }) }] };
        referenceEnvironment.targetLinks[0]!.targetLink = { ...referenceEnvironment.targetLinks[0]!.targetLink,
            id: 'source-link', environmentId: 'source-database', activeDeploymentId: 'source-release', machines: ['builder-c'],
            members: [{ machineId: 'builder-c', installationId: 'installation-c', state: 'active' }] };
        let referencePort = options.referencePublishedPort ?? 25432;
        if (options.buildReference) {
            // Native service observation and Home metadata are the boundaries;
            // retained service selection and address resolution remain real.
            const metadata = vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (String(url).endsWith('/v1/account/encryption-mode')) return { status: 200, data: { mode: 'plain' } };
                if (!String(url).endsWith('/v1/machines/builder-c')) throw new Error('Unexpected reference metadata read');
                return { status: 200, data: { machine: { id: 'builder-c', kind: 'persistent', revokedAt: null,
                    replacedByMachineId: null, seq: 1, active: true, activeAt: 1, createdAt: 1, updatedAt: 1,
                    metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({ host: 'fixture', platform: 'linux',
                        happyCliVersion: '0.0.0', homeDir: root, happyHomeDir: root })), metadataVersion: 1,
                    daemonState: encodePlainMachineStoredContent({ status: 'running', reachability: { revision: 1,
                        management: { daemon: 'ready', providers: [], publicSsh: 'closed' }, ingress: [],
                        privateNetworks: options.referenceNetworkObserved === false ? [] : [{ provider: { kind: 'builtin', id: 'tailscale' }, networkIdentity: 'network',
                            displayName: null, dnsName: null, addresses: ['100.64.0.7'], state: 'ready', interfaceName: 'tailscale0',
                            sourceRanges: ['100.64.0.0/10'], magicDnsEnabled: false }] } }),
                    daemonStateVersion: 1, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                    installationId: 'installation-c' } } };
            });
            releaseReferenceBoundary = () => metadata.mockRestore();
            const sourceIdentity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: root,
                serverId: homeServerIdentityId, environmentId: 'source-database' });
            const sourceDocument = 'services: {db: {image: database}}';
            const definition = { kind: 'stored' as const, contentRevision: 1, document: sourceDocument,
                composeDigest: digest(sourceDocument), profiles: [], services: ['db'] };
            const release = await createDeploymentSourceMaterializationPort({ async admit() {
                return { environmentId: 'source-database', environmentInstanceId: sourceIdentity.environmentInstanceId,
                    deploymentId: 'source-release', machineId: 'builder-c', installationId: 'installation-c',
                    deploymentRoot: sourceIdentity.deploymentRoot, artifactDirectory: join(root, 'source-artifacts'),
                    definition, async assertCurrent() {} };
            } }).materialize({ environmentId: 'source-database', deploymentId: 'source-release' });
            await release.commit();
            await mounted.lease.registry.projectManagedServices.superviseProject({ kind: 'environment',
                serverId: homeServerIdentityId, machineId: 'builder-c', environmentId: 'source-database',
                environmentInstanceId: sourceIdentity.environmentInstanceId, deploymentId: 'source-release', release,
                composeService: 'db', serviceId: `${sourceIdentity.environmentInstanceId}/db`,
                appliedServiceExports: referenceEnvironment.content.ownServer.serviceExports,
                specIdentity: JSON.stringify({ service: 'db', bindAddress: options.referenceBindAddress ?? '100.64.0.7',
                    publishedPort: referencePort, exports: referenceEnvironment.content.ownServer.serviceExports }), isCurrent: () => true,
                releaseObservation: async () => {}, nativeEffects: { keys: [] }, processSpec: { mode: { kind: 'native', builtinLifecycle: {
                    async inspect() { return { phase: 'running', readiness: 'not_reported', endpoint: null }; },
                    runtimeFacts(): ProjectNativeRuntimeFacts { return { observedAt: 1, freshness: 'current', configuration: {
                        name: 'db', replicas: null, resources: { cpus: null, memory: null }, restartPolicy: 'unless-stopped',
                        healthcheck: 'absent', mounts: [], ports: [{ target: 5432, published: referencePort,
                            bindAddress: options.referenceBindAddress ?? '100.64.0.7', protocol: 'tcp' }, ...(options.referenceDualPublication ? [{ target: 5432, published: options.referencePublishedPort ?? 25433, bindAddress: '127.0.0.1', protocol: 'tcp' as const }] : [])] } }; },
                    async stop() { return { status: 'stopped' }; },
                } } } });
        }
        const registryBinding = { purpose: 'registry' as const, targetLinkId: link.id,
            registryOrigin: 'https://docker.io', access: options.registryAccess ?? 'pull',
            source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1('registry-token'), resourceRevision: 1 } };
        if (options.registryAccess) environment.content.bindings.push(registryBinding);
        const seed = new Uint8Array(32).fill(57);
        const installations = [...link.members.map((member, index) => ({ machineId: member.machineId,
            installationId: member.installationId, seed: new Uint8Array(32).fill(58 + index) })),
            { machineId: 'builder-c', installationId: 'installation-c', seed }];
        const resource = { resourceId: 'build-token', ownerAccountId: 'account-owner', displayName: 'Build token', kind: 'token' as const,
            encryptionMode: 'plain' as const, revision: secretRevision, materialStatus: 'ready' as const, capabilities: { use: true } };
        const registryResource = { ...resource, resourceId: 'registry-token', displayName: 'Registry token', revision: 1 };
        const destination = (installation: typeof installations[number]) => ({ machineId: installation.machineId,
            installationId: installation.installationId, publicKey: nacl.sign.keyPair.fromSeed(installation.seed).publicKey });
        // Cross-owner custody comes from the actual complete-destination producer,
        // not a hand-sealed C-only fixture that could hide first-Machine fan-out.
        const prepared = await prepareEnvironmentSecretBindings({ environmentId: environment.environment.id,
            bindings: environment.content.bindings, previousBindings: [], existingGrants: [],
            runtimeInstallations: installations.slice(0, -1).map(destination), buildInstallation: destination(installations.at(-1)!),
            operationalDestinations: options.registryAccess
                ? [{ binding: registryBinding, installations: installations.map(destination) }] : [],
            materializer: createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [],
                resourceCatalogState: 'ready', isCurrent: () => true, resources: [{ ...resource,
                    storedContent: { t: 'plain', v: { v: 1, name: resource.displayName, kind: resource.kind,
                        value: 'build-owner-secret-sentinel' } } }, ...(options.registryAccess ? [{ ...registryResource,
                    storedContent: { t: 'plain' as const, v: { v: 1 as const, name: registryResource.displayName, kind: registryResource.kind,
                        value: JSON.stringify({ username: 'registry-user', password: 'registry-secret-sentinel' }) } } }] : [])] }), async assertCurrent() {} });
        const environmentInstanceId = resolveOwnServerDeploymentEnvironmentInstanceIdForHost(homeServerIdentityId, environment.environment.id);
        const sourceAdmission = { environmentId: environment.environment.id, environmentInstanceId,
            deploymentId: receipt.deployment.id, machineId: 'builder-c', installationId: 'installation-c',
            deploymentRoot: join(root, 'servers', 'home', 'deployments'), artifactDirectory: join(root, 'artifacts'),
            ...(receipt.content.sourceIntent.kind === 'repository'
                ? { sourcePath: repository, commitSha: receipt.content.sourceIntent.sha }
                : { definition: receipt.content.sourceIntent }), materializationRole: 'build' as const };
        const source = await createDeploymentSourceMaterializationPort({ admit: async () => ({ ...sourceAdmission, async assertCurrent() {} }) })
            .materialize({ environmentId: environment.environment.id, deploymentId: receipt.deployment.id });
        const physicalProjectName = resolveEnvironmentComposeProjectName({ environmentInstanceId, services: ['app', 'worker'] });
        const projection = { manifestFingerprint: source.manifestFingerprint,
            configInputDigests: [{ path: 'compose.yaml', digest: digest(document) }], physicalProjectName,
            toolVersion: '2.39.4', services: ['app', 'worker'], profiles: [] };
        const prebuilt = new Map<string, { image: DeploymentImageV1; config: string }>();
        const tags = new Map<string, DeploymentImageV1>();
        for (const service of ['app', 'worker'].filter(value => !sourceBuildServices.includes(value))) {
            for (const platform of ['linux/amd64', 'linux/arm64']) {
                const [os, architecture] = platform.split('/');
                const config = JSON.stringify({ os, architecture, config: { Labels: { service } }, rootfs: { type: 'layers', diff_ids: [] } });
                const manifestDigest = digest(`${service}/${platform}`);
                const image = { service, platform, configDigest: digest(config), manifestDigest,
                    registryReference: `example/${service}@${manifestDigest}` };
                prebuilt.set(JSON.stringify([service, platform]), { image, config });
                tags.set(image.registryReference, image);
                tags.set(image.configDigest, image);
                receipt.content.images.push(image);
            }
        }
        receipt.content.ownServer = { approvedInputBasis: { v: 1, environmentId: environment.environment.id,
            environmentRevision: environment.environment.revision, targetLinkId: link.id, targetLinkRevision: link.revision,
            sourceIntent: receipt.content.sourceIntent, ...projection,
            members: link.members.map(({ machineId, installationId }) => ({ machineId, installationId })), bindings: environment.content.bindings,
            images: [...receipt.content.images], buildServices: sourceBuildServices, ownServer: environment.content.ownServer,
            runtimeProjections: link.members.map((member, index) => ({ machineId: member.machineId,
                installationId: member.installationId, ...projection, platform: index === 0 ? 'linux/amd64' : 'linux/arm64' })) } };
        // Receipt and Environment are separately stored/opened JSON. In-memory
        // fixture edits must not mutate the already approved receipt basis.
        receipt.content = DeploymentOwnServerContentV1Schema.parse(receipt.content);
        await source.abort();
        const signal = new AbortController().signal;
        const nativeRequests: Parameters<ProjectNativeToolchainIo['run']>[0][] = [];
        let runtimeCurrent = true;
        const pulled = new Set<string>();
        const nativeIo: ProjectNativeToolchainIo = { async resolveTool() { return null; }, async run(request) {
            nativeRequests.push(request);
            assert.equal(request.env.RUNTIME_TOKEN, undefined);
            if (request.args[0] === 'buildx' && !request.args.includes('imagetools')) {
                assert.equal(request.env.BUILD_TOKEN, usesBuildSecret ? 'build-owner-secret-sentinel' : undefined);
            }
            if (request.args.includes('version')) return { exitCode: 0, stdout: request.args.includes('compose') ? '2.39.4' : 'linux/amd64' };
            if (request.args[0] === 'info') return { exitCode: 0, stdout: JSON.stringify({ ID: 'build-receipt-engine', OperatingSystem: 'Linux' }) };
            if (request.args.includes('config')) {
                const value = JSON.parse(await readFile(request.args[request.args.indexOf('--file') + 1], 'utf8'));
                // Native Compose resolves local build paths against the source
                // project directory even for --no-interpolate config output.
                for (const service of Object.values(value.services) as { build?: { context: string } }[]) {
                    if (service.build) service.build.context = resolve(request.args[request.args.indexOf('--project-directory') + 1], service.build.context);
                }
                if (options.revokeAfter === 'config') runtimeCurrent = false;
                return { exitCode: 0, stdout: JSON.stringify(value) };
            }
            if (request.args[0] === 'image') {
                const selected = tags.get(request.args[2] === '--platform' ? request.args.at(-1)! : request.args[2]);
                if (!selected) return { exitCode: 1, stdout: '' };
                if (request.args[1] === 'pull') { pulled.add(selected.configDigest); return { exitCode: 0, stdout: '' }; }
                if (request.args[1] === 'inspect' && options.coldImages && !pulled.has(selected.configDigest)) return { exitCode: 1, stdout: '' };
                if (request.args[1] === 'inspect') return { exitCode: 0, stdout: JSON.stringify([{ Id: selected.configDigest,
                    Descriptor: { digest: selected.manifestDigest, mediaType: 'application/vnd.oci.image.manifest.v1+json' },
                    RepoDigests: [selected.registryReference] }]) };
                if (request.args[1] === 'tag') { tags.set(request.args[3], selected); return { exitCode: 0, stdout: '' }; }
                if (request.args[1] === 'save') {
                    const value = prebuilt.get(JSON.stringify([selected.service, selected.platform]))!;
                    const configName = `${selected.configDigest.slice(7)}.json`;
                    await writeFile(join(root, configName), value.config);
                    await writeFile(join(root, 'manifest.json'), JSON.stringify([{ Config: configName, RepoTags: [request.args.at(-1)], Layers: [] }]));
                    await createTar({ cwd: root, file: request.args[request.args.indexOf('--output') + 1] }, [configName, 'manifest.json']);
                    return { exitCode: 0, stdout: '' };
                }
            }
            if (request.args[0] === 'buildx' && request.args[1] === 'bake') {
                // A source export can change after read-only build description.
                // Keep the real resolver/materializer and advance only its fact.
                if (options.changingBuildReference && request.args.includes('--print')) {
                    referencePort += 1;
                }
                const projectionPath = request.args[request.args.indexOf('--file') + 1];
                const projected = JSON.parse(await readFile(projectionPath, 'utf8')) as { services: Record<string, { image: string; build: { context: string } }> };
                const sets = request.args.flatMap((arg, index) => arg === '--set' ? [request.args[index + 1]] : []);
                if (request.args.includes('--print')) return { exitCode: 0, stdout: JSON.stringify({ target: Object.fromEntries(
                    Object.entries(projected.services).map(([name, value]) => [name, { context: value.build.context,
                        dockerfile: 'Dockerfile', tags: [value.image],
                        ...(options.secretBuildArgument && name === 'app' ? { args: { CANARY: 'build-owner-secret-sentinel' } } : {}),
                        secret: name === 'app' && usesBuildSecret ? [{ id: 'token', env: 'BUILD_TOKEN' }] : [] }])) }) };
                if (options.failBuild) {
                    // Process IO is the genuine boundary; the sink contract is already-masked output.
                    request.output?.onChunk('stderr', Buffer.from('build failed [REDACTED]\n'));
                    return { exitCode: 1, stdout: '', stderr: 'raw-error-secret-sentinel' };
                }
                const platform = sets.find(value => value.startsWith('*.platform='))!.slice('*.platform='.length);
                const metadata: Record<string, unknown> = {};
                for (const service of sourceBuildServices) {
                    const path = sets.find(value => value.startsWith(`${service}.output=`))!.split('dest=')[1];
                    const [os, architecture] = platform.split('/');
                    const config = JSON.stringify({ os, architecture, config: { Labels: { service } }, rootfs: { type: 'layers', diff_ids: [] } });
                    const configDigest = digest(config);
                    const manifestDigest = digest(`${service}/${platform}`);
                    const configName = `${configDigest.slice(7)}.json`;
                    await writeFile(join(root, configName), config);
                    await writeFile(join(root, 'manifest.json'), JSON.stringify([{ Config: configName, RepoTags: [projected.services[service].image], Layers: [] }]));
                    await createTar({ cwd: root, file: path }, [configName, 'manifest.json']);
                    metadata[service] = { 'containerimage.config.digest': configDigest, 'containerimage.digest': manifestDigest,
                        'containerimage.descriptor': { digest: manifestDigest, mediaType: 'application/vnd.oci.image.manifest.v1+json' } };
                }
                await writeFile(request.args[request.args.indexOf('--metadata-file') + 1], JSON.stringify(metadata));
                if (options.revokeAfter === 'build') runtimeCurrent = false;
                return { exitCode: 0, stdout: '' };
            }
            throw new Error(`Unexpected Docker boundary: ${request.args.join(' ')}`);
        } };
        const exec = createStablePluginExecService({ signal,
            isOccurrenceCurrent: () => true, resolveExecutable: async () => ({ command: '/docker' }),
            resolvePath: async () => executionDirectory,
            systemTools: { async resolve(request) { return { grantId: 'docker-fixture', toolId: request.toolId, displayName: 'Docker fixture', source: 'system', executablePath: '/docker', launch: { kind: 'binary', executablePath: '/docker' } }; } } });
        const history: OwnServerDeploymentReceipt[] = [];
        const boundaryActivity = { environmentReads: 0, receiptReads: 0, acquisitions: 0, transitions: 0 };
        const host: OwnServerDeploymentTargetHostInput = { credentials: { token: 'fixture', encryption: null },
            serverId: homeServerIdentityId, serverHttpBaseUrl: 'https://home.test', machineId: 'builder-c', signal,
            async readEnvironment() { boundaryActivity.environmentReads++; return structuredClone(environment); },
            async readReceipt() { boundaryActivity.receiptReads++; return structuredClone(receipt); },
            async *readBuildHistory() { yield* history; },
            async writeTransition(input) { boundaryActivity.transitions++;
                if (input.expectedRevision !== receipt.deployment.revision) return { ok: false,
                    errorCode: 'deployment_conflict', error: 'deployment_conflict' };
                receipt.content = DeploymentOwnServerContentV1Schema.parse(input.content);
                receipt.deployment.revision++; receipt.deployment.state = input.state;
                return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                    deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: input.state }; },
            runtime: { async acquire(request) {
                boundaryActivity.acquisitions++;
                assert.equal(request.executionRole, 'build');
                if (!runtimeCurrent) throw Object.assign(new Error('Runtime authority revoked'), { code: 'authority_revoked' });
                const acquisitionSignal = request.context.signal ? AbortSignal.any([signal, request.context.signal]) : signal;
                let released = false;
                // The host admits a finite acquisition once. Its retained loan
                // observes only local cancellation and release, not later permission edits.
                const assertCurrent = async () => {
                    if (released) throw Object.assign(new Error('Deployment source unavailable'), { code: 'deployment_source_unavailable' });
                    acquisitionSignal.throwIfAborted();
                };
                await assertCurrent();
                return { buildExecutionDirectory: executionDirectory, exec, nativeIo,
                    projectManagedServices: mounted.lease.registry.projectManagedServices, source: sourceAdmission,
                    secrets: { installationPrivateSeed: seed, grants: prepared.grants.filter(grant => grant.machineId === 'builder-c'),
                        resolveNonSecret: source => source.kind === 'reference' ? resolvePrivateServiceReferenceForHost({ source,
                            environment, host, context: request.context, actionId: request.actionId, signal: acquisitionSignal,
                            readEnvironment: async () => referenceEnvironment, owner: mounted.lease.registry.projectManagedServices,
                            homeServerIdentityId, installationId: 'installation-c', privateKey: nacl.sign.keyPair.fromSeed(seed).secretKey })
                            : Promise.reject(new Error('No generated binding in this fixture')) },
                    assertSourceCurrent: assertCurrent, assertCurrent,
                    async settleNative() {}, async release() { released = true; } };
            } } };
        const request: OwnServerDeploymentRequest = { actionId: 'deployments.deploy', input: { serverId: homeServerIdentityId,
            environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
            targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: receipt.deployment.requestKey,
            contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: receipt.deployment.contentHeaderVersion,
            contentBodyVersion: receipt.deployment.contentBodyVersion }, receipt: { ok: true,
            environmentId: environment.environment.id, revision: environment.environment.revision, deploymentId: receipt.deployment.id,
            deploymentRevision: receipt.deployment.revision, state: 'running' },
            context: { operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
        await run({ host, request, receipt, environment, referenceEnvironment, history, boundaryActivity, nativeRequests, root,
            deploymentRoot: sourceAdmission.deploymentRoot, environmentInstanceId: sourceAdmission.environmentInstanceId,
            sourceTargetPath: resolveDeploymentSourcePathForHost(sourceAdmission),
            custody: { bindings: environment.content.bindings, grants: prepared.grants, installations } });
    } finally {
        try { releaseReferenceBoundary(); await mounted.dispose(); }
        finally { Object.assign(configuration, previousConfiguration); await rm(root, { recursive: true, force: true }); }
    }
}
