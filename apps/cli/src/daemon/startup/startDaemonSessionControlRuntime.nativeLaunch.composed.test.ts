import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { expect, it, onTestFinished, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { PLUGIN_MANIFEST as OPENCODE_MANIFEST } from '@happier-dev/plugins-opencode/manifest';
import { resolveAgentCliManagedCommandPathForRuntime, resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import type { ManagedServiceHandle } from '@happier-dev/plugin-sdk/managed-services';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createInstalledMachineRpcDatabaseBoundary, createInstalledMachineRpcRelay } from '@/daemon/testkit/installedMachineRpcRelay.testkit';
import { spawnPublicInstalledProjectAgentSession } from '@/daemon/testkit/publicInstalledProjectAgentSpawn.testkit';
import { decodeRunnerDaemonPluginServiceWireValueV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { prepareRunnerDaemonPluginServices } from '@/agent/runtime/session/process/runnerDaemonPluginServices';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createUnavailableCurrentSessionInteractionOwner } from '@/session/presentation/currentSessionInteractionOwner';
import { captureAgentNativeLaunchAuthorityForHost, issueAgentNativeLaunchQualifierForHost } from '@/plugins/runtime/invocation/services/exec';
import { createPublicAcpSession } from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { projectNativeAgentCliRuntimeDescriptor } from '@/plugins/projection/registry/agentCliMetadata';
import { buildAgentCliLaunchSpecFromResolution } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { createRunnerAgentSessionRuntimeSource } from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import { AgentRuntimeDaemonServiceRequestV1Schema, AGENT_RUNTIME_DAEMON_SERVICES_PATH } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { configuration } from '@/configuration';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { materializeConnectedServicesForSpawn } from '@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn';
import { prepareSessionMcpLocalTransport } from '@/mcp/runtime/sessionMcpLocalTransport';
import * as processIdentity from '@/daemon/processIdentity';
import { buildOpenCodeManagedServerSpawnSpec } from '../../../../../packages/plugins/opencode/src/agent/runtime/server/spawnSpec';
import { OPEN_CODE_SYSTEM_TOOL_ID } from '../../../../../packages/plugins/opencode/src/agent/systemTool';
import { createOpenCodeAttachArgs, resolveOpenCodeAttachTarget } from '../../../../../packages/plugins/opencode/src/agent/surfaces/sessions/attach/descriptor';
import { createProviderCliAttachSurface } from '@/session/attach/providerCliAttach';
import { createDefaultPreparedTerminalHostOwner, createDefaultPluginTerminalHostService,
  installAgentChildLaunchEnvironmentTransformerForTerminalHost } from '@/plugins/runtime/context/terminalHost';

const boundary = vi.hoisted(() => ({
  control: null as Parameters<typeof startDaemonControlServer>[0] | null,
  database: null as ReturnType<typeof createInstalledMachineRpcDatabaseBoundary>['db'] | null,
  sudoAdapter: null as string | null,
  sudoStarts: 0,
}));
vi.mock('@/daemon/controlServer', async original => ({
  ...await original<typeof import('@/daemon/controlServer')>(),
  startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
  },
}));
// Persistence and authenticated sockets are boundaries. Home admission and the
// installed receiver produce requester custody from these resource/grant facts.
vi.mock('../../../../server/sources/storage/db', () => ({ getDbProviderFromEnv: () => 'postgres', get db() {
  if (!boundary.database) throw new Error('Missing native-launch Home database boundary');
  return boundary.database;
} }));
// Substitute only the OS identity switch. The canonical frame reader and a real
// ACP child still consume the finalizer's bytes. This does not certify any UID.
vi.mock('cross-spawn', async original => {
  const actual = await original<{ default: typeof import('cross-spawn') }>();
  const native = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, default: vi.fn((command: string, args?: readonly string[], options?: import('node:child_process').SpawnOptions) => {
    if (command !== 'sudo') return actual.default(command, [...args ?? []], options);
    if (!boundary.sudoAdapter) throw new Error('Unexpected native identity switch');
    boundary.sudoStarts++;
    return native.spawn(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), boundary.sudoAdapter], options);
  }) };
});
// Observe a separate identity at the OS boundary without provisioning it. The
// sudo adapter above deliberately runs as this test user: no installed-UID claim.
vi.mock('@happier-dev/cli-common/process', async original => {
  const actual = await original<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: async (...args: Parameters<typeof actual.execFileWithDeadline>) => {
    if (args[0] === 'getent' && JSON.stringify(args[1]) === JSON.stringify(['--service=files', 'passwd', 'happier-agent'])) {
      return { stdout: `happier-agent:x:${(process.getuid?.() ?? 1) + 1}:${process.getgid?.() ?? 1}::/var/lib/happier/agent:/usr/sbin/nologin\n`, stderr: '' };
    }
    return actual.execFileWithDeadline(...args);
  } };
});
function retainBoundaryCleanup() {
  onTestFinished(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    boundary.control = null; boundary.database = null; boundary.sudoAdapter = null;
    boundary.sudoStarts = 0;
  });
}

type NativeFixture = Awaited<ReturnType<typeof createInstalledProjectAgentDaemonFixture>>;
type Actor = 'owner' | 'member-use' | 'member-manage';

const managedAgent = {
  manifest: { ...OPENCODE_MANIFEST, id: 'acme.project-launch', entrypoints: { daemon: './daemon.mjs' }, contributes: {
    systemTools: OPENCODE_MANIFEST.contributes.systemTools,
    agents: [{ id: 'agent', title: 'Managed Agent server fixture', runtime: { kind: 'custom' as const }, primary: 'sessions' as const,
      cli: { ...OPENCODE_MANIFEST.contributes.agents[0]!.cli!, auth: { support: 'unsupported' as const, loginLaunches: [] } },
      catalog: { agentCliSystemTool: { toolId: 'opencode-cli' } },
      capabilities: { sessions: { open: ['create' as const], delivery: ['newTurn' as const], cancel: true } } }],
    settings: OPENCODE_MANIFEST.contributes.settings.map(setting => ({ ...setting,
      target: { kind: 'agent' as const, agent: 'agent' } })),
  } },
  files: {
    'agent.mjs': 'export function factory() { return { sessions: { open() { throw new Error("Managed server owner boundary only"); } } }; }',
    'daemon.mjs': 'import { factory } from "./agent.mjs"; export function activate(api) { api.agents.register("agent", factory, { sessionRunnerFactory: { module: "./agent.mjs", export: "factory", runtimeApiVersion: 1 } }); }',
  },
};

async function publicNativeFixture(actor: Actor, agentId: 'custom-acp' | 'claude' | 'managed-server', isolated: boolean) {
  retainBoundaryCleanup();
  const home = 'srv_public_native_custody';
  const custodian = actor === 'owner' ? 'requester' : 'company';
  const role = actor === 'member-use' ? 'use' : 'manage';
  let root = '';
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control,
    agentId === 'managed-server' ? undefined : agentId, true, agentId === 'managed-server' ? managedAgent : undefined, undefined, {
    externalActionAccountId: custodian, homeServerIdentityId: home, ordinaryAccountSession: true,
    machineRpcMethods: [RPC_METHODS.SESSION_SPAWN_NEW],
    machineAccess: { custodianAccountId: custodian, role },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
    agentIsolation: { managedHappierBinaryPath: process.execPath, read: () => isolated ? {
      enabled: true, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [root],
    } : { enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] } },
  });
  root = h.cwd;
  boundary.database = createInstalledMachineRpcDatabaseBoundary({ machineId: 'machine',
    ownerAccountId: custodian, installation: h.f.installation,
    ...(actor === 'owner' ? {} : { members: [{ accountId: 'requester', accessLevel: role === 'use' ? 'view' : 'admin' }] }),
  }).db;
  const manager: unknown = Reflect.get(h.machine, 'rpcHandlerManager');
  if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing installed native-launch receiver');
  let relay: Awaited<ReturnType<typeof createInstalledMachineRpcRelay>> | undefined;
  const spawned = await spawnPublicInstalledProjectAgentSession({ fixture: h, actor: actor === 'owner' ? 'owner' : 'member',
    memberRole: role, homeServerIdentityId: home,
    agentTarget: { kind: 'agent', identity: agentId === 'custom-acp' ? CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1
      : { pluginId: h.retainedAgent.pluginId, localId: h.retainedAgent.localAgentId },
      ...(agentId === 'custom-acp' ? { definitionId: 'public-frame' } : {}) },
    publicIngress: { manager, async invoke(method, params) {
      relay ??= await createInstalledMachineRpcRelay({ manager, machineId: 'machine', transportOwnerAccountId: custodian,
        methods: [RPC_METHODS.SESSION_SPAWN_NEW], ui: { installation: h.f.installation, ownerAccountId: custodian } });
      return relay.invokeUi(method, params, { actorAccountId: 'requester', callerAuthority: 'present_user' });
    } },
  });
  return { h, spawned };
}

async function nativeServices(h: NativeFixture) {
  // No requester context is supplied here. The real daemon must qualify the
  // public creator's stamp and the cold Session read before any native effect.
  delete h.tracked.requesterSessionRuntimeContext;
  const invocationId = 'public-native-effect';
  const services = await prepareRunnerDaemonPluginServices({ invocationId, signal: h.signal,
    local: createUnavailablePluginServices(), dispatch: async operation => {
      const response = await h.dispatch(operation);
      if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
      if (response.result.kind !== 'plugin_services.result_v1') throw new Error('Missing native services response');
      return decodeRunnerDaemonPluginServiceWireValueV1(response.result.value);
    } });
  // Current services resolve requester custody at the first native effect.
  onTestFinished(() => h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase(invocationId) }));
  return services;
}

async function publicTmuxBoundary(h: NativeFixture) {
  const bin = join(h.f.directory, 'terminal-bin');
  const pidFile = join(bin, 'owned-child-pid');
  const windowNameFile = join(bin, 'owned-window-name');
  const output = join(bin, 'owned-child-output');
  await mkdir(bin);
  // Only tmux's external protocol is substituted. The real default resolver,
  // adapter, private shell handoff and useful Agent child run unchanged.
  await writeExecutableShim({ dir: bin, fileName: 'tmux', contents: `#!${process.execPath}
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const args = process.argv.slice(2);
    const pidFile = ${JSON.stringify(pidFile)}, output = ${JSON.stringify(output)};
    const windowNameFile = ${JSON.stringify(windowNameFile)};
    const alive = () => { try { const pid = Number(fs.readFileSync(pidFile, 'utf8')); process.kill(pid, 0); return pid; } catch { return null; } };
    void (async () => {
      if (args.includes('new-session') || args.includes('new-window')) {
        const separator = args.indexOf(';');
        if (separator < 1 || args[separator + 1] !== 'wait-for') throw new Error('Missing canonical tmux private handoff');
        const signal = ${JSON.stringify(bin)} + '/ready-' + args[separator + 2];
        let watcher;
        const ready = new Promise(resolve => { watcher = fs.watch(${JSON.stringify(bin)}, () => {
          if (fs.existsSync(signal)) resolve();
        }); });
        const fd = fs.openSync(output, 'a');
        const child = spawn('/bin/sh', ['-c', 'exec ' + args[separator - 1]], {
          cwd: args[args.indexOf('-c') + 1], stdio: ['ignore', fd, fd], detached: true,
        });
        fs.closeSync(fd);
        if (!child.pid) throw new Error('Tmux boundary did not launch its child');
        fs.writeFileSync(pidFile, String(child.pid));
        fs.writeFileSync(windowNameFile, args[args.indexOf('-n') + 1]);
        child.unref();
        try {
          await Promise.race([ready, new Promise((_resolve, reject) => {
            child.once('error', reject); child.once('exit', () => reject(new Error('Child exited before handoff readiness')));
          })]);
        } finally { watcher.close(); }
        const format = args[args.indexOf('-F') + 1];
        process.stdout.write(format.replaceAll('#{window_id}', '@42').replaceAll('#{pane_pid}', String(child.pid)) + '\\n');
      } else if (args.includes('wait-for') && args.includes('-S')) {
        fs.writeFileSync(${JSON.stringify(bin)} + '/ready-' + args[args.indexOf('-S') + 1], 'ready');
      } else if (args.includes('has-session')) {
        if (!alive()) { process.stderr.write("can't find session: fixture"); process.exitCode = 1; }
      } else if (args.includes('list-windows')) {
        const pid = alive();
        if (pid) process.stdout.write('@42\\t' + fs.readFileSync(windowNameFile, 'utf8') + '\\t' + pid + '\\n');
      } else if (args.includes('display-message')) {
        process.stdout.write(args.some(arg => arg.includes('cursor_x')) ? '0\\t0' : (alive() ? '0|' : '1|') + (alive() ?? 1) + '|agent');
      } else if (args.includes('capture-pane')) {
        process.stdout.write(fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '');
      } else if (args.includes('kill-window') || args.includes('kill-session')) {
        const pid = alive(); if (pid) process.kill(pid, 'SIGTERM');
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      }
    })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
  ` });
  onTestFinished(async () => {
    if (!existsSync(pidFile)) return;
    const pid = Number(await readFile(pidFile, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned terminal child PID');
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  });
  const path = `${bin}:${process.env.PATH ?? ''}`;
  vi.stubEnv('PATH', path);
  return { bin, path, pidFile, output };
}

it.runIf(process.platform === 'linux').each(['owner', 'member-use', 'member-manage'] as const)(
  'carries public Custom ACP custody through the effective-isolation frame to real initialize (%s)', async actor => {
    const { h, spawned } = await publicNativeFixture(actor, 'custom-acp', true);
    if (!spawned) { expect(boundary.sudoStarts).toBe(0); return; }
    const services = await nativeServices(h);
    const capture = join(h.f.directory, 'acp-methods.jsonl');
    // Empty selection is configuration data, not requester authority. The
    // separately admitted Account owner supplies the real materializer; it is
    // never injected into the native service's Session authorization.
    const snapshot = { purposes: [], bindings: [] };
    const material = await materializeConnectedServicesForSpawn({ agentId: 'custom-acp',
      materializationKey: h.sessionId, requesterWorkAttributionV1: h.tracked.requesterWorkAttributionV1,
      agentLaunchTarget: { runtimeHome: join(h.f.directory, 'agent-home', 'runtime') },
      activeServerDir: join(h.f.directory, 'active-server'), baseDir: join(h.f.directory, 'selected-material'),
      sessionDirectory: h.cwd, recordsByServiceId: new Map(), purposeBindingSessionId: h.sessionId,
      connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: snapshot.bindings, requestAuthPurposeBindings: [] },
      qualifiedPurposeBindingSnapshot: snapshot, connectedAccountsOwner: h.requester.connectedAccountsOwner,
      processEnv: {}, signal: h.signal,
    });
    if (!material?.agentLaunchMaterials) throw new Error('Real empty-selection materializer omitted the Agent material lease');
    onTestFinished(async () => { await material.cleanupOnExit?.(); });
    // The daemon's isolation owner reads ordinary Account Session material from
    // this registry, independently of optional protected requester birth custody.
    h.connectedServiceRuntimeRegistry.registerTarget({ pid: h.tracked.pid, sessionId: h.sessionId,
      agentId: 'custom-acp', sessionDirectory: h.cwd, materializationKey: h.sessionId,
      requesterWorkAttributionV1: h.tracked.requesterWorkAttributionV1, agentLaunchMaterials: material.agentLaunchMaterials });
    const mcp = await prepareSessionMcpLocalTransport({ agentUid: process.getuid?.() ?? 1 });
    const mcpServer = createServer((_request, response) => { response.writeHead(404); response.end(); });
    await mcp.listen(mcpServer);
    onTestFinished(async () => {
      mcpServer.closeAllConnections();
      await new Promise<void>(resolve => mcpServer.close(() => resolve()));
      await mcp.retire();
    });
    const agent = writeAcpTestAgentScript({ dir: h.f.directory, fileName: 'public-acp-agent.mjs', source: `
      import { appendFileSync } from 'node:fs';
      import { createInterface } from 'node:readline';
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ method: request.method,
          daemonHome: process.env.HAPPIER_HOME_DIR }) + '\\n');
        if (request.id === undefined) continue;
        const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} }
          : request.method === 'session/new' ? { sessionId: 'public-isolated-acp' }
          : request.method === 'session/prompt' ? { stopReason: 'end_turn' } : {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
      }
    ` });
    boundary.sudoAdapter = writeAcpTestAgentScript({ dir: h.f.directory, fileName: 'identity-boundary.mjs', source: `
      import { spawn } from 'node:child_process';
      import { readAgentLaunchFrame } from ${JSON.stringify(new URL('../agentIsolation/agentLaunchFrame.ts', import.meta.url).href)};
      const payload = await readAgentLaunchFrame(process.stdin);
      const child = spawn(payload.executable, payload.args, { cwd: payload.cwd,
        env: payload.environment, stdio: ['pipe', 'inherit', 'inherit'] });
      process.stdin.pipe(child.stdin);
      process.on('SIGTERM', () => child.kill('SIGTERM'));
      child.once('exit', code => process.exit(code ?? 1));
    ` });
    const runtime = await createPublicAcpSession({ kind: 'create', sessionId: h.sessionId, cwd: h.cwd }, {
      transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'configured-acp' } },
    }, {
      pluginId: h.retainedAgent.pluginId, agentId: 'custom-acp', signal: h.signal, isCurrent: () => true,
      exec: services.exec, nativeLaunch: issueAgentNativeLaunchQualifierForHost(services.exec, () => mcp.localContext),
      systemTools: { resolve: async () => { throw new Error('Configured ACP uses its admitted launch'); } },
      resolveHostLaunch: () => ({ command: process.execPath, args: [agent], env: {}, unsetEnv: [], timeouts: {} }),
      interactions: { async request() { throw new Error('No interaction requested by the protocol fixture'); } },
      media: { async registerSourceRoot() { throw new Error('No media requested by the protocol fixture'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    });
    try {
      expect(await runtime.send({ inputIds: ['public-input'], input: { text: 'Useful owner ACP turn' },
        delivery: { kind: 'newTurn', turnId: 'public-turn' } })).toEqual({ status: 'admitted' });
      await vi.waitFor(async () => {
        const methods = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(methods).toEqual(expect.arrayContaining([
          { method: 'initialize' }, { method: 'session/new' }, { method: 'session/prompt' },
        ]));
      });
      expect(boundary.sudoStarts).toBe(1);
    } finally { await runtime.dispose(); }
  }, 120_000);

it.runIf(process.platform === 'linux').each(['owner', 'member-use', 'member-manage'] as const)(
  'keeps the public owner Linux Agent terminal useful and refuses non-owner native effects (%s)', async actor => {
    const { h, spawned } = await publicNativeFixture(actor, 'claude', false);
    const expectedPidFile = join(h.f.directory, 'terminal-bin', 'owned-child-pid');
    if (!spawned) { expect(existsSync(expectedPidFile)).toBe(false); return; }
    const services = await nativeServices(h);
    const tmux = await publicTmuxBoundary(h);
    const cli = await writeExecutableShim({ dir: tmux.bin, fileName: 'claude', contents: `#!${process.execPath}
      process.stdout.write('PUBLIC_OWNER_TERMINAL_READY\\n');
      setInterval(() => {}, 1000);
    ` });
    const terminal = createDefaultPluginTerminalHostService({ happyHomeDir: h.f.directory,
      executionRunId: 'public-owner-terminal', platform: process.platform, hasCapability: () => true });
    const binding = installAgentChildLaunchEnvironmentTransformerForTerminalHost(terminal, env => env,
      { exec: services.exec, signal: h.signal, nativeLaunch: issueAgentNativeLaunchQualifierForHost(services.exec) });
    let handle: Awaited<ReturnType<typeof terminal.createOrAttachHost>> | undefined;
    try {
      handle = await terminal.createOrAttachHost({ preference: 'tmux', sessionName: 'public-owner-terminal',
        workingDirectory: h.cwd, isolatedEnv: true, launch: { kind: 'agent-cli', agentId: 'claude',
          env: { [resolveAgentCliOverrideEnvKey('claude')]: cli, PATH: tmux.path } } });
      expect(handle.kind).toBe('tmux');
      await vi.waitFor(async () => expect(await readFile(tmux.output, 'utf8')).toContain('PUBLIC_OWNER_TERMINAL_READY'));
      expect(await terminal.evaluateLiveness(handle)).toMatchObject({ paneAlive: true });
      expect(await terminal.captureInputState(handle)).toMatchObject({ currentInput: 'PUBLIC_OWNER_TERMINAL_READY' });
    } finally {
      if (handle) await terminal.dispose(handle, { kind: 'destroy_owned_host', reason: 'session_closed' });
      binding.dispose();
    }
  }, 120_000);

it.runIf(process.platform === 'linux').each(['owner', 'member-use', 'member-manage'] as const)(
  'refuses effective-isolation prepared Agent attach before native effects after public custody (%s)', async actor => {
  const { h, spawned } = await publicNativeFixture(actor, 'managed-server', true);
  const expectedPidFile = join(h.f.directory, 'terminal-bin', 'owned-child-pid');
  if (!spawned) { expect(existsSync(expectedPidFile)).toBe(false); return; }
  const services = await nativeServices(h);
  const tmux = await publicTmuxBoundary(h);
  const prepared = createDefaultPreparedTerminalHostOwner({ happyHomeDir: h.f.directory,
    executionRunId: 'public-prepared-attach', platform: process.platform });
  const nativeLaunchAuthority = captureAgentNativeLaunchAuthorityForHost(services.exec, 'attach', h.signal);
  if (!nativeLaunchAuthority) throw new Error('Public Session Exec omitted original native attach authority');
  // This real attach producer performs admission and supplies the finalized
  // tuple/custody callback to the prepared owner. A raw prepared-owner request
  // without that producer is not a production Agent attach invocation.
  const surface = createProviderCliAttachSurface({ agentId: h.retainedAgent.agentId,
    resolveTarget: resolveOpenCodeAttachTarget, createArgs: createOpenCodeAttachArgs,
    env: { PATH: tmux.path },
  });
  try {
    await expect(surface.attachManaged({ sessionId: h.sessionId, signal: h.signal, nativeLaunchAuthority,
      workingDirectory: h.cwd, metadata: { path: h.cwd, runtimeDescriptorV1: {
        v: 1, agentId: 'opencode', agent: { backendMode: 'server', providerSessionId: 'public-provider-session',
          serverBaseUrl: 'http://127.0.0.1:4312', serverBaseUrlExplicit: true },
      } }, onAttached: async () => { throw new Error('Refused Agent attach must not publish attachment'); },
      hostPresentation: { owner: prepared, preference: 'tmux', sessionName: 'public-prepared-attach', workingDirectory: h.cwd,
        // A containing test deadline is inert: admission must refuse before
        // the prepared owner creates any startup handoff or native child.
        startupDeadline: () => Date.now() + 120_000,
        bindHost: async () => { throw new Error('Refused Agent attach must not bind a native host'); },
        waitForRetirement: async () => { throw new Error('Refused Agent attach must not retain a native host'); },
      },
    }))
      .rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    expect(existsSync(tmux.pidFile)).toBe(false);
  } finally { await prepared.disposePending(); }
}, 120_000);

it.runIf(process.platform === 'linux').each(['owner-off', 'owner-effective', 'member-use', 'member-manage'] as const)(
  'keeps the real runner-local managed Agent server useful or refuses before effects (%s)', async scenario => {
    const networkFetch = globalThis.fetch;
    const actor = scenario === 'member-use' || scenario === 'member-manage' ? scenario : 'owner';
    const isolated = scenario === 'owner-effective';
    const { h, spawned } = await publicNativeFixture(actor, 'managed-server', isolated);
    const started = join(h.f.directory, 'managed-agent-started');
    if (!spawned) { expect(existsSync(started)).toBe(false); return; }
    const cli = OPENCODE_MANIFEST.contributes.agents[0]!.cli!;
    const executable = resolveAgentCliManagedCommandPathForRuntime(projectNativeAgentCliRuntimeDescriptor({
      agentId: h.retainedAgent.agentId, title: 'Managed Agent fixture', cli,
    }), { processEnv: { HAPPIER_HOME_DIR: h.f.directory } });
    await mkdir(dirname(executable), { recursive: true });
    await writeExecutableShim({ dir: dirname(executable), fileName: executable.slice(dirname(executable).length + 1),
      contents: `#!${process.execPath}
        const http = require('node:http');
        const fs = require('node:fs');
        const args = process.argv.slice(2);
        const port = Number(args[args.indexOf('--port') + 1]);
        const server = http.createServer((_request, response) => response.end('PUBLIC_MANAGED_OWNER_READY'));
        server.listen(port, '127.0.0.1', () => {
          fs.writeFileSync(${JSON.stringify(started)}, 'PUBLIC_MANAGED_OWNER_READY');
          process.stdout.write('PUBLIC_MANAGED_OWNER_READY\\n');
        });
        process.on('SIGTERM', () => server.close(() => process.exit(0)));
      ` });
    const launch = buildAgentCliLaunchSpecFromResolution({ source: 'managed', command: executable },
      { processEnv: { HAPPIER_JS_RUNTIME_PATH: process.execPath } });
    if (!launch) throw new Error('Managed Agent executable did not produce its canonical launch spec');
    h.tracked.runnerAgentInvocationContext = { ...h.tracked.runnerAgentInvocationContext!,
      agentCliLaunch: { localAgentId: h.retainedAgent.localAgentId, spec: launch } };

    // Publish and consume the actual private runner authority, rather than
    // injecting an already-authorized Exec or managed-service binding.
    const command = `${process.execPath} ${join(h.f.directory, '.runner-snapshots', 'managed-runner', 'index.mjs')}`;
    Object.assign(h.runner, { snapshotIdentity: 'snapshot:managed-runner', processCommandHash: hashProcessCommand(command) });
    h.tracked.processCommandHash = h.runner.processCommandHash;
    vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue({ pid: process.pid,
      processStartTimeMs: h.runner.processStartTimeMs, command });
    const authorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: h.f.directory,
      publicReleaseRing: configuration.publicReleaseRing });
    await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: h.f.directory, publicReleaseRing: configuration.publicReleaseRing,
      path: authorityFilePath, sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, httpPort: 43129 });
    const homeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const target = new URL(String(url));
      // Home is substituted above; health and useful requests still reach the
      // actual runner-owned loopback child through the network boundary.
      if (target.pathname !== AGENT_RUNTIME_DAEMON_SERVICES_PATH) return await (
        target.hostname === '127.0.0.1' ? networkFetch : homeFetch
      )(url, init);
      const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
      const response = await h.dispatch(request.operation, request.context.executionRunSnapshotId);
      return Response.json(response);
    });
    const source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: h.f.directory,
      publicReleaseRing: configuration.publicReleaseRing, authorityFilePath, expectedSessionId: h.sessionId });
    if (!source) throw new Error('Missing current public Session runner source');
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, h.signal]);
    let service: ManagedServiceHandle | undefined;
    try {
      const services = await source.createInvocationServices({ pluginId: source.identity.pluginId,
        pluginVersion: source.identity.pluginVersion, agentId: source.identity.agentId,
        occurrenceId: source.identity.occurrenceId, correlationId: 'public-managed-agent', cwd: h.cwd,
        processOwner: { kind: 'session', sessionId: h.sessionId }, environment: {}, signal,
        // The real runner's Session binding scopes managed services separately
        // from process ownership; this fixture has no interactive presenter.
        session: { id: h.sessionId, current: { interactions: createUnavailableCurrentSessionInteractionOwner() } },
        isOccurrenceCurrent: source.identity.isCurrent });
      const spawning = services.managedServices.supervise(buildOpenCodeManagedServerSpawnSpec({ id: 'opencode-server',
        dialect: 'v1', systemToolId: OPEN_CODE_SYSTEM_TOOL_ID, durableLog: false }), { signal })
        .then(handle => { service = handle; return handle; });
      if (isolated) {
        const outcome = await spawning.then(handle => ({ kind: 'started' as const, handle }),
          error => ({ kind: 'refused' as const, error: error as unknown }));
        if (outcome.kind === 'started') {
          // If the guard is bypassed, establish the actual child effect before
          // the strict refusal assertion fails; a registration alone proves none.
          expect(await outcome.handle.waitUntilHealthy({ signal })).toMatchObject({ state: 'healthy', mode: 'spawn' });
          expect(await readFile(started, 'utf8')).toBe('PUBLIC_MANAGED_OWNER_READY');
        }
        expect(outcome).toMatchObject({ kind: 'refused', error: { code: 'agent_isolation_unavailable', retryable: false } });
        expect(existsSync(started)).toBe(false);
        return;
      }
      service = await spawning;
      expect(await service.waitUntilHealthy({ signal })).toMatchObject({ state: 'healthy', mode: 'spawn' });
      expect(await readFile(started, 'utf8')).toBe('PUBLIC_MANAGED_OWNER_READY');
      const response = await service.request({ pathAndQuery: '/owner-proof', signal });
      expect(response.ok).toBe(true);
      if (!response.body) throw new Error('Useful owner managed response omitted its body');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      try {
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; chunks.push(chunk.value); }
      } finally { reader.releaseLock(); }
      expect(Buffer.concat(chunks).toString('utf8')).toBe('PUBLIC_MANAGED_OWNER_READY');
    } finally {
      await service?.dispose();
      controller.abort();
      await source.retire?.();
    }
  }, 120_000);
