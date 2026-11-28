import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import nacl from 'tweetnacl';
import { MachineServicesDetailResultV1Schema, MachineServicesListResultV1Schema,
    DeploymentChildRpcV1Schema, accountSettingsParse, type DeploymentChildRpcV1, type ActionExecutorContext } from '@happier-dev/protocol';
import { DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
    DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createDeploymentEnvironmentHeaderV1,
    createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { configuration } from '@/configuration';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import * as installationStore from '@/daemon/identity/store';
import { createMachineServicesRuntime } from '@/daemon/local/services/launch/machineServices';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { StoredCredentials } from '@/persistence';
import type { DeploymentServiceExportV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { createScmBackendRegistry } from '@/scm/registry';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createDeploymentSourceMaterializationPort } from './exactCommitRelease';
import { createOwnServerDeploymentReads } from './ownServerDeploymentReads';
import { createOwnServerDockerBoundary } from './ownServerDeployment.testkit';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import { restoreOwnServerDeploymentServices, type RestoreOwnServerDeploymentServicesInput } from './restoreOwnServerDeploymentServices';
import { restoreOwnServerServicesForHost } from './restoreOwnServerServicesForHost';
import { readRelayHttpBody } from './privateServiceContainerBridge.testkit';
import { createDeploymentTelemetryHost } from '../../telemetry/collectorHost';
import { releaseRemovedServiceReferenceForwards } from './serviceReferenceForwardCustody';
import { captureOwnServerDeploymentSource } from './sourceProvenance';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler } from '@/api/rpc/types';
import { createDeploymentChildRequesterHarness } from '@/testkit/backends/deploymentChildRequesterHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { resolveAdmittedRequesterAccountReadRuntime } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { registerDaemonDeploymentChildRpcHandler } from '@/deployments/daemonDeploymentChildRpc';
import type { RequesterEnvironmentAccessObservation } from '@/api/client/accountEncryptionCurrentnessObservation';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { createDaemonDeploymentActionDeps } from '../../createDaemonDeploymentActionDeps';
import { createOwnServerDeploymentRuntimeForHost } from './ownServerDeploymentHostRuntime';
import { resolvePrivateServiceReferenceForHost } from './privateServiceReference';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { artifactListResponse, artifactReadResponse } from '@/testkit/http/artifactHome';
import { readOwnedNoticeArtifactV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { DeploymentActionInputSchemasV1 } from '@happier-dev/protocol';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { logger } from '@/ui/logger';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function createRestartedEnvironmentFixture(nativeState: 'running' | 'stopped' | 'removed' | 'partially-removed' = 'running',
    homeInventoryMode?: 'plain' | 'e2ee', sourceCase?: 'reused-container' | 'foreign-environment' | 'mixed-service-sources', publishedPorts = true, noHealthcheck = false,
    primaryService = 'app', appliedServiceExports: DeploymentServiceExportV1[] = [], restoration = false, prepareReadRole = false,
    referencePublication?: Readonly<{ host: string; port: string }>, includeUnreadableEnvironment = false, readTelemetryCollectorEndpoint?: () => string | null) {
    const root = await mkdtemp(join(tmpdir(), 'happier-retained-service-recovery-'));
    const home = createHash('sha256').update(root).digest('hex').slice(0, 12);
    const docker = await createOwnServerDockerBoundary(join(root, 'tools'), { engineId: `recovery-${home}`, accounting: { memoryBytes: 2097152 } });
    const images = [await docker.registerImage(primaryService, 'retained')];
    if (nativeState === 'partially-removed' || sourceCase === 'mixed-service-sources') images.push(await docker.registerImage('worker', 'retained'));
    const composeServices = images.map(image => image.service);
    vi.stubEnv('PATH', `${join(root, 'tools')}${delimiter}${process.env.PATH ?? ''}`);
    const serverUrl = `https://recovery-${home}.test`;
    const profile = await addServerProfile({ name: `recovery-${home}`, serverUrl, webappUrl: serverUrl });
    await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
        v: 1, homeServerIdentityId: `srv_recovery_${home}`, canonicalServerUrl: serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: serverUrl }],
    } });
    // Installed identity is an OS-file boundary; all source and service owners remain real.
    const installationKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
    const installation = { machineId: 'machine-a', installationId: 'installation-a',
        publicKey: Buffer.from(installationKeys.publicKey).toString('base64url') };
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
        installationId: installation.installationId, createdAt: 1,
        publicKey: prepareReadRole ? installation.publicKey : Buffer.alloc(32).toString('base64url'),
        privateKey: prepareReadRole ? Buffer.from(installationKeys.secretKey).toString('base64url') : Buffer.alloc(64).toString('base64url') });
    const target = { serverId: profile.id, machineId: 'machine-a' };
    // Reload16: serving B reused the native container created from retained A.
    const sourceDeploymentId = sourceCase ? 'cmvxhjin9002amcvu7wok7vi1' : 'deployment-a';
    const servingDeploymentId = sourceCase === 'reused-container' || sourceCase === 'mixed-service-sources' ? 'cmvxhwoyw002imcvup262fnnk' : sourceDeploymentId;
    const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
        serverId: target.serverId, environmentId: sourceCase ? 'cmvx1tgtc002fmc8mtjxkne1x' : `environment-recovery-${home}` });
    const sourceIdentity = sourceCase === 'foreign-environment'
        ? await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
            serverId: target.serverId, environmentId: 'environment-foreign' }) : identity;
    const exporterHost = readTelemetryCollectorEndpoint ? 'happier-relay-' + createHash('sha256').update(JSON.stringify([
        process.getuid!(), `recovery-${home}`, createHash('sha256').update(`${identity.projectName}_default`).digest('hex'),
        JSON.stringify([identity.environmentInstanceId, sourceDeploymentId, 'telemetry']),
    ])).digest('hex').slice(0, 32) : undefined;
    const document = JSON.stringify({ services: Object.fromEntries(images.map(image => [image.service,
        { image: image.registryReference, pull_policy: 'never', restart: 'unless-stopped',
            ...(exporterHost ? { environment: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://${exporterHost}:8080` } } : {}),
            ...(noHealthcheck ? { healthcheck: { disable: true } } : {}),
            ports: image.service === primaryService && publishedPorts ? [{ target: 5432, published: referencePublication?.port ?? '25432', host_ip: referencePublication?.host ?? '100.64.0.7', protocol: 'tcp' },
                { target: 5432, published: '35432', host_ip: '127.0.0.1', protocol: 'udp' }] : [] }])) });
    const definition = { kind: 'stored' as const, contentRevision: 1, document,
        composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: composeServices };
    const runtimeBindings = prepareReadRole ? [{ purpose: 'variable' as const, phase: 'runtime' as const, name: 'DB_NAME',
        grantRef: '00000000-0000-4000-8000-000000000041', source: { kind: 'value' as const, value: 'fixture_database' } }] : [];
    const admission = { ...sourceIdentity, ...target, deploymentId: sourceDeploymentId, installationId: 'installation-a',
        artifactDirectory: join(root, 'artifacts'), definition,
        ...(restoration ? { restorationForDeploymentId: sourceDeploymentId } : {}), async assertCurrent() {} };
    const source = await createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]),
        async admit() { return admission; } }).materialize({ environmentId: sourceIdentity.environmentId, deploymentId: sourceDeploymentId });
    const retained = await captureOwnServerDeploymentSource({ source, admission });
    await source.commit();
    // Create the pre-restart native inventory at the Docker boundary, without
    // registering any observation in the fresh runtime below.
    await promisify(execFile)(docker.executablePath, ['compose', '--project-name', identity.projectName,
        '--project-directory', source.rootPath, '--file', join(source.rootPath, 'compose.yaml'), 'up', '--detach', '--no-build', '--pull', 'never']);
    let servingSource = retained;
    if (sourceCase === 'mixed-service-sources') {
        const nextAdmission = { ...admission, deploymentId: servingDeploymentId, restorationForDeploymentId: undefined };
        const nextSource = await createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]),
            async admit() { return nextAdmission; } }).materialize({ environmentId: identity.environmentId, deploymentId: servingDeploymentId });
        servingSource = await captureOwnServerDeploymentSource({ source: nextSource, admission: nextAdmission });
        await nextSource.commit();
        // Docker boundary: Compose retained app from A while worker was created
        // from B. Recovery must prove each service's own retained source.
        const statePath = join(root, 'tools', 'docker-state.json');
        const state = JSON.parse(await readFile(statePath, 'utf8')) as { containers: { Config: { Labels: Record<string, string> } }[] };
        const worker = state.containers.find(row => row.Config.Labels['com.docker.compose.service'] === 'worker')!;
        worker.Config.Labels['com.docker.compose.project.working_dir'] = nextSource.rootPath;
        await writeFile(`${statePath}.next`, JSON.stringify(state));
        await rename(`${statePath}.next`, statePath);
    }
    if (nativeState !== 'running') {
        const ids = await promisify(execFile)(docker.executablePath, ['ps', '--all',
            ...(nativeState === 'partially-removed' ? ['--filter', 'label=com.docker.compose.service=worker'] : []), '--format', '{{.ID}}']);
        await promisify(execFile)(docker.executablePath, ['container', ...(nativeState === 'stopped' ? ['stop'] : ['rm', '--force']),
            ...ids.stdout.trim().split('\n')]);
    }
    const environment = createDeploymentEnvironmentHeaderV1({ id: identity.environmentId, serverId: target.serverId,
        ...(sourceCase ? { revision: 13 } : {}) });
    const link = createDeploymentTargetLinkHeaderV1({ environmentId: environment.id, activeDeploymentId: servingDeploymentId });
    const unreadableEnvironment = createDeploymentEnvironmentHeaderV1({ ...environment, id: 'unreadable-environment',
        runtimeTargetLinkId: 'unreadable-link' });
    const unreadableReceipt = createDeploymentReceiptHeaderV1({ id: 'unreadable-deployment',
        environmentId: unreadableEnvironment.id, targetLinkId: 'unreadable-link', contentArtifactId: 'unreadable-receipt-artifact' });
    const unreadableLink = createDeploymentTargetLinkHeaderV1({ ...link, id: unreadableReceipt.targetLinkId,
        environmentId: unreadableEnvironment.id, activeDeploymentId: unreadableReceipt.id });
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
                toolVersion: '2.39.4', services: composeServices, profiles: [], bindings: runtimeBindings, images,
                ownServer: { rollout: 'recreate', autoRestorePreviousRelease: false, serviceExports: appliedServiceExports },
                members: [{ machineId: 'machine-a', installationId: 'installation-a' }],
            } } },
    });
    const receipt = sourceCase ? createDeploymentReceiptDetailV1({
        deployment: createDeploymentReceiptHeaderV1({ environmentId: environment.id, id: servingDeploymentId, revision: 2,
            contentArtifactId: 'artifact-serving-b' }),
        content: { ...sourceReceipt.content,
            machineResults: sourceReceipt.content.machineResults.map(result => ({ ...result, currentDeploymentId: servingDeploymentId })),
            ownServer: { sources: sourceCase === 'mixed-service-sources' ? [servingSource] : [], approvedInputBasis: { ...sourceReceipt.content.ownServer!.approvedInputBasis!,
                environmentId: environment.id, physicalProjectName: identity.projectName } } },
    }) : sourceReceipt;
    const readReceipt = async (deploymentId: string) => {
        if (sourceCase && deploymentId === sourceDeploymentId) return sourceReceipt;
        if (deploymentId === receipt.deployment.id) return receipt;
        throw new Error(`Unexpected retained receipt: ${deploymentId}`);
    };
    let inventoryReads = 0;
    const unreadableReads: string[] = [];
    const noticeRows = new Map<string, { id: string } & Record<string, unknown>>();
    const healthLog = vi.spyOn(logger, 'infoFile');
    const openedReceiptArtifacts: string[] = [];
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', jti: home })).toString('base64url')}.signature`;
    const credentials: StoredCredentials = { token, encryption: homeInventoryMode === 'e2ee'
        ? { type: 'legacy', secret: new Uint8Array(32).fill(23) } : null };
    const readRoleRef = formatSharedSavedSecretRefV1('recovery-read-role');
    const bindingEnvironment = prepareReadRole ? createDeploymentEnvironmentDetailV1({ environment,
        content: { ...createDeploymentEnvironmentDetailV1({ environment }).content, definition, bindings: runtimeBindings,
            template: { templateRef: { sourceId: 'catalog', itemId: 'postgres', version: '1', ref: { kind: 'version', version: '1' } },
                definition: { kind: 'stored', contentRevision: 1, composeDigest: definition.composeDigest }, services: composeServices,
                data: [{ engine: 'postgres', service: primaryService, version: '16', variables: { database: 'DB_NAME' } }] } } }) : undefined;
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
        const availableReceipts = [failed, receipt, ...(sourceCase === 'reused-container' || sourceCase === 'mixed-service-sources' ? [sourceReceipt] : [])];
        // Home HTTP and Account Artifact storage are genuine boundaries. The
        // real history projection selects the serving version; source custody
        // opens its historical receipt through the mode-correct Artifact owner.
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(request.url!).pathname;
            if (prepareReadRole && path.endsWith('/secret-launch-admission')) return { status: 200, data: { ok: true,
                grants: [], bindingPreparation: { runtimeInstallations: [installation], buildInstallation: installation } } };
            expect(request.method).toBe('GET');
            if (path === '/v1/deployments/environments') {
                const query = new URL(request.url!).searchParams;
                expect(query.get('machineId')).toBe(target.machineId);
                inventoryReads++;
                const ids = query.getAll('environmentIds');
                const inventory = [{ environment, link }, ...(includeUnreadableEnvironment ? [{ environment: unreadableEnvironment, link: unreadableLink }] : [])]
                    .filter(row => !ids.length || ids.includes(row.environment.id));
                return { status: 200, data: { ok: true, items: inventory.map(row => row.environment),
                    runtimeTargetLinks: inventory.map(row => row.link), nextCursor: null, coverage: 'complete' } };
            }
            if (path === `/v1/deployments/environments/${environment.id}`)
                return { status: 200, data: { ok: true, environment, targetLinks: [link] } };
            if (includeUnreadableEnvironment && path === `/v1/deployments/environments/${unreadableEnvironment.id}`) {
                unreadableReads.push('environment');
                return { status: 200, data: { ok: true, environment: unreadableEnvironment, targetLinks: [unreadableLink] } };
            }
            if (includeUnreadableEnvironment && path === `/v1/deployments/environments/${unreadableEnvironment.id}/deployments`) {
                unreadableReads.push('receipts');
                return { status: 200, data: { ok: true, items: [unreadableReceipt], nextCursor: null } };
            }
            if (path === `/v1/deployments/environments/${environment.id}/deployments`)
                return { status: 200, data: { ok: true, items: availableReceipts.map(value => value.deployment), nextCursor: null } };
            const selected = availableReceipts.find(value => path === `/v1/deployments/receipts/${value.deployment.id}`);
            if (selected) return { status: 200, data: { ok: true, deployment: selected.deployment } };
            throw new Error(`Unexpected Home deployment read: ${path}`);
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(url).pathname;
            if (path === `/v1/artifacts/${unreadableReceipt.contentArtifactId}`) unreadableReads.push('artifact');
            if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(url, [...noticeRows.values()]) };
            const noticeRow = noticeRows.get(path.split('/')[3]!);
            if (noticeRow) return { status: 200, data: path.endsWith('/recipients') ? {
                artifactId: noticeRow.id, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
                dataEncryptionKey: noticeRow.dataEncryptionKey, callerDataEncryptionKey: noticeRow.dataEncryptionKey, recipients: [],
                provenanceDataEncryptionKey: noticeRow.provenanceDataEncryptionKey,
                callerProvenanceDataEncryptionKey: noticeRow.provenanceDataEncryptionKey,
            } : noticeRow };
            if ((requester || prepareReadRole) && path === '/v1/account/profile') return { status: 200, data: { id: requester ? 'bob' : 'owner' } };
            if ((requester || prepareReadRole) && path === '/v2/account/settings') return { status: 200,
                data: { content: requester?.settingsContent ?? { t: 'plain', v: {} }, version: 1 } };
            if (prepareReadRole && path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: {
                resources: [{ resourceId: 'recovery-read-role', encryptionMode: 'plain', recipientEnvelope: null,
                    entry: { ref: readRoleRef, source: 'shared_resource', relationship: 'owner', name: 'Read role', kind: 'token',
                        ownerAccountId: 'owner', revision: 1, materialStatus: 'ready',
                        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
                    storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'recovery-read-role', mode: 'plain',
                        content: { v: 1, name: 'Read role', kind: 'token', value: 'fixture-read-role-password' } }) }] } };
            if (path === '/v1/account/encryption/currentness') return { status: 200,
                data: requester?.currentness ?? createAccountEncryptionCurrentnessFixture({ mode }) };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 0 } };
            if (referencePublication && path === `/v1/machines/${target.machineId}`) return { status: 200, data: { machine: {
                id: target.machineId, kind: 'persistent', revokedAt: null, replacedByMachineId: null,
                seq: 1, active: true, activeAt: 1, createdAt: 1, updatedAt: 1,
                installationId: installation.installationId, storageMode: 'plain',
                metadata: null, metadataVersion: 1, daemonState: null, daemonStateVersion: 1, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            } } };
            if (path === `/v1/machines/${target.machineId}`) throw new axios.AxiosError('No private networks', 'ERR_BAD_REQUEST',
                undefined, undefined, { status: 404, statusText: 'Not Found', data: { error: 'not_found' },
                    headers: {}, config: { headers: new axios.AxiosHeaders() } });
            const selected = availableReceipts.find(value => path === `/v1/artifacts/${value.deployment.contentArtifactId}`);
            if (!selected && path.startsWith('/v1/artifacts/')) {
                const id = decodeURIComponent(path.split('/').at(-1)!);
                const document = id === 'domain-content' ? { kind: 'deployment-domain.v1', value: {
                    hostname: 'store.example.test', target: { service: primaryService, containerPort: 9090 } } }
                    : id === environment.contentArtifactId ? { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
                        value: bindingEnvironment?.content ?? createDeploymentEnvironmentDetailV1({ environment }).content }
                        : id === link.contentArtifactId ? { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, value: {} } : null;
                if (document) return { status: 200, data: { id, ownerAccountId: 'bob', access: 'owner', publicAudience: 'none',
                    encryptionMode: mode, dataEncryptionKey: key.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : key.dataEncryptionKey,
                    header: encode({ kind: document.kind, title: 'Domain' }), body: encode({ body: JSON.stringify(document.value) }),
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
                return { status: 404, data: { error: 'not_found' } };
            }
            if (!selected) throw new Error(`Unexpected Account Artifact read: ${path}`);
            return { status: 200, data: receiptArtifactRow(selected) };
        });
        const receiptArtifactRow = (selected: typeof receipt) => {
            openedReceiptArtifacts.push(selected.deployment.contentArtifactId);
            return { id: selected.deployment.contentArtifactId, ownerAccountId: 'owner',
                access: 'owner', publicAudience: 'none', encryptionMode: mode,
                dataEncryptionKey: key.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : key.dataEncryptionKey,
                header: encode({ kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Retained' }),
                body: encode({ body: JSON.stringify(selected.content) }), headerVersion: 1, bodyVersion: 1,
                seq: 1, createdAt: 1, updatedAt: 1 };
        };
        vi.spyOn(axios, 'post').mockImplementation(async (url, input) => {
            if (new URL(url).pathname === '/v1/artifacts/read') {
                const result = artifactReadResponse(input, id => {
                    const selected = availableReceipts.find(value => id === value.deployment.contentArtifactId);
                    if (!selected) return noticeRows.get(id) ?? null;
                    return receiptArtifactRow(selected);
                });
                if ((input as { artifactIds: string[] }).artifactIds.includes(unreadableReceipt.contentArtifactId)) unreadableReads.push('artifact');
                return result;
            }
            const mutation = readCarrierMutation(input);
            const id = typeof mutation.id === 'string' ? mutation.id : new URL(url).pathname.split('/').at(-1)!;
            const prior = noticeRows.get(id);
            const version = Number(prior?.bodyVersion ?? 0) + 1;
            noticeRows.set(id, { ...prior, ...mutation, id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                encryptionMode: mode, headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version });
            return { status: 200, data: { id, success: true, headerVersion: version, bodyVersion: version } };
        });
    }
    const fixture = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
        controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
    const recover = (owner: RestoreOwnServerDeploymentServicesInput['owner'], signal: AbortSignal,
        restoreServiceReferences?: RestoreOwnServerDeploymentServicesInput['restoreServiceReferences']) =>
        restoreOwnServerDeploymentServices({ ...target, installationId: 'installation-a', receipt, owner, signal,
            isCurrent: () => !signal.aborted, readReceipt, ...(restoreServiceReferences ? { restoreServiceReferences } : {}) });
    const runtime = createMachineServicesRuntime({ target,
        readMetadata: () => ({ status: 'ready', metadataVersion: 1, metadata: { serviceWatchesV1: { v: 1, watches: [] } } }),
        captureMetadataPort() { throw new Error('Read-only recovery must not write Machine metadata'); },
        restoreEnvironmentServices: (owner, signal, observations, environmentId) => homeInventoryMode
            ? restoreOwnServerServicesForHost({ ...observations, readTelemetryCollectorEndpoint, ...target, environmentId, installationId: 'installation-a', owner, signal,
                isCurrent: () => !signal.aborted, async resolveRuntime() { return { ...target, accountId: 'owner', credentials,
                    serverHttpBaseUrl: serverUrl, isCurrent: async () => !signal.aborted }; } })
            : recover(owner, signal),
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
        noticeDiagnostics: () => healthLog.mock.calls.filter(([tag]) => tag.startsWith('[deploymentHealth]')),
        async executeNoticeRestart(input: unknown) {
            const request = DeploymentActionInputSchemasV1['deployments.restart'].parse(input);
            const host = { ...target, credentials, serverHttpBaseUrl: serverUrl,
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const) };
            const deps = createDaemonDeploymentActionDeps({ ...host, runtime: createOwnServerDeploymentRuntimeForHost(host) });
            const operations = createHostActionOperationRuntime({ machineId: target.machineId, resolveAccountId: async () => 'owner' });
            return await operations.observeExecution({ actionId: 'deployments.restart', input: request, rpcContext: context,
                execute: async operation => ({ ok: true, result: await deps.deploymentAction('deployments.restart', request, {
                    ...context, operationAcceptance: operation.operationAcceptance, operationOwnerUpdate: operation.operationOwnerUpdate,
                }) }) });
        },
        async readNotices() {
            const store = createCredentialedAccountArtifactStore(credentials);
            return await Promise.all([...noticeRows.keys()].map(async id => {
                const artifact = await runWithServerHttpBaseUrl(serverUrl, () => store.read(id, { includeSharedAudience: false }));
                return artifact ? readOwnedNoticeArtifactV1(artifact, 'owner') : null;
            }));
        },
        readHandle: () => fixture.registry.projectManagedServices.resolveEnvironmentService(identity.homeServerIdentityId, service),
        recoverWithReferences: (restoreServiceReferences: NonNullable<RestoreOwnServerDeploymentServicesInput['restoreServiceReferences']>) =>
            recover(fixture.registry.projectManagedServices, new AbortController().signal, restoreServiceReferences),
        // A recovery whose Home view still names the retained source receipt.
        recoverRetainedSourceReceipt: () => restoreOwnServerDeploymentServices({ ...target, installationId: 'installation-a',
            receipt: sourceReceipt, owner: fixture.registry.projectManagedServices, signal: new AbortController().signal,
            isCurrent: () => true, readReceipt }),
        targetLinkId: link.id,
        async prepareBindings() {
            const operation = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: serverUrl,
                snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
                    settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(token) }, async isCurrent() { return true; } });
            const requesterIdentity = selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: identity.homeServerIdentityId,
                hostAccountAutomation: { accountId: 'owner', custodianAccountId: 'owner', machineId: target.machineId,
                    installationId: installation.installationId } });
            const host = { ...target, credentials, serverHttpBaseUrl: serverUrl,
                resolveRequesterIdentity: async () => requesterIdentity, savedSecretOperationContext: operation };
            const daemon = createDaemonDeploymentActionDeps({ ...host,
                runtime: createOwnServerDeploymentRuntimeForHost({ ...host, async acquirePluginRuntimeRegistryLease() {
                    const lease = pluginReloadController.tryAcquireRuntimeRegistry();
                    if (!lease) throw new Error('Expected admitted native runtime');
                    return lease;
                } }), ensureServiceObservations: runtime.ensureEnvironmentServices });
            return await daemon.deploymentAction!('deployments.bindings.set', { serverId: target.serverId,
                environmentId: environment.id, expectedRevision: environment.revision, set: [{ purpose: 'dataRole',
                    service: primaryService, role: 'readOnlyPassword', source: { kind: 'secret', ref: readRoleRef, resourceRevision: 1 } }], remove: [] }, {});
        },
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
        async resolveReference(component: 'host' | 'port', applied = false) {
            const sourceEnvironment = createDeploymentEnvironmentDetailV1({ environment });
            sourceEnvironment.environment.runtimeTargetLinkId = link.id;
            sourceEnvironment.content.ownServer = { ...sourceEnvironment.content.ownServer, serviceExports: appliedServiceExports };
            sourceEnvironment.targetLinks[0]!.targetLink = { ...link, machines: [target.machineId], members: [
                { machineId: target.machineId, installationId: installation.installationId, state: 'active' },
            ] };
            const host = { ...target, credentials, serverHttpBaseUrl: serverUrl,
                ensureServiceObservations: runtime.ensureEnvironmentServices,
                resolveRequesterIdentity: async () => ({ kind: 'unknown' as const, reason: 'requester_authority_unavailable' as const }),
                async acquirePluginRuntimeRegistryLease() {
                    const lease = pluginReloadController.tryAcquireRuntimeRegistry();
                    if (!lease) throw new Error('Expected admitted native runtime');
                    return lease;
                } };
            if (applied) {
                const dependencies = createDaemonDeploymentActionDeps({ ...host, runtime: createOwnServerDeploymentRuntimeForHost(host) });
                const applied = await dependencies.resolveServiceExportBinding({ exportKey: appliedServiceExports[0]!.key,
                    deploymentId: sourceDeploymentId, installationId: installation.installationId, service,
                    generation: 'retained-export-generation', destination: { host: '127.0.0.1', port: Number(referencePublication!.port) },
                }, new AbortController().signal);
                return applied ? component === 'host' ? applied.binding.destination.host : String(applied.binding.destination.port) : null;
            }
            return resolvePrivateServiceReferenceForHost({ source: { kind: 'reference', environmentId: environment.id,
                export: appliedServiceExports[0]!.key, via: 'auto', component },
                environment: createDeploymentEnvironmentDetailV1(), readEnvironment: async () => sourceEnvironment,
                host, context, actionId: 'deployments.deploy', signal: new AbortController().signal,
                owner: fixture.registry.projectManagedServices, homeServerIdentityId: identity.homeServerIdentityId,
                installationId: installation.installationId, privateKey: installationKeys.secretKey });
        },
        sourcePath: source.rootPath, sourceDeploymentId, openedReceiptArtifacts, environmentRevision: environment.revision,
        listMachine: (readable = true) => runtime.execute({ actionId: 'machines.services.list', input: target, context,
            canReadEnvironments: async ids => new Set(readable ? ids : []) }),
        get inventoryReads() { return inventoryReads; },
        unreadableReads,
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
    it.skipIf(process.platform !== 'linux')('restores the retained Compose exporter alias to the new collector receiver', async () => {
        const receiver = createServer((_request, response) => response.end('collector after restart'));
        receiver.listen(0, '127.0.0.1');
        await once(receiver, 'listening');
        const address = receiver.address();
        if (!address || typeof address === 'string') throw new Error('Expected a TCP receiver');
        const recovery = Promise.withResolvers<void>();
        const lifetime = new AbortController();
        const collector = createDeploymentTelemetryHost({
            serverBaseUrl: 'https://home.test', machineId: 'machine-a', token: 'fixture',
            subscribeMachineChanges: () => () => {},
            onRefreshError: recovery.reject,
            async restoreLocalDeploymentRelays() {
                await fixture.runtime.ensureEnvironmentServices();
                recovery.resolve();
            },
        });
        const fixture = await createRestartedEnvironmentFixture('running', 'e2ee', undefined, true, false,
            'app', [], false, false, undefined, false, collector.readEndpoint);
        try {
            const exporter = new URL((await fixture.docker.readRuntimeEnvironment('app')).OTEL_EXPORTER_OTLP_ENDPOINT!);
            await expect(fixture.docker.readPrivateRelaySocketPath(exporter.hostname)).rejects.toThrow('fixture_private_relay_missing');
            collector.bind(lifetime.signal).exposeEndpoint(() => `http://127.0.0.1:${address.port}`);
            await recovery.promise;
            const socketPath = await fixture.docker.readPrivateRelaySocketPath(exporter.hostname);
            expect(await readRelayHttpBody(socketPath)).toBe('collector after restart');
            await fixture.runtime.ensureEnvironmentServices();
            expect(fixture.inventoryReads).toBe(1);
            expect((await fixture.docker.readInvocations()).filter(call => call.args.includes('up'))).toHaveLength(1);
            const handle = fixture.readHandle();
            if (!handle) throw new Error('Expected a recovered native service observation');
            await releaseRemovedServiceReferenceForwards(new Set([handle.retirementSignal]), await handle.readNativeEffectKeys());
            await expect(fixture.docker.readPrivateRelaySocketPath(exporter.hostname)).rejects.toThrow('fixture_private_relay_missing');
        } finally {
            lifetime.abort();
            try { await fixture.dispose(); }
            finally { await new Promise<void>(resolve => receiver.close(() => resolve())); }
        }
    });

    it('awaits the restored reference cleanup and leaves observation retirement to the teardown proof', async () => {
        const fixture = await createRestartedEnvironmentFixture();
        const started = Promise.withResolvers<void>();
        const complete = Promise.withResolvers<void>();
        const close = vi.fn(async () => { started.resolve(); await complete.promise; });
        let retired: Promise<void> | undefined;
        try {
            expect(await fixture.recoverWithReferences(async () => ({ close }))).toEqual([]);
            const handle = fixture.readHandle();
            if (!handle) throw new Error('Expected a recovered native service observation');
            const keys = await handle.readNativeEffectKeys();
            retired = releaseRemovedServiceReferenceForwards(new Set([handle.retirementSignal]), keys);
            const winner = await Promise.race([started.promise.then(() => 'started'), retired.then(() => 'finished')]);
            expect(winner).toBe('started');
            expect(fixture.readHandle()).toBe(handle);
            complete.resolve();
            await retired;
            await handle.dispose();
            expect(close).toHaveBeenCalledTimes(1);
        } finally {
            complete.resolve();
            await retired?.catch(() => undefined);
            await fixture.dispose();
        }
    });

    it.each(['plain', 'e2ee'] as const)('publishes the restored stopped service through the native notice owner with its current restart choice ($0)', async mode => {
        const fixture = await createRestartedEnvironmentFixture('stopped', mode);
        try {
            const listed = await fixture.list();
            expect(listed).toMatchObject({ kind: 'snapshot', services: [{ state: 'stopped' }] });
            if (listed.kind !== 'snapshot') throw new Error('Expected restored service inventory');
            await vi.waitFor(async () => {
                expect(await fixture.readNotices(), JSON.stringify(fixture.noticeDiagnostics())).toEqual(expect.arrayContaining([expect.objectContaining({
                    kind: 'account_notice.v1', healthPhase: 'open',
                    source: { kind: 'host', topic: 'service_health', subject: fixture.service },
                    recoveryChoices: [expect.objectContaining({ actionId: 'deployments.restart', input: expect.objectContaining({
                        environmentId: fixture.readInput.environmentId, deploymentId: fixture.readInput.deploymentId,
                        service: fixture.service, expectedGeneration: listed.services[0]!.generation,
                    }) })],
                })]));
            });
            expect((await fixture.docker.readInvocations()).filter(call => call.args.includes('up'))).toHaveLength(1);
            const notice = (await fixture.readNotices()).find(value => value?.kind === 'account_notice.v1'
                && value.source.kind === 'host' && value.source.topic === 'service_health'
                && value.page?.kind === 'host' && value.page.page === 'machine_service');
            if (notice?.kind !== 'account_notice.v1') throw new Error('Expected restored service notice');
            const restart = notice.recoveryChoices?.find(choice => choice.actionId === 'deployments.restart');
            if (!restart) throw new Error('Expected native restart recovery choice');
            expect(await fixture.executeNoticeRestart(restart.input)).toMatchObject({ ok: true,
                result: { kind: 'observed', serviceId: fixture.service.serviceId, generation: listed.services[0]!.generation } });
            expect((await fixture.docker.readInvocations()).filter(call => call.args.includes('restart'))).toHaveLength(1);
        } finally { await fixture.dispose(); }
    });
    it.each([false, true])('resolves the captured DB-MOVE loopback export after a restart without first opening Machine Services (applied=%s)', async applied => {
        // COR3-164/dbmove/svcs.json and COR3B-DATA-1115/dbmove/dest-export-save.input.json:
        // the retained database was running with this publication, but cutover returned service_export_unavailable.
        const fixture = await createRestartedEnvironmentFixture('running', 'plain', undefined, true, false, 'database', [
            { containerPort: 5432, exposure: 'loopback', key: 'cor3b-move-db', scheme: 'postgres',
                service: 'database', transport: { kind: 'iroh' } },
        ], false, false, { host: '127.0.0.1', port: '32785' });
        try {
            expect(fixture.readHandle()).toBeNull();
            await expect(fixture.resolveReference('host', applied)).resolves.toBe('127.0.0.1');
            await expect(fixture.resolveReference('port', applied)).resolves.toBe('32785');
            expect(fixture.inventoryReads).toBe(1);
        } finally { await fixture.dispose(); }
    });
    it('reads a healthy selected service when another retained service source is missing', async () => {
        const fixture = await createRestartedEnvironmentFixture('running', 'plain', 'mixed-service-sources', true, false, 'app', [], true);
        try {
            await rm(fixture.sourcePath, { recursive: true });
            expect(await fixture.reads('deployments.health.read', {
                ...fixture.readInput, service: fixture.serviceFor('worker'),
            }, fixture.context)).toMatchObject({ ok: true, freshness: 'current', health: 'healthy' });
            expect(await fixture.reads('deployments.health.read', fixture.readInput, fixture.context))
                .toMatchObject({ ok: false, errorCode: 'ENOENT',
                    failureCause: { phase: 'service.restoration', errorCode: 'ENOENT' } });
        } finally { await fixture.dispose(); }
    });
    it('recovers a cold selected Environment without opening another Environment’s unreadable Artifact', async () => {
        const fixture = await createRestartedEnvironmentFixture('running', 'plain', undefined, true, false, 'app', [], false,
            false, undefined, true);
        try {
            expect(fixture.readHandle()).toBeNull();
            const exact = await fixture.reads('deployments.health.read', fixture.readInput, fixture.context);
            expect({ exact, unreadableReads: fixture.unreadableReads }).toMatchObject({
                exact: { ok: true, health: 'healthy', freshness: 'current' }, unreadableReads: [],
            });
            expect(await fixture.listMachine()).toMatchObject({ ok: false });
            expect(fixture.unreadableReads).toEqual(['environment', 'receipts', 'artifact']);
            expect(await fixture.reads('deployments.health.read', fixture.readInput, fixture.context))
                .toMatchObject({ ok: true, health: 'healthy' });
            expect(fixture.inventoryReads).toBe(2);
        } finally { await fixture.dispose(); }
    });
    it('preserves the retained service restoration cause through default bindings preparation', async () => {
        const fixture = await createRestartedEnvironmentFixture('running', 'plain', undefined, true, false, 'app', [], true, true);
        try {
            await rm(fixture.sourcePath, { recursive: true });
            await expect(fixture.runtime.ensureEnvironmentServices()).rejects.toMatchObject({ ok: false, errorCode: 'ENOENT',
                failureCause: { phase: 'service.restoration', errorClass: 'Error', errorCode: 'ENOENT', httpStatus: null } });
            expect(await fixture.prepareBindings()).toMatchObject({ ok: false, errorCode: 'ENOENT',
                failureCause: { phase: 'service.restoration', errorClass: 'Error', errorCode: 'ENOENT', httpStatus: null } });
        } finally { await fixture.dispose(); }
    });
    it('keeps healthy services visible when a retained restoration source directory is missing', async () => {
        const fixture = await createRestartedEnvironmentFixture('running', 'plain', 'mixed-service-sources', true, false, 'app', [], true);
        try {
            // Real OS loss after native creation reproduces the cold Services read;
            // the other service's source and all domain owners remain real.
            await rm(fixture.sourcePath, { recursive: true });
            const listed = await fixture.listMachine();
            expect(listed).toMatchObject({ kind: 'snapshot', services: expect.arrayContaining([
                expect.objectContaining({ serviceId: fixture.service.serviceId, state: 'unknown',
                    generation: null, unavailableReason: 'unavailable',
                    failureCause: { phase: 'service.restoration', errorClass: 'Error', errorCode: 'ENOENT', httpStatus: null },
                    capabilities: { exec: false, start: false, stop: false, restart: false, logs: false, accounting: false } }),
                expect.objectContaining({ serviceId: fixture.serviceFor('worker').serviceId, state: 'healthy' }),
            ]) });
            const snapshot = MachineServicesListResultV1Schema.parse(listed);
            expect(snapshot.kind === 'snapshot' && snapshot.services).toHaveLength(2);
            expect(await fixture.listMachine()).toMatchObject({ kind: 'snapshot', services: expect.arrayContaining([
                expect.objectContaining({ serviceId: fixture.service.serviceId, state: 'unknown', generation: null,
                    failureCause: expect.objectContaining({ errorCode: 'ENOENT' }) }),
                expect.objectContaining({ serviceId: fixture.serviceFor('worker').serviceId, state: 'healthy' }),
            ]) });
            expect(await fixture.listMachine(false)).toEqual({ kind: 'snapshot', services: [] });
            expect(await fixture.detail()).toMatchObject({ kind: 'service', service: expect.objectContaining({
                serviceId: fixture.service.serviceId, state: 'unknown', generation: null,
                failureCause: { phase: 'service.restoration', errorClass: 'Error', errorCode: 'ENOENT', httpStatus: null },
            }) });
            const calls = await fixture.docker.readInvocations();
            expect(calls.filter(call => call.args.includes('up'))).toHaveLength(1);
            expect(calls.filter(call => call.args.includes('stop') || call.args.includes('down') || call.args.includes('rm'))).toEqual([]);
        } finally { await fixture.dispose(); }
    });
    it('retires an unfiltered failed-only Services observation on its Environment access change', async () => {
        const fixture = await createRestartedEnvironmentFixture('running', 'plain', undefined, true, false, 'app', [], true);
        const demand = new AbortController();
        let held: { dispose(): void | Promise<void> } | undefined;
        let publishAccess: ((event: RequesterEnvironmentAccessObservation) => void) | undefined;
        const observation: NonNullable<NonNullable<ActionExecutorContext['machineServicesListResource']>['observation']> = {
            signal: demand.signal, invalidate() {}, retire() { demand.abort(); },
            accept(subscription) { held = subscription; },
        };
        try {
            await rm(fixture.sourcePath, { recursive: true });
            const listed = await fixture.runtime.execute({ actionId: 'machines.services.list',
                input: { serverId: fixture.readInput.serverId, machineId: fixture.readInput.machineId },
                context: { ...fixture.context, machineServicesListResource: { observation } },
                canReadEnvironments: async ids => new Set(ids),
                // The external Account access feed is the subscription boundary;
                // restoration, disclosure selection and stream retirement stay real.
                async observeEnvironmentAccessChanges(listener) {
                    publishAccess = listener;
                    return { async dispose() { publishAccess = undefined; } };
                },
            });
            expect(listed).toMatchObject({ kind: 'snapshot', services: [expect.objectContaining({
                serviceId: fixture.service.serviceId, generation: null, state: 'unknown',
                failureCause: expect.objectContaining({ errorCode: 'ENOENT' }),
            })] });
            expect(fixture.readHandle()).toBeNull();
            const unavailableDemand = new AbortController();
            let unavailableSubscription: { dispose(): void | Promise<void> } | undefined;
            try {
                const unavailable = await fixture.runtime.execute({ actionId: 'machines.services.list',
                    input: { serverId: fixture.readInput.serverId, machineId: fixture.readInput.machineId },
                    context: { ...fixture.context, machineServicesListResource: { observation: {
                        signal: unavailableDemand.signal, invalidate() {}, retire() { unavailableDemand.abort(); },
                        accept(subscription) { unavailableSubscription = subscription; },
                    } } },
                    canReadEnvironments: async ids => new Set(ids),
                    observeEnvironmentAccessChanges: async () => ({ ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' }),
                });
                expect(unavailable, 'a failed-only Environment row still requires the access observer')
                    .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
            } finally { unavailableDemand.abort(); await unavailableSubscription?.dispose(); }
            if (!publishAccess) throw new Error('Expected admitted Account access subscription');
            publishAccess({ kind: 'changes', environmentIds: ['unrelated-environment'] });
            expect(demand.signal.aborted).toBe(false);
            publishAccess({ kind: 'changes', environmentIds: [fixture.service.environmentId] });
            expect(demand.signal.aborted).toBe(true);
        } finally {
            demand.abort();
            await held?.dispose();
            await fixture.dispose();
        }
    });
    it('restores applied Iroh export declarations on the recreated managed service handle', async () => {
        const appliedServiceExports: DeploymentServiceExportV1[] = [{ key: 'database', service: 'app', containerPort: 5432,
            scheme: 'postgres', exposure: 'loopback', transport: { kind: 'iroh' } }];
        const fixture = await createRestartedEnvironmentFixture('running', undefined, undefined, true, false, 'app', appliedServiceExports);
        try {
            expect(fixture.readHandle()).toBeNull();
            await fixture.list();
            expect(fixture.readHandle()?.appliedServiceExports).toEqual(appliedServiceExports);
        } finally { await fixture.dispose(); }
    });
    it('publishes a retained reference failure in the existing consumer diagnostic without stopping native custody', async () => {
        const fixture = await createRestartedEnvironmentFixture('running');
        try {
            await fixture.list();
            const handle = fixture.readHandle();
            if (!handle?.reportDependencyFailure) throw new Error('Retained consumer diagnostics required');
            handle.reportDependencyFailure({ ok: false, errorCode: 'private_service_destination_unreachable', error: 'private_service_destination_unreachable' });
            expect(handle.snapshot().diagnostics).toEqual(expect.arrayContaining([
                expect.objectContaining({ code: 'private_service_destination_unreachable', severity: 'error' }),
            ]));
            expect(handle.retirementSignal.aborted).toBe(false);
            expect(await fixture.list()).toMatchObject({ kind: 'snapshot', services: [expect.objectContaining({
                health: expect.objectContaining({ status: 'down', reason: 'private_service_destination_unreachable' }),
            })] });
            handle.reportDependencyFailure(null);
            expect((await fixture.list())).not.toMatchObject({ kind: 'snapshot', services: [expect.objectContaining({
                health: expect.objectContaining({ reason: 'private_service_destination_unreachable' }),
            })] });
        } finally { await fixture.dispose(); }
    });
    it('retires Environment observation custody at ApiMachine replacement without stopping its native container', async () => {
        const fixture = await createRestartedEnvironmentFixture('running');
        try {
            await fixture.list();
            const handle = fixture.readHandle();
            expect(handle?.retirementSignal.aborted).toBe(false);
            await fixture.runtime.dispose();
            expect(handle?.retirementSignal.aborted).toBe(true);
            expect(fixture.readHandle()).toBeNull();
            const calls = await fixture.docker.readInvocations();
            expect(calls.filter(call => call.args.includes('stop') || call.args.includes('down') || call.args.includes('rm'))).toEqual([]);
        } finally { await fixture.dispose(); }
    });
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

    it('recovers services retained from different sources in the same serving Compose project', async () => {
        const fixture = await createRestartedEnvironmentFixture('running', undefined, 'mixed-service-sources');
        try {
            expect(await fixture.list()).toMatchObject({ kind: 'snapshot', services: expect.arrayContaining([
                { serviceId: fixture.service.serviceId, state: 'healthy' },
                { serviceId: fixture.serviceFor('worker').serviceId, state: 'healthy' },
            ].map(value => expect.objectContaining(value))) });
            expect(await fixture.reads('deployments.health.read', fixture.readInput, fixture.context))
                .toMatchObject({ ok: true, health: 'healthy', deploymentId: 'cmvxhwoyw002imcvup262fnnk' });
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

    it('keeps the live serving observation when a later recovery reads an older receipt for the same containers', async () => {
        // COR3-171 r4: a recovery read that ran after the redeploy registered its
        // leased observation superseded it, so exec refused with "redeploy".
        const fixture = await createRestartedEnvironmentFixture('running', undefined, 'reused-container');
        try {
            expect(await fixture.list()).toMatchObject({ kind: 'snapshot', services: [
                { serviceId: fixture.service.serviceId, deployment: { deploymentId: 'cmvxhwoyw002imcvup262fnnk' } },
            ] });
            const live = fixture.readHandle();
            if (!live) throw new Error('Expected the live serving observation');
            expect(await fixture.recoverRetainedSourceReceipt()).toEqual([]);
            expect(fixture.readHandle()).toBe(live);
            expect(live.retirementSignal.aborted).toBe(false);
            expect(await fixture.list()).toMatchObject({ kind: 'snapshot', services: [
                { serviceId: fixture.service.serviceId, generation: live.instanceId,
                    deployment: { deploymentId: 'cmvxhwoyw002imcvup262fnnk' } },
            ] });
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
