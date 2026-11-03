import { createHash } from 'node:crypto';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentActionInputSchemasV1 } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema, projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { createDeploymentSourceMaterializationPort } from '@/deployments/targets/ownServer/exactCommitRelease';
import { createScmBackendRegistry } from '@/scm/registry';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import * as installationStore from '@/daemon/identity/store';
import { createDaemonDeploymentActionDeps } from '../createDaemonDeploymentActionDeps';
import { createOwnServerDeploymentRuntimeForHost } from '../targets/ownServer/ownServerDeploymentHostRuntime';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import type { StoredCredentials } from '@/persistence';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';

// Account observation retains its real supervisor over a deterministic Socket.IO boundary.
vi.mock('socket.io-client', async () => {
    const { createApiSessionSocketStub } = await import('@/testkit/backends/apiSessionSocketHarness');
    return { io: () => createApiSessionSocketStub() };
});

describe('existing deployment native restart', () => {
    it('restarts the admitted mounted Environment after Source withdrawal without creating another service', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-deployment-restart-'));
        const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
        const environment = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        const keys = tweetnacl.sign.keyPair();
        const installation = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({
            version: 1, installationId: 'installation-a', createdAt: 1,
            publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url'),
        });
        const document = JSON.stringify({ services: { app: { image: 'example/app:1' } } });
        const materializer = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit() {
            return { environmentId: environment.environment.id, environmentInstanceId: 'instance', deploymentId: receipt.deployment.id,
                machineId: 'machine-a', installationId: 'installation-a', deploymentRoot: join(root, 'deployments'),
                artifactDirectory: join(root, 'artifacts'), definition: { kind: 'stored' as const, contentRevision: 1, document,
                    composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'] },
                async assertCurrent() {} };
        } });
        const release = await materializer.materialize({ environmentId: environment.environment.id, deploymentId: receipt.deployment.id });
        await release.commit();
        let nativeRestarts = 0;
        const handle = await fixture.registry.projectManagedServices.superviseProject({ kind: 'environment', serverId: 'home', machineId: 'machine-a',
            environmentId: release.environmentId, environmentInstanceId: release.environmentInstanceId, deploymentId: release.deploymentId,
            release, composeService: 'app', serviceId: 'instance/app', specIdentity: 'deployment-a', isCurrent: () => true,
            releaseObservation: async () => {}, nativeEffects: { keys: [] }, processSpec: { mode: { kind: 'native', observationOnly: true,
                builtinLifecycle: {
                    async inspect() { return { phase: 'running', readiness: 'not_reported', endpoint: null }; },
                    async restart() {
                        expect(operations.store.list({ accountId: 'member', machineId: host.machineId }).items)
                            .toEqual(expect.arrayContaining([expect.objectContaining({ state: 'running',
                                domainRef: { kind: 'machineService', serverId: 'home', operation: 'restart',
                                    generation: handle.instanceId,
                                    subject: { kind: 'machineService', machineId: host.machineId, serviceId: 'instance/app' } } })]));
                        nativeRestarts++;
                        return { phase: 'running', readiness: 'not_reported', endpoint: null };
                    },
                    async stop() { return { status: 'stopped' }; },
                } } },
        });
        const credentials: StoredCredentials = { token: `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`, encryption: null };
        const documents = new Map<string, Record<string, unknown>>();
        const put = (id: string, kind: string, content: unknown) => documents.set(id, { id, ownerAccountId: 'member', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind, title: 'Restart' }), body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        put(environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content);
        put(environment.targetLinks[0]!.targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, environment.targetLinks[0]!.content);
        put(receipt.deployment.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, receipt.content);
        // Only HTTP and installation custody are substituted; requester projection,
        // definition admission, host dispatch and the mounted native owner remain real.
        const resourceReads = { environment: 0, receipt: 0, artifact: 0 };
        vi.spyOn(axios, 'request').mockImplementation(async http => {
            const path = new URL(http.url!).pathname;
            if (path.includes('/environments/')) {
                resourceReads.environment++;
                return { status: 200, data: { ok: true, environment: environment.environment,
                    targetLinks: environment.targetLinks.map(row => row.targetLink) } };
            }
            if (path.includes('/receipts/')) { resourceReads.receipt++; return { status: 200, data: { ok: true, deployment: receipt.deployment } }; }
            throw new Error(`Unexpected restart resource route: ${path}`);
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'member' } };
            if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            resourceReads.artifact++;
            return { status: 200, data: documents.get(path.split('/').at(-1)!) };
        });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'home' } } }));
        const host = { credentials, serverId: 'home', machineId: 'machine-a', serverHttpBaseUrl: 'https://restart.test',
            acquirePluginRuntimeRegistryLease: () => fixture.controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () => fixture.registry }),
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const) };
        const deps = createDaemonDeploymentActionDeps({ ...host, runtime: createOwnServerDeploymentRuntimeForHost(host) });
        const operations = createHostActionOperationRuntime({ machineId: host.machineId, resolveAccountId: async () => 'member' });
        const request = DeploymentActionInputSchemasV1['deployments.restart'].parse({ serverId: 'home', machineId: 'machine-a',
            installationId: 'installation-a', environmentId: environment.environment.id, targetLinkId: 'target-link',
            deploymentId: receipt.deployment.id, expectedGeneration: handle.instanceId,
            service: { kind: 'deployment', machineId: 'machine-a', environmentId: environment.environment.id,
                environmentInstanceId: 'instance', composeService: 'app', serviceId: 'instance/app' } });
        try {
            for (const role of ['manage', 'use'] as const) {
                const target = { kind: 'machine' as const, machineId: 'machine-a' };
                const envelope = { v: 1 as const, requestId: `restart-${role}`, target, input: request };
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: `restart-${role}`, binding: {
                    accountId: 'member', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
                    serverIdentityId: 'home', machineId: 'machine-a', installationId: 'installation-a', admittedMachineRole: role,
                    actionId: 'deployments.restart', requestId: envelope.requestId, target, accountEncryptionMode: 'plain',
                    environmentId: request.environmentId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                    deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.restart', envelope.input) } });
                const sealed = sealExternalActionRequesterAccountContextV1({ authorization, purpose: { kind: 'external_action' },
                    credentials: { token: `h.${Buffer.from(JSON.stringify({ sub: 'member' })).toString('base64url')}.s`, secret: null, encryption: null },
                    installationPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes });
                const requester = await prepareRequesterAccountActionContext({ authorization: sealed, purpose: { kind: 'external_action' },
                    machineId: 'machine-a', installationId: 'installation-a', installationPrivateKey: keys.secretKey,
                    serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: host.serverHttpBaseUrl, ownCredentials: credentials,
                    isCurrent: async () => true, createExecutor: () => createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps }) });
                if (!requester) throw new Error('Expected admitted requester projection');
                const context = { surface: 'cli' as const, authority: 'present_user' as const, originalActionEnvelope: envelope,
                    externalActionTarget: target, externalActionExecutionAuthorization: requester.authorization,
                    operationAcceptance: { operationId: `restart-${role}`, actionId: 'deployments.restart' as const, accept() {} } };
                // Source authority was decided at mint. Withdrawal applies to
                // the next admission, not this already accepted restart.
                environment.environment.capabilities.deploy = false;
                const restart = (value: typeof request) => deps.deploymentAction('deployments.restart', value, context);
                try {
                    expect(await operations.observeExecution({ actionId: 'deployments.restart', input: request,
                        rpcContext: context, execute: async operation => {
                            const result = await deps.deploymentAction('deployments.restart', request, { ...context,
                                operationAcceptance: operation.operationAcceptance, operationOwnerUpdate: operation.operationOwnerUpdate });
                            return { ok: true, result };
                        } })).toMatchObject({ ok: true, result: { kind: 'observed', serviceId: 'instance/app', generation: handle.instanceId } });
                    expect(operations.store.list({ accountId: 'member', machineId: host.machineId }).items)
                        .toEqual(expect.arrayContaining([expect.objectContaining({ domainRef: { kind: 'machineService',
                            serverId: 'home', operation: 'restart', generation: handle.instanceId,
                            subject: { kind: 'machineService', machineId: host.machineId, serviceId: 'instance/app' } } })]));
                    expect(resourceReads).toEqual({ environment: 0, receipt: 0, artifact: 0 });
                    expect(await restart({ ...request, expectedGeneration: 'old-generation' })).toMatchObject({ ok: false, errorCode: 'service_generation_changed' });
                    expect(await restart({ ...request, deploymentId: 'foreign-deployment' })).toMatchObject({ ok: false, errorCode: 'service_unavailable' });
                    expect(await restart({ ...request, environmentId: 'foreign-environment' })).toMatchObject({ ok: false });
                    expect(await deps.deploymentAction('deployments.restart', request, { ...context,
                        signal: AbortSignal.abort() })).toMatchObject({ ok: false, errorCode: 'cancelled' });
                } finally { await requester.dispose(); }
            }
            expect(nativeRestarts).toBe(2);
            expect(fixture.registry.projectManagedServices.listProjectServices()).toEqual([handle]);
        } finally {
            installation.mockRestore();
            vi.restoreAllMocks();
            await handle.dispose();
            await fixture.dispose();
            await rm(root, { recursive: true, force: true });
        }
    });
});
