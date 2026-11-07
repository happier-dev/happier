import { delimiter, join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import fastify from 'fastify';
import nacl from 'tweetnacl';
import * as undici from 'undici';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorContext, DeploymentActionInputSchemasV1,
    DeploymentChildRpcV1Schema, DeploymentDomainChildRpcV1Schema, DeploymentDomainMachineTopologyV1Schema,
    DeploymentEnvironmentGetResultV1Schema, encodeBase64, verifyMachineInstallationProof, signMachineInstallationProof } from '@happier-dev/protocol';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationVerifyRequestV1Schema,
    bindExternalActionExecutionAuthorizationVerifyHttpPathV1, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1,
    verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { DeploymentDomainHeaderV1Schema, DeploymentDomainAddAdmissionInputV1Schema,
    DeploymentDomainPreparedContentInputV1Schema, DeploymentDomainTransitionInputV1Schema,
    deploymentDomainObservationProofPayloadV1, nativeCaddyDomainRouteIdsV1,
    nativeCaddyRemovalSigningBytes } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { encodePlainArtifactStoredContent, decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
    EnvironmentSecretLaunchAdmissionInputV1Schema, MachineConnectorSecretGrantInputV1Schema,
    computeEnvironmentSecretLaunchAdmissionDigestV1, machineSecretGrantSubjectKey } from '@happier-dev/deployment-protocol';
import * as cloudflareEntry from '../../../../../../packages/plugins/deploy-cloudflare/src/index.js';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionSchemaReader,
    createCommittedContributedActionInvoker } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createPurposeTargetResolver } from '@/daemon/connectedServices/purposeBindings/resolveTarget';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { prepareInstalledRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import * as installationStore from '@/daemon/identity/store';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { openMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import type { ClientToServerEvents } from '@/api/types';
import type { StoredCredentials } from '@/persistence';
import { nativeCaddyImage } from '@happier-dev/cli-common/machineSetup';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { withSocketTempDir } from '@/testkit/fs/tempDir';
import { createOwnServerDockerBoundary } from './ownServerDeployment.testkit';
import { createOwnServerDomainNative } from './ownServerDomainNative';
import { materializeCaddyDomainRouteV1 } from './caddyRouteMaterialization';

// Genuine network boundary: Node's HTTP adapter uses Undici; retain its real
// Agent and replace only fetch with the same boundary used by Bun below.
vi.mock('undici', async importOriginal => {
    const runtime = await importOriginal<typeof import('undici')>();
    return { ...runtime, fetch: vi.fn(runtime.fetch) };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

/** Home, Cloudflare and native Socket.IO are the system boundaries. The
 * reviewed issuer, Account module, credential purpose, sealing and CAS stay real. */
it.each(['connector grant authorization refused', 'create connector grant authorization refused', 'prepared', 'adopt omitted configuration', 'adopt omitted configuration result', 'create configuration without version', 'create malformed configuration', 'authored ui', 'authored agent', 'Home Domain admission refused', 'authored domain ingress', 'authored domain ingress null configuration', 'authored domain DNS refused', 'rejected authored', 'vendor unknown', 'content conflict', 'two members', 'partial grant', 'remove shared', 'remove final',
    'recovery Add a3318568 missing selection', 'recovery Add no recorded ingress', 'remove unprepared absent tunnel', 'remove unprepared partial config', 'remove unprepared foreign route', 'remove unprepared app gone',
    'remove unprepared configuration without version', 'remove unprepared null configuration', 'remove unprepared malformed configuration',
    'remove unprepared DNS optional pagination', 'remove unprepared tunnel optional pagination'] as const)(
    'runs the admitted Domain Action and its selected Account child before native work: %s', async scenario => withSocketTempDir(async directory => {
    const app = fastify();
    const privateWrites: string[] = [];
    app.addHook('onRequest', async request => {
        if (request.method === 'POST' && request.url === '/v1/artifacts') privateWrites.push(request.url);
    });
    const unprepared = scenario === 'remove unprepared absent tunnel' || scenario === 'remove unprepared partial config'
        || scenario === 'remove unprepared foreign route' || scenario === 'remove unprepared app gone'
        || scenario === 'remove unprepared configuration without version' || scenario === 'remove unprepared null configuration' || scenario === 'remove unprepared malformed configuration'
        || scenario === 'remove unprepared DNS optional pagination' || scenario === 'remove unprepared tunnel optional pagination';
    const dnsOptionalPagination = scenario === 'remove unprepared DNS optional pagination';
    const tunnelOptionalPagination = scenario === 'remove unprepared tunnel optional pagination';
    const nullConfiguration = scenario === 'authored domain ingress null configuration' || scenario === 'remove unprepared null configuration';
    const realNativeRemoval = scenario === 'remove unprepared configuration without version' || scenario === 'remove unprepared null configuration' || dnsOptionalPagination || tunnelOptionalPagination;
    const realNativeDiscovery = scenario === 'remove unprepared app gone' || realNativeRemoval;
    const createWithoutVersion = scenario === 'create configuration without version';
    const omittedConfigurationResult = scenario === 'adopt omitted configuration result';
    const omittedConfiguration = scenario === 'adopt omitted configuration' || omittedConfigurationResult;
    const malformedRemoval = scenario === 'remove unprepared malformed configuration';
    const malformedPreparation = scenario === 'create malformed configuration';
    const malformedConfigurationValue = 'private-malformed-configuration-value';
    const grantAuthorizationRefused = scenario === 'connector grant authorization refused' || scenario === 'create connector grant authorization refused';
    const creatingTunnel = createWithoutVersion || malformedPreparation || scenario === 'create connector grant authorization refused';
    const removing = scenario === 'remove shared' || scenario === 'remove final' || unprepared;
    const actionId = removing ? 'deployments.domains.remove' as const : 'deployments.domains.add' as const;
    const origin = 'https://cloudflare-domain-home.test';
    const controllerSeed = new Uint8Array(32).fill(81), targetSeed = new Uint8Array(32).fill(82);
    const controller = nacl.sign.keyPair.fromSeed(controllerSeed), targetKeys = nacl.sign.keyPair.fromSeed(targetSeed);
    const receiverBSeed = new Uint8Array(32).fill(83), receiverB = nacl.sign.keyPair.fromSeed(receiverBSeed);
    const members = scenario === 'two members' || scenario === 'partial grant' ? ['receiver', 'receiver-b'] : ['receiver'];
    const grantedMembers = scenario === 'partial grant' ? ['receiver'] : members;
    const installation = (machineId: string) => `${machineId}-installation`;
    const credentials: StoredCredentials = { token: `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`,
        credentialProvenance: 'stored_session', encryption: null };
    const plugin = normalizePluginManifestV2(cloudflareEntry.manifest);
    const descriptor = plugin.contributes.connectedAccountDescriptors[0];
    if (!descriptor) throw new Error('Cloudflare must declare its connected Account service');
    const service = { pluginId: plugin.id, localId: descriptor.id };
    const credentialRef = { service, accountId: 'cloudflare-profile' };
    const credentialRevision = 'csr_abcdefghijklmnopqrstuv';
    const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: credentialRef, status: 'connected',
        authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision,
        configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null,
        displayName: 'Cloudflare fixture', scopes: [] });
    const unexpected = async (): Promise<never> => { throw new Error('No interactive credential selection in an admitted Domain'); };
    const connectedAccounts = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: 'owner',
        store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
        selectTarget: unexpected,
        resolveTarget: createPurposeTargetResolver({ available: true,
            resolveService: async () => ({ service, authentication: descriptor.authentication }), listAccounts: async () => [profile] }),
        resolveCredentialRevision: async () => credentialRevision,
        materializeAccount: async ({ credentialRevisionBasis }) => {
            credentialRevisionBasis?.captureCredentialRevision(credentialRevision);
            return { kind: 'httpHeaders', headers: { authorization: 'Bearer private-cloudflare-api-token' } };
        }, projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
    });
    const authored = await registerAuthoredAccountActionRelease(app, 'owner', { primary: {
        manifest: cloudflareEntry.manifest,
        projectRoot: resolve(import.meta.dirname, '../../../../../../packages/plugins/deploy-cloudflare'),
        entryPath: resolve(import.meta.dirname, '../../../../../../packages/plugins/deploy-cloudflare/src/accountRuntime.ts'),
        manifestExport: null,
    } });
    const environment = createDeploymentEnvironmentDetailV1();
    environment.environment.owner = { kind: 'account', accountId: 'owner' };
    const domainIngressOnly = scenario === 'authored domain ingress' || scenario === 'authored domain ingress null configuration' || scenario === 'authored domain DNS refused';
    if (domainIngressOnly || scenario === 'recovery Add no recorded ingress') delete environment.content.ingress;
    else environment.content.ingress = { kind: 'cloudflareTunnel' };
    const targetLink = environment.targetLinks[0];
    if (!targetLink) throw new Error('Expected the canonical Environment target-link fixture');
    const link = targetLink.targetLink;
    link.machines = members;
    link.members = members.map(machineId => ({ machineId, installationId: installation(machineId), state: 'active' as const }));
    const vendorController = { accountId: 'vendor-account', zoneId: 'vendor-zone',
        tunnel: unprepared || creatingTunnel ? { kind: 'create', name: 'environment-tunnel' }
            : { kind: 'adopt', tunnelId: 'reviewed-tunnel', name: 'environment-tunnel' }, owned: [], dnsOwnership: [],
        connector: { imageRef: 'cloudflare/cloudflared:2026.10.0', version: '2026.10.0' } };
    const content = { hostname: 'app.example.test', target: { service: 'web', containerPort: 8080 },
        healthCheck: { path: '/health', expectStatus: 200 }, ingress: { provider: { kind: 'builtin', id: 'cloudflareNamed' },
            config: { hostname: 'app.example.test', controller: vendorController }, credentialRefs: [
                { purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount', account: credentialRef } }] } };
    const authoredDomain = scenario === 'authored ui' || scenario === 'authored agent' || scenario === 'Home Domain admission refused' || scenario === 'rejected authored' || domainIngressOnly || scenario === 'recovery Add a3318568 missing selection' || scenario === 'recovery Add no recorded ingress';
    const { ingress: _vendorSelection, ...authoredContent } = content;
    const authoredInput = { serverId: 'home', environmentId: environment.environment.id,
        domainId: 'domain', expectedRevision: environment.environment.revision, targetLinkId: link.id,
        expectedTargetLinkRevision: link.revision, requestKey: 'cloudflare-domain', contentArtifactId: 'domain-content',
        contentHeaderVersion: 1, contentBodyVersion: 1 };
    const input = removing ? DeploymentActionInputSchemasV1['deployments.domains.remove'].parse({ serverId: 'home',
        environmentId: authoredInput.environmentId, domainId: authoredInput.domainId, expectedRevision: authoredInput.expectedRevision,
        expectedDomainRevision: 1, requestKey: 'remove-cloudflare-domain' }) : authoredDomain
            ? DeploymentActionInputSchemasV1['deployments.domains.add'].parse({ serverId: authoredInput.serverId,
                environmentId: authoredInput.environmentId, domainId: authoredInput.domainId, expectedRevision: authoredInput.expectedRevision,
                targetLinkId: authoredInput.targetLinkId, expectedTargetLinkRevision: authoredInput.expectedTargetLinkRevision,
                requestKey: authoredInput.requestKey, content: domainIngressOnly || scenario === 'Home Domain admission refused' ? content : authoredContent }) : authoredInput;
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const envelope = { v: 1 as const, requestId: 'domain-request', target, input };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'domain-root', binding: {
        serverIdentityId: 'home', accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, custodianAccountId: 'owner', admittedMachineRole: 'manage',
        machineId: 'controller', installationId: 'controller-installation', actionId, environmentId: input.environmentId,
        requestId: envelope.requestId, accountEncryptionMode: 'plain', target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        deploymentChildRoot: true, deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(actionId, input) } });
    const retainedGrant = machineSecretGrantSubjectKey({ v: 1, kind: 'connectorToken', machineId: 'receiver',
        installationId: installation('receiver'), provider: { kind: 'builtin', id: 'cloudflareNamed' }, connectorId: 'reviewed-tunnel' });
    const retainedContent = removing && !unprepared ? { ...content, cloudflarePreparation: { tunnelId: 'reviewed-tunnel',
        owned: [{ hostname: content.hostname, expectedService: 'http://172.18.0.2:9381' }],
        dnsOwnership: [{ hostname: content.hostname, recordId: 'acknowledged-dns-record' }],
        connectors: [{ machineId: 'receiver', installationId: installation('receiver'), ...vendorController.connector,
            networkName: 'environment_default', grantRef: retainedGrant }] } } : content;
    for (const [id, kind, body] of [[authoredInput.contentArtifactId, 'deployment-domain.v1', retainedContent],
        [environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content],
        [link.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, {}]] as const) {
        if (authoredDomain && id === authoredInput.contentArtifactId) continue;
        authored.artifacts.seed(id, encodePlainArtifactStoredContent({ kind, title: 'Domain' }),
            encodePlainArtifactStoredContent({ body: JSON.stringify(body) }));
    }
    const trace: string[] = [];
    let domain: ReturnType<typeof DeploymentDomainHeaderV1Schema.parse> | undefined;
    if (removing) domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: input.domainId, environmentId: input.environmentId,
        targetLinkId: link.id, revision: 1, state: unprepared ? 'pending' : 'active', contentArtifactId: authoredInput.contentArtifactId,
        contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1,
        placements: [{ placement: { serverId: 'home', accountId: 'owner', environmentId: input.environmentId, targetLinkId: link.id,
            domainId: input.domainId, machineId: 'receiver', installationId: installation('receiver'), nativeServer: 'private_app',
            actionOperationId: 'previous-operation', requestId: 'previous-request' }, listener: 'privateOrigin', desired: true,
            dockerEngineId: 'engine-receiver', content: { contentArtifactId: authoredInput.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 } }] });
    const grants = new Map<string, string>();
    let preparedBody: unknown;
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 0 }));
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
    app.get('/v1/account/profile', async () => ({ id: 'owner' }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    const verifyPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(authorization.binding.actionId);
    app.post(verifyPath, async request => {
        const body = ExternalActionExecutionAuthorizationVerifyRequestV1Schema.parse(request.body);
        expect(body).toEqual({ v: 1, admittedMachineRole: 'manage' });
        expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === authorization.token).toBe(true);
        const signature = request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
        if (typeof signature !== 'string') throw new Error('Expected the installed controller root signature');
        expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token,
            effectActionId: authorization.binding.actionId, target, installationId: 'controller-installation',
            requestId: envelope.requestId, method: 'POST', path: verifyPath, body, signature,
            publicKey: controller.publicKey })).toBe(true);
        trace.push('root-admitted');
        return { ok: true };
    });
    app.get<{ Params: { machineId: string } }>('/v1/machines/:machineId', async request => {
        const { machineId } = request.params;
        const isController = machineId === 'controller';
        return { machine: { id: machineId, kind: 'persistent', revokedAt: null, replacedByMachineId: null,
            storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            installationId: isController ? 'controller-installation' : installation(machineId),
            installationPublicKey: encodeBase64(isController ? controller.publicKey : machineId === 'receiver-b' ? receiverB.publicKey : targetKeys.publicKey, 'base64') } };
    });
    app.get('/v1/deployments/environments/:environmentId', async () => DeploymentEnvironmentGetResultV1Schema.parse({
        ok: true, environment: environment.environment, targetLinks: [link] }));
    app.get('/v1/deployments/environments/:environmentId/domains/:domainId', async () => ({ ok: true,
        environmentId: input.environmentId, revision: input.expectedRevision, domain }));
    const removalSpec = getActionSpec('deployments.domains.remove');
    if (!removalSpec.serverTransport) throw new Error('Expected the canonical Domain removal transport');
    const removalRequest = removing && bindHomeDomainHttpRequestV1({ transport: removalSpec.serverTransport,
        inputSchema: DeploymentActionInputSchemasV1['deployments.domains.remove'], input });
    if (removalRequest) app.all(removalRequest.path, async request => {
        expect(request.method).toBe(removalRequest.method);
        if (!domain) throw new Error('Expected existing Domain');
        domain = { ...domain, revision: 2, state: 'removing', placements: domain.placements?.map(capture => ({ ...capture, desired: false,
            retireSharedTunnel: scenario === 'remove final', placement: { ...capture.placement,
                actionOperationId: 'domain-operation', requestId: envelope.requestId } })) };
        trace.push('removal-admitted');
        return { ok: true, environmentId: input.environmentId, revision: input.expectedRevision + 1, domain };
    });
    app.post('/v1/deployments/environments/:environmentId/domains', async request => {
        trace.push('domain-admitted');
        const admitted = DeploymentDomainAddAdmissionInputV1Schema.parse(request.body);
        if (authoredDomain) {
            authoredInput.contentArtifactId = admitted.contentArtifactId;
            expect(authored.artifacts.read(admitted.contentArtifactId)).toBeDefined();
            expect(trace).toContain('root-admitted');
        }
        domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: input.domainId, environmentId: input.environmentId,
            targetLinkId: link.id, revision: 1, state: 'applying', contentArtifactId: authoredInput.contentArtifactId,
            contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1,
            placements: admitted.placements.map(placement => ({ placement: { serverId: 'home', accountId: 'owner',
                environmentId: input.environmentId, targetLinkId: link.id, domainId: input.domainId, machineId: placement.machineId,
                installationId: placement.installationId, nativeServer: placement.nativeServer,
                actionOperationId: admitted.actionOperationId, requestId: admitted.requestId }, listener: placement.listener, desired: true,
                dockerEngineId: placement.dockerEngineId, content: { contentArtifactId: authoredInput.contentArtifactId,
                    contentHeaderVersion: 1, contentBodyVersion: 1 } })) });
        return { ok: true, environmentId: input.environmentId, revision: input.expectedRevision + 1, domain };
    });
    app.post('/v1/deployments/environments/:environmentId/domains/:domainId/transitions', async request => {
        const transition = DeploymentDomainTransitionInputV1Schema.parse(request.body);
        if (!domain) throw new Error('Expected admitted Domain');
        for (const { proof, ...observation } of transition.observations) {
            expect(verifyMachineInstallationProof({ payload: deploymentDomainObservationProofPayloadV1({
                expectedDomainRevision: transition.expectedDomainRevision, observation }),
                proof, publicKey: targetKeys.publicKey })).toBe(true);
            if (realNativeRemoval) {
                if (observation.state !== 'removed' || !observation.removal) throw new Error('Expected proved native removal');
                expect(observation.removal.routeIds).toEqual(nativeCaddyDomainRouteIdsV1(input.domainId, 'privateOrigin').removalIds);
                expect(nacl.sign.detached.verify(nativeCaddyRemovalSigningBytes(observation.removal.placement,
                    observation.removal.routeIds), Buffer.from(observation.removal.proof.signature, 'base64url'), targetKeys.publicKey)).toBe(true);
            }
        }
        domain = removing ? { ...domain, revision: domain.revision + 1, placements: [], deletedAtMs: 2 }
            : { ...domain, revision: domain.revision + 1, state: 'active' };
        trace.push(removing ? 'domain-removed' : 'domain-active');
        return { ok: true, environmentId: input.environmentId, revision: input.expectedRevision + 1, domain };
    });
    app.post('/v1/deployments/environments/:environmentId/secret-launch-admission', async (request, reply) => {
        const { proof, ...body } = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(request.body);
        if (body.materialization.kind !== 'domain') throw new Error('Expected accepted Domain capture');
        const admittedTarget = body.materialization.capture.placement.machineId;
        expect(body.materialization).toMatchObject({ kind: 'domain', domainId: input.domainId, expectedDomainRevision: 1,
            actionOperationId: 'domain-operation', capture: domain?.placements?.find(c => c.placement.machineId === admittedTarget) });
        expect(body.materialization).not.toHaveProperty('use');
        expect(verifyMachineInstallationProof({ payload: { version: 1, accountId: 'owner', machineId: 'controller',
            installationId: 'controller-installation', deploymentSecretLaunch: {
                requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, proof, publicKey: controller.publicKey })).toBe(true);
        trace.push('domain-facts');
        if (scenario === 'Home Domain admission refused') return reply.code(403).send({
            error: 'invalid_token', authorizationRefusal: 'verification_purpose' });
        return { ok: true, grants: [], domainAdmission: { controller: { machineId: 'controller', installationId: 'controller-installation',
            publicKey: encodeBase64(controller.publicKey, 'base64url') }, target: { machineId: admittedTarget, installationId: installation(admittedTarget),
            publicKey: encodeBase64(admittedTarget === 'receiver-b' ? receiverB.publicKey : targetKeys.publicKey, 'base64url') }, actionOperationId: 'domain-operation' } };
    });
    app.post('/v1/deployments/machines/:machineId/connector-secret-grant', async (request, reply) => {
        const { proof, ...body } = MachineConnectorSecretGrantInputV1Schema.parse(request.body);
        expect(body).toMatchObject({ operation: 'set', hostMachineId: 'controller', hostInstallationId: 'controller-installation',
            subject: { machineId: body.subject.machineId, installationId: installation(body.subject.machineId),
                provider: { kind: 'builtin', id: 'cloudflareNamed' }, connectorId: 'reviewed-tunnel' } });
        expect(verifyMachineInstallationProof({ payload: { version: 1, accountId: 'owner', machineId: 'controller',
            installationId: 'controller-installation', deploymentSecretLaunch: {
                requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, proof, publicKey: controller.publicKey })).toBe(true);
        if (body.operation !== 'set') throw new Error('Expected the sole connector SET writer');
        if (grantAuthorizationRefused) return reply.code(401).send({ error: 'invalid_token', authorizationRefusal: 'deployment_child_http' });
        if (scenario === 'partial grant' && body.subject.machineId === 'receiver-b')
            return reply.code(503).send({ ok: false, error: 'service_unavailable' });
        expect(openMachineSecretGrant({ grant: body.grant, machineId: body.subject.machineId, installationId: body.subject.installationId,
            installationPrivateSeed: body.subject.machineId === 'receiver-b' ? receiverBSeed : targetSeed })).toEqual({ kind: 'connectorToken', token: 'private-minted-connector-token' });
        expect(openMachineSecretGrant({ grant: body.grant, machineId: body.subject.machineId, installationId: body.subject.installationId,
            installationPrivateSeed: body.subject.machineId === 'receiver-b' ? targetSeed : receiverBSeed })).toBeNull();
        expect(openMachineSecretGrant({ grant: body.grant, machineId: body.subject.machineId, installationId: body.subject.installationId,
            installationPrivateSeed: controllerSeed })).toBeNull();
        grants.set(body.subject.machineId, machineSecretGrantSubjectKey(body.subject));
        trace.push('sealed-for-target');
        return { ok: true, grant: body.grant };
    });
    app.post('/v1/deployments/environments/:environmentId/domains/:domainId/prepared-content', async (request, reply) => {
        const prepared = DeploymentDomainPreparedContentInputV1Schema.parse(request.body);
        expect(prepared).toMatchObject({ expectedDomainRevision: 1, actionOperationId: 'domain-operation', capture: domain?.placements?.[0] });
        trace.push('content-cas');
        if (scenario === 'content conflict') return reply.code(409).send({ ok: false, error: 'deployment_conflict' });
        const row = authored.artifacts.read(authoredInput.contentArtifactId);
        if (!row) throw new Error('Expected the original Domain Artifact at CAS');
        row.body = prepared.contentUpdate.body;
        row.bodyVersion += 1;
        if (prepared.contentUpdate.provenance !== undefined) row.provenance = prepared.contentUpdate.provenance;
        if (prepared.contentUpdate.provenanceDataEncryptionKey !== undefined)
            row.provenanceDataEncryptionKey = prepared.contentUpdate.provenanceDataEncryptionKey;
        const decoded = decodePlainArtifactStoredContent(row.body);
        if (!decoded || typeof decoded !== 'object' || !('body' in decoded) || typeof decoded.body !== 'string') throw new Error('Expected private Domain Artifact');
        preparedBody = JSON.parse(decoded.body);
        if (!domain) throw new Error('Preparation must follow Domain admission');
        domain = DeploymentDomainHeaderV1Schema.parse({ ...domain, contentBodyVersion: row.bodyVersion,
            placements: domain.placements?.map(capture => ({ ...capture, content: { ...capture.content, contentBodyVersion: row.bodyVersion } })) });
        return { ok: true, environmentId: input.environmentId, revision: input.expectedRevision + 1, domain };
    });
    const unrelatedRoute = { hostname: 'other.example.test', service: 'http://172.18.0.9:9381' };
    // A failed preparation CAS leaves the original content (owned=[]), while
    // Cloudflare can already contain configure's acknowledged route and DNS.
    let remoteConfig: unknown = { ingress: [...(removing && scenario !== 'remove unprepared absent tunnel'
        ? [{ hostname: content.hostname, service: scenario === 'remove unprepared foreign route'
            ? 'http://foreign-service:9381' : 'http://172.18.0.2:9381' }] : []), ...(unprepared ? [unrelatedRoute] : []),
        { service: 'http_status:404' }] };
    // Real read-only QA Account GET, 2026-11-07T02:40:19Z: successful
    // result object with config:null and numeric version (no response values retained).
    if (nullConfiguration) remoteConfig = null;
    let dnsRemoved = false;
    const dnsRecord = { id: 'acknowledged-dns-record', name: content.hostname, type: 'CNAME',
        content: scenario === 'remove unprepared foreign route' ? 'foreign-tunnel.cfargotunnel.com'
            : 'reviewed-tunnel.cfargotunnel.com', proxied: true };
    const vendorRequests: Array<{ method: string; path: string }> = [];
    const fetchBoundary = vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
        const request = new Request(value, init);
        const url = new URL(request.url), method = request.method;
        if (url.origin !== 'https://api.cloudflare.com') return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'home' } } });
        vendorRequests.push({ method, path: url.pathname });
        expect(request.headers.get('authorization') === 'Bearer private-cloudflare-api-token').toBe(true);
        const path = url.pathname;
        if (path === '/client/v4/accounts/vendor-account/cfd_tunnel') {
            if (creatingTunnel && method === 'POST') {
                expect(await request.json()).toEqual({ name: 'environment-tunnel', config_src: 'cloudflare' });
                trace.push('vendor-tunnel-created');
                return Response.json({ success: true, result: { id: 'reviewed-tunnel' } });
            }
            expect(method).toBe('GET');
            expect(url.searchParams.get('name')).toBe('environment-tunnel');
            trace.push('vendor-tunnel-lookup');
            const exhausted = tunnelOptionalPagination && Number(url.searchParams.get('page')) > 1;
            return Response.json({ success: true, result: scenario === 'remove unprepared absent tunnel' || exhausted ? [] : [{
                id: 'reviewed-tunnel', name: 'environment-tunnel', account_tag: 'vendor-account', config_src: 'cloudflare', deleted_at: null,
            }], ...(tunnelOptionalPagination ? {} : { result_info: { page: 1, per_page: 100,
                total_count: scenario === 'remove unprepared absent tunnel' ? 0 : 1,
                count: scenario === 'remove unprepared absent tunnel' ? 0 : 1 } }) });
        }
        if (path.endsWith('/token')) { trace.push('mint-token'); return Response.json({ success: true, result: 'private-minted-connector-token' }); }
        if (path.endsWith('/configurations')) {
            if (method === 'PUT') {
                const body: unknown = await request.json();
                if (!body || typeof body !== 'object' || !('config' in body)) throw new Error('Expected exact tunnel configuration');
                remoteConfig = body.config; trace.push('vendor-config');
            }
            if (method === 'GET' && omittedConfigurationResult) return Response.json({ success: true });
            // Cloudflare's GET configuration contract makes version optional.
            return Response.json({ success: true, result: {
                ...(method === 'GET' && (scenario === 'remove unprepared configuration without version' || createWithoutVersion) ? {} : { version: 1 }),
                ...(method === 'GET' && omittedConfiguration ? {} : {
                    config: method === 'GET' && (malformedRemoval || malformedPreparation) ? malformedConfigurationValue : remoteConfig }) } });
        }
        if (path.endsWith('/dns_records/acknowledged-dns-record')) {
            if (method === 'DELETE') { dnsRemoved = true; trace.push('vendor-dns-removed'); return Response.json({ success: true, result: { id: dnsRecord.id } }); }
            return scenario === 'vendor unknown' ? Response.json({ success: false, errors: [{ code: 1000 }] }, { status: 503 })
                : dnsRemoved ? Response.json({ success: false }, { status: 404 }) : Response.json({ success: true, result: dnsRecord });
        }
        if (path.endsWith('/dns_records')) {
            if (method === 'POST') {
                trace.push('vendor-dns');
                expect(await request.json()).toMatchObject({ type: 'CNAME', name: content.hostname,
                    content: 'reviewed-tunnel.cfargotunnel.com', proxied: true });
                if (scenario === 'authored domain DNS refused') return Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 });
                return Response.json({ success: true, result: dnsRecord });
            }
            const page = Number(url.searchParams.get('page') ?? 1);
            const records = removing && scenario !== 'remove unprepared absent tunnel' && !dnsRemoved
                && !(dnsOptionalPagination && page > 1) ? [dnsRecord] : [];
            // Cloudflare documents each pagination metadata field as optional.
            return Response.json({ success: true, result: records, result_info: dnsOptionalPagination
                ? { page, per_page: 100, total_count: dnsRemoved ? 0 : 1 } : { page: 1, total_pages: 1 } });
        }
        if (path.endsWith('/cfd_tunnel/reviewed-tunnel')) return Response.json({ success: true, result: {
            id: 'reviewed-tunnel', name: 'environment-tunnel', account_tag: 'vendor-account', config_src: 'cloudflare', deleted_at: null } });
        throw new Error(`Unexpected vendor method/path ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetchBoundary);
    // Undici and platform Request types implement the same Fetch wire boundary.
    vi.mocked(undici.fetch).mockImplementation(fetchBoundary as unknown as typeof undici.fetch);
    const installedIdentity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, installationId: 'controller-installation', createdAt: 1,
        publicKey: encodeBase64(controller.publicKey, 'base64url'), privateKey: encodeBase64(controller.secretKey, 'base64url') });
    await app.ready();
    const restoreHttp = installAxiosFastifyAdapter({ app, origin });
    const channel = await createRequesterCurrentnessSocketHarness();
    const nativeJobs: Array<ReturnType<typeof DeploymentDomainChildRpcV1Schema.parse>> = [];
    const discoveredPrivateCandidates: Array<string | undefined> = [];
    let caddyVersion = 1;
    const nativeRemovals: string[] = [];
    const caddyServer = createServer((request, response) => {
        const nativeServer = caddyConfig.apps.http.servers.private_app;
        if (request.method === 'GET') {
            response.setHeader('ETag', `"${caddyVersion}"`);
            response.end(JSON.stringify(request.url === '/config/' ? caddyConfig : nativeServer));
            return;
        }
        if (request.method !== 'DELETE' || !request.url?.startsWith('/id/')) { response.writeHead(405).end(); return; }
        if (request.headers['if-match'] !== `"${caddyVersion}"`) { response.writeHead(412).end(); return; }
        const id = decodeURIComponent(request.url.slice('/id/'.length));
        nativeServer.routes = nativeServer.routes.filter(route => route['@id'] !== id);
        nativeRemovals.push(id); caddyVersion++; response.end();
    });
    const retainedRoute = materializeCaddyDomainRouteV1({ domainId: input.domainId,
        domain: { hostname: content.hostname, target: content.target, healthCheck: content.healthCheck }, listener: 'privateOrigin',
        upstreams: { kind: 'replicas', containerNames: ['removed-app-web'] }, privateSourceRanges: [] });
    const caddyConfig = { admin: { listen: 'unix//run/domain-native/admin.sock|0660' }, apps: { http: { servers: {
        private_app: { listen: [':9381'], automatic_https: { disable: true }, routes: [retainedRoute.route], errors: { routes: [] } },
    } } } };
    if (realNativeDiscovery) {
        const configPath = join(directory, 'initial.json');
        await writeFile(configPath, JSON.stringify(caddyConfig));
        await new Promise<void>((resolve, reject) => { caddyServer.once('error', reject); caddyServer.listen(join(directory, 'admin.sock'), resolve); });
        const bin = join(directory, 'bin');
        await createOwnServerDockerBoundary(bin, { engineId: 'engine-receiver', nativeCaddy: {
            Id: 'c'.repeat(64), Name: '/retained-caddy', State: { Running: true },
            Config: { Image: nativeCaddyImage, Labels: { 'dev.happier.machine-setup.recipe': 'caddy@1' },
                Cmd: ['caddy', 'run', '--resume', '--config', '/etc/caddy/happier.json'] },
            HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'environment_default', Mounts: [
                { Type: 'bind', Source: directory, Target: '/run/domain-native' },
                { Type: 'bind', Source: configPath, Target: '/etc/caddy/happier.json' },
            ] }, NetworkSettings: { Ports: {}, Networks: { environment_default: { IPAddress: '172.18.0.2' } } },
        } });
        vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
    }
    const runNativeJob = async (job: Parameters<ReturnType<typeof createOwnServerDomainNative>>[0]) => {
        const artifacts = createCredentialedAccountArtifactStore(credentials);
        const native = createOwnServerDomainNative({ credentials, serverId: 'home', serverHttpBaseUrl: origin, machineId: 'receiver',
            acquirePluginRuntimeRegistryLease: async () => {
                const lease = runtime?.controller.tryAcquireRuntimeRegistry();
                if (!lease) throw new Error('Admitted Account runtime was retired');
                return lease;
            },
            readEnvironment: async () => environment,
            open: id => runWithServerHttpBaseUrl(origin, () => artifacts.read(id,
                { prepareRecipients: false, includeSharedAudience: false })) });
        installedIdentity.mockReturnValueOnce({ version: 1, installationId: installation('receiver'), createdAt: 1,
            publicKey: encodeBase64(targetKeys.publicKey, 'base64url'), privateKey: encodeBase64(targetKeys.secretKey, 'base64url') });
        return await native(job, { surface: 'cli', signal: new AbortController().signal });
    };
    type RpcCall = Parameters<ClientToServerEvents[typeof SOCKET_RPC_EVENTS.CALL]>[0];
    channel.server.on('connection', socket => {
        socket.on(SOCKET_RPC_EVENTS.CALL, async (call: RpcCall, acknowledge: (value: unknown) => void) => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, call.params, call.method);
            const job = DeploymentChildRpcV1Schema.parse(decoded.params);
            if (job.kind === 'domainDiscover') {
                discoveredPrivateCandidates.push('contentArtifactId' in job.input
                    && authored.artifacts.read(job.input.contentArtifactId) ? job.input.contentArtifactId : undefined);
                if (realNativeDiscovery) {
                    acknowledge({ ok: true, result: await runNativeJob(job) });
                    return;
                }
                acknowledge({ ok: true, result: DeploymentDomainMachineTopologyV1Schema.parse({ machineId: job.machineId, installationId: job.installationId,
                    dockerEngineId: `engine-${job.machineId}`, privateNetworks: [], replicas: [], caddy: { status: 'ready', containerId: 'caddy-receiver',
                        containerName: 'owned-caddy', adminSocketPath: '/run/happier-caddy/admin.sock', networkNames: ['environment_default'],
                        servers: [{ serverId: 'private_app', listen: [':9381'], tls: false, automaticHttpsDisabled: true, endpoints: [] },
                            ...(domainIngressOnly ? [{ serverId: 'public_app', listen: [':443'], tls: true, automaticHttpsDisabled: false,
                                endpoints: [{ hostAddress: '0.0.0.0', hostPort: 443, containerPort: 443 }] }] : [])],
                        containerOrigins: [{ serverId: 'private_app', networkName: 'environment_default', service: 'http://172.18.0.2:9381' }] } }) });
                return;
            }
            trace.push('native-dispatch');
            nativeJobs.push(DeploymentDomainChildRpcV1Schema.parse(job));
            if (realNativeRemoval) {
                acknowledge({ ok: true, result: await runNativeJob(job) });
            } else if (unprepared) {
                const routeIds = nativeCaddyDomainRouteIdsV1(input.domainId, job.capture.listener).removalIds;
                const removal = { kind: 'removed' as const, placement: job.capture.placement, routeIds,
                    proof: { version: 1 as const, algorithm: 'ed25519' as const, signature: encodeBase64(nacl.sign.detached(
                        nativeCaddyRemovalSigningBytes(job.capture.placement, routeIds), targetKeys.secretKey), 'base64url') } };
                const observation = { capture: job.capture, state: 'removed' as const, removal };
                acknowledge({ ok: true, result: { ...observation, proof: signMachineInstallationProof({
                    payload: deploymentDomainObservationProofPayloadV1({ expectedDomainRevision: job.expectedDomainRevision, observation }),
                    privateKey: targetKeys.secretKey }) } });
            } else if (authoredDomain || scenario === 'two members' && job.machineId === 'receiver') {
                const observation = { capture: job.capture, state: 'active' as const };
                acknowledge({ ok: true, result: { ...observation, proof: signMachineInstallationProof({
                    payload: deploymentDomainObservationProofPayloadV1({ expectedDomainRevision: job.expectedDomainRevision, observation }),
                    privateKey: targetKeys.secretKey }) } });
            } else acknowledge({ ok: true, result: { errorCode: 'native_route_unavailable' } });
        });
    });
    let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    let requester: Awaited<ReturnType<typeof prepareInstalledRequesterAccountActionContext>> = null;
    try {
        runtime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { accountExecution: { credentials, serverUrl: origin, isCurrent: () => true },
            connectedAccounts, actionFormConnectedAccounts: connectedAccounts } });
        const appliedRuntime = runtime;
        const list = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () =>
            tryAcquireAuthoritativePluginRuntimeRegistryLease({ controller: appliedRuntime.controller }) });
        const ownerIdentity = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
            resolveHostIdentity: async () => ({ machineId: 'controller', installationId: 'controller-installation', custodianAccountId: 'owner' }) });
        const resolveActionRequester = ownerIdentity.resolveActionRequester;
        if (!resolveActionRequester) throw new Error('Expected the canonical installed requester resolver');
        const acquireRuntimeRegistryLease = async () => {
            const lease = appliedRuntime.controller.tryAcquireRuntimeRegistry();
            if (!lease) throw new Error('Admitted Account runtime was retired');
            return lease;
        };
        const deps = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl: origin, machineId: 'controller',
            resolveRequesterIdentity: async context => {
                const requester = await resolveActionRequester(context);
                try { return requester.identity; } finally { await requester.dispose(); }
            }, acquirePluginRuntimeRegistryLease: acquireRuntimeRegistryLease,
            runtime: { async acquire() { throw new Error('Domain cannot deploy an application'); } } });
        const invokeAccount = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease,
            requestCurrentIntent: async ({ fingerprint }) => ({ status: 'approved', fingerprint }) });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps,
            listContributedActionDefinitions: list, readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
            invokeContributedAction: invokeAccount });
        requester = await prepareInstalledRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' }, machineId: 'controller',
            serverId: 'home', serverHttpBaseUrl: origin, ownCredentials: credentials,
            resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl: origin,
                resolveCurrentMachineId: () => 'controller', resolveCurrentServerIdentityId: () => 'home' }),
            createExecutor: () => executor });
        if (!requester) throw new Error('Expected real original requester admission');
        expect(trace).toContain('root-admitted');
        const surface = scenario === 'authored ui' ? 'ui' : scenario === 'authored agent' ? 'mcp' : 'cli';
        const context: ActionExecutorContext = { authority: 'present_user', surface, runtimeAccountId: 'owner', serverId: 'home', serverIdentityId: 'home',
            actionCaller: { kind: 'host' }, interactivePresentation: 'unavailable',
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'controller',
                installationId: 'controller-installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true,
            externalActionExecutionAuthorization: requester.authorization, externalActionTarget: target, originalActionEnvelope: envelope,
            actionRequestId: envelope.requestId, signal: new AbortController().signal,
            signExternalActionApprovalInput: request => signExternalActionApprovalInputV1({ ...request,
                authorizationToken: authorization.token, privateKey: controller.secretKey }),
            actionsSettings: setActionApprovalOverride({ settings: normalizeActionsSettingsV1(undefined), actionId,
                surface, approvalRequired: scenario === 'rejected authored' }), operationAcceptance: { operationId: 'domain-operation', accept() {} } };
        const result = await executor.execute(actionId, input, context);
        if (scenario === 'recovery Add a3318568 missing selection' || scenario === 'recovery Add no recorded ingress'
            || scenario === 'authored ui' || scenario === 'authored agent') {
            expect(result).toMatchObject({ ok: false, errorCode: 'required_fact_unavailable',
                details: { requiredFact: scenario === 'recovery Add no recorded ingress'
                    ? 'domain_ingress_required' : 'cloudflare_selection_required', remedy: expect.any(String) } });
            expect(nativeJobs).toEqual([]);
            expect(discoveredPrivateCandidates).toEqual([]);
            expect(privateWrites).toEqual([]);
            expect(trace).not.toContain('domain-admitted');
            expect(vendorRequests).toEqual([]);
            return;
        }
        if (scenario === 'Home Domain admission refused') {
            expect(result).toMatchObject({ ok: false, errorCode: 'action_forbidden',
                error: 'action_forbidden (home_signed_authorization_rejected:verification_purpose)',
                details: { requiredFact: 'verification_purpose', remedy: expect.any(String) },
                failureCause: { phase: 'home.authorization.verification_purpose', httpStatus: 403 } });
            expect(trace).toContain('domain-admitted');
            expect(trace).not.toContain('mint-token');
            expect(nativeJobs).toEqual([]);
            return;
        }
        if (scenario === 'rejected authored') {
            expect(result).toMatchObject({ ok: false });
            expect(trace).not.toContain('domain-admitted');
            expect(privateWrites).toEqual([]);
            expect(authored.artifacts.read(authoredInput.contentArtifactId)).toBeUndefined();
            return;
        }
        if (domainIngressOnly) {
            const evidence = JSON.stringify({ result, trace, vendorRequests });
            expect(trace, evidence).toContain('vendor-dns');
            if (scenario === 'authored domain DNS refused') {
                expect(result, evidence).toMatchObject({ ok: false });
                expect(trace).not.toContain('domain-active');
                expect(nativeJobs).toEqual([]);
            } else {
                expect(result, evidence).toMatchObject({ ok: true, result: { ok: true, domain: { state: 'active' } } });
                expect(remoteConfig).toEqual({ ingress: [{ hostname: content.hostname, service: 'http://172.18.0.2:9381' },
                    { service: 'http_status:404' }] });
                expect(trace.indexOf('domain-active')).toBeGreaterThan(trace.indexOf('vendor-dns'));
                expect(nativeJobs).toMatchObject([{ capture: { listener: 'privateOrigin' },
                    cloudflareConnector: { tunnelId: 'reviewed-tunnel' } }]);
            }
            return;
        }
        if (malformedRemoval || malformedPreparation) {
            expect(result, JSON.stringify({ result, trace, vendorRequests })).toMatchObject({ ok: false,
                errorCode: malformedRemoval ? 'invalid_provider_output' : 'outcome_unknown',
                details: { step: 'native_execution', requiredFact: 'cloudflarePreparation',
                    providerOutput: expect.stringMatching(/(?=.*configurations)(?=.*result\.config)(?=.*object)/),
                    remedy: expect.stringMatching(/\S/) }, failureCause: {
                    phase: malformedRemoval ? 'deployment.domain.cloudflare_retirement' : 'deployment.domain.cloudflare_preparation',
                    errorCode: 'invalid_provider_output' } });
            expect(JSON.stringify(result)).not.toContain(malformedConfigurationValue);
            expect(domain?.deletedAtMs).toBeUndefined();
            expect(trace).not.toContain('domain-removed');
            expect(trace).not.toContain('domain-active');
            expect(nativeJobs).toEqual([]);
            expect(vendorRequests.filter(request => request.method !== 'GET')).toEqual(malformedRemoval ? [] : [{
                method: 'POST', path: '/client/v4/accounts/vendor-account/cfd_tunnel' }]);
            return;
        }
        if (grantAuthorizationRefused) {
            expect(result).toMatchObject({ ok: false, failureCause: { phase: 'home.authorization.deployment_child_http',
                errorCode: 'action_forbidden', httpStatus: 401 } });
            expect(nativeJobs).toEqual([]);
            expect(vendorRequests.every(request => request.method === 'GET' || creatingTunnel && request.method === 'POST'
                && request.path.endsWith('/cfd_tunnel'))).toBe(true);
            expect(preparedBody).toMatchObject({ cloudflarePreparation: { tunnelId: 'reviewed-tunnel', connectors: [] } });
            expect(JSON.stringify({ result, preparedBody })).not.toContain('private-minted-connector-token');
            expect(JSON.stringify({ result, preparedBody })).not.toContain('private-cloudflare-api-token');
            return;
        }
        if (unprepared) {
            expect(authored.artifacts.read(authoredInput.contentArtifactId)?.bodyVersion).toBe(1);
            expect(retainedContent).not.toHaveProperty('cloudflarePreparation');
            expect(vendorController.owned).toEqual([]);
            const evidence = JSON.stringify({ result, trace, vendorRequests });
            if (scenario === 'remove unprepared foreign route') {
                expect(result, evidence).toMatchObject({ ok: false, errorCode: 'route_conflict' });
                expect(remoteConfig).toEqual({ ingress: [{ hostname: content.hostname, service: 'http://foreign-service:9381' },
                    unrelatedRoute, { service: 'http_status:404' }] });
                expect(dnsRemoved).toBe(false);
                expect(nativeJobs).toEqual([]);
                expect(vendorRequests.every(request => request.method === 'GET')).toBe(true);
            } else {
                expect(result, evidence).toMatchObject({ ok: true, result: { ok: true, domain: { deletedAtMs: 2 } } });
                expect(trace).toContain('domain-removed');
                expect(nativeJobs).toHaveLength(1);
                expect(nativeJobs[0]?.cloudflareConnector).toBeUndefined();
                expect(remoteConfig).toEqual(nullConfiguration ? null : { ingress: [unrelatedRoute, { service: 'http_status:404' }] });
                if (nullConfiguration) expect(vendorRequests.filter(request => request.path.endsWith('/configurations')
                    && request.method !== 'GET')).toEqual([]);
                expect(dnsRemoved).toBe(scenario !== 'remove unprepared absent tunnel');
                expect(trace).toContain('vendor-tunnel-lookup');
                if (realNativeRemoval) {
                    expect(nativeRemovals).toEqual([retainedRoute.route['@id']]);
                    expect(caddyConfig.apps.http.servers.private_app.routes).toEqual([]);
                }
            }
            expect(vendorRequests.filter(request => request.method !== 'GET').every(request =>
                request.path.endsWith('/configurations') || request.path.endsWith('/dns_records/acknowledged-dns-record'))).toBe(true);
            expect(trace).not.toContain('mint-token');
            return;
        }
        if (removing) {
            expect({ result, trace }, JSON.stringify({ result, trace, vendorRequests })).toMatchObject({ result: { ok: false, errorCode: 'native_route_unavailable' },
                trace: expect.arrayContaining(['removal-admitted', 'vendor-config', 'vendor-dns-removed', 'native-dispatch']) });
            expect(trace).not.toContain('mint-token');
            expect(remoteConfig).toEqual({ ingress: [{ service: 'http_status:404' }] });
            expect(nativeJobs).toHaveLength(1);
            if (scenario === 'remove final') expect(nativeJobs[0]?.cloudflareConnector).toMatchObject({ tunnelId: 'reviewed-tunnel', grantRef: retainedGrant });
            else expect(nativeJobs[0]?.cloudflareConnector).toBeUndefined();
            return;
        }
        expect([...grants.keys()], JSON.stringify({ result, trace })).toEqual(grantedMembers);
        const grantRef = grants.get('receiver');
        expect(grantRef).toBeTypeOf('string');
        expect(trace.filter(item => item === 'mint-token')).toHaveLength(1);
        expect(trace.filter(item => item === 'vendor-config'), JSON.stringify({ result, trace })).toHaveLength(scenario === 'partial grant' ? 0 : 1);
        expect(trace.indexOf('sealed-for-target')).toBeGreaterThan(trace.indexOf('domain-facts'));
        if (scenario !== 'partial grant') {
            expect(trace.indexOf('vendor-config')).toBeGreaterThan(trace.indexOf('sealed-for-target'));
            expect(trace.indexOf('content-cas')).toBeGreaterThan(trace.indexOf('vendor-dns'));
        } else expect(trace.indexOf('content-cas'), JSON.stringify({ result, trace })).toBeGreaterThan(trace.indexOf('sealed-for-target'));
        if (createWithoutVersion) expect(trace).toContain('vendor-tunnel-created');
        expect(result).toMatchObject({ ok: false, errorCode: scenario === 'prepared' || createWithoutVersion || omittedConfiguration || scenario === 'two members' ? 'native_route_unavailable'
            : scenario === 'content conflict' ? 'deployment_conflict' : 'outcome_unknown' });
        if (scenario === 'content conflict') {
            expect(nativeJobs).toEqual([]);
            expect(authored.artifacts.read(authoredInput.contentArtifactId)?.bodyVersion).toBe(1);
        } else {
            expect(preparedBody).toMatchObject({ cloudflarePreparation: { tunnelId: 'reviewed-tunnel',
                owned: [{ hostname: content.hostname, expectedService: 'http://172.18.0.2:9381' }],
                dnsOwnership: scenario === 'partial grant' ? [] : [{ hostname: content.hostname, recordId: dnsRecord.id }], connectors: grantedMembers.map(machineId => ({ machineId,
                    installationId: installation(machineId), ...vendorController.connector, networkName: 'environment_default', grantRef: grants.get(machineId) })) } });
            expect(authored.artifacts.read(authoredInput.contentArtifactId)?.bodyVersion).toBe(2);
            if (scenario === 'vendor unknown' || scenario === 'partial grant') expect(nativeJobs).toEqual([]);
            else {
                expect(trace.indexOf('native-dispatch')).toBeGreaterThan(trace.indexOf('content-cas'));
                expect(nativeJobs).toHaveLength(members.length);
                expect(nativeJobs[0]).toMatchObject({ expectedDomainRevision: 1, actionOperationId: 'domain-operation',
                    capture: { content: { contentBodyVersion: 2 }, placement: { nativeServer: 'private_app' } },
                    cloudflareConnector: { tunnelId: 'reviewed-tunnel', networkName: 'environment_default', grantRef,
                        connector: vendorController.connector } });
            }
        }
        expect(JSON.stringify({ result, nativeJobs, preparedBody })).not.toContain('private-minted-connector-token');
        expect(JSON.stringify({ result, nativeJobs, preparedBody })).not.toContain('private-cloudflare-api-token');
    } finally {
        await requester?.dispose();
        await runtime?.dispose();
        if (caddyServer.listening) await new Promise<void>((resolve, reject) => caddyServer.close(error => error ? reject(error) : resolve()));
        await channel.close(); restoreHttp(); await app.close();
    }
}));
