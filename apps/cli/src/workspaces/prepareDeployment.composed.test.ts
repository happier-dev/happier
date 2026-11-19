import axios, { AxiosHeaders } from 'axios';
import { validatePreparedDeploymentHead } from './prepareDeploymentValidation.composed.testkit';
import childProcess from 'child_process';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createActionExecutor, listActionSpecsForSurface, DeploymentPrepareResultV1Schema, FeaturesResponseSchema, type ActionExecutorContext, type DeploymentPrepareInputV1, type ScmActionId } from '@happier-dev/protocol';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { emptyConnectedAccountCatalogRecordV1, sealConnectedAccountCatalogContentV1, ConnectedAccountCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { createGithubScmHostingProviderAdapter, createGithubRestAdapter } from '@happier-dev/plugins-scm-github';
import type { AgentSessionRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import * as persistence from '@/persistence';
import { SessionMessageContentSchema, UserMessageSchema } from '@/api/types';
import { buildCommittedLaunchMetadata } from '@/agent/runtime/createSessionMetadata';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { prepareSessionCreationTarget } from '@/session/creation/prepareSessionCreationTarget';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { registerSessionCreationTargetPreparationRpc } from '@/session/creation/registerSessionCreationTargetPreparationRpc';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { registerCapabilitiesHandlers } from '@/rpc/handlers/capabilities';
import { createProbeTempDir, writeExecutableScript } from '@/capabilities/probes/agentModelsProbe.testkit';
import { openSessionStoredContent } from '@/session/transport/encryption/sessionEncryptionContext';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createBareGitRemoteFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { createDeploymentGitRegistry } from '@/deployments/targets/ownServer/exactCommitRelease.testkit';
import { createScmHostingProviderRegistry } from '@/scm/hostingProviders/registry';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { isHostGitPush } from '@/scm/gitHostTransport';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createGitWorkspace, runGit } from '@/scm/rpc/__tests__/testRpcHarness';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from './projectAccountRows.testkit';
import { withdrawActiveProjectAccountRowsSnapshot } from './projectAccountRows';
import { removeTempDir } from '@/testkit/fs/tempDir';
import nacl from 'tweetnacl';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema, projectDeploymentPreparationAdmissionV1, projectExternalActionDeploymentPreparationEnvelopeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { admitRequesterAccountActionContext, prepareInstalledRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import * as installationStore from '@/daemon/identity/store';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createPrepareSessionCreationAuthorization, isReviewedSessionActionCreationChild, projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createDaemonSessionAccountActionExecutor } from '@/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import type { SessionActionRpcOriginV1, SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/socketRpc';
import { WorkspaceSyncSourceExecutionV1Schema, readOriginalActionEnvelopeMachineRpcKindV1 } from '@happier-dev/protocol/socketRpc';
import { ExternalActionMachineRpcExecutionV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { readExternalActionBindingAuthority } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { buildWorkflowActionContext } from '@/daemon/workflows/workflowActionContext';
import { invokeHostReviewedChildV1, readHostAdmittedReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { deriveDeploymentPrepareSessionCreationIdentityV1, type SessionActionChildCreationProofV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationAuthorizationV1';
import { admitSessionSpawnNewActionInputV2, SessionSpawnNewActionInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { materializeSessionCreationActionInput } from '@happier-dev/protocol/actions/executor/sessionSpawn';
import { HomeGovernanceGetInputV1Schema } from '@happier-dev/protocol/home/governance/actionsV1';
import { HomeSessionDefaultsProjectionV1Schema } from '@happier-dev/protocol/home/governance/projection';
import { deriveDeploymentPrepareSessionSpawnInputV1 } from '@happier-dev/protocol/deployments/deploymentPreparationV1';
import { readSessionInputRequest, SessionInputAdmissionResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionLookupByTagsRequestV2Schema } from '@happier-dev/protocol/sessions/control/contract';
import { managedMachineActionEndpointPathV1, ManagedListInputV1Schema, ManagedListOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { readRpcErrorCode, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { resolveMachineRpcExternalActionEffectV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import type { SessionSpawnDirectTargetTransport } from '@/session/actions/createCliActionDeps';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { createDaemonApprovalExecutionAuthorizationPreparer } from '@/daemon/externalActions/approvalExecutionAuthorization';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { ExternalActionApprovalReplay } from '@/rpc/handlers/externalAction';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, ActionAutomationIndexV1Schema } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { logger } from '@/ui/logger';

afterEach(() => {
  vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  resetActiveAccountSettingsSnapshotForTests(); withdrawActiveProjectAccountRowsSnapshot();
});
// Both composed suites publish into the same daemon controller lifetime.
afterAll(() => pluginReloadController.shutdown());

const token = `header.${Buffer.from(JSON.stringify({ sub: 'prepare-account', tokenEpoch: 1,
  provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'prepare/app' };
const installationKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
const publicKey = Buffer.from(installationKeys.publicKey).toString('base64');
type BoundRead = Readonly<{ headers: unknown; method: 'GET' | 'POST'; path: string; body?: unknown; effectActionId: string }>;
function verifiesPrepareRead(read: BoundRead) {
  const headers = read.headers && typeof read.headers === 'object' ? read.headers : {};
  return Reflect.get(headers, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER) === 'prepare-proof'
    && Reflect.get(headers, EXTERNAL_ACTION_EFFECT_ACTION_HEADER) === read.effectActionId
    && verifyExternalActionMachineRequestV1({ authorizationToken: 'prepare-proof', effectActionId: read.effectActionId,
      target: { kind: 'machine', machineId: 'workspace-daemon' }, installationId: 'workspace-installation',
      requestId: 'prepare-request', method: read.method, path: read.path, ...(read.body === undefined ? {} : { body: read.body }),
      signature: String(Reflect.get(headers, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER) ?? ''), publicKey: installationKeys.publicKey });
}

// The native RPC dispatcher and its owners stay real. Only the Agent executable
// and Home network endpoint are substituted beside the existing runner boundary.
async function createPreparationNativeRpc(input: Readonly<{
  machineAdmission: SocketRpcMachineAdmissionContextV1;
  serverId: string;
  serverHttpBaseUrl: string;
  daemonToken: string;
  privateKey: Uint8Array;
}>) {
  const { machineAdmission } = input;
  const machineId = machineAdmission.machineId;
  // The installation file is an OS boundary; keep its custody opener real.
  vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
    installationId: machineAdmission.installationId, createdAt: 1,
    publicKey: Buffer.from(installationKeys.publicKey).toString('base64url'),
    privateKey: Buffer.from(input.privateKey).toString('base64url') });
  const executable = await createProbeTempDir('happier-prepare-agent-');
  onTestFinished(executable.cleanup);
  await writeExecutableScript(join(executable.dir, process.platform === 'win32' ? 'claude.cmd' : 'claude'),
    process.platform === 'win32' ? '@echo off\r\necho claude 2.0.0\r\n' : '#!/bin/sh\nprintf "claude 2.0.0\\n"\n');
  await writeExecutableScript(join(executable.dir, process.platform === 'win32' ? 'codex.cmd' : 'codex'),
    process.platform === 'win32' ? '@echo off\r\necho codex 0.100.0\r\n' : '#!/bin/sh\nprintf "codex 0.100.0\\n"\n');
  vi.stubEnv('PATH', executable.dir + delimiter + (process.env.PATH ?? ''));
  const native = new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId, scopeKind: 'machine', encryptionMode: 'plain', logger() {},
    prepareRequesterAccountContext: request => prepareInstalledRequesterAccountActionContext({ ...request,
      machineId, serverId: input.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl,
      ownCredentials: { token: input.daemonToken, encryption: null },
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId, serverIdentityId: input.serverId }),
      createExecutor: admitted => createActionExecutor(createCliActionDeps({ token: admitted.credentials.token,
        credentials: admitted.credentials, sessionId: '', mode: 'plain', ctx: null,
        serverId: input.serverId, serverIdentityId: input.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl,
        savedSecretOperationContext: admitted.savedSecretOperationContext, isCredentialCurrent: admitted.isCurrent,
        externalActionMachineInstallationId: machineAdmission.installationId,
        externalActionMachineRequestPrivateKey: input.privateKey,
        machineActionDirectTargetTransport: { machineId, invoke: (method, request, options) => native.invokeLocal(method, request, options) },
      })) }),
    authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, {
      machineId, resolveCustodianAccountId: async () => machineAdmission.custodianAccountId,
      resolveInstallationId: () => machineAdmission.installationId,
      resolveHomeServerIdentityId: async () => input.serverId,
      verifyMachineAdmission: admission => verifyMachineRpcAdmissionCurrent({ ...admission,
        privateKey: input.privateKey, daemonToken: input.daemonToken, serverHttpBaseUrl: input.serverHttpBaseUrl }),
    }, source) });
  registerSessionCreationTargetPreparationRpc({ rpcHandlerManager: native });
  registerDaemonContributionRegistryProjectionHandler(native);
  registerCapabilitiesHandlers(native, { filesystemEffectAdmission: createFilesystemEffectAdmission({
    resolveHomeServerIdentityId: async () => input.serverId,
    resolveHostIdentity: async () => ({ custodianAccountId: machineAdmission.custodianAccountId,
      machineId, installationId: machineAdmission.installationId }),
    // This fixture Machine uses daemon placement; requester identity remains
    // with the real admission and execution-placement owners.
    readAgentIsolation: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }),
  }) });
  return native;
}

function attachPreparationRpcPeer(socket: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>,
  machineAdmission: SocketRpcMachineAdmissionContextV1, native: RpcHandlerManager,
  admission?: Readonly<{ enforce: boolean; refuseOriginalAction?: boolean; record: (method: string, kind: string | null, executionParsed: boolean, envelopeParsed: boolean, rootActionId?: string) => void }>) {
  const machineId = machineAdmission.machineId;
  socket.server.on('connection', peer => peer.on('rpc-call', async (packet: unknown, acknowledge: (result: unknown) => void) => {
    try {
      if (!packet || typeof packet !== 'object' || !('method' in packet) || typeof packet.method !== 'string'
        || !packet.method.startsWith(machineId + ':') || !('params' in packet)) throw new Error('Unexpected preparation RPC');
      // Home is the substituted network boundary. Preserve the request carrier
      // and add its authenticated Machine admission before real daemon ingress.
      const execution = ExternalActionMachineRpcExecutionV1Schema.safeParse(Reflect.get(packet, 'externalActionExecution'));
      const envelope = ExternalActionRequestEnvelopeSchema.safeParse(Reflect.get(packet, 'originalActionEnvelope'));
      const kind = execution.success && envelope.success ? readOriginalActionEnvelopeMachineRpcKindV1({
        method: packet.method.slice(machineId.length + 1), machineId, execution: execution.data,
        envelope: envelope.data, params: packet.params,
      }) : null;
      admission?.record(packet.method, kind, execution.success, envelope.success,
        execution.success ? execution.data.authorization.binding.actionId : undefined);
      if (admission?.enforce && execution.success) {
        const purpose = resolveMachineRpcExternalActionEffectV1(packet.method.slice(machineId.length + 1),
          execution.data.authorization.binding, { machineId, installationId: execution.data.installationId }, execution.data.reviewedChild);
        const isChild = execution.data.authorization.binding.actionId !== execution.data.effectActionId;
        if (purpose !== execution.data.effectActionId || isChild && kind !== 'child' || envelope.success && kind === null) {
          acknowledge({ ok: false, error: 'Home refused the original Action RPC child', errorCode: RPC_ERROR_CODES.FORBIDDEN });
          return;
        }
      }
      if (admission?.refuseOriginalAction) {
        // Mirror Home's typed network refusal; all downstream transport,
        // Session projection and approved-receipt persistence stay real.
        acknowledge({ ok: false, error: 'Home refused the original Action', errorCode: RPC_ERROR_CODES.FORBIDDEN,
          failureCause: { phase: 'rpc.admission.original_action', errorClass: 'UnknownThrownValue',
            errorCode: RPC_ERROR_CODES.FORBIDDEN, httpStatus: null }, effectAttempted: false });
        return;
      }
      const retainedChild = execution.success && envelope.success && kind === 'child' ? WorkspaceSyncSourceExecutionV1Schema.parse({ method: packet.method,
        requestId: Reflect.get(packet, 'requestId'), params: packet.params,
        externalActionExecution: execution.data, originalActionEnvelope: envelope.data }) : null;
      // Match registerSocketRpcHandlers' admitted child forwarding; these are
      // Home transport stamps, not fields supplied by the public RPC caller.
      const result = await native.handleRequest({ ...packet, method: packet.method, params: packet.params,
        machineAdmission, ...(retainedChild ? {
          workspaceSyncSourceExecution: retainedChild,
          callerInputAuthorization: retainedChild.externalActionExecution.authorization,
          callerAuthority: readExternalActionBindingAuthority(retainedChild.externalActionExecution.authorization.binding),
          ...(retainedChild.externalActionExecution.authorization.binding.sessionActionOrigin
            ? { sessionActionOrigin: retainedChild.externalActionExecution.authorization.binding.sessionActionOrigin } : {}),
        } : {}) }, undefined, 'authenticated_home_socket');
      acknowledge({ ok: true, result });
    } catch (error) {
      const errorCode = readRpcErrorCode(error);
      acknowledge({ ok: false, error: String(error), ...(errorCode ? { errorCode } : {}) });
    }
  }));
}

function fixture(options: Readonly<{ isCredentialCurrent?: () => boolean; signal?: AbortSignal; onSourceRead?: () => void; enforceHomeRpcAdmission?: boolean; refuseHomeOriginalAction?: boolean }> = {}) {
  // Observe the real logger's I/O boundary without replacing transport decisions.
  const log = vi.spyOn(logger, 'debug');
  const phaseLog = vi.spyOn(logger, 'warnLocalFile');
  const rootPath = createGitWorkspace('happier-prepare-');
  onTestFinished(() => removeTempDir(rootPath));
  runGit(rootPath, ['commit', '--allow-empty', '-m', 'base']);
  runGit(rootPath, ['remote', 'add', 'origin', 'https://github.com/prepare/app.git']);
  const baseCommit = runGit(rootPath, ['rev-parse', 'HEAD']);
  const workspace = { id: 'workspace', serverId: 'prepare-home', machineId: 'workspace-daemon', rootPath,
    createdAtMs: 1, repositoryIdentity: repository, source: { sourceId: 'source', revision: 3 } };
  const input = { projectSourceId: 'source', sourceRevision: 3, repository, baseCommit,
    workspace: { kind: 'workspace-ref' as const, serverId: workspace.serverId, id: workspace.id },
    sessionDraft: { executionTarget: { serverId: workspace.serverId, machineId: workspace.machineId },
      directory: { kind: 'path' as const, path: rootPath },
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } };
  let sourceRevision = 3;
  let includeController = false;
  let requireBoundReads = false;
  let denySource = false;
  let machineCustodianAccountId = 'prepare-account';
  let actionsSettings = normalizeActionsSettingsV1({ v: 1, actions: {} });
  let rawSession = { ...createSessionNotificationContextFixture('prepared-session'),
    ...createSessionRecordFixture({ id: 'prepared-session', active: true, encryptionMode: 'plain',
      machineId: workspace.machineId, metadata: JSON.stringify({ machineId: workspace.machineId, path: rootPath }), dataEncryptionKey: null }) };
  const launches: unknown[] = [];
  const birthProofs: SessionActionChildCreationProofV1[] = [];
  const accepted: ReturnType<typeof UserMessageSchema.parse>[] = [];
  const boundReads: BoundRead[] = [];
  const rpcAdmissions: Array<Readonly<{ method: string; kind: string | null; executionParsed: boolean; envelopeParsed: boolean; rootActionId?: string }>> = [];
  const homeRpcAdmission = { enforce: options.enforceHomeRpcAdmission === true,
    refuseOriginalAction: options.refuseHomeOriginalAction === true,
    record: (method: string, kind: string | null, executionParsed: boolean, envelopeParsed: boolean, rootActionId?: string) =>
      rpcAdmissions.push({ method, kind, executionParsed, envelopeParsed, ...(rootActionId ? { rootActionId } : {}) }) };
  const recordReadCustody = (read: typeof boundReads[number]) => {
    if (!requireBoundReads) return;
    boundReads.push(read);
  };
  const environment = createDeploymentEnvironmentHeaderV1({ id: 'staging', serverId: workspace.serverId,
    projectSourceId: 'source', controllerMachineId: 'another-controller' });
  const targetLink = createDeploymentTargetLinkHeaderV1({ environmentId: environment.id });
  const source = () => ({ id: 'source', revision: sourceRevision, name: 'App', audience: [], createdByAccountId: 'prepare-account',
    repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'prepare/app', cloneUrl: 'https://github.com/prepare/app.git' }, protocol: 'https' } });
  vi.spyOn(axios, 'request').mockImplementation(async config => {
    if (config.method === 'GET' && new URL(String(config.url)).pathname === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) {
      return { status: 200, data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
    }
    if (new URL(String(config.url)).pathname === '/v1/home/governance/get') {
      expect(config.method).toBe('POST');
      expect(new URL(String(config.url)).origin).toBe('https://prepare-home.test');
      expect(AxiosHeaders.from(config.headers).get('Authorization')).toBe(`Bearer ${token}`);
      expect(HomeGovernanceGetInputV1Schema.parse(config.data)).toEqual({ projection: 'session_defaults' });
      return { status: 200, data: HomeSessionDefaultsProjectionV1Schema.parse({ homeDefaults: null }) };
    }
    if (config.method === 'POST' && new URL(String(config.url)).pathname === managedMachineActionEndpointPathV1('machines.managed.list')) {
      ManagedListInputV1Schema.parse(config.data);
      return { status: 200, data: ManagedListOutputV1Schema.parse({ machines: [] }) };
    }
    expect(config.method).toBe('GET');
    const url = new URL(String(config.url));
    const read: BoundRead = { headers: config.headers, method: 'GET', path: `${url.pathname}${url.search}`,
      effectActionId: String(config.url).includes('/v1/projects/sources/') ? 'projects.sources.read' : 'deployments.environments.get' };
    recordReadCustody(read);
    if (String(config.url).includes('/v1/deployments/environments/')) return { status: 200, data: { ok: true, environment, targetLinks: [targetLink] } };
    expect(config.url).toBe('https://prepare-home.test/v1/projects/sources/source?serverId=prepare-home');
    if (denySource) return { status: verifiesPrepareRead(read) ? 403 : 401, data: { error: 'forbidden' } };
    options.onSourceRead?.();
    return { status: 200, data: { ok: true, source: source(), canManage: true } };
  });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (String(url).includes('/v2/sessions/prepared-session')) return { status: 200, data: { session: rawSession } };
    if (String(url).includes('/v2/sessions/existing-preparation-session')) return { status: 200,
      data: { session: { ...rawSession, id: 'existing-preparation-session' } } };
    if (String(url).includes('/v1/account/entity-rows/connected-accounts/purposes')) return { status: 200,
      data: ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
        content: sealConnectedAccountCatalogContentV1({ mode: 'plain', material: null,
          record: emptyConnectedAccountCatalogRecordV1('purposes') }) }) };
    if (String(url).includes('/v2/account/settings/history')) return { status: 200, data: { snapshots: [] } };
    if (String(url).includes('/v2/sessions/prepare-caller')) return { status: 200,
      data: { session: { ...createSessionNotificationContextFixture('prepare-caller'),
        ...createSessionRecordFixture({ id: 'prepare-caller', encryptionMode: 'plain', machineId: workspace.machineId,
          metadata: JSON.stringify({ machineId: workspace.machineId, path: rootPath }), dataEncryptionKey: null }) } } };
    if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'prepare-account' } };
    if (String(url).endsWith('/v2/account/settings')) return { status: 200,
      data: { content: { t: 'plain', v: { actionsSettingsV1: actionsSettings } }, version: 1 } };
    if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    const machine = { id: workspace.machineId, kind: 'persistent', active: true,
      installationId: 'workspace-installation', installationPublicKey: publicKey,
      revokedAt: null, replacedByMachineId: null, storageMode: 'plain',
      access: { custodian: { accountId: machineCustodianAccountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    if (String(url).endsWith('/v1/machines')) return { status: 200, data: [machine,
      ...(includeController ? [{ ...machine, id: 'another-controller' }] : [])] };
    if (String(url).endsWith(`/v1/machines/${workspace.machineId}`)) return { status: 200, data: { machine } };
    boundaryErrors.push(`Unexpected read: ${url}`);
    throw new Error(`Unexpected read: ${url}`);
  });
  const dispatched: unknown[] = [];
  const boundaryErrors: string[] = [];
  const prepareDispatches: unknown[] = [];
  const prepareInvocations: unknown[] = [];
  let loseReply = false;
  let messageOutcome: ReturnType<typeof SessionInputAdmissionResultV1Schema.parse> | undefined;
  let nativeRefusal: Extract<SpawnSessionResult, { type: 'error' }> | undefined;
  const sessionTransport: SessionSpawnDirectTargetTransport = { machineId: workspace.machineId,
    readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1, metadata: {} }),
    prepare: (request, options) => prepareSessionCreationTarget({ request, signal: options?.signal }),
    spawnedSession: { spawn: async (options, transport) => {
      launches.push(options);
      const prepareProof = transport?.creationAuthorization?.prepareRequestProof;
      if (prepareProof && options.sessionCreationTag) birthProofs.push(await prepareProof({ tag: options.sessionCreationTag }));
      if (loseReply) throw Object.assign(new Error('Native launch acknowledgement lost'), { code: 'outcome_unknown' });
      if (nativeRefusal) return nativeRefusal;
      rawSession = { ...rawSession, metadata: JSON.stringify(buildCommittedLaunchMetadata({ options, directory: rootPath })) };
      return { type: 'success', sessionId: 'prepared-session',
        sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
    }, resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) },
  };
  const machineAdmissionTransport = async (request: Parameters<NonNullable<Parameters<typeof createCliActionDeps>[0]['machineAdmissionTransport']>>[0]) => {
    accepted.push(UserMessageSchema.parse(openSessionStoredContent({ mode: 'plain', ctx: null, content: request.content })));
    return messageOutcome ? SessionInputAdmissionResultV1Schema.parse({ ...messageOutcome, localId: request.localId })
      : { status: 'accepted' as const, localId: request.localId };
  };
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
    if (String(url) === 'https://prepare-home.test/v2/sessions/lookup-by-tags') {
      SessionLookupByTagsRequestV2Schema.parse(body);
      return { status: 200, data: { sessions: [] } };
    }
    if (String(url) === 'https://prepare-home.test/v2/sessions/prepared-session/pending'
      || String(url) === 'https://prepare-home.test/v2/sessions/existing-preparation-session/pending') {
      if (!body || typeof body !== 'object') throw new Error('Missing pending input');
      const localId = readPendingLocalId(Reflect.get(body, 'localId'));
      if (!localId) throw new Error('Missing pending input identity');
      const content = SessionMessageContentSchema.parse(Reflect.get(body, 'content'));
      accepted.push(UserMessageSchema.parse(openSessionStoredContent({ mode: 'plain', ctx: null, content })));
      if (messageOutcome?.status === 'outcomeUnknown') throw Object.assign(new Error('Input acknowledgement lost'), { code: 'ECONNRESET' });
      return { status: 200, data: { didWrite: messageOutcome?.status !== 'alreadyAccepted', message: { localId } } };
    }
    if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
    if (String(url).includes('/v1/account/project-rows/')) {
      recordReadCustody({ headers: config?.headers, method: 'POST', path: new URL(String(url)).pathname, body,
        effectActionId: 'deployments.prepare' });
      return projectAccountRowsReadHttpResponse([createPlainProjectAccountRefRow(workspace)], String(url), body);
    }
    if (!String(url).startsWith('https://prepare-home.test/v1/actions/')) {
      boundaryErrors.push(`Unexpected POST: ${url}`);
      throw new Error(`Unexpected POST: ${url}`);
    }
    if (!String(url).includes('/v1/actions/deployments.prepare')) {
      dispatched.push(body);
      throw new Error('Prepare children must use the canonical native Session owner');
    }
    const actionId = 'deployments.prepare';
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
    if (String(url).endsWith('/execution-authorization')) return { status: 200, data: { v: 1, token: 'session-proof', binding: {
      accountId: 'prepare-account', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      serverIdentityId: 'prepare-home', custodianAccountId: 'prepare-account', machineId: workspace.machineId,
      installationId: 'workspace-installation', actionId, requestId: 'prepare-request',
      target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
      deploymentPreparationAdmission: projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({ actionId, envelope: request.envelope }),
    } } };
    prepareDispatches.push(request.envelope);
    prepareInvocations.push(openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
      purpose: { kind: 'external_action' }, machineId: workspace.machineId, installationId: 'workspace-installation',
      serverIdentityId: workspace.serverId, installationPrivateKey: installationKeys.secretKey, includeInvocation: true })?.invocation);
    return { status: 200, data: { v: 1, actionId, requestId: 'prepare-request', execution: { ok: true,
      result: { kind: 'handedOff', sessionRef: { serverId: workspace.serverId, sessionId: 'prepared-session' } } } } };
  });
  const execute = async (next: DeploymentPrepareInputV1 = input) => {
    const machineAdmission: SocketRpcMachineAdmissionContextV1 = { actorAccountId: 'prepare-account', custodianAccountId: 'prepare-account',
      machineId: workspace.machineId, installationId: 'workspace-installation', role: 'manage', encryptionMode: 'plain' };
    const native = await createPreparationNativeRpc({ machineAdmission, serverId: workspace.serverId,
      serverHttpBaseUrl: 'https://prepare-home.test', daemonToken: token, privateKey: installationKeys.secretKey });
    const socket = await createRequesterCurrentnessSocketHarness();
    onTestFinished(() => socket.close());
    attachPreparationRpcPeer(socket, machineAdmission, native, homeRpcAdmission);
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: '', mode: 'plain', ctx: null,
      serverId: workspace.serverId, serverIdentityId: 'prepare-home', serverHttpBaseUrl: 'https://prepare-home.test',
      isCredentialCurrent: options.isCredentialCurrent, sessionSpawnDirectTargetTransport: sessionTransport, machineAdmissionTransport,
      machineActionDirectTargetTransport: { machineId: workspace.machineId, invoke: (method, request, options) => native.invokeLocal(method, request, options) } });
    return runWithServerHttpBaseUrl('https://prepare-home.test', () => createActionExecutor(deps).execute('deployments.prepare', next,
    { surface: 'ui', authority: 'present_user', serverId: workspace.serverId, runtimeAccountId: 'prepare-account',
      actionCaller: { kind: 'host' }, actionRequestId: 'prepare-request', signal: options.signal,
      externalActionTarget: { kind: 'machine', machineId: workspace.machineId } }));
  };
  const { sessionDraft: _sessionDraft, ...continuationInput } = input;
  return { input, continuationInput, execute, dispatched, prepareDispatches, prepareInvocations, post, rootPath, environment, targetLink, boundReads, launches, birthProofs, accepted, boundaryErrors, rpcAdmissions,
    targetRefusals: () => log.mock.calls.filter(([message]) => message === '[MachineRPC] exact target refused'),
    phaseRefusals: () => phaseLog.mock.calls.filter(([message]) => message === '[external-action-phase]'),
    executeRoot: (context: ActionExecutorContext) => createActionExecutor(createCliActionDeps({ token,
      credentials: { token, encryption: null }, sessionId: '', mode: 'plain', ctx: null, serverId: workspace.serverId,
      serverIdentityId: workspace.serverId, serverHttpBaseUrl: 'https://prepare-home.test' })).execute('deployments.prepare', input,
      { ...context, surface: 'ui', authority: 'present_user', serverId: workspace.serverId, runtimeAccountId: 'prepare-account',
        actionCaller: { kind: 'host' }, actionRequestId: 'prepare-request',
        externalActionTarget: { kind: 'machine', machineId: workspace.machineId } }),
    setActionsSettings(next: typeof actionsSettings) { actionsSettings = next; },
    useForeignCustodian() { machineCustodianAccountId = 'daemon-owner'; },
    denySource() { denySource = true; }, setSourceRevision(value: number) { sourceRevision = value; },
    admit: async (foreignCustodian = false, next: DeploymentPrepareInputV1 = input, origin?: SessionActionRpcOriginV1,
      workflowOrigin?: ExternalActionExecutionAuthorizationV1['binding']['workflowActionOrigin'],
      getCurrentTurnWorkDepth?: (turnId?: string) => number | undefined) => {
      machineCustodianAccountId = foreignCustodian ? 'daemon-owner' : 'prepare-account';
      const daemonToken = foreignCustodian
        ? `header.${Buffer.from(JSON.stringify({ sub: machineCustodianAccountId })).toString('base64url')}.signature` : token;
      const machineAdmission: SocketRpcMachineAdmissionContextV1 = { actorAccountId: 'prepare-account',
        custodianAccountId: machineCustodianAccountId, machineId: workspace.machineId,
        installationId: 'workspace-installation', role: 'manage', encryptionMode: 'plain' };
      const socket = await createRequesterCurrentnessSocketHarness();
      onTestFinished(() => socket.close());
      const native = await createPreparationNativeRpc({ machineAdmission, serverId: workspace.serverId,
        serverHttpBaseUrl: 'https://prepare-home.test', daemonToken, privateKey: installationKeys.secretKey });
      attachPreparationRpcPeer(socket, machineAdmission, native, homeRpcAdmission);
      let current = true;
      const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'prepare-request',
        target: { kind: 'machine', machineId: workspace.machineId }, input: next });
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'prepare-proof', binding: {
        accountId: 'prepare-account', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
        serverIdentityId: workspace.serverId, custodianAccountId: machineCustodianAccountId, machineId: workspace.machineId,
        installationId: 'workspace-installation', actionId: 'deployments.prepare', requestId: 'prepare-request',
        target: envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('deployments.prepare', next),
        ...(origin ? { sessionActionOrigin: origin,
          sessionActionSource: { machineId: workspace.machineId, installationId: 'workspace-installation' } } : {}),
        ...(workflowOrigin ? { workflowActionOrigin: workflowOrigin } : {}),
      } });
      // Home authorization and HTTP/socket endpoints are the boundaries; the
      // private requester admission, custody, Settings and child dispatch stay real.
      const admitted = await admitRequesterAccountActionContext({ authorization, credentials: { token, encryption: null },
        // Session/Workflow origins belong to their signed binding above. The
        // private invocation box carries only the canonical host/Plugin shape.
        ...(!origin && !workflowOrigin ? { invocation: {
          caller: { kind: 'host' as const }, surface: 'ui' as const, authority: 'present_user' as const,
        } } : {}),
        serverId: workspace.serverId, serverIdentityId: workspace.serverId, serverHttpBaseUrl: 'https://prepare-home.test',
        isCurrent: async () => current });
      if (!admitted) throw new Error('Prepare requester admission unavailable');
      onTestFinished(() => admitted.dispose());
      const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
        serverId: workspace.serverId, serverIdentityId: workspace.serverId, serverHttpBaseUrl: 'https://prepare-home.test',
        target: { kind: 'machine', machineId: workspace.machineId }, installationId: 'workspace-installation',
        privateKey: installationKeys.secretKey, isCurrent: admitted.isCurrent });
      if (!carrier) throw new Error('Prepare requester HTTP custody unavailable');
      requireBoundReads = true;
      const receiver = createCliActionDeps({ token: daemonToken, credentials: { token: daemonToken, encryption: null },
        sessionId: '', mode: 'plain', ctx: null, serverId: workspace.serverId, serverIdentityId: workspace.serverId,
        savedSecretOperationContext: admitted.savedSecretOperationContext,
        isCredentialCurrent: admitted.isCurrent,
        ...(getCurrentTurnWorkDepth ? { getCurrentTurnWorkDepth } : {}),
        externalActionMachineInstallationId: 'workspace-installation', externalActionMachineRequestPrivateKey: installationKeys.secretKey,
        sessionSpawnDirectTargetTransport: sessionTransport, machineAdmissionTransport,
        serverHttpBaseUrl: 'https://prepare-home.test', ...(options.enforceHomeRpcAdmission ? {} : { machineActionDirectTargetTransport: {
          machineId: workspace.machineId, invoke: (method, request, options) => native.invokeLocal(method, request, options),
        } }) });
      const ingress = { machineAdmission, verifyMachineAdmissionCurrent: async () => current };
      return { authorization: carrier, envelope, receiver, ingress, accountSettings: admitted.accountSettingsContext.settings,
        approveAndReplay: async (options: Readonly<{ retainIngress?: boolean; replayAs?: 'differentApproval' | 'differentAccount' }> = {}) => {
          // Artifact persistence and Home HTTP/socket/OS adapters are boundaries.
          // Keep policy, approve/CAS, origin verification, private-port reopening,
          // reviewed-child admission and the native Session adapter real.
          const artifacts = new Map<string, ApprovalRequestV2>();
          const originCurrentness = (credentialsToken: string) =>
            createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
              credentials: { token: credentialsToken, encryption: null }, machineId: workspace.machineId,
              serverId: workspace.serverId, serverApiUrl: 'https://prepare-home.test',
              resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: workspace.machineId,
                serverIdentityId: workspace.serverId }),
            });
          const approvalDeps = {
            ...receiver,
            approvalsCreate: async ({ request }) => {
              const stored = ApprovalRequestV2Schema.parse(structuredClone(request));
              artifacts.set('prepare-review', stored);
              artifacts.set('other-review', structuredClone(stored));
              return { artifactId: 'prepare-review' };
            },
            approvalsGet: async ({ artifactId }) => structuredClone(artifacts.get(artifactId) ?? null),
            approvalsUpdate: async ({ artifactId, request, expectedStatus }) => {
              const previous = artifacts.get(artifactId);
              if (!previous) throw new Error('Missing Prepare approval');
              const parsed = ApprovalRequestV2Schema.parse(request);
              const transition = decideApprovalRequestTransition(previous, parsed, { expectedStatus });
              if (!transition.ok) return transition;
              artifacts.set(artifactId, structuredClone(parsed));
              return { ok: true };
            },
            isApprovalExecutionOriginCurrent: originCurrentness(daemonToken),
            prepareApprovalExecutionAuthorization: createDaemonApprovalExecutionAuthorizationPreparer({
              machineId: workspace.machineId, serverId: workspace.serverId, serverBaseUrl: 'https://prepare-home.test',
              daemonWorkSignal: new AbortController().signal,
              requesterAccountContext: readRequesterAccountActionContext(carrier) ?? undefined,
              resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: workspace.machineId,
                serverIdentityId: workspace.serverId }),
              prepareRequesterAccountContext: request => prepareInstalledRequesterAccountActionContext({ ...request,
                purpose: { kind: 'external_action' },
                machineId: workspace.machineId, serverId: workspace.serverId, serverHttpBaseUrl: 'https://prepare-home.test',
                ownCredentials: { token: daemonToken, encryption: null },
                resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: workspace.machineId,
                  serverIdentityId: workspace.serverId }),
                createExecutor: () => createActionExecutor(receiver),
              }),
            }),
          } satisfies ActionExecutorDeps;
          let replayResult: Awaited<ReturnType<ExternalActionApprovalReplay>> | undefined;
          const executor = createActionExecutor({ ...approvalDeps,
            approvalRequestApprovedReplay: async ({ artifactId, context }) => {
              const accountId = options.replayAs === 'differentAccount' ? 'other-account' : 'prepare-account';
              const replayExecutor = options.replayAs === 'differentAccount' ? createActionExecutor({ ...approvalDeps,
                isApprovalExecutionOriginCurrent: originCurrentness(
                  `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`),
              }) : executor;
              const replayIngress = options.retainIngress !== false
                ? { ...ingress, machineAdmission: { ...machineAdmission, actorAccountId: accountId } } : undefined;
              replayResult = await replayExecutor.replayApprovedApprovalRequest({
                artifactId: options.replayAs === 'differentApproval' ? 'other-review' : artifactId,
                callerAuthority: context.authority,
                currentAccount: { accountId, serverId: workspace.serverId, serverIdentityId: workspace.serverId },
              }, replayIngress);
              return replayResult;
            },
          });
          const context: ActionExecutorContext = { ...ingress, surface: 'cli', authority: 'account_automation',
            serverId: workspace.serverId, serverIdentityId: workspace.serverId, runtimeAccountId: 'prepare-account',
            actionCaller: { kind: 'host' }, actionRequestId: 'prepare-request', defaultSessionMachineId: workspace.machineId,
            originalActionEnvelope: envelope, externalActionTarget: envelope.target, externalActionExecutionAuthorization: carrier,
            signExternalActionApprovalInput: request => signExternalActionApprovalInputV1({ actionId: request.actionId,
              input: request.input, target: request.target, authorizationToken: request.authorization.token,
              privateKey: installationKeys.secretKey }),
          };
          return runWithServerHttpBaseUrl('https://prepare-home.test', async () => {
            const pending = await executor.execute('deployments.prepare', next, context);
            expect(pending, JSON.stringify(pending)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            expect(launches).toEqual([]);
            const decision = await executor.execute('approval.request.decide', { artifactId: 'prepare-review', decision: 'approve' },
              { ...context, surface: 'ui', authority: 'present_user', actionRequestId: 'prepare-decision' });
            return { decision, replayResult, request: ApprovalRequestV2Schema.parse(artifacts.get('prepare-review')) };
          });
        },
        retire() { current = false; }, execute: async () => {
          const result = await runWithServerHttpBaseUrl('https://prepare-home.test', () => createActionExecutor(receiver).execute('deployments.prepare', next,
        { ...ingress, surface: 'ui', authority: 'present_user', serverId: workspace.serverId, runtimeAccountId: 'prepare-account',
          actionCaller: { kind: 'host' }, actionRequestId: 'prepare-request',
          actionsSettings: admitted.accountSettingsContext.settings.actionsSettingsV1, originalActionEnvelope: envelope,
          externalActionTarget: { kind: 'machine', machineId: workspace.machineId },
          externalActionExecutionAuthorization: carrier }));
          return result.ok ? result.result : result;
        } };
    },
    originate: async (requireApproval: boolean) => {
      includeController = true;
      const settings = normalizeActionsSettingsV1({ v: 1, actions: requireApproval
        ? { 'deployments.prepare': { approvalRequiredSurfaces: ['cli'] } } : {} });
      return createCliActionExecutorFromCredentials({ credentials: { token, encryption: null, credentialProvenance: 'stored_session' }, externalActionClient: true,
        serverId: workspace.serverId, serverIdentityId: workspace.serverId, serverApiUrl: 'https://prepare-home.test',
        actionsSettingsProvider: { getActionsSettings: () => settings, getAccountSettings: () => accountSettingsParse({ actionsSettingsV1: settings }) },
      }).execute('deployments.prepare', input, { surface: 'cli', authority: 'present_user', actionRequestId: 'prepare-request' });
    },
    loseReply() { loseReply = true; },
    refuseNativeLaunch(errorCode: Extract<SpawnSessionResult, { type: 'error' }>['errorCode']) {
      nativeRefusal = { type: 'error', errorCode, agentId: 'claude', errorMessage: 'Private native authentication diagnostic' };
    },
    existingSessionChild(result: unknown = { status: 'accepted', localId: 'prepare-existing-input' }) {
      messageOutcome = SessionInputAdmissionResultV1Schema.parse(result);
    },
  };
}

function sessionCallerRegression() {
  it('refuses an unreviewed Session preflight operand under a signed Prepare child', async () => {
    const f = fixture();
    const custody = await f.admit();
    const identity = deriveDeploymentPrepareSessionCreationIdentityV1(custody.authorization.binding);
    const recipe = deriveDeploymentPrepareSessionSpawnInputV1(f.input);
    if (!identity || !recipe) throw new Error('Missing signed Prepare Session recipe');
    const childInput = SessionSpawnNewActionInputV2Schema.parse(recipe);
    const result = await invokeHostReviewedChildV1({ parent: { actionId: 'deployments.prepare', input: f.input },
      context: { ...custody.ingress, runtimeAccountId: 'prepare-account', actionRequestId: identity.requestId,
        originalActionEnvelope: custody.envelope, externalActionTarget: { kind: 'machine', machineId: 'workspace-daemon' },
        externalActionExecutionAuthorization: custody.authorization },
      child: { action: 'session.spawn_new', role: 'prepare-session', input: childInput },
      admittedReview: { action: 'session.spawn_new', role: 'prepare-session', surface: 'agent' },
      execute: async (_input, context) => {
        const reviewedChild = readHostAdmittedReviewedChildV1(context) ?? undefined;
        const review = { authorization: custody.authorization, envelope: custody.envelope, actionId: 'session.spawn_new',
          machineId: 'workspace-daemon', method: RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT, reviewedChild };
        const params = { directory: recipe.directory, prepareAgentIsolationMember: true };
        expect(await isReviewedSessionActionCreationChild({ ...review, params })).toBe(true);
        expect(await isReviewedSessionActionCreationChild({ ...review,
          params: { ...params, sessionCreationTag: identity.sessionCreationTag } })).toBe(false);
        return { ok: true as const, result: {} };
      },
    });
    expect(result).toMatchObject({ ok: true });
  });

  it('binds the full reviewed Prepare recipe before issuing a Session birth proof', async () => {
    const f = fixture();
    const input = { ...f.input, sessionDraft: { ...f.input.sessionDraft, memoryEnabled: true,
      organizationPlacement: { folderId: 'reviewed-folder', tagIds: ['reviewed-tag'] },
      connectedServices: { v: 2 as const, bindingsByServiceId: {
        'happier.agent.claude/anthropic': { source: 'connected' as const, selection: 'profile' as const,
          profileId: '97bd5614-8970-4068-87f2-1447de69d604' },
      } } } };
    const custody = await f.admit(false, input, undefined, { runId: 'prepare-workflow', requestId: 'prepare-request' });
    const identity = deriveDeploymentPrepareSessionCreationIdentityV1(custody.authorization.binding);
    if (!identity) throw new Error('Missing signed Prepare child identity');
    const recipe = deriveDeploymentPrepareSessionSpawnInputV1(input);
    if (!recipe) throw new Error('Missing Prepare Session recipe');
    const childInput = SessionSpawnNewActionInputV2Schema.parse(materializeSessionCreationActionInput('session.spawn_new', recipe,
      { actionRequestId: identity.requestId }));
    const spawn = admitSessionSpawnNewActionInputV2(childInput);
    const unreviewedContext = { ...custody.ingress, runtimeAccountId: 'prepare-account',
      actionRequestId: identity.requestId, originalActionEnvelope: custody.envelope,
      externalActionExecutionAuthorization: custody.authorization };
    expect(createPrepareSessionCreationAuthorization({ context: unreviewedContext, publicInput: spawn,
      installationId: 'workspace-installation', privateKey: installationKeys.secretKey })).toEqual({ ok: false, reason: 'operands_invalid' });
    let entered = false;
    const result = await invokeHostReviewedChildV1({ parent: { actionId: 'deployments.prepare', input },
      context: { ...custody.ingress, runtimeAccountId: 'prepare-account', actionRequestId: identity.requestId,
        originalActionEnvelope: custody.envelope, externalActionTarget: { kind: 'machine', machineId: 'workspace-daemon' },
        externalActionExecutionAuthorization: custody.authorization },
      child: { action: 'session.spawn_new', role: 'prepare-session', input: childInput },
      admittedReview: { action: 'session.spawn_new', role: 'prepare-session', surface: 'agent' },
      execute: async (_input, context) => {
        entered = true;
        const issue = (publicInput: typeof spawn) => createPrepareSessionCreationAuthorization({
          context: { ...context, ...custody.ingress }, publicInput,
          installationId: 'workspace-installation', privateKey: installationKeys.secretKey,
        });
        const allowed = issue(spawn);
        if (!allowed.ok) throw new Error(`Unexpected Prepare authorization refusal: ${allowed.reason}`);
        // The birth proof crosses HTTP as JSON; the admitted requester's host-private custody stays behind.
        const proof = await allowed.authorization.prepareRequestProof!({ tag: identity.sessionCreationTag });
        expect(JSON.parse(JSON.stringify(proof))).toEqual(proof);
        expect(issue({ ...spawn, directory: { kind: 'path', path: join(f.rootPath, 'outside-reviewed-directory') } })).toEqual({ ok: false, reason: 'public_input' });
        expect(issue({ ...spawn, memoryEnabled: false })).toEqual({ ok: false, reason: 'public_input' });
        expect(issue({ ...spawn, organizationPlacement: { folderId: 'unreviewed-folder', tagIds: ['reviewed-tag'] } })).toEqual({ ok: false, reason: 'public_input' });
        expect(issue({ ...spawn, connectedServices: { v: 2, bindingsByServiceId: {} } })).toEqual({ ok: false, reason: 'public_input' });
        const { buildSessionSpawnNewArgs } = await import('@happier-dev/protocol/actions/executor/sessionSpawn');
        const { completeSpawnActionResult } = await import('@happier-dev/protocol/actions/executor/resultProjection');
        const deniedContext = { ...context, ...custody.ingress, machineAdmission: undefined, verifyMachineAdmissionCurrent: undefined };
        const args = buildSessionSpawnNewArgs(spawn, deniedContext);
        if (!args || !custody.receiver.sessionSpawnNew) throw new Error('Missing reviewed Session receiver arguments');
        const refusal = completeSpawnActionResult(await custody.receiver.sessionSpawnNew({ ...args, admittedInput: spawn }));
        expect(refusal).toMatchObject({ ok: false, errorCode: 'permission_denied', effectAttempted: false,
          details: { reason: 'machine_admission_missing' } });
        return { ok: true as const, result: {} };
      },
    });
    expect(result).toMatchObject({ ok: true });
    expect(entered).toBe(true);
    expect(f.launches).toEqual([]);
  });

  it.each([false, true])('hands off a signed Workflow caller without replacing its origin with present-person authority (existing Session: %s)', async existingSession => {
    const f = fixture();
    const settings = normalizeActionsSettingsV1({ v: 1, actions: {},
      approvalWaivedSurfaces: { 'deployments.prepare': ['agent'] } });
    f.setActionsSettings(settings);
    const workflowOrigin = { runId: 'prepare-workflow', requestId: 'prepare-request' };
    const input = existingSession ? { ...f.continuationInput, sessionRef: { serverId: 'prepare-home', sessionId: 'prepared-session' } } : f.input;
    const custody = await f.admit(false, input, undefined, workflowOrigin);
    const authorization = { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const };
    const result = await runWithServerHttpBaseUrl('https://prepare-home.test', () => createActionExecutor(custody.receiver).execute('deployments.prepare', input, {
      ...buildWorkflowActionContext({ runId: workflowOrigin.runId, invocationRecordId: 'prepare-workflow-invocation',
        workDepth: 0, authorization }),
      ...custody.ingress,
      serverId: 'prepare-home', runtimeAccountId: 'prepare-account',
      // Installed ingress carries the admitted Workflow host's start snapshot.
      agentStartContext: { caller: { kind: 'originless', runId: workflowOrigin.runId, runDepth: 0 },
        baseline: { machineId: 'workspace-daemon', directory: f.rootPath },
        roles: {}, ledSubtreeSessionIds: [], callerPermissionCeiling: authorization.admittedPermissionCeiling,
        workDepthLimit: custody.accountSettings.workDepthLimit, allowLists: custody.accountSettings.sessionAgentStartAllowListsV1 },
      sessionAgentSpawnPolicyV1: custody.accountSettings.sessionAgentSpawnPolicyV1,
      actionsSettings: settings, actionRequestId: 'prepare-request', originalActionEnvelope: custody.envelope,
      externalActionTarget: { kind: 'machine', machineId: 'workspace-daemon' },
      externalActionExecutionAuthorization: custody.authorization,
    }));
    expect(result, JSON.stringify({ result, launches: f.launches.length, accepted: f.accepted.length, boundaryErrors: f.boundaryErrors })).toMatchObject({ ok: true, result: { kind: 'handedOff' } });
    expect(custody.authorization.binding.workflowActionOrigin).toEqual(workflowOrigin);
    expect(f.launches).toHaveLength(existingSession ? 0 : 1);
    if (!existingSession) expect(f.launches[0]).toMatchObject({ originRunId: workflowOrigin.runId });
    expect(f.accepted).toHaveLength(1);
    expect(f.accepted[0]?.content.text).toContain(f.input.baseCommit);
    expect(f.accepted[0]?.content.text).toContain('scm.pullRequest.openOrReuse');
    if (existingSession) expect(readSessionInputRequest(f.accepted[0]?.meta)).toMatchObject({
      producer: 'workflow', workflow: { runId: workflowOrigin.runId, invocationRecordId: 'prepare-workflow-invocation', workDepth: 0 },
      permission: { requestedPermissionCeiling: 'default' },
    });
    expect(f.dispatched).toEqual([]);
  });

  it('refuses a copied signed origin without the admitted requester custody', async () => {
    const f = fixture();
    const custody = await f.admit();
    const forged = ExternalActionExecutionAuthorizationV1Schema.parse(custody.authorization);
    const result = await createActionExecutor(custody.receiver).execute('deployments.prepare', f.input, {
      surface: 'agent', authority: 'account_automation', serverId: 'prepare-home', runtimeAccountId: 'prepare-account',
      actionCaller: { kind: 'session', sessionId: 'foreign-session', starterDepth: 0, turnDepth: 1 },
      defaultSessionId: 'foreign-session', actionRequestId: 'prepare-request', originalActionEnvelope: custody.envelope,
      externalActionTarget: { kind: 'machine', machineId: 'workspace-daemon' }, externalActionExecutionAuthorization: forged,
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(f.dispatched).toEqual([]);
  });

  it.each([false, true])('hands off a real Session caller without replacing its origin with present-person authority (existing Session: %s)', async existingSession => {
    const f = fixture();
    const input = existingSession ? { ...f.continuationInput, sessionRef: { serverId: 'prepare-home', sessionId: 'prepared-session' } } : f.input;
    let custody: Awaited<ReturnType<typeof f.admit>> | undefined;
    let readCurrentTurnWorkDepth: ((turnId?: string) => number | undefined) | undefined;
    const settings = normalizeActionsSettingsV1({ v: 1, actions: {},
      approvalWaivedSurfaces: { 'deployments.prepare': ['agent'] } });
    f.setActionsSettings(settings);
    const executeSession = createDaemonSessionAccountActionExecutor({
      serverId: 'prepare-home', serverHttpBaseUrl: 'https://prepare-home.test', token,
      credentials: { token, encryption: null }, machineId: 'workspace-daemon',
      prepareExternalActionAuthorization: async ({ sessionActionOrigin }) => {
        custody = await f.admit(false, input, sessionActionOrigin, undefined, turnId => readCurrentTurnWorkDepth?.(turnId));
        return { authorization: custody.authorization, target: { kind: 'machine', machineId: 'workspace-daemon' } };
      },
      createExecutor: getCurrentTurnWorkDepth => {
        readCurrentTurnWorkDepth = getCurrentTurnWorkDepth;
        if (!custody) throw new Error('Session origin must be admitted before Prepare execution');
        const executor = createActionExecutor(custody.receiver);
        return { execute: (actionId, input, context) => executor.execute(actionId, input, {
          ...context, ...custody!.ingress, runtimeAccountId: 'prepare-account', actionsSettings: custody!.accountSettings.actionsSettingsV1,
          // The authenticated Session ingress, rather than authored Prepare input, owns these facts.
          agentStartContext: { caller: { kind: 'session', sessionId: 'prepare-caller', starterDepth: 0, turnDepth: 1 },
            baseline: { machineId: 'workspace-daemon', directory: f.rootPath }, roles: {}, ledSubtreeSessionIds: [],
            callerPermissionCeiling: 'default', workDepthLimit: custody!.accountSettings.workDepthLimit,
            allowLists: custody!.accountSettings.sessionAgentStartAllowListsV1 },
          sessionAgentSpawnPolicyV1: custody!.accountSettings.sessionAgentSpawnPolicyV1,
          originalActionEnvelope: custody!.envelope,
        }) };
      },
    });
    const result = await runWithServerHttpBaseUrl('https://prepare-home.test', () => executeSession({ kind: 'action.execute', requestId: 'prepare-request',
      actionId: 'deployments.prepare', input,
      witness: { turnId: 'prepare-turn', inputId: 'prepare-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 1,
        callerPermissionMode: 'default', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
        agentStartCaller: { kind: 'session', sessionId: 'prepare-caller', starterDepth: 0, turnDepth: 1 } },
    }, { sessionId: 'prepare-caller', isCurrent: async () => true }));
    expect(result, JSON.stringify({ result, launches: f.launches.length, accepted: f.accepted.length, boundaryErrors: f.boundaryErrors })).toMatchObject({ ok: true, result: { kind: 'handedOff' } });
    expect(f.boundReads.map(read => read.effectActionId)).toEqual(['deployments.prepare', 'projects.sources.read']);
    expect(f.boundReads.every(verifiesPrepareRead)).toBe(true);
    expect(custody?.authorization.binding.sessionActionOrigin?.caller).toEqual({
      kind: 'session', sessionId: 'prepare-caller', starterDepth: 0, turnDepth: 1,
    });
    expect(f.launches).toHaveLength(existingSession ? 0 : 1);
    if (!existingSession) expect(f.launches[0]).toMatchObject({ originSessionId: 'prepare-caller' });
    expect(f.accepted).toHaveLength(1);
    expect(f.accepted[0]?.content.text).toContain(f.input.baseCommit);
    expect(f.accepted[0]?.content.text).toContain('scm.pullRequest.openOrReuse');
    if (existingSession) expect(readSessionInputRequest(f.accepted[0]?.meta)).toMatchObject({
      producer: 'sessionAction', sourceSession: { sourceSessionId: 'prepare-caller', sourceTurnId: 'prepare-turn', sourceInputId: 'prepare-input' },
    });
    expect(f.dispatched).toEqual([]);
  });
}

describe('Prepare routing and signed Account reads', () => {
  it('retains requester constraints and confirmed review at the Prepare root HTTP boundary', async () => {
    const f = fixture();
    const callerInputConstraints = { models: null, permissionModes: ['default' as const] };
    const presentUserConfirmation = { actionId: 'deployments.prepare' as const,
      inputDigest: computeActionInputApprovalDigestV1('deployments.prepare', f.input), requestId: 'prepare-request',
      accountId: 'prepare-account', serverId: 'prepare-home', target: { kind: 'machine' as const, machineId: 'workspace-daemon' } };
    const result = await f.executeRoot({ callerPermissionMode: 'default', callerInputConstraints, presentUserConfirmation });
    expect(result).toMatchObject({ ok: true, result: { kind: 'handedOff' } });
    expect(f.prepareInvocations).toEqual([expect.objectContaining({ callerPermissionMode: 'default', callerInputConstraints,
      presentUserConfirmation })]);
  });
  it.each([false, true])('resolves the exact workspace Machine through the original outer Account factory with two available Machines (Require: %s)', async requireApproval => {
    const f = fixture();
    const result = await f.originate(requireApproval);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'handedOff' } });
    expect(f.prepareDispatches).toEqual([{ v: 1, requestId: 'prepare-request',
      target: { kind: 'machine', machineId: 'workspace-daemon' }, input: f.input }]);
    expect(f.dispatched).toEqual([]);
    expect(f.post.mock.calls.filter(([url]) => String(url).includes('/project-rows/')).map(([, body]) => body))
      .toEqual([{ key: f.input.workspace }]);
  });

  it('keeps signed read purpose on Source denial and refuses retired custody before SCM or Session effects', async () => {
    const f = fixture();
    f.denySource();
    const requester = await f.admit();
    const result = await requester.execute();
    expect(f.boundReads.map(read => read.effectActionId)).toEqual(['deployments.prepare', 'projects.sources.read']);
    expect(f.boundReads.every(verifiesPrepareRead)).toBe(true);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'action_forbidden' });
    requester.retire();
    expect(await requester.execute()).toMatchObject({ ok: false, errorCode: 'action_forbidden' });
    expect(f.boundReads).toHaveLength(2);
    expect(f.dispatched).toEqual([]);
  });

  it('refuses stale Source before native checkout inspection', async () => {
    const f = fixture();
    f.setSourceRevision(4);
    expect(await f.execute()).toEqual({ ok: true, result: { kind: 'conflict', reason: 'source_changed' } });
    expect(f.dispatched).toEqual([]);
  });

  it('rejects a foreign workspace Home before any reads or child dispatch', async () => {
    const f = fixture();
    expect(await f.execute({ ...f.input, workspace: { ...f.input.workspace, serverId: 'foreign-home' } }))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(f.post).not.toHaveBeenCalled();
  });
});

describe('Prepare native workspace to normal Session handoff', () => {
  sessionCallerRegression();
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
  // Real product-build source admission and publication, without mocking SCM.
  beforeAll(async () => {
    runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: {
        pluginIds: ['happier.scm.backend.git', 'happier.scm.forge.github', 'happier.agent.claude', 'happier.agent.codex'],
      },
    });
    expect(runtime.registry.activatedPluginIds.has('happier.scm.forge.github'),
      JSON.stringify(runtime.registry.pluginDiagnosticsByPluginId['happier.scm.forge.github'])).toBe(true);
    expect(runtime.registry.contributes.agentDefinitionsById.get('claude'),
      JSON.stringify(runtime.registry.pluginDiagnosticsByPluginId['happier.agent.claude'])).toBeDefined();
  });
  afterAll(async () => {
    await runtime?.dispose();
  });

  it.each([false, true])('hands an admitted read-only host Prepare/Import to its canonical native Session child (import=%s)', async importTool => {
    const f = fixture();
    const input = { ...f.input, sessionDraft: { ...f.input.sessionDraft, permissionMode: 'read-only' as const },
      ...(importTool ? { importFrom: { tool: 'Docker Compose', configurationPaths: ['compose.yaml'] } } : {}) };
    const result = await (await f.admit(false, input)).execute();
    expect(result, JSON.stringify(f.boundaryErrors)).toMatchObject({ kind: 'handedOff',
      sessionRef: { serverId: 'prepare-home', sessionId: 'prepared-session' } });
    expect(f.launches).toHaveLength(1);
    expect(f.accepted).toHaveLength(1);
    expect(f.accepted[0]?.content.text).toContain(f.input.baseCommit);
    expect(f.dispatched).toEqual([]);
  });

  it.each([false, true])('approves and replays fresh read-only Prepare/Import through native Session birth (import=%s)', async importTool => {
    const f = fixture();
    const input = { ...f.input, sessionDraft: { ...f.input.sessionDraft, permissionMode: 'read-only' as const },
      ...(importTool ? { importFrom: { tool: 'Docker Compose', configurationPaths: ['compose.yaml'] } } : {}) };
    const custody = await f.admit(false, input);
    const result = await custody.approveAndReplay();
    expect(result.request.decision).toMatchObject({ kind: 'approve', authority: 'present_user' });
    expect(result.request.execution, JSON.stringify({ result, boundaryErrors: f.boundaryErrors })).toMatchObject({ ok: true, result: { kind: 'handedOff',
      sessionRef: { serverId: 'prepare-home', sessionId: 'prepared-session' } } });
    expect(f.launches).toHaveLength(1);
    expect(f.accepted).toHaveLength(1);
    const identity = deriveDeploymentPrepareSessionCreationIdentityV1(custody.authorization.binding);
    if (!identity) throw new Error('Missing signed Prepare child identity');
    expect(f.birthProofs).toMatchObject([{ sourceExecution: {
      requestId: identity.requestId, params: { creationKey: identity.creationKey },
    } }]);
  });

  it('retains the native birth refusal cause in the approved Prepare receipt when receiving custody is unavailable', async () => {
    const f = fixture();
    const result = await (await f.admit()).approveAndReplay({ retainIngress: false });
    expect(result.request.execution, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'permission_denied',
      effectAttempted: false, failureCause: { phase: 'session.creation.authorization', errorCode: 'permission_denied' } });
    expect(f.launches).toEqual([]);
    expect(f.accepted).toEqual([]);
  });

  it('keeps a different Prepare approval open when the approved artifact is replaced at replay', async () => {
    const f = fixture();
    const result = await (await f.admit()).approveAndReplay({ replayAs: 'differentApproval' });
    expect(result.request.decision).toMatchObject({ kind: 'approve', authority: 'present_user' });
    expect(result.replayResult).toMatchObject({ ok: true, result: { status: 'open' } });
    expect(result.request.execution).toBeUndefined();
    expect(f.launches).toEqual([]);
    expect(f.accepted).toEqual([]);
  });

  it('refuses Prepare replay under a different Account before Session birth', async () => {
    const f = fixture();
    const result = await (await f.admit()).approveAndReplay({ replayAs: 'differentAccount' });
    expect(result.request.decision).toMatchObject({ kind: 'approve', authority: 'present_user' });
    expect(result.request.execution).toMatchObject({ ok: false, errorCode: 'approval_stale', effectAttempted: false });
    expect(f.launches).toEqual([]);
    expect(f.accepted).toEqual([]);
  });

  it.each([false, true])('replays approved fresh Prepare/Import through Home RPC child admission (import=%s)', async importTool => {
    const f = fixture({ enforceHomeRpcAdmission: true });
    const input = { ...f.input, sessionDraft: { ...f.input.sessionDraft, permissionMode: 'read-only' as const },
      ...(importTool ? { importFrom: { tool: 'Docker Compose', configurationPaths: ['compose.yaml'] } } : {}) };
    const result = await (await f.admit(false, input)).approveAndReplay();
    expect(f.rpcAdmissions, JSON.stringify({ result, targetRefusals: f.targetRefusals(), phaseRefusals: f.phaseRefusals(), execution: result.request.execution, decision: result.decision,
      boundaryErrors: f.boundaryErrors, rpcAdmissions: f.rpcAdmissions })).toContainEqual(expect.objectContaining({
      method: `workspace-daemon:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`,
      executionParsed: true, rootActionId: 'deployments.prepare' }));
    expect(result.request.execution, JSON.stringify({ result, targetRefusals: f.targetRefusals(), phaseRefusals: f.phaseRefusals(), execution: result.request.execution, decision: result.decision,
      boundaryErrors: f.boundaryErrors, rpcAdmissions: f.rpcAdmissions })).toMatchObject({ ok: true,
      result: { kind: 'handedOff', sessionRef: { serverId: 'prepare-home', sessionId: 'prepared-session' } } });
    expect(f.launches).toHaveLength(1);
    expect(f.accepted).toHaveLength(1);
  });

  it('hands off browser Prepare with its authored Session placement through the exact Machine', async () => {
    const f = fixture({ enforceHomeRpcAdmission: true });
    const input = { ...f.input, sessionDraft: { ...f.input.sessionDraft,
      organizationPlacement: { folderId: null, tagIds: [] } } };
    const result = await (await f.admit(false, input)).execute();

    expect(result, JSON.stringify({ result, targetRefusals: f.targetRefusals(), boundaryErrors: f.boundaryErrors }))
      .toMatchObject({ kind: 'handedOff', sessionRef: { serverId: 'prepare-home', sessionId: 'prepared-session' } });
    expect(f.rpcAdmissions).toContainEqual(expect.objectContaining({
      method: `workspace-daemon:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`,
      executionParsed: true, rootActionId: 'deployments.prepare',
    }));
    expect(f.launches).toHaveLength(1);
  });

  it('retains Home original-Action refusal cause and no-effect metadata in the approved Prepare receipt', async () => {
    const f = fixture({ enforceHomeRpcAdmission: true, refuseHomeOriginalAction: true });
    const input = { ...f.input, sessionDraft: { ...f.input.sessionDraft, permissionMode: 'read-only' as const } };
    const result = await (await f.admit(false, input)).approveAndReplay();
    expect(f.rpcAdmissions).toContainEqual(expect.objectContaining({
      method: `workspace-daemon:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`,
      executionParsed: true, envelopeParsed: true, kind: 'child' }));
    expect(result.request.execution, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'permission_denied',
      failureCause: { phase: 'rpc.admission.original_action', errorCode: RPC_ERROR_CODES.FORBIDDEN }, effectAttempted: false });
    expect(f.launches).toEqual([]);
    expect(f.accepted).toEqual([]);
  });

  it('starts Prepare with the authored Agent and Connected Account instead of silently using Claude', async () => {
    const f = fixture();
    const sessionDraft = {
      executionTarget: { serverId: f.input.workspace.serverId, machineId: 'workspace-daemon' },
      directory: { kind: 'path' as const, path: f.rootPath },
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      connectedServices: { v: 2 as const, bindingsByServiceId: {
        'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'profile' as const,
          profileId: '97bd5614-8970-4068-87f2-1447de69d604' },
      } },
    };
    const result = await f.execute({ ...f.input, sessionDraft });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'handedOff' } });
    expect(f.launches).toMatchObject([{ backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      connectedServices: sessionDraft.connectedServices }]);
    expect(f.accepted[0]?.content.text).toContain('Prepare this repository');
    expect(f.accepted[0]?.content.text).not.toContain('97bd5614-8970-4068-87f2-1447de69d604');
  });

  it.each(['machine', 'home', 'directory'] as const)('refuses a recipe moved away from the reviewed workspace (%s) before Session effects', async changed => {
    const f = fixture();
    const draft = f.input.sessionDraft;
    const sessionDraft = { ...draft,
      executionTarget: { ...draft.executionTarget,
        ...(changed === 'machine' ? { machineId: 'another-machine' } : {}),
        ...(changed === 'home' ? { serverId: 'foreign-home' } : {}) },
      ...(changed === 'directory' ? { directory: { kind: 'path' as const, path: f.rootPath + '-sibling' } } : {}) };
    expect(await f.execute({ ...f.input, sessionDraft })).toMatchObject({ ok: true,
      result: { kind: 'conflict', reason: 'input_changed' } });
    expect(f.dispatched).toEqual([]);
  });

  it('admits the optional target scope once and keeps the Session on the workspace Machine', async () => {
    const f = fixture();
    const input = { ...f.input, target: { environmentId: f.environment.id, targetLinkId: f.targetLink.id,
      expectedTargetLinkRevision: f.targetLink.revision + 1 } };
    // Real executor entry resolves its configurable approval scope once; the
    // Session child consumes that admission and keeps the workspace placement.
    const receiver = await f.admit(false, input);
    expect(await receiver.execute()).toMatchObject({ kind: 'handedOff' });
    expect(vi.mocked(axios.request).mock.calls.filter(([config]) => String(config.url).includes('/v1/deployments/')))
      .toHaveLength(1);
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0]).toMatchObject({ directory: f.rootPath });
  });

  it('hands a personal Source without an Environment to the admitted workspace Session and settles with its ref', async () => {
    const f = fixture();
    const result = await f.execute();
    expect(result).toEqual({ ok: true, result: { kind: 'handedOff', sessionRef: { serverId: 'prepare-home', sessionId: 'prepared-session' } } });
    if (!result.ok) throw new Error('Expected handoff');
    expect(DeploymentPrepareResultV1Schema.safeParse(result.result).success).toBe(true);
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0]).toMatchObject({ directory: f.rootPath });
    const encoded = JSON.stringify(f.accepted[0]);
    expect(encoded).toContain(f.input.baseCommit);
    expect(encoded).toContain('scm.remote.push');
    expect(encoded).toContain('scm.pullRequest.openOrReuse');
    expect(encoded).not.toContain(token);
    expect(f.post.mock.calls.filter(([url]) => String(url).includes('/project-rows/')).map(([, body]) => body))
      .toEqual([{ key: f.input.workspace }]);
  });

  it('checks the admitted handoff once while later Session admission remains with its owner', async () => {
    let admissionReads = 0;
    const f = fixture({ isCredentialCurrent: () => ++admissionReads === 1 });
    expect(await f.execute()).toMatchObject({ ok: true, result: { kind: 'handedOff' } });
    expect(admissionReads).toBe(1);
    expect(f.launches).toHaveLength(1);
  });

  it('keeps local cancellation after Source inspection without dispatching a Session', async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal, onSourceRead: () => controller.abort() });
    expect(await f.execute()).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(f.dispatched).toEqual([]);
  });

  it.each([
    { error: Object.assign(new Error('Private Prepare diagnostic bearer=prepare-secret'),
      { code: 'project_account_rows_unavailable', response: { status: 503 } }),
      errorCode: 'project_account_rows_unavailable', errorClass: 'Error', httpStatus: 503 },
    { error: new TypeError('Private Prepare diagnostic bearer=prepare-secret'),
      errorCode: 'action_failed', errorClass: 'TypeError', httpStatus: null },
  ])('retains the original Prepare exception cause through Action settlement ($errorCode)', async ({ error, errorCode, errorClass, httpStatus }) => {
    const f = fixture();
    // Home HTTP is the system boundary; keep admitted row reads, Prepare and
    // the public Action result projection real beneath this failed request.
    f.post.mockRejectedValueOnce(error);
    const result = await f.execute();
    expect(result).toMatchObject({ ok: false, errorCode, failureCause: {
      phase: 'deployments.prepare', errorClass, httpStatus,
      errorCode: 'code' in error ? error.code : null,
    } });
    expect(JSON.stringify(result)).not.toContain('prepare-secret');
    expect(JSON.stringify(result)).not.toContain('Private Prepare diagnostic');
    expect(f.dispatched).toEqual([]);
  });

  it('retains the independent disclosure refusal for a genuine foreign custodian without creating a Session', async () => {
    const f = fixture();
    f.useForeignCustodian();
    const result = await f.executeRoot({});
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'requester_credential_disclosure_required' });
    expect(f.dispatched).toEqual([]);
    expect(f.launches).toEqual([]);
    expect(f.prepareDispatches).toEqual([]);
  });

  it('hands imported configuration references to the normal new Session without reading configuration values', async () => {
    const f = fixture();
    const importFrom = { tool: 'Existing app manager', configurationPaths: ['deploy/app.json', 'compose.previous.yaml'] };
    const input = { ...f.input, importFrom };
    expect(await f.execute(input)).toMatchObject({ ok: true, result: { kind: 'handedOff' } });
    expect(f.accepted[0]?.content.text).toContain(JSON.stringify({ ...input, sessionDraft: undefined }));
    expect(f.launches).toHaveLength(1);
    expect(f.prepareDispatches).toEqual([]);
  });

  it.each([{ status: 'accepted', signed: false }, { status: 'alreadyAccepted', signed: true }] as const)(
    'continues the exact existing Session through ordinary message admission ($status; signed=$signed)', async ({ status, signed }) => {
    const f = fixture();
    f.existingSessionChild({ status, localId: 'prepare-existing-input' });
    const sessionRef = { serverId: 'prepare-home', sessionId: 'existing-preparation-session' };
    const input = { ...f.continuationInput, sessionRef };
    const result = signed ? await (await f.admit(false, input)).execute() : await f.execute(input);
    expect(result).toEqual(signed ? { kind: 'handedOff', sessionRef } : { ok: true, result: { kind: 'handedOff', sessionRef } });
    if (signed) {
      expect(f.boundReads.map(read => read.effectActionId)).toEqual(['deployments.prepare', 'projects.sources.read']);
      expect(f.boundReads.every(verifiesPrepareRead)).toBe(true);
    }
    expect(f.launches).toHaveLength(0);
    expect(f.accepted).toHaveLength(1);
    expect(f.accepted[0]?.content.text).toContain(f.input.baseCommit);
  });

  it('preserves an existing Session input acknowledgement loss without spawning a replacement', async () => {
    const f = fixture();
    const sessionRef = { serverId: 'prepare-home', sessionId: 'existing-preparation-session' };
    f.existingSessionChild({ status: 'outcomeUnknown', localId: 'prepare-existing-input', code: 'transport_unavailable' });
    expect(await f.execute({ ...f.continuationInput, sessionRef })).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    expect(f.launches).toHaveLength(0);
    expect(f.accepted).toHaveLength(1);
  });

  it('rejects an existing Session from a different Home before handoff', async () => {
    const f = fixture();
    expect(await f.execute({ ...f.continuationInput, sessionRef: { serverId: 'foreign-home', sessionId: 'foreign-session' } }))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(f.dispatched).toEqual([]);
  });

  it('refuses inline import configuration values rather than placing them in Session input', async () => {
    const f = fixture();
    const input = { ...f.input, importFrom: { tool: 'Previous manager', configurationPaths: ['app.json'],
      configuration: { password: 'must-not-enter-a-session' } } };
    expect(await f.execute(input)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(f.dispatched).toEqual([]);
  });

  it('refuses changed local base before dispatching a Session', async () => {
    const f = fixture();
    runGit(f.rootPath, ['commit', '--allow-empty', '-m', 'concurrent base']);
    expect(await f.execute()).toEqual({ ok: true, result: { kind: 'conflict', reason: 'base_changed' } });
    expect(f.dispatched).toEqual([]);
  });

  it('preserves a native Session launch refusal without retrying the handoff', async () => {
    const f = fixture();
    f.refuseNativeLaunch(SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED);
    expect(await f.execute()).toMatchObject({ ok: false, errorCode: 'spawn_failed',
      details: { type: 'error', launchError: { code: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED } } });
    expect(f.launches).toHaveLength(1);
    expect(f.accepted).toHaveLength(0);
  });

  it.each(['agent_signed_out', 'agent_cli_missing'] as const)('retains the typed Session child refusal (%s)', async code => {
    const f = fixture();
    f.refuseNativeLaunch(code);
    const result = await f.execute();
    expect(result).toMatchObject({ ok: false, errorCode: code, error: code,
      details: { type: 'error', code, retryable: false, agentId: 'claude' } });
    if (code === 'agent_signed_out') expect(result).toMatchObject({ details: { launchError: {
      kind: 'launch_error', code, failureCause: { phase: 'authentication', failureReason: 'authentication_required' },
    } } });
    expect(JSON.stringify(result)).not.toContain('Private native authentication diagnostic');
    expect(f.launches).toHaveLength(1);
    expect(f.accepted).toHaveLength(0);
  });

  it('keeps Dockerfile-only Prepare on the workspace daemon when the target Environment controller differs', async () => {
    const f = fixture();
    writeFileSync(join(f.rootPath, 'Dockerfile'), 'FROM scratch\nCOPY app /app\nENTRYPOINT ["/app"]\n');
    runGit(f.rootPath, ['add', 'Dockerfile']);
    runGit(f.rootPath, ['commit', '-m', 'Dockerfile-only app']);
    const baseCommit = runGit(f.rootPath, ['rev-parse', 'HEAD']);
    expect(readdirSync(f.rootPath).filter(file => /^(?:docker-)?compose\.ya?ml$/.test(file))).toEqual([]);
    expect(await f.execute({ ...f.input, baseCommit, target: { environmentId: f.environment.id,
      targetLinkId: f.targetLink.id, expectedTargetLinkRevision: f.targetLink.revision } }))
      .toMatchObject({ ok: true, result: { kind: 'handedOff' } });
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0]).toMatchObject({ directory: f.rootPath });
    expect(f.prepareDispatches).toEqual([]);
  });

  it('preserves the Session owner unknown birth outcome without repeating the create', async () => {
    const f = fixture();
    f.loseReply();
    expect(await f.execute()).toEqual({ ok: true, result: { kind: 'partial', reason: 'child_failed',
      childOperationRefs: [] } });
    expect(f.launches).toHaveLength(1);
    expect(f.accepted).toHaveLength(0);
  });

  it('retains the born Session when initial input acknowledgement is unknown', async () => {
    const f = fixture();
    f.existingSessionChild({ status: 'outcomeUnknown', localId: 'prepare-new-input', code: 'transport_unavailable' });
    expect(await f.execute()).toEqual({ ok: true, result: { kind: 'partial', reason: 'child_failed',
      sessionRef: { serverId: 'prepare-home', sessionId: 'prepared-session' }, childOperationRefs: [] } });
    expect(f.launches).toHaveLength(1);
    expect(f.accepted).toHaveLength(1);
  });

});

describe('Prepare Session source through the canonical SCM PR owner', () => {
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
  beforeAll(async () => {
    runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.scm.backend.git', 'happier.scm.forge.github', 'happier.agent.claude'] } });
    expect(runtime.registry.contributes.agentDefinitionsById.get('claude'),
      JSON.stringify(runtime.registry.pluginDiagnosticsByPluginId['happier.agent.claude'])).toBeDefined();
  });
  afterAll(async () => { await runtime?.dispose(); });

  it.each([
    { forgeState: 'available', importTool: false, validation: 'unavailable' },
    { forgeState: 'authentication-refused', importTool: false, validation: 'unavailable' },
    { forgeState: 'available', importTool: true, validation: 'unavailable' },
    { forgeState: 'available', importTool: false, validation: 'ownServer' },
    { forgeState: 'available', importTool: false, validation: 'movedHead' },
  ] as const)('admits a Session-authored proposal with head-bound validation evidence (forge=$forgeState; import=$importTool; validation=$validation)', async ({ forgeState, importTool, validation }) => {
    const accountId = 'prepare-pr-account';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const serverId = 'prepare-pr-home';
    const machineId = 'prepare-pr-machine';
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
    const sessionId = 'cmv3prepareprsessionaaaaa';
    const rootPath = createGitWorkspace('happier-prepare-pr-');
    const remote = createBareGitRemoteFixture('happier-prepare-pr-remote-');
    onTestFinished(async () => { await removeTempDir(rootPath); await removeTempDir(remote.remotePath); });
    const dockerfile = 'FROM node:22-alpine\nWORKDIR /app\nCOPY app.js /app/app.js\nCMD ["node", "app.js"]\n';
    // The fixture already has valid build instructions; Prepare must retain them.
    execFileSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', join(rootPath, 'Dockerfile'), dockerfile]);
    runGit(rootPath, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    runGit(rootPath, ['add', 'Dockerfile']);
    runGit(rootPath, ['commit', '-m', 'Dockerfile-only app']);
    const baseCommit = runGit(rootPath, ['rev-parse', 'HEAD']);
    runGit(rootPath, ['remote', 'add', 'origin', 'https://github.com/prepare/app.git']);
    runGit(rootPath, ['push', remote.remotePath, 'main']);
    runGit(rootPath, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    runGit(rootPath, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'prepare/app' };
    const workspace = { id: 'prepare-pr-workspace', serverId, machineId, rootPath, createdAtMs: 1,
      repositoryIdentity: repository, source: { sourceId: 'prepare-pr-source', revision: 1 } };
    const input = { projectSourceId: workspace.source.sourceId, sourceRevision: workspace.source.revision,
      repository, baseCommit, ...(importTool ? { importFrom: { tool: 'Existing app manager',
        configurationPaths: ['deploy.previous.json'] } } : {}), workspace: { kind: 'workspace-ref' as const, serverId, id: workspace.id },
      sessionDraft: { executionTarget: { serverId, machineId }, directory: { kind: 'path' as const, path: rootPath },
        agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } };
    let rawSession = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain', machineId,
      metadata: JSON.stringify({ machineId, path: rootPath }), dataEncryptionKey: null });
    const accepted: ReturnType<typeof UserMessageSchema.parse>[] = [];
    const preparationSocket = await createRequesterCurrentnessSocketHarness();
    onTestFinished(() => preparationSocket.close());
    const machineAdmission: SocketRpcMachineAdmissionContextV1 = { actorAccountId: accountId, custodianAccountId: accountId,
      machineId, installationId: 'prepare-pr-installation', role: 'manage', encryptionMode: 'plain' };
    const nativeRpc = await createPreparationNativeRpc({ machineAdmission, serverId,
      serverHttpBaseUrl: 'https://prepare-pr-home.test', daemonToken: token, privateKey: installation.secretKey });
    attachPreparationRpcPeer(preparationSocket, machineAdmission, nativeRpc);
    let launches = 0;
    let purposeReads = 0;
    const spawnDeps = createCliActionDeps({ token, credentials, sessionId: '', mode: 'plain', ctx: null, serverId,
      serverHttpBaseUrl: 'https://prepare-pr-home.test',
      machineActionDirectTargetTransport: { machineId, invoke: (method, request, options) => nativeRpc.invokeLocal(method, request, options) },
      sessionSpawnDirectTargetTransport: { machineId,
        prepare: (request, options) => prepareSessionCreationTarget({ request, signal: options?.signal }),
        // Runner launch and Home persistence are external boundaries. The actual
        // creator composes metadata, checks correspondence and admits the input.
        spawnedSession: { spawn: async options => {
          launches++;
          rawSession = { ...rawSession, metadata: JSON.stringify(buildCommittedLaunchMetadata({ options, directory: rootPath })) };
          return { type: 'success', sessionId,
            sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
        }, resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) },
      },
      machineAdmissionTransport: async request => {
        accepted.push(UserMessageSchema.parse(openSessionStoredContent({ mode: 'plain', ctx: null, content: request.content })));
        return { status: 'accepted', localId: request.localId };
      },
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/entity-rows/connected-accounts/purposes') { purposeReads++; return { status: 200,
        data: ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
          content: sealConnectedAccountCatalogContentV1({ mode: 'plain', material: null,
            record: emptyConnectedAccountCatalogRecordV1('purposes') }) }) }; }
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      const machine = { id: machineId, kind: 'persistent', active: true, installationId: 'prepare-pr-installation',
        installationPublicKey: Buffer.from(installation.publicKey).toString('base64'), revokedAt: null, replacedByMachineId: null,
        storageMode: 'plain', access: { custodian: { accountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
      if (path === '/v1/machines') return { status: 200, data: [machine] };
      if (path === `/v1/machines/${machineId}`) return { status: 200, data: { machine } };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: rawSession } };
      throw new Error(`Unexpected Home GET ${path}`);
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => String(url).endsWith('/v1/account/profile')
      ? Response.json({ id: accountId }) : String(url).endsWith('/features') ? Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {
        serverIdentity: { serverIdentityId: serverId }, encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' },
      } })) : Promise.reject(new Error('Unexpected fetch path: ' + new URL(String(url)).pathname))));
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      if (new URL(String(config.url)).pathname === '/v1/home/governance/get') {
        expect(config.method).toBe('POST');
        expect(new URL(String(config.url)).origin).toBe('https://prepare-pr-home.test');
        expect(AxiosHeaders.from(config.headers).get('Authorization')).toBe(`Bearer ${token}`);
        expect(HomeGovernanceGetInputV1Schema.parse(config.data)).toEqual({ projection: 'session_defaults' });
        return { status: 200, data: HomeSessionDefaultsProjectionV1Schema.parse({ homeDefaults: null }) };
      }
      expect(config.method).toBe('GET');
      expect(new URL(String(config.url)).pathname).toBe(`/v1/projects/sources/${workspace.source.sourceId}`);
      return { status: 200, data: { ok: true, canManage: true, source: { id: workspace.source.sourceId, revision: 1,
        name: 'Prepare app', audience: [], createdByAccountId: accountId,
        repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
          repository: { nameWithOwner: 'prepare/app', cloneUrl: 'https://github.com/prepare/app.git' }, protocol: 'https' } } } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
      if (path.includes('/v1/account/project-rows/')) return projectAccountRowsReadHttpResponse([createPlainProjectAccountRefRow(workspace)], String(url), body);
      if (path.endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
      if (path === '/v2/sessions/' + sessionId + '/pending') {
        if (!body || typeof body !== 'object') throw new Error('Expected Pending input request');
        const content = SessionMessageContentSchema.parse(Reflect.get(body, 'content'));
        accepted.push(UserMessageSchema.parse(openSessionStoredContent({ mode: 'plain', ctx: null, content })));
        return { status: 200, data: { didWrite: true, terminal: false, suppressed: false } };
      }
      throw new Error(`Unexpected Home POST ${path}`);
    });
    const handoff = await runWithServerHttpBaseUrl('https://prepare-pr-home.test', () => createActionExecutor(spawnDeps).execute('deployments.prepare', input,
      { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: accountId, actionCaller: { kind: 'host' },
        actionRequestId: 'prepare-pr-request', externalActionTarget: { kind: 'machine', machineId } }));
    expect(handoff, JSON.stringify({ handoff, launches, acceptedInputs: accepted.length }))
      .toEqual({ ok: true, result: { kind: 'handedOff', sessionRef: { serverId, sessionId } } });
    expect(launches).toBe(1);
    expect(purposeReads).toBeGreaterThan(0);
    expect(accepted).toHaveLength(1);
    expect(runGit(rootPath, ['rev-parse', 'HEAD'])).toBe(baseCommit);
    const brief = accepted[0]!.content.text;
    const selection = JSON.parse(brief.match(/```json\s*([\s\S]*?)```/)?.[1] ?? 'null');
    const { sessionDraft: _sessionDraft, ...sourceIntent } = input;
    expect(selection).toEqual(sourceIntent);
    expect(selection).not.toHaveProperty('sessionDraft');
    if (importTool) {
      // The Agent consumes a public Action reference, not a private native recipe.
      const restoreActionId = brief.match(/\bdeployments\.backups\.\w+\b/u)?.[0];
      const restoreSpec = listActionSpecsForSurface('agent').find(spec => spec.id === restoreActionId);
      expect(restoreSpec, 'Import handoff must name the admitted public restore Action').toMatchObject({
        id: 'deployments.backups.restore', safety: 'danger', sideEffectClass: 'write', approvalScope: 'environment',
      });
    }

    // Restore fetch before the real HTTP forge. Only Home HTTP, Agent process
    // and the forge credential store are substituted; SCM internals stay real.
    vi.unstubAllGlobals();
    const pullRequests: Array<Record<string, unknown>> = [];
    let creations = 0;
    let forgePostRequests = 0;
    const forge = createServer(async (request, response) => {
      expect(request.headers.authorization).toBe('Bearer synthetic-forge-token');
      if (request.method === 'POST') forgePostRequests++;
      if (request.method === 'POST' && forgeState === 'authentication-refused') {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'Bad credentials' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.method === 'POST') {
        let text = ''; for await (const chunk of request) text += Buffer.from(chunk).toString();
        const draft = JSON.parse(text) as Record<string, unknown>;
        const pr = { number: 17, title: draft.title, body: draft.body, state: 'open', draft: false,
          html_url: 'https://github.com/prepare/app/pull/17', base: { ref: 'main', sha: baseCommit },
          head: { ref: 'prepare/deployment', sha: runGit(remote.remotePath, ['rev-parse', 'refs/heads/prepare/deployment']), repo: { full_name: 'prepare/app' } } };
        pullRequests.push(pr); creations++; response.end(JSON.stringify(pr));
      } else response.end(JSON.stringify(pullRequests));
    });
    await new Promise<void>(resolve => forge.listen(0, '127.0.0.1', resolve));
    onTestFinished(async () => { forge.closeAllConnections(); await new Promise<void>((resolve, reject) => forge.close(error => error ? reject(error) : resolve())); });
    const address = forge.address();
    if (!address || typeof address === 'string') throw new Error('Forge did not listen');
    const providerRegistry = createScmHostingProviderRegistry({ providers: [{ id: 'github', pluginId: 'happier.scm.forge.github',
      kind: 'github', displayName: 'GitHub', capabilities: ['detect', 'pullRequest'], authService: 'github-account' }],
      runtimeRegistrations: [{ pluginId: 'happier.scm.forge.github', occurrenceId: 'prepare-pr-forge', registration: {
        id: 'github', adapter: { routing: createGithubScmHostingProviderAdapter(), pullRequests: createGithubRestAdapter({
          fetcher: (url, init) => fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}${new URL(url).search}`, init),
        }) },
      } }] });
    // Genuine OS/process boundary: host Git push retains its private metadata
    // view and upstream policy; only the external receiver is local to the test.
    const actualSpawn = childProcess.spawn;
    vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
      const isGit = /(?:^|[/\\])git(?:\.exe)?$/.test(command);
      return actualSpawn(command, isGit && isHostGitPush({ bin: 'git', args: [...(args ?? [])] })
        ? ['-c', 'remote.origin.pushurl=' + remote.remotePath, ...(args ?? [])] : isGit && args?.includes('fetch')
          ? ['-c', 'remote.origin.url=' + remote.remotePath, ...args.map(arg => arg === 'https://github.com/prepare/app.git' ? remote.remotePath : arg)] : args, options);
    });
    syncBuiltinESMExports();
    const registry = createDeploymentGitRegistry({ resolveScmHostingProviderRegistry: async () => providerRegistry,
      resolveScmHostingTokenMaterialization: async () => ({ kind: 'available', token: 'synthetic-forge-token' }) });
    const actions: string[] = [];
    const scm = createActionExecutor({ scmActionExecute: async args => {
      actions.push(args.actionId);
      return executeScmActionOperation({ actionId: args.actionId, input: args.input, registry, workingDirectory: rootPath,
        sessionId, actionContext: args.context, executeCanonicalAction: args.executeCanonicalAction });
    } });
    const perform = async (actionId: ScmActionId, actionInput: unknown) => {
      const result = await scm.execute(actionId, actionInput, { surface: 'ui', authority: 'present_user', serverId,
        defaultSessionId: sessionId, runtimeAccountId: accountId, actionCaller: { kind: 'host' } });
      expect(result, actionId + ": " + JSON.stringify(result)).toMatchObject({ ok: true, result: { success: true } });
      return result;
    };
    const provider: AgentSessionRuntime = { async send(request) {
      expect(JSON.stringify(request)).toContain(JSON.stringify(brief));
      await perform('scm.branch.create', { cwd: rootPath, name: 'prepare/deployment', startPoint: baseCommit, checkout: true });
      // A deterministic substitute for the external Agent process authors the
      // files. This checks host/SCM semantics, not model reasoning or validation.
      execFileSync(process.execPath, ['-e', `const fs=require('node:fs'),p=require('node:path');
        for (const [name,text] of Object.entries(JSON.parse(process.argv[2]))) fs.writeFileSync(p.join(process.argv[1],name),text);`, rootPath,
        JSON.stringify({
          'app.js': 'require("node:http").createServer((q,s)=>s.end("ok")).listen(8080);\n',
          'compose.yaml': 'services:\n  app:\n    build: .\n    ports: ["8080:8080"]\n    healthcheck:\n      test: ["CMD", "node", "-e", "fetch(\'http://127.0.0.1:8080\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]\n',
        })]);
      await perform('scm.commit.create', { cwd: rootPath, message: 'Propose deployment source', scope: { kind: 'all-pending' } });
      // Redirect only the Git transport to its local bare boundary. The logical
      // hosted Source selection is unchanged before handoff and PR inspection.
      await perform('scm.remote.push', { cwd: rootPath, remote: 'origin', branch: 'prepare/deployment' });
      let head = runGit(rootPath, ['rev-parse', 'HEAD']);
      const reviewedHead = head;
      let validationSummary = validation === 'unavailable'
        ? 'Validation unavailable: no reviewed validation target. No merge or Production deployment requested.'
        : await validatePreparedDeploymentHead({ sha: reviewedHead, runtime, installation, credentials, serverId, machineId, accountId, workspace });
      if (validation === 'movedHead') {
        writeFileSync(join(rootPath, 'app.js'), readFileSync(join(rootPath, 'app.js'), 'utf8') + '// Changed after validation\n');
        await perform('scm.commit.create', { cwd: rootPath, message: 'Advance the proposal after reviewed validation', scope: { kind: 'all-pending' } });
        await perform('scm.remote.push', { cwd: rootPath, remote: 'origin', branch: 'prepare/deployment' });
        head = runGit(rootPath, ['rev-parse', 'HEAD']);
        expect(head).not.toBe(reviewedHead);
        validationSummary = `Validation unavailable: pushed head moved from ${reviewedHead} to ${head}. Renew review and validation.`;
      }
      const prInput = { cwd: rootPath, base: 'main', head: 'prepare/deployment', title: 'Prepare app for deployment',
        body: `Configuration proposed at ${head}. ${validationSummary}` };
      if (forgeState === 'available') {
        expect(await perform('scm.pullRequest.openOrReuse', prInput)).toMatchObject({ result: { result: 'created', pullRequest: { headSha: head, state: 'open' } } });
        expect(await perform('scm.pullRequest.openOrReuse', prInput)).toMatchObject({ result: { result: 'reused', pullRequest: { headSha: head, state: 'open' } } });
      } else {
        expect(await scm.execute('scm.pullRequest.openOrReuse', prInput, { surface: 'ui', authority: 'present_user', serverId,
          defaultSessionId: sessionId, runtimeAccountId: accountId, actionCaller: { kind: 'host' } }))
          .toMatchObject({ ok: true, result: { success: false, errorCode: 'REMOTE_AUTH_REQUIRED' } });
      }
      return { status: 'admitted' };
    }, watch: () => ({ dispose() {} }), dispose() {} };
    const native = createNativeAgentSessionOperations(provider, sessionId, undefined, undefined, undefined, undefined, undefined,
      { context: {} as AgentSessionRuntimeContext, // This boundary Agent uses no SDK services.
        cwd: rootPath, connectedAccounts: [], capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
        cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null } });
    onTestFinished(() => native.resetOrDisposeRuntime());
    await native.sendTurnPrompt(brief, { localId: 'prepare-pr-input', turnId: 'prepare-pr-turn',
      agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 } });
    expect(readFileSync(join(rootPath, 'Dockerfile'), 'utf8')).toBe(dockerfile);
    const head = runGit(rootPath, ['rev-parse', 'HEAD']);
    expect(head).not.toBe(baseCommit);
    expect(runGit(remote.remotePath, ['rev-parse', 'refs/heads/prepare/deployment'])).toBe(head);
    expect(runGit(remote.remotePath, ['rev-parse', 'refs/heads/main'])).toBe(baseCommit);
    expect(runGit(rootPath, ['diff', '--name-only', 'main...HEAD']).split('\n')).toEqual(['app.js', 'compose.yaml']);
    expect(forgePostRequests).toBe(1);
    expect(creations).toBe(forgeState === 'available' ? 1 : 0);
    if (forgeState === 'available') expect(pullRequests[0]).toMatchObject({ state: 'open', head: { sha: head },
      body: expect.stringContaining('Configuration proposed at ' + head + '. ' + (validation === 'ownServer' ? 'Validation succeeded:' : 'Validation unavailable:')) });
    else expect(pullRequests).toEqual([]);
    if (validation === 'movedHead') {
      expect(pullRequests[0]?.body).toContain('Validation unavailable: pushed head moved');
      expect(pullRequests[0]?.body).not.toContain('Validation succeeded:');
    }
    expect(actions).toEqual(['scm.branch.create', 'scm.commit.create', 'scm.remote.push',
      ...(validation === 'movedHead' ? ['scm.commit.create', 'scm.remote.push'] : []), 'scm.pullRequest.openOrReuse',
      ...(forgeState === 'available' ? ['scm.pullRequest.openOrReuse'] : [])]);
    expect(JSON.stringify({ brief, pullRequests })).not.toContain(token);
    expect(JSON.stringify({ brief, pullRequests })).not.toContain('synthetic-forge-token');
    // Validation text uses the actual deploy receipt for the reviewed head. Docker IO is a boundary fixture, not external-engine qualification.
    // Reuse the owning native integration harness: review, build and activation each get its existing 60s test budget.
  }, 3 * 60_000);
});
