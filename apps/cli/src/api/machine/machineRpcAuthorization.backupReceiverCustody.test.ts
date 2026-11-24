import { expect, it, vi } from 'vitest';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ExternalActionExecutionAuthorizationV1Schema, type ReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import { BACKUP_RECEIVER_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createActionExecutor } from '@happier-dev/protocol';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { resolveExternalActionRootInvocationAuthority } from '@/api/externalActionExecutionAuthorization';
import * as installationStore from '@/daemon/identity/store';
import { prepareInstalledRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { encodeStoredCredentials } from '@/persistence';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent, type MachineRpcAdmissionBoundary } from './machineRpcAuthorization';

it('opens the sealed requester custody for a Backup receiver Setup child only on the receiver its review named', async () => {
  const homeId = 'home';
  const source = tweetnacl.sign.keyPair();
  const receiver = tweetnacl.sign.keyPair();
  const admission = { actorAccountId: 'requester', custodianAccountId: 'receiver-owner', machineId: 'receiver',
    installationId: 'receiver-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
  const target = { kind: 'machine' as const, machineId: 'source' };
  const rootInput = { serverId: homeId, environmentId: 'environment', expectedRevision: 3, intent: 'test' as const,
    destinationSetup: { kind: 'anotherMachine' as const, machineId: 'receiver', expectedInstallationId: 'receiver-installation', receiverInputs: {} },
    configuration: { configRevision: 1, destinationRef: { pluginId: 'happier.backup.local', localId: 'open' }, occurrenceId: 'destination',
      config: { path: '/private/repository' }, credentialBindings: [],
      sources: [{ kind: 'dump' as const, sourceId: 'database', service: 'postgres', consistency: 'logical' as const }],
      ownership: { environmentId: 'environment', prefix: 'owner-prefix' }, retention: { kind: 'keepEverything' as const } } };
  const envelope = { v: 1 as const, requestId: 'backup-configure', target, input: rootInput };
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root', binding: {
    accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
    custodianAccountId: 'requester', serverIdentityId: homeId, machineId: 'source', installationId: 'source-installation',
    actionId: 'deployments.backups.configure', requestId: envelope.requestId, target, environmentId: 'environment',
    deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.backups.configure', rootInput),
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  const authority = resolveExternalActionRootInvocationAuthority(root);
  const request = { homeId, machineId: 'receiver' };
  const reviewedChild: ReviewedActionChildHttpProofV1 = { actionId: 'machines.setup.plan', role: BACKUP_RECEIVER_SETUP_CHILDREN_V1.plan.role,
    inputDigest: computeActionInputApprovalDigestV1('machines.setup.plan', request) };
  // The source seals the requester's custody to the receiver installation (the sender's seal owner admits it).
  const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root,
    purpose: { kind: 'machine_rpc', method: RPC_METHODS.MACHINE_SETUP_PLAN, params: request, reviewedChild,
      recipient: { machineId: admission.machineId, installationId: admission.installationId } },
    credentials: encodeStoredCredentials({ token: 'requester-account', credentialProvenance: 'stored_session', encryption: null }),
    installationPublicKey: receiver.publicKey, randomBytes: tweetnacl.randomBytes });
  const requestId = '0123456789abcdef0123456789abcdef';
  const method = `${admission.machineId}:${RPC_METHODS.MACHINE_SETUP_PLAN}`;
  const packet = (params: unknown, proof = reviewedChild) => ({ method, requestId, params: projectNativeJsonValueForTransport(params),
    originalActionEnvelope: envelope, externalActionExecution: { v: 1 as const, authorization: sealed, effectActionId: 'machines.setup.plan',
      target, installationId: 'source-installation', reviewedChild: proof,
      machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: root.token, requesterAccountContext: sealed.requesterAccountContext,
        effectActionId: 'machines.setup.plan', target, installationId: 'source-installation',
        method, requestId, params, reviewedChild: proof, privateKey: source.secretKey }) } });
  const channel = await createRequesterCurrentnessSocketHarness();
  const installed = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
    installationId: admission.installationId, createdAt: 1, publicKey: Buffer.from(receiver.publicKey).toString('base64url'),
    privateKey: Buffer.from(receiver.secretKey).toString('base64url') });
  // Home is the genuine network boundary; custody opening, packet matching and dispatch stay real.
  const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { v: 1, ok: true } });
  const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'requester' } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    throw new Error(`Unexpected requester HTTP path ${path}`);
  });
  try {
    const boundary: MachineRpcAdmissionBoundary = { machineId: admission.machineId, resolveInstallationId: () => admission.installationId,
      resolveCustodianAccountId: async () => admission.custodianAccountId, resolveHomeServerIdentityId: async () => homeId,
      verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, privateKey: receiver.secretKey,
        daemonToken: 'daemon', serverHttpBaseUrl: 'https://home.invalid' }) };
    const effects: unknown[] = [];
    const logs: string[] = [];
    const rpc = new RpcHandlerManager({ scopePrefix: admission.machineId, localMachineId: admission.machineId,
      encryptionMode: 'plain', logger: (...entry: unknown[]) => { logs.push(JSON.stringify(entry)); },
      authorizeRequest: (rpcRequest, origin) => authorizeMachineRpcRequest(rpcRequest, boundary, origin),
      prepareRequesterAccountContext: input => prepareInstalledRequesterAccountActionContext({ ...input,
        purpose: input.purpose ?? { kind: 'external_action' },
        machineId: admission.machineId, serverId: homeId, serverHttpBaseUrl: 'https://home.invalid',
        resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: admission.machineId, serverIdentityId: homeId }),
        createExecutor: () => createActionExecutor(createUnavailableActionTransportDeps()) }),
    });
    rpc.registerHandler(RPC_METHODS.MACHINE_SETUP_PLAN, async (input, context) => {
      effects.push({ input, custody: Boolean(context?.callerInputAuthorization?.requesterHttpProjection) });
      return { planned: true };
    });
    const invoke = async (params: unknown, proof = reviewedChild, role: 'manage' | 'use' = 'manage') => {
      const encoded = await socketRpcCodec.encodeParams({ mode: 'plain' }, params, { method, callId: requestId });
      const result = await rpc.handleRequest({ method, params: encoded, requestId, callerAuthority: authority,
        machineAdmission: { ...admission, role }, callerInputAuthorization: sealed, originalActionEnvelope: envelope,
        workspaceSyncSourceExecution: packet(encoded, proof) });
      return socketRpcCodec.decodeResult({ mode: 'plain' }, { ok: true, result }, requestId);
    };
    expect(await invoke(request), logs.join('\n')).toEqual({ planned: true });
    // The handler ran with the opened requester custody projected for the receiver.
    expect(effects).toEqual([{ input: request, custody: true }]);
    expect(await invoke(request, reviewedChild, 'use')).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(await invoke(request, { ...reviewedChild, role: 'forged' })).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    const elsewhere = { homeId, machineId: 'elsewhere' };
    expect(await invoke(elsewhere, { ...reviewedChild, inputDigest: computeActionInputApprovalDigestV1('machines.setup.plan', elsewhere) }))
      .toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(effects).toHaveLength(1);
  } finally { installed.mockRestore(); post.mockRestore(); get.mockRestore(); await channel.close(); }
});
