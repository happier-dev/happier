import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn as observedSpawn } from 'node:child_process';
import axios, { AxiosHeaders, type AxiosRequestConfig } from 'axios';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { afterAll, afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { readStoredCredentialsForServerId, writeStoredCredentialsForServerId } from '@/persistence';
import { decodeRunnerDaemonPluginServiceWireValueV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema, ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { startExecutionRun } from '@/agent/runtime/bridges/executionRun/startExecutionRun';
import { stopExecutionRun } from '@/agent/runtime/bridges/executionRun/executionRunStop';
import { finishExecutionRun } from '@/agent/runtime/bridges/executionRun/finishExecutionRun';
import { projectExecutionRunPublicState } from '@/agent/runtime/bridges/executionRun/publicState';
import { createNativeAgentExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/nativeAgentExecutionRun';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import * as sessionRpc from '@/session/transport/rpc/sessionRpc';
import { createProjectSetupTrustClient } from '@/workspaces/projectSetup/projectSetupTrust';
import { createProjectSetupSuccessStore } from '@/workspaces/projectSetup/projectSetupSuccess';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { logger } from '@/ui/logger';
import { createRunnerAgentSessionRuntimeSource } from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import { AgentRuntimeDaemonServiceRequestV1Schema, AGENT_RUNTIME_DAEMON_SERVICES_PATH } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority, readAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { configuration, reloadConfiguration } from '@/configuration';
import * as processIdentity from '@/daemon/processIdentity';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { createRequesterSessionCredentialCustody, prepareRequesterSessionBootstrap,
  retireRequesterSessionCredentialCustody } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { prepareRunnerDaemonPluginServices } from '@/agent/runtime/session/process/runnerDaemonPluginServices';
import { buildOutboundSessionMessagePayload } from '@/api/session/client/transport/outboundSessionMessagePayload';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { authorizeResolvedAgentNativeExecLaunchForHost, issueAgentNativeLaunchQualifierForHost, spawnAuthorizedHostExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { createSessionDaemonAuthorityFixture } from '@/mcp/runtime/sessionDaemonAuthority.testkit';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { registerProjectDefinitionHandlers } from '@/rpc/handlers/projectDefinitions';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { projectSessionAccessCapabilitiesV1, SessionEffectiveAccessV1Schema } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { requesterSessionCredentialPath } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { writePrivateOwnerFile } from '@/daemon/privateBearerFile';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListRequestV1Schema, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { dispatchCurrentRunnerDaemonPluginService } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';
import { SessionSpawnNewInputV2Schema, SessionSpawnNewResultV1Schema } from '@happier-dev/protocol';
import { registerSessionSpawnNewRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import { createMachineSessionDirectTargetTransport } from '@/rpc/handlers/sessionServerStartLifecycleAdapter';
import { createSpawnNewSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import type { RpcHandler } from '@/api/rpc/types';
import { writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { installDaemonMachineAdmissionTransport, MachineAdmissionTransportUnavailableError } from '@/daemon/machineAdmissionTransport';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { spawnPublicInstalledProjectAgentSession } from '@/daemon/testkit/publicInstalledProjectAgentSpawn.testkit';
import { resolveRequesterSessionExecutionIdentityForHost } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createDeferred } from '@/testkit/async/deferred';
import { assertStartupFailureThroughCli } from '@/session/services/createSpawnedSession.startupFailure.testkit';
import { createFirstConversationAgentFixture } from '@/daemon/testkit/firstConversationAgent.testkit';
import { runInstalledFirstConversationRuntime } from '@/daemon/testkit/firstConversationRuntime.testkit';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { prepareDaemonConnectedServices } from '@/daemon/spawn/prepareDaemonConnectedServices';
import type { ApiClient } from '@/api/api';
import { prepareSessionMcpLocalTransport } from '@/mcp/runtime/sessionMcpLocalTransport';
import { resolveSessionMcpNativeLaunchMaterial } from '@/mcp/runtime/sessionMcpNativeLaunchMaterial';
import * as nativeProcess from '@happier-dev/cli-common/process';
import { runAgentIsolationMemberReadinessBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null,
  memberWorkspaceRoots: new Set<string>() }));
// Synthetic member accounts have no native directory on this test host. Only
// their OS canonical-path observation is substituted; real workspaces stay real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: async (...args: Parameters<typeof actual.realpath>) =>
    boundary.memberWorkspaceRoots.has(String(args[0])) ? String(args[0]) : actual.realpath(...args) };
});
// The private HTTP listener is the transport boundary. Its production dispatcher,
// installed finite registration, requester custody and Exec remain real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));
// Genuine HTTP boundary: control requests use Undici's fetch and dispatcher.
// Preserve its Agent while sharing the fixture's existing Fetch responder.
vi.mock('undici', async importOriginal => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as unknown as typeof actual.fetch };
});
// Observe the genuine OS boundary without replacing a process, its output, or
// any Exec/admission logic. The matching owner-positive launch validates this
// observer before it is used as evidence that a refused grant created no child.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; boundary.memberWorkspaceRoots.clear(); });
afterAll(() => pluginReloadController.shutdown());

function observeGrantChildren(cwd: string) {
  const spawn = vi.mocked(observedSpawn);
  const start = spawn.mock.calls.length;
  return () => spawn.mock.calls.slice(start).filter(([, args, options]) =>
    args?.includes('--version') && options?.cwd === cwd).length;
}

const pluginExecAgent = {
    manifest: createPluginManifestV2Fixture({ id: 'acme.project-launch', hostAccess: { required: [{
      id: 'native-process', capability: 'process', reason: 'Run the declared native Agent CLI',
      scope: { executables: [{ kind: 'systemTool', id: 'native-cli' }] },
    }, { id: 'workspace', capability: 'filesystem', reason: 'Use the original Agent workspace',
      scope: { locations: [{ root: 'workspace' }], access: ['read'] } }], optional: [] }, contributes: {
      systemTools: [{ id: 'native-cli', title: 'Native Agent CLI fixture', executableNames: ['git'] }],
      agents: [{ id: 'agent', title: 'Native Agent', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }],
    } }),
    files: { 'agent.mjs': 'export function factory() { return { sessions: { open() { throw new Error("Native process boundary only"); } } }; }',
      'daemon.mjs': 'import { factory } from "./agent.mjs"; export function activate(api) { api.agents.register("agent", factory, { sessionRunnerFactory: { module: "./agent.mjs", export: "factory", runtimeApiVersion: 1 } }); }' },
  };

function terminalSignIn(accountId: string, tokenEpoch = 0) {
  const claims = { sub: accountId, tokenEpoch, provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } };
  return { token: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`, encryption: null };
}

it.skipIf(process.platform !== 'linux')('authorizes OpenCode member launch after adopting its prepared spawn material', async () => {
  const home = 'srv_installed_project_fixture';
  const roots: string[] = [];
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, 'opencode', true, undefined, undefined, {
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
    agentIsolation: { managedHappierBinaryPath: '/opt/happier/cli/current/happier',
      read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1',
        status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: roots }) },
  });
  roots.push(h.cwd);
  const requester = { kind: 'isolated' as const, separationRequired: true,
    homeServerIdentityId: home, requester: h.f.bootstrap.attribution };
  // The OS account observation is a simulated boundary; material projection,
  // registry adoption and the installed OpenCode daemon dispatcher stay real.
  const member = { ...deriveAgentIsolationMemberIdentity(requester), agentUid: 2401, agentGid: 2401 };
  boundary.memberWorkspaceRoots.add(member.workspaceRoot);
  const runNative = nativeProcess.execFileWithDeadline;
  vi.spyOn(nativeProcess, 'execFileWithDeadline').mockImplementation(async (...request) => {
    const observed = await runAgentIsolationMemberReadinessBoundary({ request,
      nativeHome: { path: member.home, uid: member.agentUid } });
    return observed ?? runNative(...request);
  });
  const api = new Proxy({} as ApiClient, { get() { throw new Error('Brokered member launch must not acquire local credentials'); } });
  const prepared = await prepareDaemonConnectedServices({
    options: { directory: h.cwd, requesterWorkAttributionV1: requester.requester,
      modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'agent:happier.agent.opencode/opencode',
        providerConnectionId: null, modelId: 'muse-spark-1.3' } },
      teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: 'team-model',
        teamId: 'team', expectedResourceRevision: 1, deliveryMode: 'brokered' }] },
    preparedAgentIsolationIdentity: { memberIdentity: member, nativeIdentity: member },
    normalizedExistingSessionId: '', requestedSessionId: h.sessionId, effectiveResume: '', catalogAgentId: 'opencode',
    credentials: { token: 'synthetic-requester', encryption: null }, api,
    activeServerDir: join(h.f.directory, 'server'), connectedServicesMaterializationBaseDir: join(h.f.directory, 'materialized'),
    connectedServiceRefreshCoordinator: null, processEnv: {}, pluginRuntimeRegistry: h.plugin.registry,
  });
  expect(prepared).toMatchObject({ ok: true });
  if (!prepared.ok) throw new Error('Brokered member preparation refused');
  onTestFinished(() => prepared.auth?.cleanupOnExit?.());
  const material = prepared.agentLaunchMaterials;
  if (!material) throw new Error('Selected material producer returned no projection');
  h.connectedServiceRuntimeRegistry.registerTarget({ pid: h.runner.pid, spawnTrackingKey: 'opencode-spawn',
    agentId: h.retainedAgent.agentId, materializationKey: prepared.materializationKey,
    requesterWorkAttributionV1: h.f.bootstrap.attribution, agentLaunchMaterials: material,
    connectedServicesBindingsRaw: prepared.effectiveBindings,
    connectedServiceSelectionsEnv: prepared.auth?.env });
  h.connectedServiceRuntimeRegistry.adoptSessionId({ pid: h.runner.pid,
    spawnTrackingKey: 'opencode-spawn', sessionId: h.sessionId });
  expect(h.connectedServiceRuntimeRegistry.getBySessionId(h.sessionId)?.agentLaunchMaterials).toBe(material);
  const transport = await prepareSessionMcpLocalTransport({ agentUid: process.getuid!() });
  onTestFinished(() => transport.retire());
  const mcpMaterial = await resolveSessionMcpNativeLaunchMaterial({
    launch: { agentIsolationMemberIdentity: member, agentIsolationRuntimeHome: material.runtimeHome },
    isolationEnabled: true, homeServerIdentityId: home,
    source: { kind: 'requester', identity: requester, hostHomeServerIdentityId: home }, signal: h.signal,
  });
  if (!mcpMaterial) throw new Error('Session MCP material producer returned no native identity');
  expect(await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase() })).toMatchObject({ ok: true });
  expect(h.connectedServiceRuntimeRegistry.getBySessionId(h.sessionId)?.agentLaunchMaterials).toBe(material);
  const refusals = vi.spyOn(logger, 'warnLocalFile');
  const launch = await h.dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1',
    agentLaunchKind: 'managedService', ...h.operationBase(),
    sessionMcpContext: transport.localContext,
    mcpLaunchMaterial: { ...material, nativeIdentity: mcpMaterial.identity },
    launch: { command: '/installed/opencode', args: ['serve'], cwd: h.cwd, env: {} } });
  expect(launch, JSON.stringify(launch.ok ? { ok: true } : {
    error: launch.error, diagnostics: refusals.mock.calls.map(([message, details]) => ({ message, details })),
  })).toMatchObject({
    ok: true, result: { kind: 'plugin_services.result_v1' },
  });
  if (!launch.ok || launch.result.kind !== 'plugin_services.result_v1') throw new Error('Missing authorized Agent tuple');
  expect(decodeRunnerDaemonPluginServiceWireValueV1(launch.result.value)).toMatchObject({
    launch: { command: 'sudo', args: ['-n', '-u', member.username, '--', '/opt/happier/cli/current/happier', 'agent-launch'] },
  });
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase() });
}, 120_000);

it.each(['owner-policy-off', 'member-policy-off', 'unknown-requester', 'owner-policy-on', 'cancelled-parent-before-admission', 'withdrawn-after-admission'] as const)(
  'admits runner managed Agent servers only through the original requester finalizer (S0-5 %s)', async shape => {
  const home = 'srv_s0_managed_agent';
  const member = shape === 'member-policy-off';
  // OWNER-RULINGS 2026-11-02, Guest execution fallback: an admitted guest
  // inherits the owner's OS user when separate-user provisioning is off.
  const usesOwnerOsUser = shape === 'owner-policy-off' || member;
  const unknown = shape === 'unknown-requester';
  let enabled = shape === 'owner-policy-on';
  const workspaceRoots: string[] = [];
  let runnerCommand = '';
  // Git is the fixture's actually admitted non-runtime Host tool. Its daemon
  // binds only ephemeral localhost; the real supervisor owns its child/tree.
  // Generic system tools deliberately cannot launch Node/package runtimes.
  const managedAgent = pluginExecAgent;
  const custodian = member ? 'company' : 'requester';
  const daemonCredentials = terminalSignIn(custodian);
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, managedAgent, undefined, {
    credentials: daemonCredentials, externalActionAccountId: custodian, homeServerIdentityId: home,
    runnerIdentity: happyHomeDir => {
      runnerCommand = `${process.execPath} ${join(happyHomeDir, '.runner-snapshots', 's0-managed-runner', 'index.mjs')}`;
      return { pid: process.pid, processStartTimeMs: 1, processCommandHash: hashProcessCommand(runnerCommand),
        snapshotIdentity: 'snapshot:s0-managed-runner' };
    },
    ordinaryAccountSession: !member && !unknown,
    ...(unknown ? { retainIncompleteRequesterCustody: true } : {}),
    machineAccess: { custodianAccountId: custodian, role: 'manage' },
    processEnv: { PATH: process.env.PATH },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
    agentIsolation: { read: () => ({ enabled, status: enabled
      ? { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }
      : { kind: 'disabled' }, workspaceRoots }) },
  });
  workspaceRoots.push(h.cwd);
  const readNativeProcessIdentity = processIdentity.readProcessIdentityByPid;
  vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockImplementation(async (pid, dependencies) =>
    pid === h.runner.pid ? { pid, processStartTimeMs: h.runner.processStartTimeMs, command: runnerCommand }
      : await readNativeProcessIdentity(pid, dependencies));
  const authorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing });
  await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing, path: authorityFilePath,
    sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, httpPort: 43129 });
  const homeFetch = globalThis.fetch;
  let daemonRequests = 0;
  let withdrawnAtFinalizer = false;
  const supervisionEntered = createDeferred<void>();
  // Observe only the strict private-HTTP outcome, never request material,
  // arbitrary exception text or credential-bearing response messages.
  const supervisionOutcomes: Array<Readonly<{ phase: 'supervision'; code: string }>> = [];
  const pendingHttp: Promise<unknown>[] = [];
  const httpPhases: Array<Readonly<{ phase: 'received' | 'parsed' | 'returned' | 'threw';
    operation?: string; schemaSuccess?: boolean; issueCodes?: readonly string[]; code?: string;
    errorKind?: 'Error' | 'TypeError' | 'RangeError' | 'PluginError' | 'ZodError' | 'other' }>> = [];
  vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(String(url)).pathname !== AGENT_RUNTIME_DAEMON_SERVICES_PATH) return homeFetch(url, init);
    httpPhases.push({ phase: 'received' });
    const parsed = AgentRuntimeDaemonServiceRequestV1Schema.safeParse(JSON.parse(String(init?.body)));
    httpPhases.push({ phase: 'parsed', schemaSuccess: parsed.success,
      ...(parsed.success ? { operation: parsed.data.operation.kind } : { issueCodes: parsed.error.issues.map(issue => issue.code) }) });
    const request = parsed.success ? parsed.data : AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
    expect(request.context.sessionId).toBe(h.sessionId);
    daemonRequests++;
    if (shape === 'withdrawn-after-admission' && request.operation.kind === 'plugin_exec.resolved_agent_launch.authorize_v1') {
      await writeStoredCredentialsForServerId(h.f.bootstrap.attribution.serverId, terminalSignIn('other-account'));
      withdrawnAtFinalizer = true;
    }
    const dispatchResponse = h.dispatch(request.operation, request.context.executionRunSnapshotId).catch(error => {
      const ownCode: unknown = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
      const ownName: unknown = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'name')?.value : undefined;
      const errorKind = ownName === 'PluginError' || ownName === 'ZodError' ? ownName
        : error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError' : error instanceof Error ? 'Error' : 'other';
      const ownIssues: unknown = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'issues')?.value : undefined;
      httpPhases.push({ phase: 'threw', operation: request.operation.kind, errorKind,
        ...(typeof ownCode === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(ownCode) ? { code: ownCode } : {}),
        ...(Array.isArray(ownIssues) ? { issueCodes: ownIssues.map((issue: unknown) => issue && typeof issue === 'object'
          && 'code' in issue && typeof issue.code === 'string' && /^[a-z_]+$/u.test(issue.code) ? issue.code : 'unknown') } : {}) });
      throw error;
    });
    pendingHttp.push(dispatchResponse);
    if (request.operation.kind === 'managed_server.supervision.authorize') supervisionEntered.resolve();
    // A real fetch detaches on abort even while the daemon awaits upstream IO.
    let removeAbort = () => {};
    const response = await (init?.signal ? Promise.race([dispatchResponse,
      new Promise<never>((_resolve, reject) => {
        const signal = init.signal!;
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        removeAbort = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
      })]) : dispatchResponse).finally(() => removeAbort());
    httpPhases.push({ phase: 'returned', operation: request.operation.kind, code: response.ok ? 'ok' : response.error.code });
    if (request.operation.kind === 'managed_server.supervision.authorize') {
      supervisionOutcomes.push({ phase: 'supervision', code: response.ok ? 'authorized' : response.error.code });
    }
    return Response.json(response);
  });
  const source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing, authorityFilePath, expectedSessionId: h.sessionId });
  if (!source) throw new Error('Missing genuine managed Agent runner source');
  const lifetime = new AbortController();
  onTestFinished(() => source.retire?.());
  onTestFinished(() => lifetime.abort());
  const createServices = (correlationId: string) => source.createInvocationServices({ pluginId: h.retainedAgent.pluginId,
    pluginVersion: h.retainedAgent.pluginVersion, agentId: h.retainedAgent.agentId,
    occurrenceId: source.identity.occurrenceId, correlationId,
    processOwner: { kind: 'session', sessionId: h.sessionId }, cwd: h.cwd, environment: {}, providerBindingActive: false,
    session: { id: h.sessionId, current: { interactions: { async request() { throw new Error('No user interaction requested'); } } } },
    signal: lifetime.signal, isOccurrenceCurrent: () => !lifetime.signal.aborted });
  const qualificationEntered = createDeferred<void>();
  const releaseQualification = createDeferred<void>();
  if (shape === 'cancelled-parent-before-admission') {
    const homeRead = vi.mocked(axios.get).getMockImplementation();
    if (!homeRead) throw new Error('Missing genuine Home HTTP boundary');
    vi.mocked(axios.get).mockImplementation(async (...args) => {
      if (new URL(String(args[0])).pathname === '/v1/machines/machine') {
        qualificationEntered.resolve();
        await releaseQualification.promise;
      }
      return await homeRead(...args);
    });
    onTestFinished(() => releaseQualification.resolve());
  }
  const services = await createServices(`s0-managed-${shape}`);
  const serverArgs = ['daemon', '--listen=127.0.0.1', '--port=0', '--export-all', `--base-path=${h.cwd}`];
  const serverSpec = { id: 's0-native-server', mode: { kind: 'spawn',
    launch: { executable: { kind: 'systemTool', id: 'native-cli' }, args: serverArgs }, endpoint: { kind: 'none' } },
    healthCheck: { kind: 'none' } } satisfies Parameters<typeof services.managedServices.supervise>[0];
  const spawns = vi.mocked(observedSpawn);
  const firstSpawn = spawns.mock.calls.length;
  const childStarts = () => spawns.mock.calls.slice(firstSpawn).filter(([, args]) =>
    args?.includes('daemon') && args.includes('--listen=127.0.0.1') && args.includes('--port=0')).length;
  let handle: Awaited<ReturnType<typeof services.managedServices.supervise>> | undefined;
  let failure: unknown;
  const projectEffectsBefore = h.nativeEffects();
  try {
    // Read the exact production private authority, not a synthesized capability.
    // A missing snapshot file alone is not a condition of this canonical reader.
    expect(await readAgentRuntimeDaemonServiceAuthority({ happyHomeDir: h.f.directory,
      publicReleaseRing: configuration.publicReleaseRing, path: authorityFilePath,
      sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent })).not.toBeNull();
    if (shape === 'cancelled-parent-before-admission') {
      const individualCaller = new AbortController();
      const pending = services.managedServices.supervise(serverSpec, { signal: individualCaller.signal });
      const settlement = Promise.allSettled([pending]);
      try {
        await Promise.all([qualificationEntered.promise, supervisionEntered.promise]);
        lifetime.abort(new DOMException('Session incarnation retired', 'AbortError'));
        await expect(pending).rejects.toMatchObject({ code: 'plugin_operation_aborted' });
        expect(individualCaller.signal.aborted).toBe(false);
        expect(childStarts()).toBe(0);
      } finally {
        releaseQualification.resolve();
        await settlement;
        await Promise.allSettled(pendingHttp);
      }
      return;
    }
    try { handle = await services.managedServices.supervise(serverSpec, { signal: lifetime.signal }); }
    catch (error) { failure = error; }
    expect({ supervisionOutcomes, childStarts: childStarts() }, JSON.stringify({ httpPhases })).toEqual({
      supervisionOutcomes: [{ phase: 'supervision', code: unknown ? 'agent_isolation_unavailable' : 'authorized' }],
      childStarts: usesOwnerOsUser ? 1 : 0,
    });
    if (usesOwnerOsUser) {
      expect(failure).toBeUndefined();
      if (!handle) throw new Error('Admitted requester did not receive its managed server');
      expect(handle.snapshot()).toMatchObject({ state: 'running' });
      expect(childStarts()).toBe(1);
      const nativeSpawn = spawns.mock.calls.slice(firstSpawn).find(([, args]) => args?.includes('--listen=127.0.0.1'));
      expect(nativeSpawn).toBeDefined();
      // The real child inherits this daemon's OS user; no uid/gid switch.
      expect(nativeSpawn?.[2]?.uid).toBeUndefined();
      expect(nativeSpawn?.[2]?.gid).toBeUndefined();
      // A running Session service keeps its placement until its next start.
      enabled = true;
      const nextServices = await createServices(`s0-managed-${shape}-reuse`);
      const reused = await nextServices.managedServices.supervise(serverSpec, { signal: lifetime.signal });
      expect(reused.snapshot()).toMatchObject({ state: 'running' });
      expect(childStarts()).toBe(1);
    } else {
      const withdrewCredentials = shape === 'withdrawn-after-admission';
      expect(failure).toMatchObject({
        code: withdrewCredentials ? 'plugin_managed_service_establishment_failed' : 'agent_isolation_unavailable',
        retryable: false,
      });
      if (!unknown) expect(httpPhases).toContainEqual({ phase: 'returned', operation: 'plugin_exec.resolved_agent_launch.authorize_v1',
        code: withdrewCredentials ? 'project_requester_credentials_unavailable' : 'agent_isolation_unavailable' });
      expect(childStarts()).toBe(0);
      expect(h.nativeEffects()).toBe(projectEffectsBefore);
      expect(handle).toBeUndefined();
      if (shape === 'withdrawn-after-admission') expect(withdrawnAtFinalizer).toBe(true);
    }
    const requestsAtSettlement = daemonRequests;
    await Promise.resolve();
    expect(daemonRequests).toBe(requestsAtSettlement);
  } finally { await handle?.dispose(); lifetime.abort(); await source.retire?.(); }
}, 120_000);

it.each(['qualification', 'currentness'] as const)('detaches a cancelled launch from shared requester identity while its sibling still completes (F11 %s)', async phase => {
  const home = 'srv_f11_owner';
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  let holdCurrentness = false;
  const currentnessSignals: Array<AbortSignal | undefined> = [];
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    externalActionAccountId: 'requester', homeServerIdentityId: home, ordinaryAccountSession: true,
    resolveCurrentMachineExecutionOriginContext: async signal => {
      if (holdCurrentness) {
        currentnessSignals.push(signal);
        entered.resolve();
        await release.promise;
      }
      return { serverIdentityId: home, machineId: 'machine' };
    },
    agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
  });
  const invocationId = 'f11-shared-identity';
  expect(await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase(invocationId) })).toMatchObject({ ok: true });
  const services = boundary.control?.agentRuntimeDaemonServices;
  if (!services) throw new Error('Missing registered daemon services');
  const get = vi.mocked(axios.get).getMockImplementation();
  if (!get) throw new Error('Missing Home HTTP boundary');
  let identityReads = 0;
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    if (new URL(String(args[0])).pathname === '/v1/machines/machine') {
      identityReads++;
      if (phase === 'qualification') {
        entered.resolve();
        await release.promise;
      }
    }
    return await get(...args);
  });
  const launch = async (signal: AbortSignal) => await services.dispatch(AgentRuntimeDaemonServiceRequestV1Schema.parse({
    v: 1, context: { token: 'a'.repeat(43), sessionId: h.sessionId }, operation: {
      kind: 'host_scm.run_v1', ...h.operationBase(invocationId), command: { bin: 'git', args: ['--version'], cwd: h.cwd },
    },
  }), { sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, trackedSession: h.tracked,
    invocationContext: h.tracked.runnerAgentInvocationContext!, isCurrent: async () => true, signal });
  if (phase === 'currentness') {
    expect(await launch(h.signal)).toMatchObject({ ok: true });
    holdCurrentness = true;
  }
  const cancelled = new AbortController();
  const childStarts = observeGrantChildren(h.cwd);
  let detached = false;
  const first = launch(cancelled.signal).finally(() => { detached = true; });
  const second = launch(h.signal);
  // Attach observers before cancellation so a typed rejection is never unhandled.
  const settled = Promise.allSettled([first, second]);
  try {
    await entered.promise;
    cancelled.abort(new DOMException('Launch cancelled', 'AbortError'));
    // One event-loop turn proves detachment while the HTTP read is still held;
    // this is not a wall-clock threshold or a production deadline.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(detached, 'cancelled launch must settle before the shared read is released').toBe(true);
    expect(identityReads).toBe(1);
    expect(childStarts()).toBe(0);
    expect(await first).toMatchObject({ ok: false });
    if (phase === 'currentness') expect(currentnessSignals.some(signal => signal?.aborted)).toBe(true);
    release.resolve();
    const surviving = await second;
    expect(surviving).toMatchObject({ ok: true });
    if (!surviving.ok || surviving.result.kind !== 'plugin_services.result_v1') throw new Error('Missing surviving SCM result');
    expect(decodeRunnerDaemonPluginServiceWireValueV1(surviving.result.value)).toMatchObject({ success: true, exitCode: 0,
      stdout: expect.stringMatching(/^git version /) });
    expect(identityReads).toBe(1);
    expect(childStarts()).toBe(1);
  } finally {
    release.resolve();
    await settled;
    await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase(invocationId) });
  }
}, 120_000);

it.each(['fresh', 'resumed', 'continuation'] as const)('retains qualified owner custody through grant-based PluginExec (%s)', async shape => {
  const home = 'srv_plugin_exec_owner';
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, pluginExecAgent, undefined, {
    externalActionAccountId: 'requester', homeServerIdentityId: home,
    ordinaryAccountSession: shape !== 'resumed',
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
    agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
  });
  if (shape === 'resumed') delete h.tracked.requesterSessionRuntimeContext;
  const run = async (invocationId: string) => {
    const services = await prepareRunnerDaemonPluginServices({ invocationId, signal: h.signal,
      local: createUnavailablePluginServices(), dispatch: async operation => {
        const response = await h.dispatch(operation);
        if (!response.ok) throw Object.assign(new Error(response.error.code), { code: response.error.code });
        if (response.result.kind !== 'plugin_services.result_v1') throw new Error('Missing registered PluginExec response');
        return decodeRunnerDaemonPluginServiceWireValueV1(response.result.value);
      } });
    const resolved = await services.exec.systemTools.resolve({ toolId: 'native-cli', purpose: 'Start the admitted native Agent', cwd: h.cwd });
    const readChildStarts = observeGrantChildren(h.cwd);
    const result = await services.exec.run({ executable: resolved.executable, args: ['--version'], cwd: h.cwd }, {
      nativeLaunch: issueAgentNativeLaunchQualifierForHost(services.exec),
    });
    expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
    expect(new TextDecoder().decode(result.stdout)).toMatch(/^git version /);
    expect(readChildStarts()).toBe(1);
    await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase(invocationId) });
  };
  if (shape === 'continuation') await run('plugin-exec-initial');
  await run(`plugin-exec-${shape}`);
  if (shape === 'resumed') {
    const recovered = h.tracked.requesterSessionRuntimeContext?.bootstrap;
    expect(recovered?.attribution).toEqual(h.f.bootstrap.attribution);
    expect(recovered?.homeServerIdentityId).toBe(home);
    expect(recovered?.getBoundSessionId()).toBe(h.sessionId);
    expect(recovered?.credentials.token === h.f.bootstrap.credentials.token).toBe(true);
    expect(recovered?.credentials.token === h.installedCredentials?.token).toBe(false);
  }
}, 120_000);

it.each(['fresh', 'public stamped owner', 'retained', 'continuation'] as const)('carries native Session runner context into generic PluginExec (%s)', async shape => {
  const home = 'srv_plugin_exec_carrier_owner';
  let command = '';
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, false, pluginExecAgent,
    shape === 'public stamped owner' ? pluginReloadController : undefined, {
    externalActionAccountId: 'requester', homeServerIdentityId: home,
    runnerIdentity: happyHomeDir => {
      command = `${process.execPath} ${join(happyHomeDir, '.runner-snapshots', 'carrier-runner', 'index.mjs')}`;
      return { pid: process.pid, processStartTimeMs: 1, processCommandHash: hashProcessCommand(command),
        snapshotIdentity: 'snapshot:carrier-runner' };
    },
    ordinaryAccountSession: shape !== 'retained',
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
    agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
  });
  if (shape === 'retained') delete h.tracked.requesterSessionRuntimeContext;
  if (shape === 'public stamped owner') {
    const installedAgent = h.plugin.registry.contributes.agentDefinitionsById.get(h.retainedAgent.agentId);
    if (!installedAgent?.identity) throw new Error('Missing installed public Agent identity');
    let launched: SpawnSessionOptions | undefined;
    expect(await spawnPublicInstalledProjectAgentSession({ fixture: h, actor: 'owner', homeServerIdentityId: home,
      agentTarget: { kind: 'agent', identity: installedAgent.identity },
      onSpawn: options => { launched = options; },
    })).toBe(true);
    expect(launched).toMatchObject({ requesterWorkAttributionV1: {
      serverId: configuration.activeServerId, accountId: 'requester', machineId: 'machine', installationId: h.f.installation.installationId,
    }, verifyRequesterMachineAdmissionCurrent: expect.any(Function) });
    expect(h.tracked.requesterSessionRuntimeContext).toBeUndefined();
  }
  // Process census and HTTP are genuine boundaries. The source claims its
  // actual private authority and builds its own Session invocation services.
  const readNativeProcessIdentity = processIdentity.readProcessIdentityByPid;
  vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockImplementation(async (pid, dependencies) =>
    pid === h.runner.pid ? { pid, processStartTimeMs: h.runner.processStartTimeMs, command }
      : await readNativeProcessIdentity(pid, dependencies));
  const authorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing });
  await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing, path: authorityFilePath,
    sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, httpPort: 43129 });
  const homeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(String(url)).pathname !== AGENT_RUNTIME_DAEMON_SERVICES_PATH) return await homeFetch(url, init);
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
    expect(request.context.sessionId).toBe(h.sessionId);
    return Response.json(await h.dispatch(request.operation, request.context.executionRunSnapshotId));
  });
  const source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing, authorityFilePath, expectedSessionId: h.sessionId });
  if (!source) throw new Error('Missing claimed native Session runner source');
  onTestFinished(() => source.retire?.());
  const launch = async (invocationId: string) => {
    const lifetime = new AbortController();
    onTestFinished(() => lifetime.abort());
    const services = await source.createInvocationServices({ pluginId: h.retainedAgent.pluginId,
      pluginVersion: h.retainedAgent.pluginVersion, agentId: h.retainedAgent.agentId,
      occurrenceId: source.identity.occurrenceId, correlationId: invocationId,
      processOwner: { kind: 'session', sessionId: h.sessionId }, cwd: h.cwd, environment: {},
      providerBindingActive: false, signal: lifetime.signal, isOccurrenceCurrent: () => true });
    const resolved = await services.exec.systemTools.resolve({ toolId: 'native-cli', purpose: 'Open the native Session carrier', cwd: h.cwd });
    const beforeProject = h.nativeEffects();
    const readChildStarts = observeGrantChildren(h.cwd);
    const result = await services.exec.run({ executable: resolved.executable, args: ['--version'], cwd: h.cwd }, {
      nativeLaunch: issueAgentNativeLaunchQualifierForHost(services.exec),
    });
    expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
    expect(new TextDecoder().decode(result.stdout)).toMatch(/^git version /);
    expect(readChildStarts()).toBe(1);
    // A child succeeding alone cannot prove the native preparation was wired.
    // Its accepted Project toolchain must have been evaluated by the real owner.
    expect(h.nativeEffects()).toBe(beforeProject + 1);
    if (shape !== 'retained') expect(h.nativeRequesterIdentities().at(-1)).toEqual({
      kind: 'isolated', separationRequired: false, requester: { ...h.f.bootstrap.attribution, serverId: home },
    });
    await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase(invocationId) });
    lifetime.abort();
  };
  if (shape === 'continuation') await launch('carrier-original');
  await launch(`carrier-${shape}`);
  if (shape === 'retained') {
    expect(h.tracked.requesterSessionRuntimeContext?.bootstrap.homeServerIdentityId).toBe(home);
    expect(h.tracked.requesterSessionRuntimeContext?.bootstrap.getBoundSessionId()).toBe(h.sessionId);
  } else expect(h.tracked.requesterSessionRuntimeContext).toBeUndefined();
}, 120_000);

it.each(['owner', 'member', 'member manage'] as const)('admits UI-shaped fresh Codex native launch only for the exact owner (%s)', async actor => {
  const home = 'srv_ui_codex_native_owner';
  const custodian = actor === 'owner' ? 'requester' : 'company';
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, 'codex', true, undefined, pluginReloadController, {
    externalActionAccountId: custodian, homeServerIdentityId: home, ordinaryAccountSession: true,
    machineAccess: { custodianAccountId: custodian, role: actor === 'member' ? 'use' : 'manage' },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
    agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
  });
  if (!await spawnPublicInstalledProjectAgentSession({ fixture: h, actor: actor === 'owner' ? 'owner' : 'member',
    memberRole: actor === 'member' ? 'use' : 'manage', homeServerIdentityId: home })) {
    expect(h.nativeEffects()).toBe(0);
    return;
  }
  if (actor === 'owner') expect(await resolveRequesterSessionExecutionIdentityForHost({
    happyHomeDir: h.f.directory, serverId: h.f.bootstrap.attribution.serverId, serverHttpBaseUrl: 'https://session-home.test',
    sessionId: h.sessionId, machineId: 'machine', credentials: h.installedCredentials!,
    attribution: h.tracked.requesterWorkAttributionV1, runtimeContext: h.tracked.requesterSessionRuntimeContext,
    hostHomeServerIdentityId: home, sessionCustodianAccountId: custodian, isCurrent: h.f.isHomeCurrent, signal: h.signal,
  })).toMatchObject({ kind: 'isolated', separationRequired: false });
  const invocationId = `ui-codex-native-${actor}`;
  const services = await prepareRunnerDaemonPluginServices({ invocationId, signal: h.signal,
    local: createUnavailablePluginServices(), dispatch: async operation => {
      const response = await h.dispatch(operation);
      if (!response.ok) throw Object.assign(new Error(response.error.code), { code: response.error.code });
      if (response.result.kind !== 'plugin_services.result_v1') throw new Error('Missing real native service result');
      return decodeRunnerDaemonPluginServiceWireValueV1(response.result.value);
    } });
  const before = h.nativeEffects();
  const admission = authorizeResolvedAgentNativeExecLaunchForHost(services.exec,
    // The provider executable is the OS boundary. Spend the actual finalized
    // tuple on a child so an authorization-only result cannot close this path.
    { command: process.execPath, args: ['-e', 'process.stdout.write("public-owner-native-ready")'], cwd: h.cwd, env: {} }, h.signal,
    issueAgentNativeLaunchQualifierForHost(services.exec));
  if (actor === 'owner') {
    const launch = await admission;
    const child = spawnAuthorizedHostExecLaunchForHost(launch, { signal: h.signal });
    try {
      const result = await child.handle.wait();
      expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
      expect(new TextDecoder().decode(result.stdout)).toBe('public-owner-native-ready');
    } finally {
      await child.dispose();
      await child.waitForSettlement();
    }
  } else await expect(admission).rejects.toMatchObject({ data: { code: 'agent_isolation_unavailable' } });
  expect(h.nativeEffects()).toBe(before);
  expect(h.tracked.requesterSessionRuntimeContext).toBeUndefined();
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase(invocationId) });
}, 120_000);

it.each(['member', 'retained member', 'incomplete retained birth', 'foreign retained Home', 'missing Home', 'withdrawn'] as const)('enforces requester admission for grant-based PluginExec (%s)', async source => {
  const home = 'srv_plugin_exec_owner';
  let current = true;
  const retained = source === 'retained member' || source === 'incomplete retained birth' || source === 'foreign retained Home';
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, pluginExecAgent, undefined, {
    // The installed daemon Account is the physical custodian, not the incoming
    // Session actor. Retained requester credentials remain the distinct member.
    externalActionAccountId: source === 'retained member' ? 'company' : 'requester',
    ...(source === 'retained member' ? { credentials: {
      token: `e30.${Buffer.from(JSON.stringify({ sub: 'company' })).toString('base64url')}.signature`, encryption: null,
    } } : {}),
    homeServerIdentityId: source === 'foreign retained Home' ? 'srv_foreign' : home, ordinaryAccountSession: !retained,
    ...(source === 'incomplete retained birth' ? { retainIncompleteRequesterCustody: true } : {}),
    ...(source === 'member' || source === 'retained member' ? { machineAccess: { custodianAccountId: 'company', role: 'manage' } } : {}),
    resolveCurrentMachineExecutionOriginContext: async () => current && source !== 'missing Home' ? { serverIdentityId: home, machineId: 'machine' } : null,
    agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
  });
  if (retained) delete h.tracked.requesterSessionRuntimeContext;
  const services = await prepareRunnerDaemonPluginServices({ invocationId: 'plugin-exec-refused', signal: h.signal,
    local: createUnavailablePluginServices(), dispatch: async operation => {
      const response = await h.dispatch(operation);
      if (!response.ok) throw Object.assign(new Error(response.error.code), { code: response.error.code });
      if (response.result.kind !== 'plugin_services.result_v1') throw new Error('Missing registered PluginExec response');
      return decodeRunnerDaemonPluginServiceWireValueV1(response.result.value);
    } });
  const resolved = await services.exec.systemTools.resolve({ toolId: 'native-cli', purpose: 'Retain the original native tool', cwd: h.cwd });
  const readChildStarts = observeGrantChildren(h.cwd);
  if (source === 'withdrawn') {
    const result = await services.exec.run({ executable: resolved.executable, args: ['--version'], cwd: h.cwd }, {
      nativeLaunch: issueAgentNativeLaunchQualifierForHost(services.exec),
    });
    expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
    expect(readChildStarts()).toBe(1);
    current = false;
  }
  const effects = h.nativeEffects();
  const childStartsBeforeRefusal = source === 'withdrawn' ? 1 : 0;
  expect(readChildStarts()).toBe(childStartsBeforeRefusal);
  for (const native of [false, true]) {
    if (source === 'retained member') {
      // OWNER-RULINGS 2026-11-02, Guest execution fallback: this admitted
      // guest runs as the owner's OS user while provisioning is off.
      const start = vi.mocked(observedSpawn).mock.calls.length;
      const result = await services.exec.run({ executable: resolved.executable, args: ['--version'], cwd: h.cwd }, native
        ? { nativeLaunch: issueAgentNativeLaunchQualifierForHost(services.exec) } : undefined);
      expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
      expect(new TextDecoder().decode(result.stdout)).toMatch(/^git version /);
      expect(readChildStarts()).toBe(native ? 2 : 1);
      const nativeSpawn = vi.mocked(observedSpawn).mock.calls.slice(start).find(([, args, options]) =>
        args?.includes('--version') && options?.cwd === h.cwd);
      expect(nativeSpawn).toBeDefined();
      expect(nativeSpawn?.[2]?.uid).toBeUndefined();
      expect(nativeSpawn?.[2]?.gid).toBeUndefined();
      continue;
    }
    await expect(services.exec.run({ executable: resolved.executable, args: ['--version'], cwd: h.cwd }, native
      ? { nativeLaunch: issueAgentNativeLaunchQualifierForHost(services.exec) } : undefined))
      .rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    expect(readChildStarts()).toBe(childStartsBeforeRefusal);
  }
  expect(h.nativeEffects()).toBe(effects);
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase('plugin-exec-refused') });
}, 120_000);

it('retains the canonical Project refusal cause through registered PluginExec and the strict runner HTTP consumer', async () => {
  const home = 'srv_plugin_exec_owner';
  const startupAgent = createFirstConversationAgentFixture('UNADMITTED_STARTUP_INPUT', { nativeStartupExec: true });
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, startupAgent, undefined, {
    externalActionAccountId: 'requester', homeServerIdentityId: home, ordinaryAccountSession: true,
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
    agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
  });
  // Process census and HTTP are genuine boundaries. All private authority-file,
  // response parsing, requester qualification and Project preparation remain real.
  const command = `${process.execPath} ${join(h.f.directory, '.runner-snapshots', 'fixture-runner', 'index.mjs')}`;
  h.runner.snapshotIdentity = 'snapshot:fixture-runner';
  h.runner.processCommandHash = hashProcessCommand(command);
  h.tracked.processCommandHash = h.runner.processCommandHash;
  vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue({ pid: process.pid,
    processStartTimeMs: h.runner.processStartTimeMs, command });
  const path = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing });
  const authority = { path, happyHomeDir: h.f.directory, publicReleaseRing: configuration.publicReleaseRing,
    sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent };
  await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 43129 });
  let retireAtNativeAdmission = false;
  const homeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(String(url)).pathname !== AGENT_RUNTIME_DAEMON_SERVICES_PATH) return await homeFetch(url, init);
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
    expect(request.context.sessionId).toBe(h.sessionId);
    return Response.json(await h.dispatch(request.operation));
  });
  const services = await prepareRunnerDaemonPluginServices({ invocationId: 'plugin-exec-cause', signal: h.signal,
    local: createUnavailablePluginServices(), dispatch: operation => dispatchCurrentRunnerDaemonPluginService({
      authority, operation, signal: h.signal,
    }) });
  const resolved = await services.exec.systemTools.resolve({ toolId: 'native-cli', purpose: 'Retain original native grant', cwd: h.cwd });
  const readChildStarts = observeGrantChildren(h.cwd);
  const positive = await services.exec.run({ executable: resolved.executable, args: ['--version'], cwd: h.cwd });
  expect(positive.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
  expect(new TextDecoder().decode(positive.stdout)).toMatch(/^git version /);
  expect(readChildStarts()).toBe(1);
  const diagnostic = vi.spyOn(logger, 'warnLocalFile');
  // Feed the actual strict HTTP consumer exception through host lifecycle
  // publication, retained startup observation and the public CLI Action sink.
  // Keep prompt preparation available; retire the genuine runtime only when
  // the native startup launch reaches its HTTP admission boundary.
  retireAtNativeAdmission = true;
  // preparation_pending is a Session turn issue, not a native startup code.
  // The startup owner retains its generic exited-before-open result.
  await assertStartupFailureThroughCli({ preparationCode: null,
    settlementKind: 'returned', sessionId: h.sessionId, publishFailure: async persist => {
      const diagnosticsBeforeHostOpen = diagnostic.mock.calls.length;
      const runtime = await runInstalledFirstConversationRuntime({ fixture: h, homeServerIdentityId: home,
        persistTurnMutation: persist,
        beforeDaemonHttpRequest: async operation => {
          if (retireAtNativeAdmission && operation.kind === 'plugin_exec.launch.authorize_v1') {
            retireAtNativeAdmission = false;
            await h.machine.shutdown();
          }
        } });
      await Promise.race([runtime.failed.promise, runtime.outcome]);
      await runtime.stop();
      await runtime.outcome.catch(() => undefined);
      // The Session issue owner presents unavailable requester custody as a
      // recoverable preparation failure; the strict HTTP exception below still
      // retains the exact Project refusal and its closed dispatch cause.
      const issue = runtime.turns.flatMap(mutation => mutation.action === 'fail' ? [mutation.issue] : [])[0];
      expect(issue).toMatchObject({
        code: 'preparation_pending', source: 'dependency_failure',
      });
      expect(runtime.assistant).toHaveLength(1);
      expect(runtime.assistant[0]).toContain(issue!.sanitizedPreview);
      expect(diagnostic.mock.calls.slice(diagnosticsBeforeHostOpen).map(([message]) => String(message)))
        .toContain(JSON.stringify({ kind: 'plugin_exec_installed_account_refused',
          phase: 'installed_account_qualification', reason: 'finite_runtime_unavailable', sessionId: h.sessionId }));
      expect(readChildStarts()).toBe(1);
      // The conversation publishes its own runner authority. Exercise that
      // current authority while this fixture's HTTP and process boundaries live.
      const currentAuthority = { ...authority, path: h.tracked.agentRuntimeDaemonServiceAuthorityFilePath! };
      const currentServices = await prepareRunnerDaemonPluginServices({ invocationId: 'plugin-exec-cause-after-startup',
        signal: h.signal, local: createUnavailablePluginServices(),
        dispatch: operation => dispatchCurrentRunnerDaemonPluginService({ authority: currentAuthority, operation, signal: h.signal }) });
      const currentGrant = await currentServices.exec.systemTools.resolve({ toolId: 'native-cli',
        purpose: 'Retain original native refusal', cwd: h.cwd });
      const refusal = await currentServices.exec.run({ executable: currentGrant.executable, args: ['--version'], cwd: h.cwd }, {
        nativeLaunch: issueAgentNativeLaunchQualifierForHost(currentServices.exec),
      }).then(() => { throw new Error('Retired requester ingress unexpectedly executed a native process'); }, error => error);
      expect(refusal).toMatchObject({ code: 'project_requester_credentials_unavailable',
        details: { cause: { code: 'ingress_missing', stage: 'dispatch' } } });
      expect(readChildStarts()).toBe(1);
      expect(h.nativeEffects()).toBe(0);
      const qualification = diagnostic.mock.calls.map(([message]) => String(message))
        .filter(message => message.includes('plugin_exec_installed_account_refused'));
      expect(qualification).toEqual(Array.from({ length: 2 }, () => JSON.stringify({ kind: 'plugin_exec_installed_account_refused',
        phase: 'installed_account_qualification', reason: 'finite_runtime_unavailable', sessionId: h.sessionId })));
      expect(qualification.join('')).not.toContain(h.f.directory);
      expect(qualification.join('').includes(h.installedCredentials!.token)).toBe(false);
    } });
  expect(retireAtNativeAdmission).toBe(false);
}, 120_000);

it.each(['retained', 'associated retained', 'current', 'associated current', 'released .17', 'associated .17 owner rows', 'current custom ACP'] as const)('recovers qualified owner custody before native Session Exec and SCM with isolation disabled (%s)', async generation => {
  const home = 'srv_native_owner';
  const ordinaryAccountSession = generation !== 'retained' && generation !== 'associated retained';
  const associated = generation.startsWith('associated ');
  const legacyOwnerRows = generation === 'released .17' || generation === 'associated .17 owner rows';
  const selectedSecret = associated && ordinaryAccountSession;
  const secretValue = 'synthetic-project-owner-value';
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, !associated, undefined, undefined, {
    externalActionAccountId: 'requester', homeServerIdentityId: home, ordinaryAccountSession,
    ...(selectedSecret ? { accountSettings: { secrets: [{ id: 'project-owner-secret', name: 'Project owner secret', kind: 'token', updatedAt: 1,
      encryptedValue: { _isSecretValue: true, value: secretValue } }] } } : {}),
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
    agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
  });
  if (generation === 'released .17') {
    const post = vi.mocked(axios.post).getMockImplementation()!;
    vi.mocked(axios.post).mockImplementation(async (...args) => new URL(String(args[0])).pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
      ? { status: 404, data: { statusCode: 404, error: 'Not Found', message: 'Route not found' } } : await post(...args));
  }
  if (ordinaryAccountSession) {
    const get = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (...args) => {
      const response = await get(...args);
      const path = new URL(String(args[0])).pathname;
      if (path === `/v2/sessions/${h.sessionId}` && !legacyOwnerRows) {
        return { ...response, data: { ...response.data, session: { ...response.data.session,
          effectiveAccess: SessionEffectiveAccessV1Schema.parse({ v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) }) } } };
      }
      if (path === '/v1/machines/machine' && legacyOwnerRows) {
        // Exact .17 machineSerialization.ts owner-only response generation.
        const row = response.data.machine;
        return { ...response, data: { machine: { id: row.id, metadata: row.metadata, metadataVersion: row.metadataVersion,
          daemonState: row.daemonState, daemonStateVersion: row.daemonStateVersion, dataEncryptionKey: null,
          installationId: row.installationId, installationPublicKey: h.f.installation.publicKey,
          contentPublicKeyFingerprint: null, replacedByMachineId: null, replacedAt: null, replacementReason: null,
          replacementSource: null, replacementActorUserId: null, seq: 1, active: true, activeAt: 1,
          revokedAt: null, createdAt: 1, updatedAt: 1 } } };
      }
      return response;
    });
  }
  if (selectedSecret) {
    const { prepareProjectAgentLaunch } = await import('@/workspaces/projectSetup/projectAgentLaunch');
    const { projectRuntimeAccountRowsInput } = await import('@/workspaces/projectAccountRows');
    const { bootstrapAccountSettingsContext } = await import('@/settings/accountSettings/bootstrapAccountSettingsContext');
    const { createSavedSecretMaterializerFromSnapshotV1 } = await import('@/settings/secrets/savedSecretCatalog');
    const bindings = { v: 1 as const, bindings: { PROJECT_TOKEN: { ref: 'project-owner-secret' } } };
    h.tracked.runnerAgentInvocationContext = { ...h.tracked.runnerAgentInvocationContext!, secretReferenceOverlay: bindings };
    await writeFile(join(h.cwd, '.happier/project.json'), JSON.stringify({ version: 1,
      toolchain: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' },
      environmentVariables: [{ name: 'PROJECT_TOKEN', kind: 'secret', required: true }] }));
    const runtime = await h.machine.resolveProjectFiniteRuntime({ signal: h.signal });
    if (!runtime?.credentials) throw new Error('Missing original installed Account Project runtime');
    const snapshot = await bootstrapAccountSettingsContext({ credentials: runtime.credentials,
      mode: 'blocking', publication: 'invocation' });
    const prepared = await prepareProjectAgentLaunch({ cwd: h.cwd, machineId: runtime.machineId, serverId: runtime.serverId,
      serverHttpBaseUrl: runtime.serverHttpBaseUrl, account: projectRuntimeAccountRowsInput(runtime),
      nativeIo: runtime.nativeIo, successHomeDir: runtime.successHomeDir, signal: h.signal,
      environmentBindings: bindings, secretEnvironment: { accountSettings: snapshot.rawSettings ?? snapshot.settings,
        savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(snapshot, { isCurrent: () => !h.signal.aborted }),
        settingsSecretsReadKeys: snapshot.settingsSecretsReadKeys } });
    if (prepared.kind !== 'prepared') throw new Error(`Missing exact selected-secret Project review: ${prepared.kind === 'refused' ? prepared.code : prepared.kind}`);
    expect(await createProjectSetupTrustClient({ credentials: runtime.credentials, serverHttpBaseUrl: runtime.serverHttpBaseUrl })
      .approveReviewedEffect({ project: prepared.outcome.plan.project, expectedRevision: 1, authority: 'present_user',
        reviewedEffectDigest: prepared.outcome.plan.reviewedEffectDigest,
        currentEffectDigest: prepared.outcome.plan.reviewedEffectDigest, approvedAtMs: 2 })).toMatchObject({ status: 'updated' });
  }
  // Resume may retire the in-memory context, but not its original private Home.
  delete h.tracked.requesterSessionRuntimeContext;
  expect(await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase('owner-native') })).toMatchObject({ ok: true });
  const scm = await h.dispatch({ kind: 'host_scm.run_v1', ...h.operationBase('owner-native'),
    command: { bin: 'git', args: ['--version'], cwd: h.cwd } });
  expect(scm, JSON.stringify(scm)).toMatchObject({ ok: true });
  if (!scm.ok || scm.result.kind !== 'plugin_services.result_v1') throw new Error('Missing SCM response');
  expect(decodeRunnerDaemonPluginServiceWireValueV1(scm.result.value)).toMatchObject({ success: true, exitCode: 0,
    stdout: expect.stringMatching(/^git version /) });
  const unavailable = createUnavailablePluginServices();
  let authorizedWire: unknown;
  const services = await prepareRunnerDaemonPluginServices({ invocationId: 'owner-native-exec', signal: h.signal, local: unavailable,
    dispatch: async operation => {
      const response = await h.dispatch(operation);
      if (!response.ok) throw new Error(response.error.code);
      if (response.result.kind !== 'plugin_services.result_v1') throw new Error('Missing native service response');
      const value = decodeRunnerDaemonPluginServiceWireValueV1(response.result.value);
      if (operation.kind === 'plugin_exec.resolved_agent_launch.authorize_v1') authorizedWire = value;
      return value;
    } });
  if (generation === 'current custom ACP') {
    const { writeAcpTestAgentScript } = await import('@/agent/acp/testkit/subprocessHarness');
    const { createPublicAcpRuntimeProtocols } = await import('@/agent/acp/runtime/publicSession/createPublicAcpRuntimeProtocols');
    const { resolveAccountConfiguredAcpLaunch } = await import('@/agent/runtime/registry/engineRegistry/accountConfiguredAcp');
    const { bootstrapAccountSettingsContext } = await import('@/settings/accountSettings/bootstrapAccountSettingsContext');
    const { createInvocationSavedSecretOperationContextV1 } = await import('@/settings/secrets/savedSecretOperationContext');
    const { AcpCatalogRecordV1Schema } = await import('@happier-dev/protocol/acp/catalog/catalogRowsV1');
    const { issueAgentNativeLaunchQualifierForHost } = await import('@/plugins/runtime/invocation/services/exec');
    const credentials = await readStoredCredentialsForServerId('session-home');
    if (!credentials) throw new Error('Missing original owner Account');
    const snapshot = await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', publication: 'invocation' });
    const operation = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
      serverHttpBaseUrl: 'https://session-home.test', isCurrent: async () =>
        (await readStoredCredentialsForServerId('session-home'))?.token === credentials.token });
    // ACP is the process boundary, not a replacement runtime or native finalizer.
    const script = writeAcpTestAgentScript({ dir: h.cwd, fileName: 'owner-acp.mjs', source: `
      import { createInterface } from 'node:readline';
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line); if (request.id === undefined) continue;
        const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} }
          : request.method === 'session/new' ? { sessionId: 'owner-acp-session' } : {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
      }
    ` });
    const catalog = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{ id: 'owner-acp', name: 'owner-acp', title: 'Owner ACP',
      launch: { kind: 'command', command: process.execPath, args: [script] }, env: {}, createdAt: 1, updatedAt: 1 }] });
    expect(await operation.commitAcpCatalog({ catalog: { status: 'ready', record: catalog, revision: 1 } })).toBe(true);
    const configured = await resolveAccountConfiguredAcpLaunch('owner-acp', operation);
    const protocols = createPublicAcpRuntimeProtocols({ pluginId: h.retainedAgent.pluginId, agentId: h.retainedAgent.agentId,
      signal: h.signal, isCurrent: () => !h.signal.aborted, services,
      nativeLaunch: issueAgentNativeLaunchQualifierForHost(services.exec),
      resolveHostLaunch: configured.resolveHostLaunch, runtimeDefinition: configured.runtimeDefinition });
    const runtime = await protocols.acp.open({ kind: 'create', sessionId: h.sessionId, cwd: h.cwd }, {
      definition: configured.runtimeDefinition,
      transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'unused-host-resolved-launch' } },
    });
    await runtime.dispose();
    await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase('owner-native-exec') });
    await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase('owner-native') });
    return;
  }
  const nativeEffects = h.nativeEffects();
  const launch = await authorizeResolvedAgentNativeExecLaunchForHost(services.exec, { command: process.execPath,
    args: ['-e', selectedSecret
      // The Agent echoes its Project secret, as `env` or a tool result would.
      ? `process.stdout.write(process.env.NATIVE==="active"&&process.env.PROJECT_TOKEN===${JSON.stringify(secretValue)}?"native-owner-ready "+process.env.PROJECT_TOKEN:"missing-owner-environment")`
      : associated ? 'process.stdout.write(process.env.NATIVE==="active"?"native-owner-ready":"missing-native")'
      : 'process.stdout.write("native-owner-ready")'], cwd: h.cwd, env: { PATH: process.env.PATH ?? '' } });
  const child = spawnAuthorizedHostExecLaunchForHost(launch, { signal: h.signal });
  try {
    const result = await child.handle.wait();
    expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toBe(selectedSecret ? `native-owner-ready ${secretValue}` : 'native-owner-ready');
    if (selectedSecret) {
      // The runner's transcript writer stores the echo while the launch is live.
      const stored = JSON.stringify(buildOutboundSessionMessagePayload({ mode: 'plain', ctx: null },
        { type: 'tool-result', output: `${stdout} control=project-visible-control` }));
      expect(stored).not.toContain(secretValue);
      expect(stored).toContain('native-owner-ready');
      expect(stored).toContain('project-visible-control');
      // The daemon materializes the value; the runner spawns the Agent and writes its
      // transcript in another process, so the values cross the daemon wire with the launch.
      expect(authorizedWire).toMatchObject({ secretValues: [secretValue] });
    }
    if (associated) expect(h.nativeEffects()).toBeGreaterThan(nativeEffects);
  } finally {
    await child.dispose();
    await child.waitForSettlement();
  }
  if (selectedSecret) {
    // Output written after the Agent settled (a Run's final result) is still redacted; the
    // invocation's close releases the registration.
    expect(JSON.stringify(buildOutboundSessionMessagePayload({ mode: 'plain', ctx: null }, secretValue))).not.toContain(secretValue);
  }
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase('owner-native-exec') });
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase('owner-native') });
}, 120_000);

it.each(['member', 'member without isolation port', 'shared edit', 'shared view', 'missing Home', 'missing Home without isolation port', 'foreign historical attribution', 'malformed custody',
  'missing retained Home', 'foreign retained Home'] as const)('refuses native Session Exec and SCM before effects for %s', async failure => {
  const home = 'srv_native_owner';
  const retained = failure === 'missing retained Home' || failure === 'foreign retained Home';
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    externalActionAccountId: 'requester', ordinaryAccountSession: !retained,
    homeServerIdentityId: failure === 'foreign retained Home' ? 'srv_foreign' : home,
    ...(failure.startsWith('member') ? { machineAccess: { custodianAccountId: 'another-account', role: 'manage' } } : {}),
    resolveCurrentMachineExecutionOriginContext: async () => failure.startsWith('missing Home') ? null : ({ serverIdentityId: home, machineId: 'machine' }),
    ...(failure.endsWith('without isolation port') ? {} : {
      agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) } }),
  });
  if (failure === 'missing retained Home') {
    // Admit a genuine private Session first, then retire its in-memory owner
    // and retain the exact same source through the canonical legacy writer.
    // Recovery must reject its missing birth Home at the real dispatcher.
    const binding = { happyHomeDir: h.f.directory, sessionId: h.sessionId, attribution: h.f.bootstrap.attribution };
    await h.requester.dispose();
    expect(await retireRequesterSessionCredentialCustody(binding)).toBe(true);
    const historical = await createRequesterSessionCredentialCustody({ ...binding, credentials: h.f.bootstrap.credentials });
    onTestFinished(historical.cleanup);
  }
  if (failure === 'foreign historical attribution') h.tracked.requesterWorkAttributionV1 = {
    ...h.f.bootstrap.attribution, accountId: 'historical-requester',
  };
  if (failure === 'malformed custody') await writePrivateOwnerFile({ path: requesterSessionCredentialPath({
    happyHomeDir: h.f.directory, sessionId: h.sessionId, attribution: h.f.bootstrap.attribution }), contents: '{}' });
  if (failure === 'shared edit' || failure === 'shared view') {
    const get = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (...args) => {
      const response = await get(...args);
      if (new URL(String(args[0])).pathname !== `/v2/sessions/${h.sessionId}`) return response;
      const accessLevel = failure === 'shared edit' ? 'edit' : 'view';
      return { ...response, data: { ...response.data, session: { ...response.data.session,
        share: { accessLevel, canApprovePermissions: false }, effectiveAccess: SessionEffectiveAccessV1Schema.parse({ v: 1, level: accessLevel,
          sources: [{ kind: 'direct', shareId: 'foreign-session-grant' }],
          capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [{ accessLevel, canApprovePermissions: false }] }) }) } } };
    });
  }
  expect(await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase('native-refused') })).toMatchObject({ ok: true });
  const effects = h.nativeEffects();
  const readChildStarts = observeGrantChildren(h.cwd);
  // A foreign historical requester is rejected by the incumbent Account
  // custody guard before the isolation owner can authorize either operation.
  const expectedError = failure === 'foreign historical attribution'
    ? { code: 'runner_plugin_services_unavailable', cause: { code: 'runner_plugin_services_unavailable', stage: 'dispatch' } }
    : { code: 'agent_isolation_unavailable' };
  for (const operation of [
    { kind: 'host_scm.run_v1' as const, ...h.operationBase('native-refused'), command: { bin: 'git', args: ['--version'], cwd: h.cwd } },
    { kind: 'plugin_exec.resolved_agent_launch.authorize_v1' as const, ...h.operationBase('native-refused'), agentLaunchKind: 'exec' as const,
      launch: { command: process.execPath, args: ['-e', 'process.stdout.write("must-not-run")'], cwd: h.cwd, env: {} } },
  ]) {
    expect(await h.dispatch(operation)).toMatchObject({ ok: false, error: expectedError });
    expect(h.nativeEffects()).toBe(effects);
    expect(readChildStarts()).toBe(0);
  }
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase('native-refused') });
}, 120_000);

it.each(['credentials', 'installation'] as const)('withdraws the qualified ordinary native source after %s changes without another Home qualifier', async changed => {
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    externalActionAccountId: 'requester', ordinaryAccountSession: true,
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_native_owner', machineId: 'machine' }),
    agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
  });
  const get = vi.mocked(axios.get).getMockImplementation()!;
  const reads = { machine: 0, session: 0 };
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path === '/v1/machines/machine') reads.machine++;
    if (path === `/v2/sessions/${h.sessionId}`) reads.session++;
    return await get(...args);
  });
  expect(await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase('withdrawn-native') })).toMatchObject({ ok: true });
  const run = () => h.dispatch({ kind: 'host_scm.run_v1', ...h.operationBase('withdrawn-native'),
    command: { bin: 'git', args: ['--version'], cwd: h.cwd } });
  expect(await run()).toMatchObject({ ok: true });
  expect(await run()).toMatchObject({ ok: true });
  expect(reads).toEqual({ machine: 1, session: 1 });
  if (changed === 'credentials') {
    const serverId = h.f.bootstrap.attribution.serverId;
    await writeStoredCredentialsForServerId(serverId, terminalSignIn('requester', 1));
    expect(await run()).toMatchObject({ ok: true });

    await writeStoredCredentialsForServerId(serverId, terminalSignIn('other-account'));
    const next = h.operationBase('next-native');
    expect(await h.dispatch({ kind: 'plugin_services.prepare_v1', ...next })).toMatchObject({ ok: true });
    expect(await h.dispatch({ kind: 'host_scm.run_v1', ...next,
      command: { bin: 'git', args: ['--version'], cwd: h.cwd } })).toMatchObject({ ok: false, error: { code: 'agent_isolation_unavailable' } });
    await h.dispatch({ kind: 'plugin_services.close_v1', ...next });
  } else {
    expect(configuration.installationIdentityFile.startsWith(h.f.directory)).toBe(true);
    const replacementPath = join(h.f.directory, 'replacement-installation.json');
    await readOrCreateInstallationIdentity(replacementPath);
    await copyFile(replacementPath, configuration.installationIdentityFile);
    expect(await run()).toMatchObject({ ok: false, error: { code: 'agent_isolation_unavailable' } });
    expect(await h.dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', ...h.operationBase('withdrawn-native'), agentLaunchKind: 'exec',
      launch: { command: process.execPath, args: [], cwd: h.cwd, env: {} } })).toMatchObject({ ok: false, error: { code: 'agent_isolation_unavailable' } });
  }
  expect(reads).toEqual({ machine: 1, session: 1 });
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase('withdrawn-native') });
}, 120_000);

it.each([
  { changed: 'credentials', associated: false }, { changed: 'installation', associated: false },
  { changed: 'credentials', associated: true }, { changed: 'installation', associated: true },
] as const)('completes an admitted launch when $changed changes during Project preflight (associated=$associated)', async ({ changed, associated }) => {
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, !associated, undefined, undefined, {
    externalActionAccountId: 'requester', ordinaryAccountSession: true,
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_native_owner', machineId: 'machine' }),
    agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
  });
  const post = vi.mocked(axios.post).getMockImplementation()!;
  let withdrawn = false;
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    if (!withdrawn && new URL(String(args[0])).pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) {
      withdrawn = true;
      if (changed === 'credentials') {
        await writeStoredCredentialsForServerId(h.f.bootstrap.attribution.serverId, terminalSignIn('requester', 1));
      } else {
        expect(configuration.installationIdentityFile.startsWith(h.f.directory)).toBe(true);
        const replacementPath = join(h.f.directory, 'replacement-installation.json');
        await readOrCreateInstallationIdentity(replacementPath);
        await copyFile(replacementPath, configuration.installationIdentityFile);
      }
    }
    return await post(...args);
  });
  expect(await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase('mid-preflight') })).toMatchObject({ ok: true });
  const result = await h.dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', ...h.operationBase('mid-preflight'), agentLaunchKind: 'exec',
    launch: { command: process.execPath, args: ['-e', 'process.stdout.write("must-not-run")'], cwd: h.cwd, env: {} } });
  expect(withdrawn).toBe(true);
  expect(result).toMatchObject({ ok: true });
  if (changed === 'installation') {
    // Exec admitted this launch before it entered Project preflight. A new
    // launch must still resolve identity against the withdrawn installation.
    const effects = h.nativeEffects();
    expect(await h.dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', ...h.operationBase('mid-preflight'), agentLaunchKind: 'exec',
      launch: { command: process.execPath, args: [], cwd: h.cwd, env: {} } })).toMatchObject({ ok: false, error: { code: 'agent_isolation_unavailable' } });
    expect(h.nativeEffects()).toBe(effects);
  }
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase('mid-preflight') });
}, 120_000);

it('finishes admitted Project native materialization and refuses the next launch after installation withdrawal during tool discovery', async () => {
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, false, undefined, undefined, {
    externalActionAccountId: 'requester', ordinaryAccountSession: true,
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_native_owner', machineId: 'machine' }),
    agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
  });
  const runtime = await h.machine.resolveProjectFiniteRuntime({ signal: h.signal });
  if (!runtime) throw new Error('Missing installed native IO boundary');
  const resolveTool = runtime.nativeIo.resolveTool.bind(runtime.nativeIo);
  let withdrawn = false;
  vi.spyOn(runtime.nativeIo, 'resolveTool').mockImplementation(async (...args) => {
    const selected = await resolveTool(...args);
    if (!withdrawn) {
      withdrawn = true;
      const replacementPath = join(h.f.directory, 'tool-discovery-replacement-installation.json');
      await readOrCreateInstallationIdentity(replacementPath);
      await copyFile(replacementPath, configuration.installationIdentityFile);
    }
    return selected;
  });
  expect(await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase('tool-discovery-withdrawal') })).toMatchObject({ ok: true });
  const outcome = await h.dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', ...h.operationBase('tool-discovery-withdrawal'), agentLaunchKind: 'exec',
    launch: { command: process.execPath, args: [], cwd: h.cwd, env: {} } });
  expect(withdrawn).toBe(true);
  expect(outcome).toMatchObject({ ok: true });
  const admittedEffects = h.nativeEffects();
  expect(await h.dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', ...h.operationBase('tool-discovery-withdrawal'), agentLaunchKind: 'exec',
    launch: { command: process.execPath, args: [], cwd: h.cwd, env: {} } })).toMatchObject({ ok: false, error: { code: 'agent_isolation_unavailable' } });
  expect(h.nativeEffects()).toBe(admittedEffects);
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase('tool-discovery-withdrawal') });
}, 120_000);

it.each(['preparation', 'mint', 'binding', 'requester_bootstrap'] as const)(
  'preserves issuer refusal phase through the real agent Session (%s)', async phase => {
  const home = 'srv_session_issuer_refusal';
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
  let originAvailable = true;
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    credentials, accountActionCredentials: credentials, externalActionAccountId: 'requester', homeServerIdentityId: home,
    resolveCurrentMachineExecutionOriginContext: async () => originAvailable
      ? { serverIdentityId: home, machineId: 'machine' } : null,
    agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
  });
  const homeWrite = vi.mocked(axios.post).getMockImplementation()!;
  const refusals = vi.spyOn(logger, 'warnLocalFile');
  let mintAttempted = false;
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path === bindExternalActionExecutionAuthorizationHttpPathV1('projects.list')) {
      mintAttempted = true;
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(args[1]);
      expect(request.sessionActionOrigin?.caller).toMatchObject({ kind: 'session', sessionId: h.sessionId });
      if (phase === 'mint') return { status: 401, data: { error: 'invalid_token' } };
      // The successful local mint is the Home admission; the issuer no longer
      // verifies that same proof again before projecting requester custody.
      if (phase === 'requester_bootstrap') await h.requester.bootstrap.dispose();
      return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'issuer-fixture-proof', binding: {
        accountId: phase === 'binding' ? 'foreign-account' : 'requester',
        authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: home,
        machineId: 'machine', custodianAccountId: 'requester', installationId: h.f.installation.installationId,
        actionId: 'projects.list', requestId: request.envelope.requestId, target: request.envelope.target,
        accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
      } }) };
    }
    return homeWrite(...args);
  });
  if (phase === 'preparation') originAvailable = false;
  const response = await h.dispatch({ kind: 'action.execute', surface: 'agent', actionId: 'projects.list',
    requestId: randomUUID(), input: {},
    witness: { turnId: 'issuer-turn', inputId: 'issuer-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
      agentStartCaller: { kind: 'session', sessionId: h.sessionId, starterDepth: 0, turnDepth: 0 }, callerPermissionMode: 'default' },
  });
  expect(mintAttempted).toBe(phase !== 'preparation');
  expect(response).toMatchObject({ ok: true, result: { kind: 'action.execution', outcome: {
    ok: false, errorCode: 'action_forbidden', details: { reason: 'external_authorization_refused',
      phase: `session.authorization.${phase}`, requiredFact: expect.any(String), remedy: expect.any(String) },
    failureCause: { phase: `session.authorization.${phase}` },
  } } });
  expect(h.nativeEffects()).toBe(0);
  const phaseEvents = refusals.mock.calls.filter(([message, value]) => message === '[external-action-phase]'
    && value && typeof value === 'object' && 'phase' in value && value.phase === `session.authorization.${phase}`);
  expect(phaseEvents).toHaveLength(1);
  expect(JSON.stringify(phaseEvents)).not.toContain('issuer-fixture-proof');
  expect(JSON.stringify(phaseEvents)).not.toContain(credentials.token);
}, 120_000);

it.each(['ordinary owner', 'retained requester', 'incomplete retained source'] as const)('projects Account Discovery through the installed Session Action producer (%s)', async shape => {
  const home = 'srv_discovery_owner';
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    credentials, accountActionCredentials: credentials,
    externalActionAccountId: 'requester', homeServerIdentityId: home,
    ordinaryAccountSession: shape !== 'retained requester',
    retainIncompleteRequesterCustody: shape === 'incomplete retained source',
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
    agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
  });
  const serverId = h.f.bootstrap.attribution.serverId;
  await writeDaemonSettingsFixture(h.f.directory, { activeServerId: serverId,
    servers: { [serverId]: { id: serverId, name: 'Discovery Home', serverUrl: 'https://session-home.test',
      webappUrl: 'https://session-home.test', createdAt: 0, updatedAt: 0, lastUsedAt: 0,
      homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: { v: 1, homeServerIdentityId: home,
        canonicalServerUrl: 'https://session-home.test', revision: 1,
        endpoints: [{ kind: 'https', url: 'https://session-home.test' }] },
    } }, machineIdByServerId: { [serverId]: 'machine' }, lastTokenSubByServerId: { [serverId]: 'requester' },
  });
  reloadConfiguration();
  if (shape !== 'retained requester') {
    // Real connected daemons have admitted their installed Machine Account
    // before Session Actions. This port owns that authenticated observation;
    // the fixture's separate retained requester must not stand in for it.
    const installed = await h.machine.resolveInstalledAccountObservationRuntime(h.signal);
    expect(installed?.accountId, 'The real installed Machine Account lifecycle must be admitted').toBe('requester');
    expect(await installed?.isCurrent()).toBe(true);
  }
  onTestFinished(installDaemonMachineAdmissionTransport({ serverId: h.f.bootstrap.attribution.serverId, transport: async () => {
    throw new Error('Project Discovery must not request protected Session input');
  } }));
  const fetchHome = globalThis.fetch;
  vi.stubGlobal('fetch', (url: Parameters<typeof fetch>[0], init?: RequestInit) => new URL(String(url)).pathname.startsWith('/v1/features')
    ? Promise.resolve(Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {
      serverIdentity: { serverIdentityId: home },
      encryption: { storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain' },
    } }))) : fetchHome(url, init));
  const homeRead = vi.mocked(axios.get).getMockImplementation()!;
  const homeWrite = vi.mocked(axios.post).getMockImplementation()!;
  const refusals = vi.spyOn(logger, 'warnLocalFile');
  const boundaryPaths: string[] = [];
  let accountBoundaryRefusal: string | undefined;
  let minted: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> | undefined;
  let projectLists = 0;
  let privateAccountReads = 0;
  const assertSignedAccountRead = (method: string, path: string, body: unknown, options?: AxiosRequestConfig) => {
    privateAccountReads += 1;
    if (!minted) throw new Error('Account Discovery read preceded the real Home mint');
    const headers = AxiosHeaders.from(options?.headers);
    if (headers.has('Authorization')) accountBoundaryRefusal = 'ambient_bearer';
    if (headers.get(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER) !== minted.token) accountBoundaryRefusal = 'wrong_root';
    expect(headers.has('Authorization'), 'Account Discovery must use its signed requester carrier').toBe(false);
    expect(headers.get(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)).toBe(minted.token);
    expect(verifyExternalActionMachineRequestV1({ authorizationToken: minted.token, effectActionId: 'projects.list',
      target: minted.binding.target, installationId: h.f.installation.installationId, requestId: minted.binding.requestId,
      method, path, ...(body === undefined ? {} : { body }), publicKey: h.f.installation.publicKey,
      signature: String(headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER) ?? ''),
    })).toBe(true);
  };
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    boundaryPaths.push(`GET ${path}`);
    if (path === AUTHORING_MEMORY_ROUTE_V1 || path === '/v1/machines') {
      assertSignedAccountRead('GET', path, undefined, args[1]);
      return { status: 200, data: path === AUTHORING_MEMORY_ROUTE_V1
        ? AuthoringMemoryListResponseV1Schema.parse({ rows: [] }) : [] };
    }
    return homeRead(...args);
  });
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    boundaryPaths.push(`POST ${path}`);
    if (path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1('projects.list')) return { status: 200, data: { ok: true } };
    if (path === bindExternalActionExecutionAuthorizationHttpPathV1('projects.list')) {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(args[1]);
      expect(request.sessionActionOrigin?.caller).toMatchObject({ kind: 'session', sessionId: h.sessionId });
      expect(request.sessionActionSource).toEqual({ machineId: 'machine', installationId: h.f.installation.installationId });
      minted = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'discovery-proof', binding: {
        accountId: 'requester', authentication: { kind: shape === 'retained requester' ? 'account' : 'terminal', tokenEpoch: 0 }, serverIdentityId: home,
        machineId: 'machine', custodianAccountId: 'requester', installationId: h.f.installation.installationId,
        actionId: 'projects.list', requestId: request.envelope.requestId, target: request.envelope.target,
        accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
      } });
      // Home mints the real wire root. Only the installed parent may add
      // Account ports from independently admitted original Session custody.
      return { status: 200, data: minted };
    }
    if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) {
      assertSignedAccountRead('POST', path, args[1], args[2]);
      expect(ProjectAccountRowListRequestV1Schema.parse(args[1])).toMatchObject({ serverId: home });
      projectLists += 1;
      const key = { kind: 'workspace-ref', serverId: home, id: 'discovery-workspace' } as const;
      return { status: 200, data: ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [
        { key, revision: 1, content: { t: 'plain', v: { key, value: { id: key.id, serverId: home, machineId: 'machine',
          rootPath: h.cwd, projectKey: 'discovery-project', createdAtMs: 1 } } } },
      ] }) };
    }
    return homeWrite(...args);
  });
  const response = await h.dispatch({ kind: 'action.execute', surface: 'agent', actionId: 'projects.list',
    requestId: h.operationBase().requestId, input: {},
    witness: { turnId: 'discovery-turn', inputId: 'discovery-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
      agentStartCaller: { kind: 'session', sessionId: h.sessionId, starterDepth: 0, turnDepth: 0 }, callerPermissionMode: 'default' },
  });
  if (!response.ok) throw new Error(`Installed Discovery transport refused: ${response.error.code}`);
  if (response.result.kind !== 'action.execution') throw new Error(`Unexpected installed Discovery response: ${response.result.kind}`);
  const outcome = response.result.outcome;
  if (!outcome.ok && shape !== 'incomplete retained source') {
    const details = outcome.details && typeof outcome.details === 'object' ? outcome.details : undefined;
    const reason = details && 'reason' in details && typeof details.reason === 'string' ? details.reason : undefined;
    const cause = details && 'cause' in details && typeof details.cause === 'string' ? details.cause : undefined;
    const phases = refusals.mock.calls.filter(([message]) => message === '[Session Account Action] Refused'
      || message === '[external-action-phase]')
      .map(([, value]) => value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
        .filter(([key]) => ['reason', 'refusalPhase', 'refusalReason', 'refusalCode', 'errorCode',
          'phase', 'refusalBranch', 'errorClass'].includes(key))) : null);
    const messageCode = ['fixed_action_server_target_incomplete', 'account_role_overrides_unavailable', 'scope-retired',
      'account_settings_content_unavailable', 'action_not_supported_in_cli', 'project_requester_authority_unavailable',
      'requester_account_context_retired', 'requester_account_context_unavailable', 'server_scope_mismatch',
      'Requester Machine inventory authority is unavailable', 'Requester Machine inventory authority retired',
      'Account authoring memory is unavailable'].find(code => outcome.error === code)
      ?? (outcome.error === new MachineAdmissionTransportUnavailableError().message ? 'machine_admission_transport_unavailable' : 'unclassified');
    throw new Error(`Installed Discovery refused: ${outcome.errorCode}; messageCode=${messageCode}; reason=${reason}; cause=${cause}; minted=${Boolean(minted)}; projectLists=${projectLists}; accountReads=${privateAccountReads}; boundary=${accountBoundaryRefusal}; phases=${JSON.stringify(phases)}; paths=${JSON.stringify([...new Set(boundaryPaths)])}`);
  }
  if (shape === 'incomplete retained source') {
    expect(response).toMatchObject({ ok: true, result: { kind: 'action.execution', outcome: { ok: false } } });
    expect(privateAccountReads, 'An incomplete private source must disclose no Account or Project bytes').toBe(0);
    expect(projectLists).toBe(0);
    expect(h.nativeEffects()).toBe(0);
    return;
  }
  expect(Boolean(minted), 'The installed Session parent must mint the original Action root').toBe(true);
  expect(response).toMatchObject({ ok: true, result: { kind: 'action.execution', outcome: { ok: true,
    result: { items: [{ projectKey: { serverId: home, id: 'discovery-workspace' },
      project: { serverId: home, projectKey: 'discovery-project' }, machineId: 'machine', rootPath: h.cwd }] },
  } } });
  expect(projectLists).toBe(1);
  expect(h.nativeEffects()).toBe(0);
}, 120_000);

it('reports the same Project setup readiness through Account, agent and MCP ingress', async () => {
  const loopbackFetch = globalThis.fetch;
  const diagnostic = vi.spyOn(logger, 'debug');
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, false, undefined, undefined, {
    processEnv: process.env,
    externalActionAccountId: 'requester',
    credentials, accountActionCredentials: credentials,
    resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_readiness', machineId: 'machine' }),
  });
  expect(h.daemon.externalActionIngressOwner).toBeDefined();
  await writeFile(join(h.cwd, '.happier/project.json'), JSON.stringify({ version: 1 }));
  const trustWrites = h.trustWrites();
  const workspace = { serverId: 'session-home', machineId: 'machine', workspaceId: 'workspace', rootPath: h.cwd };
  const accountInspection = h.machine.createProjectDefinitionAction('session-home', { signal: h.signal,
    machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: 'machine',
      installationId: h.f.installation.installationId, role: 'use', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: h.requester.isCurrent });
  const account = ProjectDefinitionInspectOutputSchema.parse(await accountInspection({ actionId: 'projects.inspect',
    input: { workspace }, context: { serverId: 'session-home' } }));
  expect(account.setupReadiness, JSON.stringify({ readiness: account.setupReadiness,
    runtimeRefusals: diagnostic.mock.calls.filter(([message]) => String(message).includes('Runtime resolution refused')),
  })).toMatchObject({ kind: 'notRequired' });
  const homeWrite = vi.mocked(axios.post).getMockImplementation()!;
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1('projects.inspect')) {
      return { status: 200, data: { ok: true } };
    }
    if (path === bindExternalActionExecutionAuthorizationHttpPathV1('projects.inspect')) {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(args[1]);
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'readiness-proof', binding: {
        accountId: 'requester', authentication: { kind: request.sessionActionOrigin ? 'account' : 'terminal', tokenEpoch: 0 }, serverIdentityId: 'srv_readiness',
        machineId: 'machine', custodianAccountId: 'requester', installationId: h.f.installation.installationId,
        admittedMachineRole: 'manage',
        actionId: 'projects.inspect', requestId: request.envelope.requestId, target: request.envelope.target,
        accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
      } });
      return { status: 200, data: authorization };
    }
    if (path === '/v1/actions/projects.inspect') {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(args[1]);
      if (request.envelope.v !== 1) throw new Error('Expected plain Account request');
      return { status: 200, data: { v: 1, actionId: 'projects.inspect', requestId: request.envelope.requestId,
        execution: { ok: true, result: await accountInspection({ actionId: 'projects.inspect',
          input: request.envelope.input, context: { serverId: 'session-home' } }) } } };
    }
    return homeWrite(...args);
  });
  const handlers = new Map<string, (input: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
  registerProjectDefinitionHandlers({ machineId: 'machine',
    rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
    actionExecutor: h.daemon.externalActionIngressOwner!.executor });
  const inspectRpc = handlers.get('daemon.projects.inspect.v1');
  if (!inspectRpc) throw new Error('Missing installed Project inspection RPC');
  const machineAdmission = SocketRpcMachineAdmissionContextV1Schema.parse({
    actorAccountId: h.f.bootstrap.attribution.accountId, custodianAccountId: 'requester',
    machineId: h.f.bootstrap.attribution.machineId, installationId: h.f.installation.installationId,
    role: 'use', encryptionMode: h.machine.getMachineEncryptionMode(),
  });
  for (const surface of ['agent', 'mcp'] as const) {
    const response = await h.dispatch({ kind: 'action.execute', surface, actionId: 'projects.inspect',
      requestId: h.operationBase().requestId, input: { workspace },
      witness: { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
        agentStartCaller: { kind: 'session', sessionId: h.sessionId, starterDepth: 0, turnDepth: 0 }, callerPermissionMode: 'default' },
    });
    expect(response, JSON.stringify(response)).toMatchObject({ ok: true, result: { kind: 'action.execution', outcome: { ok: true } } });
    if (!response.ok || response.result.kind !== 'action.execution' || !response.result.outcome.ok) throw new Error('Missing Project inspection');
    const inspection = ProjectDefinitionInspectOutputSchema.parse(response.result.outcome.result);
    expect(inspection.setupReadiness).toEqual(account.setupReadiness);
  }
  const admission = { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
    agentStartCaller: { kind: 'session' as const, sessionId: h.sessionId, starterDepth: 0, turnDepth: 0 },
    causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const } };
  if (!('locator' in h.retainedAgent)) throw new Error('Expected the authored native Agent fixture');
  const bridge = await createSessionDaemonAuthorityFixture({ sessionId: h.sessionId, retainedAgent: h.retainedAgent,
    execute: async operation => {
      const response = await h.dispatch(operation);
      if (!response.ok || response.result.kind !== 'action.execution') throw new Error('Missing daemon Action outcome');
      return response.result.outcome;
    } });
  // The Home fixture replaces fetch; keep its external responses while letting
  // the real capability-bound loopback transport reach the TCP test listener.
  const homeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new URL(String(url)).pathname === AGENT_RUNTIME_DAEMON_SERVICES_PATH
      ? loopbackFetch(url, init) : homeFetch(url, init));
  const mcpClient: Parameters<typeof createHappierMcpServer>[0] = { sessionId: h.sessionId,
    getServerBinding: () => ({ serverId: 'session-home', serverUrl: 'https://session-home.test' }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: h.sessionId, encryptionMode: 'plain' }), updateMetadata() {},
    getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0, getPermissionMode: () => 'default',
    getActiveTurnAdmissionWitness: () => admission,
    getActiveTurnPermissionWitness: () => ({ turnId: admission.turnId, causalPermissionAuthority: admission.causalPermissionAuthority }),
    getCurrentSessionLocation: () => ({ machineId: 'machine', path: h.cwd }),
    getMetadataSnapshot: () => createTestMetadata({ machineId: 'machine', path: h.cwd }),
    getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated',
      features: FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_readiness' } } }) }),
  };
  const mcp = createHappierMcpServer(mcpClient,
    { authorityScope: 'session', sessionCredentials: { token: 'session-transport', encryption: null } });
  const credentialedMcp = createHappierMcpServer(mcpClient, { credentials });
  const homeRead = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path === '/v1/machines' || path === '/v1/machines/machine') {
      const response = await homeRead('https://session-home.test/v1/machines/machine');
      const machine = { ...response.data.machine, kind: 'persistent', active: true, storageMode: 'plain',
        installationPublicKey: encodeBase64(decodeBase64(h.f.installation.publicKey, 'base64url'), 'base64'),
        revokedAt: null, replacedByMachineId: null };
      return { status: 200, data: path === '/v1/machines' ? [machine] : { machine } };
    }
    return homeRead(...args);
  });
  try {
    expect(mcp.toolNames).toEqual(expect.arrayContaining(['action_spec_get', 'action_execute']));
    // Project Actions deliberately use the offered generic Action tool rather
    // than a direct tool by default. Keep that actual Session ingress composed.
    const response = await mcp.executeTool({ toolName: 'action_execute', args: { actionId: 'projects.inspect', input: { workspace } } });
    expect(response, JSON.stringify(response)).toMatchObject({ ok: true, result: { setupReadiness: account.setupReadiness } });
    if (!response.ok) throw new Error('Missing MCP Project inspection');
    expect(ProjectDefinitionInspectOutputSchema.parse(response.result).setupReadiness).toEqual(account.setupReadiness);
    const credentialed = await credentialedMcp.executeTool({ toolName: 'action_execute',
      args: { actionId: 'projects.inspect', input: { workspace } } });
    expect(credentialed, JSON.stringify(credentialed)).toMatchObject({ ok: true,
      result: { setupReadiness: account.setupReadiness } });
    if (!credentialed.ok) throw new Error('Missing credentialed Session MCP Project inspection');
    expect(ProjectDefinitionInspectOutputSchema.parse(credentialed.result).setupReadiness).toEqual(account.setupReadiness);
  } finally { await mcp.mcp.close(); await credentialedMcp.mcp.close(); await bridge.close(); }
  // Compose the real signed-root route with startup's executor too: the older
  // action_execute bridge reaches this path instead of the Session dispatcher.
  const { createDaemonControlApp } = await vi.importActual<typeof import('@/daemon/controlServer')>('@/daemon/controlServer');
  if (!boundary.control) throw new Error('Missing installed control owner');
  const app = createDaemonControlApp(boundary.control);
  try {
    const response = await app.inject({ method: 'POST', url: '/actions/root/execute',
      headers: { 'x-happier-daemon-token': boundary.control.controlToken },
      payload: { actionId: 'projects.inspect', surface: 'mcp', actionRequestId: 'root-readiness', input: { workspace } } });
    expect(response.statusCode).toBe(200);
    expect(response.json(), JSON.stringify(response.json())).toMatchObject({ ok: true, result: { setupReadiness: account.setupReadiness } });
  } finally { await app.close(); }
  // Home admission never grants a foreign Account the custodian's private
  // inputs, and a missing or retired Machine witness cannot prove readiness.
  const refusals = [];
  for (const [scenario, ingress] of [
    ['foreign', { machineAdmission: { ...machineAdmission, actorAccountId: 'foreign' }, verifyMachineAdmissionCurrent: h.requester.isCurrent }],
    ['missing', { machineAdmission }],
    ['retired', { machineAdmission, verifyMachineAdmissionCurrent: async () => false }],
  ] as const) {
    const response = await inspectRpc({ workspace }, {
      signal: h.signal, callerAuthority: 'account_automation', ...ingress,
    });
    if (scenario === 'missing') {
      refusals.push({ scenario, setupReadiness: ProjectDefinitionInspectOutputSchema.parse(response).setupReadiness });
    } else {
      const failure = ActionExecuteFailureSchema.parse(response);
      refusals.push({ scenario, ok: failure.ok, errorCode: failure.errorCode, failureCause: failure.failureCause });
    }
  }
  expect(refusals).toEqual([
    { scenario: 'foreign', ok: false, errorCode: 'agent_isolation_unavailable', failureCause: {
      phase: 'dispatch', errorClass: 'Error', errorCode: 'agent_isolation_unavailable', httpStatus: null } },
    { scenario: 'missing', setupReadiness: { kind: 'unknown', code: 'project_setup_requester_review_unavailable' } },
    { scenario: 'retired', ok: false, errorCode: 'machine_admission_changed', failureCause: undefined },
  ]);
  expect(h.nativeEffects()).toBe(0);
  expect(h.trustWrites()).toBe(trustWrites);
}, 120_000);

it.each([{ name: 'Claude', agentId: 'claude' }, { name: 'configured ACP', agentId: 'custom-acp' },
  { name: 'external plugin', agentId: undefined }] as const)('recovers fresh Session custody before native launch for $name and refuses a foreign requester', async ({ agentId }) => {
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, agentId, false, undefined, undefined, {
    externalActionAccountId: 'requester', resolveCurrentMachineExecutionOriginContext: async () => ({
      serverIdentityId: 'srv_installed_project_fixture', machineId: 'machine' }),
  });
  // Recover from the installed sign-in after the retained Session runtime is disposed.
  if (!h.installedCredentials) throw new Error('Missing installed Account fixture');
  const child = await prepareRequesterSessionBootstrap({ credentials: h.installedCredentials,
    attribution: h.f.bootstrap.attribution,
    homeServerIdentityId: h.f.bootstrap.homeServerIdentityId,
    boundary: { serverId: 'session-home', serverHttpBaseUrl: 'https://session-home.test', happyHomeDir: h.f.directory },
    verifyMachineAdmissionCurrent: h.f.isHomeCurrent });
  expect(child).not.toBeNull();
  onTestFinished(() => child?.cleanupOnFailure());
  await h.requester.dispose();
  delete h.tracked.requesterSessionRuntimeContext;
  const services = await prepareRunnerDaemonPluginServices({ invocationId: 'cold-invocation', signal: h.signal,
    local: createUnavailablePluginServices(), dispatch: async operation => {
      const response = await h.dispatch(operation);
      if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
      if (response.result.kind !== 'plugin_services.result_v1') throw new Error('Missing daemon service result');
      return decodeRunnerDaemonPluginServiceWireValueV1(response.result.value);
    } });
  const launch = await authorizeResolvedAgentNativeExecLaunchForHost(services.exec,
    { command: '/installed/agent', args: [], cwd: h.cwd, env: {} }, h.signal,
    issueAgentNativeLaunchQualifierForHost(services.exec));
  expect(launch).toMatchObject({ command: '/installed/agent', cwd: h.cwd });
  expect(h.tracked.requesterSessionRuntimeContext?.bootstrap.getBoundSessionId()).toBe(h.sessionId);
  expect(h.nativeEffects()).toBe(1);
  await launch.release();
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase() });
  await h.tracked.requesterSessionRuntimeContext?.dispose();
  delete h.tracked.requesterSessionRuntimeContext;
  h.tracked.requesterWorkAttributionV1 = { ...h.f.bootstrap.attribution, accountId: 'foreign' };
  const before = h.nativeEffects();
  const prepared = await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase() });
  if (prepared.ok) {
    expect(await h.dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', agentLaunchKind: 'exec', ...h.operationBase(),
      launch: { command: '/installed/agent', args: [], cwd: h.cwd, env: {} } })).toMatchObject({ ok: false });
  } else expect(prepared.error.code).toBeTruthy();
  expect(h.nativeEffects()).toBe(before);
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase() });
  h.tracked.requesterWorkAttributionV1 = h.f.bootstrap.attribution;
  h.tracked.requesterSessionRuntimeContext = await h.replaceRequesterRuntime();
  await writeStoredCredentialsForServerId(h.f.bootstrap.attribution.serverId, terminalSignIn('requester', 1));
  expect(await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase() })).toMatchObject({ ok: true });
  expect(await h.dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', agentLaunchKind: 'exec', ...h.operationBase(),
    launch: { command: '/installed/agent', args: [], cwd: h.cwd, env: {} } })).toMatchObject({
      ok: true,
    });
  expect(h.nativeEffects()).toBe(before + 1);
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase() });
}, 120_000);

it('lists an ordinary owner Session Run through Account operations without private requester custody and excludes another Account', async () => {
  const home = 'srv_ordinary_owner_run';
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, false, undefined, undefined, {
    externalActionAccountId: 'requester', ordinaryAccountSession: true, homeServerIdentityId: home,
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
    agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
  });
  expect(h.tracked.requesterSessionRuntimeContext).toBeUndefined();
  expect(h.tracked.requesterWorkAttributionV1).toBeUndefined();
  // Only Runs with actual Project preparation are projected into this census.
  // Retain a real pending setup occurrence rather than expecting a no-setup Run.
  await h.requireSetup('printf owner-operation');
  const acquired = await h.dispatch({ kind: 'execution_run.snapshot.acquire_v1',
    backendTarget: { kind: 'backend', backendId: h.retainedAgent.agentId } });
  if (!acquired.ok || acquired.result.kind !== 'execution_run.snapshot') throw new Error('Missing actual Run snapshot');
  const runId = randomUUID();
  // Session socket RPC is outside the daemon process. Keep the installed
  // invocation, native qualification, operation projection and read scope real.
  const controller = vi.spyOn(sessionRpc, 'callSessionRpc').mockImplementation(async request => {
    expect(request.token === h.installedCredentials!.token).toBe(true);
    expect(request.sessionId).toBe(h.sessionId);
    expect(request.request).toEqual({ runId });
    expect(request.method).toBe(`${h.sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}`);
    return ExecutionRunGetResponseSchema.parse({ run: { runId, callId: runId, sidechainId: runId,
      intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: h.retainedAgent.agentId },
      permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'long_lived', ioMode: 'request_response',
      status: 'running', startedAtMs: 1 } });
  });
  expect(await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase(runId), executionRunCwd: h.cwd },
    acquired.result.snapshotId)).toMatchObject({ ok: true });
  const launching = h.dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', agentLaunchKind: 'exec', ...h.operationBase(runId),
    launch: { command: '/installed/agent', args: ['--owner-run'], cwd: h.cwd, env: {} } }, acquired.result.snapshotId);
  onTestFinished(async () => {
    await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase(runId) }, acquired.result.snapshotId);
    await launching;
  });
  const list = async (accountId: string) => ActionOperationListV1ResponseSchema.parse(await h.machine.invokeLocalMachineAction(
    ACTION_OPERATION_RPC_METHODS_V2.list, {}, { signal: h.signal, rpcContext: { callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: accountId, custodianAccountId: 'requester', machineId: 'machine',
        installationId: h.f.installation.installationId, role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: h.f.isHomeCurrent } }));
  await vi.waitFor(async () => {
    controller.mockClear();
    expect((await list('another-account')).items).toEqual([]);
    expect(controller).not.toHaveBeenCalled();
    expect((await list('requester')).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: runId, scope: { accountId: 'requester', machineId: 'machine', sessionId: h.sessionId },
        setupReview: expect.objectContaining({ code: 'project_setup_consent_required' }) }),
    ]));
  });
  expect(controller).toHaveBeenCalled();
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase(runId) }, acquired.result.snapshotId);
  expect(await launching).toMatchObject({ ok: false });
}, 120_000);

it('recovers the captured Session requester before Project preparation and projects the original Session-hosted Run through startup and Account Action', async () => {
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, false, undefined, undefined, {
    externalActionAccountId: 'requester', resolveCurrentMachineExecutionOriginContext: async () => ({
      serverIdentityId: 'srv_installed_project_fixture', machineId: 'machine' }),
  });
  // Account refresh retires its previous runtime. The tracked capture can lag
  // behind the existing resolver, which now supplies the real replacement.
  const recoveredRequester = await h.replaceRequesterRuntime();
  expect(await h.requester.isCurrent()).toBe(false);
  expect(await recoveredRequester.isCurrent()).toBe(true);
  const resumedPreparation = await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase() });
  expect(resumedPreparation, JSON.stringify(resumedPreparation)).toMatchObject({ ok: true });
  expect(h.nativeEffects()).toBe(0);
  const launched = await h.dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', agentLaunchKind: 'exec', ...h.operationBase(),
    launch: { command: '/installed/agent', args: ['--resume'], cwd: h.cwd, env: {} } });
  expect(launched, JSON.stringify(launched)).toMatchObject({ ok: true, result: { kind: 'plugin_services.result_v1' } });
  expect(h.nativeEffects()).toBe(1);
  expect(h.accountReads()).not.toContain('Bearer custodian-token');
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase() });
  // Resume can also leave the capture entirely absent; it uses the same owner.
  delete h.tracked.requesterSessionRuntimeContext;
  expect(await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase() })).toMatchObject({ ok: true });
  expect(await h.dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', agentLaunchKind: 'exec', ...h.operationBase(),
    launch: { command: '/installed/agent', args: ['--resume'], cwd: h.cwd, env: {} } })).toMatchObject({ ok: true });
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase() });
  // The process controller has one lifetime. Exercise warm, resumed and Run
  // launches in that same daemon before its ordinary fixture-owned shutdown.
  h.tracked.requesterSessionRuntimeContext = recoveredRequester;
  const refusalLog = vi.spyOn(logger, 'warnLocalFile');
  const { dispatch, operationBase, nativeEffects, accountReads, cwd } = h;
  const beforeWarmLaunch = nativeEffects();
  const prepared = await dispatch({ kind: 'plugin_services.prepare_v1', ...operationBase() });
  expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true });
  expect(nativeEffects()).toBe(beforeWarmLaunch);
  const launch = await dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', agentLaunchKind: 'exec', ...operationBase(),
    launch: { command: '/installed/agent', args: ['--resume'], cwd, env: { ORIGINAL: 'host' } } });
  expect(launch, JSON.stringify(launch)).toMatchObject({ ok: true, result: { kind: 'plugin_services.result_v1' } });
  if (!launch.ok || launch.result.kind !== 'plugin_services.result_v1') throw new Error('Missing authorized Agent tuple');
  expect(decodeRunnerDaemonPluginServiceWireValueV1(launch.result.value)).toMatchObject({
    launch: { command: '/installed/agent', args: ['--resume'], cwd, env: { PATH: '/native/bin', NATIVE: 'active' } } });
  expect(nativeEffects()).toBe(beforeWarmLaunch + 1);
  expect(accountReads()).not.toContain('Bearer custodian-token');
  const refused = await dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', agentLaunchKind: 'exec', ...operationBase(),
    launch: { command: '/installed/agent', args: [], cwd: join(h.f.directory, 'foreign-project'), env: {} } });
  expect(refused).toMatchObject({ ok: false, error: { code: 'outside_root',
    cause: { code: 'outside_root', stage: 'dispatch' } } });
  const diagnostic = refusalLog.mock.calls.map(([message]) => message).find(message =>
    message.includes('runner_plugin_services_dispatch_refused'));
  expect(diagnostic).toBeDefined();
  expect(JSON.parse(diagnostic!)).toEqual({ kind: 'runner_plugin_services_dispatch_refused',
    operation: 'plugin_exec.resolved_agent_launch.authorize_v1', cause: { code: 'outside_root', stage: 'dispatch' } });
  expect(diagnostic).not.toContain(h.f.directory);
  await dispatch({ kind: 'plugin_services.close_v1', ...operationBase() });
  expect(await dispatch({ kind: 'plugin_services.prepare_v1', ...operationBase('misbound-session'),
    executionRunCwd: cwd })).toMatchObject({ ok: false, error: {
      cause: { code: 'plugin_services_invocation_context_unavailable', stage: 'invocation_context' } } });
  // A child Run can author another checkout. Parent Session cwd is neither
  // that Run's workspace nor its Project-membership decision.
  const parentCwd = join(h.f.directory, 'unassociated-parent');
  await mkdir(parentCwd);
  h.tracked.runnerAgentInvocationContext = { ...h.tracked.runnerAgentInvocationContext!, cwd: parentCwd };
  // Process census is an OS boundary. Keep the real runner-entrypoint parser
  // and authority-file reader while modelling this test process as the runner.
  const runnerCommand = `${process.execPath} ${join(h.f.directory, '.runner-snapshots', 'fixture-runner', 'index.mjs')}`;
  h.runner.snapshotIdentity = 'snapshot:fixture-runner';
  h.runner.processCommandHash = hashProcessCommand(runnerCommand);
  h.tracked.processCommandHash = h.runner.processCommandHash;
  vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue({ pid: process.pid,
    processStartTimeMs: h.runner.processStartTimeMs, command: runnerCommand });
  const authorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing });
  await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing, path: authorityFilePath,
    sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, httpPort: 43129 });
  // Only the HTTP boundary is substituted. The real retained runner source,
  // private requester, strict request parser and installed daemon stay composed.
  const homeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(String(url)).pathname !== AGENT_RUNTIME_DAEMON_SERVICES_PATH) return await homeFetch(url, init);
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
    return Response.json(await h.dispatch(request.operation, request.context.executionRunSnapshotId));
  });
  for (const choice of ['thisTime', 'skip', 'untilChanged', 'changed', 'cancel', 'deny', 'stop', 'refused'] as const) {
    const beforeNative = h.nativeEffects();
    await h.requireSetup(`printf setup-${choice}`);
    const acquired = await h.dispatch({ kind: 'execution_run.snapshot.acquire_v1',
      backendTarget: { kind: 'backend', backendId: h.retainedAgent.agentId } });
    if (!acquired.ok || acquired.result.kind !== 'execution_run.snapshot' || !acquired.result.agent) throw new Error('Missing actual Run snapshot');
    const snapshotId = acquired.result.snapshotId;
    // Native Agent open is the external boundary. The actual Run admission,
    // provisioning, Stop and terminal publication owners stay composed.
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    let releaseNativeOpen!: () => void;
    let refuseNativeOpen!: (error: unknown) => void;
    const nativeAuthorization = new Promise<void>((resolve, reject) => { releaseNativeOpen = resolve; refuseNativeOpen = reject; });
    void nativeAuthorization.catch(() => undefined);
    const runIdForLease = randomUUID();
    const createRuntime: Parameters<typeof startExecutionRun>[0]['createRuntime'] = options => {
      const native = createNativeAgentExecutionRunHostRuntime({
        runtime: { executionRuns: { async open() {
          await nativeAuthorization;
          return { async send() { return { status: 'admitted' as const }; },
            async stop() { return { status: 'requested' as const }; },
            watch() { return { dispose() {} }; }, async dispose() {} };
        } } },
        lease: { pluginId: h.retainedAgent.pluginId, pluginVersion: h.retainedAgent.pluginVersion,
          agentId: h.retainedAgent.agentId, localAgentId: 'agent', occurrenceId: runIdForLease, isCurrent: () => true },
        options: { ...options, cwd: h.cwd, scope: 'session' }, supportsResume: false,
      });
      // Admit the fake native open through the real adapter. Its authorization
      // remains held until the original daemon preparation below settles.
      void native.provisionRuntime({ initialPrompt: 'Inspect the workspace.' }).catch(() => undefined);
      return native;
    };
    const voiceAgentManager = new VoiceAgentManager({ createRuntime });
    onTestFinished(() => voiceAgentManager.dispose());
    const finish: Parameters<typeof stopExecutionRun>[0]['finishRun'] = async (runId, next, toolResult) => {
      await finishExecutionRun({ runId, next, toolResult, runs, controllers, budgetRegistry: null,
        parentProvider: 'daemon.executionRuns', sendAcp: async () => {},
        enqueueMarkerWrite: async (_id, write) => { await write(); }, terminalMarkerWritePromises: new Map() });
    };
    const started = await startExecutionRun({ params: { sessionId: h.sessionId, intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: h.retainedAgent.agentId }, instructions: '', permissionMode: 'read_only',
      retentionPolicy: 'ephemeral', runClass: 'long_lived', ioMode: 'request_response' },
      parentProvider: 'daemon.executionRuns', sendAcp: async () => {}, streamedTranscriptSession: null,
      createRuntime, getNowMs: Date.now, budgetRegistry: null, runs, controllers,
      enqueueMarkerWrite: async (_id, write) => { await write(); }, writeActivityMarker: async () => {}, finishRun: finish,
      executeBoundedRun: async () => { throw new Error('Expected controller-owned provisioning'); },
      send: async () => ({ ok: true }), voiceAgentManager });
    const runId = started.runId;
    const controller = controllers.get(runId);
    if (controller?.kind !== 'backend') throw new Error('Missing actual Run controller');
    onTestFinished(async () => { await stopExecutionRun({ runId, runs, controllers, voiceAgentManager, getNowMs: Date.now, finishRun: finish }); });
    // Substitute only the Session socket transport with its actual controller.
    vi.spyOn(sessionRpc, 'callSessionRpc').mockImplementation(async request => {
      expect(request.sessionId).toBe(h.sessionId);
      expect(request.request).toEqual({ runId });
      expect(request.token === recoveredRequester.bootstrap.credentials.token).toBe(true);
      if (request.method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_GET)) {
        return ExecutionRunGetResponseSchema.parse({ run: projectExecutionRunPublicState(runs.get(runId)!) });
      }
      if (request.method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)) {
        return await stopExecutionRun({ runId, runs, controllers, voiceAgentManager, getNowMs: Date.now, finishRun: finish });
      }
      throw new Error('Unexpected Session transport method');
    });
    if (choice === 'thisTime') {
      expect(await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase(runId) }, snapshotId))
        .toMatchObject({ ok: false, error: { cause: { code: 'plugin_services_invocation_context_unavailable', stage: 'invocation_context' } } });
      expect(h.nativeEffects()).toBe(beforeNative);
    }
    // Use the actual Session-owned Run service constructor rather than giving
    // its proxy a hand-authored cwd carrier. Removing caller wiring must fail.
    const source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: h.f.directory,
      publicReleaseRing: configuration.publicReleaseRing, authorityFilePath, expectedSessionId: h.sessionId,
      executionRunSnapshot: acquired.result, occurrenceId: acquired.result.agent.descriptor.occurrenceId,
      runtimeAuthority: acquired.result.agent.descriptor.runtimeAuthority });
    if (!source) throw new Error('Missing real retained Run source');
    onTestFinished(() => source.retire?.());
    await source.createInvocationServices({ pluginId: h.retainedAgent.pluginId, pluginVersion: h.retainedAgent.pluginVersion,
      agentId: h.retainedAgent.agentId, occurrenceId: acquired.result.agent.descriptor.occurrenceId,
      correlationId: runId, processOwner: { kind: 'run', runId, sessionId: h.sessionId }, cwd: h.cwd,
      environment: {}, providerBindingActive: false, signal: controller.backend.getRuntimeLifetimeSignal(), isOccurrenceCurrent: () => true });
    const launching = h.dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', agentLaunchKind: 'exec', ...h.operationBase(runId),
      launch: { command: '/installed/agent', args: ['--cold-run'], cwd: h.cwd, env: {} } }, snapshotId);
    let completed: Awaited<typeof launching> | undefined;
    void launching.then(result => { completed = result; }).catch(() => undefined);
    void launching.then(result => {
      if (result.ok) releaseNativeOpen();
      else refuseNativeOpen(Object.assign(new Error('Native preparation refused'), { code: result.error.code }));
    });
    // This is separately authenticated Account ingress. Session custody starts
    // the Run; it does not grant the later human decision.
    const rpcContext = { callerAuthority: 'present_user' as const,
      machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: 'machine',
        installationId: h.f.installation.installationId, role: 'manage' as const, encryptionMode: 'plain' as const },
      verifyMachineAdmissionCurrent: recoveredRequester.bootstrap.isCurrent };
    expect(await h.machine.resolveProjectFiniteRuntime({ signal: h.signal, ...rpcContext }),
      'The installed Account ingress must resolve its original Project runtime').not.toBeNull();
    const read = async () => ActionOperationGetV1ResponseSchema.parse(await h.machine.invokeLocalMachineAction(
      ACTION_OPERATION_RPC_METHODS_V2.get, { operationId: runId, refreshSetupReview: true }, { signal: h.signal, rpcContext }));
    const held = await vi.waitFor(async () => {
      expect(completed, 'Original native launch must remain pending on setup').toBeUndefined();
      const result = await read();
      expect(result).toMatchObject({ kind: 'found', operation: { operationId: runId, actionId: 'execution.run.start',
        setupReview: { code: 'project_setup_consent_required' } } });
      return result;
    });
    if (held.kind !== 'found' || !held.operation.setupReview || held.operation.domainRef?.kind !== 'projectCommand') {
      throw new Error('Original native Run hold unavailable');
    }
    expect(h.nativeEffects()).toBe(beforeNative);
    expect(h.admission.dependencies()).toMatchObject([{ operationId: runId, state: 'setup' }]);
    const digest = held.operation.setupReview.reviewedEffectDigest;
    expect(held.operation.cancellation).toBe('supported');
    const decide = () => h.machine.invokeLocalMachineAction(RPC_METHODS.DAEMON_PROJECTS_PREPARE, {
      workspace: { serverId: 'session-home', machineId: 'machine', workspaceId: 'workspace', rootPath: h.cwd },
      heldOperationId: runId, phase: 'setup', expectedEffectDigest: digest,
      ...(choice === 'skip' ? { skipForInvocation: true } : { consentScope: 'thisTime' }),
    }, { signal: h.signal, rpcContext, localActionContext: { surface: 'rpc', authority: 'present_user', actionRequestId: randomUUID() } });
    if (choice === 'deny' || choice === 'stop' || choice === 'refused') {
      if (choice === 'deny') {
        expect(await h.machine.invokeLocalMachineAction(ACTION_OPERATION_RPC_METHODS_V1.cancel,
          { operationId: runId }, { signal: h.signal, rpcContext })).toMatchObject({ kind: 'requested' });
      } else if (choice === 'stop') {
        expect(await stopExecutionRun({ runId, runs, controllers, voiceAgentManager, getNowMs: Date.now, finishRun: finish }))
          .toEqual({ ok: true, status: 'cancelled' });
      } else {
        // Observe real terminal publication before invocation disposal. A
        // running-only daemon projection would still offer a resumable review.
        await finish(runId, { status: 'failed', finishedAtMs: Date.now(), error: { code: 'project_setup_refused' } }, { output: {} });
        expect(await read()).toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: 'project_setup_refused' } } });
        const failed = await read();
        if (failed.kind !== 'found') throw new Error('Missing terminal controller projection');
        expect(failed.operation.setupReview).toBeUndefined();
        expect(await decide()).toMatchObject({ ok: false, errorCode: 'project_setup_review_unavailable' });
        await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase(runId) }, snapshotId);
      }
      expect(await launching).toMatchObject({ ok: false });
      await vi.waitFor(() => expect(runs.get(runId)?.status).toBe(choice === 'refused' ? 'failed' : 'cancelled'));
      const terminal = await read();
      if (terminal.kind === 'found') {
        expect(terminal.operation.state).toBe(choice === 'refused' ? 'failed' : 'cancelled');
        expect(terminal.operation.setupReview).toBeUndefined();
      }
      expect(await decide()).toMatchObject({ ok: false, errorCode: 'project_setup_review_unavailable' });
      expect(h.nativeEffects()).toBe(beforeNative);
      expect(h.admission.dependencies()).toHaveLength(0);
      await source.retire?.();
      continue;
    }
    if (choice === 'changed') {
      await h.requireSetup('printf changed-effect');
      expect(await decide()).toMatchObject({ operation: { operationId: runId,
        setupReview: { code: 'project_setup_effect_changed' } } });
      expect(completed).toBeUndefined();
      expect(h.admission.dependencies()).toMatchObject([{ operationId: runId, state: 'setup' }]);
    }
    if (choice === 'cancel' || choice === 'changed') {
      await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase(runId) }, snapshotId);
      expect(await launching).toMatchObject({ ok: false });
      expect(await decide()).toMatchObject({ ok: false, errorCode: 'project_setup_review_unavailable' });
      expect(h.nativeEffects()).toBe(beforeNative);
      expect(h.admission.dependencies()).toHaveLength(0);
      continue;
    }
    if (choice === 'untilChanged') {
      const approvingAccount = await readStoredCredentialsForServerId('session-home');
      if (!approvingAccount) throw new Error('Missing approving Account credentials');
      await createProjectSetupTrustClient({ credentials: approvingAccount, serverHttpBaseUrl: 'https://session-home.test' })
        .approveReviewedEffect({ project: { serverId: 'session-home', projectId: 'project' }, expectedRevision: 'absent',
          authority: 'present_user', reviewedEffectDigest: digest, currentEffectDigest: digest, approvedAtMs: 2 });
      await read();
    } else {
      expect(await decide(), choice).toMatchObject({ operation: { operationId: runId } });
    }
    expect(await launching).toMatchObject({ ok: true, result: { kind: 'plugin_services.result_v1' } });
    expect(h.trustWrites()).toBe(choice === 'untilChanged' ? 2 : 1);
    const runtime = await h.machine.resolveProjectFiniteRuntime({ signal: h.signal, requesterSessionBootstrap: recoveredRequester.bootstrap });
    if (!runtime?.successHomeDir) throw new Error('Missing target completion owner');
    const completion = await createProjectSetupSuccessStore({ homeDir: runtime.successHomeDir }).read({
      serverId: 'session-home', machineId: 'machine', workspaceRefId: 'workspace' });
    if (choice === 'skip') expect(completion?.reviewedEffectDigest).not.toBe(digest);
    else expect(completion?.reviewedEffectDigest).toBe(digest);
    await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase(runId) }, snapshotId);
    expect(h.admission.dependencies()).toHaveLength(0);
    expect(await read()).toEqual({ kind: 'not_found' });
  }
  // Recovery must still refuse a requester whose real Machine admission retired.
  h.tracked.runnerAgentInvocationContext = { ...h.tracked.runnerAgentInvocationContext!, cwd };
  delete h.tracked.requesterSessionRuntimeContext;
  h.f.retire();
  const beforeRefusedLaunch = nativeEffects();
  expect(await dispatch({ kind: 'plugin_services.prepare_v1', ...operationBase() })).toMatchObject({ ok: true });
  expect(await dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', agentLaunchKind: 'exec', ...operationBase(),
    launch: { command: '/installed/agent', args: [], cwd, env: {} } })).toMatchObject({
      ok: false, error: { cause: { code: 'agent_isolation_unavailable', stage: 'dispatch' } },
    });
  expect(nativeEffects()).toBe(beforeRefusedLaunch);
  await dispatch({ kind: 'plugin_services.close_v1', ...operationBase() });
}, 120_000);
