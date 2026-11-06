import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import nacl from 'tweetnacl';
import { vi } from 'vitest';
import { DeploymentChildRpcV1Schema, projectDeploymentChildRoutingV1, deploymentOperationForRootActionV1,
    isDeploymentChildRootActionIdV1, type DeploymentChildRpcV1 } from '@happier-dev/protocol';
import { createDeploymentCandidatePublicationV1, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema,
    projectDeploymentPreparationAdmissionV1, projectDeploymentNativeAdmissionV1,
    isDeploymentDomainNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, sealExternalActionRequestV2, createActionExecutor } from '@happier-dev/protocol/actions';
import { deriveAccountMachineKeyFromRecoverySecret, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { createExternalActionMachineRpcExecution } from '@/api/externalActionExecutionAuthorization';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import * as installationStore from '@/daemon/identity/store';
import { prepareInstalledRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { encodeStoredCredentials, type StoredCredentials } from '@/persistence';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

/** Real closed producers and requester admission; only the installation file is substituted. */
export async function createDeploymentChildRequesterHarness(options: Readonly<{
    encryptionMode?: 'plain' | 'e2ee';
    serverHttpBaseUrl?: string;
    profileId?: string;
    job?: DeploymentChildRpcV1;
    rootActionId?: 'deployments.templates.instantiate' | 'deployments.publish' | 'deployments.environments.create';
    rootInput?: unknown;
    source?: Readonly<{ id: string; revision: number }>;
    receivingIdentity?: Readonly<{ machineId: string; installationId: string; homeIdentityId: string }>;
}> = {}) {
    const encryptionMode = options.encryptionMode ?? 'e2ee';
    const serverHttpBaseUrl = options.serverHttpBaseUrl ?? 'https://requester-home.test';
    const profileId = options.profileId ?? 'home-profile';
    const homeIdentityId = options.receivingIdentity?.homeIdentityId ?? 'srv_archive_home';
    const machineId = options.receivingIdentity?.machineId ?? 'receiver';
    const receiver = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(71));
    const controller = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(72));
    const installed = { version: 1 as const, installationId: options.receivingIdentity?.installationId ?? 'receiver-installation', createdAt: 1,
        publicKey: Buffer.from(receiver.publicKey).toString('base64url'), privateKey: Buffer.from(receiver.secretKey).toString('base64url') };
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(installed);
    const secret = new Uint8Array(32).fill(73);
    const bob: StoredCredentials = { token: 'bob-private-archive', credentialProvenance: 'stored_session',
        encryption: encryptionMode === 'plain' ? null : { type: 'legacy', secret } };
    const ann: StoredCredentials = { token: 'ann-finite-socket', credentialProvenance: 'stored_session',
        encryption: encryptionMode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(74) } };
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
    const job = DeploymentChildRpcV1Schema.parse(options.job ?? { v: 1, kind: 'member', actionId: 'deployments.deploy',
        machineId, installationId: installed.installationId, phase: 'activate', deploymentId: 'deployment',
        selectedDeploymentId: 'deployment', actionOperationId: 'operation', input: {
            serverId: homeIdentityId, environmentId: 'environment', targetLinkId: 'link', expectedRevision: 1,
            expectedTargetLinkRevision: 1, requestKey: 'request', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 } });
    if (job.machineId !== machineId || job.installationId !== installed.installationId) {
        throw new Error('Deployment fixture job must target its installed receiver');
    }
    const binding = { accountId: 'bob', authentication: { kind: 'account' as const, tokenEpoch: 1 },
        serverIdentityId: homeIdentityId, actionId: options.rootActionId ?? job.actionId, requestId: 'private-deployment-request',
        target: { kind: 'machine' as const, machineId: 'controller' } };
    const rootInput = getActionSpec(binding.actionId).inputSchema.parse(options.rootInput ?? job.input);
    const envelope = encryptionMode === 'plain'
        ? ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: binding.requestId, target: binding.target, input: rootInput })
        : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: rootInput,
            material: { type: 'dataKey', machineKey }, randomBytes: nacl.randomBytes });
    const requestEnvelopeDigest = computeExternalActionRequestEnvelopeDigestV1(envelope);
    const deploymentPreparationAdmission = projectDeploymentPreparationAdmissionV1(binding.actionId, rootInput);
    const nativeAdmission = projectDeploymentNativeAdmissionV1(binding.actionId, rootInput);
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'private-deployment-root', binding: {
        ...binding, custodianAccountId: 'controller-owner', accountEncryptionMode: encryptionMode, machineId: 'controller',
        installationId: 'controller-installation', requestEnvelopeDigest,
        ...(isDeploymentChildRootActionIdV1(binding.actionId, deploymentPreparationAdmission) ? { deploymentChildRoot: true } : {}),
        ...(isDeploymentDomainNativeAdmissionV1(nativeAdmission)
            ? { environmentId: nativeAdmission.environmentId, deploymentNativeAdmission: nativeAdmission } : {}),
        ...(deploymentPreparationAdmission ? { deploymentPreparationAdmission } : {}),
        ...(options.rootActionId || deploymentOperationForRootActionV1(job.actionId) === undefined ? {} : { deploymentCandidatePublication: createDeploymentCandidatePublicationV1({ ...binding, requestEnvelopeDigest,
            environmentId: job.input.environmentId, source: options.source ?? { id: 'source', revision: 1 } }) }) } });
    const purpose = { kind: 'machine_rpc', method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, params: job,
        recipient: { machineId, installationId: installed.installationId } } as const;
    const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
        credentials: encodeStoredCredentials(bob), installationPublicKey: receiver.publicKey, randomBytes: nacl.randomBytes });
    const receiverEncryption = encryptionMode === 'plain' ? { encryptionMode: 'plain' as const }
        : { encryptionKey: new Uint8Array(32).fill(76), encryptionVariant: 'dataKey' as const };
    const receiverCodec = createMachineContentCodec(receiverEncryption);
    const receiverContent = receiverCodec.mode === 'plain' ? { mode: 'plain' as const } : {
        mode: 'e2ee' as const, cipher: { encryptRaw: async (value: unknown) => receiverCodec.encodeRpc(value),
            decryptRaw: async (value: string) => receiverCodec.decodeRpc(value) } };
    const method = `${machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`;
    const encodedJob = await socketRpcCodec.encodeParams(receiverContent, job, { method, callId: '71'.repeat(16) });
    const execution = createExternalActionMachineRpcExecution({ context: {
        externalActionExecutionAuthorization: sealed, externalActionTarget: root.binding.target },
        effectActionId: job.actionId, installationId: root.binding.installationId, method,
        requestId: 'private-child-request', params: encodedJob, privateKey: controller.secretKey,
        deploymentChildRouting: projectDeploymentChildRoutingV1(job) });
    if (!execution) throw new Error('Missing controller packet');
    const packet = { method, requestId: 'private-child-request', params: StrictJsonValueSchema.parse(encodedJob),
        originalActionEnvelope: envelope, externalActionExecution: execution };
    const currentness = { mode: encryptionMode, version: 1, signingKeyFingerprint: encryptionMode === 'plain' ? null : 'bob-signing',
        contentKeyFingerprint: encryptionMode === 'plain' ? null : computeAccountEncryptionMigrateKeyFingerprintV1(
            nacl.box.keyPair.fromSecretKey(machineKey).publicKey), updatedAt: 1 };
    const settingsContent = encryptionMode === 'plain' ? { t: 'plain' as const, v: {} }
        : { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
            material: { type: 'legacy', secret }, payload: {}, randomBytes: nacl.randomBytes }) };
    let current = true;
    return { bob, ann, receiver, controller, installed, secret, machineKey, job, root, envelope, purpose, sealed, packet,
        receiverEncryption, receiverContent,
        currentness, settingsContent, profileId, homeIdentityId, serverHttpBaseUrl,
        setCurrent(value: boolean) { current = value; },
        async prepare(signal?: AbortSignal) {
            const prepared = await prepareInstalledRequesterAccountActionContext({ authorization: sealed, purpose,
                deploymentChildExecution: packet, machineId: job.machineId, serverId: profileId, serverHttpBaseUrl,
                verifyServiceMoveChildCurrent: async () => current,
                resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: job.machineId, serverIdentityId: homeIdentityId }),
                createExecutor: () => createActionExecutor(createUnavailableActionTransportDeps()), ...(signal ? { signal } : {}) });
            if (!prepared) throw new Error('Missing private requester receiver custody');
            return prepared;
        } };
}
