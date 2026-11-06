import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { MachineServicesDetailResultV1Schema, MachineServicesListResultV1Schema,
    DeploymentChildRpcV1Schema, type DeploymentChildRpcV1 } from '@happier-dev/protocol';
import { DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
    DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentEnvironmentHeaderV1, createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1,
    createDeploymentReceiptHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { configuration } from '@/configuration';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import * as installationStore from '@/daemon/identity/store';
import { createMachineServicesRuntime } from '@/daemon/local/services/launch/machineServices';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { StoredCredentials } from '@/persistence';
import { createScmBackendRegistry } from '@/scm/registry';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createDeploymentSourceMaterializationPort } from './exactCommitRelease';
import { createOwnServerDeploymentReads } from './ownServerDeploymentReads';
import { createOwnServerDockerBoundary } from './ownServerDeployment.testkit';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import { restoreOwnServerDeploymentServices } from './restoreOwnServerDeploymentServices';
import { restoreOwnServerServicesForHost } from './restoreOwnServerServicesForHost';
import { captureOwnServerDeploymentSource } from './sourceProvenance';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler } from '@/api/rpc/types';
import { createDeploymentChildRequesterHarness } from '@/testkit/backends/deploymentChildRequesterHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { resolveAdmittedRequesterAccountReadRuntime } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { registerDaemonDeploymentChildRpcHandler } from '@/deployments/daemonDeploymentChildRpc';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function createRestartedEnvironmentFixture(nativeState: 'running' | 'stopped' | 'removed' | 'partially-removed' = 'running',
    homeInventoryMode?: 'plain' | 'e2ee', sourceCase?: 'reused-container' | 'foreign-environment', publishedPorts = true, noHealthcheck = false,
    primaryService = 'app') {
    const root = await mkdtemp(join(tmpdir(), 'happier-retained-service-recovery-'));
    const home = createHash('sha256').update(root).digest('hex').slice(0, 12);
    const docker = await createOwnServerDockerBoundary(join(root, 'tools'), { engineId: `recovery-${home}`, accounting: { memoryBytes: 2097152 } });
    const images = [await docker.registerImage(primaryService, 'retained')];
    if (nativeState === 'partially-removed') images.push(await docker.registerImage('worker', 'retained'));
    const composeServices = images.map(image => image.service);
    vi.stubEnv('PATH', `${join(root, 'tools')}${delimiter}${process.env.PATH ?? ''}`);
    const serverUrl = `https://recovery-${home}.test`;
    const profile = await addServerProfile({ name: `recovery-${home}`, serverUrl, webappUrl: serverUrl });
    await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
        v: 1, homeServerIdentityId: `srv_recovery_${home}`, canonicalServerUrl: serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: serverUrl }],
    } });
    // Installed identity is an OS-file boundary; all source and service owners remain real.
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
        installationId: 'installation-a', createdAt: 1, publicKey: Buffer.alloc(32).toString('base64url'),
        privateKey: Buffer.alloc(64).toString('base64url') });
    const target = { serverId: profile.id, machineId: 'machine-a' };
    // Reload16: serving B reused the native container created from retained A.
    const sourceDeploymentId = sourceCase ? 'cmvxhjin9002amcvu7wok7vi1' : 'deployment-a';
    const servingDeploymentId = sourceCase === 'reused-container' ? 'cmvxhwoyw002imcvup262fnnk' : sourceDeploymentId;
    const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
        serverId: target.serverId, environmentId: sourceCase ? 'cmvx1tgtc002fmc8mtjxkne1x' : `environment-recovery-${home}` });
    const sourceIdentity = sourceCase === 'foreign-environment'
        ? await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
            serverId: target.serverId, environmentId: 'environment-foreign' }) : identity;
    const document = JSON.stringify({ services: Object.fromEntries(images.map(image => [image.service,
        { image: image.registryReference, pull_policy: 'never', restart: 'unless-stopped',
            ...(noHealthcheck ? { healthcheck: { disable: true } } : {}),
            ports: image.service === primaryService && publishedPorts ? [{ target: 5432, published: '25432', host_ip: '100.64.0.7', protocol: 'tcp' },
                { target: 5432, published: '35432', host_ip: '127.0.0.1', protocol: 'udp' }] : [] }])) });
    const definition = { kind: 'stored' as const, contentRevision: 1, document,
        composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: composeServices };
    const admission = { ...sourceIdentity, ...target, deploymentId: sourceDeploymentId, installationId: 'installation-a',
        artifactDirectory: join(root, 'artifacts'), definition, async assertCurrent() {} };
    const source = await createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]),
        async admit() { return admission; } }).materialize({ environmentId: sourceIdentity.environmentId, deploymentId: sourceDeploymentId });
    const retained = await captureOwnServerDeploymentSource({ source, admission });
    await source.commit();
    // Create the pre-restart native inventory at the Docker boundary, without
    // registering any observation in the fresh runtime below.
    await promisify(execFile)(docker.executablePath, ['compose', '--project-name', identity.projectName,
        '--project-directory', source.rootPath, '--file', join(source.rootPath, 'compose.yaml'), 'up', '--detach', '--no-build', '--pull', 'never']);
    if (nativeState !== 'running') {
        const ids = await promisify(execFile)(docker.executablePath, ['ps', '--all',
            ...(nativeState === 'partially-removed' ? ['--filter', 'label=com.docker.compose.service=worker'] : []), '--format', '{{.ID}}']);
        await promisify(execFile)(docker.executablePath, ['container', ...(nativeState === 'stopped' ? ['stop'] : ['rm', '--force']),
            ...ids.stdout.trim().split('\n')]);
    }
    const environment = createDeploymentEnvironmentHeaderV1({ id: identity.environmentId, serverId: target.serverId,
        ...(sourceCase ? { revision: 13 } : {}) });
    const link = createDeploymentTargetLinkHeaderV1({ environmentId: environment.id, activeDeploymentId: servingDeploymentId });
    const sourceReceipt = createDeploymentReceiptDetailV1({
        deployment: createDeploymentReceiptHeaderV1({ environmentId: sourceIdentity.environmentId, id: sourceDeploymentId,
            ...(sourceCase ? { contentArtifactId: 'artifact-retained-a' } : {}) }),
        content: { sourceIntent: definition, machines: ['machine-a'], buildMachineId: 'machine-a', onFailure: 'rollbackAll',
            images, machineResults: [{ machineId: target.machineId, installationId: 'installation-a',
                actionOperationId: 'operation-a', steps: [], currentDeploymentId: sourceDeploymentId, activation: 'succeeded', health: 'healthy' }],
            steps: [], ownServer: { sources: [retained], approvedInputBasis: {
                v: 1, environmentId: sourceIdentity.environmentId, environmentRevision: environment.revision, targetLinkId: link.id,
                targetLinkRevision: link.revision, sourceIntent: definition, manifestFingerprint: source.manifestFingerprint,
                configInputDigests: [{ path: 'compose.yaml', digest: definition.composeDigest }], physicalProjectName: sourceIdentity.projectName,
                toolVersion: '2.39.4', services: composeServices, profiles: [], bindings: [], images,
                members: [{ machineId: 'machine-a', installationId: 'installation-a' }],
            } } },
    });
    const receipt = sourceCase ? createDeploymentReceiptDetailV1({
        deployment: createDeploymentReceiptHeaderV1({ environmentId: environment.id, id: servingDeploymentId, revision: 2,
            contentArtifactId: 'artifact-serving-b' }),
        content: { ...sourceReceipt.content,
            machineResults: sourceReceipt.content.machineResults.map(result => ({ ...result, currentDeploymentId: servingDeploymentId })),
            ownServer: { sources: [], approvedInputBasis: { ...sourceReceipt.content.ownServer!.approvedInputBasis!,
                environmentId: environment.id, physicalProjectName: identity.projectName } } },
    }) : sourceReceipt;
    const readReceipt = async (deploymentId: string) => {
        if (sourceCase && deploymentId === sourceDeploymentId) return sourceReceipt;
        if (deploymentId === receipt.deployment.id) return receipt;
        throw new Error(`Unexpected retained receipt: ${deploymentId}`);
    };
    let inventoryReads = 0;
    const openedReceiptArtifacts: string[] = [];
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', jti: home })).toString('base64url')}.signature`;
    const credentials: StoredCredentials = { token, encryption: homeInventoryMode === 'e2ee'
        ? { type: 'legacy', secret: new Uint8Array(32).fill(23) } : null };
    let requester: Awaited<ReturnType<typeof createDeploymentChildRequesterHarness>> | undefined;
    if (homeInventoryMode) {
        const mode = homeInventoryMode;
        const key = await createResourceDataKey({ credentials, mode });
        const encode = (value: unknown) => key.mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : encodeBase64(encryptWithDataKey(value, key.dataKey));
        const failed = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({
            environmentId: environment.id, id: 'deployment-newer-failed', state: 'failed', revision: 2,
            contentArtifactId: 'artifact-newer-failed', requestedAtMs: 2000, startedAtMs: 2001, settledAtMs: 2002 }),
            content: { ...receipt.content, machineResults: [] } });
        const availableReceipts = [failed, receipt, ...(sourceCase === 'reused-container' ? [sourceReceipt] : [])];
        // Home HTTP and Account Artifact storage are genuine boundaries. The
        // real history projection selects the serving version; source custody
        // opens its historical receipt through the mode-correct Artifact owner.
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(request.url!).pathname;
            expect(request.method).toBe('GET');
            if (path === '/v1/deployments/environments') {
                expect(new URL(request.url!).searchParams.get('machineId')).toBe(target.machineId);
                inventoryReads++;
                return { status: 200, data: { ok: true, items: [environment], runtimeTargetLinks: [link], nextCursor: null, coverage: 'complete' } };
            }
            if (path === `/v1/deployments/environments/${environment.id}`)
                return { status: 200, data: { ok: true, environment, targetLinks: [link] } };
            if (path === `/v1/deployments/environments/${environment.id}/deployments`)
                return { status: 200, data: { ok: true, items: availableReceipts.map(value => value.deployment), nextCursor: null } };
            const selected = availableReceipts.find(value => path === `/v1/deployments/receipts/${value.deployment.id}`);
            if (selected) return { status: 200, data: { ok: true, deployment: selected.deployment } };
            throw new Error(`Unexpected Home deployment read: ${path}`);
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(url).pathname;
            if (requester && path === '/v1/account/profile') return { status: 200, data: { id: 'bob' } };
            if (requester && path === '/v2/account/settings') return { status: 200, data: { content: requester.settingsContent, version: 1 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200,
                data: requester?.currentness ?? createAccountEncryptionCurrentnessFixture({ mode }) };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 0 } };
            if (path === `/v1/machines/${target.machineId}`) throw new axios.AxiosError('No private networks', 'ERR_BAD_REQUEST',
                undefined, undefined, { status: 404, statusText: 'Not Found', data: { error: 'not_found' },
                    headers: {}, config: { headers: new axios.AxiosHeaders() } });
            const selected = availableReceipts.find(value => path === `/v1/artifacts/${value.deployment.contentArtifactId}`);
            if (!selected && path.startsWith('/v1/artifacts/')) {
                const id = decodeURIComponent(path.split('/').at(-1)!);
                const document = id === 'domain-content' ? { kind: 'deployment-domain.v1', value: {
                    hostname: 'store.example.test', target: { service: primaryService, containerPort: 9090 } } }
                    : id === environment.contentArtifactId ? { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
                        value: createDeploymentEnvironmentDetailV1({ environment }).content }
                        : id === link.contentArtifactId ? { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, value: {} } : null;
                if (document) return { status: 200, data: { id, ownerAccountId: 'bob', access: 'owner', publicAudience: 'none',
                    encryptionMode: mode, dataEncryptionKey: key.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : key.dataEncryptionKey,
                    header: encode({ kind: document.kind, title: 'Domain' }), body: encode({ body: JSON.stringify(document.value) }),
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
            }
            if (!selected) throw new Error(`Unexpected Account Artifact read: ${path}`);
            openedReceiptArtifacts.push(selected.deployment.contentArtifactId);
            return { status: 200, data: { id: selected.deployment.contentArtifactId, ownerAccountId: 'owner',
                access: 'owner', publicAudience: 'none', encryptionMode: mode,
                dataEncryptionKey: key.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : key.dataEncryptionKey,
                header: encode({ kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Retained' }),
                body: encode({ body: JSON.stringify(selected.content) }), headerVersion: 1, bodyVersion: 1,
                seq: 1, createdAt: 1, updatedAt: 1 } };
        });
    }
    const fixture = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
        controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
    const runtime = createMachineServicesRuntime({ target,
        readMetadata: () => ({ status: 'ready', metadataVersion: 1, metadata: { serviceWatchesV1: { v: 1, watches: [] } } }),
        captureMetadataPort() { throw new Error('Read-only recovery must not write Machine metadata'); },
        restoreEnvironmentServices: (owner, signal) => homeInventoryMode
            ? restoreOwnServerServicesForHost({ ...target, installationId: 'installation-a', owner, signal,
                isCurrent: () => !signal.aborted, async resolveRuntime() { return { ...target, accountId: 'owner', credentials,
                    serverHttpBaseUrl: serverUrl, isCurrent: async () => !signal.aborted }; } })
            : restoreOwnServerDeploymentServices({ ...target,
                installationId: 'installation-a', receipt, owner, signal, isCurrent: () => !signal.aborted, readReceipt }),
    });
    const serviceFor = (composeService: string) => ({ kind: 'deployment' as const, machineId: target.machineId, environmentId: environment.id,
        environmentInstanceId: identity.environmentInstanceId, serviceId: `${identity.environmentInstanceId}/${composeService}`, composeService });
    const service = serviceFor(primaryService);
    const reads = createOwnServerDeploymentReads({ ...target, async readReceipt(request) {
        return request.deploymentId === receipt.deployment.id ? receipt : readReceipt(request.deploymentId); },
        async readRetentionHeaders() { return { environment, deployment: receipt.deployment, link }; },
        async readEnvironmentMetadata() { return { environment, targetLinks: [link] }; }, async assertCurrent() {},
        ensureServiceObservations: runtime.ensureEnvironmentServices,
    });
    const context = { surface: 'cli' as const, authority: 'present_user' as const };
    const readInput = { ...target, environmentId: environment.id, deploymentId: receipt.deployment.id,
        targetLinkId: link.id, installationId: 'installation-a', service };
    return { docker, runtime, reads, context, readInput, service, serviceFor,
        targetLinkId: link.id,
        async discoverDomain(job: DeploymentChildRpcV1) {
            const channel = await createRequesterCurrentnessSocketHarness();
            let prepared: Awaited<ReturnType<Awaited<ReturnType<typeof createDeploymentChildRequesterHarness>>['prepare']>> | undefined;
            try {
                requester = await createDeploymentChildRequesterHarness({ encryptionMode: 'plain', job, profileId: target.serverId,
                    serverHttpBaseUrl: serverUrl, receivingIdentity: { ...target, installationId: 'installation-a',
                        homeIdentityId: identity.homeServerIdentityId } });
                prepared = await requester.prepare();
                const handlers = new Map<string, RpcHandler>();
                registerDaemonDeploymentChildRpcHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                    machineId: target.machineId,
                    ensureServiceObservations: runtime.ensureEnvironmentServices,
                    resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                    resolveRequesterRuntime: ingress => resolveAdmittedRequesterAccountReadRuntime({ ingress, ...target,
                        installationId: 'installation-a', isInstalledCurrent: () => true }),
                    resolveInstalledRuntime: async () => ({ ...target, accountId: 'owner', credentials,
                        serverHttpBaseUrl: serverUrl, isCurrent: async () => true }),
                    acquirePluginRuntimeRegistryLease: async () => fixture.lease,
                });
                return await handlers.get(RPC_METHODS.DAEMON_DEPLOYMENT_CHILD)!(job, {
                    signal: new AbortController().signal, callerInputAuthorization: prepared.authorization,
                    originalActionEnvelope: requester.envelope, workspaceSyncSourceExecution: requester.packet,
                    machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'owner', machineId: target.machineId,
                        installationId: 'installation-a', role: 'manage', encryptionMode: 'plain' },
                    verifyMachineAdmissionCurrent: async () => true,
                });
            } finally { await prepared?.dispose(); await channel.close(); }
        },
        sourcePath: source.rootPath, sourceDeploymentId, openedReceiptArtifacts, environmentRevision: environment.revision,
        get inventoryReads() { return inventoryReads; },
        detail: async () => MachineServicesDetailResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.detail',
            input: { ...target, serviceId: service.serviceId }, context, canReadEnvironments: async ids => new Set(ids) })),
        list: async () => MachineServicesListResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.list',
            input: { ...target, environmentId: environment.id }, context, canReadEnvironments: async ids => new Set(ids) })),
        async dispose() { await runtime.dispose();
            for (const composeService of composeServices)
                await fixture.registry.projectManagedServices.resolveEnvironmentService(identity.homeServerIdentityId, serviceFor(composeService))?.dispose();
            await fixture.dispose();
            for (const retainedIdentity of [identity, ...(sourceIdentity === identity ? [] : [sourceIdentity])])
                await rm(join(retainedIdentity.deploymentRoot, retainedIdentity.environmentInstanceId), { recursive: true, force: true });
            await rm(root, { recursive: true, force: true }); },
    };
}

describe('retained Environment service recovery on first use', () => {
    it.each([{ service: 'uptime-kuma', state: 'running' }, { service: 'linkding', state: 'running' },
        { service: 'linkding', state: 'removed' }] as const)('recovers Store $service Docker when Domain discovery is the first read after restart ($state)', async ({ service, state }) => {
        const fixture = await createRestartedEnvironmentFixture(state, 'plain', undefined, false, false, service);
        try {
            const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domainDiscover', actionId: 'deployments.domains.add',
                machineId: fixture.readInput.machineId, installationId: 'installation-a',
                input: { serverId: fixture.readInput.serverId, environmentId: fixture.service.environmentId,
                    targetLinkId: fixture.targetLinkId, expectedRevision: 1, expectedTargetLinkRevision: 1,
                    domainId: 'store-domain', requestKey: 'discover-domain', contentArtifactId: 'domain-content',
                    contentHeaderVersion: 1, contentBodyVersion: 1 } });
            if (job.kind !== 'domainDiscover') throw new Error('Expected Domain discovery');
            // The next real prerequisite is Caddy setup, which this read-only
            // fixture deliberately does not grant. It must get past Docker and replicas.
            const result = await fixture.discoverDomain(job);
            if (state === 'removed') {
                expect(result).toMatchObject({ ok: false, errorCode: 'service_unavailable',
                    failureCause: { phase: 'deployment.domain.service_docker', errorCode: 'service_unavailable' },
                    details: { step: 'service_docker', requiredFact: 'managedServiceDocker', remedy: expect.any(String) } });
                expect(fixture.inventoryReads).toBe(1);
                return;
            }
            expect(result).toMatchObject({ ok: false, errorCode: 'admin_access_unavailable' });
            expect(fixture.inventoryReads).toBe(1);
            expect(await fixture.list()).toMatchObject({ kind: 'snapshot', services: [{
                serviceId: fixture.service.serviceId, state: 'healthy' }] });
            expect(fixture.inventoryReads, 'Domain and Services share the same recovery attempt').toBe(1);
            expect((await fixture.docker.readInvocations()).filter(call => call.args.includes('up'))).toHaveLength(1);
        } finally { await fixture.dispose(); }
    });

    it('retains accounting and configuration for the no-healthcheck app after reusing its older container', async () => {
        const fixture = await createRestartedEnvironmentFixture('running', 'plain', 'reused-container', true, true);
        try {
            expect(await fixture.detail()).toMatchObject({ kind: 'service',
                service: { name: 'app', native: { phase: 'running', readiness: 'not_reported' } },
                accounting: { kind: 'sample', samples: [{ memoryBytes: 2097152 }] },
                runtimeFacts: { freshness: 'current', configuration: { name: 'app', healthcheck: 'absent', restartPolicy: 'unless-stopped' } },
            });
        } finally { await fixture.dispose(); }
    });

    it.each([{ mode: 'plain', published: true }, { mode: 'e2ee', published: true },
        { mode: 'plain', published: false }] as const)('finds the activated retained receipt through real $mode Home inventory (published=$published)', async ({ mode, published }) => {
        const fixture = await createRestartedEnvironmentFixture('running', mode, undefined, published);
        try {
            expect(await fixture.list()).toMatchObject({ kind: 'snapshot', services: [{ serviceId: fixture.service.serviceId,
                state: 'healthy', health: { freshness: 'current' }, deployment: { deploymentId: 'deployment-a' },
                configuration: { ports: published ? [
                    { target: 5432, published: '25432', bindAddress: '100.64.0.7', protocol: 'tcp' },
                    { target: 5432, published: '35432', bindAddress: '127.0.0.1', protocol: 'udp' },
                ] : [] } }] });
            expect(await fixture.list()).toMatchObject({ kind: 'snapshot', services: [{ serviceId: fixture.service.serviceId }] });
            expect(fixture.inventoryReads, 'one retained inventory per managed owner/target').toBe(1);
            expect((await fixture.docker.readInvocations()).filter(call => call.args.includes('up'))).toHaveLength(1);
        } finally { await fixture.dispose(); }
    });

    it.each(['list', 'health', 'drift'] as const)('recovers a surviving native service when %s is the first read', async first => {
        const fixture = await createRestartedEnvironmentFixture();
        try {
            if (first === 'list') expect(await fixture.list()).toMatchObject({ kind: 'snapshot', services: [
                { serviceId: fixture.service.serviceId, state: 'healthy', native: { phase: 'running' } },
            ] });
            if (first === 'health') {
                const health = await fixture.reads('deployments.health.read', fixture.readInput, fixture.context);
                expect(health).toMatchObject({ ok: true, freshness: 'current', health: 'healthy', native: { phase: 'running' } });
            }
            if (first === 'drift') expect(await fixture.reads('deployments.drift.read', { ...fixture.readInput, expectedRevision: 1 }, fixture.context))
                .toMatchObject({ ok: true, freshness: 'current' });
            expect(await fixture.list()).toMatchObject({ kind: 'snapshot', services: [{ serviceId: fixture.service.serviceId }] });
        } finally { await fixture.dispose(); }
    });

    it('retains an honestly stopped service without starting its native container', async () => {
        const fixture = await createRestartedEnvironmentFixture('stopped');
        try {
            expect(await fixture.list()).toMatchObject({ kind: 'snapshot', services: [
                { serviceId: fixture.service.serviceId, state: 'stopped', native: { phase: 'stopped' } },
            ] });
            expect(await fixture.reads('deployments.health.read', fixture.readInput, fixture.context))
                .toMatchObject({ ok: true, freshness: 'current', health: 'unhealthy', native: { phase: 'stopped' } });
            expect((await fixture.docker.readInvocations()).filter(call => call.args.includes('up'))).toHaveLength(1);
        } finally { await fixture.dispose(); }
    });

    it('does not invent a running service after its native container was removed', async () => {
        const fixture = await createRestartedEnvironmentFixture('removed');
        try {
            const listed = await fixture.list();
            expect(listed.kind).toBe('snapshot');
            if (listed.kind !== 'snapshot') throw new Error('Expected settled service inventory');
            const retained = listed.services.find(service => service.serviceId === fixture.service.serviceId);
            if (retained) expect(retained).toMatchObject({ state: 'stopped', native: { phase: 'stopped' } });
            else expect(listed.services).toEqual([]);
            const health = await fixture.reads('deployments.health.read', fixture.readInput, fixture.context);
            expect(health).toMatchObject(retained
                ? { ok: true, health: 'unhealthy', native: { phase: 'stopped' } }
                : { ok: false, errorCode: 'service_unavailable' });
            const invocations = await fixture.docker.readInvocations();
            expect(invocations.filter(call => call.args.includes('up'))).toHaveLength(1);
        } finally { await fixture.dispose(); }
    });

    it('recovers the surviving service when another retained service container was removed', async () => {
        const fixture = await createRestartedEnvironmentFixture('partially-removed');
        try {
            const listed = await fixture.list();
            expect(listed).toMatchObject({ kind: 'snapshot', services: [
                { serviceId: fixture.service.serviceId, state: 'healthy', native: { phase: 'running' } },
            ] });
            if (listed.kind !== 'snapshot') throw new Error('Expected settled service inventory');
            expect(listed.services.map(service => service.serviceId)).toEqual([fixture.service.serviceId]);
            expect(await fixture.reads('deployments.health.read', fixture.readInput, fixture.context))
                .toMatchObject({ ok: true, freshness: 'current', health: 'healthy', native: { phase: 'running' } });
            expect(await fixture.reads('deployments.health.read', { ...fixture.readInput, service: fixture.serviceFor('worker') }, fixture.context))
                .toMatchObject({ ok: false, errorCode: 'service_unavailable' });
            expect((await fixture.docker.readInvocations()).filter(call => call.args.includes('up'))).toHaveLength(1);
        } finally { await fixture.dispose(); }
    });

    it.each(['plain', 'e2ee'] as const)('recovers serving B through %s Home inventory when its reused container retains source A', async mode => {
        const fixture = await createRestartedEnvironmentFixture('running', mode, 'reused-container');
        try {
            expect(await fixture.list()).toMatchObject({ kind: 'snapshot', services: [
                { serviceId: fixture.service.serviceId, state: 'healthy', native: { phase: 'running' },
                    deployment: { deploymentId: 'cmvxhwoyw002imcvup262fnnk' }, configuration: { ports: [
                        { target: 5432, published: '25432', bindAddress: '100.64.0.7', protocol: 'tcp' },
                        { target: 5432, published: '35432', bindAddress: '127.0.0.1', protocol: 'udp' },
                    ] } },
            ] });
            expect(await fixture.reads('deployments.health.read', fixture.readInput, fixture.context))
                .toMatchObject({ ok: true, deploymentId: 'cmvxhwoyw002imcvup262fnnk', freshness: 'current',
                    health: 'healthy', native: { phase: 'running' } });
            expect(await fixture.reads('deployments.drift.read', { ...fixture.readInput,
                expectedRevision: fixture.environmentRevision }, fixture.context))
                .toMatchObject({ ok: true, deploymentId: 'cmvxhwoyw002imcvup262fnnk', freshness: 'current', differingFields: [] });
            expect(fixture.openedReceiptArtifacts).toEqual(expect.arrayContaining(['artifact-serving-b', 'artifact-retained-a']));
            const ids = await promisify(execFile)(fixture.docker.executablePath, ['ps', '--all', '--format', '{{.ID}}']);
            const inspected = await promisify(execFile)(fixture.docker.executablePath,
                ['inspect', '--type', 'container', ...ids.stdout.trim().split('\n')]);
            expect(JSON.parse(inspected.stdout)).toMatchObject([{ Config: { Labels: {
                'com.docker.compose.project.working_dir': fixture.sourcePath,
            } } }]);
            expect(fixture.sourcePath).toContain(join('releases', fixture.sourceDeploymentId));
            expect((await fixture.docker.readInvocations()).filter(call => call.args.includes('up'))).toHaveLength(1);
        } finally { await fixture.dispose(); }
    });

    it('rejects matching native labels when retained source belongs to a foreign Environment', async () => {
        const fixture = await createRestartedEnvironmentFixture('running', undefined, 'foreign-environment');
        try {
            const listed = await fixture.list();
            if (listed.kind === 'snapshot') expect(listed.services).toEqual([]);
            else expect(listed.kind).toBe('unavailable');
            expect(await fixture.reads('deployments.health.read', fixture.readInput, fixture.context))
                .toMatchObject({ ok: false, errorCode: 'service_unavailable' });
            expect((await fixture.docker.readInvocations()).filter(call => call.args.includes('up'))).toHaveLength(1);
        } finally { await fixture.dispose(); }
    });
});
