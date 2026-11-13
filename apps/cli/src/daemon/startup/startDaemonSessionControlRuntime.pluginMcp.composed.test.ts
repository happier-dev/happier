import { join } from 'node:path';
import { ChildProcess } from 'node:child_process';
import axios from 'axios';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { configuration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { readRequesterSessionCredentialsForChild, requesterSessionCredentialPath, REQUESTER_SESSION_ID_ENV } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import * as processIdentity from '@/daemon/processIdentity';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { createRunnerAgentSessionRuntimeSource } from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import { AGENT_RUNTIME_DAEMON_SERVICES_PATH, AgentRuntimeDaemonServiceRequestV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry/registry';
import { applyRunnerMcpSessionContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { probeMcpStdioServerTools } from '@/mcp/servers/probeMcpStdioServerTools';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { reportSessionRunnerFailure } from '@/cli/resolveSessionRunnerFailureExitCode';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { logger } from '@/ui/logger';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createMachineSessionSpawnRpcHandler } from '@/session/actions/sessionLifecycleActions';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionTeamCredentialLaunchUnavailableError } from '@/session/services/sessionTeamCredentialLaunch';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { buildCodexAppServerConfigOverrides, assignInjectedServerKeys } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/config/overrides';
import { resolveClaudeLaunchSettingsOverlayArgs } from '../../../../../packages/plugins/claude/src/agent/runtime/launchSettings';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// Only the private HTTP listener is substituted. Installation, source custody,
// runner admission, daemon dispatch, attachment and MCP discovery stay real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); boundary.control = null; });

it.each([
  { nativeCollision: false, member: false },
  { nativeCollision: true, member: false },
  { nativeCollision: true, member: true },
])('delivers only an admitted external plugin and retires reapply/Stop attachments (%o)', async ({ nativeCollision, member }) => {
  const pluginId = 'acme.project-launch';
  const serverId = `plugin:${pluginId}/tools`;
  const homeId = 'srv_mcp_fixture';
  const profileId = 'session-home';
  const wireName = nativeCollision ? 'tools_2' : 'tools';
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, member, {
    manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: {
      agents: [{ id: 'agent', title: 'Fixture Agent', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }],
      mcp: { servers: [{ id: 'tools', kind: 'dynamic', sessionScope: 'session', title: 'Fixture tools' }],
        discoverySources: nativeCollision ? [{ id: 'native-config', title: 'Native fixture', loadedInHappierSessions: true,
          metadata: { agentId: `${pluginId}/agent` } }] : [] },
    } }),
    files: {
      'agent.mjs': `export function factory() { return { sessions: { open() { throw new Error('Native launch is observed separately'); } } }; }`,
      'daemon.mjs': `import { factory } from './agent.mjs';
        export function activate(api) {
          api.agents.register('agent', factory, { sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } });
          ${nativeCollision ? `api.mcp.registerDiscoverySource('native-config', async () => ({ items: [],
            endpoints: [{ id: 'native-tools', name: 'tools', kind: 'http', url: 'https://native.example.test/mcp' }] }));` : ''}
          api.mcp.registerServer('tools', {
            async listTools() { return { items: [{ name: 'echo', inputSchema: { type: 'object' } }] }; },
            async callTool(input) { return { echoed: input }; },
            async listResources() { return { items: [] }; }, async listResourceTemplates() { return { items: [] }; },
            async readResource(request) { return { contents: [{ uri: request.uri, text: '' }] }; },
            async subscribeResource() { return { dispose() {} }; }, async listPrompts() { return { items: [] }; },
            async getPrompt() { return { messages: [] }; }, async dispose() {}
          });
        }`,
    },
  }, undefined, { serverId: profileId, homeServerIdentityId: homeId, externalActionAccountId: member ? 'custodian' : 'requester',
    machineAccess: { custodianAccountId: member ? 'custodian' : 'requester', role: member ? 'use' : 'manage' } });
  await updateSettings(current => ({ ...current, servers: { ...current.servers, [profileId]: {
    id: profileId, name: 'Session Home', serverUrl: 'https://session-home.test', webappUrl: 'https://session-home.test',
    createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
    homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: 'https://session-home.test',
      revision: 1, endpoints: [{ kind: 'https', url: 'https://session-home.test' }] },
  } } }));
  vi.stubEnv(REQUESTER_SESSION_ID_ENV, h.sessionId);
  const childCredentials = await readRequesterSessionCredentialsForChild(requesterSessionCredentialPath({
    happyHomeDir: h.f.directory, sessionId: h.sessionId, attribution: h.tracked.requesterWorkAttributionV1!,
  }));
  if (!childCredentials) throw new Error('Missing genuine child requester credential custody');
  expect(childCredentials.requesterSessionCredentialScope?.requesterSession?.homeServerIdentityId).toBe(homeId);
  expect(childCredentials.requesterSessionCredentialScope?.requesterSession?.attribution.serverId).toBe(profileId);
  const runnerCommand = `${process.execPath} ${join(h.f.directory, '.runner-snapshots', 'fixture-runner', 'index.mjs')}`;
  // Tokens remain distinct; Account ownership comes from the actual Machine
  // row and immutable Session birth, never token equality or a changed birth.
  expect(h.tracked.requesterWorkAttributionV1?.accountId).toBe('requester');
  expect(h.requester.bootstrap.attribution.accountId).toBe('requester');
  expect(h.requester.bootstrap.credentials.token).not.toBe('custodian-token');
  h.runner.snapshotIdentity = 'snapshot:fixture-runner';
  h.runner.processCommandHash = hashProcessCommand(runnerCommand);
  h.tracked.processCommandHash = h.runner.processCommandHash;
  vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue({ pid: process.pid,
    processStartTimeMs: h.runner.processStartTimeMs, command: runnerCommand });
  const authorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing });
  await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: h.f.directory, publicReleaseRing: configuration.publicReleaseRing,
    path: authorityFilePath, sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, httpPort: 43129 });
  const homeFetch = globalThis.fetch;
  const endpoints: string[] = [];
  let nativeDiscoveries = 0;
  vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(String(url)).pathname !== AGENT_RUNTIME_DAEMON_SERVICES_PATH) return await homeFetch(url, init);
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
    if (request.operation.kind === 'mcp.plugin.discover') nativeDiscoveries += 1;
    const delivery = new AbortController();
    const response = await boundary.control!.agentRuntimeDaemonServices!.dispatch(request, {
      sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, trackedSession: h.tracked,
      invocationContext: h.tracked.runnerAgentInvocationContext!, isCurrent: async () => true,
      signal: init?.signal ? AbortSignal.any([init.signal, delivery.signal]) : delivery.signal,
    });
    if (response.ok && response.result.kind === 'mcp.plugin.materialized') {
      for (const server of response.result.servers) {
        if (server.id === serverId && (server.transport.kind === 'http' || server.transport.kind === 'sse')) endpoints.push(server.transport.url);
      }
    }
    // A delivered response closes its HTTP request lifetime. Real discovery
    // below must still work against the Session-owned hosted endpoint.
    delivery.abort();
    return Response.json(response);
  });
  const source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing, authorityFilePath, expectedSessionId: h.sessionId });
  if (!source) throw new Error('Missing real runner admission');
  let runnerExited = false;
  onTestFinished(() => runnerExited ? undefined : source.retire?.());
  const engines = await resolveCliEngineRegistry({ happyHomeDir: h.f.directory, backendId: source.identity.backendId,
    requireRunnerAgentSessionRuntimeSource: true, runnerAgentSessionRuntimeSource: source });
  const resolution = await engines.resolveForBackendId(source.identity.backendId);
  if (!resolution) throw new Error('Missing runner engine');
  const plan = await resolution.engineAdapter.runtimeCore.createSessionRuntime({ credentials: childCredentials,
    directory: h.cwd, backendTarget: { kind: 'backend', backendId: source.identity.backendId } });
  const bridge = plan.deps?.sessionLoopLifecycleDeps?.daemonTurnContributionsBridge;
  const catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [], bindings: [] });
  const settings = accountSettingsParse({});
  if (nativeCollision && !member) {
    const missing = await h.dispatch({ kind: 'mcp.plugin.discover', preparationId: 'd123e109-9973-4cf7-b50b-95e764e77b82' });
    expect(missing).toMatchObject({ ok: false, error: { code: 'plugin_mcp_preparation_unavailable' } });
    const preparation = await bridge!.pluginMcp!.prepare({ catalog, directory: h.cwd });
    expect((await preparation.discoverNativeServers()).map(server => server.name)).toContain('tools');
    await preparation.dispose();
    await expect(preparation.discoverNativeServers()).rejects.toThrow();
    const cancelled = new AbortController();
    const aborted = await bridge!.pluginMcp!.prepare({ catalog, directory: h.cwd, signal: cancelled.signal });
    cancelled.abort();
    await expect(aborted.discoverNativeServers()).rejects.toThrow();
    await aborted.dispose();
    // Preparation close never becomes a new authority or reopens discovery.
    await aborted.dispose();
    await expect(aborted.discoverNativeServers()).rejects.toThrow();
    nativeDiscoveries = 0;
  }
  const session = applyRunnerMcpSessionContext({ sessionId: h.sessionId,
    getServerBinding: () => ({ serverId: profileId, serverUrl: 'https://session-home.test' }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: h.sessionId, encryptionMode: 'plain' }), updateMetadata() {},
    enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }),
  }, { getPluginMcpPort: () => bridge?.pluginMcp ?? null });
  const input = { session, credentials: childCredentials, accountSettings: settings, isolationEnabled: false,
    accountSettingsSnapshot: { source: 'network' as const, settings, settingsVersion: 1, loadedAtMs: 1,
      settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(h.f.bootstrap.credentials.token),
      mcpServerCatalog: { status: 'ready' as const, authority: 'active' as const, catalog, revision: 1, diagnostics: [] } },
    machineId: 'machine', directory: h.cwd, agentId: source.identity.backendId, agentAcceptsUserMcp: true,
    mcpToolControl: { off: 'hidden' as const, approval: 'native' as const },
    includeHappierMcpServer: false as const, tmpDir: h.f.directory,
    sessionMetadata: { mcpSelectionV1: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [serverId], forceExcludeServerIds: [] } },
  };
  vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
  if (member) {
    await expect(resolveRunnerMcpServers(input)).rejects.toMatchObject({ code: 'agent_isolation_unavailable', retryable: false });
    expect(nativeDiscoveries).toBe(0);
    expect(endpoints).toHaveLength(0);
    await source.retire?.();
    runnerExited = true;
    return;
  }
  const first = await resolveRunnerMcpServers(input);
  onTestFinished(() => first.happierMcpServer.stop());
  expect(Object.keys(first.mcpServers)).toEqual([wireName]);
  expect(first.mcpServerIdentities?.[wireName]).toMatchObject({ serverId, plugin: { pluginId, localId: 'tools' } });
  expect(first.mcpToolPolicy?.[wireName]).toEqual({ unlisted: 'ask', tools: {} });
  const key = assignInjectedServerKeys([wireName]).get(wireName);
  expect(buildCodexAppServerConfigOverrides(first.mcpServers, { mcpToolPolicy: first.mcpToolPolicy }))
    .toContain(`mcp_servers.${key}.default_tools_approval_mode="prompt"`);
  const claudeArgs = resolveClaudeLaunchSettingsOverlayArgs({ args: [], interactionKind: 'noninteractive_sdk',
    permissionMode: 'default', launchSettings: {}, mcpToolPolicy: first.mcpToolPolicy });
  expect(claudeArgs.join(' ')).toContain(`mcp__${wireName}`);
  expect((await probeMcpStdioServerTools({ config: first.mcpServers[wireName]! })).tools.map(tool => tool.name)).toEqual(['echo']);

  // Reapply owns a new attachment. Retiring the previous applied profile must
  // close its endpoint without closing the successor.
  const second = await resolveRunnerMcpServers({ ...input, session: applyRunnerMcpSessionContext(session, { getPermissionMode: () => 'yolo' }) });
  onTestFinished(() => second.happierMcpServer.stop());
  expect(second.mcpToolPolicy?.[wireName]).toEqual({ unlisted: 'allow', tools: {} });
  expect(endpoints).toHaveLength(2);
  expect(endpoints[0]).not.toBe(endpoints[1]);
  first.happierMcpServer.stop();
  await vi.waitFor(async () => { await expect(homeFetch(endpoints[0]!)).rejects.toThrow(); });
  expect((await probeMcpStdioServerTools({ config: second.mcpServers[wireName]! })).tools.map(tool => tool.name)).toEqual(['echo']);
  // The launched bridge holds the endpoint bearer; any other local caller of the loopback port is refused.
  expect((await homeFetch(endpoints[1]!, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status).toBe(401);
  // Same Account separation cannot admit an untracked Session. Keep the
  // genuine bridge/dispatcher in place; remove only Machine runner custody.
  h.trackedSessionsByKey.delete(h.tracked.trackingKey);
  try {
    await expect(bridge!.pluginMcp!.prepare({ catalog, directory: h.cwd }))
      .rejects.toMatchObject({ code: 'plugin_mcp_preparation_unavailable' });
  } finally { h.trackedSessionsByKey.set(h.tracked.trackingKey, h.tracked); }
  h.tracked.stopRequestedAtMs = Date.now();
  const refusal = await bridge!.pluginMcp!.prepare({ catalog, directory: h.cwd }).catch((error: unknown) => error);
  expect(refusal).toMatchObject({ code: 'plugin_mcp_preparation_unavailable' });
  const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
  const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
  try {
    expect(reportSessionRunnerFailure(refusal)).toBe(1);
    expect(log).toHaveBeenCalledWith('[Session] Runner failed', expect.objectContaining({
      errorCode: 'plugin_mcp_preparation_unavailable',
    }));
    expect(SessionRuntimeIssueV1Schema.parse(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: refusal })))
      .toMatchObject({ code: 'plugin_mcp_preparation_unavailable' });
  } finally { log.mockRestore(); fatal.mockRestore(); }
  await h.daemon.onChildExited(h.tracked.pid, { reason: 'explicit-stop', code: 0, signal: null });
  runnerExited = true;
  await expect(homeFetch(endpoints[1]!)).rejects.toThrow();
  await expect(probeMcpStdioServerTools({ config: second.mcpServers[wireName]! })).rejects.toThrow();
  // The daemon already retired these attachments. Repeated local retirement
  // must drain the stand-in's handles without restoring either endpoint.
  await source.retire?.();
}, 180_000);

it.each(['plugin_mcp_preparation_unavailable', 'team_credential_provider_selection_not_current'])(
  'carries the closed startup refusal %s through requester Home, runner exit and the original launch operation', async code => {
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control);
  h.tracked.stopRequestedAtMs = Date.now();
  const refusal = await h.dispatch({ kind: 'mcp.plugin.prepare', preparationId: 'b0848cfe-730b-4a8d-9904-615950c78503',
    directory: h.cwd, catalog: { bindings: [] } });
  if (refusal.ok) throw new Error('Expected real daemon MCP refusal');
  const error = code === 'team_credential_provider_selection_not_current'
    ? new SessionTeamCredentialLaunchUnavailableError()
    : new PluginError({ code: refusal.error.code, message: 'PRIVATE_BODY' });
  const issue = SessionRuntimeIssueV1Schema.parse(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error, occurredAt: 100 }));
  expect(issue.code).toBe(code);
  // Only Home HTTP and physical child exit are substituted. The requester
  // reader, native-open waiter, launch adapter and operation store stay real.
  h.tracked.childProcess = new ChildProcess();
  h.tracked.childProcess.exitCode = 1;
  const getHome = vi.mocked(axios.get).getMockImplementation()!;
  let scenario = 'current';
  vi.mocked(axios.get).mockImplementation(async (url, options) => {
    if (new URL(String(url)).pathname !== `/v2/sessions/${h.sessionId}`) return getHome(url, options);
    expect(options?.headers?.Authorization).toBe(`Bearer ${h.requester.bootstrap.credentials.token}`);
    if (scenario === 'read-failed') throw new Error('PRIVATE_HOME_FAILURE');
    return { status: 200, data: { session: createSessionRecordFixture({ id: h.sessionId, encryptionMode: 'plain',
      metadata: JSON.stringify({ machineId: 'machine' }), dataEncryptionKey: null, share: null,
      latestTurnStatus: 'failed', lastRuntimeIssue: { ...issue,
        ...(scenario === 'stale' ? { occurredAt: 0 } : {}),
        ...(scenario === 'unknown' ? { code: `${code}_PRIVATE` } : {}),
      } }) } };
  });
  const scope = { accountId: 'requester', machineId: 'machine' };
  const handler = createMachineSessionSpawnRpcHandler({ handlers: {
    spawnSession: async () => ({ type: 'success', sessionId: h.sessionId }), stopSession: async () => true,
  }, awaitAgentSessionOpen: input => h.daemon.awaitAgentSessionOpen(input) });
  for (const outcome of ['current', 'stale', 'unknown', 'read-failed']) {
    scenario = outcome;
    const operations = createHostActionOperationRuntime({ machineId: scope.machineId,
      resolveAccountId: async () => scope.accountId, generateOperationId: () => outcome, supportsCoreCancellation: () => true });
    try {
      await operations.observeExecution({ actionId: 'session.spawn_new', input: { creationKey: outcome },
        execute: async operation => ({ ok: true, result: await handler({ directory: h.cwd,
          agentTarget: { kind: 'agent', identity: { pluginId: 'acme.project-launch', localId: 'agent' } },
        }, { signal: operation.signal, localActionContext: operation }) }) });
      await operations.handlers.getV2({ operationId: outcome, waitForTerminal: true });
      const snapshot = operations.store.get(scope, outcome);
      expect(snapshot, outcome).toMatchObject({ state: 'succeeded', result: { type: 'error', errorCode: 'SPAWN_FAILED' } });
      const result = snapshot?.result;
      if (!result || typeof result !== 'object' || !('errorDetail' in result)) throw new Error('Missing launch cause');
      const projected = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({ errorCode: 'SPAWN_FAILED',
        errorMessage: 'Session launch failed', errorDetail: result.errorDetail }));
      expect(projected, outcome).toMatchObject({ type: 'error', code: 'spawn_failed', launchError: {
        code: outcome === 'current' ? code : 'SPAWN_FAILED',
      } });
      expect(JSON.stringify([snapshot, projected])).not.toContain('PRIVATE');
    } finally { operations.runner.cancel(scope, outcome); }
  }
}, 180_000);
