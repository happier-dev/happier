import axios from 'axios';
import { ApiMachineClient, type ApiMachineClientLifecycleDependencies } from '@/api/apiMachine';
import { createDaemonExternalActionExecution, createRequesterAccountOperationContext, requiresPortableSessionSpawnServerIdentity } from '@/daemon/externalActions/execution';
import { createProcessOwnershipRuntime } from '@/daemon/processes/ownership/processOwnershipRuntime';
import { createLeftBehindPass } from '@/daemon/processes/leftBehind/leftBehindPass';
import { createEndOwnerRemainder } from '@/daemon/processes/endOwnerRemainder';
import { createLocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import { createLocalServicesDaemonFeatureGate } from '@/daemon/local/services/featureGate';
import { createDaemonShutdownCancellationDomains } from '@/daemon/startup/shutdownCancellationDomains';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { ExternalActionIngressOwner } from '@/rpc/handlers/externalAction';
import { DiscussionAgentPublisherResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { requesterWorkspaceSyncTargetInstallationFiles } from './requesterWorkspaceSyncFilesystem.testkit';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { expect, onTestFinished, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { computeWorkspaceSyncPolicyDigest, ExternalActionExecutionAuthorizationV1Schema, WorkspaceSyncRelationshipCreateRpcRequestV1Schema,
  type WorkspaceSyncRelationshipCreateRpcRequestV1 } from '@happier-dev/protocol';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalExecutionV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createDaemonExternalActionTargetResolver, createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createDaemonApprovalExecutionAuthorizationPreparer } from '@/daemon/externalActions/approvalExecutionAuthorization';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1, verifyExternalActionMachineRequestV1, verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionMachineRpcExecutionV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionDaemonDispatchRequestSchema, ExternalActionMachineBootstrapV1Schema, parseExternalActionDaemonDispatchResultV1,
  EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, type ExternalActionRequestEnvelope,
  type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, MachineUpdateOperationProtocolCapabilitiesRequestV1Schema,
  MachineUpdateOperationProtocolCapabilitiesResponseV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { WorkspaceSyncSeedRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import { bindExternalActionExecutionAuthorizationVerifyHttpPathV1, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { createAgentIsolationMemberPreparationBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { deriveAgentIsolationMemberIdentity, buildAgentIsolationProvisioningSteps } from '@/daemon/agentIsolation/provisioning';
import { writeAgentIsolationMemberBinding } from '@/daemon/agentIsolation/memberBindings';
import type { HostAgentIsolationLaunchContext } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { workspaceCheckoutNativeBoundary as native } from '@/workspaces/activation/workspaceCheckoutNative.testkit';
import { runWorkspaceEffectWorker } from '@/workspaces/activation/workspaceEffectWorker';
import { registerMachineWorkspaceSyncRpcHandlers } from '@/api/machine/rpcHandlers.workspaceSync';
import { admitRequesterAccountActionContext, prepareInstalledRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent,
  doesWorkspaceSyncTargetRequestMatchRouting, readWorkspaceSyncTargetMethod,
  doesWorkspaceSyncSourceRootMatchRouting, doesWorkspaceSyncSourceWriterTargetRootMatchRouting } from '@/api/machine/machineRpcAuthorization';
import { encodeStoredCredentials } from '@/persistence';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { createPlainProjectAccountRefRow, createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import type { ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { configuration } from '@/configuration';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { prepareAccountSettingsV2Content } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { composeBindChildSourcePhaseTestRuntime } from './createProductionDaemonWorkspaceSyncRuntime.testkit';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { createApiSessionSocketStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { MachineInstallationProofPayloadV1Schema, MachineInstallationProofV1Schema, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { RpcRequest, RpcHandlerRegistrar, RpcHandlerContext } from '@/api/rpc/types';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import type { StoredCredentials } from '@/persistence';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent, createMachineDataEncryptionKeyV1 } from '@happier-dev/protocol/machines/machineStoredContent';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { encodeBase64, encrypt } from '@/api/encryption';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { artifactReadResponse } from '@/testkit/http/artifactHome';
import { materializeWorkspaceRefForMachineRoot } from '@/workspaces/workspaceRefsV1';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { createProjectWorkerAction } from '@/workspaces/execution/projectWorkerAction';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

/** Real Sync receiver/native/controller composition; callers install OS boundaries only. */
export async function createRequesterWorkspaceSyncFixture(options: Readonly<{
  role: 'use' | 'manage';
  sourceCustodianAccountId?: string;
  socketIo: Parameters<typeof composeBindChildSourcePhaseTestRuntime>[0]['socketIo'];
  readHomePost?: Parameters<typeof composeBindChildSourcePhaseTestRuntime>[0]['readAdditionalHttpPostResponse'];
  forwardHomeRpc?: (payload: unknown, receive: (packet: RpcRequest) => Promise<unknown>) => Promise<unknown>;
  readTargetRpcResponse?: (payload: Readonly<{ method: string; params: unknown }>) => unknown;
  afterTargetRpcResponse?: (payload: Readonly<{ method: string; params: unknown }>) => void;
  remoteTarget?: boolean;
  accountMode?: 'plain' | 'e2ee';
  targetCustodianAccountId?: string;
  targetResourceMode?: 'plain' | 'e2ee';
  workerCleanCopy?: boolean;
  remoteSeed?: boolean;
  nativeCarrierHome?: Parameters<typeof composeBindChildSourcePhaseTestRuntime>[0]['nativeCarrierHome'];
  originalActionHomeHttp?: boolean;
  readRawMachineAdmission?: (payload: Readonly<{ machineId: string; method: string; params: unknown; token?: string }>) => Promise<NonNullable<RpcRequest['machineAdmission']>>;
  prepareActiveServerDirectory?: Parameters<typeof composeBindChildSourcePhaseTestRuntime>[0]['prepareActiveServerDirectory'];
}>) {
  const { role, socketIo } = options;
  const sourceCustodianAccountId = options.sourceCustodianAccountId ?? 'requester';
  const accountMode = options.accountMode ?? 'plain';
  const targetCustodianAccountId = options.targetCustodianAccountId ?? 'member-a';
  const targetResourceMode = options.targetResourceMode ?? 'plain';
  const targetSecret = tweetnacl.randomBytes(32);
  const installedOwnerE2ee = targetCustodianAccountId === sourceCustodianAccountId && targetResourceMode === 'e2ee';
  const installedCredentials: StoredCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: sourceCustodianAccountId })).toString('base64url')}.signature`,
    encryption: installedOwnerE2ee ? { type: 'legacy', secret: targetSecret } : null };
  const sourceResourceMode = installedOwnerE2ee ? 'e2ee' as const : 'plain' as const;
  const sourceMaterial = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(targetSecret) };
  const sourcePublicKey = tweetnacl.box.keyPair.fromSecretKey(sourceMaterial.machineKey).publicKey;
  const sourceResourceKey = installedOwnerE2ee ? createMachineDataEncryptionKeyV1({ material: sourceMaterial,
    dataKeyPublicKey: sourcePublicKey, randomBytes: tweetnacl.randomBytes }) : null;
  let preparation: ReturnType<typeof createAgentIsolationMemberPreparationBoundary> | undefined;
  let workspaceRoot = '';
  let memberReads = 0;
  const agentIsolation: HostAgentIsolationLaunchContext = {
    managedHappierBinaryPath: '/opt/happier/cli/current/happier',
    read: () => role === 'use' ? ({ enabled: true, memberProvisioning: 'linuxUsersV1',
      status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [workspaceRoot] })
      : ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }),
    readMember: async input => { memberReads++; if (!preparation) throw new Error('Native member fixture is not ready'); return preparation.members.read(input); },
    prepareMember: async input => {
      if (!preparation) throw new Error('Native member fixture is not ready');
      const result = await preparation.members.prepare(input);
      if (result.kind !== 'ready') throw new Error('Native member preparation refused');
      return result;
    },
  };
  let workspaceSyncService: ApiMachineClientLifecycleDependencies['workspaceSync'];
  const installed = await createInstalledFilesystemMachineFixture({ agentIsolation, credentials: installedCredentials,
    accountId: sourceCustodianAccountId,
    readWorkspaceSync: () => workspaceSyncService,
    ...(sourceResourceKey ? { machineEncryption: { encryptionKey: sourceResourceKey.encryptionKey, encryptionVariant: 'dataKey' } } : {}),
    readAdditionalHttpResponse: async url => {
      if (!installedOwnerE2ee) return undefined;
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'e2ee', version: 1,
        signingKeyFingerprint: 'fixture-signing', contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(
          tweetnacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(targetSecret)).publicKey), updatedAt: 1 } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: 0,
        content: prepareAccountSettingsV2Content({ credentials: installedCredentials, raw: {}, envelopeKind: 'encrypted' }) } };
      return undefined;
    } });
  const identity = { kind: 'isolated' as const, separationRequired: true, homeServerIdentityId: installed.homeServerIdentityId,
    requester: { serverId: installed.homeServerIdentityId, accountId: 'member-a', machineId: installed.machineId,
      installationId: installed.installation.installationId } };
  const member = deriveAgentIsolationMemberIdentity(identity);
  workspaceRoot = member.workspaceRoot;
  preparation = createAgentIsolationMemberPreparationBoundary({ activeServerDir: configuration.activeServerDir,
    requesterIdentity: identity, custodianAccountId: sourceCustodianAccountId, encryptionMode: 'plain', uid: 2401 });
  for (const step of buildAgentIsolationProvisioningSteps({ requesterIdentity: identity, daemonUsername: 'happier',
    daemonPrimaryGroup: 'happier', binaryPath: agentIsolation.managedHappierBinaryPath! })) preparation.installed.add(step.id);
  const backing = join(installed.directory, 'member-home'), workspaceBacking = join(installed.directory, 'member-workspace');
  await mkdir(backing); await mkdir(workspaceBacking);
  native.mounts = [
    { path: member.home, backing, uid: 2401, gid: 2401, mode: 0o40700 },
    { path: member.workspaceRoot, backing: workspaceBacking, uid: 2401, gid: 1001, mode: 0o42770 },
  ];
  native.accountLookups.set(JSON.stringify(['--service=files', 'passwd', member.username]),
    `${member.username}:x:2401:2401:${member.ownershipMarker}:${member.home}:/usr/sbin/nologin\n`);
  native.accountLookups.set(JSON.stringify(['--service=files', 'group', member.username]), `${member.username}:x:2401:\n`);
  native.accountLookups.set(JSON.stringify(['--service=files', 'group', 'happier']), 'happier:x:1001:\n');
  await writeAgentIsolationMemberBinding(configuration.activeServerDir, { ...member, agentUid: 2401, agentGid: 2401 });
  native.launch = async (input, output) => {
    native.phases.push('native_frame_read_started');
    const frame = await readAgentLaunchFrame(input);
    native.phases.push('native_frame_read_completed');
    expect(frame.nativeIdentity?.agentUid).toBe(2401);
    await runWorkspaceEffectWorker([], { input, output, signal: new AbortController().signal,
      currentDirectory: () => member.workspaceRoot });
  };
  const rows: ProjectAccountRowV1[] = [];
  const custodianRows: ProjectAccountRowV1[] = sourceCustodianAccountId === 'member-a' ? rows : [];
  const targetAccountRows: ProjectAccountRowV1[] = [createPlainProjectAccountRefRow({ id: 'target-custodian-private-ref',
    serverId: installed.homeServerIdentityId, machineId: 'target-parent',
    rootPath: join(installed.directory, 'target-custodian-private'), createdAtMs: 1 })];
  const targetAccountRowRequests: string[] = [];
  let requesterProjectionReads = 0;
  const requesterMachineAuthorityReads: string[] = [];
  const requesterRowRequests: Array<Readonly<{ path: string; body: unknown }>> = [];
  const requesterRows = createProjectAccountRowsHttpBoundary(rows), ownerRows = createProjectAccountRowsHttpBoundary(custodianRows);
  const targetRows = createProjectAccountRowsHttpBoundary(targetAccountRows);
  const requesterRoots = new Map<string, NonNullable<RpcHandlerContext['callerInputAuthorization']>>();
  const approvalArtifacts = new Map<string, Readonly<{ id: string }> & Record<string, unknown>>();
  const secret = tweetnacl.randomBytes(32);
  const credentials: StoredCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'member-a',
    ...(options.originalActionHomeHttp ? { tokenEpoch: 0, provenance: { v: 1, kind: 'account', authority: 'present_user' } } : {}) })).toString('base64url')}.signature`,
    encryption: accountMode === 'e2ee' ? { type: 'legacy', secret } : null };
  const targetCredentials: StoredCredentials = targetCustodianAccountId === 'member-a' ? credentials
    : targetCustodianAccountId === sourceCustodianAccountId ? installed.bootstrap.credentials : {
    token: `e30.${Buffer.from(JSON.stringify({ sub: targetCustodianAccountId })).toString('base64url')}.signature`,
    encryption: targetResourceMode === 'e2ee' ? { type: 'legacy', secret: targetSecret } : null };
  const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
  const targetMaterial = targetCustodianAccountId === 'member-a' ? material
    : { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(targetSecret) };
  const targetResourceKey = targetResourceMode === 'e2ee' ? createMachineDataEncryptionKeyV1({
    material: targetMaterial, dataKeyPublicKey: tweetnacl.box.keyPair.fromSecretKey(targetMaterial.machineKey).publicKey,
    randomBytes: tweetnacl.randomBytes }) : null;
  const targetMetadata = { host: 'target', platform: 'linux', homeDir: installed.directory,
    happyCliVersion: 'test', happyHomeDir: installed.directory };
  const sourceMetadata = { host: 'source', platform: 'linux', homeDir: installed.directory,
    happyCliVersion: 'test', happyHomeDir: installed.directory };
  const sourceResource = sourceResourceKey ? { encryptionKey: sourceResourceKey.encryptionKey,
    ownerDataEncryptionKey: encodeBase64(sourceResourceKey.dataEncryptionKey), ownerPublicKey: sourcePublicKey,
    requesterPublicKey: tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey,
    requesterDataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: sourceResourceKey.encryptionKey,
      recipientPublicKey: tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey, randomBytes: tweetnacl.randomBytes })),
    metadata: encodeBase64(encrypt(sourceResourceKey.encryptionKey, 'dataKey', sourceMetadata)) } : null;
  const targetResource = targetResourceKey ? { encryptionKey: targetResourceKey.encryptionKey,
    ownerDataEncryptionKey: encodeBase64(targetResourceKey.dataEncryptionKey),
    ownerPublicKey: tweetnacl.box.keyPair.fromSecretKey(targetMaterial.machineKey).publicKey,
    requesterPublicKey: tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey,
    requesterDataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: targetResourceKey.encryptionKey,
      recipientPublicKey: tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey, randomBytes: tweetnacl.randomBytes })),
    metadata: encodeBase64(encrypt(targetResourceKey.encryptionKey, targetResourceKey.encryptionVariant, targetMetadata)) } : null;
  const rowCipher = createProjectAccountRowCipherV1({ mode: accountMode,
    material: accountMode === 'e2ee' ? { type: 'legacy', secret } : null, randomBytes: tweetnacl.randomBytes });
  const createRequesterRefRow = (ref: Parameters<typeof createPlainProjectAccountRefRow>[0]) => {
    const row = createPlainProjectAccountRefRow(ref);
    if (!row.content || row.content.t !== 'plain') throw new Error('Expected initial plain fixture row');
    return { ...row, content: rowCipher.seal(row.content.v) };
  };
  const settings = prepareAccountSettingsV2Content({ credentials, raw: {}, envelopeKind: accountMode === 'e2ee' ? 'encrypted' : 'plain' });
  const originalHomePost = vi.mocked(axios.post).getMockImplementation();
  const selectedRoot = role === 'use' ? member.workspaceRoot : installed.directory;
  const sourcePath = join(selectedRoot, 'source-parent-ref');
  const targetPath = join(options.remoteTarget ? installed.directory : selectedRoot, 'target-parent-ref');
  const targetKeys = tweetnacl.sign.keyPair();
  const targetInstallation = { version: 1 as const, createdAt: 1, installationId: 'target-parent-installation',
    publicKey: Buffer.from(targetKeys.publicKey).toString('base64url'), privateKey: Buffer.from(targetKeys.secretKey).toString('base64url') };
  const machineBootstrap = (target: boolean) => ExternalActionMachineBootstrapV1Schema.parse({
    id: target ? 'target-parent' : installed.machineId, active: true, kind: 'persistent',
    revokedAt: null, replacedByMachineId: null, managedMachineRef: null,
    installationId: target ? targetInstallation.installationId : installed.installation.installationId,
    access: { custodian: { accountId: target ? targetCustodianAccountId : sourceCustodianAccountId, displayName: 'Custodian' },
      role: target ? 'manage' : role, resourceMode: target ? targetResourceMode : sourceResourceMode, accessState: 'ready' },
  });
  const targetRpcDiagnostics: Array<Readonly<{ message: string; data?: unknown }>> = [];
  const seedRequests: Parameters<typeof authorizeMachineRpcRequest>[0][] = [];
  let targetRpc: RpcHandlerManager | undefined;
  let sourceRpc: RpcHandlerManager | undefined;
  const targetMachine = options.remoteTarget && options.remoteSeed
    ? runWithServerHttpBaseUrl(installed.serverHttpBaseUrl, () => new ApiMachineClient(targetCredentials.token, {
      id: 'target-parent', ...(targetResource ? { encryptionMode: 'e2ee' as const,
        encryptionKey: targetResource.encryptionKey, encryptionVariant: 'dataKey' as const } : { encryptionMode: 'plain' as const }),
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    })) : undefined;
  if (targetMachine) Reflect.set(targetMachine, 'socket', createApiSessionSocketStub({ connected: true,
    emitWithAck: async (event, payload) => {
      if (event !== 'rpc-call') return resolveApiSessionSocketDefaultAck(event, payload);
      if (!payload || typeof payload !== 'object' || !('workspaceSyncSeedRouting' in payload)
        || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)
        || !('requestId' in payload) || typeof payload.requestId !== 'string' || !('externalActionExecution' in payload)) {
        throw new Error('Incomplete signed seed packet');
      }
      const routing = WorkspaceSyncSeedRoutingV1Schema.parse(payload.workspaceSyncSeedRouting);
      const signed = ExternalActionMachineRpcExecutionV1Schema.parse(payload.externalActionExecution);
      expect(verifyExternalActionMachineRpcRequestV1({ publicKey: targetInstallation.publicKey,
        signature: signed.machineSignature, authorizationToken: signed.authorization.token,
        effectActionId: signed.effectActionId, target: signed.target, installationId: signed.installationId,
        method: payload.method, requestId: payload.requestId, params: payload.params, workspaceSyncSeedRouting: routing })).toBe(true);
      const sourceContext = routing.sourceWriterTarget.source.sourceContext;
      if (!sourceRpc || !sourceContext) throw new Error('Installed SOURCE receiver is unavailable');
      if (options.forwardHomeRpc) return options.forwardHomeRpc(payload, packet =>
        requesterWorkspaceSyncTargetInstallationFiles.run({ path: configuration.installationIdentityFile,
          identity: JSON.stringify(installed.installation) }, () => sourceRpc!.handleRequest(packet, undefined, 'authenticated_home_socket')));
      const received: RpcRequest = { ...payload,
        method: payload.method as string, params: payload.params, workspaceSyncSeedRouting: routing,
        callerInputAuthorization: signed.authorization, machineAdmission: sourceContext.machineAdmission,
        callerAuthority: sourceContext.callerAuthority, sessionActionOrigin: sourceContext.sessionActionOrigin,
        callerInputConstraints: sourceContext.callerInputConstraints };
      const result = await requesterWorkspaceSyncTargetInstallationFiles.run({ path: configuration.installationIdentityFile,
        identity: JSON.stringify(installed.installation) }, () => sourceRpc.handleRequest(received));
      return { ok: true, result };
    } }));
  const homeActionRequests: ReturnType<typeof ExternalActionDaemonDispatchRequestSchema.parse>[] = [];
  const adoptHomeAuthorization = (value: unknown) => {
    const wire = ExternalActionExecutionAuthorizationV1Schema.parse(value);
    requesterRoots.set(wire.token, wire);
    return wire;
  };
  const createHomeAuthorization = (envelope: ExternalActionRequestEnvelope, token = 'member-sync-root') => {
    return adoptHomeAuthorization({ v: 1, token, binding: {
      accountId: 'member-a', custodianAccountId: sourceCustodianAccountId, serverIdentityId: installed.homeServerIdentityId,
      machineId: installed.machineId, installationId: installed.installation.installationId,
      actionId: 'workspace.sync.relationship.create', accountEncryptionMode: accountMode, admittedMachineRole: role,
      authentication: { kind: 'account', tokenEpoch: 0 }, requestId: envelope.requestId,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target } });
  };
  // Authenticated Home forwards the verified source root beside its physical
  // receiving admission. Keep that network projection, including its signature.
  const relayedRequester = (payload: unknown) => {
    if (!payload || typeof payload !== 'object' || !('externalActionExecution' in payload)) return undefined;
    const execution = ExternalActionMachineRpcExecutionV1Schema.parse(payload.externalActionExecution);
    if (!('method' in payload) || typeof payload.method !== 'string' || !('requestId' in payload)
      || typeof payload.requestId !== 'string' || !('params' in payload) || !('workspaceSyncSourceWriterTargetRouting' in payload)) {
      throw new Error('Incomplete signed physical Sync packet');
    }
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(payload.workspaceSyncSourceWriterTargetRouting);
    expect(verifyExternalActionMachineRpcRequestV1({ publicKey: installed.installation.publicKey,
      signature: execution.machineSignature, authorizationToken: execution.authorization.token,
      effectActionId: execution.effectActionId, target: execution.target, installationId: execution.installationId,
      method: payload.method, requestId: payload.requestId, params: payload.params,
      workspaceSyncSourceWriterTargetRouting: routing })).toBe(true);
    return execution.authorization;
  };
  if (options.remoteTarget) Reflect.set(installed.machine, 'socket', createApiSessionSocketStub({ connected: true,
    emitWithAck: async (event, payload) => {
      if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
        expect(MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.parse(payload).machineId).toBe(installed.machineId);
        return MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse({ v: 1, result: 'success', revision: 1 });
      }
      if (event !== 'rpc-call') return resolveApiSessionSocketDefaultAck(event, payload);
      if (!targetRpc || !payload || typeof payload !== 'object' || !('method' in payload)
        || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Missing physical target receiver');
      if (options.forwardHomeRpc) return options.forwardHomeRpc(payload, packet =>
        requesterWorkspaceSyncTargetInstallationFiles.run({ path: configuration.installationIdentityFile,
          identity: JSON.stringify(targetInstallation) }, () => targetRpc!.handleRequest(packet, undefined, 'authenticated_home_socket')));
      const routing = 'workspaceSyncSourceWriterTargetRouting' in payload
        ? WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(payload.workspaceSyncSourceWriterTargetRouting) : undefined;
      const sourceContext = routing?.source.sourceContext;
      // Home admits root-free cleanup as the authenticated installed SOURCE writer.
      // It forwards that admission to the retained TARGET endpoint, not a new B root.
      const installedWriterRelease = routing?.target.phase === 'release' && !('externalActionExecution' in payload);
      if (installedWriterRelease) {
        expect(routing.sourceWriter).toEqual({ machineId: installed.machineId,
          installationId: installed.installation.installationId });
      }
      const incoming: RpcRequest = { ...payload, method: payload.method, params: payload.params,
        callerInputAuthorization: relayedRequester(payload),
        machineAdmission: installedWriterRelease ? { actorAccountId: sourceCustodianAccountId, custodianAccountId: sourceCustodianAccountId,
          machineId: installed.machineId, installationId: installed.installation.installationId,
          role: 'manage', encryptionMode: sourceResourceMode } : {
          actorAccountId: 'member-a', custodianAccountId: targetCustodianAccountId, machineId: 'target-parent',
          installationId: targetInstallation.installationId, role: 'manage', encryptionMode: targetResourceMode },
        callerAuthority: sourceContext?.callerAuthority ?? 'present_user',
        sessionActionOrigin: sourceContext?.sessionActionOrigin, callerInputConstraints: sourceContext?.callerInputConstraints };
      const root = incoming.callerInputAuthorization;
      if (routing && root) targetRpcDiagnostics.push({ message: 'Physical receiver root binding', data: {
        sourceRootMatches: doesWorkspaceSyncSourceRootMatchRouting(root, routing.source),
        targetRootMatches: doesWorkspaceSyncSourceWriterTargetRootMatchRouting(root, routing, incoming.machineAdmission),
        authorityMatches: routing.source.sourceContext.callerAuthority === incoming.callerAuthority,
        sessionOriginMatches: isDeepStrictEqual(routing.source.sourceContext.sessionActionOrigin, incoming.sessionActionOrigin),
        constraintsMatch: isDeepStrictEqual(routing.source.sourceContext.callerInputConstraints, incoming.callerInputConstraints),
        sourceAuthority: routing.source.sourceContext.callerAuthority, receiverAuthority: incoming.callerAuthority,
      } });
      const response = options.readTargetRpcResponse?.({ method: payload.method, params: payload.params });
      if (response !== undefined) return { ok: true, result: response };
      const result = await requesterWorkspaceSyncTargetInstallationFiles.run({ path: configuration.installationIdentityFile,
        identity: JSON.stringify(targetInstallation) }, () => installedWriterRelease
          ? targetRpc!.handleRequest(incoming, undefined, 'authenticated_home_socket')
          : targetRpc!.handleRequest(incoming));
      options.afterTargetRpcResponse?.({ method: payload.method, params: payload.params });
      return { ok: true, result };
    } }));
  const sourceSocket = Reflect.get(installed.machine, 'socket');
  const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, withScmRuntime: true, projectRowsFromHttp: true,
    ...(options.nativeCarrierHome ? { nativeCarrierHome: options.nativeCarrierHome } : {}),
    serverId: installed.homeServerIdentityId, profileId: installed.serverId, managedHomeId: installed.homeServerIdentityId,
    ...(options.prepareActiveServerDirectory ? { prepareActiveServerDirectory: options.prepareActiveServerDirectory } : {}),
    credentials: installed.bootstrap.credentials, sourceMachineId: installed.machineId, sourcePath, targetPath,
    sourceAccountIncludesTargetRefs: sourceCustodianAccountId === 'member-a',
    ...(options.remoteTarget ? { separateTargetParent: true, targetCredentials,
      ...(options.remoteSeed ? { remoteSeed: true } : {}),
      ...(targetMachine ? { callWorkspaceSeedExport: async (descriptor, context) => {
        try {
          return await targetMachine.callWorkspaceSyncSeedExport({ ...descriptor, credentials: targetCredentials,
            context: buildActionExecutorContextForRpc({ ...context, serverId: installed.serverId }) });
        } catch (error) {
          targetRpcDiagnostics.push({ message: 'Seed transport failure', data: error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack, code: readRpcErrorCode(error) } : { name: 'UnknownThrownValue' } });
          throw error;
        }
      } } : {}),
      callWorkspaceTargetPhase: (descriptor, context) => {
        targetRpcDiagnostics.push({ message: 'Source target-phase descriptor', data: { method: descriptor.method,
          originalEnvelopePresent: context?.workspaceSyncSourceRouting?.originalActionEnvelope !== undefined,
          sourceRootMatches: context?.callerInputAuthorization && context.workspaceSyncSourceRouting
            ? doesWorkspaceSyncSourceRootMatchRouting(context.callerInputAuthorization, context.workspaceSyncSourceRouting) : null,
          writerRootMatches: context?.callerInputAuthorization && context.workspaceSyncSourceRouting
            ? doesWorkspaceSyncSourceWriterTargetRootMatchRouting(context.callerInputAuthorization, { v: 1,
              source: context.workspaceSyncSourceRouting, target: descriptor.routing,
              sourceWriter: { machineId: installed.machineId, installationId: installed.installation.installationId } }) : null,
          methodMatches: descriptor.method === readWorkspaceSyncTargetMethod(descriptor.routing.phase),
          requestMatches: context?.workspaceSyncSourceRouting?.sourceContext ? doesWorkspaceSyncTargetRequestMatchRouting(
            descriptor.request, { ...descriptor.routing, targetContext: context.workspaceSyncSourceRouting.sourceContext }) : null } });
        return installed.machine.callWorkspaceSyncTargetPhase({ ...descriptor,
          credentials: installed.bootstrap.credentials, context: buildActionExecutorContextForRpc({ ...context,
            serverId: installed.serverId }) });
      } } : {}),
    privateCheckout: { prepareNativeOperation: async input => {
      native.phases.push('native_prepare_started');
      try { return await installed.machine.prepareNativeOperation(input); }
      finally { native.phases.push('native_prepare_settled'); }
    } }, agentIsolation,
    requesterMachineAdmissionBoundary: { machineId: installed.machineId, daemonToken: installed.bootstrap.credentials.token,
      isHomeCurrent: installed.isHomeCurrent, readInstallation: () => installed.installation },
    handleAdditionalSocketAck: async (payload, token) => {
      if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) return undefined;
      rpcDiagnostics.push({ message: 'Machine socket ACK method', data: { method: payload.method } });
      const approval = payload.method === `${installed.machineId}:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`
        || payload.method === `${installed.machineId}:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`;
      const target = payload.method.startsWith('target-parent:') ? targetRpc : payload.method.startsWith(`${installed.machineId}:`)
        ? approval ? installed.rpcHandlerManager : sourceRpc : undefined;
      if (!target) return undefined;
      const isTarget = target === targetRpc;
      const response = isTarget ? options.readTargetRpcResponse?.({ method: payload.method, params: payload.params }) : undefined;
      if (response !== undefined) return { ok: true, result: response };
      const request: RpcRequest = { ...payload, method: payload.method, params: payload.params,
        machineAdmission: options.readRawMachineAdmission ? await options.readRawMachineAdmission({ machineId: isTarget ? 'target-parent' : installed.machineId, method: payload.method, params: payload.params, token }) : { actorAccountId: 'member-a', custodianAccountId: isTarget ? targetCustodianAccountId : sourceCustodianAccountId,
          machineId: isTarget ? 'target-parent' : installed.machineId, installationId: isTarget ? targetInstallation.installationId : installed.installation.installationId,
          role: isTarget ? 'manage' : role, encryptionMode: isTarget ? targetResourceMode : sourceResourceMode }, callerAuthority: 'present_user' };
      const result = isTarget ? await requesterWorkspaceSyncTargetInstallationFiles.run({ path: configuration.installationIdentityFile,
        identity: JSON.stringify(targetInstallation) }, () => target.handleRequest(request)) : await target.handleRequest(request);
      if (isTarget) options.afterTargetRpcResponse?.({ method: payload.method, params: payload.params });
      return { ok: true, result };
    },
    readAdditionalHttpResponse: async (url, config) => {
      if (options.originalActionHomeHttp && new URL(url).pathname === '/v1/machines') return { status: 200,
        data: [machineBootstrap(false), machineBootstrap(true)] };
      const artifactPath = new URL(url).pathname;
      if (artifactPath.startsWith('/v1/artifacts/')) {
        const row = approvalArtifacts.get(artifactPath.split('/')[3]!);
        return { status: row ? 200 : 404, data: row ?? {} };
      }
      const bearer = config?.headers?.Authorization;
      const requester = typeof bearer === 'string' && bearer.startsWith('Bearer ')
        && readAccountIdFromToken(bearer.slice(7)) === 'member-a';
      if (requester && (url.endsWith('/v1/account/profile') || url.endsWith('/v1/machines/machine'))
        && new Error().stack?.includes('readRequesterMachineAdmissionCurrent')) requesterMachineAuthorityReads.push(new URL(url).pathname);
      const targetAccount = config?.headers?.Authorization === `Bearer ${targetCredentials.token}`;
      const selectedMode = requester ? accountMode : targetAccount ? targetResourceMode : 'plain';
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: selectedMode, updatedAt: 1 } };
      if (url.endsWith('/v1/machines/target-parent')) return { status: 200, data: { machine: {
        ...machineBootstrap(true),
        id: 'target-parent', active: true, managedMachineRef: null, installationId: targetInstallation.installationId,
        installationPublicKey: Buffer.from(targetInstallation.publicKey, 'base64url').toString('base64'),
        dataEncryptionKey: targetResource ? requester ? targetResource.requesterDataEncryptionKey : targetResource.ownerDataEncryptionKey : MACHINE_PLAIN_DATA_KEY_MARKER,
        access: { custodian: { accountId: targetCustodianAccountId, displayName: 'Target custodian' }, role: 'manage',
          resourceMode: targetResourceMode, accessState: 'ready' }, metadataVersion: 1, daemonStateVersion: 0, daemonState: null,
        metadata: targetResource?.metadata ?? encodePlainMachineStoredContent(targetMetadata),
      } } };
      if (url.endsWith('/v1/machines/machine')) return { status: 200, data: { machine: {
        ...machineBootstrap(false),
        id: installed.machineId, active: true, managedMachineRef: null, installationId: installed.installation.installationId,
        installationPublicKey: Buffer.from(installed.installation.publicKey, 'base64url').toString('base64'),
        dataEncryptionKey: sourceResource ? requester ? sourceResource.requesterDataEncryptionKey : sourceResource.ownerDataEncryptionKey : MACHINE_PLAIN_DATA_KEY_MARKER,
        access: { custodian: { accountId: sourceCustodianAccountId, displayName: 'Custodian' }, role: requester ? role : 'manage',
          resourceMode: sourceResourceMode, accessState: 'ready' }, metadataVersion: 1, daemonStateVersion: 0, daemonState: null,
        metadata: sourceResource?.metadata ?? encodePlainMachineStoredContent(sourceMetadata),
      } } };
      return url.endsWith('/v1/account/profile') ? { status: 200, data: {
        id: requester ? 'member-a' : config?.headers?.Authorization === `Bearer ${targetCredentials.token}` ? targetCustodianAccountId : sourceCustodianAccountId } }
        : url.endsWith('/v2/account/settings') ? { status: 200, data: { content: requester ? settings : targetAccount
          ? prepareAccountSettingsV2Content({ credentials: targetCredentials, raw: {}, envelopeKind: targetResourceMode === 'e2ee' ? 'encrypted' : 'plain' })
          : prepareAccountSettingsV2Content({ credentials: installed.bootstrap.credentials, raw: {}, envelopeKind: 'plain' }), version: 1 } }
        : url.endsWith('/v1/account/encryption/currentness') ? { status: 200, data: { mode: selectedMode, version: 1,
          signingKeyFingerprint: selectedMode === 'e2ee' ? 'fixture-signing' : null,
          contentKeyFingerprint: selectedMode === 'e2ee' ? computeAccountEncryptionMigrateKeyFingerprintV1(
            tweetnacl.box.keyPair.fromSecretKey(requester ? material.machineKey : targetMaterial.machineKey).publicKey) : null, settingsVersion: 1, updatedAt: 1 } } : undefined;
    },
    readAdditionalHttpPostResponse: async (url, body, config) => {
      const home = await options.readHomePost?.(url, body, config);
      if (home !== undefined) return home;
      const artifactPath = new URL(url).pathname;
      if (options.originalActionHomeHttp && (artifactPath === '/v1/actions/workspace.sync.relationship.create/execution-authorization'
        || artifactPath === '/v1/actions/workspace.sync.relationship.create')) {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        if (artifactPath.endsWith('/execution-authorization')) return { status: 200,
          data: createHomeAuthorization(request.envelope, `member-sync-root-${request.envelope.requestId}`) };
        const dispatch = ExternalActionDaemonDispatchRequestSchema.parse({ actionId: 'workspace.sync.relationship.create',
          envelope: request.envelope, executionAuthorization: request.executionAuthorization,
          principal: { accountId: 'member-a', authentication: { kind: 'account', tokenEpoch: 0 },
            authority: config?.headers?.[AUTHORITY_CEILING_HEADER_V1] === 'account_automation' ? 'account_automation' : 'present_user' },
          placement: { machineId: installed.machineId, target: request.envelope.target } });
        homeActionRequests.push(dispatch);
        const received = await installed.rpcHandlerManager.handleRequest({
          method: `${installed.machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`, params: dispatch,
          authorization: ACTION_API_SERVER_ORIGIN, machineAdmission: { actorAccountId: 'member-a',
            custodianAccountId: sourceCustodianAccountId, machineId: installed.machineId,
            installationId: installed.installation.installationId, role, encryptionMode: sourceResourceMode } });
        const result = parseExternalActionDaemonDispatchResultV1(received);
        if (result?.kind !== 'response') throw new Error(`Original Home Action receiver refused: ${readRpcErrorCode(received) ?? result?.kind ?? 'invalid_response'}`);
        return { status: 200, data: result.prepared.response };
      }
      if (artifactPath === '/v1/artifacts/read') return artifactReadResponse(body, id => approvalArtifacts.get(id) ?? null);
      if (artifactPath === '/v1/artifacts' || artifactPath.startsWith('/v1/artifacts/')) {
        const mutation = readCarrierMutation(body);
        const id = typeof mutation.id === 'string' ? mutation.id : artifactPath.split('/')[3]!;
        const previous = approvalArtifacts.get(id);
        const version = Number(previous?.bodyVersion ?? 0) + 1;
        const bearer = config?.headers?.Authorization;
        const ownerAccountId = typeof bearer === 'string' && bearer.startsWith('Bearer ')
          && readAccountIdFromToken(bearer.slice(7)) === 'member-a' ? 'member-a' : sourceCustodianAccountId;
        approvalArtifacts.set(id, { ...previous, ...mutation, id, ownerAccountId, access: 'owner', publicAudience: 'none',
          encryptionMode: ownerAccountId === 'member-a' ? accountMode : sourceResourceMode,
          headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version });
        return { status: 200, data: { id, success: true, headerVersion: version, bodyVersion: version } };
      }
      if (options.remoteTarget && url.endsWith('/v1/machines/machine/admission/verify')
        && body && typeof body === 'object' && 'proof' in body
        && ('workspaceSyncSourceWriterTargetRouting' in body || 'workspaceSyncSeedRouting' in body)) {
        const { proof, ...wirePurpose } = body;
        const { v: _version, ...rpcAdmission } = wirePurpose as Record<string, unknown>;
        const ok = verifyMachineInstallationProof({ publicKey: installed.installation.publicKey,
          proof: MachineInstallationProofV1Schema.parse(proof), payload: MachineInstallationProofPayloadV1Schema.parse({
            version: 1, accountId: sourceCustodianAccountId, machineId: installed.machineId,
            installationId: installed.installation.installationId, rpcAdmission }) });
        return { status: ok ? 200 : 403, data: ok ? { v: 1, ok: true,
          destinationInstallation: 'workspaceSyncSeedRouting' in body
            ? { machineId: installed.machineId, installationId: installed.installation.installationId,
              installationPublicKey: installed.installation.publicKey }
            : { machineId: 'target-parent', installationId: targetInstallation.installationId,
              installationPublicKey: targetInstallation.publicKey } } : { error: 'access_denied' } };
      }
      if (url.endsWith('/v1/machines/machine/admission/verify') && originalHomePost) return originalHomePost(url, body, config);
      if (options.remoteTarget && url.endsWith('/v1/machines/target-parent/admission/verify') && body && typeof body === 'object'
        && 'proof' in body) {
        const { proof, ...wirePurpose } = body;
        const { v: _version, ...rpcAdmission } = wirePurpose as Record<string, unknown>;
        const ok = verifyMachineInstallationProof({ publicKey: targetInstallation.publicKey,
          proof: MachineInstallationProofV1Schema.parse(proof), payload: MachineInstallationProofPayloadV1Schema.parse({ version: 1,
            machineId: 'target-parent', installationId: targetInstallation.installationId, accountId: targetCustodianAccountId, rpcAdmission }) });
        return { status: ok ? 200 : 403, data: ok ? { v: 1, ok: true,
          ...('workspaceSyncSeedRouting' in body ? { destinationInstallation: { machineId: installed.machineId,
            installationId: installed.installation.installationId, installationPublicKey: installed.installation.publicKey } } : {})
        } : { error: 'access_denied' } };
      }
      const path = new URL(url).pathname;
      if (path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1('workspace.sync.relationship.create')) {
        const signature = config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
        const token = config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER];
        const root = typeof token === 'string' ? requesterRoots.get(token) : undefined;
        const ok = root
          && config?.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER] === 'workspace.sync.relationship.create'
          && typeof signature === 'string' && verifyExternalActionMachineRequestV1({
            publicKey: installed.installation.publicKey, signature, authorizationToken: root.token,
            effectActionId: 'workspace.sync.relationship.create', target: { kind: 'machine', machineId: installed.machineId },
            installationId: installed.installation.installationId, requestId: root.binding.requestId, method: 'POST', path, body });
        return { status: ok ? 200 : 403, data: ok ? { ok: true } : { error: 'access_denied' } };
      }
      if (!url.includes('/v1/account/project-rows/')) return undefined;
      if (targetCustodianAccountId !== 'member-a' && targetCustodianAccountId !== sourceCustodianAccountId
        && config?.headers?.Authorization === `Bearer ${targetCredentials.token}`) {
        targetAccountRowRequests.push(new URL(url).pathname);
        return targetRows(url, body);
      }
      // Signed Action HTTP projections carry the requester's original root;
      // they deliberately do not disclose the requester's bearer credential.
      const rootToken = config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER];
      const root = typeof rootToken === 'string' ? requesterRoots.get(rootToken) : undefined;
      const signature = config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
      const effectActionId = config?.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER];
      const signedRequester = root && typeof signature === 'string' && typeof effectActionId === 'string' && verifyExternalActionMachineRequestV1({
        publicKey: installed.installation.publicKey, signature, authorizationToken: root.token,
        effectActionId, target: root.binding.target,
        installationId: installed.installation.installationId, requestId: root.binding.requestId,
        method: 'POST', path: new URL(url).pathname, body });
      const bearer = config?.headers?.Authorization;
      const requester = (typeof bearer === 'string' && bearer.startsWith('Bearer ')
        && readAccountIdFromToken(bearer.slice(7)) === 'member-a')
        || signedRequester === true;
      if (requester) requesterRowRequests.push({ path: new URL(url).pathname, body });
      if (requester && url.endsWith('/list')) {
        requesterProjectionReads++;
      }
      return requester ? requesterRows(url, body) : ownerRows(url, body);
    },
  });
  if (options.remoteTarget) {
    if (!fixture.targetParent) throw new Error('Physical target runtime is unavailable');
    targetRpc = new RpcHandlerManager({ scopePrefix: 'target-parent', localMachineId: 'target-parent', scopeKind: 'machine',
      ...(targetResource ? { encryptionMode: 'e2ee' as const, encryptionKey: targetResource.encryptionKey, encryptionVariant: 'dataKey' as const }
        : { encryptionMode: 'plain' as const }), logger: (message, data) => { targetRpcDiagnostics.push({ message, data }); }, authorizeRequest: async (request, source) => {
        const routing = request.workspaceSyncSourceWriterTargetRouting;
        targetRpcDiagnostics.push({ message: 'Target receiver input', data: { method: request.method,
          sourceRootMatches: routing && request.callerInputAuthorization
            ? doesWorkspaceSyncSourceRootMatchRouting(request.callerInputAuthorization, routing.source) : null,
          targetRootMatches: routing && request.callerInputAuthorization
            ? doesWorkspaceSyncSourceWriterTargetRootMatchRouting(request.callerInputAuthorization, routing, request.machineAdmission) : null } });
        return authorizeMachineRpcRequest(request, {
        machineId: 'target-parent', resolveInstallationId: () => targetInstallation.installationId,
        resolveCustodianAccountId: async () => targetCustodianAccountId, resolveHomeServerIdentityId: async () => installed.homeServerIdentityId,
        verifyMachineAdmission: received => verifyMachineRpcAdmissionCurrent({ ...received,
          ...(received.workspaceSyncTargetRouting ? { workspaceSyncTargetReceiver: { machineId: 'target-parent',
            installationId: targetInstallation.installationId } } : {}),
          privateKey: targetInstallation.privateKey, daemonToken: targetCredentials.token, serverHttpBaseUrl: installed.serverHttpBaseUrl }),
      }, source);
      } });
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: targetRpc, service: fixture.targetParent.workspaceSync });
  }
  await mkdir(targetPath);
  const targetRef = options.workerCleanCopy ? materializeWorkspaceRefForMachineRoot([fixture.sourceRef], {
    serverId: fixture.sourceRef.serverId, machineId: fixture.targetRef.machineId, rootPath: targetPath,
    parentWorkspace: { serverId: fixture.sourceRef.serverId, workspaceId: fixture.sourceRef.id,
      machineId: fixture.sourceRef.machineId, rootPath: sourcePath },
    nowMs: 1, createId: () => fixture.targetRef.id,
  }).workspaceRef : fixture.targetRef;
  rows.push(createRequesterRefRow(fixture.sourceRef), createRequesterRefRow(targetRef));
  const custodianRef = { ...fixture.sourceRef, id: 'custodian-private-ref', rootPath: join(installed.directory, 'custodian-private') };
  custodianRows.push(createPlainProjectAccountRefRow(custodianRef));
  const custodianBefore = [...custodianRows];
  if (sourceCustodianAccountId === 'member-a') {
    await runWithServerHttpBaseUrl(installed.serverHttpBaseUrl, () => readProjectAccountRows({
      credentials: installed.bootstrap.credentials, serverId: installed.serverId, publication: 'installed' }));
  }
  if (role === 'use') {
    if (!options.remoteTarget) native.privateRoot = targetPath;
    native.privateRoots = [sourcePath];
  }
  const content = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
  const request = { v: 1 as const, operationId: 'member-sync-create', actionInput: { v: 1 as const, sourceWorkspaceRefId: fixture.sourceRef.id,
    targetMachineId: fixture.targetRef.machineId, targetPath, mode: options.workerCleanCopy ? 'mirror_exactly' : 'keep_both_in_sync',
    ...(options.workerCleanCopy ? { purpose: 'worker_clean_copy' as const } : {}), destinationIntent: 'materialize_from_source_workspace',
    contentPolicy: { ...content, policyDigest: computeWorkspaceSyncPolicyDigest(content) } } } satisfies WorkspaceSyncRelationshipCreateRpcRequestV1;
  const prepareInvocation = async (input: WorkspaceSyncRelationshipCreateRpcRequestV1, original?: Readonly<{
    envelope: ExternalActionRequestEnvelope; authorization: ExternalActionExecutionAuthorizationV1;
  }>) => {
    const invocation = WorkspaceSyncRelationshipCreateRpcRequestV1Schema.parse(input);
    const encryptionBinding = { accountId: 'member-a', serverIdentityId: installed.homeServerIdentityId,
      actionId: 'workspace.sync.relationship.create' as const, authentication: { kind: 'account' as const, tokenEpoch: 0 },
      requestId: invocation.operationId, target: { kind: 'machine' as const, machineId: installed.machineId } };
    const envelope = original?.envelope ?? (accountMode === 'e2ee' ? sealExternalActionRequestV2({ binding: encryptionBinding,
      projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, material, input: invocation.actionInput, randomBytes: tweetnacl.randomBytes })
      : { v: 1 as const, requestId: invocation.operationId, target: encryptionBinding.target, input: invocation.actionInput });
    const wire = original?.authorization ?? createHomeAuthorization(envelope);
    requesterRoots.set(wire.token, wire);
    const account = await admitRequesterAccountActionContext({ authorization: wire, credentials,
      invocation: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' } },
      serverId: installed.serverId, serverIdentityId: installed.homeServerIdentityId, serverHttpBaseUrl: installed.serverHttpBaseUrl,
      isCurrent: installed.isHomeCurrent, isRetainedCustodyCurrent: installed.isHomeCurrent });
    if (!account) throw new Error('Requester Account admission refused');
    onTestFinished(() => account.dispose());
    const sealed = sealExternalActionRequesterAccountContextV1({ authorization: wire,
      purpose: { kind: 'machine_rpc', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE, params: invocation },
      credentials: encodeStoredCredentials(credentials), installationPublicKey: Buffer.from(installed.installation.publicKey, 'base64url'),
      randomBytes: tweetnacl.randomBytes });
    const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: sealed,
      serverId: installed.serverId, serverIdentityId: installed.homeServerIdentityId, serverHttpBaseUrl: installed.serverHttpBaseUrl,
      target: wire.binding.target, installationId: installed.installation.installationId, privateKey: installed.installation.privateKey,
      rootAdmitted: true });
    if (!authorization) throw new Error('Requester signed projection refused');
    return { request: invocation, account, authorization, wire, envelope };
  };
  const { account, authorization, wire, envelope } = await prepareInvocation(request);
  // The source controller consumes the installed Account ingress itself. This
  // is the same public receiver composition as Machine RPC authorization tests;
  // no Session daemon or Action effect is needed to link Workspaces.
  const rpcDiagnostics: Array<Readonly<{ message: string; data?: unknown }>> = [];
  const authorizeSourceRequest = (request: Parameters<typeof authorizeMachineRpcRequest>[0],
    source: Parameters<typeof authorizeMachineRpcRequest>[2]) => {
    if (request.workspaceSyncSeedRouting) seedRequests.push(request);
    return authorizeMachineRpcRequest(request, {
      machineId: installed.machineId, resolveInstallationId: () => installed.installation.installationId,
      resolveCustodianAccountId: async () => sourceCustodianAccountId, resolveHomeServerIdentityId: async () => installed.homeServerIdentityId,
      verifyMachineAdmission: received => verifyMachineRpcAdmissionCurrent({ ...received,
        ...(received.workspaceSyncSeedRouting ? { workspaceSyncSeedReceiver: { machineId: installed.machineId,
          installationId: installed.installation.installationId, accountId: sourceCustodianAccountId } } : {}),
        privateKey: installed.installation.privateKey, daemonToken: installed.bootstrap.credentials.token,
        serverHttpBaseUrl: installed.serverHttpBaseUrl }),
    }, source);
  };
  const rpc = new RpcHandlerManager({ scopePrefix: installed.machineId, localMachineId: installed.machineId,
    scopeKind: 'machine',
    ...(sourceResource ? { encryptionMode: 'e2ee' as const, encryptionKey: sourceResource.encryptionKey, encryptionVariant: 'dataKey' as const } : { encryptionMode: 'plain' as const }), logger: (message, data) => { rpcDiagnostics.push({ message, data }); },
    prepareRequesterAccountContext: input => prepareInstalledRequesterAccountActionContext({ ...input,
      ownCredentials: installed.bootstrap.credentials,
      machineId: installed.machineId, serverId: installed.serverId, serverHttpBaseUrl: installed.serverHttpBaseUrl,
      isRetainedCustodyCurrent: installed.isHomeCurrent,
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: installed.machineId,
        serverIdentityId: installed.homeServerIdentityId }),
      createExecutor: () => createActionExecutor(createUnavailableActionTransportDeps()) }),
    authorizeRequest: authorizeSourceRequest });
  const diagnosticRegistrarFor = (manager: RpcHandlerManager): RpcHandlerRegistrar => ({
    registerHandler: (method, handler) => manager.registerHandler(method, async (request, context) => {
      if (method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE) {
        rpcDiagnostics.push({ message: 'Sync handler input', data: { originalEnvelopePresent: context?.originalActionEnvelope !== undefined } });
      }
      try { return await handler(request, context); }
      catch (error) {
        const causes: unknown[] = [];
        let current: unknown = error;
        while (current instanceof Error) {
          causes.push({ name: current.name, message: current.message, stack: current.stack,
            ...(current instanceof AggregateError ? { errors: current.errors.map(error => error instanceof Error
              ? { name: error.name, message: error.message, code: readRpcErrorCode(error) } : { name: 'UnknownThrownValue' }) } : {}),
            ...('code' in current ? { code: current.code } : {}) });
          current = current.cause;
        }
        rpcDiagnostics.push({ message: 'Sync handler failure', data: causes });
        throw error;
      }
    }),
  });
  registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: diagnosticRegistrarFor(rpc), service: fixture.parent.workspaceSync });
  sourceRpc = rpc;
  workspaceSyncService = fixture.parent.workspaceSync;
  await fixture.registerSeedExport(installed.rpcHandlerManager);
  await fixture.registerSeedExport(rpc);
  const initializeActionIngress = async () => {
    const shutdown = createDaemonShutdownCancellationDomains();
    const admission = createProjectWorkerAdmission({ machineId: installed.machineId,
      admissionDrain: createDaemonAdmissionDrain(), readPolicy: async () => ({ status: 'unavailable' }) });
    const workerAction = createProjectWorkerAction({ machineId: installed.machineId, serverId: installed.serverId,
      serverHttpBaseUrl: installed.serverHttpBaseUrl, credentials: installed.bootstrap.credentials,
      accountId: sourceCustodianAccountId, admission, workspaceSync: fixture.parent.workspaceSync,
      isFiniteExecutionLive: () => true });
    // This receiver owns no Sessions, Runs or Services. These are the same
    // production lifecycle owners, with an empty fixture-owned root inventory.
    const daemonScopeKey = `sync-fixture:${installed.machineId}`;
    const ownership = createProcessOwnershipRuntime({ daemonScopeKey, listRoots: () => [] });
    const leftBehind = createLeftBehindPass({ processOwnershipRuntime: ownership });
    const localServices = createLocalServicesDaemonRuntime({ machineId: installed.machineId,
      processOwnershipRuntime: ownership, startLoop: false });
    onTestFinished(async () => { shutdown.beginShutdown(); leftBehind.dispose(); await localServices.stop(); });
    const resolveOrigin = async () => ({ machineId: installed.machineId, serverIdentityId: installed.homeServerIdentityId });
    let createExecutor: ReturnType<typeof createDaemonExternalActionExecution>;
    const prepareRequesterAccountContext: NonNullable<Parameters<typeof createDaemonApprovalExecutionAuthorizationPreparer>[0]['prepareRequesterAccountContext']> = async input => prepareInstalledRequesterAccountActionContext({
      ownCredentials: installed.bootstrap.credentials,
      authorization: input.authorization, purpose: input.purpose ?? { kind: 'external_action' },
      machineId: installed.machineId, serverId: installed.serverId, serverHttpBaseUrl: installed.serverHttpBaseUrl,
      isRetainedCustodyCurrent: installed.isHomeCurrent,
      resolveCurrentMachineExecutionOriginContext: resolveOrigin,
      createExecutor: admitted => createExecutor(admitted.credentials, undefined, undefined, undefined, undefined, undefined, admitted) });
    const ingressOwner: ExternalActionIngressOwner = {
      currentServerId: installed.serverId, currentServerHttpBaseUrl: installed.serverHttpBaseUrl,
      prepareRequesterAccountContext,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: installed.bootstrap.credentials,
        serverApiUrl: installed.serverHttpBaseUrl }),
      externalActionMachineRequestPrivateKey: installed.installation.privateKey,
      get executor() { return createExecutor(installed.bootstrap.credentials); },
    };
    const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
      credentials: installed.bootstrap.credentials, machineId: installed.machineId, serverId: installed.serverId,
      serverApiUrl: installed.serverHttpBaseUrl, resolveCurrentMachineExecutionOriginContext: resolveOrigin });
    createExecutor = createDaemonExternalActionExecution({
      params: { machineId: installed.machineId, serverId: installed.serverId, serverBaseUrl: installed.serverHttpBaseUrl,
        credentials: installed.bootstrap.credentials, getApiMachineForSessions: () => installed.machine,
        resolveProjectWorkerAction: () => workerAction,
        resolveCurrentMachineExecutionOriginContext: resolveOrigin },
      requiresPortableSessionSpawnServerIdentity,
      requesterAccountOperationContext: createRequesterAccountOperationContext({ machineId: installed.machineId,
        custodianAccountId: sourceCustodianAccountId, installationIdentity: installed.installation }),
      acquireDaemonPluginRuntimeRegistryLease: () => acquireAuthoritativePluginRuntimeRegistryLease({
        happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController }),
      shutdownCancellationDomains: shutdown,
      // The fixture has no registered Session caller.
      isSessionCallerCurrent: async () => false,
      externalActionApprovalExecutionOriginCurrentness: currentness,
      externalActionIngressOwner: ingressOwner,
      externalActionInstallationIdentity: installed.installation,
      externalActionContributedApprovalReplay: null,
      externalActionContributedInvoker: null,
      externalActionContributedDefinitionLister: null,
      externalActionTranscriptFollowLeaseRegistry: null,
      observeContributedPluginExecution: request => installed.machine.observePluginActionExecution(request),
      relayDiscussionAgentPublication: (credentials, serverHttpBaseUrl, publication, signal) => runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
        const sessionId = publication.request.sessionId;
        const transport = await resolveSessionTransportContext({ reason: 'session-control', credentials, idOrPrefix: sessionId,
          ...(signal ? { signal } : {}) });
        if (!transport.ok || transport.sessionId !== sessionId) return { v: 1, ok: false, error: 'discussion_post_denied' };
        const rpc = { token: credentials.token, sessionId, method: `${sessionId}:${SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1}`,
          request: publication, timeoutMs: null, ...(signal ? { signal } : {}) };
        return DiscussionAgentPublisherResponseV1Schema.parse(transport.mode === 'plain'
          ? await callSessionRpc({ ...rpc, mode: 'plain' }) : await callSessionRpc({ ...rpc, mode: 'e2ee', ctx: transport.ctx }));
      }),
      ownerRemainder: createEndOwnerRemainder({ processOwnershipRuntime: ownership, daemonScopeKey, firstPass: leftBehind.firstPass }),
      isRuntimePublicationQuiescing: () => shutdown.daemonWorkSignal.aborted,
      pluginRuntimeController: pluginReloadController,
      connectedAccountRequestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
      // As in startup, the port reader refuses until an HTTP server publishes it.
      // This fixture owns no connected-account request-auth HTTP listener.
      requireConnectedAccountRequestAuthHttpPort: () => { throw new Error('connected_account_request_auth_http_port_unavailable'); },
      localServicesActionFeatureGate: createLocalServicesDaemonFeatureGate({ env: process.env }),
      localServicesRuntimeActionRoutes: { inventoryRoutes: localServices.inventoryRoutes,
        launcherRoutes: localServices.launcherRoutes, previewRoutes: localServices.previewRoutes, actionRoutes: localServices.actionRoutes },
      localServicesRuntime: localServices,
    });
    installed.machine.setRPCHandlers({ spawnSession: async () => { throw new Error('No Session spawn expected'); },
      stopSession: async () => true, requestShutdown() {} }, { externalActionIngressOwner: ingressOwner });
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: diagnosticRegistrarFor(installed.rpcHandlerManager), service: fixture.parent.workspaceSync });
    return { prepareRequesterAccountContext };
  };
  let actionIngress: ReturnType<typeof initializeActionIngress> | undefined;
  const prepareActionIngress = () => actionIngress ??= initializeActionIngress();
  type PreparedInvocation = Readonly<{
    request: WorkspaceSyncRelationshipCreateRpcRequestV1;
    envelope: typeof envelope;
    authorization: NonNullable<RpcHandlerContext['callerInputAuthorization']>;
  }>;
  const prepareExecutorContext = async (invocation: PreparedInvocation) => {
    requesterRoots.set(invocation.authorization.token, invocation.authorization);
    const { prepareRequesterAccountContext } = await prepareActionIngress();
    const prepared = await prepareRequesterAccountContext({ authorization: invocation.authorization,
      purpose: { kind: 'machine_rpc', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE, params: invocation.request } });
    if (!prepared) throw new Error('Requester Action ingress refused');
    onTestFinished(() => prepared.dispose());
    const context = { ...buildActionExecutorContextForRpc({ actionId: invocation.authorization.binding.actionId,
      serverId: installed.serverId, runtimeAccountId: prepared.authorization.binding.accountId,
      callerAuthority: 'present_user', callerInputAuthorization: prepared.authorization,
      originalActionEnvelope: invocation.envelope, verifyMachineAdmissionCurrent: async () => installed.isHomeCurrent(),
      machineAdmission: { actorAccountId: 'member-a', custodianAccountId: sourceCustodianAccountId, machineId: installed.machineId,
        installationId: installed.installation.installationId, role, encryptionMode: sourceResourceMode } }),
      surface: 'ui' as const,
      // The receiving external-Action ingress signs approval input with this
      // installed Machine key, including when its executor uses B credentials.
      signExternalActionApprovalInput: (({ actionId, input, target, requesterConfirmation, sessionTargetsV1 }) =>
        signExternalActionApprovalInputV1({ authorizationToken: invocation.authorization.token,
          actionId, input, target, privateKey: installed.installation.privateKey,
          ...(requesterConfirmation ? { requesterConfirmation } : {}),
          ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}) })) satisfies NonNullable<import('@happier-dev/protocol').ActionExecutorContext['signExternalActionApprovalInput']>,
    };
    const executor = prepared.executor;
    return { executor, context };
  };
  const executeApprovalDecision = async (artifactId: string, invocation: PreparedInvocation) => {
    const { executor, context } = await prepareExecutorContext(invocation);
    return executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context);
  };
  const executeRelationshipAction = async (invocation: PreparedInvocation = { request, envelope, authorization }) => {
    const { executor, context } = await prepareExecutorContext(invocation);
    const result = await executor.execute('workspace.sync.relationship.create', invocation.request.actionInput,
      { ...context, actionRequestId: invocation.request.operationId });
    if (result.ok && result.result && typeof result.result === 'object' && 'kind' in result.result
      && result.result.kind === 'approval_request_created' && 'artifactId' in result.result
      && typeof result.result.artifactId === 'string') {
      const decision = await executor.execute('approval.request.decide', { artifactId: result.result.artifactId, decision: 'approve' }, context);
      if (decision.ok && decision.result && typeof decision.result === 'object' && 'execution' in decision.result) {
        return ApprovalExecutionV2Schema.parse(decision.result.execution);
      }
      return decision;
    }
    return result;
  };
  return { installed, fixture, identity, member, rows, custodianRows, custodianRef, custodianBefore,
    sourcePath, targetPath, sourceRef: fixture.sourceRef, targetRef,
    request, account, authorization, credentials, wire, envelope, prepareInvocation, prepareActionIngress, executeRelationshipAction, executeApprovalDecision, homeActionRequests, adoptHomeAuthorization, rpc, targetRpc, targetMachine, targetInstallation, targetResource, sourceResource, sourceResourceMode, accountMode,
    memberReads: () => memberReads, requesterProjectionReads: () => requesterProjectionReads, requesterRowRequests, requesterMachineAuthorityReads, rpcDiagnostics, targetRpcDiagnostics, approvalArtifacts,
    targetAccountRows, targetAccountRowRequests, seedRequests, authorizeSourceRequest };
}
