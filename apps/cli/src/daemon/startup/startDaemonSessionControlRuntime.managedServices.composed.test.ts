import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { PLUGIN_MANIFEST as OPENCODE_MANIFEST } from '@happier-dev/plugins-opencode/manifest';
import { resolveAgentCliManagedCommandPathForRuntime } from '@happier-dev/cli-common/agents/resolution';
import { projectNativeAgentCliRuntimeDescriptor } from '@/plugins/projection/registry/agentCliMetadata';
import { buildAgentCliLaunchSpecFromResolution } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';
import { configuration } from '@/configuration';
import { createDaemonControlApp, type startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority';
import { createAgentRuntimeDaemonServiceAuthorityPath } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { resolveLocalPathPluginSource } from '@/plugins/discovery/sources/localPath';
import { bindPluginRuntimeSourceAuthority } from '@/plugins/runtime/sourceAuthority';
import { resolvePluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { loadVerifiedPluginModule } from '@/plugins/runtime/loadPluginModule';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createDaemonPluginSecretCustodyRouter } from '@/plugins/runtime/context/secrets';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { AGENT_RUNTIME_DAEMON_SERVICES_PATH, AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { projectManagedServiceSpawnEnvironmentKeys } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { buildOpenCodeManagedServerSpawnSpec } from '../../../../../packages/plugins/opencode/src/agent/runtime/server/spawnSpec';
import { OPEN_CODE_SYSTEM_TOOL_ID } from '../../../../../packages/plugins/opencode/src/agent/systemTool';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createPurposeTargetResolver } from '@happier-dev/cli-common/connectedAccounts';
import { PluginConnectedAccountAuthenticationV2Schema, QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol';
import { decodeRunnerDaemonPluginServiceWireValueV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// Only the listening socket is replaced. Requests below use real HTTP injection,
// signed authority publication, registry attestation and the startup dispatcher.
vi.mock('@/daemon/controlServer', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlServer')>(),
  startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
  },
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); boundary.control = null; });

it('resolves an OpenCode child Run CLI independently of its Codex carrier launch', async () => {
  const cliRoot = await mkdtemp(join(tmpdir(), 'happier-opencode-child-cli-'));
  onTestFinished(() => rm(cliRoot, { recursive: true, force: true }));
  const executable = join(cliRoot, 'opencode');
  await writeFile(executable, '');
  await chmod(executable, 0o700);
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, 'codex', false,
    undefined, createPluginReloadController(), {
      additionalPluginIds: ['happier.agent.opencode'],
      processEnv: { HAPPIER_OPENCODE_PATH: executable },
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_session_home', machineId: 'machine' }),
      agentIsolation: { managedHappierBinaryPath: process.execPath,
        read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
    });
  h.tracked.runnerAgentInvocationContext = { ...h.tracked.runnerAgentInvocationContext!,
    agentCliLaunch: { localAgentId: 'codex', spec: {
      source: 'override', resolvedPath: join(h.f.directory, 'codex'),
      command: join(h.f.directory, 'codex'), args: ['--carrier-only'],
    } },
  };
  const snapshot = await h.dispatch({ kind: 'execution_run.snapshot.acquire_v1',
    backendTarget: { kind: 'backend', backendId: 'opencode' } });
  if (!snapshot.ok || snapshot.result.kind !== 'execution_run.snapshot') throw new Error(`Missing OpenCode Run snapshot: ${JSON.stringify(snapshot)}`);
  const snapshotId = snapshot.result.snapshotId;
  const runId = 'opencode-on-codex-carrier';
  try {
    const prepared = await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase(runId), executionRunCwd: h.cwd }, snapshotId);
    expect(prepared).toMatchObject({ ok: true });
    const spec = buildOpenCodeManagedServerSpawnSpec({ id: 'opencode-server', dialect: 'v1', systemToolId: OPEN_CODE_SYSTEM_TOOL_ID });
    if (spec.mode.kind !== 'spawn') throw new Error('Expected managed server launch');
    const authorized = await h.dispatch({ kind: 'managed_server.supervision.authorize', requestId: 'opencode-child-launch',
      operationClaimId: runId, contributionId: 'happier.agent.opencode/agents/opencode', serverId: spec.id,
      executable: spec.mode.launch.executable, environmentKeys: projectManagedServiceSpawnEnvironmentKeys(spec),
    }, snapshotId);
    expect(authorized, JSON.stringify(authorized)).toMatchObject({ ok: true, result: { kind: 'managed_server.supervision', status: 'authorized',
      launch: { kind: 'daemonResolved', value: { command: executable, args: [] } } } });
  } finally {
    await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase(runId) }, snapshotId);
    await h.dispatch({ kind: 'execution_run.snapshot.release_v1', snapshotId });
  }
});

it('projects the detached OpenCode Run exact profile through its requester Account owner instead of the parent binding', async () => {
  const authentication = PluginConnectedAccountAuthenticationV2Schema.parse({ defaultModeId: 'token', modes: [{
    id: 'token', kind: 'manual', outcomeReconciliation: 'none',
    fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' } }],
  }] });
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, false, {
    manifest: createPluginManifestV2Fixture({ id: 'acme.project-launch', contributes: {
      connectedAccountDescriptors: [{ id: 'subscription', title: 'Subscription', authentication }],
      agents: [{ id: 'agent', title: 'OpenCode account binding fixture', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        connectedAccounts: [{ purpose: 'openai-codex-model-request', service: 'subscription', materializationKinds: ['httpHeaders'] }] }],
    } }),
    files: {
      'agent.mjs': 'export function factory() { return { sessions: { open() { throw new Error("Binding observation cannot run inference"); } } }; }',
      'daemon.mjs': `import { factory } from './agent.mjs';
        export function activate(api) {
          const unused = async () => { throw new Error('Binding observation cannot invoke account credentials'); };
          api.connectedAccounts.register('subscription', {
            authentication: { modes: { token: { kind: 'manual', complete: unused } } },
            refresh: unused, revoke: unused, status: unused, materialize: unused,
          });
          api.agents.register('agent', factory, { sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } });
        }`,
    },
  }, createPluginReloadController());
  const service = { pluginId: h.retainedAgent.pluginId, localId: 'subscription' };
  const purpose = { consumer: { pluginId: h.retainedAgent.pluginId, localId: h.retainedAgent.localAgentId }, purpose: 'openai-codex-model-request' };
  // Account metadata transport is the boundary; binding and target resolution stay real.
  const resolver = createPurposeTargetResolver({ available: true,
    resolveService: async () => ({ service, authentication }),
    listAccounts: async () => ['parent-profile', 'judge-profile'].map(accountId => QualifiedConnectedAccountProfileV4Schema.parse({
      ref: { service, accountId }, authenticationModeId: 'token', status: 'connected', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationReady: true,
      configurationRevision: null, scopes: [], displayName: accountId,
    })),
  });
  const unused = async () => { throw new Error('Binding observation cannot select or materialize credentials'); };
  const owner = createConnectedAccountPurposeBindingOwner({
    store: { read: async () => ({ v: 1, bindings: [] }), update: unused, subscribe: () => ({ dispose() {} }) },
    resolveTarget: resolver, selectTarget: unused, materializeAccount: unused,
    projectTargetAccounts: unused, assertTargetAccountMaterializable: unused,
  });
  h.tracked.requesterSessionRuntimeContext = { ...h.requester, connectedAccountsOwner: owner };
  const binding = (accountId: string) => ({ purpose, target: { kind: 'account' as const, account: { service, accountId } } });
  const parentLease = owner.activatePurposeBindings({ subject: { kind: 'session', sessionId: h.sessionId },
    purposes: [purpose], bindings: [binding('parent-profile')] });
  const runId = 'judge-with-exact-connected-profile';
  const runLease = owner.activatePurposeBindings({ subject: { kind: 'execution_run', runId,
    runnerPid: h.runner.pid, agentId: h.retainedAgent.agentId, isCurrent: () => true }, purposes: [purpose], bindings: [binding('judge-profile')] });
  onTestFinished(() => { runLease.dispose(); parentLease.dispose(); });
  h.connectedServiceRuntimeRegistry.registerRunTarget({ runKey: runId, pid: h.runner.pid,
    sessionId: h.sessionId, agentId: h.retainedAgent.agentId, exactPurposeBindingSubjectId: runLease.subjectId });
  const snapshot = await h.dispatch({ kind: 'execution_run.snapshot.acquire_v1',
    backendTarget: { kind: 'backend', backendId: h.retainedAgent.agentId } });
  if (!snapshot.ok || snapshot.result.kind !== 'execution_run.snapshot') throw new Error('Missing admitted Run snapshot');
  const snapshotId = snapshot.result.snapshotId;
  const prepared = await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase(runId), executionRunCwd: h.cwd }, snapshotId);
  expect(prepared).toMatchObject({ ok: true });
  const read = () => h.dispatch({ kind: 'plugin_connected_accounts.get_binding_v1', ...h.operationBase(runId), purpose: purpose.purpose }, snapshotId);
  const selected = await read();
  if (!selected.ok || selected.result.kind !== 'plugin_services.result_v1') throw new Error(`Missing connected binding: ${JSON.stringify(selected)}`);
  expect(decodeRunnerDaemonPluginServiceWireValueV1(selected.result.value)).toMatchObject({ account: { service, accountId: 'judge-profile' } });
  // An expired exact Run must not fall back to the still-active parent's profile.
  runLease.dispose();
  const retired = await read();
  if (!retired.ok || retired.result.kind !== 'plugin_services.result_v1') throw new Error('Missing retired binding result');
  expect(decodeRunnerDaemonPluginServiceWireValueV1(retired.result.value)).toBeNull();
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase(runId) }, snapshotId);
  await h.dispatch({ kind: 'execution_run.snapshot.release_v1', snapshotId });
});

it.each([
  ['development', 'metadata'], ['development', 'retained'],
  ['external', 'metadata'], ['external-development', 'metadata'],
] as const)('serves a refreshed %s Agent with an off-PATH %s CLI through signed authority and refuses its predecessor', async (source, launchSource) => {
  let phase = 'admitted_fixture';
  onTestFailed(() => console.error('Managed-service composition phase:', { source, launchSource, phase }));
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control,
    source === 'development' ? 'opencode' : undefined, false,
    source !== 'development' ? {
      manifest: { ...OPENCODE_MANIFEST, id: 'acme.project-launch', entrypoints: { daemon: './daemon.mjs' }, contributes: {
        systemTools: OPENCODE_MANIFEST.contributes.systemTools, agents: [{
          id: 'agent', title: 'External managed-service Agent', runtime: { kind: 'custom' }, primary: 'sessions',
          cli: { ...OPENCODE_MANIFEST.contributes.agents[0]!.cli!, auth: { support: 'unsupported', loginLaunches: [] } },
          catalog: { agentCliSystemTool: { toolId: 'opencode-cli' } },
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        }],
        settings: OPENCODE_MANIFEST.contributes.settings.map(setting => ({ ...setting, target: { kind: 'agent', agent: 'agent' } })),
      } },
      files: {
        'agent.mjs': 'export function factory() { return { sessions: { open() { throw new Error("No inference at authorization"); } } }; }',
        'daemon.mjs': 'import { factory } from "./agent.mjs"; export function activate(api) { api.agents.register("agent", factory, { sessionRunnerFactory: { module: "./agent.mjs", export: "factory", runtimeApiVersion: 1 } }); }',
      },
    } : undefined, createPluginReloadController());
  phase = 'fixture_ready';
  let retainedAgent = h.retainedAgent;
  if (source === 'external-development') {
    const loaded = await resolvePluginContributes({ happyHomeDir: h.f.directory, existingAgentIds: new Set() });
    if (!('committed' in h.plugin)) throw new Error('Missing authored external source');
    const generation = h.plugin.committed.generations.get(retainedAgent.pluginId);
    if (!generation) throw new Error('Missing physical external development source');
    const localSource = await resolveLocalPathPluginSource({ locator: generation.rootPath });
    if (!localSource.ok) throw new Error('Missing external source declaration');
    const sourceAuthority = bindPluginRuntimeSourceAuthority({
      custody: { kind: 'development', registeredRootId: localSource.pluginRootPath },
      resolvedRoot: localSource.pluginRootPath, observedRevision: 1,
    });
    if (sourceAuthority.kind !== 'development') throw new Error('Expected development source authority');
    const candidateScope = {};
    const entryPath = join(localSource.pluginRootPath, 'daemon.mjs');
    const module = await loadVerifiedPluginModule({ entryPath, loadMode: 'source-ts', generationScope: candidateScope });
    const registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: h.f.directory,
      pluginIds: [retainedAgent.pluginId],
      contributes: createResolvedContributionRegistry({ ...loaded, materializationIdsByPluginId: {} }),
      preparedDevelopmentActivationGraphsByPluginId: new Map([[retainedAgent.pluginId, {
        module, candidateScope, sourceAuthority, rootPath: localSource.pluginRootPath, entryPath,
      }]]),
    });
    const binding = registry.agentRuntimesByAgentId.get(retainedAgent.agentId)?.sessionRunnerFactoryBinding;
    if (!binding || binding.sourceCustody.kind !== 'development') {
      await registry.dispose();
      throw new Error(`External development activation failed: ${JSON.stringify(registry.pluginDiagnosticsByPluginId[retainedAgent.pluginId])}`);
    }
    await h.plugin.controller.adoptPreparedRuntimeRegistry({ registry, changedPluginIds: [retainedAgent.pluginId], runningSessionDisposition: 'retainRunningSessions' });
    retainedAgent = binding;
  }
  const control = boundary.control;
  if (!control) throw new Error('Missing production control composition');
  const app = createDaemonControlApp(control);
  onTestFinished(() => app.close());
  const cli = OPENCODE_MANIFEST.contributes.agents[0]!.cli!;
  phase = 'cli_fixture';
  const executable = resolveAgentCliManagedCommandPathForRuntime(projectNativeAgentCliRuntimeDescriptor({
    agentId: retainedAgent.agentId, title: 'Managed Agent', cli,
  }), { processEnv: { HAPPIER_HOME_DIR: h.f.directory } });
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, '');
  await chmod(executable, 0o700);
  vi.stubEnv('PATH', '');
  // Exclude real user installations from the fixture.
  vi.stubEnv('HOME', h.f.directory);
  vi.stubEnv('USERPROFILE', h.f.directory);
  const managedLaunch = buildAgentCliLaunchSpecFromResolution({ source: 'managed', command: executable },
    { processEnv: { HAPPIER_JS_RUNTIME_PATH: process.execPath } });
  if (!managedLaunch) throw new Error('Missing canonical managed CLI launch');
  const expectedArgs = [...managedLaunch.args, ...(launchSource === 'retained' ? ['--admitted-cli'] : [])];
  if (launchSource === 'retained') {
    h.tracked.runnerAgentInvocationContext = { ...h.tracked.runnerAgentInvocationContext!,
      agentCliLaunch: { localAgentId: retainedAgent.localAgentId,
        spec: { ...managedLaunch, args: expectedArgs } },
    };
  }

  const command = `${process.execPath} ${resolve('package-dist/index.mjs')} opencode`;
  h.tracked.processCommandHash = hashProcessCommand(command);
  h.tracked.agentRuntimeDaemonServiceAuthorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({
    happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
  });
  const refresh = () => refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
    happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
    httpPort: 43129, sessionId: h.sessionId, tracked: h.tracked,
    resolveCurrentRetainedAgent: () => retainedAgent,
    readProcessIdentityByPidFn: async pid => ({ pid, processStartTimeMs: h.tracked.processStartTimeMs!, command }),
    persistRunnerAgentCustody: async () => true,
  });
  phase = 'predecessor_authority';
  const predecessor = await refresh();
  // The OS boundary supplies a distinct successor process occurrence. Source
  // selection, signed authority refresh, tracked-row lookup and dispatch stay real.
  h.tracked.pid += 1;
  h.tracked.sessionRunnerPid = h.tracked.pid;
  h.tracked.processStartTimeMs = 2;
  h.tracked.runnerAgentBootstrapIdentity = { agentId: retainedAgent.agentId, backendId: retainedAgent.agentId };
  h.tracked.agentRuntimeDaemonServiceAuthorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({
    happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
  });
  h.trackedSessionsByKey.set(h.tracked.trackingKey, h.tracked);
  phase = 'successor_authority';
  const successor = await refresh();
  expect(successor.document.runner.pid).not.toBe(predecessor.document.runner.pid);
  expect(successor.capabilityDigest).not.toBe(predecessor.capabilityDigest);
  const spec = buildOpenCodeManagedServerSpawnSpec({
    id: 'opencode-server', dialect: 'v1', systemToolId: OPEN_CODE_SYSTEM_TOOL_ID,
  });
  if (spec.mode.kind !== 'spawn') throw new Error('Expected the native managed-server spawn specification');
  const launch = spec.mode.launch;
  const request = async (token: string) => app.inject({
    method: 'POST', url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
    headers: { 'x-happier-daemon-token': token },
    payload: { v: 1, context: { sessionId: h.sessionId, token }, operation: {
      kind: 'managed_server.supervision.authorize', requestId: 'supervision-request',
      contributionId: `${retainedAgent.pluginId}/agents/${retainedAgent.localAgentId}`,
      serverId: spec.id,
      executable: launch.executable, environmentKeys: projectManagedServiceSpawnEnvironmentKeys(spec),
    } },
  });
  phase = 'stale_request';
  const stale = await request(predecessor.document.capability);
  expect(stale.statusCode, stale.body).toBe(403);
  phase = 'current_request';
  const current = await request(successor.document.capability);
  expect(current.statusCode, current.body).toBe(200);
  expect(AgentRuntimeDaemonServiceResponseV1Schema.parse(current.json())).toMatchObject({
    ok: true, result: { kind: 'managed_server.supervision', status: 'authorized',
      launch: { kind: 'daemonResolved', value: { command: managedLaunch.command, args: expectedArgs } } },
  });
  for (const localAgentId of ['', 'different-agent']) {
    phase = 'misbound_launch';
    h.tracked.runnerAgentInvocationContext = { ...h.tracked.runnerAgentInvocationContext!,
      agentCliLaunch: { localAgentId,
        spec: managedLaunch },
    };
    const misbound = await request(successor.document.capability);
    expect(misbound.statusCode, misbound.body).toBe(500);
    expect(misbound.json()).toMatchObject({ code: 'plugin_agent_cli_system_tool_unavailable' });
  }
  const canonicalOrigin = 'http://127.0.0.1:4312';
  phase = 'secret_custody';
  const secretId = 'opencodeServerPassword';
  const custody = createDaemonPluginSecretCustodyRouter({
    paths: resolvePluginStorePaths({ happyHomeDir: configuration.happyHomeDir }),
    resolveDeviceLocalSecretStorage: async () => await readOrCreateDeviceLocalSecretStorage({
      path: join(configuration.happyHomeDir, 'device-local-secret-key.json'),
    }),
  }).resolve({ pluginId: retainedAgent.pluginId, declaration: {
    id: secretId, custody: 'daemon', managedServiceOrigin: { endpointSettingId: 'opencodeServerBaseUrl' },
  } });
  if (!custody) throw new Error('Missing daemon secret custody');
  await custody.set({ secretId, canonicalOrigin, value: 'fixture-managed-service-secret' });
  phase = 'secret_read';
  const secret = await app.inject({ method: 'POST', url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
    headers: { 'x-happier-daemon-token': successor.document.capability },
    payload: { v: 1, context: { sessionId: h.sessionId, token: successor.document.capability },
      operation: { kind: 'managed_server.secret.read', requestId: 'declared-secret-request', phase: 'read', secretId, canonicalOrigin } },
  });
  expect(secret.statusCode).toBe(200);
  expect(AgentRuntimeDaemonServiceResponseV1Schema.parse(secret.json())).toMatchObject({
    ok: true, result: { kind: 'managed_server.secret', status: 'resolved', value: 'fixture-managed-service-secret' },
  });
  if (source === 'external-development') {
    phase = 'foreign_binding';
    // Deliberately mis-bind the refresh producer. Even a signed, current runner
    // capability cannot substitute a foreign root for the registry occurrence.
    const foreignRoot = join(h.f.directory, 'foreign-agent-root');
    await mkdir(foreignRoot);
    retainedAgent = { ...retainedAgent, sourceCustody: { kind: 'development', registeredRootId: foreignRoot } };
    h.tracked.runnerAgentBootstrapIdentity = { agentId: retainedAgent.agentId, backendId: retainedAgent.agentId };
    h.tracked.agentRuntimeDaemonServiceAuthorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({
      happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
    });
    const foreign = await refresh();
    const refused = await request(foreign.document.capability);
    expect(refused.statusCode).toBe(500);
    expect(refused.json()).toMatchObject({ code: 'plugin_services_retained_generation_untrusted' });
  }
  phase = 'complete';
});
