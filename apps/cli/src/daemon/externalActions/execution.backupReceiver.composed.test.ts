import { expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { encodeStoredCredentials, type StoredCredentials } from '@/persistence';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import nacl from 'tweetnacl';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { WORKFLOW_RUN_STORAGE_HTTP_PATH } from '@/daemon/workflows/workflowRunStorageClient';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1, PluginInstallationManifestPublisherHeaderV1Schema } from '@happier-dev/protocol/plugins/installations/manifests';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import * as currentInstallation from '@/daemon/identity/currentMachineInstallation';
import { createDaemonExternalActionExecution, createRequesterAccountOperationContext } from '@/daemon/externalActions/execution';
import { createDaemonShutdownCancellationDomains } from '@/daemon/startup/shutdownCancellationDomains';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import * as installationStore from '@/daemon/identity/store';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import { BACKUP_RECEIVER_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

function unmounted<T>(name: string): T {
  const unavailable = () => {
    throw new Error(`Unexpected daemon capability: ${name}`);
  };
  return new Proxy(unavailable, { get: unavailable }) as T;
}

it.each([
  { scenario: 'reviewed Apply on the named Manage receiver', machineId: 'receiver', role: 'manage', admitted: true, apply: true },
  { scenario: 'named Manage receiver', machineId: 'receiver', role: 'manage', admitted: true },
  { scenario: 'receiver shared only for Use', machineId: 'receiver', role: 'use', admitted: false },
  { scenario: 'Machine the review did not name', machineId: 'elsewhere', role: 'manage', admitted: false },
] as const)('admits the Backup receiver Setup child at the receiving executor only for the $scenario', async scenario => {
  const { machineId, role, admitted } = scenario;
  const apply = 'apply' in scenario;
  onTestFinished(() => vi.restoreAllMocks());
  const credentials: StoredCredentials = {
    token: `e30.${Buffer.from(JSON.stringify({ sub: 'person', tokenEpoch: 1, provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`,
    encryption: null,
    credentialProvenance: 'stored_session',
  };
  const homeId = 'srv_backup_home';
  const target = { kind: 'machine' as const, machineId: 'source' };
  const rootInput = { serverId: homeId, environmentId: 'environment', expectedRevision: 3, intent: 'test' as const,
    destinationSetup: { kind: 'anotherMachine' as const, machineId: 'receiver', expectedInstallationId: 'receiver-installation', receiverInputs: {} },
    configuration: { configRevision: 1, destinationRef: { pluginId: 'happier.backup.local', localId: 'open' }, occurrenceId: 'destination',
      config: { path: '/private/repository' }, credentialBindings: [],
      sources: [{ kind: 'dump' as const, sourceId: 'database', service: 'postgres', consistency: 'logical' as const }],
      ownership: { environmentId: 'environment', prefix: 'owner-prefix' }, retention: { kind: 'keepEverything' as const } } };
  const envelope = { v: 1 as const, requestId: 'backup-configure', target, input: rootInput };
  const sourceRoot = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-verified-backup', binding: {
    accountId: 'person', custodianAccountId: 'person', authentication: { kind: 'account', tokenEpoch: 1 },
    accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId: 'source', installationId: 'source-installation',
    actionId: 'deployments.backups.configure', requestId: envelope.requestId, target, environmentId: 'environment', admittedMachineRole: 'manage',
    deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.backups.configure', rootInput),
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  const planInput = { homeId, machineId };
  const child = apply ? BACKUP_RECEIVER_SETUP_CHILDREN_V1.apply : BACKUP_RECEIVER_SETUP_CHILDREN_V1.plan;
  const input = apply ? MachineSetupApplyInputV1Schema.parse({ homeId, machineId, targets: [{ homeId, machineId,
    sources: [{ kind: 'direct', setup: {} }], desiredRevision: 0, recipePlans: [], exclusions: [] }] }) : planInput;
  const rpcMethod = getActionSpec(child.action).bindings?.rpcMethod;
  if (!rpcMethod) throw new Error('Setup must expose its production Machine RPC binding');
  const method = `${machineId}:${rpcMethod}`;
  const sourceKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
  const receiverKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(13));
  const installation = { version: 1 as const, installationId: `${machineId}-installation`, createdAt: 1,
    publicKey: encodeBase64(receiverKeys.publicKey, 'base64url'), privateKey: encodeBase64(receiverKeys.secretKey, 'base64url') };
  vi.spyOn(currentInstallation, 'readCurrentMachineInstallation').mockResolvedValue({ machineId, identity: installation });
  const operations = createHostActionOperationRuntime({ machineId, serverId: homeId, resolveAccountId: async () => 'bob',
    custodyBinding: { serverId: homeId, installationId: installation.installationId } });
  const publishes: Array<{ body: unknown; publisher: unknown }> = [];
  const rpcDiagnostics: unknown[] = [];
  const network: string[] = [];
  if (apply) {
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
    onTestFinished(() => runtime.dispose());
    const currentness = await createRequesterCurrentnessSocketHarness();
    onTestFinished(() => currentness.close());
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const pathname = new URL(String(url)).pathname;
      network.push(`GET ${pathname}`);
      if (pathname === '/v1/account/profile') return { status: 200, data: { id: 'person' } };
      if (pathname.endsWith('/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (pathname.endsWith('/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (pathname === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      if (pathname.startsWith('/v1/artifacts')) return { status: 404, data: { error: 'not_found' } };
      throw new Error(`Unexpected Home read ${pathname}`);
    });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
      network.push(`${request.method} ${new URL(String(request.url)).pathname}`);
      if (request.method?.toUpperCase() === 'GET' && new URL(String(request.url)).pathname === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1)
        return { status: 200, data: { v: 1, rows: [] } };
      throw new Error(`Unexpected Home request ${request.method} ${new URL(String(request.url)).pathname}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      const pathname = new URL(String(url)).pathname;
      network.push(`POST ${pathname}`);
      if (pathname.endsWith('/verify')) return { status: 200, data: { ok: true } };
      if (pathname === WORKFLOW_RUN_STORAGE_HTTP_PATH) {
        const header = PluginInstallationManifestPublisherHeaderV1Schema.parse(JSON.parse(Buffer.from(
          String(config?.headers?.[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]), 'base64url').toString('utf8')));
        publishes.push({ body, publisher: header.proof });
        if (body.operation === 'get') {
          throw Object.assign(new Error('Run not found'), { response: { status: 404, data: { error: 'run_not_found' } } });
        }
        // Stop at Home's network boundary before the Run starts native work.
        throw Object.assign(new Error('Fixture stopped after publication'), { response: { status: 409 } });
      }
      throw new Error(`Unexpected Home write ${pathname}`);
    });
  }
  // The installed identity file is the OS boundary; admission matching stays real.
  vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(installation);
  const apiMachine = new Proxy({ runActionOperation: operations.runActionOperation, getMachineEncryptionMode: () => 'plain' }, {
    get: (target, key) => key in target ? Reflect.get(target, key) : vi.fn(),
  }) as never;
  const isCallerCurrent = async () => true;
  const createExternal = createDaemonExternalActionExecution({
    params: {
      machineId, serverId: 'home', serverBaseUrl: 'https://home.invalid', credentials,
      getApiMachineForSessions: () => apiMachine,
      resolveServerFeaturesSnapshot: () => ({ status: 'unavailable' }) as never,
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId, serverIdentityId: homeId }) as never,
    },
    requiresPortableSessionSpawnServerIdentity: () => false,
    requesterAccountOperationContext: createRequesterAccountOperationContext({
      machineId, custodianAccountId: 'bob', installationIdentity: installation,
    }),
    acquireDaemonPluginRuntimeRegistryLease: unmounted('pluginRegistry'),
    shutdownCancellationDomains: createDaemonShutdownCancellationDomains(),
    isSessionCallerCurrent: isCallerCurrent,
    externalActionApprovalExecutionOriginCurrentness: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
      credentials, serverId: 'home', serverApiUrl: 'https://home.invalid', machineId, isSessionCallerCurrent: isCallerCurrent }),
    externalActionIngressOwner: undefined,
    externalActionContributedApprovalReplay: null,
    observeContributedPluginExecution: unmounted('pluginExecution'),
    relayDiscussionAgentPublication: unmounted('discussion'),
    externalActionInstallationIdentity: installation,
    ownerRemainder: unmounted('processRemainder'),
    isRuntimePublicationQuiescing: unmounted('publication'),
    pluginRuntimeController: unmounted('plugins'),
    connectedAccountRequestAuthRegistry: unmounted('connectedAccounts'),
    requireConnectedAccountRequestAuthHttpPort: unmounted('connectedAccountHttp'),
    localServicesActionFeatureGate: unmounted('localServicesGate'),
    localServicesRuntimeActionRoutes: unmounted('localServicesRoutes'),
    localServicesRuntime: unmounted('localServices'),
    externalActionContributedInvoker: null,
    externalActionContributedDefinitionLister: null,
    externalActionTranscriptFollowLeaseRegistry: null,
  });
  const external = createExternal(credentials, () => 0, isCallerCurrent, undefined, null);
  const machineAdmission = { actorAccountId: 'person', custodianAccountId: 'bob', machineId,
    installationId: installation.installationId, role, encryptionMode: 'plain' as const };
  const requestId = 'receiver-setup';
  const reviewedChild = { actionId: child.action, role: child.role,
    inputDigest: computeActionInputApprovalDigestV1(child.action, input) };
  const root = apply ? sealExternalActionRequesterAccountContextV1({ authorization: sourceRoot,
    credentials: encodeStoredCredentials(credentials), installationPublicKey: receiverKeys.publicKey,
    randomBytes: nacl.randomBytes,
    purpose: { kind: 'machine_rpc', method: rpcMethod, params: input, reviewedChild,
      recipient: { machineId, installationId: installation.installationId } },
  }) : sourceRoot;
  const createPacket = (method: string, effectActionId: ActionId = child.action) => {
    const signed = { effectActionId, installationId: root.binding.installationId, target, reviewedChild };
    return { method, requestId, params: input, originalActionEnvelope: envelope, externalActionExecution: {
      v: 1 as const, authorization: root, ...signed,
      machineSignature: signExternalActionMachineRpcRequestV1({ ...signed, authorizationToken: root.token,
        event: SOCKET_RPC_EVENTS.CALL, method, requestId, params: input, privateKey: sourceKeys.secretKey,
        ...(root.requesterAccountContext ? { requesterAccountContext: root.requesterAccountContext } : {}) }),
    } };
  };
  const packet = createPacket(method);
  if (apply) {
    const mountRpc = (receiverId: string) => new RpcHandlerManager({ scopePrefix: receiverId, localMachineId: receiverId, encryptionMode: 'plain', logger: (message, data) => rpcDiagnostics.push({ message, data }),
      completionLogger: (message, data) => rpcDiagnostics.push({ message, data }),
      // Home verifies the source and receiver admission. Local wire matching and execution are real.
      authorizeRequest: async () => ({ ok: true }),
      prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({
        ...request, machineId, installationId: installation.installationId, installationPrivateKey: receiverKeys.secretKey,
        serverId: 'home', serverIdentityId: homeId, serverHttpBaseUrl: 'https://home.invalid',
        isCurrent: async () => !request.signal?.aborted,
        createExecutor: requester => createExternal(requester.credentials, () => 0, requester.isCurrent, undefined, null, undefined, requester),
      }),
    });
    const rpc = mountRpc(machineId);
    const planMethod = getActionSpec(BACKUP_RECEIVER_SETUP_CHILDREN_V1.plan.action).bindings?.rpcMethod;
    if (!planMethod) throw new Error('Setup Plan must expose its production Machine RPC binding');
    registerActionSpecRpcHandlers({ rpcHandlerManager: rpc,
      actionIds: [child.action, BACKUP_RECEIVER_SETUP_CHILDREN_V1.plan.action],
      actionExecutor: external, targetMachineId: machineId });
    const request = { method, requestId, params: input, callerInputAuthorization: root,
      callerAuthority: 'present_user' as const, machineAdmission, originalActionEnvelope: envelope, workspaceSyncSourceExecution: packet };
    const otherEnvironment = { ...envelope, input: { ...envelope.input, environmentId: 'another-environment' } };
    const third = mountRpc('other-machine');
    registerActionSpecRpcHandlers({ rpcHandlerManager: third, actionIds: [child.action],
      actionExecutor: external, targetMachineId: 'other-machine' });
    const assertRefused = (result: unknown, boundary: string) => {
      const code = (result as { errorCode?: string } | null)?.errorCode;
      expect([RPC_ERROR_CODES.FORBIDDEN, 'target_unavailable'], JSON.stringify({ boundary, result })).toContain(code);
      expect(publishes).toHaveLength(0);
    };
    const thirdMethod = `other-machine:${rpcMethod}`;
    assertRefused(await third.handleRequest({ ...request, method: thirdMethod,
      workspaceSyncSourceExecution: createPacket(thirdMethod),
      machineAdmission: { ...machineAdmission, machineId: 'other-machine' } }), 'third machine');
    const otherMethod = `${machineId}:${planMethod}`;
    assertRefused(await rpc.handleRequest({ ...request, method: otherMethod,
      workspaceSyncSourceExecution: createPacket(otherMethod, BACKUP_RECEIVER_SETUP_CHILDREN_V1.plan.action) }), 'another action');
    assertRefused(await rpc.handleRequest({ ...request, originalActionEnvelope: otherEnvironment,
      workspaceSyncSourceExecution: { ...packet, originalActionEnvelope: otherEnvironment } }), 'another environment');
    assertRefused(await rpc.handleRequest({ ...request, machineAdmission: { ...machineAdmission,
      installationId: 'retired-installation' } }), 'another installation');
    rpcDiagnostics.length = 0;
    const result = await rpc.handleRequest(request, undefined, 'authenticated_home_socket');
    expect(publishes, JSON.stringify({ result, rpcDiagnostics, publishes, network })).toContainEqual({
      body: expect.objectContaining({ operation: 'admit', machineId, publisherMachineId: machineId }),
      publisher: expect.objectContaining({ machineId, installationId: installation.installationId }),
    });
    return;
  }
  const result = await Promise.resolve(external.execute(child.action, input, {
    surface: 'rpc', authority: 'account_automation', actionRequestId: requestId,
    externalActionExecutionAuthorization: root, externalActionTarget: target, originalActionEnvelope: envelope,
    machineAdmission, verifyMachineAdmissionCurrent: async () => true, workspaceSyncSourceExecution: packet,
  } as never)).catch((error: unknown) => error);
  // A refused child stops at this executor's admission; an admitted one proceeds to the native Setup owner.
  expect(JSON.stringify(result).includes('target_binding_mismatch'), JSON.stringify(result)).toBe(!admitted);
});
