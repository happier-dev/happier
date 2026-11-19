import { expect, it, vi } from 'vitest';
import axios from 'axios';
import { createDeploymentChildRequesterHarness } from '@/testkit/backends/deploymentChildRequesterHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { RpcHandlerManager } from './RpcHandlerManager';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { DeploymentChildRpcV1Schema } from '@happier-dev/protocol';
import { createDeploymentChildExecutionProofV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionAutomationHttpPortV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createExternalActionMachineRpcExecution } from '@/api/externalActionExecutionAuthorization';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

it.each([
  { authority: 'present_user', mode: 'plain' }, { authority: 'account_automation', mode: 'plain' },
  { authority: 'present_user', mode: 'e2ee' }, { authority: 'account_automation', mode: 'e2ee' },
] as const)(
  'admits the retained rollback child with admitted $authority authority ($mode) on the same installation', async ({ authority, mode }) => {
    const channel = await createRequesterCurrentnessSocketHarness();
    try {
      const h = await createDeploymentChildRequesterHarness({ encryptionMode: mode,
        rootInput: { serverId: 'srv_archive_home', environmentId: 'environment', deploymentId: 'retained' },
        job: DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: 'deployments.rollback',
          machineId: 'receiver', installationId: 'receiver-installation', phase: 'activate', deploymentId: 'recovery',
          selectedDeploymentId: 'retained', actionOperationId: 'rollback-operation', input: {
            serverId: 'srv_archive_home', environmentId: 'environment', deploymentId: 'retained', targetLinkId: 'link',
            expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: 'recovery',
            contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 } }) });
      // Profile, Settings and their push transport are genuine Home boundaries.
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
        if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: h.settingsContent, version: 1 } };
        if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: h.currentness };
        throw new Error('Unexpected requester HTTP read');
      });
      let activations = 0;
      const rpc = new RpcHandlerManager({ scopePrefix: 'receiver', localMachineId: 'receiver', ...h.receiverEncryption, logger: () => {},
        // The server has verified the signature and lowered authority; native custody and root derivation stay real.
        authorizeRequest: async () => ({ ok: true }), prepareRequesterAccountContext: () => h.prepare() });
      rpc.registerHandler(RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, async (input, context) => {
        activations += 1;
        return { selectedDeploymentId: DeploymentChildRpcV1Schema.parse(input).kind === 'member' ? 'retained' : null,
          authority: context?.callerAuthority };
      });
      const request = { method: h.packet.method, requestId: h.packet.requestId, params: h.packet.params,
        originalActionEnvelope: h.envelope, workspaceSyncSourceExecution: h.packet,
        callerInputAuthorization: h.sealed, callerAuthority: authority,
        machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'receiver-owner', machineId: 'receiver',
          installationId: 'receiver-installation', role: 'use' as const, encryptionMode: mode } };
      const run = async (packet: typeof request) => {
        const response = await rpc.handleRequest(packet);
        return typeof response === 'string' ? socketRpcCodec.decodeResult(h.receiverContent,
          { ok: true, result: response }, '71'.repeat(16)) : response;
      };
      expect(await run(request)).toEqual({ selectedDeploymentId: 'retained', authority });
      expect(activations).toBe(1);
      expect(await run({ ...request, machineAdmission: { ...request.machineAdmission, installationId: 'retired' } }))
        .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(await run({ ...request, originalActionEnvelope: { ...h.envelope, requestId: 'foreign-root' } }))
        .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(activations).toBe(1);
    } finally { await channel.close(); vi.restoreAllMocks(); }
  });

it('preserves signed Workflow Role writes without admitting report-copy configuration transport', async () => {
  const rpc = new RpcHandlerManager({ scopePrefix: 'lead', localMachineId: 'run-machine', encryptionMode: 'plain', logger: () => {},
    // Home signature validation is the network boundary; local method/target admission stays real.
    authorizeRequest: async () => ({ ok: true }) });
  const roleWrite = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-verified-workflow', binding: {
    accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
    accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: 'run-machine', installationId: 'installed',
    actionId: 'session.role.set', requestId: 'workflow-role-write', requestEnvelopeDigest: 'a'.repeat(43),
    target: { kind: 'session', sessionId: 'lead' }, workflowActionOrigin: {
      runId: 'workflow', requestId: 'workflow-role-write', sessionAuthority: {
        authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
        runDepth: 0, runOriginSessionId: 'lead', directory: '/repo', workspaceWrites: 'allow',
      },
    },
  } });
  rpc.registerHandler('session.role.set', (_input, context) => ({ actionId: context?.callerInputAuthorization?.binding.actionId }));
  let copied = false;
  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET, () => { copied = true; return { updated: true }; });
  const request = { method: 'lead:session.role.set', params: { sessionId: 'lead', roleId: 'builder' },
    callerAuthority: 'account_automation' as const, callerInputAuthorization: roleWrite };
  expect(await rpc.handleRequest(request)).toEqual({ actionId: 'session.role.set' });
  expect(await rpc.handleRequest({ ...request, method: 'other:session.role.set' }))
    .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  const copy = ExternalActionExecutionAuthorizationV1Schema.parse({ ...roleWrite,
    binding: { ...roleWrite.binding, actionId: 'session.roles.apply_to_reports' } });
  expect(await rpc.handleRequest({ ...request, method: `lead:${SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET}`,
    callerInputAuthorization: copy })).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  expect(copied).toBe(false);
});

it.each(['account', 'terminal'] as const)('admits only the closed finite archive phase under the verified receiver signer without opening %s requester custody at the holder', async kind => {
  const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: 'deployments.deploy',
    machineId: 'receiver', installationId: 'receiver-install', phase: 'activate', deploymentId: 'deployment',
    selectedDeploymentId: 'deployment', actionOperationId: 'operation',
    input: { serverId: 'home', environmentId: 'environment', targetLinkId: 'link', expectedRevision: 1,
      expectedTargetLinkRevision: 1, requestKey: 'request', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 } });
  const h = await createDeploymentChildRequesterHarness({ encryptionMode: 'plain', job,
    receivingIdentity: { machineId: 'receiver', installationId: 'receiver-install', homeIdentityId: 'home' } });
  // Home may admit either root authentication kind; its finite-child authority
  // comes from the real deployment authorization producer.
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ ...h.root,
    binding: { ...h.root.binding, authentication: { kind, tokenEpoch: 1 } } });
  const proof = createDeploymentChildExecutionProofV1({ ...h.packet,
    externalActionExecution: { ...h.packet.externalActionExecution, authorization: root } },
    { environmentId: 'environment', deploymentId: 'deployment', holderMachineId: 'holder', holderInstallationId: 'holder-install' });
  const method = `holder:${RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD}`;
  const params = { source: { rootPath: '/archive', path: '/archive/image.tar' } };
  let current = true;
  const rpc = new RpcHandlerManager({ scopePrefix: 'holder', localMachineId: 'holder', encryptionMode: 'plain', logger: () => {},
    // Home is the network boundary; real local wire parsing and authority matching remain intact.
    authorizeRequest: async () => current ? { ok: true } : { ok: false, error: 'forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN } });
  rpc.registerHandler(RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD, async (_input, context) => ({
    rootAccount: context?.callerInputAuthorization?.binding.accountId,
    actorAccount: context?.machineAdmission?.actorAccountId,
    current: await context?.verifyMachineAdmissionCurrent?.(),
  }));
  const request = { method, params, callerAuthority: 'account_automation' as const, callerInputAuthorization: root,
    machineAdmission: { actorAccountId: 'receiver-ann', custodianAccountId: 'holder-owner', machineId: 'holder',
      installationId: 'holder-install', role: 'use' as const, encryptionMode: 'plain' as const },
    workspaceSyncSourceExecution: { method, requestId: 'download-request', params, externalActionExecution: { v: 1 as const,
      authorization: root, effectActionId: 'daemon.filesystem.download' as const, target: root.binding.target,
      installationId: 'receiver-install', machineSignature: 'a'.repeat(86), deploymentChildExecution: proof } } };
  expect(await rpc.handleRequest(request)).toMatchObject({ rootAccount: 'bob', actorAccount: 'receiver-ann', current: true });
  current = false;
  expect(await rpc.handleRequest(request)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  current = true;
  expect(await rpc.handleRequest({ ...request, method: `holder:${RPC_METHODS.DAEMON_TERMINAL_LIST}` }))
    .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
});

it('admits the receiver archive download whose parent proof still carries the receiver-sealed requester box', async () => {
  const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: 'deployments.deploy',
    machineId: 'receiver', installationId: 'receiver-install', phase: 'activate', deploymentId: 'deployment',
    selectedDeploymentId: 'deployment', actionOperationId: 'operation',
    input: { serverId: 'home', environmentId: 'environment', targetLinkId: 'link', expectedRevision: 1,
      expectedTargetLinkRevision: 1, requestKey: 'request', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 } });
  const h = await createDeploymentChildRequesterHarness({ encryptionMode: 'plain', job,
    receivingIdentity: { machineId: 'receiver', installationId: 'receiver-install', homeIdentityId: 'home' } });
  // The controller-signed child packet carries the box sealed to the receiver; the
  // receiver opens it and signs its download with the box-free admitted root.
  expect(h.packet.externalActionExecution.authorization.requesterAccountContext).toBeDefined();
  const { requesterAccountContext: _box, ...admittedRoot } = h.packet.externalActionExecution.authorization;
  const root = ExternalActionExecutionAuthorizationV1Schema.parse(admittedRoot);
  const proof = createDeploymentChildExecutionProofV1(h.packet,
    { environmentId: 'environment', deploymentId: 'deployment', holderMachineId: 'holder', holderInstallationId: 'holder-install' });
  const method = `holder:${RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD}`;
  const params = { source: { rootPath: '/archive', path: '/archive/image.tar' } };
  const rpc = new RpcHandlerManager({ scopePrefix: 'holder', localMachineId: 'holder', encryptionMode: 'plain', logger: () => {},
    // Home is the network boundary; real local wire parsing and authority matching remain intact.
    authorizeRequest: async () => ({ ok: true }) });
  rpc.registerHandler(RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD, async (_input, context) => ({
    rootAccount: context?.callerInputAuthorization?.binding.accountId }));
  const request = { method, params, callerAuthority: 'account_automation' as const, callerInputAuthorization: root,
    machineAdmission: { actorAccountId: 'receiver-ann', custodianAccountId: 'holder-owner', machineId: 'holder',
      installationId: 'holder-install', role: 'use' as const, encryptionMode: 'plain' as const },
    workspaceSyncSourceExecution: { method, requestId: 'download-request', params, externalActionExecution: { v: 1 as const,
      authorization: root, effectActionId: 'daemon.filesystem.download' as const, target: root.binding.target,
      installationId: 'receiver-install', machineSignature: 'a'.repeat(86), deploymentChildExecution: proof } } };
  expect(await rpc.handleRequest(request)).toMatchObject({ rootAccount: root.binding.accountId });
  // The same sealed parent proof admits no other root, binding, receiver or Account.
  const attempt = async (presented: typeof root, installationId = 'receiver-install') => await rpc.handleRequest({
    ...request, callerInputAuthorization: presented,
    workspaceSyncSourceExecution: { ...request.workspaceSyncSourceExecution, externalActionExecution: {
      ...request.workspaceSyncSourceExecution.externalActionExecution, authorization: presented, installationId } } });
  const refused = { errorCode: RPC_ERROR_CODES.FORBIDDEN };
  expect(await attempt(ExternalActionExecutionAuthorizationV1Schema.parse({ ...root, token: 'other-root' })))
    .toMatchObject(refused);
  expect(await attempt(ExternalActionExecutionAuthorizationV1Schema.parse({ ...root,
    binding: { ...root.binding, requestId: 'other-request' } }))).toMatchObject(refused);
  expect(await attempt(root, 'other-receiver-install')).toMatchObject(refused);
  expect(await attempt(ExternalActionExecutionAuthorizationV1Schema.parse({ ...root,
    binding: { ...root.binding, accountId: 'other-account' } }))).toMatchObject(refused);
});

it('runs the joining member archive download under the deploy admission without a filesystem Ask', async () => {
  const install = { machineId: 'joining', installationId: 'joining-install', homeIdentityId: 'home' };
  const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: 'deployments.deploy',
    machineId: install.machineId, installationId: install.installationId, phase: 'restore', deploymentId: 'candidate',
    selectedDeploymentId: 'serving', actionOperationId: 'rollout',
    input: { serverId: 'home', environmentId: 'environment', targetLinkId: 'link', expectedRevision: 1,
      expectedTargetLinkRevision: 1, requestKey: 'candidate', contentArtifactId: 'candidate-content',
      contentHeaderVersion: 1, contentBodyVersion: 1 } });
  const h = await createDeploymentChildRequesterHarness({ encryptionMode: 'plain', job, receivingIdentity: install });
  const actionId = 'daemon.filesystem.download';
  const method = `holder:${RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD}`;
  const input = { rootPath: '/archive', path: '/archive/serving.tar', destination: { destinationId: 'archive-destination' },
    asZip: false, format: 'entry_tree' as const };
  const params = StrictJsonValueSchema.parse(createTargetedActionRpcRequestV1(input, { kind: 'machine', machineId: 'holder' }));
  const manifestHash = `sha256:${'1'.repeat(64)}`;
  const receipt = { success: true, status: 'accepted', operationId: 'archive-operation', destinationId: 'archive-destination',
    prepared: { transferId: 'archive-transfer', name: 'serving.tar', sizeBytes: 42, manifestHash, expiresAt: 1,
      endpointCandidates: [] },
    entryTree: { operationId: 'archive-operation', expectation: { kind: 'file', digest: '1'.repeat(40), executable: false, size: 42 },
      blobs: [{ transferId: 'archive-transfer', sizeBytes: 42, manifestHash }] } };
  const filesystemActionExecute = vi.fn(async () => receipt);
  const approvalsCreate = vi.fn(async () => { throw new Error('Unexpected filesystem Ask'); });
  const rpc = new RpcHandlerManager({ scopePrefix: 'holder', localMachineId: 'holder', encryptionMode: 'plain', logger: () => {},
    // Authenticated Home and native byte transfer are the system boundaries.
    authorizeRequest: async () => ({ ok: true }) });
  registerActionSpecRpcHandlers({ rpcHandlerManager: rpc, actionIds: [actionId], targetMachineId: 'holder',
    defaultMachineTarget: true, actionExecutor: createActionExecutor({ ...createUnavailableActionTransportDeps(),
      filesystemActionExecute, approvalsCreate,
      actionAutomations: createActionAutomationHttpPortV1({ accountId: 'bob', request: async () => ({ v: 1, rows: [] }) }),
    }) });
  const request = { method, params, callerAuthority: 'account_automation' as const,
    machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'bob', machineId: 'holder',
      installationId: 'holder-install', role: 'use' as const, encryptionMode: 'plain' as const } };
  const send = async (root: typeof h.root, includeParent = true) => {
    const requestId = 'archive-download';
    const externalActionExecution = createExternalActionMachineRpcExecution({
      context: { externalActionExecutionAuthorization: root, externalActionTarget: root.binding.target },
      effectActionId: actionId, installationId: install.installationId, method, requestId, params, privateKey: h.receiver.secretKey,
      ...(includeParent ? { deploymentChildExecution: h.packet, deploymentArchiveOrigin: { environmentId: 'environment',
        deploymentId: 'serving', holderMachineId: 'holder', holderInstallationId: 'holder-install' } } : {}),
    });
    if (!externalActionExecution) throw new Error('Missing signed archive download');
    return await rpc.handleRequest({ ...request, callerInputAuthorization: root,
      workspaceSyncSourceExecution: { method, requestId, params, externalActionExecution } });
  };
  expect(await send(h.root, false)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  for (const wrongBinding of [{ accountId: 'other-account' }, { requestId: 'different-deploy' }]) {
    expect(await send({ ...h.root, binding: { ...h.root.binding, ...wrongBinding } }))
      .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  }
  expect(filesystemActionExecute).not.toHaveBeenCalled();
  expect(await send(h.root)).toEqual(receipt);
  expect(filesystemActionExecute).toHaveBeenCalledOnce();
  expect(approvalsCreate).not.toHaveBeenCalled();
});

it.each(['account', 'terminal'] as const)('preserves the %s root authority when admitting exact-machine terminal observation', async kind => {
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-home-root', binding: {
    accountId: 'actor', custodianAccountId: 'owner', authentication: { kind, tokenEpoch: 1 },
    accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: 'machine', installationId: 'installation',
    actionId: 'machines.terminal.list', requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43),
    target: { kind: 'machine', machineId: 'machine' },
  } });
  const authority = kind === 'account' ? 'present_user' as const : 'account_automation' as const;
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain', logger: () => {},
    // Authenticated Home admission is the network boundary; local matching stays real.
    authorizeRequest: async () => ({ ok: true }) });
  rpc.registerHandler(RPC_METHODS.DAEMON_TERMINAL_LIST, (_input, context) => ({ authority: context?.callerAuthority, terminals: [] }));
  const request = { method: `machine:${RPC_METHODS.DAEMON_TERMINAL_LIST}`, params: {},
    callerAuthority: authority, callerInputAuthorization: root,
    machineAdmission: { actorAccountId: 'actor', custodianAccountId: 'owner', machineId: 'machine',
      installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const } };
  expect(await rpc.handleRequest(request)).toMatchObject({ authority, terminals: [] });
  expect(await rpc.handleRequest({ ...request, callerAuthority: kind === 'account' ? 'account_automation' : 'present_user' }))
    .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  expect(await rpc.handleRequest({ ...request, machineAdmission: { ...request.machineAdmission, installationId: 'replaced' } }))
    .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
});
