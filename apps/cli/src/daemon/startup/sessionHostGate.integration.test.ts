import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { appendFile, cp, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { loadavg, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { z } from 'zod/mini';
import { SessionSpawnNewInputV2Schema, SessionSpawnNewActionResultV1Schema,
  projectSessionSpawnNewActionInputV2 } from '@happier-dev/protocol';
import type { ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { configuration, reloadConfiguration } from '@/configuration';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { readDaemonState, writeCredentialsTokenOnly } from '@/persistence';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createFirstConversationAgentFixture } from '@/daemon/testkit/firstConversationAgent.testkit';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import { daemonPost } from '@/daemon/controlHttp';
import { stopDaemonSession } from '@/daemon/controlClient';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { CLI_API_TOKEN_ENV, CLI_API_TOKEN_HANDOFF_ENV } from '@/auth/cliApiToken';
import { PROCESS_OWNER_ENV_KEY } from '@/processes/ownerTag';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { isSessionHostProcessCommand } from '@/daemon/sessionHost/daemonSessionHost';

/**
 * Phase-3 session host gate: a real source daemon (Bun by default, the shipped runtime; set
 * HAPPIER_SESSION_HOST_GATE_RUNTIME=node for Node) with the session host placement on, real
 * per-Session holders and a held fixture ACP Agent, against the workflow server testkit.
 * 1. N=1/3/10: host USS/PSS, daemon USS, process census, time to open each Session.
 * 2. Soak at N=10 (host lag sampler = 100 ms timer preloaded into the Bun processes).
 * 3. Host SIGKILL mid-turn at N=3: one new host, same Agents, one settled turn per Session, and
 *    all emitted chunks present exactly once in order.
 * 4. An Agent exits after host SIGKILL: accept its final stdout and settle its turn before the holder leaves.
 * Warm phase: two sequential Starts around a short idle gap, with an idle PSS sample.
 * 5. Host update: the daemon restarts from another runtime identity (a `versions/<v>` path
 *    before, the checkout after) while turns stream; the old host hands over (exit 75).
 * Scratch measurement harness (gated). Results and logs: HAPPIER_SESSION_HOST_GATE_DIR.
 * HAPPIER_SESSION_HOST_GATE_INSTALL=<install home> with HAPPIER_SESSION_HOST_GATE_VERSION_A/_B runs
 * the installed executables instead (`<home>/cli/versions/<v>/happier <v>/package-dist/index.mjs`,
 * as installs spawn them): daemon A from version A, daemon B from version B. The fixture plugin is
 * then written to that install's plugin store, where the installed daemons read it.
 */

const childrenSchema = z.object({ children: z.array(z.object({ happySessionId: z.string(), pid: z.number() })) });
const SHORT_CHUNKS = 2;
const LONG_CHUNKS = 240;
/** Fixture emission period of a LONG turn (one chunk per period). */
const LONG_CHUNK_PERIOD_MS = 250;
const SHORT_CHUNK_PERIOD_MS = 50;
const gateRuntime = process.env.HAPPIER_SESSION_HOST_GATE_RUNTIME === 'node' ? 'node' : 'bun';
const gateBun = process.env.HAPPIER_SESSION_HOST_GATE_BUN ?? 'bun';
const soakMs = Number(process.env.HAPPIER_SESSION_HOST_GATE_SOAK_MS ?? 120_000);
const bundleEntry = process.env.HAPPIER_SESSION_HOST_GATE_ENTRY === 'bundle';
// Comma list of phases to run (open = N=1/3/10 + soak + stop): reruns of crash/update skip the rest.
// Read before the gate clears HAPPIER_* keys from the environment.
const gateSettleMs = Number(process.env.HAPPIER_SESSION_HOST_GATE_SETTLE_MS ?? 0);
const gateInstallHome = process.env.HAPPIER_SESSION_HOST_GATE_INSTALL?.trim() || null;
const gateInstallVersions = [process.env.HAPPIER_SESSION_HOST_GATE_VERSION_A, process.env.HAPPIER_SESSION_HOST_GATE_VERSION_B];
const gatePhases = new Set((process.env.HAPPIER_SESSION_HOST_GATE_PHASES ?? 'open,crash,crash-exit,update').split(',').map(phase => phase.trim()));

function agentSource(stateDirectory: string): string {
  return String.raw`
import { appendFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const state = ${JSON.stringify(stateDirectory)};
appendFileSync(state + '/pids', process.pid + ' ' + process.cwd() + '\n');
const record = message => JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n';
const send = message => process.stdout.write(record(message));
const modes = { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] };
// Like a real ACP Agent: launch the configured stdio Happier MCP server (the holder relay) as a
// child, initialize it, list its tools and call one; record the outcome per Agent pid.
const startMcp = servers => {
  const server = servers.find(entry => entry.name === 'happier' && entry.command);
  if (!server) return appendFileSync(state + '/mcp-' + process.pid, 'none ' + JSON.stringify(servers.map(entry => entry.name)) + '\n');
  const env = { ...process.env, ...Object.fromEntries((server.env ?? []).map(item => [item.name, item.value])) };
  const mcp = spawn(server.command, server.args ?? [], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  appendFileSync(state + '/mcp-' + process.pid, 'spawned ' + mcp.pid + '\n');
  const call = (id, method, params) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  createInterface({ input: mcp.stdout }).on('line', line => {
    const reply = JSON.parse(line);
    if (reply.id === 1) { mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); call(2, 'tools/list', {}); }
    if (reply.id === 2) { appendFileSync(state + '/mcp-' + process.pid, 'tools ' + (reply.result?.tools?.length ?? 'error') + '\n');
      call(3, 'tools/call', { name: 'action_spec_search', arguments: { query: 'session' } }); }
    if (reply.id === 3) appendFileSync(state + '/mcp-' + process.pid, 'call ' + (reply.result ? 'ok' : 'error') + '\n');
  });
  mcp.on('exit', code => appendFileSync(state + '/mcp-' + process.pid, 'exit ' + code + '\n'));
  call(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'shgate-acp', version: '1' } });
};
// Each Agent opens its own provider conversation (a shared id is one conversation in two Sessions,
// which the daemon rightly refuses to respawn twice).
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(state + '/methods', process.pid + ' ' + (request.method ?? 'response') + '\n');
  if (request.method === 'initialize') return send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (request.method === 'session/new') { startMcp(request.params?.mcpServers ?? []); return send({ id: request.id, result: { sessionId: 'acp-held-' + process.pid, modes } }); }
  if (request.method === 'session/load') return send({ id: request.id, result: { modes } });
  if (request.method === 'session/set_mode') return send(request.params.modeId === 'default'
    ? { id: request.id, result: {} }
    : { id: request.id, error: { code: -32602, message: 'Unsupported fixture mode' } });
  if (request.method !== 'session/prompt') return request.id === undefined ? undefined : send({ id: request.id, result: {} });
  const total = JSON.stringify(request.params.prompt ?? '').includes('LONG') ? ${LONG_CHUNKS} : ${SHORT_CHUNKS};
  const exitsDuringCrash = JSON.stringify(request.params.prompt ?? '').includes('EXIT_AFTER_CRASH');
  const chunk = n => record({ method: 'session/update', params: { sessionId: request.params.sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk-' + n + ' ' } } } });
  let n = 0;
  const timer = setInterval(() => {
    const emitted = state + '/chunks-' + process.pid;
    if (exitsDuringCrash && existsSync(state + '/exit-after-crash-' + process.pid)) {
      clearInterval(timer);
      // Two complete records in one pipe write, followed by exit without a prompt response.
      process.stdout.write(chunk(n + 1) + chunk(n + 2), () => {
        appendFileSync(emitted, (n + 1) + '\n' + (n + 2) + '\n');
        process.exit(42);
      });
      return;
    }
    if (exitsDuringCrash && n >= 5) return;
    process.stdout.write(chunk(++n));
    appendFileSync(emitted, n + '\n');
    if (n === total) { clearInterval(timer); send({ id: request.id, result: { stopReason: 'end_turn' } }); }
  }, total > ${SHORT_CHUNKS} ? ${LONG_CHUNK_PERIOD_MS} : ${SHORT_CHUNK_PERIOD_MS});
});
`;
}

/** 100 ms timer-lag + CPU sampler preloaded into the daemon and session host (5 s windows). */
function lagSamplerSource(lagDirectory: string): string {
  return String.raw`
import { appendFileSync } from 'node:fs';
const role = process.argv.includes('session-host') ? 'host' : process.argv.includes('start-sync') ? 'daemon' : null;
if (role) {
  const file = ${JSON.stringify(lagDirectory)} + '/' + role + '-' + process.pid + '.jsonl';
  let last = performance.now(); let max = 0; let sum = 0; let count = 0; let over100 = 0; let over1000 = 0;
  setInterval(() => {
    const now = performance.now(); const lag = Math.max(0, now - last - 100); last = now;
    max = Math.max(max, lag); sum += lag; count += 1; if (lag > 100) over100 += 1; if (lag > 1000) over1000 += 1;
  }, 100).unref();
  setInterval(() => {
    const cpu = process.cpuUsage();
    appendFileSync(file, JSON.stringify({ t: Date.now(), maxLagMs: Math.round(max), meanLagMs: count ? Math.round(sum / count) : 0,
      samples: count, over100, over1000, cpuUs: cpu.user + cpu.system }) + '\n');
    max = 0; sum = 0; count = 0; over100 = 0; over1000 = 0;
  }, 5000).unref();
  process.on('exit', code => appendFileSync(file, JSON.stringify({ t: Date.now(), exit: code }) + '\n'));
}
`;
}

it.skipIf(process.env.HAPPIER_RUN_SESSION_HOST_GATE !== '1')(
  'session host gate: host USS and open time at N=1/3/10, soak lag, host crash and host update mid-turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-shgate-'));
  const workspace = join(directory, 'workspace');
  const agentState = join(directory, 'agent-state');
  await mkdir(workspace);
  await mkdir(agentState);
  const gateDir = process.env.HAPPIER_SESSION_HOST_GATE_DIR ?? join(tmpdir(), `${basename(directory)}-gate`);
  const lagDir = join(gateDir, 'lag');
  await mkdir(lagDir, { recursive: true });
  const lagPreload = join(directory, 'lag-sampler.mjs');
  await writeFile(lagPreload, lagSamplerSource(lagDir));
  const environment = createEnvKeyScope([...Object.keys(process.env).filter(key => key.startsWith('HAPPIER_')),
    'DEBUG', CLI_API_TOKEN_ENV, CLI_API_TOKEN_HANDOFF_ENV, PROCESS_OWNER_ENV_KEY,
    // The scope patches only declared keys: declare every key this gate sets.
    'HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL',
    'HAPPIER_CLI_SUBPROCESS_PREFER_TSX', 'HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK', 'HAPPIER_DAEMON_WAIT_FOR_AUTH',
    'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID', 'HAPPIER_DAEMON_SESSION_RESPAWN_BASE_DELAY_MS', 'HAPPIER_DAEMON_SESSION_RESPAWN_JITTER_MS',
    'HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED', 'HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED',
    'HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK', 'HAPPIER_FIRST_PARTY_INSTALL_HOME']);
  const lifetime = new AbortController();
  const daemons: { child: ChildProcess; closed: Promise<unknown>; logPath: string }[] = [];
  let completed = false;
  let plugin: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
  const serverPath = '../../../../server/sources/testkit/workflowApprovedOperationServer.testkit';
  const server: typeof import('../../../../server/sources/testkit/workflowApprovedOperationServer.testkit') = await import(serverPath);
  let home: Awaited<ReturnType<typeof server.startWorkflowApprovedOperationServer>> | undefined;
  const ownedPids = new Set<number>();
  onTestFinished(async () => {
    lifetime.abort();
    try {
      const state = await readDaemonState();
      if (state && daemons.some(({ child }) => child.pid === state.pid && child.exitCode === null)) {
        for (const session of (await home?.readWorkflowSessionEffects())?.sessions ?? []) {
          await stopDaemonSession(session.id, { target: state }).catch(() => undefined);
        }
      }
    } finally {
      // Only PIDs this isolated fixture started or observed as its own children.
      for (const pid of ownedPids) {
        if (!await waitForProcessExit(pid, { timeoutMs: 0 })) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
      for (const daemon of daemons) {
        if (daemon.child.exitCode === null && daemon.child.signalCode === null) daemon.child.kill('SIGTERM');
        await daemon.closed;
      }
      await cp(configuration.logsDir, join(gateDir, 'logs'), { recursive: true }).catch(() => {});
      console.info('[shgate] logs', gateDir, 'completed', completed);
      try { await plugin?.dispose(); }
      finally { try { await home?.close(); }
        finally { environment.restore(); reloadConfiguration(); if (completed) await rm(directory, { recursive: true, force: true }); } }
    }
  });
  environment.patch(Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith('HAPPIER_')).map(key => [key, undefined])));
  const serverId = 'shgate';
  // An installed daemon resolves its plugin store from its install home: the fixture writes there too.
  if (gateInstallHome) environment.patch({ HAPPIER_FIRST_PARTY_INSTALL_HOME: gateInstallHome });
  environment.patch({ HAPPIER_HOME_DIR: directory, HAPPIER_ACTIVE_SERVER_ID: serverId,
    [CLI_API_TOKEN_ENV]: undefined, [CLI_API_TOKEN_HANDOFF_ENV]: undefined, [PROCESS_OWNER_ENV_KEY]: undefined });
  reloadConfiguration();
  const installation = await readOrCreateInstallationIdentity();
  const machineId = randomUUID();
  home = await server.startWorkflowApprovedOperationServer({ installedMachine: { machineId, installation, happyHomeDir: directory } });
  const boundHome = home;
  if (!home.installedToken) throw new Error('Installed terminal credential was not minted');
  environment.patch({ DEBUG: '1', HAPPIER_SERVER_URL: home.baseUrl, HAPPIER_WEBAPP_URL: home.baseUrl,
    ...bundleEntry ? {} : { HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '1', HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '1' },
    HAPPIER_DAEMON_WAIT_FOR_AUTH: '1', HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: serverId,
    HAPPIER_DAEMON_SESSION_RESPAWN_BASE_DELAY_MS: '0', HAPPIER_DAEMON_SESSION_RESPAWN_JITTER_MS: '0',
    HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0',
    HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '0' });
  await writeDaemonSettingsFixture(directory, { activeServerId: serverId,
    servers: { [serverId]: { id: serverId, name: serverId, serverUrl: home.baseUrl, webappUrl: home.baseUrl,
      createdAt: 0, updatedAt: 0, lastUsedAt: 0 } },
    machineIdByServerIdByAccountId: { [serverId]: { [home.accountId]: machineId } },
    lastTokenSubByServerId: { [serverId]: home.accountId } });
  reloadConfiguration();
  await seedTestServerProfile({ id: serverId, homeId: home.homeId, serverUrl: home.baseUrl });
  await writeCredentialsTokenOnly({ token: home.installedToken });
  reloadConfiguration();
  // Runners deny path-only runtimes by name (bundle and source): run the fixture Agent through a renamed copy.
  const agentRuntime = join(directory, 'shgate-acp-agent');
  await cp(process.execPath, agentRuntime);
  const conversation = createFirstConversationAgentFixture('SHGATE', {
    fixedDefaultPermission: true,
    nativeAcp: { source: agentSource(agentState), executablePath: agentRuntime, resumable: true },
  });
  const agentIdentity = { pluginId: conversation.manifest.id, localId: conversation.manifest.contributes.agents[0]!.id };
  plugin = await runWithServerHttpBaseUrl(boundHome.baseUrl, () => createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: directory,
    plugins: [{ ...conversation, includeAvailability: true }] }));
  const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
  const pidLog = join(gateDir, 'pids.txt');
  const recordPid = async (pid: number, role: string) => {
    if (ownedPids.has(pid)) return;
    ownedPids.add(pid);
    await appendFile(pidLog, `${new Date().toISOString()} ${pid} ${role}\n`);
  };
  // Runtime identity before the update: the CLI as installed under `versions/<v>/` (a symlink to
  // this checkout). After the update the daemon runs from the checkout path itself.
  // HAPPIER_SESSION_HOST_GATE_ENTRY=bundle runs the built CLI bundle (`apps/cli/dist/index.mjs`),
  // the npm pkgroll shape (dependencies stay external; the native executable inlines them):
  // no source-dev preflight.
  const entryPath = bundleEntry ? 'dist/index.mjs' : 'src/index.ts';
  const realEntry = join(repository, 'apps/cli', entryPath);
  const oldVersionRoot = join(directory, 'versions', '0.3.0-gate-old');
  // Source mode keeps the `apps/cli/src/index.ts` shape the daemon recognizes as a Session runner
  // (`classifyHappyProcess`); installed versions run the bundle, which `…/cli/dist/index.mjs` matches.
  const oldCliDir = join(oldVersionRoot, bundleEntry ? 'cli' : 'apps/cli');
  await mkdir(dirname(oldCliDir), { recursive: true });
  await symlink(join(repository, 'apps/cli'), oldCliDir);
  const oldEntry = join(oldCliDir, entryPath);
  const installedVersionDir = (entry: string) => {
    const version = gateInstallVersions[entry === oldEntry ? 0 : 1];
    if (!gateInstallHome || !version) throw new Error('HAPPIER_SESSION_HOST_GATE_INSTALL needs _VERSION_A and _VERSION_B');
    return join(gateInstallHome, 'cli', 'versions', version);
  };
  const startGateDaemon = async (label: string, entry: string) => {
    const output = createWriteStream(join(gateDir, `daemon-${label}.log`));
    const daemon = gateInstallHome
      ? spawn(join(installedVersionDir(entry), process.platform === 'win32' ? 'happier.exe' : 'happier'),
        [join(installedVersionDir(entry), 'package-dist', 'index.mjs'), 'daemon', 'start-sync'],
        // The single executable honors NODE_OPTIONS: daemon and hosts load the lag sampler.
        { cwd: repository, env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(lagPreload).href}` },
          stdio: ['ignore', 'pipe', 'pipe'] })
      : gateRuntime === 'bun'
      ? spawn(gateBun, [entry, 'daemon', 'start-sync'], { cwd: repository,
        env: { ...process.env, BUN_OPTIONS: `${bundleEntry ? '' : '--conditions=happier-source '}--preload ${lagPreload}`,
          HAPPIER_CLI_SUBPROCESS_RUNTIME: 'bun', HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entry }, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(process.execPath, [...bundleEntry ? [] : ['--conditions=happier-source', '--import',
        join(repository, 'packages/cli-common/registerSourceRuntime.mjs')], entry, 'daemon', 'start-sync'],
      { cwd: repository, env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(lagPreload).href}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    daemon.stdout!.pipe(output); daemon.stderr!.pipe(output, { end: false });
    const closed = once(daemon, 'exit');
    daemons.push({ child: daemon, closed, logPath: String(output.path) });
    await recordPid(daemon.pid!, `daemon-${label}`);
    const started = performance.now();
    await Promise.race([(async () => {
      for (;;) {
        if ((await readDaemonState())?.pid === daemon.pid) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      await Promise.all([
        boundHome.waitForMachineRpc(machineId, RPC_METHODS.CAPABILITIES_DESCRIBE, lifetime.signal),
        boundHome.waitForMachineRpc(machineId, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, lifetime.signal),
      ]);
    })(), closed.then(([code, signal]) => { throw new Error(`Daemon ${label} ended before registering; code=${code} signal=${signal}`); })]);
    console.info('[shgate] daemon', label, daemon.pid, 'ready ms', Math.round(performance.now() - started));
    return { child: daemon, closed };
  };
  const daemonA = await startGateDaemon('a-old-version', oldEntry);
  // A source daemon refuses spawns until its Machine snapshot arrives (P03-Q6-PREFLIGHT: ~90 s); opt-in settle.
  await new Promise(resolve => setTimeout(resolve, gateSettleMs));

  const execute = async (actionId: string, input: unknown, projectDirectory: string) => {
    const target = { kind: 'machine' as const, machineId, project: { machineId, directory: projectDirectory } };
    const requestId = randomUUID();
    const send = (actionInput: unknown, presentUserConfirmation?: ExternalActionRequesterInvocationV1['presentUserConfirmation']) =>
      dispatchOriginalAccountAction({ actionId, input: actionInput, requestId, target,
        credentials: { token: boundHome.token, encryption: null }, serverHttpBaseUrl: boundHome.baseUrl,
        serverIdentityId: boundHome.homeId, authority: 'present_user',
        invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user',
          ...(presentUserConfirmation ? { presentUserConfirmation } : {}) },
        signal: lifetime.signal });
    const reviewed = await send(input);
    if (reviewed?.ok !== false || reviewed.errorCode !== 'action_interactive_review_required') return reviewed;
    const details = z.object({ review: z.object({ actionArgs: z.unknown() }), reviewDigest: z.string() }).parse(reviewed.details);
    return await send(details.review.actionArgs, { actionId: ActionIdSchema.parse(actionId),
      inputDigest: computeActionInputApprovalDigestV1(ActionIdSchema.parse(actionId), details.review.actionArgs),
      reviewDigest: details.reviewDigest, requestId, accountId: boundHome.accountId,
      serverId: boundHome.homeId, target });
  };
  const readLines = async (name: string) => (await readFile(join(agentState, name), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  const waitFor = async <T>(read: () => Promise<T | null | undefined>, label: string, timeoutMs = 180_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  };
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const round = (value: number) => Math.round(value * 10) / 10;

  const smaps = async (pid: number) => {
    const text = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8').catch(() => '');
    const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text)?.[1] ?? 0) / 1024;
    return { uss: round(kb('Private_Clean') + kb('Private_Dirty')), pss: round(kb('Pss')), rss: round(kb('Rss')) };
  };
  const cpuTicks = async (pid: number) => {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(fields[11] ?? 0) + Number(fields[12] ?? 0);
  };
  type ProcRow = { pid: number; ppid: number; cmd: string };
  const readProcs = async (): Promise<ProcRow[]> => {
    const rows: ProcRow[] = [];
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const stat = await readFile(`/proc/${name}/stat`, 'utf8').catch(() => null);
      if (!stat) continue;
      const cmd = (await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '')).replaceAll('\0', ' ').trim();
      rows.push({ pid: Number(name), ppid: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]), cmd });
    }
    return rows;
  };
  const listChildren = async () => childrenSchema.parse(await daemonPost('/list', {})).children;
  const agentRows = async () => (await readLines('pids')).map(line => {
    const [pid, ...cwd] = line.split(' ');
    return { pid: Number(pid), cwd: cwd.join(' ') };
  });
  const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  type GateSession = { sessionId: string; workspace: string; actionMs: number; listedMs: number; hostPid: number; agentPid?: number };
  let workspaceSeq = 0;
  const openSession = async (text: string): Promise<GateSession> => {
    const sessionWorkspace = join(workspace, `ws-${++workspaceSeq}`);
    await mkdir(sessionWorkspace);
    const started = performance.now();
    const birth = await execute('session.spawn_new', projectSessionSpawnNewActionInputV2(SessionSpawnNewInputV2Schema.parse({
      creationKey: randomUUID(), executionTarget: { serverId, machineId }, directory: { kind: 'path', path: sessionWorkspace },
      organizationPlacement: { folderId: null, tagIds: [] }, agentTarget: { kind: 'agent', identity: agentIdentity },
      connectedServices: { v: 2, bindingsByServiceId: {} }, initialInput: { text },
    })), sessionWorkspace);
    if (!birth?.ok) throw new Error(`Session birth refused ${JSON.stringify(birth)}`);
    const created = SessionSpawnNewActionResultV1Schema.parse(birth.result);
    if (created.type !== 'success') {
      const outcome = created.type === 'error' ? created.code : created.outcome;
      throw new Error(`Session did not start (${created.type}: ${outcome})`);
    }
    const actionMs = performance.now() - started;
    const hostPid = await waitFor(async () => (await listChildren()).find(child => child.happySessionId === created.sessionId)?.pid, 'listed');
    const listedMs = performance.now() - started;
    await recordPid(hostPid, 'session-host');
    return { sessionId: created.sessionId, workspace: sessionWorkspace, actionMs: round(actionMs), listedMs: round(listedMs), hostPid };
  };
  const chunkCount = async (agentPid: number) => (await readLines(`chunks-${agentPid}`)).length;
  const agentOf = async (session: GateSession) => session.agentPid ??= await waitFor(async () => {
    const candidates = (await agentRows()).filter(agent => agent.cwd === session.workspace && isAlive(agent.pid)).reverse();
    for (const { pid } of candidates) {
      if (await chunkCount(pid) === 0) continue;
      await recordPid(pid, `agent ${session.sessionId}`);
      return pid;
    }
    return null;
  }, `streaming Agent of ${session.sessionId}`);
  const agentMethods = async (pids: readonly number[]) => {
    const methods = (await readLines('methods')).map(line => line.split(' '));
    return pids.map(pid => {
      const mine = methods.filter(([owner]) => owner === String(pid)).map(([, method]) => method);
      return { initialize: mine.filter(m => m === 'initialize').length, prompt: mine.filter(m => m === 'session/prompt').length,
        load: mine.filter(m => m === 'session/load').length };
    });
  };
  const turnsOf = async (ids: readonly string[]) => (await boundHome.readWorkflowSessionEffects()).turns.filter(turn => ids.includes(turn.sessionId));
  const waitTurnsSettled = async (group: readonly GateSession[], timeoutMs = 180_000) => await waitFor(async () => {
    const turns = await turnsOf(group.map(s => s.sessionId));
    // A turn is open while running, in progress or waiting; stopping the group earlier ends live adopted turns.
    const open = new Set(['running', 'in_progress', 'waiting', 'pending']);
    return turns.length >= group.length && turns.every(turn => !open.has(turn.status)) ? turns : null;
  }, 'turns settled', timeoutMs);
  const census = async (group: readonly GateSession[]) => {
    const procs = await readProcs();
    const byPid = new Map(procs.map(row => [row.pid, row]));
    const daemonPid = (await readDaemonState())?.pid ?? -1;
    const descendants = new Set([daemonPid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const row of procs) if (!descendants.has(row.pid) && descendants.has(row.ppid)) { descendants.add(row.pid); grew = true; }
    }
    descendants.delete(daemonPid);
    const listed = await listChildren();
    const ids = new Set(group.map(s => s.sessionId));
    const hosts = [...new Set([...listed.filter(child => ids.has(child.happySessionId)).map(child => child.pid),
      ...[...descendants].filter(pid => isSessionHostProcessCommand(byPid.get(pid)?.cmd))])].filter(pid => byPid.has(pid));
    const agents = (await agentRows()).map(row => row.pid).filter(pid => byPid.has(pid));
    const holders = [...new Set(agents.map(pid => byPid.get(pid)!.ppid))];
    for (const pid of holders) await recordPid(pid, 'holder');
    const agentSet = new Set(agents);
    const relays = procs.filter(row => agentSet.has(row.ppid) && row.cmd.includes('mcp-relay')).map(row => row.pid);
    for (const pid of relays) await recordPid(pid, 'mcp-relay');
    const known = new Set([...hosts, ...agents, ...holders, ...relays]);
    const runners = [...descendants].filter(pid => !known.has(pid) && /(src\/index\.ts|index\.mjs)/.test(byPid.get(pid)!.cmd));
    const other = [...descendants].filter(pid => !known.has(pid) && !runners.includes(pid))
      .map(pid => byPid.get(pid)!.cmd.split(' ').slice(0, 2).map(token => basename(token)).join(' '));
    return { daemonPid, hosts, runners, holders, agents, relays, other,
      holderCommands: [...new Set(holders.map(pid => basename(byPid.get(pid)?.cmd.split(' ')[0] ?? '?')))] };
  };
  /** Contiguity of the streamed chunks of one Session's transcript: each number once, in order. */
  const transcriptChunkNumbers = async (sessionId: string) => {
    const effects = await boundHome.readWorkflowSessionEffects();
    const text = JSON.stringify(effects.messages.filter(message => message.sessionId === sessionId).map(message => message.content));
    return [...text.matchAll(/chunk-(\d+) /g)].map(match => Number(match[1]));
  };
  const transcriptChunks = async (sessionId: string) => {
    const seen = await transcriptChunkNumbers(sessionId);
    const counts = new Map<number, number>();
    for (const n of seen) counts.set(n, (counts.get(n) ?? 0) + 1);
    const max = Math.max(0, ...seen);
    const missing = Array.from({ length: max }, (_, i) => i + 1).filter(n => !counts.has(n));
    const duplicated = [...counts].filter(([, count]) => count > 1).map(([n]) => n);
    const inOrder = seen.every((n, i) => i === 0 || n > seen[i - 1]!);
    return { delivered: seen.length, max, missing, duplicated, inOrder };
  };
  const lagWindow = async (role: 'host' | 'daemon', pid: number, fromMs: number, toMs: number) => {
    const lines = (await readFile(join(lagDir, `${role}-${pid}.jsonl`), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { t: number; maxLagMs?: number; meanLagMs?: number; over100?: number; over1000?: number; cpuUs?: number; exit?: number });
    const inWindow = lines.filter(line => line.t >= fromMs && line.t <= toMs + 5_000 && line.maxLagMs !== undefined);
    const exit = lines.find(line => line.exit !== undefined)?.exit ?? null;
    if (!inWindow.length) return { windows: 0, exit };
    return { windows: inWindow.length, maxLagMs: Math.max(...inWindow.map(line => line.maxLagMs!)),
      meanOfMeansMs: Math.round(inWindow.reduce((sum, line) => sum + line.meanLagMs!, 0) / inWindow.length),
      over100: inWindow.reduce((sum, line) => sum + line.over100!, 0), over1000: inWindow.reduce((sum, line) => sum + line.over1000!, 0), exit };
  };
  const stopGroup = async (group: readonly GateSession[]) => {
    const { holders: holderPids } = await census(group);
    const state = await readDaemonState();
    for (const s of group) await stopDaemonSession(s.sessionId, { target: state! }).catch(() => undefined);
    const hostPids = [...new Set(group.map(s => s.hostPid))];
    const agentPids = group.map(s => s.agentPid).filter((pid): pid is number => pid !== undefined);
    const waitForExit = (pid: number) => waitForProcessExit(pid, { timeoutMs: 60_000 });
    const [hostExited, agentsExited, holdersExited] = await Promise.all([
      Promise.all(hostPids.map(waitForExit)),
      Promise.all(agentPids.map(waitForExit)),
      Promise.all(holderPids.map(waitForExit)),
    ]);
    return { hostExited, agentsExited, holdersExited };
  };
  const expectStopped = (result: Awaited<ReturnType<typeof stopGroup>>, sessionCount: number) => {
    expect(result.hostExited).toEqual([true]);
    expect(result.agentsExited).toEqual(Array.from({ length: sessionCount }, () => true));
    expect(result.holdersExited).toEqual(Array.from({ length: sessionCount }, () => true));
  };
  const results: Record<string, unknown> = { runtime: gateRuntime, entry: bundleEntry ? 'bundle' : 'source', bun: gateRuntime === 'bun' ? gateBun : null, startedAt: new Date().toISOString() };
  const save = async () => await writeFile(join(gateDir, 'results.json'), JSON.stringify(results, null, 1));

  if (gatePhases.has('warm')) {
    const loadAtStart = loadavg();
    const before = await openSession('SHGATE');
    await agentOf(before);
    await waitTurnsSettled([before]);
    const state = (await readDaemonState())!;
    const readDaemonLog = async () => await readFile(state.daemonLogPath!, 'utf8');
    const hostLaunches = async () => (await readDaemonLog()).split('[DAEMON RUN] Session host launched').length - 1;
    const stop = async (session: GateSession) => {
      expect(await stopDaemonSession(session.sessionId, { target: state })).toMatchObject({ status: 'stopped' });
      await waitFor(async () => (await listChildren()).every(child => child.happySessionId !== session.sessionId) || null, 'Session ended');
    };
    await stop(before);
    const endedAt = performance.now();
    await sleep(2_000);
    const idleHost = await smaps(before.hostPid);
    const idleCpuTicks = await cpuTicks(before.hostPid);
    const launchesAtStart = await hostLaunches();
    const idleGapMs = round(performance.now() - endedAt);
    const after = await openSession('SHGATE');
    await agentOf(after);
    await waitTurnsSettled([after]);
    const postStartLaunches = await hostLaunches() - launchesAtStart;
    results.warm = { before, after, idleHost, idleCpuTicks, idleGapMs, postStartLaunches, loadAtStart, loadAtEnd: loadavg() };
    await save();
    console.info('[shgate] warm', JSON.stringify(results.warm));
    expect(launchesAtStart).toBe(1);
    expect(after.hostPid).toBe(before.hostPid);
    expect(postStartLaunches).toBe(0);
    await stop(after);
    expect(await waitForProcessExit(after.hostPid, { timeoutMs: 60_000 })).toBe(true);
    await waitFor(async () => (await readDaemonLog()).includes('[DAEMON RUN] Session host idle grace expired') || null, 'logged idle grace expiry');
  }

  // 1+2. N = 1, 3, 10 (2-chunk turns), then the soak at N=10.
  const sessions: GateSession[] = [];
  const memory: unknown[] = [];
  results.memory = memory;
  const openPhaseStart = Date.now();
  if (gatePhases.has('open')) {
  for (const target of [1, 3, 10]) {
    while (sessions.length < target) sessions.push(await openSession('SHGATE'));
    for (const s of sessions) await agentOf(s);
    await waitTurnsSettled(sessions);
    await sleep(10_000);
    const counted = await census(sessions);
    // On Linux scope launches the census also lists the host's scope-exec supervisor: the host is the large one.
    const hostMem = (await Promise.all(counted.hosts.map(smaps))).sort((a, b) => b.uss - a.uss)[0] ?? null;
    const holderMem = await Promise.all(counted.holders.map(smaps));
    const agentMem = await Promise.all(counted.agents.map(smaps));
    const relayMem = await Promise.all(counted.relays.map(smaps));
    memory.push({ n: sessions.length, census: { hosts: counted.hosts.length, runners: counted.runners.length,
      holders: counted.holders.length, agents: counted.agents.length, relays: counted.relays.length, other: counted.other, holderCommands: counted.holderCommands },
    hostPids: counted.hosts, host: hostMem, daemon: await smaps(counted.daemonPid),
    holderUssSum: round(holderMem.reduce((sum, m) => sum + m.uss, 0)), agentUssSum: round(agentMem.reduce((sum, m) => sum + m.uss, 0)),
    relays: counted.relays.length, relayUssSum: round(relayMem.reduce((sum, m) => sum + m.uss, 0)),
    mcp: await Promise.all(counted.agents.map(async pid => (await readLines(`mcp-${pid}`)).join(' | '))),
    openActionMs: sessions.map(s => s.actionMs), openListedMs: sessions.map(s => s.listedMs) });
    console.info('[shgate] memory', JSON.stringify(memory.at(-1)));
    await save();
  }
  const soakHost = sessions[0]!.hostPid;
  const soakStart = Date.now();
  const soakTicks0 = await cpuTicks(soakHost);
  const soakSamples: unknown[] = [];
  while (Date.now() - soakStart < soakMs) {
    await sleep(Math.min(15_000, soakMs));
    soakSamples.push({ atS: Math.round((Date.now() - soakStart) / 1000), host: await smaps(soakHost) });
  }
  results.soak = { n: sessions.length, hostPid: soakHost, durationS: Math.round((Date.now() - soakStart) / 1000),
    hostCpuS: round((await cpuTicks(soakHost) - soakTicks0) / 100), samples: soakSamples,
    hostLag: await lagWindow('host', soakHost, soakStart, Date.now()),
    hostLagDuringOpens: await lagWindow('host', soakHost, openPhaseStart, soakStart),
    daemonLag: await lagWindow('daemon', daemonA.child.pid!, soakStart, Date.now()) };
  console.info('[shgate] soak', JSON.stringify(results.soak));
  const stopTen = await stopGroup(sessions);
  results.stopTen = { ...stopTen, hostExitCode: (await lagWindow('host', soakHost, 0, Date.now())).exit };
  await save();
  }

  // 3. Host SIGKILL mid-turn, N=3.
  const crashGroup: GateSession[] = [];
  if (gatePhases.has('crash')) {
  for (let i = 0; i < 3; i++) crashGroup.push(await openSession('SHGATE LONG'));
  const crashAgents = await Promise.all(crashGroup.map(agentOf));
  await waitFor(async () => (await Promise.all(crashAgents.map(chunkCount))).every(count => count >= 5) || null, 'crash: chunks streaming');
  const crashHosts = [...new Set(crashGroup.map(s => s.hostPid))];
  const agentLinesBefore = (await agentRows()).length;
  const methodsBefore = await agentMethods(crashAgents);
  // Saved before the kill (in a transcript checkpoint the server holds): must all survive.
  const savedBeforeKill = await Promise.all(crashGroup.map(async s => await transcriptChunkNumbers(s.sessionId)));
  const chunksAtKill = await Promise.all(crashAgents.map(chunkCount));
  const killedAt = performance.now();
  for (const pid of crashHosts) process.kill(pid, 'SIGKILL');
  for (const pid of crashHosts) await waitForProcessExit(pid, { timeoutMs: 10_000 });
  // Chunks the Agents sent before the host was gone; later ones wait unacknowledged in the holder.
  const chunksAtKillExit = await Promise.all(crashAgents.map(chunkCount));
  const respawned = await waitFor(async () => {
    const listed = await listChildren();
    const rows = crashGroup.map(s => listed.find(child => child.happySessionId === s.sessionId && !crashHosts.includes(child.pid)));
    return rows.every(Boolean) ? rows.map(row => row!.pid) : null;
  }, 'crash: Sessions re-listed in a new host');
  const relistedMs = round(performance.now() - killedAt);
  for (const pid of respawned) await recordPid(pid, 'session-host (after crash)');
  const crashTurns = await waitTurnsSettled(crashGroup, 300_000);
  results.crash = { n: crashGroup.length, killedHosts: crashHosts, newHosts: [...new Set(respawned)], relistedMs, chunksAtKill,
    chunksAtKillExit, savedBeforeKill: savedBeforeKill.map(seen => ({ count: seen.length, max: Math.max(0, ...seen) })),
    agentsBefore: crashAgents, agentsAlive: crashAgents.map(isAlive), newAgentProcesses: (await agentRows()).length - agentLinesBefore,
    turnStatuses: crashTurns.map(turn => turn.status),
    methodsBefore, agentMethods: await agentMethods(crashAgents),
    agentSent: await Promise.all(crashAgents.map(chunkCount)),
    transcripts: await Promise.all(crashGroup.map(async (s, i) => {
      const transcript = await transcriptChunks(s.sessionId);
      const lostSaved = savedBeforeKill[i]!.filter(n => transcript.missing.includes(n));
      const lastSaved = Math.max(0, ...savedBeforeKill[i]!);
      // In flight at the kill: sent before the host was gone and newer than every saved chunk.
      const outsideInFlight = transcript.missing.filter(n => n <= lastSaved || n > chunksAtKillExit[i]!);
      return { ...transcript, lostSaved, outsideInFlight };
    })),
    killedHostLag: await lagWindow('host', crashHosts[0]!, 0, Date.now()) };
  for (const s of crashGroup) s.hostPid = respawned[crashGroup.indexOf(s)]!;
  console.info('[shgate] crash', JSON.stringify(results.crash));
  results.stopCrash = await stopGroup(crashGroup);
  await save();
  }

  const crashExitGroup: GateSession[] = [];
  if (gatePhases.has('crash-exit')) {
    const session = await openSession('SHGATE LONG EXIT_AFTER_CRASH');
    crashExitGroup.push(session);
    const agentPid = await agentOf(session);
    await waitFor(async () => (await chunkCount(agentPid)) >= 5 || null, 'crash-exit: turn streaming');
    const { holders } = await census(crashExitGroup);
    expect(holders).toHaveLength(1);
    const [holderPid] = holders as [number];
    const originalAgentCount = (await agentRows()).length;
    const methodsBefore = await agentMethods([agentPid]);

    // Keep this fixture's daemon from starting a successor until the Agent has exited.
    expect(daemonA.child.kill('SIGSTOP')).toBe(true);
    try {
      process.kill(session.hostPid, 'SIGKILL');
      expect(await waitForProcessExit(session.hostPid, { timeoutMs: 10_000 })).toBe(true);
      await writeFile(join(agentState, `exit-after-crash-${agentPid}`), '');
      expect(await waitForProcessExit(agentPid, { timeoutMs: 10_000 })).toBe(true);
      expect(isAlive(holderPid)).toBe(true);
    } finally {
      daemonA.child.kill('SIGCONT');
    }

    const turns = await waitTurnsSettled(crashExitGroup, 300_000);
    const agentSent = await chunkCount(agentPid);
    await waitFor(async () => (await transcriptChunkNumbers(session.sessionId)).includes(agentSent) || null,
      'crash-exit: final stdout committed');
    results.crashExit = {
      turnStatuses: turns.map(turn => turn.status),
      agentSent,
      newAgentProcesses: (await agentRows()).length - originalAgentCount,
      methodsBefore, agentMethods: await agentMethods([agentPid]),
      transcript: await transcriptChunks(session.sessionId),
      holderExited: await waitForProcessExit(holderPid, { timeoutMs: 60_000 }),
    };
    console.info('[shgate] crash-exit', JSON.stringify(results.crashExit));
    await save();
  }

  // 5. Host update: daemon restarts from another runtime identity while turns stream.
  const updateGroup: GateSession[] = [];
  let daemonB: Awaited<ReturnType<typeof startGateDaemon>> | undefined;
  if (gatePhases.has('update')) {
  for (let i = 0; i < 3; i++) updateGroup.push(await openSession('SHGATE LONG'));
  const updateAgents = await Promise.all(updateGroup.map(agentOf));
  await waitFor(async () => (await Promise.all(updateAgents.map(chunkCount))).every(count => count >= 5) || null, 'update: chunks streaming');
  const oldHosts = [...new Set(updateGroup.map(s => s.hostPid))];
  const updateAgentLinesBefore = (await agentRows()).length;
  const methodsBefore = await agentMethods(updateAgents);
  daemonA.child.kill('SIGTERM');
  const [daemonAExitCode, daemonASignal] = await daemonA.closed as [number | null, NodeJS.Signals | null];
  const chunksAtRestart = await Promise.all(updateAgents.map(chunkCount));
  const oldHostAliveAfterDaemonStop = oldHosts.map(isAlive);
  const restartAt = performance.now();
  daemonB = await startGateDaemon('b-current', realEntry);
  const oldHostExited = await Promise.all(oldHosts.map(pid => waitForProcessExit(pid, { timeoutMs: 180_000 })));
  const moved = await waitFor(async () => {
    const listed = await listChildren();
    const rows = updateGroup.map(s => listed.find(child => child.happySessionId === s.sessionId && !oldHosts.includes(child.pid)));
    return rows.every(Boolean) ? rows.map(row => row!.pid) : null;
  }, 'update: Sessions re-listed in a current host', 300_000);
  const movedMs = round(performance.now() - restartAt);
  for (const pid of moved) await recordPid(pid, 'session-host (after update)');
  const updateTurns = await waitTurnsSettled(updateGroup, 300_000);
  const daemonBLog = await readFile(join(gateDir, 'daemon-b-current.log'), 'utf8').catch(() => '');
  const newHostCommand = (await readFile(`/proc/${moved[0]}/cmdline`, 'utf8').catch(() => '')).replaceAll('\0', ' ');
  results.update = { n: updateGroup.length, oldHosts, oldHostAliveAfterDaemonStop, daemonAExit: { code: daemonAExitCode, signal: daemonASignal },
    oldHostExited, oldHostExitCodes: await Promise.all(oldHosts.map(async pid => (await lagWindow('host', pid, 0, Date.now())).exit)),
    newHosts: [...new Set(moved)], newHostRunsCheckoutEntry: newHostCommand.includes(gateInstallHome ? installedVersionDir(realEntry) : realEntry), movedMs, chunksAtRestart,
    agentsBefore: updateAgents, agentsAlive: updateAgents.map(isAlive), newAgentProcesses: (await agentRows()).length - updateAgentLinesBefore,
    turnStatuses: updateTurns.map(turn => turn.status),
    methodsBefore, agentMethods: await agentMethods(updateAgents),
    agentSent: await Promise.all(updateAgents.map(chunkCount)),
    transcripts: await Promise.all(updateGroup.map(s => transcriptChunks(s.sessionId))),
    handoverRequestLogged: /asked to hand over/.test(daemonBLog) };
  for (const s of updateGroup) s.hostPid = moved[updateGroup.indexOf(s)]!;
  console.info('[shgate] update', JSON.stringify(results.update));
  results.stopUpdate = await stopGroup(updateGroup);
  }
  results.finalCensus = await census([...sessions, ...crashGroup, ...crashExitGroup, ...updateGroup]);
  results.daemonB = { pid: daemonB?.child.pid ?? null };
  await save();

  // Gate verdicts (after every measurement is saved).
  type PhaseVerdict = { newHosts: number[]; agentsAlive: boolean[]; newAgentProcesses: number; turnStatuses: string[];
    methodsBefore: Awaited<ReturnType<typeof agentMethods>>;
    agentMethods: Awaited<ReturnType<typeof agentMethods>>;
    transcripts: { missing: number[]; duplicated: number[]; max: number; inOrder: boolean }[] };
  if (gatePhases.has('crash')) {
  const crash = results.crash as PhaseVerdict;
  expect(crash.newHosts).toHaveLength(1);
  expect(crash.agentsAlive.every(Boolean)).toBe(true);
  expect(crash.newAgentProcesses).toBe(0);
  expect(crash.turnStatuses).toEqual(crashGroup.map(() => 'completed'));
  expect(crash.agentMethods).toEqual(crash.methodsBefore);
  for (const transcript of crash.transcripts) {
    expect(transcript).toMatchObject({ missing: [], duplicated: [], inOrder: true, max: LONG_CHUNKS });
  }
  expectStopped(results.stopCrash as Awaited<ReturnType<typeof stopGroup>>, crashGroup.length);
  }
  if (gatePhases.has('crash-exit')) {
    const ended = results.crashExit as {
      turnStatuses: string[];
      agentSent: number;
      newAgentProcesses: number;
      methodsBefore: PhaseVerdict['methodsBefore'];
      agentMethods: PhaseVerdict['agentMethods'];
      transcript: PhaseVerdict['transcripts'][number];
      holderExited: boolean;
    };
    expect(ended.turnStatuses).toEqual(['failed']);
    expect(ended.newAgentProcesses).toBe(0);
    expect(ended.agentMethods).toEqual(ended.methodsBefore);
    expect(ended.transcript).toMatchObject({ missing: [], duplicated: [], inOrder: true, max: ended.agentSent });
    expect(ended.holderExited).toBe(true);
  }
  if (gatePhases.has('update')) {
  const update = results.update as PhaseVerdict & { oldHosts: number[]; oldHostExitCodes: (number | null)[] };
  expect(update.oldHostExitCodes).toEqual(update.oldHosts.map(() => 75));
  expect(update.newHosts).toHaveLength(1);
  expect(update.agentsAlive.every(Boolean)).toBe(true);
  expect(update.newAgentProcesses).toBe(0);
  expect(update.turnStatuses).toEqual(updateGroup.map(() => 'completed'));
  expect(update.agentMethods).toEqual(update.methodsBefore);
  for (const transcript of update.transcripts) {
    expect(transcript).toMatchObject({ missing: [], duplicated: [], inOrder: true, max: LONG_CHUNKS });
  }
  expectStopped(results.stopUpdate as Awaited<ReturnType<typeof stopGroup>>, updateGroup.length);
  }
  completed = true;
}, 7_200_000);
