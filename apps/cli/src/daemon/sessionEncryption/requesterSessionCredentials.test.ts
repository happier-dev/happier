import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { createProviderAccountUsageStore } from '@/daemon/connectedServices/accountUsage/store';
import { access, mkdtemp, rm, readFile, chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import axios from 'axios';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { dirname, join } from 'node:path';
import { resolveAgentCliManagedCommandPathForRuntime } from '@happier-dev/cli-common/agents';
import { AcpCatalogRecordV1Schema, type AcpCatalogRecordV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { createAgentInstallJobOwner } from '@/capabilities/installJobs/agentInstallJobOwner';
import { registerMachineAgentInstallJobRpcHandlers } from '@/api/machine/rpcHandlers.agentInstallJobs';
import { DaemonAgentInstallStartResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { getAcpNpmRuntimeSpec } from '@/agent/acp/catalog/configured/resolveAcpLaunch';
import { resolveAccountConfiguredAcpLaunch } from '@/agent/runtime/registry/engineRegistry/accountConfiguredAcp';
import fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import tweetnacl from 'tweetnacl';
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { SessionForkRpcParamsSchema } from '@happier-dev/protocol/sessions/fork';
import { SessionContinueWithReplayRpcParamsSchema } from '@happier-dev/protocol/sessions/continueWithReplay';
import { createContinueWithReplayLifecycleActionHandler } from '@/session/actions/lifecycle/createContinueWithReplayLifecycleActionHandler';
import { createMachineSessionStopLifecycleActionExecutor } from '@/session/actions/lifecycle/createStopSessionLifecycleActionExecutor';
import { loadSessionHandoffRemoteMetadata, registerMachineSessionHandoffRpcHandlers } from '@/api/machine/sessionHandoff/handlers';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { PRIVATE_SPAWN_SESSION_RPC_METHODS } from '@/rpc/handlers/spawnSessionOptionsContract';
import type { RpcHandler } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createDeferred } from '@/testkit/async/deferred';
import { captureRequesterCurrentnessRefusal } from './requesterCurrentness';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { acquireSavedSecretMaterializerForOperation } from '@/settings/secrets/savedSecretCatalogRead';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { formatSavedSecretCatalogReferenceV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { configuration, reloadConfiguration } from '@/configuration';
import { normalizeServerHttpBaseUrl, publishServerHttpRuntimeOrigin, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { probeAlreadyRunningExistingSessionServiceability } from '@/daemon/startup/pendingQueueNudge';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { createActionExecutor, computeExternalActionRequestEnvelopeDigestV1, SessionPendingEnqueueByMachineRequestV1Schema, type ExternalActionExecutionAuthorizationV1,
  deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol';
import { sealExternalActionRequestV2, openExternalActionResponseV2 } from '@happier-dev/protocol/actions';
import { encryptSessionPayload, decryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { executeExternalAction } from '../externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '../externalActions/daemonExternalActionTargetResolver';
import { prepareRequesterAccountActionContext } from './requesterAccountActionProjection';
import { createRequesterSessionRuntimeContext } from './createRequesterSessionRuntimeContext';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import type { TrackedSession } from '../types';
import { createSessionLifecycleRpcActionExecutor } from '@/rpc/handlers/sessionLifecycle';
import * as sessionLifecycleRpc from '@/rpc/handlers/sessionLifecycle';
import { sealSessionRequesterHandoffPreflightBootstrapRpcRequestV1, sealExternalActionRequesterAccountContextV1, sealSessionRequesterBootstrapRpcRequestV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createForkSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createForkSessionLifecycleActionHandler';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createMachineSessionSpawnRpcHandler } from '@/session/actions/sessionLifecycleActions';
import { prepareDaemonConnectedServices } from '@/daemon/spawn/prepareDaemonConnectedServices';
import { prepareDaemonSpawnChildEnvironment } from '@/daemon/spawn/prepareDaemonSpawnChildEnvironment';
import { resolveSpawnBackendIdentity } from '@/daemon/spawn/resolveSpawnBackendIdentity';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { ApiClient } from '@/api/api';
import { execFile, spawn } from 'node:child_process';
import { createOnChildExited } from '../sessions/onChildExited';
import { subscribeManagedSessionDirectoryRemoval } from '../sessions/subscribeManagedSessionDirectoryRemoval';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { promisify } from 'node:util';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { bindRequesterSessionCredentialScope, decodeStoredCredentials, encodeStoredCredentials, sameStoredCredentials, type Credentials } from '@/persistence';
import { createTrackedSessionHandoffCoordinator } from '@/daemon/actionOperations/createTrackedSessionHandoffCoordinator';
import { createWorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import { WorkspaceSyncController } from '@/workspaces/sync/workspaceSyncController';
import { createWorkspaceSyncMutagenAdapter } from '@/workspaces/sync/workspaceSyncMutagenAdapter';
import { createWorkspaceRootOwnershipManager } from '@/workspaces/sync/workspaceSyncRootOwnership';
import { replacePrivateBearerFile, writePrivateOwnerFile } from '../privateBearerFile';
import { deriveSettingsSecretsKeyForCredentials, deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import { encryptSecretStringV1, decryptSecretStringWithKeysV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { createSpawnNewSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { listHappierProcessRoots } from '../processes/roots/listHappierProcessRoots';
import { resolveProcessOwnership } from '../processes/ownership/resolveProcessOwnership';
import { resolveProcessOwnerRequester } from '../processes/ownership/resolveProcessOwnerRequester';
import { projectMachineProcesses } from '../processes/view/projectMachineProcesses';
import * as requesterCredentialOwner from './requesterSessionCredentials';
import { projectRunnerDaemonPluginServicesFailure } from '../agentRuntime/runnerDaemonPluginServicesHost';
import { AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { registerExternalActionRpcHandler } from '@/rpc/handlers/externalAction';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, ExternalActionExecutionAuthorizationV1Schema,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  ExternalActionDaemonDispatchRequestSchema, parseExternalActionDaemonDispatchResult } from '@happier-dev/protocol/actions/externalActionApi';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import { prepareInstalledRequesterAccountActionContext } from './requesterAccountActionProjection';
import * as installationStore from '@/daemon/identity/store';
import { decodeExternalActionResolvedTargetV1, encodeExternalActionResolvedTargetV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { resolveSessionRunnerFailureExitCode } from '@/cli/resolveSessionRunnerFailureExitCode';
import { admitRequesterSessionBootstrap, prepareRequesterSessionBootstrap, createRequesterSessionCredentialCustody, resolveRequesterSessionBootstrap, verifyRequesterSessionCredentialBinding, verifyRequesterSessionMachineAdmissionCurrent, resolveRequesterSessionCredentials, readRequesterSessionCredentialsForChild, listRequesterSessionCredentialBindings, requesterSessionCredentialPath, REQUESTER_SESSION_ID_ENV, type RequesterSessionMachineAdmissionBoundary } from "./requesterSessionCredentials";

import { prepareWorkflowSessionRequester } from '@/daemon/workflows/workflowSessionStartup';
import { createWorkflowRunMachineTransport } from '@/daemon/workflows/workflowMachineTransport';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { registerActionOperationRpcHandlers } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { logger } from '@/ui/logger';
import { withWebLatencyTrace } from '../externalActions/webLatencyTrace';
import { observeConnectedServiceMaterializationPhase } from '../connectedServices/materialize/materializationPhase';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import { CustodySchema } from './requesterSessionCustody';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { ManagedWorkspaceRefV2WriteSchema } from '@happier-dev/protocol/workspaces/workspaceRefV1';

// Genuine socket boundary: these custody tests do not establish runner availability.
vi.mock('socket.io-client', () => ({ io: () => { throw new Error('Runner socket unavailable'); } }));

const attribution = { serverId: 'bob-home', accountId: 'bob', machineId: 'machine', installationId: 'installation' };
// Home HTTP is the authentication boundary; real requester owners inspect the subject.
const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'bob', tokenEpoch: 1,
  provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.fixture`, encryption: null } as const;
const origin = 'http://requester-home.test';
let app: FastifyInstance | undefined;
let restore: (() => void) | undefined;
let directory: string | undefined;
let runtimeFixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
let sessionControlFixture: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | undefined;

it.each(['alice', 'bob'])('keeps Workflow startup operation reads and recovery cancellation in requester custody (custodian=%s)', async custodianAccountId => {
  const host = await home({ custodianAccountId });
  const prepared = await prepareRequesterSessionBootstrap({ credentials, attribution,
    boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory!,
      getObservedServerIdentityId: () => 'srv_workflow_home' },
    verifyMachineAdmissionCurrent: async () => true });
  expect(prepared).not.toBeNull();
  if (!prepared) throw new Error('Requester fixture was not admitted');
  const operations = createHostActionOperationRuntime({ machineId: attribution.machineId,
    custodyBinding: { serverId: attribution.serverId, installationId: attribution.installationId },
    resolveAccountId: async () => custodianAccountId, supportsCoreCancellation: () => true,
    generateOperationId: () => 'workflow-startup-operation' });
  const receiver = new RpcHandlerManager({ scopePrefix: attribution.machineId, encryptionMode: 'plain', logger: () => {} });
  registerActionOperationRpcHandlers(receiver, operations.handlers);
  const runId = 'admitted-workflow-run';
  const bindTransport = (withRequester = true) => createWorkflowRunMachineTransport({ runId, credentials,
    ...(withRequester ? { requesterWorkAttributionV1: attribution } : {}),
    machineAdmissionBoundary: host.boundary,
    boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory!,
      getObservedServerIdentityId: () => 'srv_workflow_home' },
    isCurrent: async () => true,
    transport: { machineId: attribution.machineId, invoke: (method, input, options) => receiver.invokeLocal(method, input, options) } });
  let transport = bindTransport();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void;
  const nativeCompletion = new Promise<void>(resolve => { finish = resolve; });
  const execution = operations.observeExecution({ actionId: 'session.spawn_new', actionRequestId: 'workflow:birth',
    input: { creationKey: 'workflow:birth', directory: { kind: 'path', path: '/workspace' }, observeSessionCommit: true,
      executionTarget: { serverId: attribution.serverId, machineId: attribution.machineId } },
    rpcContext: { requesterSessionBootstrap: prepared.admitted },
    // Native Session process completion is the external boundary; the operation owner/store remain real.
    execute: async operation => { started(); operation.signal.addEventListener('abort', finish, { once: true });
      await nativeCompletion;
      return operation.signal.aborted ? { ok: false, errorCode: 'cancelled', error: 'cancelled' }
        : { ok: true, result: { type: 'success', sessionId: 'workflow-child' } }; } });
  try {
    await ready;
    const request = { operationId: 'workflow-startup-operation' };
    const expected = { kind: 'found', operation: { operationId: request.operationId, state: 'running',
      scope: { accountId: attribution.accountId, machineId: attribution.machineId } } };
    // Production's startup observer and retained-operation recovery supply no local Action context.
    expect(await transport.transport.invoke(ACTION_OPERATION_RPC_METHODS_V2.get, request)).toMatchObject(expected);
    if (custodianAccountId === attribution.accountId) {
      const ordinaryOwner = bindTransport(false);
      try { expect(await ordinaryOwner.transport.invoke(ACTION_OPERATION_RPC_METHODS_V2.get, request)).toMatchObject(expected); }
      finally { await ordinaryOwner.dispose(); }
    }
    for (const localActionContext of [
      { executionRunWorkflowRunId: 'another-run', requesterWorkAttributionV1: attribution },
      { requesterWorkAttributionV1: attribution },
      { executionRunWorkflowRunId: runId, requesterWorkAttributionV1: { ...attribution, accountId: 'unrelated-account' } },
    ]) expect(await transport.transport.invoke(ACTION_OPERATION_RPC_METHODS_V2.get, request, { localActionContext }))
      .toMatchObject({ ok: false, errorCode: 'project_requester_credentials_unavailable' });
    expect(await transport.transport.invoke(ACTION_OPERATION_RPC_METHODS_V2.get, request,
      { executionRunWorkflowRunId: 'another-run' }))
      .toMatchObject({ ok: false, errorCode: 'project_requester_credentials_unavailable' });
    expect(await transport.transport.invoke(ACTION_OPERATION_RPC_METHODS_V2.get, request,
      { executionRunWorkflowRunId: 'another-run', localActionContext: {
        executionRunWorkflowRunId: runId, requesterWorkAttributionV1: attribution,
      } }))
      .toMatchObject({ ok: false, errorCode: 'project_requester_credentials_unavailable' });
    await transport.dispose();
    transport = bindTransport();
    expect(await transport.transport.invoke(ACTION_OPERATION_RPC_METHODS_V2.get, request)).toMatchObject(expected);
    expect(await transport.transport.invoke(ACTION_OPERATION_RPC_METHODS_V1.cancel, request)).toMatchObject({ kind: 'requested' });
    await execution;
    expect(await transport.transport.invoke(ACTION_OPERATION_RPC_METHODS_V2.get, request))
      .toMatchObject({ kind: 'found', operation: { state: 'cancelled', scope: { accountId: attribution.accountId } } });
    if (custodianAccountId !== attribution.accountId) expect(await operations.handlers.getV2(request)).toEqual({ kind: 'not_found' });
  } finally {
    finish(); await execution; await transport.dispose(); await prepared.cleanupOnFailure();
  }
});

it('retains and retires Workflow trigger custody through private requester bootstrap without spawning a Session', async () => {
  const host = await home();
  const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
    serverHttpBaseUrl: origin, boundary: host.boundary });
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {},
    authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'machine',
      resolveCustodianAccountId: async () => 'alice', resolveInstallationId: () => 'installation',
      verifyMachineAdmission: current }) });
  const launched: unknown[] = [];
  sessionLifecycleRpc.registerSessionSpawnNewRpcHandlers({ rpcHandlerManager: rpc,
    requesterBootstrapBoundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory!,
      getObservedServerIdentityId: () => 'srv_workflow_home',
      spawnLifecycleHandler: async input => { launched.push(input); return { type: 'success', sessionId: 'unexpected' }; } },
  });
  const { acquireWorkflowRequesterCredentials } = await import('../workflows/requesterCustody');
  const input = { kind: 'requester_session_bootstrap_v1', scope: 'workflow_trigger',
    input: { executionTarget: { serverId: attribution.serverId, machineId: 'machine' }, scopeId: 'schedule', operation: 'retain' },
    requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: encodeStoredCredentials(credentials) } };
  const options = { rpcContext: { machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
    installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const }, verifyMachineAdmissionCurrent: async () => true } };
  expect(await rpc.invokeLocal(RPC_METHODS.SESSION_SPAWN_NEW, input, options)).toEqual({ ok: true });
  expect(launched).toEqual([]);
  const binding = { scopeId: 'schedule', happyHomeDir: directory!, serverId: attribution.serverId,
    machineId: 'machine', installationId: 'installation', serverHttpBaseUrl: origin };
  const retained = await acquireWorkflowRequesterCredentials(binding);
  expect(retained?.attribution.accountId).toBe('bob');
  await retained?.release();
  expect(await rpc.invokeLocal(RPC_METHODS.SESSION_SPAWN_NEW, { ...input, input: { ...input.input, operation: 'retire' } }, options)).toEqual({ ok: true });
  expect(await acquireWorkflowRequesterCredentials(binding)).toBeNull();
});
afterAll(async () => { await runtimeFixture?.dispose(); runtimeFixture = undefined; });
afterEach(async () => {
  await sessionControlFixture?.dispose(); sessionControlFixture = undefined;
  restore?.(); restore = undefined;
  await app?.close(); app = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  vi.unstubAllEnvs();
});

it.each([
  ['workflow', 'owner'], ['workflow', 'member'], ['workflow', 'misbound'], ['workflow', 'missing-home'],
  ['direct', 'owner'], ['direct', 'member'],
] as const)('admits %s owner MCP with retained Home custody (%s)', async (ingress, caller) => {
  const custodianAccountId = caller === 'member' ? 'alice' : 'bob';
  const host = await home({ custodianAccountId });
  const birth = { ...attribution, serverId: configuration.activeServerId };
  const homeServerIdentityId = 'srv_workflow_home';
  let currentHome: string | null = caller === 'missing-home' ? null : homeServerIdentityId;
  const { adoptServerProfileHomeConnectionDescriptor } = await import('@/server/serverProfiles');
  const { readMcpExecutionSource, assertMcpStdioExecutionSupported } = await import('@/mcp/runtime/mcpExecutionSource');
  await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: birth.serverId, createIfMissing: true,
    observation: 'exact', descriptor: { v: 1, homeServerIdentityId, canonicalServerUrl: 'https://workflow-home.example.test',
      revision: 1, endpoints: [{ kind: 'https', url: 'https://workflow-home.example.test' }] } });
  const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution: birth, sessionId: 'session',
    serverHttpBaseUrl: origin, boundary: host.boundary });
  const boundary = { serverId: birth.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory!,
    getObservedServerIdentityId: () => currentHome };
  const beforePreparation = host.requests.length;
  // Direct receivers must not need Workflow's adapter to retain the receiving
  // Home when their already-admitted profile supplies its exact identity.
  const prepare = ingress === 'workflow' ? prepareWorkflowSessionRequester : prepareRequesterSessionBootstrap;
  const prepared = await prepare({ credentials, attribution: birth,
    boundary: ingress === 'direct' ? { serverId: boundary.serverId,
      serverHttpBaseUrl: boundary.serverHttpBaseUrl, happyHomeDir: boundary.happyHomeDir } : boundary,
    machineAdmission: { actorAccountId: birth.accountId, custodianAccountId }, verifyMachineAdmissionCurrent: current });
  if (caller === 'missing-home') {
    expect(prepared).toBeNull();
    expect(host.requests).toHaveLength(beforePreparation);
    return;
  }
  if (!prepared) throw new Error('Workflow requester preparation failed');
  requesterCredentialOwner.bindRequesterSessionRuntimeMachineAdmissionCurrentness({ bootstrap: prepared.admitted,
    boundary: { ...host.boundary, getObservedServerIdentityId: boundary.getObservedServerIdentityId } });
  try {
    const custody = await prepared.admitted.bindSession('session', host.correspondence.sessionCreationTag);
    if (!custody) throw new Error('Workflow Session custody failed');
    vi.stubEnv(REQUESTER_SESSION_ID_ENV, 'session');
    const child = await runWithServerHttpBaseUrl(origin, () => readRequesterSessionCredentialsForChild(custody.path));
    if (!child) throw new Error('Workflow child credentials unavailable');
    expect(child.requesterSessionCredentialScope?.requesterSession?.homeServerIdentityId).toBe(homeServerIdentityId);
    // Real requester preparation, protected birth writer and child opener feed
    // the exact MCP consumer. A different Session must not borrow this birth.
    const beforeMcp = host.readReturnedRows().machine;
    const admission = readMcpExecutionSource({ credentials: child, catalogCredentials: child,
      sessionId: caller === 'misbound' ? 'another-session' : 'session', machineId: birth.machineId, serverHttpBaseUrl: origin })
      .then(source => assertMcpStdioExecutionSupported(source, false));
    if (caller === 'owner') {
      await expect(admission).resolves.toMatchObject({ kind: 'requester',
        identity: { kind: 'isolated', separationRequired: false }, hostHomeServerIdentityId: homeServerIdentityId });
      currentHome = 'srv_replaced_home';
      expect(await prepared.admitted.isCurrent()).toBe(false);
    } else {
      await expect(admission).rejects.toMatchObject({ code: 'agent_isolation_unavailable',
        details: { reason: caller === 'misbound' ? 'session_requester_unavailable' : 'agent_launch_kind_unavailable' } });
    }
    expect(host.readReturnedRows().machine - beforeMcp).toBe(caller === 'misbound' ? 0 : 1);
  } finally { await prepared.cleanupOnFailure(); }
});

async function home(options: Readonly<{ sessionId?: string; creationMachineId?: string; bot?: boolean; custodianAccountId?: string; requesterReadsOnly?: boolean;
  machineGrantCount?: number;
  sessionActive?: boolean; sessionSeq?: number; encryptionSecret?: Uint8Array; beforeProfileRead?: () => Promise<void>;
  beforeMachineAccessRead?: () => Promise<void>; beforeSettingsRead?: () => Promise<void> }> = {}) {
  const sessionId = options.sessionId ?? 'session';
  const custodianAccountId = options.custodianAccountId ?? 'alice';
  directory = await mkdtemp(join(tmpdir(), 'requester-custody-'));
  app = fastify();
  const keyPair = tweetnacl.sign.keyPair();
  let installationId = 'installation';
  let accountId = 'bob';
  let access = true;
  let signedAdmissionAvailable = true;
  let accountMode: 'plain' | 'e2ee' = options.encryptionSecret ? 'e2ee' : 'plain';
  let sessionRole: 'owner' | 'view' = 'owner';
  let loseDuringVerification = false;
  let unavailablePath: string | null = null;
  let acpCatalog: AcpCatalogRecordV1 = { v: 1, definitions: [] };
  let settingsAvailable = true;
  let machineRowsReturned = 0;
  let grantRowsReturned = 0;
  let machineRole: 'manage' | 'use' = options.machineGrantCount ? 'manage' : 'use';
  const requests: Array<{ path: string; bearer: string | undefined; purpose: string | string[] | undefined; sessionActionAuthorized?: true }> = [];
  const pendingInputs: unknown[] = [];
  let sessionActionAuthorization: ExternalActionExecutionAuthorizationV1 | undefined;
  const hasSignedSessionActionAuthority = (request: FastifyRequest) => {
    const root = sessionActionAuthorization;
    const signature = request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER.toLowerCase()];
    const encodedTarget = request.headers[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER.toLowerCase()];
    const target = typeof encodedTarget === 'string' ? decodeExternalActionResolvedTargetV1(encodedTarget) : null;
    // Root verification signs the original Machine target; Session HTTP reads
    // use the separately projected Session target under that same signed root.
    const targetMatches = target?.kind === 'session' && target.sessionId === sessionId
      || request.method === 'POST' && request.url === '/v1/actions/session.open/execution-authorization/verify'
        && root?.binding.target.kind === 'machine' && target?.kind === 'machine'
        && target.machineId === root.binding.target.machineId;
    return access && root?.binding.accountId === accountId
      && (root.binding.target.kind === 'session' && root.binding.target.sessionId === sessionId
        || root.binding.actionId === 'session.open' && root.binding.target.kind === 'machine' && root.binding.target.machineId === 'machine')
      && root.binding.machineId === 'machine'
      && root.binding.installationId === installationId
      && request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER.toLowerCase()] === root.token
      && request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER.toLowerCase()] === root.binding.actionId
      && targetMatches && target !== null
      && typeof signature === 'string' && verifyExternalActionMachineRequestV1({ authorizationToken: root.token,
        effectActionId: root.binding.actionId, target, installationId, requestId: root.binding.requestId,
        method: request.method, path: request.url, publicKey: keyPair.publicKey, signature,
        ...(request.body === undefined ? {} : { body: request.body }) });
  };
  app.addHook('preHandler', async (request, reply) => {
    const signed = hasSignedSessionActionAuthority(request);
    requests.push({ path: request.url, bearer: request.headers.authorization, purpose: request.headers['x-happier-request-purpose'],
      ...(signed ? { sessionActionAuthorized: true as const } : {}) });
    if (request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER.toLowerCase()] && !signed)
      return reply.code(403).send({ error: 'access_denied' });
    if (request.url === unavailablePath) return reply.code(503).send({ error: 'home_unavailable' });
  });
  app.get('/v1/account/profile', async () => { await options.beforeProfileRead?.(); return { id: accountId }; });
  app.get('/v1/account/encryption', async () => ({ mode: accountMode, updatedAt: 1 }));
  app.get('/v1/account/encryption/currentness', async () => ({ mode: accountMode, version: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
  app.post('/v1/actions/session.open/execution-authorization/verify', async () => ({ ok: access }));
  app.post('/v1/actions/session.message.send/execution-authorization/verify', async (_request, reply) =>
    access ? { ok: true } : reply.code(403).send({ error: 'access_denied' }));
  app.post(`/v2/sessions/${sessionId}/pending`, async request => {
    pendingInputs.push(request.body);
    return { didWrite: true, terminal: false };
  });
  app.get('/v2/account/settings', async (_request, reply) => { await options.beforeSettingsRead?.(); return settingsAvailable
    ? accountMode === 'plain' ? { content: { t: 'plain', v: {} }, version: 1 } : { content: null, version: 0 }
    : reply.code(500).send({ error: 'database_unavailable' }); });
  app.get('/v1/account/entity-rows/acp', async () => ({ status: 'present', revision: 1, content: { t: 'plain', v: acpCatalog } }));
  app.get('/v1/machines/machine/access', async (_request, reply) => {
    await options.beforeMachineAccessRead?.();
    if (access) grantRowsReturned += options.machineGrantCount ?? 0;
    return access ? {
    machineId: 'machine', custodian: { accountId: custodianAccountId, displayName: 'Custodian' },
    access: { custodian: { accountId: custodianAccountId, displayName: 'Custodian' }, role: machineRole, resourceMode: 'plain', accessState: 'ready' },
    canManage: machineRole === 'manage', grants: Array.from({ length: options.machineGrantCount ?? 0 }, (_, index) => ({
      machineId: 'machine', principal: { kind: 'account', accountId: `recipient-${index}` }, level: 'view',
      display: { name: `Recipient ${index}` }, readiness: 'ready',
      audience: [{ accountId: `recipient-${index}`, displayName: `Recipient ${index}`, readiness: 'ready', reason: null, canPrepareKeys: false }],
      removal: { losesAccessAccountIds: [`recipient-${index}`] },
    })), ownDirectGrant: true, ownAccessSources: [],
  } : reply.code(403).send({ kind: 'refused', code: 'access_denied' });
  });
  // The publication read exposes the one Machine's access without its grant roster.
  // Currentness inspects authority; the encoded content is not opened.
  const machineRows = Array.from({ length: 128 }, (_, index) => ({
    id: index === 0 ? 'machine' : `unrelated-machine-${index}`, metadata: 'opaque-machine-content', metadataVersion: 1,
    daemonState: null, daemonStateVersion: 0, installationId: 'installation', revokedAt: null, replacedByMachineId: null,
    access: { custodian: { accountId: custodianAccountId, displayName: 'Custodian' }, role: machineRole, resourceMode: 'plain', accessState: 'ready' },
  }));
  app.get('/v1/machines', async () => { machineRowsReturned += machineRows.length; return machineRows; });
  app.get('/v1/machines/machine', async (_request, reply) => {
    await options.beforeMachineAccessRead?.();
    if (access) machineRowsReturned++;
    return access ? { machine: machineRows[0] } : reply.code(404).send({ error: 'machine_unavailable' });
  });
  app.post('/v1/machines/machine/admission/verify', async (request, reply) => {
    // The network adapter is the external Home boundary; the real signer and verifier remain in-process.
    const body = request.body as { context: SocketRpcMachineAdmissionContextV1; method?: string;
      purpose?: { kind: 'requester_session_currentness'; sessionId: string };
      proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
    if (!body?.context || !body.method && !body.purpose) throw new Error('Missing fresh C41 request');
    const purpose = body.purpose?.kind === 'requester_session_currentness' && body.purpose.sessionId === sessionId
      && body.method === undefined ? { purpose: body.purpose }
      : body.purpose === undefined && Object.values(PRIVATE_SPAWN_SESSION_RPC_METHODS).some(method => body.method === `machine:${method}`)
        ? { method: body.method! } : null;
    if (!purpose) return reply.code(403).send({ error: 'wrong_currentness_purpose' });
    const valid = verifyMachineInstallationProof({ publicKey: keyPair.publicKey, proof: body.proof,
      payload: { version: 1, accountId: custodianAccountId, machineId: 'machine', installationId: 'installation',
        rpcAdmission: { context: body.context, ...purpose } } });
    expect(body.context.actorAccountId).toBe(accountId);
    if (loseDuringVerification) installationId = 'replacement';
    return valid && access && signedAdmissionAvailable ? { v: 1, ok: true } : reply.code(403).send({ error: 'access_denied' });
  });
  const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1, sessionCreationTag: `create:v1:${'a'.repeat(43)}`,
    recipe: { execution: { machineId: options.creationMachineId ?? 'machine', directory: { kind: 'path', path: '/workspace' } },
      organization: { folderId: null, tagIds: [] }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null,
      ...(options.bot ? { identity: { bot: { kind: 'bot' }, createdAsBot: true } } : {}),
      configuration: null, connectedServices: null, capabilitySelection: null, transcriptStorage: null,
      terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null } });
  app.get(`/v2/sessions/${sessionId}`, async (request, reply) => options.requesterReadsOnly
    && request.headers.authorization !== `Bearer ${credentials.token}`
    && !hasSignedSessionActionAuthority(request)
    ? reply.code(403).send({ error: 'access_denied' }) : ({ session: createSessionRecordFixture({ id: sessionId, seq: options.sessionSeq ?? 0,
    active: options.sessionActive === true, encryptionMode: accountMode, metadata: options.encryptionSecret
      ? encryptSessionPayload({ ctx: { encryptionKey: options.encryptionSecret, encryptionVariant: 'legacy' },
          payload: { machineId: 'machine', path: '/workspace', codexSessionId: 'same-native-session', sessionCreationCorrespondenceV1: correspondence } })
      : JSON.stringify({ machineId: 'machine', path: '/workspace', codexSessionId: 'same-native-session',
      ...(options.bot ? { bot: { kind: 'bot' }, createdAsBot: true } : {}),
      sessionCreationCorrespondenceV1: correspondence }), dataEncryptionKey: null,
    share: sessionRole === 'owner' ? null : { accessLevel: 'view', canApprovePermissions: false },
  }) }));
  app.get(`/v1/access-keys/${sessionId}/machine`, async () => ({ accessKey: { id: 'existing' } }));
  app.post('/v3/automations/runs/workflow-storage', async () => ({ runs: [] }));
  await app.ready();
  restore = installAxiosFastifyAdapter({ app, origin });
  const boundary: RequesterSessionMachineAdmissionBoundary = { machineId: 'machine', daemonToken: 'alice-daemon',
    isHomeCurrent: () => true, readInstallation: () => ({ installationId, privateKey: keyPair.secretKey }) };
  return { boundary, requests, pendingInputs, correspondence, keyPair, setAccess: (value: boolean) => { access = value; },
    setSignedAdmissionAvailable: (value: boolean) => { signedAdmissionAvailable = value; },
    setMachineRole: (value: 'manage' | 'use') => { machineRole = value; for (const row of machineRows) row.access.role = value; },
    readReturnedRows: () => ({ machine: machineRowsReturned, grants: grantRowsReturned }),
    setSessionActionAuthorization: (value: ExternalActionExecutionAuthorizationV1) => { sessionActionAuthorization = value; },
    setUnavailablePath: (value: string | null) => { unavailablePath = value; },
    setSettingsAvailable: (value: boolean) => { settingsAvailable = value; },
    setAcpCatalog: (record: AcpCatalogRecordV1) => { acpCatalog = record; },
    setAccountId: (value: string) => { accountId = value; }, setAccountMode: (value: 'plain' | 'e2ee') => { accountMode = value; },
    setSessionRole: (value: 'owner' | 'view') => { sessionRole = value; },
    replaceDuringVerification: () => { loseDuringVerification = true; } };
}

describe('requester Session lifecycle custody', () => {
  it.each(['plain', 'e2ee'] as const)('retires %s requester custody only after definite non-admission at Resume', async mode => {
    const secret = new Uint8Array(32).fill(23);
    const host = await home(mode === 'e2ee' ? { encryptionSecret: secret } : {});
    const requesterCredentials = { ...credentials, encryption: mode === 'e2ee' ? { type: 'legacy' as const, secret } : null };
    const binding = { happyHomeDir: directory!, sessionId: 'session', attribution };
    const custody = await createRequesterSessionCredentialCustody({ ...binding, credentials: requesterCredentials,
      homeServerIdentityId: 'srv_original_home',
      machineAdmission: { custodianAccountId: 'alice', role: 'use' } });
    const child = spawn(process.execPath, ['-e', 'process.exitCode = 0'], { stdio: 'ignore' });
    const pid = child.pid;
    if (pid === undefined) throw new Error('Missing requester child fixture');
    await new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
    const exited = createOnChildExited({ trackedSessionsByKey: new Map([[legacyPidSessionTrackingKey(pid), { trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: binding.sessionId,
      startedBy: 'daemon', requesterWorkAttributionV1: attribution } satisfies TrackedSession]]),
      spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null });
    await exited(pid, { reason: 'process-exited', code: 0, signal: null });
    await expect(access(custody.path)).resolves.toBeUndefined();
    const recover = () => requesterCredentialOwner.resolveRequesterSessionBootstrap({ ...binding,
      serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary });
    const resumed = await recover();
    expect(resumed?.getBoundSessionId()).toBe(binding.sessionId);
    await resumed?.dispose();
    await expect(access(custody.path)).resolves.toBeUndefined();
    host.setAccess(false);
    expect(await recover()).toBeNull();
    await expect(access(custody.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retires only the deleted requester Session through the existing deletion subscription', async () => {
    await home();
    const custody = await createRequesterSessionCredentialCustody({ happyHomeDir: directory!, sessionId: 'deleted',
      attribution, credentials, machineAdmission: { custodianAccountId: 'alice', role: 'use' } });
    const retained = await createRequesterSessionCredentialCustody({ happyHomeDir: directory!, sessionId: 'retained', attribution, credentials });
    const workflow = await createRequesterSessionCredentialCustody({ happyHomeDir: directory!, sessionId: 'deleted',
      attribution, credentials, scope: 'workflow_trigger' });
    let deleted: ((change: { sessionId: string }) => void | Promise<void>) | undefined;
    const dispose = await subscribeManagedSessionDirectoryRemoval({
      directories: createManagedSessionDirectories({ activeServerDir: directory! }), token: 'custodian-fixture',
      stopSession: async () => ({ status: 'not_found' }),
      onSessionDeletedChange: listener => { deleted = listener; return () => { deleted = undefined; }; },
      onSessionAccessReset: () => () => {},
      requesterCustody: { happyHomeDir: directory!, serverId: attribution.serverId },
    });
    try {
      if (!deleted) throw new Error('Missing existing deletion subscription');
      await deleted({ sessionId: 'deleted' });
      await expect(access(custody.path)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(retained.path)).resolves.toBeUndefined();
      await expect(access(workflow.path)).resolves.toBeUndefined();
      await deleted({ sessionId: 'deleted' });
    } finally { dispose(); }
  });
  it.each(['plain', 'e2ee'] as const)('recovers closed native-target Sync custody without a fabricated host member (%s)', async mode => {
    const secret = new Uint8Array(32).fill(27);
    const host = await home({ sessionId: 'native-sync', ...(mode === 'e2ee' ? { encryptionSecret: secret } : {}) });
    const requesterCredentials = mode === 'e2ee' ? { token: credentials.token, encryption: { type: 'legacy' as const, secret } } : credentials;
    const workspace = ManagedWorkspaceRefV2WriteSchema.parse({ v: 2, kind: 'managed', id: 'native-workspace',
      serverId: 'srv_original_home', managedId: 'managed-target', rootPath: '/guest/repo',
      controller: { machineId: attribution.machineId, installationId: attribution.installationId }, createdAtMs: 1 });
    const binding = { happyHomeDir: directory!, relationshipId: 'native-sync', attribution, workspace };
    const sourceExecutionIdentity = mode === 'e2ee'
      ? { kind: 'isolated' as const, requester: attribution, separationRequired: true } : undefined;
    const custody = await requesterCredentialOwner.createWorkspaceSyncManagedTargetCredentialCustody({ ...binding,
      credentials: requesterCredentials, homeServerIdentityId: workspace.serverId,
      ...(sourceExecutionIdentity ? { sourceExecutionIdentity } : {}) });
    const stored = JSON.parse(await readFile(custody.path, 'utf8'));
    expect(stored).toMatchObject({ v: 2, scope: 'workspace_sync_relationship', endpointRole: 'managed_target', workspace });
    expect(stored.executionIdentity).toBeUndefined();
    expect(stored.machineAdmission).toBeUndefined();
    expect(stored.sourceExecutionIdentity).toEqual(sourceExecutionIdentity);
    // The actual unchanged v1 reader must refuse rather than drop the native locator.
    expect(createStoredReadSchema(CustodySchema).safeParse(stored).success).toBe(false);
    expect(await listRequesterSessionCredentialBindings({ happyHomeDir: directory!, ...attribution,
      scope: 'workspace_sync_relationship', endpointRole: 'managed_target' })).toEqual({ status: 'ready', bindings: [{
      sessionId: binding.relationshipId, scope: 'workspace_sync_relationship', endpointRole: 'managed_target', attribution, workspace,
    }] });
    const recovered = await requesterCredentialOwner.resolveWorkspaceSyncManagedTargetCredentialCustody({ ...binding,
      serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary });
    expect(recovered).toEqual({ credentials: { ...requesterCredentials, credentialProvenance: 'stored_session' }, workspace,
      ...(sourceExecutionIdentity ? { sourceExecutionIdentity } : {}) });
    expect(host.requests.some(request => request.path.startsWith('/v2/sessions/'))).toBe(false);
    vi.stubEnv(REQUESTER_SESSION_ID_ENV, binding.relationshipId);
    expect(await readRequesterSessionCredentialsForChild(custody.path)).toBeNull();
  });

  it.each(['managed', 'controller', 'installation', 'root', 'home', 'reference', 'account'] as const)('refuses a substituted native-target %s binding without replacing retained custody', async mismatch => {
    const host = await home({ sessionId: 'native-binding' });
    const workspace = ManagedWorkspaceRefV2WriteSchema.parse({ v: 2, kind: 'managed', id: 'native-workspace',
      serverId: 'srv_original_home', managedId: 'managed-target', rootPath: '/guest/repo',
      controller: { machineId: attribution.machineId, installationId: attribution.installationId }, createdAtMs: 1 });
    const binding = { happyHomeDir: directory!, relationshipId: 'native-binding', attribution, workspace };
    const custody = await requesterCredentialOwner.createWorkspaceSyncManagedTargetCredentialCustody({ ...binding, credentials });
    const substituted = { ...binding,
      ...(mismatch === 'account' ? { attribution: { ...attribution, accountId: 'other-account' } } : {}),
      workspace: { ...workspace,
        ...(mismatch === 'managed' ? { managedId: 'other-target' } : {}),
        ...(mismatch === 'root' ? { rootPath: '/guest/other' } : {}),
        ...(mismatch === 'home' ? { serverId: 'other-home' } : {}),
        ...(mismatch === 'reference' ? { id: 'other-reference' } : {}),
        controller: { ...workspace.controller,
          ...(mismatch === 'controller' ? { machineId: 'other-controller' } : {}),
          ...(mismatch === 'installation' ? { installationId: 'other-installation' } : {}) } } };
    await expect(requesterCredentialOwner.resolveWorkspaceSyncManagedTargetCredentialCustody({ ...substituted,
      serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary })).resolves.toBeNull();
    await expect(requesterCredentialOwner.createWorkspaceSyncManagedTargetCredentialCustody({ ...substituted, credentials }))
      .rejects.toThrow('requester_session_custody_mismatch');
    expect(JSON.parse(await readFile(custody.path, 'utf8')).workspace).toEqual(workspace);
  });

  it.each(['plain', 'e2ee'] as const)('discovers each custody scope in the current Home store and recovers Sync with its captured identity (%s)', async mode => {
    const secret = new Uint8Array(32).fill(19);
    const host = await home({ sessionId: 'sync-relationship', ...(mode === 'e2ee' ? { encryptionSecret: secret } : {}) });
    const requesterCredentials = mode === 'e2ee' ? { token: credentials.token, encryption: { type: 'legacy' as const, secret } } : credentials;
    const binding = { happyHomeDir: directory!, relationshipId: 'sync-relationship', attribution };
    const executionIdentity = { kind: 'isolated', requester: attribution, separationRequired: true } as const;
    const custody = await requesterCredentialOwner.createWorkspaceSyncRelationshipCredentialCustody({ ...binding,
      credentials: requesterCredentials, executionIdentity, homeServerIdentityId: 'srv_original_home' });
    expect(custody.path).toBe(join(directory!, 'requester-session-credentials',
      'home-bob-home', 'relationship-sync-relationship.json'));
    const session = await createRequesterSessionCredentialCustody({ happyHomeDir: directory!, sessionId: 'session', attribution, credentials });
    await createRequesterSessionCredentialCustody({ happyHomeDir: directory!, sessionId: 'schedule', scope: 'workflow_trigger', attribution, credentials });
    expect(await listRequesterSessionCredentialBindings({ happyHomeDir: directory!, ...attribution })).toEqual({
      status: 'ready', bindings: [{ sessionId: 'session', attribution }] });
    expect(await listRequesterSessionCredentialBindings({ happyHomeDir: directory!, ...attribution, scope: 'workflow_trigger' })).toEqual({
      status: 'ready', bindings: [{ sessionId: 'schedule', scope: 'workflow_trigger', attribution }] });
    expect(await listRequesterSessionCredentialBindings({ happyHomeDir: directory!, ...attribution, scope: 'workspace_sync_relationship' })).toEqual({
      status: 'ready', bindings: [{ sessionId: binding.relationshipId, scope: 'workspace_sync_relationship', attribution }] });
    const recovered = await requesterCredentialOwner.resolveWorkspaceSyncRelationshipCredentialCustody({ ...binding,
      serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary });
    expect(recovered).toEqual({ credentials: { ...requesterCredentials, credentialProvenance: 'stored_session' }, executionIdentity });
    await expect(requesterCredentialOwner.createWorkspaceSyncRelationshipCredentialCustody({ ...binding,
      credentials: requesterCredentials, executionIdentity: { ...executionIdentity, separationRequired: false },
      homeServerIdentityId: 'srv_original_home' })).rejects.toThrow('requester_session_custody_mismatch');
    expect(host.requests.some(request => request.path.startsWith('/v2/sessions/'))).toBe(false);
    expect(host.requests.filter(request => request.path === '/v1/account/profile')).not.toHaveLength(0);
    expect(host.requests.filter(request => request.path === '/v1/account/profile').every(request =>
      request.bearer === `Bearer ${credentials.token}`)).toBe(true);
    vi.stubEnv(REQUESTER_SESSION_ID_ENV, binding.relationshipId);
    expect(await readRequesterSessionCredentialsForChild(custody.path)).toBeNull();
    await custody.cleanup();
    await expect(access(custody.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(session.path)).resolves.toBeUndefined();
  });

  it.each(['requester', 'machine', 'identity'] as const)('refuses substituted Sync relationship %s custody', async mismatch => {
    const host = await home();
    const binding = { happyHomeDir: directory!, relationshipId: 'sync-relationship', attribution };
    const custody = await requesterCredentialOwner.createWorkspaceSyncRelationshipCredentialCustody({ ...binding, credentials,
      executionIdentity: { kind: 'isolated', requester: attribution, separationRequired: true } });
    if (mismatch === 'requester') host.setAccountId('alice');
    if (mismatch === 'machine') host.setAccess(false);
    if (mismatch === 'identity') {
      const stored = JSON.parse(await readFile(custody.path, 'utf8'));
      stored.executionIdentity.requester.accountId = 'alice';
      await replacePrivateBearerFile({ path: custody.path, contents: JSON.stringify(stored) });
    }
    expect(await requesterCredentialOwner.resolveWorkspaceSyncRelationshipCredentialCustody({ ...binding, serverHttpBaseUrl: origin,
      machineAdmissionBoundary: host.boundary })).toBeNull();
    if (mismatch !== 'identity') await expect(access(custody.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['owner', 'manager'] as const)('recovers Sync relationship SOURCE Account custody independently of the target native identity (%s)', async authority => {
    const host = await home({ sessionId: 'source-sync', ...(authority === 'owner'
      ? { custodianAccountId: attribution.accountId } : { machineGrantCount: 1 }) });
    const binding = { happyHomeDir: directory!, relationshipId: 'source-sync', attribution };
    const target = await requesterCredentialOwner.createWorkspaceSyncRelationshipCredentialCustody({ ...binding, credentials,
      executionIdentity: { kind: 'isolated', requester: attribution, separationRequired: true } });
    const source = await requesterCredentialOwner.createWorkspaceSyncSourceCredentialCustody({ ...binding, credentials });
    expect(source.path).not.toBe(target.path);
    const stored = JSON.parse(await readFile(source.path, 'utf8'));
    expect(stored).toMatchObject({ scope: 'workspace_sync_relationship', endpointRole: 'source', attribution });
    expect(stored.executionIdentity).toBeUndefined();
    expect(await listRequesterSessionCredentialBindings({ happyHomeDir: directory!, ...attribution,
      scope: 'workspace_sync_relationship', endpointRole: 'source' })).toEqual({ status: 'ready', bindings: [
      { sessionId: binding.relationshipId, scope: 'workspace_sync_relationship', endpointRole: 'source', attribution },
    ] });
    expect(await listRequesterSessionCredentialBindings({ happyHomeDir: directory!, ...attribution,
      scope: 'workspace_sync_relationship' })).toEqual({ status: 'ready', bindings: [
      { sessionId: binding.relationshipId, scope: 'workspace_sync_relationship', attribution },
    ] });
    expect(await requesterCredentialOwner.resolveWorkspaceSyncSourceCredentialCustody({ ...binding,
      serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary })).toMatchObject(credentials);
    expect(host.requests.some(request => request.path.startsWith('/v2/sessions/'))).toBe(false);
    host.setAccess(false);
    expect(await requesterCredentialOwner.resolveWorkspaceSyncSourceCredentialCustody({ ...binding,
      serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary })).toBeNull();
    await expect(access(source.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(target.path)).resolves.toBeUndefined();
  });

  it('refuses SOURCE Manage-to-Use downgrade at the next boundary while retaining target native custody', async () => {
    const host = await home({ sessionId: 'source-downgrade', machineGrantCount: 1 });
    const binding = { happyHomeDir: directory!, relationshipId: 'source-downgrade', attribution };
    const source = await requesterCredentialOwner.createWorkspaceSyncSourceCredentialCustody({ ...binding, credentials });
    const target = await requesterCredentialOwner.createWorkspaceSyncRelationshipCredentialCustody({ ...binding, credentials,
      executionIdentity: { kind: 'isolated', requester: attribution, separationRequired: true } });
    const fresh = { credentials, attribution, sessionId: binding.relationshipId, serverHttpBaseUrl: origin, boundary: host.boundary };
    const machineReads = () => host.requests.filter(request => request.path === '/v1/machines/machine').length;
    expect(await requesterCredentialOwner.resolveWorkspaceSyncSourceCredentialCustody({ ...binding,
      serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary })).toMatchObject(credentials);
    host.setMachineRole('use');
    expect(await requesterCredentialOwner.resolveWorkspaceSyncSourceCredentialCustody({ ...binding,
      serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary })).toBeNull();
    let before = machineReads();
    expect(await requesterCredentialOwner.verifyWorkspaceSyncSourceMachineAdmissionCurrent(fresh)).toBe(false);
    expect(machineReads() - before).toBe(1);
    expect(await requesterCredentialOwner.resolveWorkspaceSyncRelationshipCredentialCustody({ ...binding,
      serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary })).not.toBeNull();
    await expect(access(source.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(target.path)).resolves.toBeUndefined();
    host.setMachineRole('manage');
    before = machineReads();
    expect(await requesterCredentialOwner.verifyWorkspaceSyncSourceMachineAdmissionCurrent(fresh)).toBe(true);
    expect(machineReads() - before).toBe(1);
    expect(host.requests.some(request => request.path.endsWith('/admission/verify'))).toBe(false);
  });

  it('recovers Sync relationship custody without a fictional Session proof', async () => {
    const host = await home({ machineGrantCount: 1 });
    const binding = { happyHomeDir: directory!, relationshipId: 'relationship-without-session', attribution };
    await requesterCredentialOwner.createWorkspaceSyncSourceCredentialCustody({ ...binding, credentials });
    await requesterCredentialOwner.createWorkspaceSyncRelationshipCredentialCustody({ ...binding, credentials,
      executionIdentity: { kind: 'isolated', requester: attribution, separationRequired: true } });
    const fresh = { credentials, attribution, sessionId: binding.relationshipId, serverHttpBaseUrl: origin, boundary: host.boundary };
    // This Home has an actual Session named "session". Its signed Session proof
    // refuses the relationship id, as the real AccessKey/Session owner does.
    expect(await verifyRequesterSessionMachineAdmissionCurrent(fresh)).toBe(false);
    const beforeSync = host.requests.length;
    expect(await requesterCredentialOwner.resolveWorkspaceSyncSourceCredentialCustody({ ...binding,
      serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary })).toMatchObject(credentials);
    expect(await requesterCredentialOwner.verifyWorkspaceSyncSourceMachineAdmissionCurrent(fresh)).toBe(true);
    host.setMachineRole('use');
    expect(await requesterCredentialOwner.resolveWorkspaceSyncRelationshipCredentialCustody({ ...binding,
      serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary })).not.toBeNull();
    expect(await requesterCredentialOwner.verifyWorkspaceSyncRelationshipMachineAdmissionCurrent(fresh)).toBe(true);
    expect(host.requests.slice(beforeSync).some(request => request.path.endsWith('/admission/verify')
      || request.path.startsWith('/v2/sessions/'))).toBe(false);
    expect(await verifyRequesterSessionMachineAdmissionCurrent({ ...fresh, sessionId: 'session' })).toBe(true);
  });

  it.each(['source', 'target'] as const)('recovers Sync %s custody with fresh authenticated HTTP while another valid credential observes the same Account', async endpoint => {
    const host = await home({ machineGrantCount: 1 });
    const binding = { happyHomeDir: directory!, relationshipId: 'other-token-sync', attribution };
    const custody = endpoint === 'source'
      ? await requesterCredentialOwner.createWorkspaceSyncSourceCredentialCustody({ ...binding, credentials })
      : await requesterCredentialOwner.createWorkspaceSyncRelationshipCredentialCustody({ ...binding, credentials,
        executionIdentity: { kind: 'isolated', requester: attribution, separationRequired: true } });
    const original = await readFile(custody.path, 'utf8');
    // Both credentials authenticate as this Account in the real HTTP fixture.
    // A different live Session holds the Account observation under its own token.
    const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: attribution.accountId,
      token: 'other-valid-requester-token', serverBaseUrl: origin });
    const recover = () => endpoint === 'source'
      ? requesterCredentialOwner.resolveWorkspaceSyncSourceCredentialCustody({ ...binding, serverHttpBaseUrl: origin,
        machineAdmissionBoundary: host.boundary })
      : requesterCredentialOwner.resolveWorkspaceSyncRelationshipCredentialCustody({ ...binding, serverHttpBaseUrl: origin,
        machineAdmissionBoundary: host.boundary });
    try {
      await observation.read();
      expect(await recover()).not.toBeNull();
      await expect(readFile(custody.path, 'utf8')).resolves.toBe(original);
    } finally { await observation.dispose(); }
    expect(await recover()).not.toBeNull();
    expect(await readFile(custody.path, 'utf8')).toBe(original);
  });

  it.each(['source', 'target'] as const)('preserves Sync %s custody when Machine admission is unavailable, then retires a definite refusal', async endpoint => {
    const host = await home({ machineGrantCount: 1 });
    const binding = { happyHomeDir: directory!, relationshipId: 'unavailable-sync', attribution };
    const custody = endpoint === 'source'
      ? await requesterCredentialOwner.createWorkspaceSyncSourceCredentialCustody({ ...binding, credentials })
      : await requesterCredentialOwner.createWorkspaceSyncRelationshipCredentialCustody({ ...binding, credentials,
        executionIdentity: { kind: 'isolated', requester: attribution, separationRequired: true } });
    let homeCurrent = false;
    const boundary = { ...host.boundary, isHomeCurrent: () => homeCurrent };
    const recover = () => endpoint === 'source'
      ? requesterCredentialOwner.resolveWorkspaceSyncSourceCredentialCustody({ ...binding, serverHttpBaseUrl: origin, machineAdmissionBoundary: boundary })
      : requesterCredentialOwner.resolveWorkspaceSyncRelationshipCredentialCustody({ ...binding, serverHttpBaseUrl: origin, machineAdmissionBoundary: boundary });
    await expect(recover()).rejects.toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
    await expect(access(custody.path)).resolves.toBeUndefined();
    homeCurrent = true;
    host.setUnavailablePath('/v1/machines/machine');
    await expect(recover()).rejects.toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
    await expect(access(custody.path)).resolves.toBeUndefined();
    host.setUnavailablePath(null);
    host.setAccess(false);
    expect(await recover()).toBeNull();
    await expect(access(custody.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['plain', 'e2ee'] as const)('retains %s requester birth across daemon restart admission refusal and resumes from the same disk custody', async mode => {
    const encryptionSecret = mode === 'e2ee' ? new Uint8Array(32).fill(23) : undefined;
    const requesterCredentials = encryptionSecret
      ? { token: credentials.token, encryption: { type: 'legacy' as const, secret: encryptionSecret } }
      : credentials;
    const host = await home({ encryptionSecret, requesterReadsOnly: true });
    const binding = { happyHomeDir: directory!, sessionId: 'session', attribution };
    const custody = await createRequesterSessionCredentialCustody({ ...binding, credentials: requesterCredentials,
      homeServerIdentityId: 'srv_original_home' });
    const original = await readFile(custody.path, 'utf8');
    // A restarted daemon has no tracked requester context. Its ordinary cold
    // discovery must keep the exact birth when Home refuses signed admission
    // even though the authenticated requester still has Machine access.
    const recover = () => requesterCredentialOwner.resolveRequesterSessionBootstrapFromCustody({
      happyHomeDir: directory!, sessionId: binding.sessionId, serverId: attribution.serverId,
      serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary,
      legacyOwnerCredentials: { token: 'alice-daemon', encryption: null },
    });
    const running = await recover();
    expect(running?.getBoundSessionId()).toBe(binding.sessionId);
    expect(host.requests.filter(request => request.path.endsWith('/admission/verify'))).toHaveLength(1);
    await running?.dispose();
    host.setSignedAdmissionAvailable(false);
    expect(await recover()).toBeNull();
    expect(host.requests.filter(request => request.path.endsWith('/admission/verify'))).toHaveLength(2);
    expect(await readFile(custody.path, 'utf8')).toBe(original);
    host.setSignedAdmissionAvailable(true);
    const resumed = await recover();
    expect(host.requests.filter(request => request.path.endsWith('/admission/verify'))).toHaveLength(3);
    expect(resumed?.getBoundSessionId()).toBe(binding.sessionId);
    expect(resumed?.attribution).toEqual(attribution);
    expect(resumed?.credentials.token).toBe(requesterCredentials.token);
    await resumed?.dispose();
    host.setAccountId('another-person');
    expect(await recover()).toBeNull();
    await expect(access(custody.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['direct', 'cold', 'session-binding'] as const)('retires ordinary crash custody only after definite %s recovery refusal', async recovery => {
    const host = await home();
    const binding = { happyHomeDir: directory!, sessionId: 'session', attribution };
    const custody = await createRequesterSessionCredentialCustody({ ...binding, credentials, homeServerIdentityId: 'srv_original_home' });
    const other = await createRequesterSessionCredentialCustody({ ...binding, sessionId: 'cara-session',
      attribution: { ...attribution, accountId: 'cara' }, credentials: { token: 'cara-fixture', encryption: null } });
    const recover = () => recovery !== 'direct'
      ? requesterCredentialOwner.resolveRequesterSessionBootstrapFromCustody({ ...binding, serverId: attribution.serverId,
        serverHttpBaseUrl: origin, expectedAttribution: attribution, machineAdmissionBoundary: host.boundary })
      : resolveRequesterSessionCredentials({ ...binding, serverHttpBaseUrl: origin,
        verifyMachineAdmissionCurrent: () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution,
          sessionId: binding.sessionId, serverHttpBaseUrl: origin, boundary: host.boundary }) });
    const admitted = await recover();
    expect(admitted).not.toBeNull();
    if (admitted && 'dispose' in admitted) await admitted.dispose();
    if (recovery === 'session-binding') host.setSessionRole('view');
    else host.setAccess(false);
    // The runner crashes after revocation, leaving custody for recovery.
    await expect(promisify(execFile)(process.execPath, ['-e', 'process.exitCode = 1']))
      .rejects.toMatchObject({ code: 1 });
    await expect(access(custody.path)).resolves.toBeUndefined();
    await expect(recover()).resolves.toBeNull();
    // The direct caller supplies only an opaque boolean; cold recovery owns
    // the Home evidence that distinguishes withdrawal from unavailability.
    if (recovery === 'direct') await expect(access(custody.path)).resolves.toBeUndefined();
    else await expect(access(custody.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(other.path)).resolves.toBeUndefined();
    host.setAccess(true);
    host.setSessionRole('owner');
    if (recovery !== 'direct') {
      await expect(recover()).resolves.toBeNull();
      await createRequesterSessionCredentialCustody({ ...binding, credentials, homeServerIdentityId: 'srv_original_home' });
    }
    const recovered = await recover();
    expect(recovered).not.toBeNull();
    if (recovered && 'dispose' in recovered) await recovered.dispose();
    await expect(access(custody.path)).resolves.toBeUndefined();
    await expect(access(other.path)).resolves.toBeUndefined();
  });

  it.each(['home-withdrawal', 'machine-refusal', 'session-role-withdrawal'] as const)(
    'retires direct Session custody only when %s recovery yields definite withdrawal', async failure => {
      const host = await home();
      let homeCurrent = true;
      const boundary = { ...host.boundary, isHomeCurrent: () => homeCurrent };
      const binding = { happyHomeDir: directory!, sessionId: 'session', attribution };
      const custody = await createRequesterSessionCredentialCustody({ ...binding, credentials });
      const recover = () => resolveRequesterSessionCredentials({ ...binding, serverHttpBaseUrl: origin,
        verifyMachineAdmissionCurrent: () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution,
          sessionId: binding.sessionId, serverHttpBaseUrl: origin, boundary }) });
      expect((await recover())?.token).toBe(credentials.token);
      if (failure === 'home-withdrawal') homeCurrent = false;
      if (failure === 'machine-refusal') host.setAccess(false);
      if (failure === 'session-role-withdrawal') host.setSessionRole('view');
      await expect(recover()).resolves.toBeNull();
      if (failure === 'session-role-withdrawal') await expect(access(custody.path)).rejects.toMatchObject({ code: 'ENOENT' });
      else await expect(access(custody.path)).resolves.toBeUndefined();
      homeCurrent = true;
      host.setAccess(true);
      host.setSessionRole('owner');
      if (failure === 'session-role-withdrawal') {
        await expect(recover()).resolves.toBeNull();
        await createRequesterSessionCredentialCustody({ ...binding, credentials });
      }
      expect((await recover())?.token).toBe(credentials.token);
      await expect(access(custody.path)).resolves.toBeUndefined();
    });

  it.each(['machine-home', 'binding-home', 'network', 'cancelled', 'retargeted-home', 'home-changed-during-read', 'invalid-home-response', 'invalid-admission-response'] as const)(
    'retains requester recovery custody across %s and admits after recovery', async failure => {
      let homeCurrent = true;
      let changeHomeDuringRead = failure === 'home-changed-during-read';
      const host = await home({ beforeMachineAccessRead: async () => {
        if (changeHomeDuringRead) homeCurrent = false;
      } });
      const binding = { happyHomeDir: directory!, sessionId: 'session', attribution };
      const custody = await createRequesterSessionCredentialCustody({ ...binding, credentials, homeServerIdentityId: 'srv_original_home' });
      const controller = new AbortController();
      const boundary = { ...host.boundary, isHomeCurrent: () => homeCurrent };
      const recover = (signal?: AbortSignal) => requesterCredentialOwner.resolveRequesterSessionBootstrapFromCustody({
        ...binding, serverId: attribution.serverId, serverHttpBaseUrl: origin, expectedAttribution: attribution,
        machineAdmissionBoundary: boundary, signal });
      try {
        if (failure === 'machine-home') host.setUnavailablePath('/v1/machines/machine');
        if (failure === 'binding-home') host.setUnavailablePath('/v2/sessions/session');
        if (failure === 'network') vi.spyOn(axios, 'get').mockRejectedValueOnce(new axios.AxiosError('fixture transport failure', 'ECONNRESET'));
        if (failure === 'invalid-home-response') {
          const get = axios.get.bind(axios);
          vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            const response = await get(url, config);
            return String(url).endsWith('/v2/sessions/session') ? { ...response, data: { session: { id: 'session' } } } : response;
          });
        }
        if (failure === 'invalid-admission-response') {
          const post = axios.post.bind(axios);
          vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            const response = await post(url, body, config);
            return String(url).endsWith('/admission/verify') ? { ...response, data: {} } : response;
          });
        }
        if (failure === 'cancelled') controller.abort();
        if (failure === 'retargeted-home') homeCurrent = false;
        if (['cancelled', 'retargeted-home', 'home-changed-during-read', 'invalid-home-response', 'invalid-admission-response'].includes(failure))
          await expect(recover(controller.signal)).resolves.toBeNull();
        else await expect(recover()).rejects.toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
        await expect(access(custody.path)).resolves.toBeUndefined();
      } finally { vi.restoreAllMocks(); host.setUnavailablePath(null); homeCurrent = true; changeHomeDuringRead = false; }
      const admitted = await recover();
      expect(admitted?.getBoundSessionId()).toBe('session');
      await admitted?.dispose();
    });

  it('reads one exact Machine per binding evaluation without its inventory or grant roster, and refuses later revocation', async () => {
    const host = await home({ machineGrantCount: 128 });
    const phases = vi.spyOn(logger, 'debug');
    const verify = () => verifyRequesterSessionCredentialBinding({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, verifyMachineAdmissionCurrent: () => verifyRequesterSessionMachineAdmissionCurrent({
        credentials, attribution, sessionId: 'session', serverHttpBaseUrl: origin, boundary: host.boundary }) });
    try {
      // Report cold and warm fixtures; counts, rather than timing noise, gate cost.
      for (let iteration = 0; iteration < 2; iteration++) {
        phases.mockClear();
        expect(await verify()).toBe(true);
        console.info('REQLATENCY fixture warmup', iteration, JSON.stringify(phases.mock.calls
          .filter(([label]) => label === '[PluginExec] Requester currentness phase').map(([, phase]) => phase)));
      }
      host.requests.length = 0;
      phases.mockClear();
      const before = host.readReturnedRows();
      expect(await verify()).toBe(true);
      const paths = host.requests.map(request => request.path);
      const measured = phases.mock.calls.filter(([label]) => label === '[PluginExec] Requester currentness phase')
        .map(([, phase]) => phase);
      console.info('REQLATENCY fixture phases', JSON.stringify(measured));
      const after = host.readReturnedRows();
      expect({ machine: after.machine - before.machine, grants: after.grants - before.grants }).toEqual({ machine: 1, grants: 0 });
      expect(paths.filter(path => path === '/v1/machines/machine')).toHaveLength(1);
      expect(paths.filter(path => path === '/v1/machines' || path.endsWith('/access'))).toHaveLength(0);
      expect(paths.filter(path => path === '/v1/account/profile')).toHaveLength(1);
      expect(host.requests.filter(request => request.path.startsWith('/v2/sessions/session')).map(request => request.purpose))
        .toEqual(['session-detail:requester-binding']);
      expect(paths.filter(path => path.endsWith('/admission/verify'))).toHaveLength(1);
      host.setAccess(false);
      expect(await verify()).toBe(false);
    } finally { phases.mockRestore(); }
  });
  it.each(['plain', 'e2ee'] as const)('shares one in-flight Settings read across 16 identical requester admissions, then reads fresh again (%s)', async mode => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const secret = new Uint8Array(32).fill(31);
    const requesterCredentials = { ...credentials, encryption: mode === 'e2ee' ? { type: 'legacy' as const, secret } : null };
    const host = await home({ beforeSettingsRead: () => held, ...(mode === 'e2ee' ? { encryptionSecret: secret } : {}) });
    const phases = vi.spyOn(logger, 'infoFile');
    const prepare = () => prepareRequesterSessionBootstrap({ credentials: requesterCredentials, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: () => verifyRequesterSessionMachineAdmissionCurrent({ credentials: requesterCredentials, attribution,
        sessionId: 'session', serverHttpBaseUrl: origin, boundary: host.boundary }), boundSessionId: 'session' });
    const pending = Promise.all(Array.from({ length: 16 }, prepare));
    let reads = 0;
    try {
      await expect.poll(() => phases.mock.calls.filter(([label, fact]) => label === '[accountSettings] Bootstrap phase'
        && fact !== null && typeof fact === 'object' && 'phase' in fact && fact.phase === 'cache_read'
        && 'status' in fact && fact.status === 'completed').length).toBe(16);
      await expect.poll(() => host.requests.filter(request => request.path === '/v2/account/settings').length).toBeGreaterThan(0);
      reads = host.requests.filter(request => request.path === '/v2/account/settings').length;
    } finally { release(); phases.mockRestore(); }
    const admitted = await pending;
    try {
      expect(reads).toBe(1);
      expect(admitted.every(value => value?.admitted.accountSettingsContext.source === 'network')).toBe(true);
      expect(new Set(admitted.map(value => value?.admitted.savedSecretOperationContext)).size).toBe(16);
      const next = await prepare();
      expect(next).not.toBeNull();
      await next?.cleanupOnFailure();
      expect(host.requests.filter(request => request.path === '/v2/account/settings')).toHaveLength(2);
    } finally { await Promise.all(admitted.map(value => value?.cleanupOnFailure())); }
  });

  it('reads distinct requester credential scopes once each', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const host = await home({ beforeSettingsRead: () => held });
    const rotated = { ...credentials, token: credentials.token.replace('.fixture', '.rotated') };
    const pending = Promise.all([credentials, rotated].map(requesterCredentials => prepareRequesterSessionBootstrap({
      credentials: requesterCredentials, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: () => verifyRequesterSessionMachineAdmissionCurrent({ credentials: requesterCredentials,
        attribution, sessionId: 'session', serverHttpBaseUrl: origin, boundary: host.boundary }), boundSessionId: 'session' })));
    try { await expect.poll(() => host.requests.filter(request => request.path === '/v2/account/settings').length).toBe(2); }
    finally { release(); }
    const admitted = await pending;
    try { expect(admitted.every(value => value !== null)).toBe(true); }
    finally { await Promise.all(admitted.map(value => value?.cleanupOnFailure())); }
  });

  it('does not reuse a superseded Account read when the requester Account switches mid-flight', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const host = await home({ beforeSettingsRead: () => held });
    const controller = new AbortController();
    const prepare = (accountId: string, token: string, signal?: AbortSignal) => prepareRequesterSessionBootstrap({
      credentials: { token, encryption: null }, attribution: { ...attribution, accountId }, signal,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: () => verifyRequesterSessionMachineAdmissionCurrent({
        credentials: { token, encryption: null }, attribution: { ...attribution, accountId },
        sessionId: 'session', serverHttpBaseUrl: origin, boundary: host.boundary }) });
    const old = prepare('bob', credentials.token, controller.signal).catch(() => null);
    await expect.poll(() => host.requests.filter(request => request.path === '/v2/account/settings').length).toBe(1);
    controller.abort();
    host.setAccountId('alice');
    const aliceToken = `e30.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.fixture`;
    const next = prepare('alice', aliceToken);
    try { await expect.poll(() => host.requests.filter(request => request.path === '/v2/account/settings').length).toBe(2); }
    finally { release(); }
    expect(await old).toBeNull();
    const admitted = await next;
    try { expect(admitted?.admitted.attribution.accountId).toBe('alice'); }
    finally { await admitted?.cleanupOnFailure(); }
  });

  it.each(['plain', 'e2ee'] as const)('admits early original requester input through exact retained Session custody without another credential box (%s)', async mode => {
    const sessionId = 'c123456789012345678901234';
    const secret = new Uint8Array(32).fill(31);
    const requesterCredentials = { ...credentials, encryption: mode === 'e2ee' ? { type: 'legacy' as const, secret } : null };
    const host = await home({ sessionId, sessionActive: true, requesterReadsOnly: true, ...(mode === 'e2ee' ? { encryptionSecret: secret } : {}) });
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials: requesterCredentials, attribution, sessionId,
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const prepared = await prepareRequesterSessionBootstrap({ credentials: requesterCredentials, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: current, boundSessionId: sessionId, preparedSessionId: sessionId });
    if (!prepared) throw new Error('Missing real retained requester bootstrap');
    const identity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
      installationId: attribution.installationId, createdAt: 1, publicKey: Buffer.from(host.keyPair.publicKey).toString('base64url'),
      privateKey: Buffer.from(host.keyPair.secretKey).toString('base64url') });
    const handlers = new Map<string, RpcHandler>();
    const admittedInputs: unknown[] = [];
    const input = { sessionId, message: 'Queue before the native child exists', localId: 'requester-early-input', wait: false };
    const target = { kind: 'session' as const, sessionId };
    const authentication = { kind: 'account' as const, tokenEpoch: 1 };
    const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
    const binding = { serverIdentityId: 'srv_requester_home', accountId: 'bob', authentication,
      actionId: 'session.message.send', requestId: 'early-input-root', target };
    const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, input, randomBytes: tweetnacl.randomBytes })
      : { v: 1 as const, requestId: binding.requestId, target, input };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-early-input', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication, accountEncryptionMode: mode,
      serverIdentityId: 'srv_requester_home', machineId: 'machine', installationId: attribution.installationId,
      actionId: 'session.message.send', requestId: envelope.requestId,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target,
    } });
    host.setSessionActionAuthorization(authorization);
    registerExternalActionRpcHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
      machineId: 'machine', currentServerId: attribution.serverId, currentServerHttpBaseUrl: origin,
      resolveAccountId: async () => 'alice', resolveInstallationId: () => attribution.installationId,
      externalActionMachineRequestPrivateKey: host.keyPair.secretKey, verifyExecutionAuthorization: current,
      executor: createActionExecutor(createUnavailableActionTransportDeps()),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice-daemon', encryption: null } }),
      prepareRequesterAccountContext: async request => {
        let requesterTargetResolver: ReturnType<typeof createDaemonExternalActionTargetResolver> | undefined;
        const requester = await prepareInstalledRequesterAccountActionContext({ ...request,
          purpose: { kind: 'external_action' }, machineId: 'machine', serverId: attribution.serverId, serverHttpBaseUrl: origin,
          resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: 'srv_requester_home' }),
          // The fixture retains this Session custody across ingress attempts.
          resolveRequesterSessionBootstrap: async id => id === sessionId ? { ...prepared.admitted, release: async () => {} } : null,
          createExecutor: admitted => {
            requesterTargetResolver = createDaemonExternalActionTargetResolver({ credentials: admitted.credentials, serverApiUrl: origin });
            return createActionExecutor(createCliActionDeps({ token: admitted.credentials.token,
              credentials: admitted.credentials, sessionId: '', ...(mode === 'e2ee'
                ? { mode: 'e2ee' as const, ctx: { encryptionKey: secret, encryptionVariant: 'legacy' as const } }
                : { mode: 'plain' as const, ctx: null }), serverId: attribution.serverId,
              serverIdentityId: 'srv_requester_home', serverHttpBaseUrl: origin,
              externalActionMachineRequestPrivateKey: host.keyPair.secretKey,
              externalActionMachineInstallationId: attribution.installationId,
              machineActionDirectTargetTransport: { machineId: attribution.machineId, invoke: async () => {
                throw new Error('Early Session input uses the installed Machine admission transport');
              } },
              machineAdmissionTransport: async (raw, options) => {
                const request = SessionPendingEnqueueByMachineRequestV1Schema.parse(raw);
                expect(options?.callerInputAuthorization?.token).toBe(authorization.token);
                expect(request.targetMachineId).toBe(attribution.machineId);
                const message = request.content.t === 'plain' ? request.content.v
                  : decryptSessionPayload({ ctx: { encryptionKey: secret, encryptionVariant: 'legacy' }, ciphertextBase64: request.content.c });
                expect(message).toMatchObject({ content: { text: input.message }, meta: { happierInputRequestV1: { producer: 'happierApp' } } });
                if (mode === 'e2ee') expect(request.requestEqualityEvidenceV1).toMatchObject({ kind: 'e2eeTag' });
                admittedInputs.push(request);
                return { status: 'accepted', localId: request.localId };
              } }));
          },
        });
        return requester ? { ...requester, resolveTarget: requesterTargetResolver } : null;
      },
    });
    const dispatch = ExternalActionDaemonDispatchRequestSchema.parse({
      actionId: 'session.message.send', envelope, executionAuthorization: authorization,
      principal: { accountId: 'bob', authentication, authority: 'present_user' },
      placement: { machineId: 'machine', target: { kind: 'machine', machineId: 'machine' } },
    });
    let rawResponse: unknown;
    const invoke = async (request = dispatch) => {
      rawResponse = await handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)?.(request,
        { authorization: ACTION_API_SERVER_ORIGIN, signal: new AbortController().signal });
      return parseExternalActionDaemonDispatchResult(rawResponse);
    };
    const executionFor = (result: Awaited<ReturnType<typeof invoke>>, request = dispatch) => {
      if (result?.kind !== 'response') return null;
      if (result.prepared.response.v === 1) return result.prepared.response.execution;
      const root = request.executionAuthorization?.binding;
      return request.envelope.v === 2 && root && 'authentication' in root
        ? openExternalActionResponseV2({ request: request.envelope, envelope: result.prepared.response,
          binding: { serverIdentityId: root.serverIdentityId, accountId: root.accountId, authentication: root.authentication,
            actionId: root.actionId, requestId: root.requestId, target: root.target }, material }) : null;
    };
    const changedRoot = (change: Readonly<{ accountId?: string; serverIdentityId?: string; installationId?: string; sessionId?: string }>) => {
      const target = { kind: 'session' as const, sessionId: change.sessionId ?? sessionId };
      const nextBinding = { ...binding, target, accountId: change.accountId ?? binding.accountId,
        serverIdentityId: change.serverIdentityId ?? binding.serverIdentityId };
      const nextInput = { ...input, sessionId: target.sessionId };
      const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: nextBinding, material, input: nextInput, randomBytes: tweetnacl.randomBytes })
        : { v: 1 as const, requestId: binding.requestId, target, input: nextInput };
      return ExternalActionDaemonDispatchRequestSchema.parse({ ...dispatch, envelope,
        principal: { accountId: nextBinding.accountId, authentication, authority: 'present_user' },
        executionAuthorization: { ...authorization, binding: { ...authorization.binding, ...nextBinding,
          installationId: change.installationId ?? attribution.installationId,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } } });
    };
    let expectedAdmissions = 1;
    const expectRefused = async (request = dispatch) => {
      const result = await runWithServerHttpBaseUrl(origin, () => invoke(request));
      expect(result).not.toBeNull();
      expect(executionFor(result, request)?.ok).not.toBe(true);
      expect(admittedInputs).toHaveLength(expectedAdmissions);
      expect(host.pendingInputs).toHaveLength(0);
    };
    try {
      const result = await runWithServerHttpBaseUrl(origin, invoke);
      const execution = executionFor(result);
      expect(execution, JSON.stringify({ resultKind: result?.kind,
        refusalCode: result?.kind === 'invalid_request' ? result.errorCode : undefined,
        requestedPaths: host.requests.map(request => request.path) }))
        .toEqual({ ok: true, result: { status: 'accepted', localId: input.localId } });
      expect(admittedInputs).toHaveLength(1);
      expect(host.pendingInputs).toHaveLength(0);
      for (const change of [{ accountId: 'another-requester' }, { serverIdentityId: 'srv_another_home' },
        { installationId: 'another-installation' }, { sessionId: 'c223456789012345678901234' }]) {
        await expectRefused(changedRoot(change));
      }
      // A supplied but unopened box must not fall back to retained Session custody.
      const wrongRecipient = sealExternalActionRequesterAccountContextV1({ authorization,
        purpose: { kind: 'external_action' }, credentials: { ...encodeStoredCredentials(requesterCredentials), token: requesterCredentials.token },
        installationPublicKey: tweetnacl.sign.keyPair().publicKey, randomBytes: tweetnacl.randomBytes });
      await expectRefused({ ...dispatch, executionAuthorization: wrongRecipient });
      host.setAccess(false);
      await expectRefused();
      host.setAccess(true);
      // A successful send does not make subsequent Home evidence available.
      // Exercise the next-send refusal through registered RPC and retained
      // Session custody, then recover with the same durable input identity.
      host.setUnavailablePath(`/v2/sessions/${sessionId}`);
      const unavailable = await runWithServerHttpBaseUrl(origin, invoke);
      expect(unavailable).toMatchObject({ kind: 'response' });
      expect(executionFor(unavailable)).toMatchObject({ ok: false,
        errorCode: 'target_unavailable', effectAttempted: false });
      expect(admittedInputs).toHaveLength(1);
      host.setUnavailablePath(null);
      expect(executionFor(await runWithServerHttpBaseUrl(origin, invoke)))
        .toEqual({ ok: true, result: { status: 'accepted', localId: input.localId } });
      expectedAdmissions = 2;
      expect(admittedInputs).toHaveLength(expectedAdmissions);
      expect(admittedInputs.map(request => SessionPendingEnqueueByMachineRequestV1Schema.parse(request).localId))
        .toEqual([input.localId, input.localId]);
      await prepared.cleanupOnFailure();
      await expectRefused();
    } finally { identity.mockRestore(); await prepared.cleanupOnFailure(); }
  });
  it('admits requester preparation once, avoids Machine rechecks for admitted readers, and refuses the next admission after revocation', async () => {
    const host = await home();
    const prepare = () => prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution,
        sessionId: 'session', serverHttpBaseUrl: origin, boundary: host.boundary }) });
    const prepared = await prepare();
    if (!prepared) throw new Error('Missing requester bootstrap');
    const admissions = () => host.requests.filter(request => request.path.endsWith('/admission/verify')).length;
    try {
      expect(admissions()).toBe(1);
      host.requests.length = 0;
      for (let reader = 0; reader < 16; reader++) {
        await expect(prepared.admitted.isCurrent()).resolves.toBe(true);
      }
      expect(admissions()).toBe(0);
      host.setAccess(false);
      await expect(prepared.admitted.isCurrent()).resolves.toBe(true);
      await expect(prepare()).resolves.toBeNull();
      // The next admission refuses at its authenticated Machine-access read,
      // before Home needs another signed admission verification.
      expect(host.requests.filter(request => request.path === '/v1/machines/machine')).toHaveLength(1);
      expect(admissions()).toBe(0);
      await prepared.admitted.dispose();
      await expect(prepared.admitted.isCurrent()).resolves.toBe(false);
    } finally { await prepared.cleanupOnFailure(); }
  });

  it.each(['plain', 'e2ee'] as const)('borrows installed credentials without withdrawing their finite-runtime identity and retains private scope restrictions (%s)', async mode => {
    const host = await home();
    host.setAccountMode(mode);
    const serialized = { token: credentials.token,
      ...(mode === 'e2ee' ? { secret: Buffer.alloc(32, 8).toString('base64') } : {}) };
    const installed = decodeStoredCredentials(serialized);
    const stored = decodeStoredCredentials(serialized);
    if (!installed || !stored) throw new Error('Missing canonical installed credentials');
    const prepare = () => prepareRequesterSessionBootstrap({ credentials: installed, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: async () => sameStoredCredentials(installed, stored) });
    const prepared = await prepare();
    try {
      expect(prepared, 'Requester scoping must not invalidate the supplying installed owner').not.toBeNull();
      expect(sameStoredCredentials(installed, stored)).toBe(true);
      expect(installed.requesterSessionCredentialScope).toBeUndefined();
      expect(prepared?.admitted.credentials.requesterSessionCredentialScope).toEqual({
        serverId: attribution.serverId, serverHttpBaseUrl: origin,
      });
      bindRequesterSessionCredentialScope(installed, { serverId: 'other-home', serverHttpBaseUrl: 'https://other-home.test' });
      await expect(prepareRequesterSessionBootstrap({ credentials: installed, attribution,
        boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
        verifyMachineAdmissionCurrent: async () => true })).rejects.toThrow('requester_session_credential_scope_mismatch');
      expect(installed.requesterSessionCredentialScope?.serverId).toBe('other-home');
    } finally { await prepared?.cleanupOnFailure(); }
  });

  it.each(['/v1/account/profile', '/v2/sessions/session', '/v1/machines/machine', '/v1/machines/machine/admission/verify', 'admission-timeout', 'machine-access-timeout'])(
    'preserves requester custody across an unavailable Home read at %s without treating it as revocation', async path => {
      const host = await home();
      const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
        serverHttpBaseUrl: origin, boundary: host.boundary });
      const prepared = await prepareRequesterSessionBootstrap({ credentials, attribution, boundSessionId: 'session',
        boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
        verifyMachineAdmissionCurrent: current });
      if (!prepared) throw Error('Missing real requester bootstrap');
      const context = prepared.admitted.savedSecretOperationContext;
      const snapshot = context.readSnapshot();
      await createRequesterSessionCredentialCustody({ happyHomeDir: directory!, sessionId: 'session', attribution,
        credentials, homeServerIdentityId: 'srv_original_home' });
      const recover = () => resolveRequesterSessionBootstrap({ happyHomeDir: directory!, sessionId: 'session', attribution,
        serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary });
      try {
        if (path === 'admission-timeout') {
          // Axios is the Home transport boundary. Reproduce the exact loaded
          // Machine-admission ECONNABORTED without a production timer.
          vi.spyOn(axios, 'post').mockRejectedValueOnce(new axios.AxiosError('never-log-request', 'ECONNABORTED'));
        } else if (path === 'machine-access-timeout') {
          const get = axios.get.bind(axios);
          vi.spyOn(axios, 'get').mockImplementation((url, config) => String(url).endsWith('/v1/machines/machine')
            ? Promise.reject(new axios.AxiosError('never-log-request', 'ECONNABORTED')) : get(url, config));
        } else host.setUnavailablePath(path);
        await expect(recover()).rejects.toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
        expect(context.readSnapshot()).toBe(snapshot);
        host.setUnavailablePath(null);
        vi.restoreAllMocks();
        const recovered = await recover();
        expect(await recovered?.isCurrent()).toBe(true);
        await recovered?.dispose();
        host.setAccess(false);
        expect(await recover()).toBeNull();
        expect(await context.isCurrent()).toBe(true);
        await prepared.admitted.dispose();
        expect(context.readSnapshot()).toBeNull();
      } finally { host.setUnavailablePath(null); vi.restoreAllMocks(); await prepared.cleanupOnFailure(); }
    },
  );

  it('recovers protected Session custody when a peer with its exact credential disposes during admission', async () => {
    const secret = new Uint8Array(32).fill(23);
    const host = await home({ encryptionSecret: secret });
    const binding = { happyHomeDir: directory!, sessionId: 'session', attribution };
    await createRequesterSessionCredentialCustody({ ...binding, homeServerIdentityId: 'srv_original_home',
      credentials: { ...credentials, encryption: { type: 'legacy', secret } } });
    const recover = () => resolveRequesterSessionBootstrap({ ...binding, serverHttpBaseUrl: origin,
      machineAdmissionBoundary: host.boundary });

    // A separate admitted bearer keeps the shared Account channel alive.
    const peer = acquireRequesterAccountEncryptionCurrentness({ accountId: attribution.accountId, serverBaseUrl: origin,
      token: 'other-admitted-credential' });
    try {
      await peer.read();
      const first = await recover();
      if (!first) throw new Error('Missing initial requester recovery');
      const entered = createDeferred();
      const release = createDeferred();
      const get = axios.get.bind(axios);
      const read = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
        if (String(url).endsWith('/v2/sessions/session')) {
          entered.resolve();
          await release.promise;
        }
        return get(url, config);
      });
      const pending = recover();
      try {
        await Promise.race([entered.promise, pending.then(() => { throw new Error('Recovery finished before Session binding'); })]);
        await first.dispose();
        release.resolve();
        const recovered = await pending;
        expect(recovered?.getBoundSessionId()).toBe(binding.sessionId);
        expect(await recovered?.isCurrent()).toBe(true);
      } finally {
        release.resolve();
        read.mockRestore();
        await first.dispose();
        await pending.then(recovered => recovered?.dispose(), () => {});
      }
    } finally { await peer.dispose(); }
  });

  it('keeps the exact requester custody refusal cause when a retained Session cannot resume', async () => {
    const host = await home();
    const binding = { happyHomeDir: directory!, sessionId: 'session', attribution };
    await createRequesterSessionCredentialCustody({ ...binding, credentials, homeServerIdentityId: 'srv_original_home' });
    let observedHomeIdentity = 'srv_original_home';
    const recover = (expectedAttribution = attribution) => requesterCredentialOwner.resolveRequesterSessionBootstrapFromCustody({
      ...binding, serverId: attribution.serverId, expectedAttribution, serverHttpBaseUrl: origin,
      machineAdmissionBoundary: { ...host.boundary, getObservedServerIdentityId: () => observedHomeIdentity },
    });

    const admitted = await captureRequesterCurrentnessRefusal(recover);
    expect(admitted.value?.getBoundSessionId()).toBe(binding.sessionId);
    expect(admitted.branch).toBeUndefined();
    await admitted.value?.dispose();

    observedHomeIdentity = 'srv_replacement_home';
    const homeRefusal = await captureRequesterCurrentnessRefusal(recover);

    observedHomeIdentity = 'srv_original_home';
    const accountRefusal = await captureRequesterCurrentnessRefusal(() => recover({ ...attribution, accountId: 'another-account' }));
    expect({ home: homeRefusal, account: accountRefusal }).toEqual({
      home: { value: null, branch: 'requester_session_custody_home_mismatch' },
      account: { value: null, branch: 'requester_session_custody_account_mismatch' },
    });

    host.setUnavailablePath('/v2/sessions/session');
    const failedRecordRead = await captureRequesterCurrentnessRefusal(() => recover().catch((error: unknown) => error));
    expect(failedRecordRead).toMatchObject({
      value: { code: 'project_requester_home_unavailable', retryable: true },
      branch: 'requester_session_custody_record_read_failed',
    });

    const runtimeUnavailable = requesterCredentialOwner.createRequesterSessionRuntimeContextResolver({
      trackedSessions: new Map(),
      getCreateRuntime: () => null,
      recoverBootstrap: recover,
    });
    await expect(captureRequesterCurrentnessRefusal(() => runtimeUnavailable(binding.sessionId, binding.attribution)))
      .resolves.toEqual({ value: null, branch: 'requester_session_custody_runtime_unavailable' });

    host.setUnavailablePath(null);
    const recovered = await recover();
    expect(recovered?.getBoundSessionId()).toBe(binding.sessionId);
    await recovered?.dispose();
  });

  it.each(['protected', 'legacy'] as const)('preserves a retryable Home read failure during %s requester recovery and admits only after recovery', async kind => {
    const host = await home();
    if (kind === 'protected') await createRequesterSessionCredentialCustody({ happyHomeDir: directory!, sessionId: 'session', attribution, credentials,
      homeServerIdentityId: 'srv_original_home' });
    const recover = () => requesterCredentialOwner.resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: directory!,
      serverId: attribution.serverId, sessionId: 'session', serverHttpBaseUrl: origin,
      machineAdmissionBoundary: host.boundary, expectedAttribution: attribution, legacyOwnerCredentials: kind === 'legacy'
        ? bindRequesterSessionCredentialScope({ ...credentials }, { serverId: attribution.serverId, serverHttpBaseUrl: origin,
          requesterSession: { sessionId: 'session', attribution, homeServerIdentityId: 'srv_original_home' } }) : credentials });
    host.setSettingsAvailable(false);
    const failure = await recover().then(() => { throw new Error('Home failure must refuse requester recovery'); }, error => error as unknown);
    expect(failure).toMatchObject({ code: 'project_requester_home_unavailable' });
    const response = AgentRuntimeDaemonServiceResponseV1Schema.parse({ ok: false,
      error: projectRunnerDaemonPluginServicesFailure(failure) });
    expect(response).toMatchObject({ ok: false, error: { code: 'project_requester_home_unavailable',
      cause: { stage: 'dispatch', code: 'project_requester_home_unavailable' } } });
    expect(resolveSessionRunnerFailureExitCode(failure)).toBe(1);
    host.setSettingsAvailable(true);
    const recovered = await recover();
    expect(recovered?.getBoundSessionId()).toBe('session');
    expect(await recovered?.isCurrent()).toBe(true);
    await recovered?.dispose();
    host.setAccess(false);
    expect(await recover()).toBeNull();
  });

  it.each(['protected', 'legacy', 'missing'] as const)('resolves %s existing-Session custody through the real local resume registration and refuses revoked or substituted ownership', async custodyKind => {
    const sessionId = 'caaaaaaaaaaaaaaaaaaaaaaaa';
    const host = await home({ sessionId, sessionSeq: 17, requesterReadsOnly: true });
    if (custodyKind === 'protected') await createRequesterSessionCredentialCustody({ happyHomeDir: directory!, sessionId, attribution, credentials,
      homeServerIdentityId: 'srv_original_home' });
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId,
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const machineAdmission = { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
      installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const launched: SpawnSessionOptions[] = [];
    let localAdmission: Awaited<ReturnType<typeof authorizeMachineRpcRequest>> | undefined;
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: async request => localAdmission = await authorizeMachineRpcRequest(request, {
        machineId: 'machine', resolveInstallationId: () => host.boundary.readInstallation()?.installationId ?? null,
        resolveCustodianAccountId: async () => 'alice',
        verifyMachineAdmission: async ({ context, method, signal }) => {
          const installation = host.boundary.readInstallation();
          return !!installation && await verifyMachineRpcAdmissionCurrent({ context, method,
            privateKey: installation.privateKey, daemonToken: host.boundary.daemonToken,
            serverHttpBaseUrl: origin, signal });
        },
      }) });
    const registry = new ConnectedServiceRuntimeRegistry();
    const trackedSessions = new Map<SessionTrackingKey, TrackedSession>();
    let requester: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
    const control = sessionControlFixture = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory!, activeServerDir: directory!,
      serverId: attribution.serverId, serverHttpBaseUrl: origin, machineId: 'machine', custodianAccountId: 'alice',
      credentials, connectedServicesMaterializationBaseDir: join(directory!, 'materialized'), registry, trackedSessions,
      getRequester: () => requester, resolveQualifiedConnectedAccountV4Support: () => 'indeterminate' });
    const resolve = async (sessionId: string, expected?: typeof attribution) => {
      const bootstrap = await requesterCredentialOwner.resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: directory!, sessionId,
        serverId: attribution.serverId, expectedAttribution: expected ?? attribution, serverHttpBaseUrl: origin,
        machineAdmissionBoundary: host.boundary, legacyOwnerCredentials: custodyKind === 'legacy'
          ? bindRequesterSessionCredentialScope({ ...credentials }, { serverId: attribution.serverId, serverHttpBaseUrl: origin,
            requesterSession: { sessionId, attribution, homeServerIdentityId: 'srv_original_home' } }) : credentials });
      if (!bootstrap) return null;
      requester = await createRequesterSessionRuntimeContext({ providerAccountUsageStore: createProviderAccountUsageStore(), bootstrap, activeServerDir: directory!,
        connectedServicesMaterializationBaseDir: join(directory!, 'materialized'),
        resolveQualifiedConnectedAccountV4Support: () => 'indeterminate', coordinatorInput: {
          machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'runtime', happyHomeDir: directory!,
          logger: { debug: () => {}, info: () => {}, warn: () => {} },
          processEnv: { HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
          trackedSessionsByKey: trackedSessions, connectedServiceRuntimeRegistry: registry,
          connectedServiceAuthGroupPreTurnSwitchCoordinator: control.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator,
        } });
      return requester;
    };
    sessionLifecycleRpc.registerPrivateSpawnSessionRpcHandlers({ rpcHandlerManager: rpc,
      spawnLifecycleHandler: createSpawnNewSessionLifecycleActionHandler({ serverId: attribution.serverId,
        // The physical Agent child is the only launch boundary substituted.
        spawnSession: async options => { launched.push(options); return { type: 'success', sessionId }; } }),
      requesterSessionRuntime: { serverId: attribution.serverId, resolve, release: runtime => runtime.dispose() },
    });
    const input = { type: 'resume-session' as const, sessionId, directory: '/workspace',
      backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const }, resume: 'same-native-session',
      permissionMode: 'read-only' as const,
      initialTranscriptAfterSeq: 99, initialGoal: { objective: 'Finish the task' }, spawnNonce: 'resume-attempt' };
    const constraints = { models: null, permissionModes: ['read-only' as const] };
    const options = { rpcContext: { machineAdmission, verifyMachineAdmissionCurrent: current,
      callerAuthority: 'account_automation' as const, callerInputConstraints: constraints } };
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
      serverId: attribution.serverId, serverIdentityId: 'portable-bob-home', serverHttpBaseUrl: origin,
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: (method, request, localOptions) =>
        rpc.invokeLocal(method, request, { ...localOptions, ...options }) },
    });
    if (!deps.sessionOpen) throw new Error('Missing canonical Session open owner');
    const resume = () => runWithServerHttpBaseUrl(origin, () => deps.sessionOpen!({ sessionId,
      serverId: 'portable-bob-home', intent: 'resume', resumeRequest: input }));
    const resumed = await resume();
    if (custodyKind === 'missing') {
      expect(resumed).toMatchObject({ ok: false, details: { errorDetail: {
        kind: 'launch_error', code: 'requester_session_custody_unavailable',
      } } });
      expect(launched).toHaveLength(0);
      return;
    }
    expect(resumed, JSON.stringify({ admission: localAdmission?.ok === false ? localAdmission.admissionPredicate : localAdmission?.ok,
      errorCode: resumed && typeof resumed === 'object' ? Reflect.get(resumed, 'errorCode') : null }))
      .toMatchObject({ ok: true, status: 'opened', sessionId });
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ existingSessionId: sessionId, resume: 'same-native-session',
      requesterWorkAttributionV1: attribution, callerInputConstraints: constraints,
      initialTranscriptAfterSeq: 17, initialGoal: { objective: 'Finish the task' } });
    expect(launched[0]?.requesterSessionBootstrap?.credentials.token).toBe(credentials.token);
    expect(launched[0]?.requesterSessionBootstrap?.getBoundSessionId()).toBe(sessionId);
    await expect(runWithServerHttpBaseUrl(origin, () => deps.sessionOpen!({ sessionId,
      serverId: 'portable-bob-home', intent: 'resume', resumeRequest: { ...input, sessionId: 'cbbbbbbbbbbbbbbbbbbbbbbbb' } })))
      .resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    const accountPrincipal = { accountId: 'bob', authority: 'account_automation' as const,
      authentication: { kind: 'account' as const, tokenEpoch: 1 } };
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const envelope = { v: 1 as const, requestId: 'resume-ingress', target,
      input: { serverId: 'portable-bob-home', sessionId, intent: 'resume', resumeRequest: input } };
    const authorization = sealExternalActionRequesterAccountContextV1({ authorization: { v: 1, token: 'home-resume-root',
      binding: { accountId: 'bob', custodianAccountId: 'alice', authentication: accountPrincipal.authentication,
        accountEncryptionMode: 'plain', serverIdentityId: 'portable-bob-home', machineId: 'machine', installationId: 'installation',
        actionId: 'session.open', requestId: envelope.requestId, target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } },
      credentials: encodeStoredCredentials(credentials), purpose: { kind: 'external_action' },
      installationPublicKey: host.keyPair.publicKey, randomBytes: tweetnacl.randomBytes });
    host.setSessionActionAuthorization(authorization);
    const admitted = await executeExternalAction({ actionId: 'session.open', envelope, principal: accountPrincipal,
      currentMachineId: 'machine', currentServerId: attribution.serverId, currentInstallationId: 'installation',
      executionAuthorization: authorization, externalActionMachineRequestPrivateKey: host.keyPair.secretKey,
      verifyExecutionAuthorization: current,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice-daemon', encryption: null }, serverApiUrl: origin }),
      executor: createActionExecutor(deps),
      prepareRequesterAccountContext: async request => {
        let resolveTarget: ReturnType<typeof createDaemonExternalActionTargetResolver> | undefined;
        const prepared = await prepareRequesterAccountActionContext({ ...request, purpose: { kind: 'external_action' },
          machineId: 'machine', installationId: 'installation', installationPrivateKey: host.keyPair.secretKey,
          serverId: attribution.serverId, serverIdentityId: 'portable-bob-home', serverHttpBaseUrl: origin, isCurrent: current,
          createExecutor: requester => {
            resolveTarget = createDaemonExternalActionTargetResolver({ credentials: requester.credentials,
              serverApiUrl: requester.serverHttpBaseUrl });
            const executor = createActionExecutor(createCliActionDeps({ token: requester.credentials.token,
            credentials: requester.credentials, sessionId: '', mode: 'plain', ctx: null, serverId: attribution.serverId,
            serverIdentityId: 'portable-bob-home', serverHttpBaseUrl: requester.serverHttpBaseUrl,
            externalActionMachineRequestPrivateKey: host.keyPair.secretKey, externalActionMachineInstallationId: 'installation',
            machineActionDirectTargetTransport: { machineId: 'machine', invoke: (method, request, localOptions) =>
              rpc.invokeLocal(method, request, { ...localOptions, ...options }) },
            }));
            return { execute: (actionId, actionInput, context) => runWithServerHttpBaseUrl(requester.serverHttpBaseUrl,
              () => executor.execute(actionId, actionInput, context)) };
          },
        });
        return prepared && resolveTarget ? { ...prepared, resolveTarget } : null;
      },
    });
    expect(admitted, JSON.stringify(admitted)).toMatchObject({ kind: 'response', response: {
      execution: { ok: true, result: { status: 'opened', sessionId } },
    } });
    expect(host.requests.some(request => request.path.startsWith('/v2/sessions/') && request.sessionActionAuthorized)).toBe(true);
    expect(host.requests.filter(request => request.path.startsWith('/v2/sessions/'))
      .every(request => request.bearer === `Bearer ${credentials.token}` || request.sessionActionAuthorized)).toBe(true);
    // The replay owner reconstructs this original private context after the
    // deciding caller has selected the executor. Resume must not use that
    // caller's broader closure in place of the original permission ceiling.
    const originalContext: RpcActionExecutorContext = { surface: 'ui', authority: 'account_automation',
      serverId: 'portable-bob-home', callerInputConstraints: constraints };
    const contextualExecutor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
      serverId: attribution.serverId, serverIdentityId: 'portable-bob-home', serverHttpBaseUrl: origin,
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: (method, request, localOptions) => {
        const delivered: RpcActionExecutorContext | undefined = localOptions?.localActionContext;
        return rpc.invokeLocal(method, request, { ...localOptions, rpcContext: { ...options.rpcContext,
          callerAuthority: delivered?.authority ?? 'present_user', callerInputConstraints: delivered?.callerInputConstraints } });
      } },
    }));
    const resumedWithOrigin = await runWithServerHttpBaseUrl(origin, () => contextualExecutor.execute('session.open', envelope.input, originalContext));
    expect(resumedWithOrigin, JSON.stringify(resumedWithOrigin)).toMatchObject({ ok: true, result: { status: 'opened', sessionId } });
    expect(launched.at(-1)?.callerInputConstraints).toEqual(constraints);
    const resumedFromMetadata = await runWithServerHttpBaseUrl(origin, () => contextualExecutor.execute('session.open', {
      serverId: 'portable-bob-home', sessionId, intent: 'resume',
    }, originalContext));
    expect(resumedFromMetadata, JSON.stringify(resumedFromMetadata)).toMatchObject({ ok: true, result: { status: 'opened', sessionId } });
    expect(launched.at(-1)?.callerInputConstraints).toEqual(constraints);
    const admittedLaunches = launched.length;
    await expect(rpc.invokeLocal(RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE, input, {
      rpcContext: { ...options.rpcContext, machineAdmission: { ...machineAdmission, actorAccountId: 'eve' } },
    })).resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    host.setAccess(false);
    await expect(resolve(sessionId)).resolves.toBeNull();
    await expect(access(requesterCredentialOwner.requesterSessionCredentialPath({ happyHomeDir: directory!, sessionId, attribution })))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(rpc.invokeLocal(RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE, input, options))
      .resolves.toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
    await expect(resume()).resolves.toMatchObject({ ok: false });
    expect(launched).toHaveLength(admittedLaunches);
  });

  it.skipIf(process.platform === 'win32').each(['bob', 'alice'])('carries authenticated Account admission into managed ACP first use (custodian %s)', async custodianAccountId => {
    const host = await home({ custodianAccountId });
    vi.stubEnv('HAPPIER_HOME_DIR', directory!);
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session', serverHttpBaseUrl: origin, boundary: host.boundary });
    const prepared = await admitRequesterSessionBootstrap({
      bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: encodeStoredCredentials(credentials) },
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      context: { signal: new AbortController().signal, machineAdmission: { actorAccountId: 'bob', custodianAccountId, machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: current },
    });
    if (!prepared) throw new Error('Missing admitted custody');
    const context = prepared.admitted.savedSecretOperationContext;
    const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{ id: 'custodian-managed', name: 'custodian-managed', title: 'Managed', createdAt: 1, updatedAt: 1,
      launch: { kind: 'npm', package: '@fixture/agent', version: '1.2.3', args: ['--acp'] }, env: { HAPPIER_HOME_DIR: { t: 'literal', v: join(directory!, 'authored-home') } },
    }] });
    expect(await context.commitAcpCatalog({ catalog: { status: 'ready', record, revision: 1 } }))
      .toMatchObject({ status: 'ready', revision: 1 });
    host.setAcpCatalog(record);
    const command = resolveAgentCliManagedCommandPathForRuntime(getAcpNpmRuntimeSpec(record.definitions[0]!, 'bob')!, { processEnv: process.env });
    await mkdir(dirname(command), { recursive: true }); await writeFile(command, '#!/bin/sh\nexit 0\n'); await chmod(command, 0o755);
    const workspace = join(dirname(dirname(command)), 'workspace');
    await mkdir(join(workspace, 'node_modules', '@fixture', 'agent'), { recursive: true });
    await writeFile(join(workspace, 'node_modules', '@fixture', 'agent', 'package.json'), JSON.stringify({ name: '@fixture/agent', version: '1.2.3', bin: { actual: 'agent.js' } }));
    await mkdir(join(workspace, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(workspace, 'node_modules', '.bin', 'actual'), '#!/bin/sh\nexit 0\n'); await chmod(join(workspace, 'node_modules', '.bin', 'actual'), 0o755);
    const launch = await resolveAccountConfiguredAcpLaunch('custodian-managed', context);
    await expect(launch.resolveHostLaunch({ cwd: directory! })).resolves.toMatchObject({ command, args: ['--acp'], env: { HAPPIER_HOME_DIR: join(directory!, 'authored-home') } });
    const handlers = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {} });
    const owner = createAgentInstallJobOwner({ accountId: custodianAccountId, readTrackedSessions: () => [], readAcpCatalog: () => undefined,
      readRegistry: () => ({ agents: [{ id: 'custom-acp', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
        pluginId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId }] }) });
    try {
      registerMachineAgentInstallJobRpcHandlers({ owner, rpcHandlerManager: handlers });
      if (custodianAccountId !== 'bob') {
        const ingress = { signal: new AbortController().signal, requesterSessionBootstrap: prepared.admitted,
          machineAdmission: { actorAccountId: 'bob', custodianAccountId, machineId: 'machine', installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const },
          verifyMachineAdmissionCurrent: current };
        const installed = DaemonAgentInstallStartResponseSchema.parse(await handlers.invokeLocal(RPC_METHODS.DAEMON_AGENTS_INSTALL_START,
          { agentId: 'custom-acp', definitionId: record.definitions[0]!.id, intent: 'install', consent: { vendorRecipe: false } }, { rpcContext: ingress }));
        expect(installed.ok).toBe(true); if (!installed.ok) throw new Error('Foreign install was not admitted');
        await vi.waitFor(() => expect(owner.read({ jobId: installed.jobId, cursor: 0 }, 'bob')).toMatchObject({ done: true, outcome: { kind: 'succeeded' } }));
        const custodianJobs = owner.list(custodianAccountId);
        expect(custodianJobs.ok).toBe(true);
        if (!custodianJobs.ok) throw new Error('Custodian job list unavailable');
        expect(custodianJobs.jobs).toEqual([]);
        expect(host.requests.filter(request => request.path === '/v1/account/entity-rows/acp').every(request => request.bearer === `Bearer ${credentials.token}`)).toBe(true);
        expect(await handlers.invokeLocal(RPC_METHODS.DAEMON_AGENTS_INSTALL_READ, { jobId: installed.jobId, cursor: 0 }, { rpcContext: { ...ingress,
          machineAdmission: { ...ingress.machineAdmission, actorAccountId: custodianAccountId } } })).toMatchObject({ ok: false, errorCode: 'job_not_found' });
      }
    } finally { await owner.shutdown(); }
    await prepared.cleanupOnFailure();
  });
  it('hydrates a sealed handoff preflight for an ephemeral requester read without retaining transfer custody', async () => {
    const host = await home({ creationMachineId: 'source-machine' });
    const hydrate = sessionLifecycleRpc.withSessionHandoffRequesterBootstrap;
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const request = { kind: 'requester_session_handoff_preflight_bootstrap_v1' as const,
      input: { sessionId: 'session', sourceMachineId: 'source-machine', targetMachineId: 'machine',
        targetPath: '/destination', sourceSessionStorageMode: 'persisted' as const },
      requesterBootstrap: { v: 1 as const, disposition: 'ordinary_requester' as const,
        credentials: encodeStoredCredentials(credentials) } };
    const sealed = sealSessionRequesterHandoffPreflightBootstrapRpcRequestV1({ request,
      installationId: 'installation', installationPublicKey: host.keyPair.publicKey,
      randomBytes: length => new Uint8Array(length).fill(7) });
    const boundary = { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory!,
      getObservedServerIdentityId: () => 'srv_requester_home',
      readInstallation: async () => ({ machineId: 'machine', identity: { installationId: 'installation',
        version: 1 as const, createdAt: 1, publicKey: Buffer.from(host.keyPair.publicKey).toString('base64url'),
        privateKey: Buffer.from(host.keyPair.secretKey).toString('base64url') } }) };
    let bootstrap: requesterCredentialOwner.AdmittedRequesterSessionBootstrap | undefined;
    const context = { signal: new AbortController().signal, callerAuthority: 'present_user' as const,
      machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
        installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const },
      verifyMachineAdmissionCurrent: current };
    const result = await hydrate({ method: RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3,
      input: sealed, context, boundary, handler: async (_input, admitted) => {
        bootstrap = admitted?.requesterSessionBootstrap;
        return { ok: true, sessionId: bootstrap?.getBoundSessionId(), current: await bootstrap?.isCurrent() };
      } });
    expect(result).toEqual({ ok: true, sessionId: 'session', current: true });
    expect(host.requests.every(request => request.path.endsWith('/admission/verify') || request.bearer === `Bearer ${credentials.token}`)).toBe(true);
    expect(host.requests.some(request => request.path.includes('/access-keys/'))).toBe(false);
    expect(await listRequesterSessionCredentialBindings({ happyHomeDir: directory!, ...attribution })).toEqual({ status: 'ready', bindings: [] });
    expect(await bootstrap?.isCurrent()).toBe(false);
    expect(await hydrate({ method: RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3,
      input: { ...sealed, input: { ...sealed.input, sessionId: 'another-session' } }, context, boundary,
      handler: async () => ({ ok: true }) })).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    const cancelled = new AbortController();
    const cancellation = new Error('Caller cancelled native preflight');
    await expect(hydrate({ method: RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3,
      input: sealed, context: { ...context, signal: cancelled.signal }, boundary,
      handler: async (_input, admitted) => {
        bootstrap = admitted?.requesterSessionBootstrap;
        cancelled.abort(cancellation);
        cancelled.signal.throwIfAborted();
        return { ok: true };
      } })).rejects.toBe(cancellation);
    expect(await bootstrap?.isCurrent()).toBe(false);
  });
  it('signs the exact requester Session currentness purpose without pretending to spawn a Session', async () => {
    const host = await home();
    expect(await verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary })).toBe(true);
  });
  it('admits the handoff private carrier before the existing target workflow without borrowing destination Account credentials', async () => {
    const host = await home({ creationMachineId: 'source-machine' });
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => undefined,
      authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'machine',
        resolveCustodianAccountId: async () => 'alice', resolveInstallationId: () => 'installation',
        verifyMachineAdmission: current }) });
    const registration = { rpcHandlerManager: rpc, runtimeConfig: { activeServerDir: directory! },
      requesterBootstrapBoundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory!,
        getObservedServerIdentityId: () => 'srv_requester_home' } };
    registerMachineSessionHandoffRpcHandlers(registration);
    const before = host.requests.length;
    const result = await rpc.handleRequest({ method: `machine:${RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3}`,
      callerAuthority: 'present_user', machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
        machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      params: { kind: 'requester_session_handoff_bootstrap_v1', input: { handoffId: 'handoff', operationId: 'prepare',
        sessionId: 'session', sourceMachineId: 'source-machine', targetMachineId: 'machine',
        negotiatedTransportStrategy: 'direct_peer', sourceSessionStorageMode: 'persisted', targetPath: '/destination',
        handoffMetadataV2: { agentBundleTransferPublication: { transferId: 'session-handoff:handoff:agent-bundle-file',
          sizeBytes: 0, manifestHash: `sha256:${'0'.repeat(64)}` } } },
      requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: encodeStoredCredentials({ ...credentials }) } } });
    // The existing workflow owns the transport refusal; admission must not replace it with ambient auth failure.
    expect(result).toMatchObject({ ok: false, errorCode: 'direct_peer_transfer_unavailable' });
    const reads = host.requests.slice(before).filter(request => request.path !== '/v1/machines/machine/admission/verify');
    expect(reads.some(request => request.path.startsWith('/v2/sessions/session'))).toBe(true);
    expect(reads.every(request => request.bearer === `Bearer ${credentials.token}`)).toBe(true);
  });
  it('uses admitted requester credentials at the source handoff coordinator instead of the daemon sign-in', async () => {
    const sessionId = `c${'b'.repeat(24)}`;
    const host = await home({ sessionId });
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId,
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: current, boundSessionId: sessionId, preparedSessionId: sessionId });
    if (!custody) throw new Error('Missing requester bootstrap');
    const daemonFile = join(directory!, 'daemon-access.key');
    await writePrivateOwnerFile({ path: daemonFile,
      contents: JSON.stringify(encodeStoredCredentials({ token: 'alice-daemon', encryption: null })) });
    const controller = new WorkspaceSyncController({
      adapter: createWorkspaceSyncMutagenAdapter({ resolveWorkspaceRef: () => null,
        // Genuine engine transport; this handoff does not request workspace synchronization.
        send: async () => { throw new Error('Unexpected Mutagen request'); } }),
      lifecycle: { start: async () => { throw new Error('Unexpected sidecar spawn'); }, stop: async () => undefined },
      localServerId: attribution.serverId, localMachineId: 'machine', resolveWorkspaceRef: () => null,
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(directory!, 'workspace-locks') }),
    });
    const coordinate = createTrackedSessionHandoffCoordinator({ expectedAccountServerId: attribution.serverId,
      readCredentials: async () => decodeStoredCredentials(JSON.parse(await readFile(daemonFile, 'utf8'))),
      workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({ sync: controller,
        bootstrap: async () => { throw new Error('Unexpected workspace materialization'); } }),
      // Genuine target RPC boundary: source admission is observed before any target attempt.
      callMachine: async () => { throw new Error('Unexpected target RPC'); },
    });
    const before = host.requests.length;
    const input = { operationId: 'handoff-operation', actionInput: { sessionId, targetMachineId: 'destination', targetPath: '/target' },
      context: { surface: 'rpc' as const, requesterSessionBootstrap: custody.admitted }, signal: new AbortController().signal,
      start: async () => ({ ok: false as const, errorCode: 'source_export_refused', error: 'source_export_refused' }),
      publishOwnerUpdate: () => undefined };
    const result = await runWithServerHttpBaseUrl(origin, () => coordinate(input));
    expect(result).toMatchObject({ ok: false, errorCode: 'source_export_refused' });
    const reads = host.requests.slice(before).filter(request => request.path !== '/v1/machines/machine/admission/verify');
    expect(reads.some(request => request.path.startsWith(`/v2/sessions/${sessionId}`)), JSON.stringify(reads.map(request => request.path))).toBe(true);
    expect(reads.every(request => request.bearer === `Bearer ${credentials.token}`)).toBe(true);
  });
  it('adopts the exact existing requester Session on the destination without rewriting its source creation recipe', async () => {
    const host = await home({ creationMachineId: 'source-machine' });
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: current, boundSessionId: 'session', preparedSessionId: 'session' });
    if (!custody) throw new Error('Missing requester bootstrap');
    // New creation still requires a recipe bound to this Machine, unlike existing-Session handoff adoption.
    expect(await custody.admitted.bindSession('session', host.correspondence.sessionCreationTag)).toBeNull();
    const bindExisting = Reflect.get(custody.admitted, 'bindExistingSession');
    expect(typeof bindExisting).toBe('function');
    if (typeof bindExisting !== 'function') throw new Error('Missing existing Session custody adoption');
    expect(await bindExisting('different-session')).toBeNull();
    const bound = await bindExisting('session');
    expect(bound).not.toBeNull();
    if (!bound) throw new Error('Missing bound requester custody');
    expect(JSON.parse(await readFile(bound.path, 'utf8'))).toMatchObject({ sessionId: 'session', attribution,
      credentials: { token: credentials.token } });
    expect(custody.admitted.getBoundSessionId()).toBe('session');
    expect(await custody.admitted.isCurrent()).toBe(true);
    expect(host.correspondence.recipe.execution.machineId).toBe('source-machine');
    host.setAccess(false);
    expect(await bindExisting('session')).toBeNull();
  });
  it.each(['disposed', 'different-parent', 'admitted'] as const)('keeps %s stop on the exact admitted requester Session before the process boundary', async state => {
    const host = await home();
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: current, boundSessionId: 'session', preparedSessionId: 'session' });
    if (!custody) throw new Error('Missing requester bootstrap');
    const stopped: string[] = [];
    // This callback is the genuine process-stop boundary; all custody/admission remains real.
    const executor = createMachineSessionStopLifecycleActionExecutor({ stopSession: async sessionId => {
      stopped.push(sessionId); return { status: 'requested' }; } });
    if (state === 'disposed') await custody.admitted.dispose();
    const result = await executor.execute('session.stop', { sessionId: state === 'different-parent' ? 'different-session' : 'session' }, {
      surface: 'rpc', signal: new AbortController().signal, requesterSessionBootstrap: custody.admitted,
      machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: current });
    if (state === 'admitted') {
      expect(result).toMatchObject({ ok: true, result: { status: 'requested' } }); expect(stopped).toEqual(['session']);
    } else { expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' }); expect(stopped).toEqual([]); }
  });
  it.each(['disposed', 'different-parent', 'admitted'] as const)('keeps %s handoff metadata reads in the exact requester custody', async state => {
    const host = await home();
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: current, boundSessionId: 'session', preparedSessionId: 'session' });
    if (!custody) throw new Error('Missing requester bootstrap');
    if (state === 'disposed') await custody.admitted.dispose();
    const before = host.requests.filter(request => request.path.startsWith('/v2/sessions/')).length;
    const metadata = await runWithServerHttpBaseUrl(origin, () => loadSessionHandoffRemoteMetadata(
      state === 'different-parent' ? 'different-session' : 'session', {
        signal: new AbortController().signal, requesterSessionBootstrap: custody.admitted,
        machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
          installationId: 'installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: current,
      }));
    const reads = host.requests.filter(request => request.path.startsWith('/v2/sessions/')).slice(before);
    if (state === 'admitted') {
      expect(metadata).toMatchObject({ path: '/workspace', codexSessionId: 'same-native-session' });
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every(request => request.bearer === `Bearer ${credentials.token}`)).toBe(true);
    } else { expect(metadata).toBeNull(); expect(reads).toEqual([]); }
  });
  it.each(['disposed', 'different-parent'] as const)('refuses %s continue before requester or custodian Account effects', async state => {
    const host = await home();
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: current, boundSessionId: 'session', preparedSessionId: 'session' });
    if (!custody) throw new Error('Missing requester bootstrap');
    const input = SessionContinueWithReplayRpcParamsSchema.parse({ directory: '/workspace',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      replay: { previousSessionId: state === 'different-parent' ? 'different-session' : 'session' } });
    runtimeFixture ??= await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
    const bridge = getSessionHostBridge();
    expect(bridge.resolveContinueWithReplayBackendTarget({ backendTarget: input.backendTarget })).toMatchObject({ ok: true });
    const handler = createContinueWithReplayLifecycleActionHandler({ sessionHostBridge: bridge,
      spawnSession: async () => { throw new Error('Unexpected physical launch'); } });
    const executor = createSessionLifecycleRpcActionExecutor({ 'session.continue_with_replay': handler });
    if (state === 'disposed') await custody.admitted.dispose();
    const before = host.requests.filter(request => request.path.startsWith('/v2/sessions/')).length;
    const result = await executor.execute('session.continue_with_replay', input, { surface: 'rpc',
      signal: new AbortController().signal, requesterSessionBootstrap: custody.admitted,
      machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: current });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE } });
    expect(host.requests.filter(request => request.path.startsWith('/v2/sessions/'))).toHaveLength(before);
  });
  it.each(['disposed', 'different-parent', 'admitted'] as const)('keeps %s fork preflight bound to the original requester Session through the lifecycle Action adapter', async (state) => {
    const host = await home();
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: current, boundSessionId: 'session', preparedSessionId: 'session' });
    if (!custody) throw new Error('Missing requester bootstrap');
    const effects: string[] = [];
    const fork = createForkSessionLifecycleActionHandler({ sessionHostBridge: getSessionHostBridge(), handlers: {
      spawnSession: async () => { effects.push('spawn'); return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Unexpected spawn' }; },
      stopSession: async () => { effects.push('stop'); return false; },
    } });
    const executor = createSessionLifecycleRpcActionExecutor({ 'session.fork': fork });
    const context = { surface: 'rpc' as const, signal: new AbortController().signal,
      requesterSessionBootstrap: custody.admitted, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
        machineId: 'machine', installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const },
      verifyMachineAdmissionCurrent: current };
    if (state === 'disposed') await custody.admitted.dispose();
    const before = host.requests.filter(request => request.path === '/v2/sessions/session').length;
    const input = SessionForkRpcParamsSchema.parse({ v: 1,
      parentSessionId: state === 'different-parent' ? 'different-session' : 'session',
      forkPoint: { type: 'latest' }, strategy: 'replay' });
    if (state === 'admitted') runtimeFixture ??= await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
    const result = await executor.execute('session.fork', input, context);
    expect(effects).toEqual([]);
    if (state === 'admitted') {
      // This fixture deliberately has no executable backend. It establishes
      // the real Account preflight, not native fork or physical launch evidence.
      const reads = host.requests.filter(request => request.path === '/v2/sessions/session').slice(before);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every(request => request.bearer === `Bearer ${credentials.token}`)).toBe(true);
    } else {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE } });
      expect(host.requests.filter(request => request.path === '/v2/sessions/session')).toHaveLength(before);
    }
    await custody.cleanupOnFailure();
  });

  it('projects full-sign-in and host visibility before requester approval without retaining credential material', async () => {
    const host = await home();
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
        serverHttpBaseUrl: origin, boundary: host.boundary }) });
    if (!custody) throw new Error('Missing requester bootstrap');
    const input = { executionTarget: { serverId: attribution.serverId, machineId: attribution.machineId },
      directory: { kind: 'path', path: '/workspace' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
      requesterSessionBootstrap: custody.admitted });
    const preview = await deps.buildApprovalPreview?.({ actionId: 'session.spawn_new', input,
      context: { surface: 'mcp' }, defaultPreview: { actionId: 'session.spawn_new', actionArgs: input, summary: 'Start Session' } });
    expect(preview).toMatchObject({ requesterCredentialDisclosure: {
      disposition: 'ordinary_requester', accountId: attribution.accountId, machineId: attribution.machineId,
      fullSignIn: true, selectedPurposeRuntimeAuth: true, hostCanInspectLocalProcess: true,
    } });
    expect(JSON.stringify(preview)).not.toContain(credentials.token);
    expect(JSON.stringify(preview)).not.toContain('requesterSessionBootstrap');
    await custody.cleanupOnFailure();
  });

  it('uses exact admitted Session credentials for serviceability and performs no read after custody disposal', async () => {
    const host = await home();
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      boundSessionId: 'session', preparedSessionId: 'session', verifyMachineAdmissionCurrent: current });
    if (!custody) throw new Error('Missing requester bootstrap');
    const options = { sessionId: 'session', credentials: { token: 'alice-daemon', encryption: null },
      requesterSessionBootstrap: custody.admitted };
    // HTTP is the genuine boundary. An unavailable socket is not evidence of
    // serviceability, but the reader must never use Alice's Account authority.
    await runWithServerHttpBaseUrl(origin, () => probeAlreadyRunningExistingSessionServiceability(options));
    const reads = host.requests.filter(request => request.path === '/v2/sessions/session');
    expect(reads).not.toHaveLength(0);
    expect(reads.every(request => request.bearer === `Bearer ${credentials.token}`)).toBe(true);
    await custody.admitted.dispose();
    const before = reads.length;
    await runWithServerHttpBaseUrl(origin, () => probeAlreadyRunningExistingSessionServiceability(options));
    expect(host.requests.filter(request => request.path === '/v2/sessions/session')).toHaveLength(before);
    await custody.cleanupOnFailure();
  });

  it.each(['rpc', 'trusted-child'] as const)('launches the admitted lifecycle with actual %s requester custody and refuses it after custody disposal', async (originKind) => {
    const host = await home();
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const custody = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: current });
    expect(custody).not.toBeNull();
    if (!custody) throw new Error('Missing requester bootstrap');
    const launched: SpawnSessionOptions[] = [];
    const handler = createSpawnNewSessionLifecycleActionHandler({ serverId: attribution.serverId,
      // Physical process launch is the boundary, not Session admission or custody.
      spawnSession: async options => { launched.push(options); return { type: 'success', sessionId: 'bob-child' }; } });
    const input = { directory: '/workspace', machineId: attribution.machineId,
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      sessionCreationTag: host.correspondence.sessionCreationTag, sessionCreationCorrespondence: host.correspondence };
    const context = { requesterSessionBootstrap: custody.admitted,
      ...(originKind === 'rpc' ? { machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
        installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const } } : {}),
      verifyMachineAdmissionCurrent: current };
    expect(await handler(input, context)).toMatchObject({ type: 'success', sessionId: 'bob-child' });
    expect(launched).toHaveLength(1);
    expect(launched[0]?.requesterSessionBootstrap).toBe(custody.admitted);
    expect(launched[0]?.requesterWorkAttributionV1).toEqual(attribution);
    host.setAccess(false);
    // This handler consumes an admitted invocation. A new request must pass
    // admission independently; Machine withdrawal does not dispose this one.
    expect(await handler(input, context)).toMatchObject({ type: 'success', sessionId: 'bob-child' });
    expect(launched).toHaveLength(2);
    await custody.admitted.dispose();
    expect(await handler(input, context)).toMatchObject({ type: 'error' });
    expect(launched).toHaveLength(2);
    await custody.cleanupOnFailure();
  });

  it('starts a Manage grantee Workflow agent Session with the Run admission role and no second Machine read', async () => {
    const host = await home({ custodianAccountId: 'alice' });
    host.setMachineRole('manage');
    const boundary = { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory!,
      getObservedServerIdentityId: () => 'srv_workflow_home' };
    const transport = createWorkflowRunMachineTransport({ runId: 'manage-agent-run', credentials,
      requesterWorkAttributionV1: attribution, machineAdmissionBoundary: host.boundary, boundary,
      isCurrent: async () => true,
      transport: { machineId: attribution.machineId, invoke: async () => { throw new Error('Unexpected Machine transport'); } } });
    let prepared: Awaited<ReturnType<typeof prepareWorkflowSessionRequester>> = null;
    try {
      const savedSecretOperationContext = await transport.resolveSavedSecretOperationContext();
      if (!savedSecretOperationContext) throw new Error('Missing admitted Workflow Run');
      const reads = host.readReturnedRows().machine;
      const startup = { credentials, attribution, boundary, savedSecretOperationContext,
        machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice' },
        verifyMachineAdmissionCurrent: async () => true };
      prepared = await prepareWorkflowSessionRequester(startup);
      if (!prepared) throw new Error('Missing Workflow requester bootstrap');
      const launched: SpawnSessionOptions[] = [];
      const handler = createMachineSessionSpawnRpcHandler({ serverId: attribution.serverId,
        handlers: { spawnSession: async options => { launched.push(options); return { type: 'success', sessionId: 'manage-agent-child' }; } } });
      expect(await handler({ directory: '/workspace', machineId: attribution.machineId,
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        sessionCreationTag: host.correspondence.sessionCreationTag, sessionCreationCorrespondence: host.correspondence },
      { requesterSessionBootstrap: prepared.admitted })).toMatchObject({ type: 'success', sessionId: 'manage-agent-child' });
      expect(launched).toHaveLength(1);
      expect(launched[0]?.requesterSessionBootstrap?.savedSecretOperationContext.machineAdmission)
        .toMatchObject({ actorAccountId: 'bob', custodianAccountId: 'alice', role: 'manage' });
      expect(host.readReturnedRows().machine).toBe(reads);
    } finally { await prepared?.cleanupOnFailure(); await transport.dispose(); }
  });

  it.each([false, true])('keeps admitted Workflow startup custody after observation ends but refuses released custody (released=%s)', async released => {
    const host = await home();
    const observation = new AbortController();
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const prepared = await prepareWorkflowSessionRequester({ credentials, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory!,
        getObservedServerIdentityId: () => 'srv_workflow_home' },
      verifyMachineAdmissionCurrent: current, signal: observation.signal });
    if (!prepared) throw new Error('Missing Workflow requester bootstrap');
    prepared.admitted.bindRuntimeMachineAdmissionCurrentness(current);
    try {
      observation.abort();
      if (released) await prepared.cleanupOnFailure();
      const custody = await prepared.admitted.bindSession('session', host.correspondence.sessionCreationTag);
      if (released) expect(custody).toBeNull();
      else {
        expect(custody).not.toBeNull();
        expect(await prepared.admitted.isCurrent()).toBe(true);
        host.setAccess(false);
        expect(await prepared.admitted.isCurrent()).toBe(true);
        expect(await prepareWorkflowSessionRequester({ credentials, attribution,
          boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory!,
            getObservedServerIdentityId: () => 'srv_workflow_home' },
          verifyMachineAdmissionCurrent: current })).toBeNull();
      }
    } finally { await prepared.cleanupOnFailure(); }
  });

  it.each(['bob', 'alice'] as const)('binds native Account credential use to verified Workflow requester/custodian identity (%s)', async custodianAccountId => {
    const host = await home({ custodianAccountId });
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const prepared = await prepareWorkflowSessionRequester({ credentials, attribution,
      machineAdmission: { actorAccountId: 'bob', custodianAccountId },
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory!,
        getObservedServerIdentityId: () => 'srv_workflow_home' },
      verifyMachineAdmissionCurrent: current });
    if (!prepared) throw new Error('Missing Workflow requester bootstrap');
    try {
      expect(prepared.admitted.allowNativeAccountCredentials).toBe(custodianAccountId === 'bob');
      prepared.admitted.bindRuntimeMachineAdmissionCurrentness(current);
      expect(await prepared.admitted.bindSession('session', host.correspondence.sessionCreationTag)).not.toBeNull();
      const recovered = await resolveRequesterSessionBootstrap({ happyHomeDir: directory!, sessionId: 'session', attribution,
        serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary });
      expect(recovered?.allowNativeAccountCredentials).toBe(custodianAccountId === 'bob');
      await recovered?.dispose();
      host.setAccess(false);
      expect(await prepared.admitted.isCurrent()).toBe(true);
      expect(await resolveRequesterSessionBootstrap({ happyHomeDir: directory!, sessionId: 'session', attribution,
        serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary })).toBeNull();
    } finally { await prepared.cleanupOnFailure(); }
  });

  it.each(['ui', 'cli', 'agent', 'misbound', 'foreign'] as const)('carries %s Workflow requester custody through spawn isolation into an external Agent child', async caller => {
    const custodianAccountId = caller === 'foreign' ? 'alice' : 'bob';
    const refusesNative = caller === 'misbound' || caller === 'foreign';
    const host = await home({ custodianAccountId });
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    // The omitted admission is the wiring negative: the same bearer and
    // attribution cannot independently authorize using the Machine's native login.
    const prepared = await prepareWorkflowSessionRequester({ credentials, attribution,
      ...(caller !== 'misbound' ? { machineAdmission: { actorAccountId: 'bob', custodianAccountId } } : {}),
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory!,
        getObservedServerIdentityId: () => 'srv_workflow_home' },
      verifyMachineAdmissionCurrent: current });
    if (!prepared) throw new Error('Missing Workflow requester bootstrap');
    prepared.admitted.bindRuntimeMachineAdmissionCurrentness(current);
    const pluginId = `acme.fix96-${caller}`;
    const plugin = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: directory!, controller: pluginReloadController,
      plugins: [{ manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { agents: [{ id: 'agent',
        title: 'External native Agent', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }] } }),
        files: { 'daemon.mjs': `import { factory } from './agent.mjs';
          export function activate(api) { api.agents.register('agent', factory, {
            sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 }
          }); }`,
          'agent.mjs': `export function factory() { return { sessions: {
            async open() { throw new Error('The OS child boundary owns this launch proof'); }
          } }; }` } }] });
    const resources = createProviderLaunchResourceScope();
    const redaction = createProviderRedactionLease({ values: [] });
    let nativeChildren = 0;
    const handler = createMachineSessionSpawnRpcHandler({ serverId: attribution.serverId, handlers: {
      spawnSession: async options => {
        expect(options.requesterSessionBootstrap).toBe(prepared.admitted);
        const identity = await resolveSpawnBackendIdentity({ agentTarget: options.agentTarget, backendTarget: options.backendTarget,
          existingSessionId: '', resume: '', credentials });
        if (!identity.ok) throw new Error(`External Agent fixture identity refused: ${identity.error.type}`);
        const launchOptions = { ...options, backendTarget: identity.effectiveBackendTargetV2 };
        const custody = await options.requesterSessionBootstrap!.bindSession('session', host.correspondence.sessionCreationTag);
        expect(custody).not.toBeNull();
        const services = await prepareDaemonConnectedServices({ options: launchOptions, normalizedExistingSessionId: '', requestedSessionId: 'session',
          effectiveResume: '', catalogAgentId: identity.catalogAgentId, credentials,
          activeServerDir: join(directory!, 'servers', attribution.serverId),
          api: await ApiClient.create(credentials), connectedServiceRefreshCoordinator: null, processEnv: {},
          connectedServicesMaterializationBaseDir: join(directory!, 'materialized'), pluginRuntimeRegistry: plugin.registry,
          isAccountRuntimeCurrent: prepared.admitted.isCurrent });
        if (!services.ok) return services.result;
        const child = await prepareDaemonSpawnChildEnvironment({ options: { ...launchOptions, existingSessionId: 'session',
          requesterSessionCredentialFile: custody!.path }, resolvedAgentId: `${pluginId}/agent`,
          effectiveModelSelection: undefined, terminal: undefined, profileEnvironmentVariables: {}, daemonSpawnHooks: null,
          pluginRuntimeRegistry: plugin.registry, processEnv: {}, connectedServiceAuth: services.auth,
          connectedServiceMaterializationIdentity: services.materializationIdentity,
          providerBindingAttempt: null, providerAgentTargetKey: null, providerDiagnosticRedactionLease: redaction,
          launchResourceScope: resources });
        if (!child.ok) return child.result;
        const receipt = join(directory!, 'native-child-receipt.json');
        await promisify(execFile)(process.execPath, ['-e', `const fs = require('node:fs');
          const custody = JSON.parse(fs.readFileSync(process.env.HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE, 'utf8'));
          fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ sessionId: process.env.HAPPIER_SESSION_REQUESTER_SESSION_ID,
            accountId: custody.attribution.accountId }));`], {
          env: buildScopedProcessEnv({ baseEnv: {}, explicitEnv: child.extraEnvForChild, unsetEnvKeys: child.spawnEnvironment.unsetEnvKeys }),
        });
        nativeChildren++;
        expect(JSON.parse(await readFile(receipt, 'utf8'))).toEqual({ sessionId: 'session', accountId: 'bob' });
        return { type: 'success', sessionId: 'session' };
      },
    } });
    vi.stubEnv('HAPPIER_HOME_DIR', directory!);
    reloadConfiguration();
    try {
      const result = await handler({ directory: directory!, agentTarget: { kind: 'agent', identity: { pluginId, localId: 'agent' } } }, {
        signal: new AbortController().signal, requesterSessionBootstrap: prepared.admitted,
        localActionContext: { surface: refusesNative ? 'cli' : caller === 'agent' ? 'agent' : caller === 'ui' ? 'ui' : 'cli',
          authority: caller === 'agent' ? 'account_automation' : 'present_user' },
      });
      expect(result, JSON.stringify(result)).toMatchObject(refusesNative
        ? { type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED', errorMessage: 'Requester Agent credential isolation unavailable' }
        : { type: 'success', sessionId: 'session' });
      expect(nativeChildren).toBe(refusesNative ? 0 : 1);
    } finally {
      try {
        await resources.release(); redaction.close();
        await plugin.dispose(); await prepared.cleanupOnFailure();
      } finally { vi.unstubAllEnvs(); reloadConfiguration(); }
    }
  });

  it.each(['use', 'manage'] as const)('retains shared Machine %s admission when acquiring a native Saved Secret', async role => {
    const host = await home({ custodianAccountId: 'alice', ...(role === 'manage' ? { machineGrantCount: 1 } : {}) });
    const prepared = await admitRequesterSessionBootstrap({
      bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: encodeStoredCredentials(credentials) },
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      context: { signal: new AbortController().signal,
        machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine', installationId: 'installation', role, encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution,
          sessionId: 'session', serverHttpBaseUrl: origin, boundary: host.boundary }) },
    });
    if (!prepared) throw new Error('Missing admitted requester custody');
    onTestFinished(prepared.cleanupOnFailure);
    let nativeVaultReads = 0;
    const homeGet = axios.get.bind(axios);
    const transport = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      if (url === 'https://vault.test/session-field') {
        nativeVaultReads++;
        return { status: 200, data: { value: 'private-session-vault-value' } };
      }
      return await homeGet(url, config);
    });
    onTestFinished(() => transport.mockRestore());
    const plugin = definePlugin({ id: 'acme.session-vault', version: '1.0.0', displayName: 'Session vault',
      entrypoints: { daemon: './daemon.mjs' }, secretSources: { field: {
        declaration: { title: 'Session credential' }, runtime: { async acquire() {
          const response = await axios.get<{ value: string }>('https://vault.test/session-field');
          return { ok: true, value: response.data.value };
        } },
      } } });
    const source = await createAuthoredAdmittedPluginRuntimeFixture({
      plugins: [{ manifest: plugin.manifest, files: { 'daemon.mjs': 'export function activate() {}' },
        instantiateCommittedModule: () => ({ activate: plugin.activate }) }], coldStart: true,
      async resolveContributes(happyHomeDir) {
        return createResolvedContributionRegistry(projectLoadedPluginContributes({
          loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' }));
      },
    });
    onTestFinished(() => source.dispose());
    const context = prepared.admitted.savedSecretOperationContext;
    const resourceId = 'session-vault-field';
    expect(context.commitCatalog({ state: 'ready', resources: [{ resourceId,
      ownerAccountId: 'bob', relationship: 'owner', displayName: 'Session field', kind: 'token', encryptionMode: 'plain',
      revision: 1, materialStatus: 'ready', storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
        content: { v: 2, name: 'Session field', kind: 'token', source: { kind: 'external',
          contribution: { pluginId: 'acme.session-vault', localId: 'field' }, account: 'bob', reference: 'selected-field' } } }) }] })).toBe(true);
    const snapshot = context.readSnapshot();
    if (!snapshot) throw new Error('Missing admitted Saved Secret catalog');
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const acquisition = acquireSavedSecretMaterializerForOperation({ snapshot, references: [{ ref }],
      operationContext: context, secretSources: source.registry.secretSources });
    if (role === 'use') await expect(acquisition).rejects.toMatchObject({ reason: 'reference_forbidden' });
    else expect((await acquisition).resolve(ref)).toMatchObject({ status: 'ready', value: 'private-session-vault-value' });
    expect(nativeVaultReads).toBe(role === 'manage' ? 1 : 0);
    expect(JSON.stringify(snapshot)).not.toContain('private-session-vault-value');
  });

  it('retires only an unadopted bootstrap Saved Secret catalog on launch failure', async () => {
    const host = await home();
    const active = getActiveAccountSettingsSnapshot();
    const result = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
        serverHttpBaseUrl: origin, boundary: host.boundary }) });
    expect(result).not.toBeNull();
    if (!result) throw new Error('Missing requester bootstrap');
    const context = result.admitted.savedSecretOperationContext;
    expect(context.commitCatalog({ state: 'ready', resources: [{ resourceId: 'unadopted-secret',
      ownerAccountId: 'bob', displayName: 'Bob token', kind: 'token', encryptionMode: 'plain',
      revision: 1, materialStatus: 'ready', storedContent: sealSavedSecretResourceStoredContentV1({
        resourceId: 'unadopted-secret', mode: 'plain',
        content: { v: 1, name: 'Bob token', kind: 'token', value: 'bob-private-material' },
      }) }] })).toBe(true);
    const captured = context.readSnapshot();
    if (!captured) throw new Error('Missing admitted catalog');
    const materializer = createSavedSecretMaterializerFromSnapshotV1(captured, { isCurrent: () => context.readSnapshot() === captured });
    const reference = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: 'unadopted-secret' });
    expect(materializer.resolve(reference)).toMatchObject({ status: 'ready', value: 'bob-private-material' });

    await result.cleanupOnFailure();

    expect(context.readSnapshot()).toBeNull();
    expect(materializer.resolve(reference)).toEqual({ status: 'temporarily_unavailable' });
    expect(await context.isCurrent()).toBe(false);
    expect(context.commitCatalog({ state: 'ready', resources: [] })).toBe(false);
    expect(getActiveAccountSettingsSnapshot()).toBe(active);
  });

  it('retires a bound but unadopted launch catalog and protected custody on launch failure', async () => {
    const host = await home();
    const active = getActiveAccountSettingsSnapshot();
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    const result = await prepareRequesterSessionBootstrap({ credentials: { ...credentials }, attribution,
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory! },
      verifyMachineAdmissionCurrent: current });
    expect(result).not.toBeNull();
    if (!result) throw new Error('Missing requester bootstrap');
    result.admitted.bindRuntimeMachineAdmissionCurrentness(current);
    const bound = await result.admitted.bindSession('session', host.correspondence.sessionCreationTag);
    expect(bound).not.toBeNull();
    if (!bound) throw new Error('Missing bound requester custody');
    expect(await readFile(bound.path, 'utf8')).toContain(credentials.token);
    const context = result.admitted.savedSecretOperationContext;
    expect(context.commitCatalog({ state: 'ready', resources: [{ resourceId: 'failed-bound-secret',
      ownerAccountId: 'bob', displayName: 'Bob token', kind: 'token', encryptionMode: 'plain',
      revision: 1, materialStatus: 'ready', storedContent: sealSavedSecretResourceStoredContentV1({
        resourceId: 'failed-bound-secret', mode: 'plain',
        content: { v: 1, name: 'Bob token', kind: 'token', value: 'bob-private-material' },
      }) }] })).toBe(true);
    const captured = context.readSnapshot();
    if (!captured) throw new Error('Missing admitted catalog');
    const materializer = createSavedSecretMaterializerFromSnapshotV1(captured, { isCurrent: () => context.readSnapshot() === captured });
    const reference = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: 'failed-bound-secret' });
    expect(materializer.resolve(reference)).toMatchObject({ status: 'ready', value: 'bob-private-material' });

    await result.cleanupOnFailure();

    expect(context.readSnapshot()).toBeNull();
    expect(materializer.resolve(reference)).toEqual({ status: 'temporarily_unavailable' });
    expect(await context.isCurrent()).toBe(false);
    expect(context.commitCatalog({ state: 'ready', resources: [] })).toBe(false);
    await expect(readFile(bound.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(getActiveAccountSettingsSnapshot()).toBe(active);
    expect(result.admitted.getBoundSessionId()).toBe('session');
  });

  it('retains the birth Home separately from the saved profile through private child custody', async () => {
    await home();
    const birth = { ...attribution, serverId: configuration.activeServerId };
    const custody = await createRequesterSessionCredentialCustody({ happyHomeDir: directory!, sessionId: 'birth-home',
      attribution: birth, credentials, homeServerIdentityId: 'srv_distinct_birth_home' });
    const previous = process.env[REQUESTER_SESSION_ID_ENV];
    process.env[REQUESTER_SESSION_ID_ENV] = 'birth-home';
    try {
      const child = await readRequesterSessionCredentialsForChild(custody.path);
      expect(child?.requesterSessionCredentialScope).toMatchObject({ serverId: birth.serverId,
        requesterSession: { sessionId: 'birth-home', attribution: birth, homeServerIdentityId: 'srv_distinct_birth_home' } });
      expect(JSON.stringify(child)).not.toContain('homeServerIdentityId');
      let installationReads = 0;
      for (const currentHome of ['srv_retargeted_home', null]) {
        expect(await resolveRequesterSessionBootstrap({ happyHomeDir: directory!, sessionId: 'birth-home', attribution: birth,
          serverHttpBaseUrl: origin, machineAdmissionBoundary: { machineId: birth.machineId, daemonToken: 'daemon-boundary',
            isHomeCurrent: () => true, getObservedServerIdentityId: () => currentHome,
            // Installation storage is an OS boundary; withdrawal must precede opening it.
            readInstallation() { installationReads++; throw new Error('Unexpected installation read'); } } })).toBeNull();
      }
      expect(installationReads).toBe(0);
    } finally {
      if (previous === undefined) delete process.env[REQUESTER_SESSION_ID_ENV];
      else process.env[REQUESTER_SESSION_ID_ENV] = previous;
    }
  });

  it('reads additive custody fields without dropping exact bounds or private decryption material, but rejects malformed required fields', async () => {
    const host = await home();
    const childAttribution = { ...attribution, serverId: configuration.activeServerId };
    const binding = { happyHomeDir: directory!, sessionId: 'session', attribution: childAttribution };
    const custody = await createRequesterSessionCredentialCustody({ ...binding, credentials });
    const stored = { v: 1, sessionId: 'session', futureOuter: 'ignored',
      attribution: { ...childAttribution, futureAttribution: 'ignored' },
      credentials: { ...encodeStoredCredentials(credentials), futureCredential: 'ignored' } };
    await replacePrivateBearerFile({ path: custody.path, contents: JSON.stringify(stored) });
    const current = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution: childAttribution, sessionId: 'session',
      serverHttpBaseUrl: origin, boundary: host.boundary });
    expect(await resolveRequesterSessionCredentials({ ...binding, serverHttpBaseUrl: origin,
      verifyMachineAdmissionCurrent: current })).toMatchObject({ ...credentials, credentialProvenance: 'stored_session' });
    const e2ee: Credentials = { token: credentials.token, encryption: { type: 'dataKey',
      publicKey: new Uint8Array(32).fill(8), machineKey: new Uint8Array(32).fill(7) } };
    const encoded = encodeStoredCredentials(e2ee);
    const encrypted = encryptSecretStringV1('bob-private-secret', deriveSettingsSecretsKeyForCredentials(e2ee),
      length => new Uint8Array(length).fill(1));
    const e2eeStored = { ...stored, credentials: { ...encoded, futureCredential: 'ignored',
      encryption: { ...encoded.encryption, futureEncryption: 'ignored' } } };
    await replacePrivateBearerFile({ path: custody.path, contents: JSON.stringify(e2eeStored) });
    const previousSessionId = process.env[REQUESTER_SESSION_ID_ENV];
    process.env[REQUESTER_SESSION_ID_ENV] = 'session';
    const release = publishServerHttpRuntimeOrigin('http://127.0.0.1:48186', 'iroh');
    try {
      const child = await readRequesterSessionCredentialsForChild(custody.path);
      expect(child).toMatchObject({ ...e2ee, credentialProvenance: 'stored_session' });
      if (!child) throw new Error('Missing protected child credentials');
      expect(child.encryption).toEqual(e2ee.encryption);
      expect(child.requesterSessionCredentialScope).toEqual({ serverId: childAttribution.serverId,
        serverHttpBaseUrl: 'http://127.0.0.1:48186',
        requesterSession: { sessionId: binding.sessionId, attribution: childAttribution } });
      expect(JSON.stringify(child)).not.toContain('requesterSessionCredentialScope');
      expect(decryptSecretStringWithKeysV1(encrypted, deriveSettingsSecretsReadKeysForCredentials(child))).toBe('bob-private-secret');
      await replacePrivateBearerFile({ path: custody.path, contents: JSON.stringify({ ...e2eeStored,
        credentials: { ...e2eeStored.credentials, token: 7 } }) });
      expect(await readRequesterSessionCredentialsForChild(custody.path)).toBeNull();
      expect(await resolveRequesterSessionCredentials({ ...binding, serverHttpBaseUrl: origin,
        verifyMachineAdmissionCurrent: current })).toBeNull();
      await replacePrivateBearerFile({ path: custody.path, contents: JSON.stringify({ ...stored,
        attribution: { ...stored.attribution, installationId: 7 } }) });
      expect(await readRequesterSessionCredentialsForChild(custody.path)).toBeNull();
      expect(await resolveRequesterSessionCredentials({ ...binding, serverHttpBaseUrl: origin,
        verifyMachineAdmissionCurrent: current })).toBeNull();
    } finally {
      release();
      if (previousSessionId === undefined) delete process.env[REQUESTER_SESSION_ID_ENV];
      else process.env[REQUESTER_SESSION_ID_ENV] = previousSessionId;
    }
  });

  it.each(['missing', 'malformed', 'wrong-session', 'wrong-home'] as const)('recovers Pending requester birth only from absent exact custody (%s)', async state => {
    const host = await home();
    const sealed = sealSessionRequesterBootstrapRpcRequestV1({ installationId: attribution.installationId,
      installationPublicKey: host.keyPair.publicKey, randomBytes: tweetnacl.randomBytes,
      request: { kind: 'requester_session_bootstrap_v1', input: { executionTarget: { serverId: attribution.serverId,
        machineId: attribution.machineId }, directory: { kind: 'path', path: '/tmp/project' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
        requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: encodeStoredCredentials(credentials),
          sessionId: state === 'wrong-session' ? 'another-session' : 'session', sessionCreationDisposition: 'created' } } });
    const path = requesterSessionCredentialPath({ happyHomeDir: directory!, sessionId: 'session', attribution });
    if (state === 'malformed') await writePrivateOwnerFile({ path, contents: '{bad' });
    let consumed = 0;
    const recovered = await requesterCredentialOwner.resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: directory!,
      serverId: attribution.serverId, sessionId: 'session', serverHttpBaseUrl: origin,
      machineAdmissionBoundary: { ...host.boundary, getObservedServerIdentityId: () => 'srv_original_home' },
      expectedAttribution: attribution, pendingBootstrap: { descriptor: { target: { homeId: state === 'wrong-home' ? 'srv_foreign_home' : 'srv_original_home',
        accountId: attribution.accountId, machineId: attribution.machineId, installationId: attribution.installationId,
        sessionId: 'session' }, requestId: 'pending-birth', requesterBootstrap: sealed.requesterBootstrap },
        consume: async () => {
          const retained = CustodySchema.safeParse(JSON.parse(await readFile(path, 'utf8')) as unknown);
          expect(retained.success).toBe(true);
          if (!retained.success) return;
          expect(retained.data.sessionId).toBe('session');
          expect(retained.data.attribution).toEqual(attribution);
          expect(retained.data.credentials.token === credentials.token).toBe(true);
          consumed++;
        } } });
    if (state === 'missing') {
      expect(recovered?.getBoundSessionId()).toBe('session');
      expect(recovered?.attribution).toEqual(attribution);
      expect(consumed).toBe(1);
    } else { expect(recovered === null).toBe(true); expect(consumed).toBe(0); }
    await recovered?.dispose();
  });

  it('recovers only the exact cold handoff Session from existing protected custody with current Home admission', async () => {
    const host = await home();
    await createRequesterSessionCredentialCustody({ happyHomeDir: directory!, sessionId: 'session', attribution, credentials,
      homeServerIdentityId: 'srv_original_home' });
    const recover = Reflect.get(requesterCredentialOwner, 'resolveRequesterSessionBootstrapFromCustody') as
      (input: unknown) => Promise<import('./requesterSessionCredentials').AdmittedRequesterSessionBootstrap | null>;
    expect(typeof recover).toBe('function');
    const input = { happyHomeDir: directory!, serverId: attribution.serverId, sessionId: 'session',
      serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary };
    const recovered = await recover(input);
    expect(recovered?.getBoundSessionId()).toBe('session');
    expect(recovered?.credentials.token).toBe(credentials.token);
    expect(await recover({ ...input, sessionId: 'another-session' })).toBeNull();
    host.setAccess(false);
    expect(await recover(input)).toBeNull();
    recovered?.savedSecretOperationContext.withdrawCatalog();
  });

  it.each([false, true])('recovers legacy Session ownership with retained Home and attribution=%s without writing requester custody', async stamped => {
    const host = await home();
    const recover = requesterCredentialOwner.resolveRequesterSessionBootstrapFromCustody;
    const retained = bindRequesterSessionCredentialScope({ ...credentials }, { serverId: attribution.serverId,
      serverHttpBaseUrl: origin, requesterSession: { sessionId: 'session', attribution, homeServerIdentityId: 'srv_original_home' } });
    const recovered = await recover({ happyHomeDir: directory!, serverId: attribution.serverId, sessionId: 'session',
      serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary, legacyOwnerCredentials: retained,
      ...(stamped ? { expectedAttribution: attribution } : {}) });
    expect(recovered?.getBoundSessionId()).toBe('session');
    expect(recovered?.homeServerIdentityId).toBe('srv_original_home');
    expect(recovered?.attribution).toEqual(attribution);
    expect(await recovered?.isCurrent()).toBe(true);
    const snapshot = { status: 'ok' as const, capturedAtMs: 1000, logicalCpus: 4, rows: [10, 20].map(pid => ({
      pid, ppid: pid === 10 ? 1 : 10, start: { startTimeMs: pid }, principal: { kind: 'uid' as const, value: '1000' },
      name: 'happier', memory: null, cpuTimeUs: null })) };
    const roots = listHappierProcessRoots({ snapshot, selfPid: 10, platform: 'darwin', daemonScopeKey: '123456789abc',
      trackedSessions: [{ pid: 20, happySessionId: 'session', processStartTimeMs: 20,
        requesterWorkAttributionV1: recovered?.attribution }] });
    const rows = resolveProcessOwnership({ snapshot, roots, daemonPrincipal: snapshot.rows[0]!.principal,
      daemonScopeKey: '123456789abc', platform: 'darwin' });
    expect(projectMachineProcesses({ status: 'ok', snapshot, roots, rows },
      { machineId: 'machine', scope: 'happier', view: 'tree' }, { accountId: 'bob', custodianAccountId: 'bob' },
      { platform: 'darwin', selfPid: 10, allProcessesVisible: false, confirmed: [],
        requesterForOwner: (owner, roots) => resolveProcessOwnerRequester(owner, roots,
          { target: attribution, custodianAccountId: 'bob' }) })).toMatchObject({ state: 'live', totals: { happier: { processCount: 2 } } });
    expect(await listRequesterSessionCredentialBindings({ happyHomeDir: directory!, serverId: attribution.serverId,
      machineId: attribution.machineId, installationId: attribution.installationId })).toEqual({ status: 'ready', bindings: [] });
    await recovered?.dispose();
  });

  it('does not invent a historical Home from current authenticated legacy ownership', async () => {
    const host = await home();
    expect(await requesterCredentialOwner.resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: directory!,
      serverId: attribution.serverId, sessionId: 'session', serverHttpBaseUrl: origin,
      machineAdmissionBoundary: host.boundary, legacyOwnerCredentials: credentials })).toBeNull();
  });

  it('does not treat a declared but unavailable requester scope as ordinary Account absence', async () => {
    const host = await home();
    const unavailable = { ...credentials };
    Object.defineProperty(unavailable, 'requesterSessionCredentialScope', { value: undefined, enumerable: false });
    const reads = host.requests.length;
    expect(await requesterCredentialOwner.resolveRequesterSessionExecutionIdentityForHost({ happyHomeDir: directory!,
      serverId: attribution.serverId, serverHttpBaseUrl: origin, sessionId: 'session', machineId: 'machine',
      hostHomeServerIdentityId: 'srv_original_home', credentials: unavailable, runtimeContext: null,
      isCurrent: () => true })).toEqual({ kind: 'unknown', reason: 'session_requester_unavailable' });
    expect(host.requests).toHaveLength(reads);
  });

  it.each(['different Session', 'different HTTP Home', 'missing retained Home', 'retargeted Home', 'unavailable Home'] as const)(
    'refuses legacy recovery with %s without rebinding original custody', async mismatch => {
      const host = await home();
      const retained = bindRequesterSessionCredentialScope({ ...credentials }, { serverId: attribution.serverId,
        serverHttpBaseUrl: mismatch === 'different HTTP Home' ? 'https://other-home.test' : origin,
        requesterSession: { sessionId: mismatch === 'different Session' ? 'another-session' : 'session', attribution,
          ...(mismatch === 'missing retained Home' ? {} : { homeServerIdentityId: 'srv_original_home' }) } });
      expect(await requesterCredentialOwner.resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: directory!,
        serverId: attribution.serverId, sessionId: 'session', serverHttpBaseUrl: origin,
        machineAdmissionBoundary: { ...host.boundary, getObservedServerIdentityId: () => mismatch === 'unavailable Home'
          ? null : mismatch === 'retargeted Home' ? 'srv_other_home' : 'srv_original_home' },
        legacyOwnerCredentials: retained })).toBeNull();
      expect(retained.requesterSessionCredentialScope?.requesterSession?.homeServerIdentityId)
        .toBe(mismatch === 'missing retained Home' ? undefined : 'srv_original_home');
    });

  it.each(['shared Session', 'changed installation', 'lost access', 'foreign custody', 'malformed custody'] as const)(
    'does not infer legacy Session ownership after %s', async failure => {
      const host = await home();
      if (failure === 'shared Session') host.setSessionRole('view');
      if (failure === 'changed installation') host.replaceDuringVerification();
      if (failure === 'lost access') host.setAccess(false);
      if (failure === 'foreign custody') await createRequesterSessionCredentialCustody({ happyHomeDir: directory!,
        sessionId: 'session', attribution: { ...attribution, installationId: 'old-installation' }, credentials });
      if (failure === 'malformed custody') await writePrivateOwnerFile({
        path: requesterSessionCredentialPath({ happyHomeDir: directory!, sessionId: 'session', attribution }), contents: '{}' });
      expect(await requesterCredentialOwner.resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: directory!,
        serverId: attribution.serverId, sessionId: 'session', serverHttpBaseUrl: origin,
        machineAdmissionBoundary: host.boundary, legacyOwnerCredentials: { ...credentials }, expectedAttribution: attribution })).toBeNull();
    });

  it.each(['serverId', 'accountId', 'machineId', 'installationId'] as const)(
    'does not replace a retained requester %s with the legacy owner identity', async field => {
      const host = await home();
      expect(await requesterCredentialOwner.resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: directory!,
        serverId: attribution.serverId, sessionId: 'session', serverHttpBaseUrl: origin,
        machineAdmissionBoundary: host.boundary, legacyOwnerCredentials: { ...credentials },
        expectedAttribution: { ...attribution, [field]: 'different-requester' } })).toBeNull();
    });

  it('recovers exact retained custody independently of an unreadable unrelated Session reference', async () => {
    const host = await home();
    await createRequesterSessionCredentialCustody({ happyHomeDir: directory!, sessionId: 'session', attribution, credentials,
      homeServerIdentityId: 'srv_original_home' });
    await writePrivateOwnerFile({ path: requesterSessionCredentialPath({ happyHomeDir: directory!, sessionId: 'unrelated', attribution }), contents: '{}' });
    const recovered = await requesterCredentialOwner.resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: directory!,
      serverId: attribution.serverId, sessionId: 'session', serverHttpBaseUrl: origin,
      machineAdmissionBoundary: host.boundary, expectedAttribution: attribution, legacyOwnerCredentials: { ...credentials } });
    expect(recovered?.getBoundSessionId()).toBe('session');
    expect(await recovered?.isCurrent()).toBe(true);
    await recovered?.dispose();
  });

  it('discovers only this Home and installed Machine from existing protected custody, and reports malformed or unsafe state unavailable', async () => {
    await home();
    const input = { happyHomeDir: directory!, serverId: attribution.serverId, machineId: attribution.machineId,
      installationId: attribution.installationId };
    expect(await listRequesterSessionCredentialBindings(input)).toEqual({ status: 'ready', bindings: [] });
    const binding = { happyHomeDir: directory!, sessionId: 'session', attribution };
    const custody = await createRequesterSessionCredentialCustody({ ...binding, credentials });
    await createRequesterSessionCredentialCustody({ ...binding, sessionId: 'other-home',
      attribution: { ...attribution, serverId: 'other-home' }, credentials });
    await createRequesterSessionCredentialCustody({ ...binding, sessionId: 'old-installation',
      attribution: { ...attribution, installationId: 'old-installation' }, credentials });
    await createRequesterSessionCredentialCustody({ ...binding, sessionId: 'other-machine',
      attribution: { ...attribution, machineId: 'other-machine' }, credentials });
    await replacePrivateBearerFile({ path: custody.path, contents: JSON.stringify({ v: 1, sessionId: 'session',
      futureOuter: true, attribution: { ...attribution, futureAttribution: true },
      credentials: { ...encodeStoredCredentials(credentials), futureCredential: true } }) });
    expect(await listRequesterSessionCredentialBindings(input)).toEqual({ status: 'ready', bindings: [{ sessionId: 'session', attribution }] });
    if (process.platform !== 'win32') {
      await chmod(custody.path, 0o644);
      expect(await listRequesterSessionCredentialBindings(input)).toEqual({ status: 'unavailable', reason: 'requester_session_custody_unavailable' });
      await chmod(custody.path, 0o600);
    }
    const malformedPath = requesterSessionCredentialPath({ ...binding, sessionId: 'malformed' });
    await writePrivateOwnerFile({ path: malformedPath, contents: JSON.stringify({ v: 1, sessionId: 'session',
      attribution, credentials: encodeStoredCredentials(credentials) }) });
    expect(await listRequesterSessionCredentialBindings(input)).toEqual({ status: 'unavailable', reason: 'requester_session_custody_unavailable' });
    await replacePrivateBearerFile({ path: malformedPath, contents: JSON.stringify({ v: 1, sessionId: 'malformed',
      attribution: { ...attribution, serverId: 'another-home' }, credentials: encodeStoredCredentials(credentials) }) });
    expect(await listRequesterSessionCredentialBindings(input)).toEqual({ status: 'unavailable', reason: 'requester_session_custody_unavailable' });
  });

  it('recovers a Bot with exact protected requester custody and removes access after final revoke', async () => {
    const host = await home({ bot: true });
    const binding = { happyHomeDir: directory!, sessionId: 'session', attribution };
    const custody = await createRequesterSessionCredentialCustody({ ...binding, credentials, homeServerIdentityId: 'srv_original_home' });
    const alice = getActiveAccountSettingsSnapshot();
    const recovered = await resolveRequesterSessionBootstrap({ ...binding, serverHttpBaseUrl: origin,
      machineAdmissionBoundary: host.boundary });
    onTestFinished(async () => { await recovered?.dispose(); });
    expect(recovered?.getBoundSessionId()).toBe('session');
    expect(recovered?.credentials).toMatchObject({ ...credentials, credentialProvenance: 'stored_session' });
    expect(recovered?.credentials.requesterSessionCredentialScope).toEqual({ serverId: attribution.serverId, serverHttpBaseUrl: origin });
    expect(JSON.stringify(recovered?.credentials)).not.toContain('requesterSessionCredentialScope');
    expect(recovered?.accountSettingsContext.source).toBe('network');
    expect(getActiveAccountSettingsSnapshot()).toBe(alice);
    expect(await recovered?.isCurrent()).toBe(true);
    expect(host.requests.filter(request => !request.path.endsWith('/admission/verify'))
      .every(request => request.bearer === `Bearer ${credentials.token}`)).toBe(true);
    expect(host.requests.filter(request => request.path.endsWith('/admission/verify'))
      .every(request => request.bearer === 'Bearer alice-daemon')).toBe(true);
    expect(await resolveRequesterSessionBootstrap({ ...binding, attribution: { ...attribution, accountId: 'eve' },
      serverHttpBaseUrl: origin, machineAdmissionBoundary: host.boundary })).toBeNull();
    host.setSessionRole('view');
    expect(await resolveRequesterSessionBootstrap({ ...binding, serverHttpBaseUrl: origin,
      machineAdmissionBoundary: host.boundary })).toBeNull();
    await expect(access(custody.path)).rejects.toMatchObject({ code: 'ENOENT' });
    // A new admitted rejoin supplies fresh custody after withdrawal retired it.
    host.setSessionRole('owner');
    await createRequesterSessionCredentialCustody({ ...binding, credentials, homeServerIdentityId: 'srv_original_home' });
    host.setAccountMode('e2ee');
    // This fixture has no live socket. Changed Home encryption is enforced by
    // independent recovery, not a new HTTP probe from an admitted reader.
    expect(await resolveRequesterSessionBootstrap({ ...binding, serverHttpBaseUrl: origin,
      machineAdmissionBoundary: host.boundary })).toBeNull();
    await recovered?.dispose();
    host.setAccountMode('plain'); host.setAccess(false);
    expect(await recovered?.savedSecretOperationContext.isCurrent()).toBe(false);
    host.setAccess(true);
    await createRequesterSessionCredentialCustody({ ...binding, credentials, homeServerIdentityId: 'srv_original_home' });
    const reconnected = await resolveRequesterSessionBootstrap({ ...binding, serverHttpBaseUrl: origin,
      machineAdmissionBoundary: host.boundary });
    onTestFinished(async () => { await reconnected?.dispose(); });
    expect(await reconnected?.savedSecretOperationContext.isCurrent()).toBe(true);
    expect(reconnected?.getBoundSessionId()).toBe('session');
    expect(recovered?.savedSecretOperationContext.readSnapshot()).toBeNull();
    expect(host.correspondence.recipe.identity).toEqual({ bot: { kind: 'bot' }, createdAsBot: true });
    host.setAccess(false);
    // Revocation is enforced by the next admission, not by rechecking admitted work.
    expect(await reconnected?.isCurrent()).toBe(true);
    expect(await resolveRequesterSessionBootstrap({ ...binding, serverHttpBaseUrl: origin,
      machineAdmissionBoundary: host.boundary })).toBeNull();
    await expect(access(custody.path)).rejects.toMatchObject({ code: 'ENOENT' });
    host.setAccess(true);
    expect(await resolveRequesterSessionBootstrap({ ...binding, serverHttpBaseUrl: origin,
      machineAdmissionBoundary: host.boundary })).toBeNull();
    await createRequesterSessionCredentialCustody({ ...binding, credentials, homeServerIdentityId: 'srv_original_home' });
    const restored = await resolveRequesterSessionBootstrap({ ...binding, serverHttpBaseUrl: origin,
      machineAdmissionBoundary: host.boundary });
    onTestFinished(async () => { await restored?.dispose(); });
    expect(restored?.getBoundSessionId()).toBe('session');
    await expect(access(custody.path)).resolves.toBeUndefined();
  });

  it('binds runtime currentness to the actual Session after custody binding', async () => {
    const host = await home();
    const rpc = new AbortController();
    let observedHome = 'srv_retained_birth_home';
    let beforeHomeRead: (() => Promise<void>) | undefined;
    const result = await admitRequesterSessionBootstrap({ bootstrap: { v: 1, disposition: 'ordinary_requester',
      credentials: { token: credentials.token }, sessionId: 'session', sessionCreationDisposition: 'rejoined' },
      boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory!,
        getObservedServerIdentityId: () => 'srv_retained_birth_home' },
      context: { signal: rpc.signal, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
        machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => !rpc.signal.aborted } });
    expect(result).not.toBeNull();
    const admitted = result!.admitted;
    onTestFinished(() => admitted.dispose());
    expect(admitted.homeServerIdentityId).toBe('srv_retained_birth_home');
    expect(admitted.preparedSessionId).toBe('session');
    expect(admitted.getBoundSessionId()).toBeNull();
    const bindRuntimeCurrentness = Reflect.get(requesterCredentialOwner,
      'bindRequesterSessionRuntimeMachineAdmissionCurrentness') as
      (input: Readonly<{ bootstrap: typeof admitted; boundary: RequesterSessionMachineAdmissionBoundary }>) => void;
    expect(typeof bindRuntimeCurrentness).toBe('function');
    bindRuntimeCurrentness({ bootstrap: admitted,
      boundary: { ...host.boundary, getObservedServerIdentityId: async () => {
        await beforeHomeRead?.();
        return observedHome;
      } } });
    expect(await admitted.isCurrent()).toBe(true);
    expect(host.requests.some(request => request.path.endsWith('/admission/verify'))).toBe(false);
    const bound = await result!.admitted.bindSession('session', host.correspondence.sessionCreationTag);
    expect(bound).not.toBeNull();
    expect(JSON.parse(await readFile(bound!.path, 'utf8'))).toMatchObject({
      attribution, homeServerIdentityId: 'srv_retained_birth_home',
    });
    expect(admitted.getBoundSessionId()).toBe('session');
    rpc.abort();
    expect(await admitted.savedSecretOperationContext.isCurrent()).toBe(true);
    host.setAccess(false);
    expect(await admitted.savedSecretOperationContext.isCurrent()).toBe(true);
    // The retained post-binding fence applies to a new binding attempt.
    expect(await admitted.bindSession('session', host.correspondence.sessionCreationTag)).toBeNull();
    observedHome = 'srv_replaced_home';
    expect(await admitted.savedSecretOperationContext.isCurrent()).toBe(false);
    observedHome = 'srv_retained_birth_home';
    let enteredHome!: () => void;
    let releaseHome!: () => void;
    const entered = new Promise<void>(resolve => { enteredHome = resolve; });
    const held = new Promise<void>(resolve => { releaseHome = resolve; });
    beforeHomeRead = async () => { enteredHome(); await held; };
    const pendingCurrentness = admitted.isCurrent();
    await entered;
    try { await admitted.dispose(); }
    finally { releaseHome(); }
    expect(await pendingCurrentness).toBe(false);
    expect(await admitted.savedSecretOperationContext.isCurrent()).toBe(false);
    expect(admitted.savedSecretOperationContext.readSnapshot()).toBeNull();
    expect(await readFile(bound!.path, 'utf8')).toContain(credentials.token);
  });

  it('refuses wrong authenticated requester and an installation replaced during fresh verification', async () => {
    const host = await home();
    const input = { credentials, attribution, sessionId: 'session', serverHttpBaseUrl: origin, boundary: host.boundary };
    host.setAccountId('alice');
    expect(await verifyRequesterSessionMachineAdmissionCurrent(input)).toBe(false);
    host.setAccountId('bob'); host.replaceDuringVerification();
    expect(await verifyRequesterSessionMachineAdmissionCurrent(input)).toBe(false);
  });
});
