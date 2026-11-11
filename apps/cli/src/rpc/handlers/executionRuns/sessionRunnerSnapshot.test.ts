import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createSessionClientExecutionRunService } from '@/api/session/client/executionRuns/createSessionClientExecutionRunService';
import { createDeferred } from '@/testkit/async/deferred';
import { FeaturesResponseSchema, AccountProfileResponseSchema, AccountSettingsSchema } from '@happier-dev/protocol';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { getCurrentTest } from 'vitest/suite';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { ExecutionRunStartResponseSchema, ExecutionRunStartFailureDetailsV1Schema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/selection/v1';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { configuration, reloadConfiguration } from '@/configuration';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { ApiClient } from '@/api/api';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { registerSessionClientRuntimeHandlers } from '@/api/session/client/executionRuns/registerSessionClientRuntimeHandlers';
import { applySessionRuntimeControls } from '@/api/session/sessionRuntimeControls';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import type { ExecutionRunHostBridgeContract } from '@/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { resolveSessionRunnerEntrypointIdentityFromProcessCommand } from '@/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { startDaemonSessionControlRuntime } from '@/daemon/startup/startDaemonSessionControlRuntime';
import { buildDaemonControlHttpHeaders } from '@/daemon/controlHttp';
import { createRunnerExecutionRunSnapshotResolver } from '@/agent/runtime/session/process/runnerExecutionRunSnapshot';
import { createRunnerReviewHostPluginAuthorityReader } from '@/agent/executionRuns/profiles/review/pluginAuthority';
import type { RunnerExecutionRunSnapshotV1 } from '@/agent/runtime/session/process/executionRunSnapshotProtocol';
import type { TrackedSession } from '@/daemon/types';
import { readStoredCredentialsForServerId, writeDaemonState, writeStoredCredentialsForServerId } from '@/persistence';
import { createMutableApiSessionClientFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createSessionRunSnapshotFixture, createSnapshotSessionPendingTransport, createSnapshotDaemonHttpListener } from './sessionRunnerSnapshot.fixture';
import { deriveConnectedServiceRunMaterializeToken } from '@/daemon/connectedServices/runs/capabilityToken';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { normalizeExecutionRunRpcPayload } from '@/session/services/executionRuns';
import { logger } from '@/ui/logger';
import type { NativeAgentSessionInteractionHostBinding, NativeAgentSessionRunToolBindingRequest } from '@/agent/runtime/registry/engineRegistryTypes';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  getActiveAccountSettingsSnapshotLifetimeToken, getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { prepareActiveAccountRoleOverrides } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ExecutionRunHostActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/executionRunHostActionApprovalRequestV1';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { assertExecutionRunStructuredOutputModelAllowed } from '@/agent/runtime/bridges/executionRun/structuredOutputAdmission';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { captureScmComparison } from '@/scm/comparisons/captureScmComparison';
import { resolveDefaultScmBackendRegistry } from '@/scm/scmBackendCatalog';
import { runSessionLoopLifecycle } from '@/agent/runtime/session/loop/lifecycle';
import { createLifecycleParams } from '@/agent/runtime/session/loop/lifecycle.testkit';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/lifecycle/runnerTerminationHandlers';
import type { RunnerTerminationEvent } from '@/agent/runtime/lifecycle/runnerTerminationOutcome';
import { cleanupBackendRunResources } from '@/agent/runtime/cleanupBackendRunResources';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { connectSessionMcpClient } from '@/mcp/runtime/sessionMcpLocalTransport';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { NativeAgentSessionRunToolBinding } from '@/agent/runtime/registry/engineRegistryTypes';
import { readCurrentDaemonPluginCatalogSnapshot } from '@/plugins/daemon/currentCatalog';
import * as sessionRpcTransport from '@/session/transport/rpc/sessionRpc';
import { projectAgentRuntimeDaemonServiceTurnWitnessV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceTurnWitness';
import { readOrCreateInstallationIdentitySync } from '@/daemon/identity/store';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SessionAutoFollowPreferencesResponseSchema, SESSION_FOLLOW_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/api';
import { DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1, DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { artifactListResponse, artifactReadResponse } from '@/testkit/http/artifactHome';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createSessionRoleContext } from '@/session/roles/sessionRoleContext';
import { createRoleSourceReader } from '@/session/roles/roleSources';
import { readPluginRoleSources } from '@/plugins/projection/registry/roles';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createExecutionRunAccountSettingsSnapshotResolver } from '@/api/machine/resolveExecutionRunAccountSettingsSnapshot';
import { readAccountRoleOverridesFromSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { applyRunnerMcpSessionContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import { readMcpExecutionSource } from '@/mcp/runtime/mcpExecutionSource';
import { executeScmDiffSummaryAction } from '@/scm/actions/executeScmDiffSummaryAction';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createExecutionRunRpcActionDeps } from './dispatchExecutionRunRpcAction';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';

const transport = vi.hoisted(() => ({ app: null as unknown }));
// Only HTTP listener/transport is substituted. Real daemon composition, ingress,
// tracked-runner authorization, source custody and native child requests remain.
vi.mock('@/daemon/controlServer', async importOriginal => {
  const actual = await importOriginal<typeof import('@/daemon/controlServer')>();
  return { ...actual, startDaemonControlServer: async (input: Parameters<typeof actual.startDaemonControlServer>[0]) => {
    const app = actual.createDaemonControlApp(input);
    transport.app = app;
    const listener = await createSnapshotDaemonHttpListener();
    return { port: listener.port, stop: async () => { await listener.stop(); await app.close(); transport.app = null; } };
  } };
});

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
let originalProcessTitle: string | undefined;
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (originalProcessTitle !== undefined) { process.title = originalProcessTitle; originalProcessTitle = undefined; }
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); reloadConfiguration();
  withdrawActiveProjectAccountRowsSnapshot();
  resetActiveAccountSettingsSnapshotForTests();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  if (failures.length > 0) throw failures[0];
});

it.each(['session_close', 'planned_refresh_then_stop', 'owner_action_starts', 'member_action_starts',
  'reviewer_nested', 'reviewer_depth_exceeded', 'reviewer_turn_changed', 'reviewer_allowed', 'reviewer_off'] as const)('admits Session-hosted Runs through tracked daemon HTTP and current MCP occurrence wiring: %s', async retirement => {
  // Physical child exit shares this composed journey's budget. vi.waitFor's
  // one-second default is not the native supervisor's retirement contract.
  const task = getCurrentTest()!;
  const home = await mkdtemp(join(tmpdir(), 'happier-session-run-snapshot-'));
  const reviewsPermission = retirement.startsWith('reviewer_');
  let reviewTurn = { turnId: 'review-causing-turn',
    workDepth: retirement === 'reviewer_nested' || retirement === 'reviewer_turn_changed' ? 3
      : retirement === 'reviewer_depth_exceeded' ? 4 : reviewsPermission ? 2 : 0 };
  roots.push(home);
  vi.stubEnv('HAPPIER_HOME_DIR', home);
  vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
  vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
  vi.stubEnv('HAPPIER_FEATURE_PROVIDERS__ENABLED', '1');
  vi.stubEnv('HAPPIER_FEATURE_VOICE__ENABLED', '1');
  vi.stubEnv('HAPPIER_FEATURE_VOICE_AGENT__ENABLED', '1');
  vi.stubEnv('HAPPIER_BUILD_FEATURES_ALLOW', 'execution.runs,providers,voice,voice.agent');
  vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
  reloadConfiguration();
  const nativeCliPaths = { parent: join(home, 'snapshot-parent-cli.cjs'), child: join(home, 'snapshot-child-cli.cjs') };
  for (const id of ['parent', 'child'] as const) {
    await writeFile(nativeCliPaths[id], `
      if (process.argv.includes('--hold')) {
        require('node:fs').appendFileSync('native-child-pids.jsonl', String(process.pid) + '\\n');
        setInterval(() => {}, 1000);
      } else process.exitCode = 0;
    `);
    vi.stubEnv(resolveAgentCliOverrideEnvKey(`acme.snapshot/${id}`), nativeCliPaths[id]);
  }
  // The isolated test worker is the tracked runner subject. Exercise real OS
  // identity observation and the existing entrypoint parser without mocking them.
  originalProcessTitle = process.title;
  process.title = join(home, 'src', 'index.ts');
  expect(pluginReloadController.getState().activeRegistry).toBeNull();
  const fixture = await createSessionRunSnapshotFixture(home);
  cleanups.push(async () => await fixture.dispose());
  // Local tracked fixture has no Home terminal transport; use its supported
  // PID identity so exit does not fabricate server terminal-settlement custody.
  const sessionId = `PID-${process.pid}`;
  const backendTarget = { kind: 'builtInAgent' as const, agentId: 'acme.snapshot/parent' };
  const childTarget = { kind: 'builtInAgent' as const, agentId: 'acme.snapshot/child' };
  const parentRegistration = fixture.registry.agentRuntimesByAgentId.get(backendTarget.agentId);
  const parentBinding = parentRegistration?.hasPrimaryRuntime ? parentRegistration.sessionRunnerFactoryBinding : null;
  if (!parentBinding) {
    const diagnostics = fixture.registry.pluginDiagnosticsByPluginId['acme.snapshot'];
    await fixture.dispose();
    throw new Error('The admitted fixture has no parent source binding: ' + JSON.stringify(diagnostics));
  }
  const processIdentity = await readProcessIdentityByPid(process.pid);
  if (!processIdentity?.processStartTimeMs) throw new Error('Runner process identity unavailable');
  const entrypoint = resolveSessionRunnerEntrypointIdentityFromProcessCommand(processIdentity.command);
  if (entrypoint.status !== 'known') throw new Error('Test worker entrypoint identity unavailable');
  const runner = { pid: process.pid, processStartTimeMs: processIdentity.processStartTimeMs,
    processCommandHash: hashProcessCommand(processIdentity.command), snapshotIdentity: entrypoint.comparableId };
  const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: home,
    publicReleaseRing: configuration.publicReleaseRing });
  const issued = await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: home,
    publicReleaseRing: configuration.publicReleaseRing, path: authorityPath, sessionId, runner,
    retainedAgent: parentBinding, httpPort: 46021 });
  vi.stubEnv(HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, authorityPath);
  const launcherPid = process.ppid;
  const tracked: TrackedSession = { pid: launcherPid, sessionRunnerPid: process.pid, startedBy: 'daemon', happySessionId: sessionId,
    processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash,
    runnerProcessIdentity: { pid: process.pid, processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash },
    runnerAgentSourceCustodyV1: parentBinding.sourceCustody,
    runnerAgentInvocationContext: { cwd: home, environment: {}, providerBindingActive: false },
    agentRuntimeDaemonServiceAuthorityFilePath: authorityPath, agentRuntimeDaemonServiceCapabilityHash: issued.capabilityDigest };
  const token = Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from(JSON.stringify({
    sub: 'snapshot-account', tokenEpoch: 1, provenance: { v: 1, kind: 'terminal',
      authority: 'account_automation' },
  })).toString('base64url') + '.';
  await writeStoredCredentialsForServerId(configuration.activeServerId, { token, encryption: null });
  const credentials = await readStoredCredentialsForServerId(configuration.activeServerId);
  if (!credentials) throw new Error('Missing stored snapshot Account credentials');
  const installation = readOrCreateInstallationIdentitySync();
  const settingsResponse = AccountSettingsV2GetResponseSchema.parse({ version: 1,
    content: { t: 'plain', v: reviewsPermission ? { workDepthLimit: 4 } : {} } });
  const promptLibraryRows = PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed',
    rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
      content: { t: 'plain', v: key === 'role-overrides' ? { key, value: { v: 1, overrides: {
        second_opinion: { roleId: 'second_opinion', instructionsOverride: 'OWNER_SECOND_OPINION_INSTRUCTIONS',
          engine: { agentTargetKey: 'agent:acme.snapshot/parent', modelId: 'snapshot-native-review' } },
        approval_reviewer: { roleId: 'approval_reviewer',
          engine: { agentTargetKey: 'agent:acme.snapshot/child', modelId: 'snapshot-native-review' } },
      } } } : emptyPromptLibraryRecordV1(key) } })) });
  const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
    settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
  const homeHttpReads: string[] = [];
  const homeHttpFailures: string[] = [];
  let roleArtifactsAvailable = true;
  const unreadableRole = {
    id: 'unreadable-role', ownerAccountId: 'snapshot-account', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
    header: encodePlainArtifactStoredContent({ kind: 'role.v1', name: 'Unreadable Role' }),
    body: encodePlainArtifactStoredContent({ body: '{}' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
  };
  const serverFeatures = { status: 'ready' as const, features: FeaturesResponseSchema.parse({ features: {
    providers: { enabled: true }, voice: { enabled: true, agent: { enabled: true } },
  },
    capabilities: { serverIdentity: { serverIdentityId: 'srv_snapshot_home' } } }) };
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    homeHttpReads.push(path);
    if (path === '/v1/account/profile') return { status: 200, data: AccountProfileResponseSchema.parse({ id: 'snapshot-account' }) };
    if (path === '/v1/machines/snapshot-machine') {
      expect(options?.headers?.Authorization === `Bearer ${token}`).toBe(true);
      return { status: 200, data: { machine: { id: 'snapshot-machine', installationId: installation.installationId,
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0, storageMode: 'plain',
        kind: 'persistent', keyBasis: { dataEncryptionKey: null, metadataVersion: 0, daemonStateVersion: 0 },
        access: { custodian: { accountId: retirement === 'member_action_starts' ? 'other-custodian' : 'snapshot-account', displayName: 'Owner' }, role: 'manage',
          resourceMode: 'plain', accessState: 'ready' } } } };
    }
    if (path === '/v2/account/settings') return { status: 200, data: settingsResponse };
    if (path === SESSION_FOLLOW_HTTP_PATHS_V1.preferences) return { status: 200,
      data: SessionAutoFollowPreferencesResponseSchema.parse({
        ...DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1, ...DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1,
      }) };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    if (path === '/v1/account/entity-rows/mcp') return { status: 200, data: { status: 'absent' } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId,
      encryptionMode: 'plain', metadata: JSON.stringify({ path: home, machineId: 'snapshot-machine' }) }) } };
    if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: promptLibraryRows };
    if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
    if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
      status: 'present', revision: 1, content: { t: 'plain', v: fixture.providerCatalog } } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(
      axios.getUri({ url: String(url), params: options?.params }), roleArtifactsAvailable ? [] : [unreadableRole]) };
    if (/^\/v1\/artifacts\/[^/]+$/.test(path)) return { status: 404, data: { error: 'Artifact not found' } };
    homeHttpFailures.push('GET ' + path);
    throw new Error('Unexpected Home HTTP read: ' + path);
  });
  const reviewApprovalRequests: ReturnType<typeof ExecutionRunHostActionApprovalRequestV1Schema.parse>[] = [];
  const commentApprovalRequests: ReturnType<typeof ApprovalRequestV2Schema.parse>[] = [];
  const workspaceRow = createPlainProjectAccountRefRow({ id: 'snapshot-review-workspace',
    serverId: configuration.activeServerId, machineId: 'snapshot-machine', rootPath: home, createdAtMs: 1 });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/artifacts/read') return artifactReadResponse(body, id => id === unreadableRole.id ? unreadableRole : null);
    if (path.endsWith('/execution-authorization')) {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const actionId = decodeURIComponent(path.split('/').at(-2)!);
      return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'snapshot-home-proof', binding: {
        serverIdentityId: 'srv_snapshot_home', accountId: 'snapshot-account', custodianAccountId: 'snapshot-account',
        authentication: { kind: 'terminal', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
        machineId: 'snapshot-machine', installationId: installation.installationId,
        actionId, requestId: request.envelope.requestId, target: request.envelope.target,
        sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
      } }) };
    }
    if (path.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
    if (path === '/v2/sessions/lookup-by-tags') return { status: 200, data: {
      sessions: [createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
        metadata: JSON.stringify({ path: home, machineId: 'snapshot-machine' }) })],
    } };
    if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list` || path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`) {
      return projectAccountRowsReadHttpResponse([workspaceRow], String(url), body);
    }
    if (path === '/v1/artifacts') {
      if (!body || typeof body !== 'object' || typeof Reflect.get(body, 'body') !== 'string') {
        throw new Error('Review approval Artifact body is unavailable');
      }
      const content = decodePlainArtifactStoredContent(Reflect.get(body, 'body'));
      if (!content || typeof content !== 'object' || typeof Reflect.get(content, 'body') !== 'string') {
        throw new Error('Review approval Artifact content is unavailable');
      }
      const request: unknown = JSON.parse(Reflect.get(content, 'body'));
      const commentApproval = ApprovalRequestV2Schema.safeParse(request);
      if (commentApproval.success) commentApprovalRequests.push(commentApproval.data);
      else reviewApprovalRequests.push(ExecutionRunHostActionApprovalRequestV1Schema.parse(request));
      // Refuse the external persistence boundary: this discriminator needs no
      // approved intent, grant or outward Review-comment effect.
      return { status: 503, data: { error: 'review_approval_fixture_unavailable' } };
    }
    homeHttpFailures.push('POST ' + path);
    throw new Error('Unexpected Home HTTP write: ' + path);
  });
  const trackedSessions = new Map([[launcherPid, tracked]]);
  setActiveAccountSettingsSnapshot({ scopeKey: resolveAccountSettingsScopeKey(credentials), source: 'network',
    settings: AccountSettingsSchema.parse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
    providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: fixture.providerCatalog } });
  // Supply the prepared Account policy through registration's existing port.
  // Role preparation stays real: the canonical loader consumes empty HTTP rows.
  const accountScopeKey = resolveAccountSettingsScopeKey(credentials);
  const preparedOverrides = await prepareActiveAccountRoleOverrides({ credentials, scopeKey: accountScopeKey,
    lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() });
  expect(preparedOverrides, JSON.stringify({ preparedOverrides, homeHttpReads, homeHttpFailures })).toMatchObject({ status: 'ready',
    overrides: { second_opinion: { roleId: 'second_opinion' } } });
  const actionsSettingsProvider = createActionSettingsProvider({ scopeKey: accountScopeKey });
  const daemon = await startDaemonSessionControlRuntime({ machineId: 'snapshot-machine', serverId: configuration.activeServerId,
    serverBaseUrl: configuration.apiServerUrl, credentials, api: await ApiClient.create(credentials),
    externalActionAccountId: 'snapshot-account',
    resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
      serverUrl: configuration.apiServerUrl, resolveCurrentMachineId: () => 'snapshot-machine',
    }),
    pluginRuntimeController: fixture.controller,
    resolveServerFeaturesSnapshot: async () => serverFeatures,
    daemonSessionMutationCustody: { stageTranscriptMessage: async () => ({ persisted: true, delivered: true }),
      stageTranscriptEvent: async () => ({ persisted: true, delivered: true }) },
    connectedServicesMaterializationBaseDir: join(home, 'connected-services'),
    getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
    pidToTrackedSession: trackedSessions, pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(),
    pidToSpawnWebhookTimeout: new Map(), getApiMachineForSessions: () => null, spawnResourceCleanupByPid: new Map(),
    sessionAttachCleanupByPid: new Map(), connectedServicesRestartRequestedPids: new Set(),
    beforeShutdown: async () => {}, onHappySessionWebhook: async () => {}, requestShutdown: () => {},
    processEnv: { HAPPIER_FEATURE_PROVIDERS__ENABLED: '1', HAPPIER_BUILD_FEATURES_ALLOW: 'execution.runs,providers' },
  });
  cleanups.push(async () => await daemon.stopControlServer());
  await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: home,
    publicReleaseRing: configuration.publicReleaseRing, path: authorityPath, sessionId, runner,
    retainedAgent: parentBinding, httpPort: daemon.controlPort, capability: issued.document.capability });
  writeDaemonState({ pid: process.pid, httpPort: daemon.controlPort, controlToken: daemon.controlToken,
    startedAt: Date.now(), startedWithCliVersion: '0.0.0' });
  const authorityFile = JSON.parse(await readFile(authorityPath, 'utf8')) as { capability: string };
  const reviewAuthorityReply = await (transport.app as ReturnType<typeof import('@/daemon/controlServer').createDaemonControlApp>).inject({
    method: 'POST', url: '/agent-runtime/session/services/v1',
    headers: buildDaemonControlHttpHeaders(authorityFile.capability),
    payload: { v: 1, context: { token: authorityFile.capability, sessionId },
      operation: { kind: 'execution_run.review_plugin_authority.resolve_v1', pluginId: 'acme.snapshot' } },
  });
  expect(reviewAuthorityReply.statusCode).toBe(200);
  expect(AgentRuntimeDaemonServiceResponseV1Schema.parse(reviewAuthorityReply.json())).toMatchObject({ ok: true, result: {
    kind: 'execution_run.review_plugin_authority', authority: { sourceCustody: parentBinding.sourceCustody },
  } });
  expect(pluginReloadController.getState().activeRegistry).toBeNull();
  const daemonRequests: ReturnType<typeof AgentRuntimeDaemonServiceRequestV1Schema.parse>[] = [];
  const snapshots: RunnerExecutionRunSnapshotV1[] = [];
  let replaceAuthorityAfterAcquisition = false;
  const actualFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/v1/features') return Response.json(serverFeatures.features);
    if (url.hostname !== '127.0.0.1' || Number(url.port) !== daemon.controlPort) return actualFetch(input, init);
    // This fixture's daemon has no plugin-change service. Supply its passive
    // catalog at the HTTP boundary from the same real admitted controller.
    if (url.pathname === '/plugins/catalog/read') return Response.json({ kind: 'available',
      ...await readCurrentDaemonPluginCatalogSnapshot({ reloadController: fixture.controller, happyHomeDir: home, selection: 'tools' }) });
    const app = transport.app as ReturnType<typeof import('@/daemon/controlServer').createDaemonControlApp> | null;
    if (!app) throw new Error('Missing daemon HTTP composition');
    if (url.pathname === '/agent-runtime/session/services/v1')
      daemonRequests.push(AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body))));
    const reply = await app.inject({ method: 'POST', url: url.pathname,
      headers: Object.fromEntries(new Headers(init?.headers)), payload: String(init?.body ?? '{}') });
    if (url.pathname === '/agent-runtime/session/services/v1') {
      const response = AgentRuntimeDaemonServiceResponseV1Schema.parse(reply.json());
      if (response.ok && response.result.kind === 'execution_run.snapshot') {
        snapshots.push(response.result);
        expect(AgentRuntimeDaemonServiceResponseV1Schema.safeParse({ ...response,
          result: { ...response.result, unexpected: true } }).success).toBe(false);
        if (replaceAuthorityAfterAcquisition) {
          replaceAuthorityAfterAcquisition = false;
          await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: home,
            publicReleaseRing: configuration.publicReleaseRing, path: authorityPath,
            sessionId, runner, retainedAgent: parentBinding, httpPort: daemon.controlPort });
        }
      }
    }
    return new Response(reply.body, { status: reply.statusCode, headers: { 'content-type': 'application/json' } });
  });
  const readReviewAuthority = createRunnerReviewHostPluginAuthorityReader(sessionId);
  expect(await readReviewAuthority('acme.snapshot')).toMatchObject({ sourceCustody: parentBinding.sourceCustody });
  expect(await createRunnerReviewHostPluginAuthorityReader('foreign-session')('acme.snapshot')).toBeNull();
  const metadata = createTestMetadata({ runtimeDescriptorV1: { v: 1, agentId: backendTarget.agentId, agent: {} },
    path: home, machineId: 'snapshot-machine',
    ...(reviewsPermission ? { approvalReviewerEnabled: retirement !== 'reviewer_off' } : {}) });
  const composition: { manager?: ExecutionRunHostBridgeContract } = {};
  const session = createMutableApiSessionClientFixture({ sessionId, metadata,
    overrides: { getBackendTarget: () => readBackendTargetRefV2(backendTarget),
      getWorkDepth: () => reviewsPermission ? 2 : 0,
      getServerIdentityId: () => 'srv_snapshot_home',
      ...createSnapshotSessionPendingTransport(),
      enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }),
      // Host structured completions are committed replies; the online Session acknowledges delivery.
      enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: true }),
      setExecutionRunWorkerUpdateSource: source => {
        if (!(source instanceof ExecutionRunHostBridge)) throw new Error('Missing registered Run bridge');
        composition.manager = source;
      } } });
  const controls: Partial<SessionRuntimeControls> = {};
  const permissions = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[Snapshot Parent]' });
  let parentControls: SessionRuntimeControls | null = null;
  let waitForParentControls: ((signal: AbortSignal) => Promise<boolean>) | undefined;
  let waitForRuntimeControls: ((signal?: AbortSignal) => Promise<boolean>) | undefined;
  let rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
  // Authenticated Session RPC is the process/network boundary; admission and
  // occurrence currentness run in the real registered host handler below.
  if (!reviewsPermission) vi.spyOn(sessionRpcTransport, 'callSessionRpc').mockImplementation(async request => {
    expect(request.method).toBe(`${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1}`);
    return await rpc.handleRequest({ method: request.method, params: request.request, callerAuthority: 'present_user' });
  });
  let ownerCredentialsAvailable = true;
  const stored = await readStoredCredentialsForServerId(configuration.activeServerId);
  if (!stored) throw new Error('Missing stored Account credential custody');
  const snapshotResolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'snapshot-machine',
    serverHttpBaseUrl: configuration.apiServerUrl, readCredentials: async () => ownerCredentialsAvailable ? stored : null,
    isOwnerCurrent: () => ownerCredentialsAvailable, onSettings: () => {} });
  cleanups.push(snapshotResolver.dispose);
  // The actual runHost producer is covered by piUserMcp. These registered
  // journeys construct its host input through the same real qualification.
  const sourceLifetime = new AbortController();
  cleanups.push(async () => { sourceLifetime.abort(); });
  let qualifiedSource: ReturnType<typeof readMcpExecutionSource> | undefined;
  let sourceDemands = 0;
  const qualifiedSnapshotResolver = Object.assign(snapshotResolver, {
    readAgentExecutionContext: async (signal?: AbortSignal) => {
      sourceDemands++;
      if (!ownerCredentialsAvailable) return null;
      qualifiedSource ??= readMcpExecutionSource({ credentials: stored, catalogCredentials: stored,
        sessionId, machineId: 'snapshot-machine', serverHttpBaseUrl: configuration.apiServerUrl,
        accountSession: { serverId: session.getServerBinding().serverId,
          homeServerIdentityId: session.getServerIdentityId(), isCurrent: () => ownerCredentialsAvailable }, signal: sourceLifetime.signal });
      const source = await qualifiedSource;
      signal?.throwIfAborted();
      if (!ownerCredentialsAvailable) return null;
      if (source.kind !== 'requester' || source.identity.kind === 'owner_person') throw new Error('Account Session must retain requester custody');
      return { requesterIdentity: source.identity, isolationEnabled: false };
    },
  });
  const installRuntimeControls = (next: SessionRuntimeControls) => applySessionRuntimeControls(controls,
    { ...next, resolveAccountSettingsSnapshot: qualifiedSnapshotResolver });
  const register = () => registerSessionClientRuntimeHandlers({ rpcHandlerManager: rpc, token,
    serverId: configuration.activeServerId, serverUrl: configuration.apiServerUrl,
    readOwnerAccountCredentials: async () => ownerCredentialsAvailable ? credentials : null, metadataPath: home, metadata, sessionId, session, actionsSettingsProvider,
    getServerFeaturesSnapshot: () => serverFeatures,
    getSessionMetadata: () => metadata, get sessionRuntimeControls() { return parentControls; }, getCurrentWorkspaceWrites: () => 'allow',
    waitForAppliedChildSelectionReader: async signal => await waitForParentControls?.(signal) ?? false,
    get waitForSessionRuntimeControls() { return waitForRuntimeControls; },
    enqueueSessionUserMessage: async () => {}, enqueueUserTextMessageCommitted: async () => ({ persisted: true, delivered: true }),
    enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: true }),
    enqueueVoiceAgentTranscriptTurnCommitted: async () => ({ persisted: true, delivered: true }),
    sendAgentMessageEphemeral: () => ({ accepted: true, epoch: 0 }), getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
    persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
  });
  let registration = register();
  cleanups.push(async () => {
    await composition.manager?.dispose?.(); await registration.dispose(); applySessionRuntimeControls(controls, null);
  });
  // Observe the authority consumed by the real MCP composer without replacing
  // its internal logic. The native Session open below remains the output gate.
  if (!composition.manager) throw new Error('Missing registered Run owner');
  const interactionHost = Reflect.get(composition.manager, 'sessionInteractionHost') as NativeAgentSessionInteractionHostBinding;
  function assertComposer(host: NativeAgentSessionInteractionHostBinding): asserts host is NativeAgentSessionInteractionHostBinding
    & Required<Pick<NativeAgentSessionInteractionHostBinding, 'composeRunToolBinding'>> {
    if (!host.composeRunToolBinding) throw new Error('Missing canonical Run MCP composer');
  }
  assertComposer(interactionHost);
  const compose = interactionHost.composeRunToolBinding;
  const mcpOccurrences: NativeAgentSessionRunToolBindingRequest[] = [];
  const mcpBindings = new Map<string, NativeAgentSessionRunToolBinding>();
  vi.spyOn(interactionHost, 'composeRunToolBinding').mockImplementation(async request => {
    const occurrence = request.readCurrentRunOccurrence(request.runId);
    expect(request.isCurrent(), 'Run authority must exist before native MCP composition').toBe(true);
    expect(occurrence?.isCurrent()).toBe(true);
    expect(occurrence?.runtimeLifetimeSignal.aborted).toBe(false);
    expect(request.signal.aborted).toBe(false);
    mcpOccurrences.push(request);
    const binding = await compose(request);
    mcpBindings.set(request.runId, binding);
    return binding;
  });
  const requestFor = (target = backendTarget, childSelection?: 'agentDefault') =>
    ExecutionRunStartRequestSchema.parse({ intent: 'delegate', backendTarget: target,
      ...(target === backendTarget ? { profileId: 'acme.snapshot/captured-delegate', profileSourceCustody: parentBinding.sourceCustody } : {}),
      instructions: 'Explain the captured comparison.', permissionMode: 'read_only',
      retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
      ...(childSelection ? { childSelection } : {}) });
  const start = (target = backendTarget, childSelection?: 'agentDefault') => rpc.handleRequest({
    method: sessionId + ':' + SESSION_RPC_METHODS.EXECUTION_RUN_START, callerAuthority: 'present_user',
    params: requestFor(target, childSelection),
  });
  const installCapturedSessionRoles = async () => {
    const roleSnapshot = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'snapshot-machine',
      serverHttpBaseUrl: configuration.apiServerUrl, readCredentials: async () => ownerCredentialsAvailable ? credentials : null,
      isOwnerCurrent: () => ownerCredentialsAvailable, onSettings: () => {} });
    await roleSnapshot();
    cleanups.push(async () => await roleSnapshot.dispose());
    const roleOperation = roleSnapshot.readOperationContext();
    if (!roleOperation) throw new Error('Missing captured Session Role owner');
    const roleInputs = { readMetadata: () => metadata,
      readOrganization: async () => createSessionRecordFixture({ id: sessionId }),
      readRoleSources: createRoleSourceReader({ accountId: 'snapshot-account',
        artifactStore: createCredentialedAccountArtifactStore(credentials),
        readPluginRoles: () => readPluginRoleSources(fixture.registry.contributes),
        readRawAccountSettings: async () => roleOperation.readSnapshot()?.rawSettings ?? {},
      }),
      readAccountRoleOverrides: () => {
        const snapshot = roleOperation.readSnapshot();
        return snapshot ? readAccountRoleOverridesFromSnapshot(snapshot) : { status: 'unavailable', reason: 'scope-retired' };
      },
      prepareAccountRoleOverrides: async signal => { await prepareActiveAccountRoleOverrides({ credentials,
        scopeKey: accountScopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), signal, operationContext: roleOperation }); },
      readOperationContext: () => roleOperation,
      readDefaultEngine: () => ({ agentTargetKey: 'agent:acme.snapshot/parent' }),
      readAppliedChildSelection: () => controls.readAppliedChildSelection?.() ?? { status: 'unavailable' as const },
      // The tracked runner owns this admitted registry; the cold global
      // plugin controller deliberately remains empty throughout this journey.
      readAgentCatalogSnapshot: () => fixture.registry.contributes,
    } satisfies Parameters<typeof createSessionRoleContext>[0] & {
      readAgentCatalogSnapshot: () => typeof fixture.registry.contributes;
    };
    const sessionRoles = createSessionRoleContext(roleInputs);
    applyRunnerMcpSessionContext(session, { getSessionRoleContext: () => sessionRoles,
      // Host runtime boundary: the causing Turn can be deeper than Session birth.
      // Use the same accessor installed by runHostSessionRuntime; admission stays real.
      ...(reviewsPermission ? { getActiveTurnPermissionWitness: () => reviewTurn } : {}) });
  };
  try {
    if (reviewsPermission) {
      await installCapturedSessionRoles();
      // Exercise the real Session service/codec/socket and registered Run owner.
      // Only the Home relay/authentication boundary is supplied by this fixture.
      const http = createServer();
      const relay = new SocketServer(http, { path: '/v1/updates/' });
      const authorities: string[] = [];
      relay.on('connection', client => {
        expect(client.handshake.auth.token === token).toBe(true);
        const authority = client.handshake.auth.authorityCeiling === 'account_automation' ? 'account_automation' : 'present_user';
        client.on(SOCKET_RPC_EVENTS.CALL, async (payload: SocketRpcRequestPayload, reply: (result: unknown) => void) => {
          authorities.push(authority);
          const result = await rpc.handleRequest({ ...payload, callerAuthority: authority });
          reply({ ok: true, result });
        });
      });
      await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
      const address = http.address();
      if (!address || typeof address === 'string') throw new Error('Missing reviewer RPC relay address');
      const service = createSessionClientExecutionRunService({ token, sessionId,
        serverUrl: `http://127.0.0.1:${address.port}`, getStoredContentCryptoContext: () => ({ mode: 'plain', ctx: null }) });
      const startResult = createDeferred<Awaited<ReturnType<typeof service.start>>>();
      Object.assign(session, { executionRuns: { ...service, start: async (request: unknown) => {
        try {
          const result = await service.start(request);
          startResult.resolve(result);
          return result;
        } catch (error) {
          startResult.reject(error);
          throw error;
        }
      } } });
      const installedControls = { readPermissionHandler: () => permissions,
        readAppliedChildSelection: async () => {
          if (retirement === 'reviewer_turn_changed') reviewTurn = { turnId: 'review-successor-turn', workDepth: 0 };
          return { status: 'applied' as const, backendTarget,
            modelId: 'snapshot-native-review', connectedServices: null };
        },
        resolveAccountSettingsSnapshot: qualifiedSnapshotResolver };
      installRuntimeControls(installedControls);
      parentControls = controls;
      const pending = permissions.handleToolCall('reviewed-read', 'Bash', { command: 'pwd' });
      const readAgentState = () => {
        const state = session.getAgentStateSnapshot();
        if (!state) throw new Error('Missing parent Agent state');
        return state;
      };
      try {
        await vi.waitFor(() => expect(readAgentState().requests?.['reviewed-read']).toBeDefined());
        const reviewing = permissions.respondAsApprovalReviewer('reviewed-read');
        if (retirement !== 'reviewer_off') {
          const started = await startResult.promise;
          expect(started, JSON.stringify(started)).toMatchObject(retirement === 'reviewer_depth_exceeded'
            ? { ok: false, code: 'work_depth_exceeded', details: { executionRunStart: { runCreation: 'noRunCreated' } } }
            : retirement === 'reviewer_turn_changed'
              ? { ok: false, code: 'execution_run_target_unavailable',
                details: { executionRunStart: { runCreation: 'noRunCreated' } } } : { ok: true });
        }
        const result = await reviewing;
        const runs = composition.manager.listPublic();
        if (retirement === 'reviewer_depth_exceeded' || retirement === 'reviewer_turn_changed') {
          expect(result).toBe('escalate');
          expect(runs).toEqual([]);
          expect(new Set(authorities)).toEqual(new Set(['account_automation']));
          expect(readAgentState().requests?.['reviewed-read']).toBeDefined();
          expect(readAgentState().completedRequests?.['reviewed-read']).toBeUndefined();
        } else if (retirement === 'reviewer_off') {
          expect(result).toBe('escalate');
          expect(runs).toEqual([]);
          expect(authorities).toEqual([]);
          expect(readAgentState().requests?.['reviewed-read']).toBeDefined();
        } else {
          expect({ result, runs: runs.map(run => ({ status: run.status, error: run.error?.code })) })
            .toMatchObject({ result: 'allow_once', runs: [{ status: 'succeeded' }] });
          expect(await pending).toMatchObject({ decision: 'approved' });
          expect(runs[0]).toMatchObject({ backendTarget: childTarget, permissionMode: 'no_tools' });
          expect(composition.manager.get(runs[0]!.runId)?.depth)
            .toBe(retirement === 'reviewer_nested' ? 4 : 3);
          expect(authorities.length).toBeGreaterThan(0);
          // The host reviewer is automated work under its causing Session Turn.
          expect(new Set(authorities)).toEqual(new Set(['account_automation']));
          expect(readAgentState().completedRequests?.['reviewed-read']).toMatchObject({
            permissionDecisionActorV1: { kind: 'approvalReviewer' },
            permissionDecisionClaimV1: { origin: 'approvalReviewer', scope: 'request' },
          });
          const opens = (await readFile(join(home, 'native-opens.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
          // The admitted external plugin receives its manifest-local Agent id.
          expect(opens).toMatchObject([{ agentId: 'child', modelId: 'snapshot-native-review' }]);
        }
        return;
      } finally {
        await permissions.reset();
        await pending.catch(() => undefined);
        await new Promise<void>(resolve => relay.close(() => resolve()));
      }
    }
    if (retirement === 'owner_action_starts' || retirement === 'member_action_starts') {
      const countMcpRefusals = (text: string) => text.split('\n').filter(line =>
        line.includes('mcp_execution_admission') && line.includes('agent_isolation_unavailable')
          && line.includes('"reason":')).length;
      logger.flushSync();
      const refusalsBeforeActions = countMcpRefusals(await readFile(logger.getLogPath(), 'utf8').catch(() => ''));
      if (retirement === 'owner_action_starts') {
        expect(await qualifiedSnapshotResolver.readAgentExecutionContext()).toMatchObject({
          requesterIdentity: { kind: 'isolated', separationRequired: false }, isolationEnabled: false,
        });
      }
      const installedControls = { readPermissionHandler: () => permissions,
        readAppliedChildSelection: async () => ({ status: 'applied' as const, backendTarget,
          modelId: 'snapshot-native-review', connectedServices: null }),
        resolveAccountSettingsSnapshot: qualifiedSnapshotResolver };
      installRuntimeControls(installedControls);
      parentControls = controls;
      const runActionDeps = createExecutionRunRpcActionDeps({ manager: composition.manager,
        context: { sessionId, cwd: home, resolveAccountSettings: () => getActiveAccountSettingsSnapshot()?.settings ?? null,
          getServerFeaturesSnapshot: () => serverFeatures },
        policy: resolveExecutionRunPolicy({ defaults: { maxConcurrentRuns: null, boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null, maxTurns: null } }), isExecutionRunsEnabled: () => true });
      const executor = createActionExecutor({ ...runActionDeps,
        isActionApprovalRequired: () => false,
        executionRunStart: async (targetSessionId, request) => {
          expect(targetSessionId).toBe(sessionId);
          return normalizeExecutionRunRpcPayload(await rpc.handleRequest({
            method: sessionId + ':' + SESSION_RPC_METHODS.EXECUTION_RUN_START,
            callerAuthority: 'present_user', params: request,
          }), { executionRunStart: true });
        },
      });
      const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-owner-run-actions-' });
      roots.push(repository.rootPath);
      await writeFile(join(repository.rootPath, repository.trackedPath), 'Changed fixture\n');
      const generated = await executeScmDiffSummaryAction({ sessionId, machineId: 'snapshot-machine', backendTarget: readBackendTargetRefV2(backendTarget),
        request: { cwd: repository.rootPath, source: { kind: 'workingTree' }, outputs: ['summary'],
          modelSelector: { modelId: 'snapshot-native-review' }, cachePolicy: { mode: 'bypass' } },
        executeCanonicalAction: (id, input) => executor.execute(id, input, {
          authority: 'present_user', surface: 'cli', defaultSessionId: sessionId }),
      });
      expect(generated, JSON.stringify({ success: generated.success,
        errorCode: 'errorCode' in generated ? generated.errorCode : null,
        summaryReasonCode: generated.outputs?.summary?.reasonCode,
        runs: composition.manager?.listPublic().map(run => ({ intent: run.intent, status: run.status, code: run.error?.code })),
        nativeCompositions: mcpOccurrences.length,
      })).toMatchObject({ success: true, runId: expect.any(String) });
      const delegated = await executor.execute('subagents.delegate.start', {
        sessionId, backendTargetKeys: ['agent:acme.snapshot/parent'], instructions: 'Owner Session delegated request',
        modelId: 'snapshot-native-review', connectedServices: null, permissionMode: 'read_only',
      }, { authority: 'present_user', surface: 'cli', defaultSessionId: sessionId });
      expect(delegated).toMatchObject({ ok: true });
      await vi.waitFor(async () => {
        const runs = composition.manager?.listPublic() ?? [];
        expect(runs).toHaveLength(2);
        if (retirement === 'member_action_starts') {
          expect(runs.every(run => run.status === 'failed')).toBe(true);
          expect(runs.map(run => run.error?.code)).toEqual(['agent_isolation_unavailable', 'agent_isolation_unavailable']);
          expect(sourceDemands).toBeGreaterThan(0);
          expect(await readFile(join(home, 'native-opens.jsonl'), 'utf8').catch(() => null)).toBeNull();
          return;
        }
        const failed = runs.find(run => run.status === 'failed');
        expect(failed?.error?.code).toBeUndefined();
        const opens = (await readFile(join(home, 'native-opens.jsonl'), 'utf8')).trim().split('\n');
        expect(opens).toHaveLength(2);
        expect(runs.every(run => composition.manager?.get(run.runId)?.sessionId === sessionId)).toBe(true);
        expect(mcpOccurrences).toHaveLength(2);
      }, { timeout: 10_000 });
      const summary = composition.manager?.listPublic().find(run => run.intent === 'scm_diff_summary');
      expect(summary).toMatchObject({ runClass: 'long_lived', retentionPolicy: 'resumable', ioMode: 'streaming' });
      // Voice's chat runtime must spend the identical original Session carrier,
      // not reconstruct Account authority in VoiceAgentManager's start wrapper.
      const voice = await executor.execute('execution.run.start', { sessionId,
        intent: 'voice_agent', backendTarget, instructions: 'Owner Session voice request', permissionMode: 'read_only',
        chatModelId: 'snapshot-native-review', commitModelId: 'snapshot-native-review', bootstrapMode: 'none',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', intentInput: {},
      }, { authority: 'present_user', surface: 'cli', defaultSessionId: sessionId });
      if (retirement === 'owner_action_starts') {
        expect(voice, JSON.stringify({ ok: voice.ok, code: voice.ok ? null : voice.errorCode })).toMatchObject({ ok: true });
        await vi.waitFor(async () => {
          const ownedVoice = composition.manager?.listPublic().find(run => run.intent === 'voice_agent');
          const voiceObservation = { status: ownedVoice?.status, code: ownedVoice?.error?.code,
            runIntents: composition.manager?.listPublic().map(run => run.intent),
            sourceDemands, nativeCompositions: mcpOccurrences.length, homeHttpFailures,
            envelopeKind: voice.ok && voice.result && typeof voice.result === 'object' && 'kind' in voice.result ? voice.result.kind : null };
          expect(ownedVoice?.error?.code, JSON.stringify(voiceObservation)).toBeUndefined();
          expect((await readFile(join(home, 'native-opens.jsonl'), 'utf8')).trim().split('\n'),
            JSON.stringify(voiceObservation)).toHaveLength(3);
          expect(ownedVoice).toMatchObject({ status: 'running' });
          expect(ownedVoice && composition.manager?.get(ownedVoice.runId)?.sessionId).toBe(sessionId);
        }, { timeout: 10_000 });
      } else {
        expect(voice).toMatchObject({ ok: true });
        await vi.waitFor(() => expect(composition.manager?.listPublic().find(run => run.intent === 'voice_agent'))
          .toMatchObject({ status: 'failed' }), { timeout: 10_000 });
        expect(await readFile(join(home, 'native-opens.jsonl'), 'utf8').catch(() => null)).toBeNull();
        logger.flushSync();
        const fileLog = await readFile(logger.getLogPath(), 'utf8');
        // Qualification belongs to the original Account source and is shared
        // across these three Runs, including its one logged refusal.
        expect(countMcpRefusals(fileLog) > refusalsBeforeActions, JSON.stringify({
          before: refusalsBeforeActions, after: countMcpRefusals(fileLog),
          reasons: fileLog.split('\n').filter(line => line.includes('mcp_execution_admission'))
            .map(line => line.match(/"reason":"([a-z_]+)"/)?.[1] ?? 'unprojected'),
        })).toBe(true);
        expect(fileLog.includes('Owner Session voice request')).toBe(false);
        // Voice preserves the original source's canonical isolation refusal.
        expect(composition.manager?.listPublic().find(run => run.intent === 'voice_agent')?.error?.code)
          .toBe('agent_isolation_unavailable');
      }
      return;
    }
    let inherited: unknown;
    if (retirement === 'session_close') {
      const snapshotDiagnostics = vi.spyOn(logger, 'warnLocalFile');
      const preview = await createRunnerExecutionRunSnapshotResolver({ sessionId, machineId: 'snapshot-machine' })(backendTarget);
      try {
        const profile = preview.profileCatalog.runtimeProfilesById.get('acme.snapshot/captured-delegate');
        if (!profile?.prepareStartParams) throw new Error('Missing daemon-admitted contributed profile');
        const prepared = await profile.prepareStartParams({ request: requestFor(), cwd: home, sessionId });
        expect(prepared?.instructions).toContain('daemon-admitted profile instructions');
        if (!preview.readNativeOfferedModel) throw new Error('Missing retained native model reader');
        const nativeRequest = { backendTarget, modelId: 'snapshot-native-review', cwd: home };
        const native = { ...nativeRequest, readNativeOfferedModel: preview.readNativeOfferedModel };
        await expect(assertExecutionRunStructuredOutputModelAllowed(native)).resolves.toBeUndefined();
        await expect(assertExecutionRunStructuredOutputModelAllowed({ ...native, modelId: 'snapshot-native-unknown' }))
          .rejects.toMatchObject({ code: 'model_structured_output_unsupported' });
        await expect(assertExecutionRunStructuredOutputModelAllowed({ ...native, modelId: 'not-offered' }))
          .rejects.toMatchObject({ code: 'model_structured_output_unsupported' });
        for (const route of [
          { modelSelection: ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:acme.snapshot/parent', providerConnectionId: 'snapshot-provider', modelId: native.modelId }) },
          { teamCredentialModel: { kind: 'team_credential_provider_model' as const, resourceId: 'snapshot-resource', teamId: 'snapshot-team',
            expectedResourceRevision: 1, agentTargetKey: 'agent:acme.snapshot/parent', modelId: native.modelId, deliveryMode: 'brokered' as const } },
        ]) {
          await expect(assertExecutionRunStructuredOutputModelAllowed({ ...native, ...route }))
            .rejects.toMatchObject({ code: 'model_structured_output_unsupported' });
        }
        await expect(preview.readNativeOfferedModel({ ...nativeRequest, backendTarget: childTarget }))
          .rejects.toMatchObject({ code: 'execution_run_contribution_snapshot_unavailable' });
        // The same public refusal covers distinct private operations. Its file
        // diagnostic must identify which boundary refused without logging inputs.
        expect(snapshotDiagnostics.mock.calls.map(([, details]) => details)).toContainEqual({
          sessionId,
          operation: 'execution_run.native_offered_model.read_v1',
          kind: 'protocol_error',
          retryable: false,
        });
      } finally { await preview.release?.(); }
      const diagnostics = vi.spyOn(logger, 'infoFile');
      for (const [currentControls, reason] of [
        [null, 'session_runtime_controls_unavailable'],
        [controls, 'applied_child_selection_reader_unavailable'],
      ] as const) {
        parentControls = currentControls;
        const notReady = await start();
        expect(notReady, JSON.stringify(notReady)).toMatchObject({ ok: false,
          errorCode: 'execution_run_parent_selection_unavailable',
          details: { executionRunStart: { runCreation: 'noRunCreated' } } });
        expect(diagnostics).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ sessionId, reason }));
      }
      let finishInstallation!: (ready: boolean) => void;
      const installation = new Promise<boolean>(resolve => { finishInstallation = resolve; });
      let waitingForInstallation = false;
      waitForParentControls = async () => { waitingForInstallation = true; return await installation; };
      let inheritedRefusal: unknown;
      const pendingInherited = start().then(result => {
        if (!ExecutionRunStartResponseSchema.safeParse(result).success) inheritedRefusal = result;
        return result;
      });
      await vi.waitFor(() => expect(waitingForInstallation || inheritedRefusal !== undefined).toBe(true), { timeout: 10_000 });
      expect(waitingForInstallation, JSON.stringify(inheritedRefusal)).toBe(true);
      installRuntimeControls({ readPermissionHandler: () => permissions, readAppliedChildSelection: async () => ({ status: 'applied', backendTarget,
        modelId: 'parent-applied-model', connectedServices: null }) });
      finishInstallation(true);
      inherited = await pendingInherited;
      expect(inherited, JSON.stringify(inherited)).toMatchObject({ runId: expect.any(String) });
      await vi.waitFor(async () => {
        const inputs = (await readFile(join(home, 'native-inputs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(inputs).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: 'parent',
          text: expect.stringContaining('daemon-admitted profile instructions') })]));
      }, { timeout: 10_000 });
      parentControls = null;
      let explicitParentWaits = 0;
      waitForParentControls = async () => { explicitParentWaits += 1; return false; };
      // The UI's provider-safe start uses ensure-or-start after answering the
      // cross-Agent chooser, then reads the ordinary canonical start response.
      let finishPermissionInstallation!: (ready: boolean) => void;
      const permissionInstallation = new Promise<boolean>(resolve => { finishPermissionInstallation = resolve; });
      let waitingForPermissions = false;
      waitForRuntimeControls = async () => { waitingForPermissions = true; return await permissionInstallation; };
      let earlyRunId: string | undefined;
      let earlyRefusal: unknown;
      const pendingDefaulted = rpc.handleRequest({
        method: sessionId + ':' + SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1,
        callerAuthority: 'present_user',
        params: { runId: null, resume: false, start: { ...requestFor(childTarget, 'agentDefault'),
          instructions: 'explicit-permission-owner-ready' } },
      }).then(result => {
        const response = ExecutionRunStartResponseSchema.safeParse(result);
        if (response.success) earlyRunId = response.data.runId;
        else earlyRefusal = result;
        return result;
      });
      const readEarlyRun = () => earlyRunId ? composition.manager?.getPublic(earlyRunId) : null;
      await vi.waitFor(() => expect(waitingForPermissions || earlyRefusal !== undefined || readEarlyRun()?.status === 'failed')
        .toBe(true), { timeout: 10_000 });
      expect(waitingForPermissions, JSON.stringify(earlyRefusal ?? readEarlyRun())).toBe(true);
      // Explicit selection needs the permission owner, but does not need an applied
      // parent model. Use the same real handler installed by the Session runtime.
      installRuntimeControls({ readPermissionHandler: () => permissions });
      parentControls = controls;
      finishPermissionInstallation(true);
      const defaulted = await pendingDefaulted;
      waitForRuntimeControls = undefined;
      expect(defaulted, JSON.stringify(defaulted)).toMatchObject({ runId: expect.any(String) });
      const defaultedResponse = ExecutionRunStartResponseSchema.safeParse(defaulted);
      expect(defaultedResponse.success, JSON.stringify(defaultedResponse)).toBe(true);
      expect(defaulted).toMatchObject({ ok: true, created: true,
        resolvedSelection: { source: 'explicit' } });
      expect(explicitParentWaits).toBe(0);
      await vi.waitFor(async () => {
        const current = composition.manager?.getPublic(defaultedResponse.success ? defaultedResponse.data.runId : '');
        if (current?.status === 'failed') throw new Error('Explicit child failed: ' + JSON.stringify(current.error));
        expect(await readFile(join(home, 'native-inputs.jsonl'), 'utf8')).toContain('explicit-permission-owner-ready');
      }, { timeout: 10_000 });
      const childRunId = ExecutionRunStartResponseSchema.parse(defaulted).runId;
      const childBinding = mcpOccurrences.find(request => request.runId === childRunId);
      const childOccurrence = childBinding?.readCurrentRunOccurrence(childRunId);
      const childWitness = childBinding?.readActiveTurnAdmissionWitness();
      if (!childBinding || !childOccurrence || !childWitness) throw new Error('Missing live child occurrence');
      const childAction = (occurrenceId = childOccurrence.occurrenceId, turnId = childWitness.turnId) =>
        (transport.app as ReturnType<typeof import('@/daemon/controlServer').createDaemonControlApp>).inject({
          method: 'POST', url: '/agent-runtime/session/services/v1', headers: buildDaemonControlHttpHeaders(authorityFile.capability),
          payload: { v: 1, context: { token: authorityFile.capability, sessionId }, operation: {
            kind: 'action.execute', requestId: 'snapshot-child-read', actionId: 'session.list', input: {},
            executionRun: { runId: childRunId, occurrenceId }, witness: projectAgentRuntimeDaemonServiceTurnWitnessV1({
              ...childWitness, turnId, agentStartCaller: { kind: 'session', sessionId,
                starterDepth: childBinding.workDepth, turnDepth: childBinding.workDepth } }),
          } },
        });
      // The route must admit the actual child owner before Account dispatch.
      const admittedChild = await childAction();
      expect(admittedChild.statusCode, JSON.stringify({ response: admittedChild.json(), homeHttpFailures,
        rpc: vi.mocked(sessionRpcTransport.callSessionRpc).mock.calls.map(([request]) => ({ method: request.method, request: request.request })),
        run: composition.manager?.getPublic(childRunId),
      })).toBe(200);
      expect(admittedChild.json()).toMatchObject({ ok: true, result: { kind: 'action.execution' } });
      expect((await childAction('replaced-occurrence')).statusCode).toBe(403);
      expect((await childAction(childOccurrence.occurrenceId, 'parent-turn')).statusCode).toBe(403);
      const childMcpBinding = mcpBindings.get(childRunId);
      const childMcpServer = childMcpBinding?.mcpServers?.happier;
      const mcpArgs = childMcpServer?.args;
      const mcpUrl = mcpArgs?.[mcpArgs.indexOf('--url') + 1];
      const childConnection = childMcpBinding?.sessionMcpContext
        ? await connectSessionMcpClient(childMcpBinding.sessionMcpContext)
        : await (async () => {
          if (!mcpUrl) throw new Error('Missing child MCP endpoint: ' + JSON.stringify({
            hasBinding: Boolean(childMcpBinding), serverNames: Object.keys(childMcpBinding?.mcpServers ?? {}),
            hasLocalContext: Boolean(childMcpBinding?.sessionMcpContext),
            supportedReads: childMcpBinding?.supportedSessionReadActions,
          }));
          const client = new Client({ name: 'snapshot-child-approval', version: '1' });
          await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
          return { client, close: () => client.close() };
        })();
      try {
        const commentEdit = await childConnection.client.callTool({ name: 'action_execute', arguments: { actionId: 'reviews.comments.edit', input: {
          workspace: { machineId: 'snapshot-machine', path: home }, commentId: 'snapshot-comment',
          nextBody: 'Reviewed child edit', expectedBodyVersion: 1, expectedServerRevision: 1, clientMutationId: 'snapshot-child-edit',
        } } });
        expect(commentApprovalRequests.at(-1)?.executionOriginV1, JSON.stringify({ commentEdit, homeHttpFailures })).toMatchObject({
          serverId: configuration.activeServerId, serverIdentityId: 'srv_snapshot_home',
          runId: childRunId, runOccurrenceId: childOccurrence.occurrenceId,
          sessionId, actionId: 'reviews.comments.edit',
        });
      } finally { await childConnection.close(); }
      parentControls = null;
      waitForRuntimeControls = async () => false;
      const withdrawn = await start(childTarget, 'agentDefault');
      expect(withdrawn, JSON.stringify(withdrawn)).toMatchObject({ ok: false,
        errorCode: 'execution_run_interaction_unavailable',
        details: { executionRunStart: { runCreation: 'noRunCreated' } } });
      waitForRuntimeControls = undefined;
      parentControls = controls;
      installRuntimeControls({ readPermissionHandler: () => permissions, readAppliedChildSelection: async () => ({ status: 'applied', backendTarget,
        modelId: 'snapshot-provider-model', modelSelection: ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:acme.snapshot/parent',
          providerConnectionId: 'snapshot-provider', modelId: 'snapshot-provider-model' }), connectedServices: null }) });
      const providerChild = await start(childTarget);
      expect(providerChild, JSON.stringify(providerChild)).toMatchObject({ runId: expect.any(String) });
      const providerChildRunId = ExecutionRunStartResponseSchema.parse(providerChild).runId;
      await vi.waitFor(async () => {
        const run = composition.manager?.getPublic(providerChildRunId);
        if (run?.status === 'failed') throw new Error('Pinned Provider child failed: ' + JSON.stringify(run.error));
        const opens = (await readFile(join(home, 'native-opens.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(opens).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: 'child', modelId: 'snapshot-provider-model', nativeCliPath: nativeCliPaths.child,
          providerConnectionId: 'snapshot-provider', materializedProviderModel: 'snapshot-provider-model' })]));
      }, { timeout: 10_000 });
      expect(daemonRequests.some(request => request.operation.kind === 'execution_run.provider.admit_v1')).toBe(true);
      expect(daemonRequests.some(request => request.operation.kind === 'execution_run.provider.prepare_v1')).toBe(true);
      expect(pluginReloadController.getState().activeRegistry).toBeNull();
      installRuntimeControls({ readPermissionHandler: () => permissions, readAppliedChildSelection: async () => ({ status: 'applied', backendTarget,
        modelId: 'snapshot-provider-model', modelSelection: ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:acme.snapshot/parent',
          providerConnectionId: 'snapshot-unverified-provider', modelId: 'snapshot-provider-model' }), connectedServices: null }) });
      const unverifiedProviderChild = await start(childTarget);
      expect(unverifiedProviderChild, JSON.stringify(unverifiedProviderChild)).toMatchObject({ ok: false,
        errorCode: 'execution_run_child_choice_required', details: { childChoice: { parentRouteCompatibility: 'unverified' },
          executionRunStart: { runCreation: 'noRunCreated' } } });
      installRuntimeControls({ readPermissionHandler: () => permissions, readAppliedChildSelection: async () => ({ status: 'applied', backendTarget,
        modelId: 'parent-applied-model', connectedServices: null }) });
      // A public role start must use this Session's captured Account, even when
      // another Account is focused. Real registration, role policy and installed
      // plugin execution remain composed; only Home/native boundaries are fixtures.
      await installCapturedSessionRoles();
      const focusedSnapshot = { scopeKey: 'unrelated-focused-account', source: 'network' as const,
        settings: AccountSettingsSchema.parse({}), rawSettings: {}, settingsVersion: 99, loadedAtMs: Date.now(), settingsSecretsReadKeys: [] };
      setActiveAccountSettingsSnapshot(focusedSnapshot);
      const secondOpinionRequest = ExecutionRunStartRequestSchema.parse({ intent: 'review', roleId: 'second_opinion', backendTarget,
          instructions: 'second-opinion-role-fixture', modelId: 'snapshot-native-review', permissionMode: 'read_only',
          retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' });
      const secondOpinionStarted = await rpc.handleRequest({
        method: sessionId + ':' + SESSION_RPC_METHODS.EXECUTION_RUN_START, callerAuthority: 'present_user',
        params: secondOpinionRequest,
      });
      expect(secondOpinionStarted, JSON.stringify(secondOpinionStarted)).toMatchObject({ runId: expect.any(String) });
      const secondOpinionRunId = ExecutionRunStartResponseSchema.parse(secondOpinionStarted).runId;
      await composition.manager?.waitForTerminal(secondOpinionRunId);
      expect(composition.manager?.getPublic(secondOpinionRunId)).toMatchObject({ status: 'succeeded', intent: 'task' });
      expect(composition.manager?.getLatestToolResult(secondOpinionRunId)).toMatchObject({ verdict: 'agree', risks: [] });
      expect(composition.manager?.get(secondOpinionRunId)?.instructions).toContain('OWNER_SECOND_OPINION_INSTRUCTIONS');
      expect(await readFile(join(home, 'native-inputs.jsonl'), 'utf8')).toContain('OWNER_SECOND_OPINION_INSTRUCTIONS');
      expect(getActiveAccountSettingsSnapshot()).toBe(focusedSnapshot);
      const runIdsBeforeRefusal = composition.manager?.listPublic().map(run => run.runId);
      roleArtifactsAvailable = false;
      const unavailableSource = await rpc.handleRequest({
        method: sessionId + ':' + SESSION_RPC_METHODS.EXECUTION_RUN_START, callerAuthority: 'present_user',
        params: secondOpinionRequest,
      });
      expect(normalizeExecutionRunRpcPayload(unavailableSource, { executionRunStart: true }), JSON.stringify({ unavailableSource, homeHttpFailures })).toMatchObject({
        ok: false, code: 'role_source_incomplete', details: { executionRunStart: { runCreation: 'noRunCreated',
          refusal: { code: 'role_source_incomplete', phase: 'agent_start_context' } } },
      });
      roleArtifactsAvailable = true;
      ownerCredentialsAvailable = false;
      const refusedRoleStart = await rpc.handleRequest({
        method: sessionId + ':' + SESSION_RPC_METHODS.EXECUTION_RUN_START, callerAuthority: 'present_user',
        params: secondOpinionRequest,
      });
      // Credential retirement is refused by Account governance before Role
      // admission. Keep that producer's typed code rather than relabeling it.
      expect(refusedRoleStart).toMatchObject({ ok: false, errorCode: 'provider_authorization_changed',
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } });
      expect(ExecutionRunStartFailureDetailsV1Schema.parse(Reflect.get(refusedRoleStart as object, 'details')))
        .toEqual(Reflect.get(refusedRoleStart as object, 'details'));
      expect(normalizeExecutionRunRpcPayload(refusedRoleStart, { executionRunStart: true })).toMatchObject({
        ok: false, code: 'provider_authorization_changed', details: { executionRunStart: { runCreation: 'noRunCreated' } },
      });
      expect(composition.manager?.listPublic().map(run => run.runId)).toEqual(runIdsBeforeRefusal);
      ownerCredentialsAvailable = true;
      setActiveAccountSettingsSnapshot({ scopeKey: accountScopeKey, source: 'network',
        settings: AccountSettingsSchema.parse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
        providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: fixture.providerCatalog } });
      const reviewStarted = await rpc.handleRequest({
        method: sessionId + ':' + SESSION_RPC_METHODS.EXECUTION_RUN_START, callerAuthority: 'present_user',
        params: ExecutionRunStartRequestSchema.parse({ intent: 'review', backendTarget,
          profileId: 'acme.snapshot/captured-review', profileSourceCustody: parentBinding.sourceCustody,
          instructions: 'review-host-action-fixture', modelId: 'snapshot-native-review', permissionMode: 'read_only',
          retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' }),
      });
      expect(reviewStarted, JSON.stringify(reviewStarted)).toMatchObject({ runId: expect.any(String) });
      const reviewRunId = ExecutionRunStartResponseSchema.parse(reviewStarted).runId;
      await composition.manager?.waitForTerminal(reviewRunId);
      expect(composition.manager?.getPublic(reviewRunId)).toMatchObject({ status: 'succeeded' });
      const reviewAction = await rpc.handleRequest({
        method: sessionId + ':' + SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, callerAuthority: 'present_user',
        params: { runId: reviewRunId, actionId: 'reviews.comments.create' },
      });
      expect(reviewAction).toMatchObject({ ok: false, errorCode: 'execution_run_host_action_current_intent_unavailable' });
      expect(reviewApprovalRequests).toEqual([expect.objectContaining({ actionId: 'reviews.comments.create',
        sessionId, runId: reviewRunId, pluginId: 'acme.snapshot', profileId: 'acme.snapshot/captured-review', proposalCount: 1 })]);
      const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-snapshot-review-' });
      roots.push(repository.rootPath);
      const comparison = await captureScmComparison({ cwd: repository.rootPath, sessionId, source: { kind: 'workingTree' },
        registry: await resolveDefaultScmBackendRegistry({ pluginRuntimeRegistry: fixture.registry }) });
      const retainedReview = await rpc.handleRequest({
        method: sessionId + ':' + SESSION_RPC_METHODS.EXECUTION_RUN_START, callerAuthority: 'present_user',
        params: ExecutionRunStartRequestSchema.parse({ intent: 'review', backendTarget,
          profileId: 'acme.snapshot/captured-retained-review', profileSourceCustody: parentBinding.sourceCustody,
          cwd: repository.rootPath, modelId: 'snapshot-native-review', instructions: 'review-host-action-fixture',
          intentInput: { comparisonId: comparison.comparison.id }, localInputId: 'snapshot-review-initial', permissionMode: 'read_only',
          retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' }),
      });
      expect(retainedReview, JSON.stringify(retainedReview)).toMatchObject({ runId: expect.any(String) });
      const retainedReviewId = ExecutionRunStartResponseSchema.parse(retainedReview).runId;
      await vi.waitFor(() => {
        expect(composition.manager?.getStructuredMeta(retainedReviewId)).toMatchObject({ kind: 'review_findings.v2' });
        expect(composition.manager?.getPublic(retainedReviewId)).toMatchObject({ status: 'running', turnInFlight: false });
      });
      const continuedReview = await rpc.handleRequest({
        method: sessionId + ':' + SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, callerAuthority: 'present_user',
        params: { runId: retainedReviewId, actionId: 'review.walkthrough',
          input: { reviewRunIds: [retainedReviewId], comparisonId: comparison.comparison.id } },
      });
      expect(continuedReview, JSON.stringify(continuedReview)).toMatchObject({ ok: true, result: { runId: retainedReviewId, mode: 'continued_review' } });
      expect(pluginReloadController.getState().activeRegistry).toBeNull();
      const choice = await start(childTarget);
      expect(choice).toMatchObject({ ok: false, errorCode: 'execution_run_child_choice_required',
        details: { childChoice: expect.any(Object) } });
      expect(normalizeExecutionRunRpcPayload(choice, { executionRunStart: true })).toMatchObject({
        ok: false, code: 'execution_run_child_choice_required', details: { childChoice: expect.any(Object) },
      });
      for (const method of [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
        SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1]) {
        const rowless = await rpc.handleRequest({
          method: sessionId + ':' + method, callerAuthority: 'present_user',
          params: { runId: null, resume: false, start: requestFor(childTarget) },
        });
        expect(rowless).toMatchObject({ ok: false, errorCode: 'execution_run_child_choice_required',
          details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' }, childChoice: expect.any(Object) } });
      }
      await vi.waitFor(async () => {
        for (const started of [inherited, defaulted]) {
          const run = composition.manager?.getPublic(ExecutionRunStartResponseSchema.parse(started).runId);
          if (run?.status === 'failed') throw new Error('Native child Run failed: ' + JSON.stringify(run.error));
        }
        const opens = (await readFile(join(home, 'native-opens.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(opens).toEqual(expect.arrayContaining([
          expect.objectContaining({ agentId: 'parent', modelId: 'parent-applied-model', sessionId, nativeCliPath: nativeCliPaths.parent }),
          expect.objectContaining({ agentId: 'child', modelId: null, sessionId, nativeCliPath: nativeCliPaths.child }),
        ]));
      }, { timeout: 10_000 });
      for (const started of [inherited, defaulted]) {
        const runId = ExecutionRunStartResponseSchema.parse(started).runId;
        expect(mcpOccurrences.some(request => request.runId === runId)).toBe(true);
      }
      const inheritedRunId = ExecutionRunStartResponseSchema.parse(inherited).runId;
      const owned = composition.manager?.get(inheritedRunId);
      if (!owned) throw new Error('Missing canonical admitted Run');
      await retainExecutionRunState({ ...owned, runId: 'other-session-run', sessionId: 'other-session' });
      const app = transport.app as ReturnType<typeof import('@/daemon/controlServer').createDaemonControlApp>;
      const materialize = (runId: string) => app.inject({ method: 'POST', url: '/connected-service-run/materialize',
        headers: { 'x-happier-daemon-token': deriveConnectedServiceRunMaterializeToken(daemon.controlToken) },
        payload: { activationId: randomUUID(), runId, runnerPid: process.pid, agentId: 'codex', cwd: home,
          connectedServices: { v: 2, bindingsByServiceId: {} } } });
      for (const runId of ['missing-run', 'other-session-run']) {
        expect((await materialize(runId)).json()).toMatchObject({
          errorCode: 'connected_service_run_materialization_blocked',
          errorMessage: 'Execution-run connected services runner identity is not current',
        });
      }
      // This deliberately native input has no subscription to issue. The real HTTP
      // materializer must reach credential resolution for the owned Run, while a
      // missing or other-Session Run refuses before that boundary.
      const ownedMaterialization = await materialize(inheritedRunId);
      expect(ownedMaterialization.json()).not.toMatchObject({
        errorMessage: 'Execution-run connected services runner identity is not current',
      });
    } else {
      installRuntimeControls({ readPermissionHandler: () => permissions });
      parentControls = controls;
    }
    // Complete a retained turn and send another through the real native loader
    // and daemon snapshot channel, before any fixture retirement or reload.
    const retainedOwner = composition.manager;
    const retainedResponse = await rpc.handleRequest({
      method: sessionId + ':' + SESSION_RPC_METHODS.EXECUTION_RUN_START, callerAuthority: 'present_user',
      params: ExecutionRunStartRequestSchema.parse({ intent: 'delegate', backendTarget: childTarget, childSelection: 'agentDefault',
        instructions: 'retained-snapshot-turn-1', permissionMode: 'read_only',
        localInputId: 'retained-initial',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' }),
    });
    expect(retainedResponse, JSON.stringify(retainedResponse)).toMatchObject({ runId: expect.any(String) });
    const retained = ExecutionRunStartResponseSchema.parse(retainedResponse);
    await vi.waitFor(() => {
      expect(retainedOwner.get(retained.runId)).toMatchObject({ sessionId });
      const current = retainedOwner.getPublic(retained.runId);
      const firstTurn = [current?.inputTurns?.current, current?.inputTurns?.last]
        .find(turn => turn?.inputIds.includes('retained-initial'));
      expect(firstTurn, JSON.stringify(current)).toMatchObject({ state: 'completed' });
      expect(current).toMatchObject({ status: 'running', turnInFlight: false });
    }, { timeout: 10_000 });
    expect(await retainedOwner.send(retained.runId, { message: 'retained-snapshot-turn-2', localInputId: 'retained-followup' }))
      .toMatchObject({ ok: true });
    expect(await retainedOwner.waitForInputTurn(retained.runId, 'retained-followup')).toMatchObject({ turn: { state: 'completed' } });
    expect(await readFile(join(home, 'native-inputs.jsonl'), 'utf8')).toContain('retained-snapshot-turn-2');
    expect(retainedOwner.getPublic(retained.runId)).toMatchObject({ status: 'running', turnInFlight: false });
    const nativeChildPids = (await readFile(join(home, 'native-child-pids.jsonl'), 'utf8')).trim().split('\n').map(Number);
    expect(nativeChildPids.length).toBeGreaterThan(0);
    for (const pid of nativeChildPids) expect(() => process.kill(pid, 0)).not.toThrow();
    if (retirement === 'planned_refresh_then_stop') {
      // A planned signal and definitive Stop share the real Session lifecycle.
      // The primary native runtime is an external boundary: hold its disposal
      // to prove child retirement is not queued behind it or transport close.
      const retireRunner = async (event?: RunnerTerminationEvent) => {
        let releasePrimary!: () => void;
        const primaryDisposed = new Promise<void>(resolve => { releasePrimary = resolve; });
        let releaseLoop!: () => void;
        const loop = new Promise<void>(resolve => { releaseLoop = resolve; });
        let terminate: ((event: RunnerTerminationEvent) => void) | undefined;
        const base = createLifecycleParams({ policyAgentId: backendTarget.agentId });
        Object.assign(session, { sessionHandlersRegistration: registration,
          disposeExecutionRuns: () => ApiSessionClient.prototype.disposeExecutionRuns.call(session),
          endSessionAndClose: async () => { await registration.dispose(); } });
        const primaryRuntime = { ...base.runtime, resetOrDisposeRuntime: async () => { await primaryDisposed; } };
        const running = runSessionLoopLifecycle({ ...base, session,
          runtimeDirectory: home, runtimeMetadata: metadata,
          runtime: primaryRuntime, hookRuntime: { ...base.hookRuntime, ...primaryRuntime },
          deps: { ...base.deps, cleanupBackendRunResourcesFn: cleanupBackendRunResources,
            runPermissionModePromptLoopFn: async () => { await loop; },
            registerRunnerTerminationHandlersFn: input => {
              const handlers = registerRunnerTerminationHandlers({ ...input,
                processLifecycleOwnership: 'caller', sessionExitReport: null, exit: () => undefined });
              terminate = handlers.requestTermination;
              return handlers;
            } },
        });
        try {
          await vi.waitFor(() => expect(terminate).toBeTypeOf('function'));
          const ownedPids = (await readFile(join(home, 'native-child-pids.jsonl'), 'utf8')).trim().split('\n').map(Number);
          if (!event) {
            // Ordinary mode handoff disposes the foreground runtime, but
            // preserves this Session's independent retained child work.
            releasePrimary(); releaseLoop();
            await running;
            for (const pid of ownedPids) expect(() => process.kill(pid, 0)).not.toThrow();
            return;
          }
          terminate!(event);
          await vi.waitFor(() => {
            for (const pid of ownedPids) expect(() => process.kill(pid, 0)).toThrow();
          }, { timeout: task.timeout });
        } finally {
          releasePrimary(); releaseLoop();
          await running;
        }
      };
      await retireRunner();
      expect(retainedOwner.getPublic(retained.runId)).toMatchObject({ status: 'running', turnInFlight: false });
      await retireRunner({ kind: 'signal', signal: 'SIGTERM' });
      expect(retainedOwner.getPublic(retained.runId)).toMatchObject({ status: 'cancelled' });
      // Replacement uses the same admitted external-plugin source but owns a
      // fresh manager and a fresh native PID. No old-generation adoption path.
      rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
      registration = register();
      const replacementResponse = await rpc.handleRequest({
        method: sessionId + ':' + SESSION_RPC_METHODS.EXECUTION_RUN_START, callerAuthority: 'present_user',
        params: ExecutionRunStartRequestSchema.parse({ intent: 'delegate', backendTarget: childTarget,
          childSelection: 'agentDefault', instructions: 'retained-snapshot-turn-1', permissionMode: 'read_only',
          localInputId: 'replacement-initial', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' }),
      });
      const replacementRun = ExecutionRunStartResponseSchema.parse(replacementResponse);
      await vi.waitFor(async () => {
        expect(composition.manager?.getPublic(replacementRun.runId)).toMatchObject({ status: 'running', turnInFlight: false });
        expect((await readFile(join(home, 'native-child-pids.jsonl'), 'utf8')).trim().split('\n').length)
          .toBeGreaterThan(nativeChildPids.length);
      }, { timeout: 10_000 });
      await retireRunner({ kind: 'killSession' });
      expect(composition.manager?.getPublic(replacementRun.runId)).toMatchObject({ status: 'cancelled' });
      return;
    }
    expect(pluginReloadController.getState().activeRegistry).toBeNull();
    // Actual controller disposal observes lease custody, rather than release call counts.
    const disposed = vi.spyOn(fixture.registry, 'dispose');
    await fixture.lease.release();
    const replacement = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: home,
      contributes: createResolvedContributionRegistry({}), pluginIds: [] });
    await fixture.controller.adoptPreparedRuntimeRegistry({ registry: replacement,
      changedPluginIds: ['acme.snapshot'], runningSessionDisposition: 'retainRunningSessions' });
    expect(disposed).not.toHaveBeenCalled();
    // Executable custody survives reload, but cannot authorize a present write.
    expect(await readReviewAuthority('acme.snapshot')).toBeNull();
    // Control of the incumbent Run must use its admitted profile, not attempt
    // a new executable acquisition from the replacement's empty catalog.
    const incumbentAction = await composition.manager?.applyAction(
      ExecutionRunStartResponseSchema.parse(inherited).runId, { actionId: 'snapshot.unsupported', input: {} },
    ).catch(error => ({ ok: false, errorCode: error.code }));
    expect(incumbentAction).toMatchObject({ ok: false, errorCode: 'execution_run_action_not_supported' });
    const parentSnapshot = [...snapshots].reverse().find(snapshot => snapshot.agent?.binding.agentId === parentBinding.agentId);
    if (!parentSnapshot) throw new Error('Missing admitted parent Run snapshot');
    expect(parentSnapshot.agent?.binding.sourceCustody).toEqual(parentBinding.sourceCustody);
    // Session close must retire its child Runs through the real registration,
    // without a test-only call to the manager masking missing lifecycle wiring.
    await registration.dispose();
    expect(retainedOwner.getPublic(retained.runId)).toMatchObject({ status: 'cancelled' });
    await vi.waitFor(() => {
      for (const pid of nativeChildPids) expect(() => process.kill(pid, 0)).toThrow();
    }, { timeout: task.timeout });
    for (const request of mcpOccurrences) {
      expect(request.isCurrent()).toBe(false);
      expect(request.readCurrentRunOccurrence(request.runId)).toBeNull();
    }
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledTimes(1));
    expect(daemonRequests.some(request => request.operation.kind === 'execution_run.snapshot.release_v1')).toBe(true);
    // An abandoned catalog acquisition is reclaimed through the same tracked
    // exit callback as a Run whose runner dies before reporting cleanup.
    const resolver = createRunnerExecutionRunSnapshotResolver({ sessionId, machineId: 'snapshot-machine' });
    await resolver();
    const replacementDisposed = vi.spyOn(replacement, 'dispose');
    const next = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: home,
      contributes: createResolvedContributionRegistry({}), pluginIds: [] });
    await fixture.controller.adoptPreparedRuntimeRegistry({ registry: next,
      changedPluginIds: [], runningSessionDisposition: 'retainRunningSessions' });
    expect(replacementDisposed).not.toHaveBeenCalled();
    // A replacement between the actual daemon response and consumer admission
    // cannot publish an acquired snapshot. Exit cleanup reclaims its old lease.
    replaceAuthorityAfterAcquisition = true;
    await expect(resolver()).rejects.toMatchObject({ code: 'native_agent_privileged_effect_authority_unavailable' });
    await daemon.onChildExited(launcherPid, { reason: 'process-exited', code: 0, signal: null });
    expect(trackedSessions.has(launcherPid)).toBe(false);
    expect(await readReviewAuthority('acme.snapshot')).toBeNull();
    await vi.waitFor(() => expect(replacementDisposed).toHaveBeenCalledTimes(1));
    await expect(resolver()).rejects.toMatchObject({ code: 'native_agent_privileged_effect_authority_unavailable' });
  } finally {
    await composition.manager?.dispose?.(); await registration.dispose(); await daemon.stopControlServer(); await fixture.dispose();
    sourceLifetime.abort();
    await snapshotResolver.dispose();
    applySessionRuntimeControls(controls, null);
    cleanups.splice(0);
  }
}, 180_000);
