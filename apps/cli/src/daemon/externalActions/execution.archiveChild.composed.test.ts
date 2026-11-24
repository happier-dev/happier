import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { DeploymentChildRpcV1Schema } from '@happier-dev/protocol';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { ApiMachineClient } from '@/api/apiMachine';
import { createExternalActionMachineRpcExecution } from '@/api/externalActionExecutionAuthorization';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createDaemonShutdownCancellationDomains } from '@/daemon/startup/shutdownCancellationDomains';
import { createDirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';
import { createPreparedFilesystemTransferActionExecutor, projectPreparedFilesystemActionResult } from '@/machines/transfer/createPreparedFilesystemTransferActionExecutor';
import * as persistence from '@/persistence';
import { registerFilesystemMutationActionHandlers } from '@/rpc/handlers/fileSystem/pathMutationHandlers';
import { createDeploymentChildRequesterHarness } from '@/testkit/backends/deploymentChildRequesterHarness';
import { createDaemonExternalActionExecution } from './execution';

function unmounted<T>(name: string): T {
    const unavailable = () => { throw new Error(`Unexpected daemon capability: ${name}`); };
    return new Proxy(unavailable, { get: unavailable }) as T;
}

it('delivers the signed Deployment archive copy to the receiving filesystem effect', async () => {
    const fixtureHomeId = 'srv_archive_home';
    const receiver = { machineId: 'receiver', installationId: 'receiver-installation', homeIdentityId: fixtureHomeId };
    const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: 'deployments.deploy',
        machineId: receiver.machineId, installationId: receiver.installationId, phase: 'restore', deploymentId: 'candidate',
        selectedDeploymentId: 'serving', actionOperationId: 'rollout', input: { serverId: fixtureHomeId,
            environmentId: 'environment', targetLinkId: 'link', expectedRevision: 1, expectedTargetLinkRevision: 1,
            requestKey: 'candidate', contentArtifactId: 'candidate-content', contentHeaderVersion: 1, contentBodyVersion: 1 } });
    const h = await createDeploymentChildRequesterHarness({ encryptionMode: 'plain', profileId: fixtureHomeId, job,
        receivingIdentity: receiver });
    const { machineId } = h.job;
    const homeId = h.root.binding.serverIdentityId;
    const actionId = 'daemon.filesystem.copy';
    const rpcMethod = RPC_METHODS.DAEMON_FILESYSTEM_COPY;
    const method = `${machineId}:${rpcMethod}`;
    const requestId = 'archive-copy';
    const rootPath = await mkdtemp(join(tmpdir(), 'archive-copy-receiver-'));
    const controller = new AbortController();
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
    const apiMachine = new ApiMachineClient(h.bob.token, { id: machineId, encryptionMode: 'plain',
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    try {
        vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockImplementation(async serverId =>
            serverId === h.profileId ? h.bob : null);
        const features = FeaturesResponseSchema.parse({ features: { workflows: { enabled: false } } });
        vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
            if (String(url) === `${h.serverHttpBaseUrl}/v1/features`) return Response.json(features);
            throw new Error(`Unexpected Home request: ${String(url)}`);
        });
        const input = { kind: 'prepared_transfer', source: { kind: 'entry_tree', serverId: homeId, machineId: 'holder', rootPath,
            path: 'archive.tar', sourceId: 'archive-entry', sizeBytes: 1, sha256: '0'.repeat(64),
            entryTree: { operationId: 'export', expectation: { kind: 'file', digest: '0'.repeat(40), executable: false, size: 1 }, blobs: [] } },
        destination: { serverId: homeId, machineId, rootPath, path: 'archive.tar' }, overwrite: false, recursive: false };
        const params = { v: 1, kind: 'targeted_action_rpc', target: { kind: 'machine', machineId }, input };
        const signArchive = (installationId: string) => createExternalActionMachineRpcExecution({ context: {
            externalActionExecutionAuthorization: h.root, externalActionTarget: h.root.binding.target },
            effectActionId: actionId, installationId, method, requestId, params,
            deploymentChildExecution: h.packet, deploymentArchiveOrigin: { environmentId: h.job.input.environmentId,
                deploymentId: 'serving', holderMachineId: 'holder', holderInstallationId: 'holder-install' },
            privateKey: h.receiver.secretKey });
        const proof = signArchive(h.installed.installationId);
        if (!proof?.deploymentChildExecution) throw new Error('Missing signed archive proof');
        expect(verifyExternalActionMachineRpcRequestV1({
            ...h.packet.externalActionExecution, authorizationToken: h.root.token,
            requesterAccountContext: h.sealed.requesterAccountContext, method: h.packet.method,
            requestId: h.packet.requestId, params: h.packet.params,
            signature: h.packet.externalActionExecution.machineSignature, publicKey: h.controller.publicKey,
        })).toBe(true);
        const received = {
            ...proof, authorizationToken: h.root.token, method, requestId, params,
            signature: proof.machineSignature, publicKey: h.receiver.publicKey,
        };
        expect(verifyExternalActionMachineRpcRequestV1(received)).toBe(true);
        for (const differentAddress of [
            { method: `another-machine:${rpcMethod}` },
            { installationId: 'another-installation' },
            { method: `${machineId}:${RPC_METHODS.STOP_SESSION}`, effectActionId: 'session.stop' },
        ]) {
            expect(verifyExternalActionMachineRpcRequestV1({ ...received, ...differentAddress })).toBe(false);
        }
        const transfer = createPreparedFilesystemTransferActionExecutor({ lifecycle, workingDirectory: rootPath,
            accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] } });
        const accept = vi.fn(() => controller.abort());
        // Mount the receiving filesystem effect against a temporary disk and loopback carrier.
        vi.spyOn(apiMachine, 'createFilesystemActionExecutor').mockReturnValue(async request => projectPreparedFilesystemActionResult(await transfer({
            actionId, input: request.input, context: { ...request.context,
                signal: AbortSignal.any([controller.signal, ...(request.context.signal ? [request.context.signal] : [])]),
                operationAcceptance: { operationId: 'copy-operation', actionId, accept } },
        })));
        const isSessionCallerCurrent = async () => true;
        let receivingHome = 'another-home';
        const daemon = createDaemonExternalActionExecution({
            params: {
                machineId, serverId: h.profileId, serverBaseUrl: h.serverHttpBaseUrl, credentials: h.bob,
                getApiMachineForSessions: () => apiMachine,
                resolveServerFeaturesSnapshot: () => undefined,
                resolveCurrentMachineExecutionOriginContext: async () => ({ machineId, serverIdentityId: receivingHome }),
            },
            requiresPortableSessionSpawnServerIdentity: () => false,
            requesterAccountOperationContext: unmounted('requesterAccountOperationContext'),
            acquireDaemonPluginRuntimeRegistryLease: unmounted('pluginRegistry'),
            shutdownCancellationDomains: createDaemonShutdownCancellationDomains(),
            isSessionCallerCurrent,
            externalActionApprovalExecutionOriginCurrentness: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
                credentials: h.bob, serverId: h.profileId, serverApiUrl: h.serverHttpBaseUrl, machineId, isSessionCallerCurrent }),
            externalActionIngressOwner: undefined,
            externalActionContributedApprovalReplay: null,
            observeContributedPluginExecution: unmounted('pluginExecution'),
            relayDiscussionAgentPublication: unmounted('discussion'),
            externalActionInstallationIdentity: h.installed,
            ownerRemainder: unmounted('processRemainder'),
            isRuntimePublicationQuiescing: () => false,
            pluginRuntimeController: unmounted('plugins'),
            connectedAccountRequestAuthRegistry: unmounted('connectedAccounts'),
            requireConnectedAccountRequestAuthHttpPort: unmounted('connectedAccountHttp'),
            localServicesActionFeatureGate: unmounted('localServicesGate'),
            localServicesRuntimeActionRoutes: unmounted('localServicesRoutes'),
            localServicesRuntime: unmounted('localServices'),
            externalActionContributedInvoker: null,
            externalActionContributedDefinitionLister: null,
            externalActionTranscriptFollowLeaseRegistry: null,
        })(h.bob, () => 0, isSessionCallerCurrent, undefined, null);
        const rpc = new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId, encryptionMode: 'plain', logger: () => {},
            // The authenticated Home socket is the network boundary. Local RPC admission and dispatch run unchanged.
            authorizeRequest: async () => ({ ok: true }) });
        registerFilesystemMutationActionHandlers(rpc, {
            workingDirectory: rootPath, accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] },
            getAdditionalAllowedReadDirs: () => [], getAdditionalAllowedWriteDirs: () => [],
            mutationMachineId: machineId, resolveMutationActionExecutor: () => daemon,
        }, [actionId]);
        const request = {
            method, params, callerAuthority: 'account_automation', callerInputAuthorization: h.root,
            workspaceSyncSourceExecution: { method, requestId, params, externalActionExecution: proof },
            machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'bob', machineId,
                installationId: h.installed.installationId, role: 'use', encryptionMode: 'plain' },
        } as const;
        expect(() => signArchive('another-installation')).toThrow(TypeError);
        const wrongFamilyMethod = `${machineId}:${RPC_METHODS.STOP_SESSION}`;
        for (const refused of [
            { ...request, machineAdmission: { ...request.machineAdmission, machineId: 'another-machine' } },
            { ...request, workspaceSyncSourceExecution: { ...request.workspaceSyncSourceExecution,
                externalActionExecution: { ...proof, installationId: 'another-installation' } } },
            { ...request, method: wrongFamilyMethod, workspaceSyncSourceExecution: { ...request.workspaceSyncSourceExecution, method: wrongFamilyMethod } },
        ]) await expect(rpc.handleRequest(refused)).resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
        await expect(rpc.handleRequest(request)).resolves.toMatchObject({ ok: false, errorCode: 'not_authenticated' });
        expect(accept).not.toHaveBeenCalled();
        receivingHome = homeId;
        const result = await rpc.handleRequest(request);
        expect(accept, JSON.stringify(result)).toHaveBeenCalledWith(expect.objectContaining({
            status: 'accepted', operationId: 'copy-operation', sourceId: 'archive-entry',
        }));
    } finally {
        controller.abort();
        await apiMachine.shutdown();
        await lifecycle.stop();
        await rm(rootPath, { recursive: true, force: true });
        vi.restoreAllMocks();
    }
});
