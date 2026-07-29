import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { release as osRelease, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertPackedPackageIdentity,
  loadPackedAuthorCandidateManifest,
  materializePackedCli,
  readPackedPackageManifest,
  sha512Sri,
  startCandidateRegistry,
  type PackedAuthorCandidate,
} from '../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import {
  parsePluginsDevChangeLine,
  type PluginsDevChangeEnvelope,
} from '../../scripts/plugin-platform/plugins-dev-live-evidence.mjs';
import {
  resolvePluginsDevPlatform,
  type PluginsDevPlatformEvidence,
} from './pluginsDevPlatform';
import { createTestAuth } from '../testkit/auth';
import { seedCliAuthForServer } from '../testkit/cliAuth';
import { sanitizeDaemonEnvForSpawn } from '../testkit/daemon/daemon';
import { startServerLight, type StartedServer } from '../testkit/process/serverLight';
import { createRunDirs } from '../testkit/runDir';

export const PLUGINS_DEV_CHANGE_TIMEOUT_MS = 600_000;
export const ISOLATED_DAEMON_START_WAIT_TIMEOUT_MS = PLUGINS_DEV_CHANGE_TIMEOUT_MS;
export const PLUGIN_INSTALL_APPROVAL_TIMEOUT_MS = ISOLATED_DAEMON_START_WAIT_TIMEOUT_MS;
export const ISOLATED_DAEMON_RESTART_ARGS = Object.freeze([
  'daemon',
  'restart',
  '--takeover',
  '--json',
] as const);
const COMMAND_TIMEOUT_MS = 120_000;
const DEV_STOP_TIMEOUT_MS = 10_000;
const PLUGIN_ID = 'acme.plugins-dev-live';

type CommandResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

type PtyLaunch = Readonly<{
  command: string;
  args: readonly string[];
}>;

const PTY_HELPER_PATH = fileURLToPath(
  new URL('../../scripts/plugin-platform/run-command-in-pty.mjs', import.meta.url),
);

type PluginState = Readonly<{
  revisionTag: string;
  entry: string;
  transitive: string;
  nested: string;
}>;

type ActionResult = PluginState & Readonly<{
  pluginId: string;
  activationInstanceId: string;
  pid: number;
}>;

type MarkerEvent = Readonly<{
  kind: 'module' | 'activate' | 'registered' | 'invoke' | 'cleanup';
  activationInstanceId: string;
  pid: number;
  state: PluginState;
}>;

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function loadCandidate(argv: readonly string[]): Promise<PackedAuthorCandidate> {
  return await loadPackedAuthorCandidateManifest(argv);
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; input?: string }>,
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    const childStdin = child.stdin;
    if (!childStdout || !childStderr || (options.input !== undefined && !childStdin)) {
      child.kill('SIGKILL');
      rejectRun(new Error(`Command stdio was unavailable: ${command} ${args.join(' ')}`));
      return;
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new Error(`Command timed out after ${options.timeoutMs ?? COMMAND_TIMEOUT_MS}ms: ${command} ${args.join(' ')}`));
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    childStdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    childStderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveRun({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    if (options.input !== undefined) childStdin?.end(options.input);
  });
}

export async function runCommandUntilOutput(
  command: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    env: NodeJS.ProcessEnv;
    input: string;
    completionText: string;
    timeoutMs?: number;
  }>,
): Promise<CommandResult & Readonly<{ completedByOutput: true }>> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let completedByOutput = false;
    let forceStop: NodeJS.Timeout | null = null;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new Error(
        `Command timed out after ${options.timeoutMs ?? COMMAND_TIMEOUT_MS}ms: ${command} ${args.join(' ')}\n`
        + Buffer.concat(stdout).toString('utf8')
        + Buffer.concat(stderr).toString('utf8'),
      ));
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    const observeCompletion = (): void => {
      if (
        completedByOutput
        || !`${Buffer.concat(stdout).toString('utf8')}${Buffer.concat(stderr).toString('utf8')}`
          .includes(options.completionText)
      ) {
        return;
      }
      completedByOutput = true;
      child.kill('SIGTERM');
      forceStop = setTimeout(() => child.kill('SIGKILL'), 2_000);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(Buffer.from(chunk));
      observeCompletion();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(Buffer.from(chunk));
      observeCompletion();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      if (forceStop) clearTimeout(forceStop);
      rejectRun(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (forceStop) clearTimeout(forceStop);
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (!completedByOutput) {
        rejectRun(new Error(
          `Command exited before ${JSON.stringify(options.completionText)}`
          + ` (code=${String(code)}, signal=${String(signal)}):\n${result.stdout}${result.stderr}`,
        ));
        return;
      }
      resolveRun({ ...result, completedByOutput: true });
    });
    child.stdin.end(options.input);
  });
}

export function resolvePluginsDevPtyLaunch(
  platform: NodeJS.Platform,
  command: string,
  args: readonly string[],
): PtyLaunch | null {
  if (platform === 'linux' || platform === 'darwin' || platform === 'win32') {
    return {
      command: process.execPath,
      args: [PTY_HELPER_PATH, '--', command, ...args],
    };
  }
  return null;
}

function assertCommandSucceeded(result: CommandResult, label: string): void {
  if (result.code !== 0 || result.signal !== null) {
    fail(`${label} failed (code=${String(result.code)}, signal=${String(result.signal)}):\n${result.stdout}${result.stderr}`);
  }
}

function parseLastJsonLine(stdout: string, label: string): Record<string, unknown> {
  const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!line) fail(`${label} emitted no JSON result`);
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    fail(`${label} emitted invalid JSON: ${line}`);
  }
  if (!isRecord(value)) fail(`${label} emitted a non-object JSON result`);
  return value;
}

async function runPackedCliJson(params: Readonly<{
  cliEntrypoint: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  expectedKind: string;
}>): Promise<Record<string, unknown>> {
  const result = await runCommand(process.execPath, [params.cliEntrypoint, ...params.args], params);
  assertCommandSucceeded(result, params.expectedKind);
  const envelope = parseLastJsonLine(result.stdout, params.expectedKind);
  if (envelope.ok !== true || envelope.kind !== params.expectedKind) {
    fail(`${params.expectedKind} reported an unexpected result: ${JSON.stringify(envelope)}`);
  }
  return envelope;
}

async function approveInitialPluginInstallInTerminal(params: Readonly<{
  cliEntrypoint: string;
  pluginRoot: string;
  sdkRegistryOrigin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}>): Promise<Readonly<{
  approval: 'present-user-terminal';
  terminal: true;
  reviewFactsObserved: true;
}>> {
  const launch = resolvePluginsDevPtyLaunch(process.platform, process.execPath, [
    params.cliEntrypoint,
    'plugins',
    'install',
    params.pluginRoot,
    '--dev',
    '--sdk-registry',
    params.sdkRegistryOrigin,
  ]);
  if (!launch) {
    fail(`The ${process.platform} plugins-dev platform runner has no real-terminal approval adapter`);
  }
  const result = await runCommandUntilOutput(launch.command, launch.args, {
    cwd: params.cwd,
    env: params.env,
    input: 'y\n',
    completionText: 'Installed ',
    timeoutMs: PLUGIN_INSTALL_APPROVAL_TIMEOUT_MS,
  });
  const reviewFacts = await resolvePluginInstallReviewFacts(params.pluginRoot);
  const missingReviewFact = reviewFacts.find((fact) => !result.stdout.includes(fact));
  if (missingReviewFact) {
    fail(
      `plugins_install terminal approval did not present ${JSON.stringify(missingReviewFact)}:\n`
      + result.stdout
      + result.stderr,
    );
  }
  return {
    approval: 'present-user-terminal',
    terminal: true,
    reviewFactsObserved: true,
  };
}

export async function resolvePluginInstallReviewFacts(
  pluginRoot: string,
  resolveRealpath: (path: string) => Promise<string> = realpath,
): Promise<readonly string[]> {
  const canonicalPluginRoot = await resolveRealpath(pluginRoot);
  return [
    'Install & Trust Plugin 1.0.0?',
    `Source: ${canonicalPluginRoot}`,
    'Executable realms: daemon',
    'Required disclosures and cooperative services:',
    'Optional host-owned resources (off by default):',
    '[y/N]',
  ];
}

async function readPackedDaemonPid(params: Readonly<{
  cliEntrypoint: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}>): Promise<number> {
  const result = await runCommand(
    process.execPath,
    [params.cliEntrypoint, 'daemon', 'status', '--json'],
    params,
  );
  assertCommandSucceeded(result, 'daemon_status');
  const snapshot = parseLastJsonLine(result.stdout, 'daemon_status');
  const daemon = snapshot.daemon;
  if (!isRecord(daemon) || daemon.running !== true || typeof daemon.pid !== 'number') {
    fail(`Isolated daemon status did not identify a running daemon: ${JSON.stringify(snapshot)}`);
  }
  return daemon.pid;
}

export class DevChangeStream {
  readonly #queued: PluginsDevChangeEnvelope[] = [];
  readonly #waiters: Array<{
    resolve: (value: PluginsDevChangeEnvelope) => void;
    reject: (error: Error) => void;
  }> = [];
  #failure: Error | null = null;

  constructor(private readonly describeForeground: () => string) {}

  push(value: PluginsDevChangeEnvelope): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.#queued.push(value);
  }

  fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  async next(timeoutMs: number = PLUGINS_DEV_CHANGE_TIMEOUT_MS): Promise<PluginsDevChangeEnvelope> {
    const queued = this.#queued.shift();
    if (queued) return queued;
    if (this.#failure) throw this.#failure;
    return await new Promise<PluginsDevChangeEnvelope>((resolveNext, rejectNext) => {
      const waiter = {
        resolve: (value: PluginsDevChangeEnvelope): void => {
          clearTimeout(timeout);
          resolveNext(value);
        },
        reject: (error: Error): void => {
          clearTimeout(timeout);
          rejectNext(error);
        },
      };
      const timeout = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        rejectNext(new Error(
          `Timed out after ${timeoutMs}ms waiting for plugins_dev_change; ${this.describeForeground()}`,
        ));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }
}

function startPluginsDev(params: Readonly<{
  cliEntrypoint: string;
  pluginRoot: string;
  sdkRegistryOrigin: string;
  env: NodeJS.ProcessEnv;
}>): Readonly<{
  child: ChildProcess;
  changes: DevChangeStream;
  stdoutLines: string[];
  stderrLines: string[];
  terminal: boolean;
  markStopping(): void;
}> {
  const cliArgs = [
    params.cliEntrypoint,
    'plugins',
    'dev',
    params.pluginRoot,
    '--sdk-registry',
    params.sdkRegistryOrigin,
    '--json',
  ];
  const terminalLaunch = resolvePluginsDevPtyLaunch(process.platform, process.execPath, cliArgs);
  const child = spawn(terminalLaunch?.command ?? process.execPath, [
    ...(terminalLaunch?.args ?? cliArgs),
  ], {
    cwd: params.pluginRoot,
    detached: process.platform !== 'win32',
    env: params.env,
    stdio: [terminalLaunch && process.platform === 'win32' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const changes = new DevChangeStream(() => JSON.stringify({
    pid: child.pid ?? null,
    stdoutLines,
    stderrLines,
  }));
  let stopping = false;
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (!childStdout || !childStderr) {
    child.kill('SIGKILL');
    fail('plugins dev foreground stdio was unavailable');
  }
  const stdout = createInterface({ input: childStdout });
  const stderr = createInterface({ input: childStderr });
  stdout.on('line', (line) => {
    stdoutLines.push(line);
    if (stdoutLines.length > 100) stdoutLines.shift();
    try {
      const change = parsePluginsDevChangeLine(line);
      if (change) changes.push(change);
    } catch (error) {
      changes.fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  stderr.on('line', (line) => {
    stderrLines.push(line);
    if (stderrLines.length > 100) stderrLines.shift();
  });
  child.once('error', (error) => changes.fail(error));
  child.once('close', (code, signal) => {
    stdout.close();
    stderr.close();
    if (!stopping) {
      changes.fail(new Error(
        `plugins dev exited before teardown (code=${String(code)}, signal=${String(signal)}):\n${stdoutLines.join('\n')}\n${stderrLines.join('\n')}`,
      ));
    }
  });
  return {
    child,
    changes,
    stdoutLines,
    stderrLines,
    terminal: terminalLaunch !== null,
    markStopping(): void {
      stopping = true;
    },
  };
}

async function stopForegroundProcess(
  processHandle: ReturnType<typeof startPluginsDev>,
): Promise<'sigint' | 'sigterm' | 'sigkill' | 'already-exited'> {
  processHandle.markStopping();
  if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) return 'already-exited';
  const closed = new Promise<boolean>((resolveClosed) => {
    processHandle.child.once('close', () => resolveClosed(true));
  });
  const signal = (nextSignal: NodeJS.Signals): void => {
    if (
      process.platform === 'win32'
      && processHandle.terminal
      && nextSignal === 'SIGINT'
      && processHandle.child.stdin?.writable
    ) {
      processHandle.child.stdin.write('\u0003');
      return;
    }
    if (processHandle.child.pid && process.platform !== 'win32') {
      try {
        process.kill(-processHandle.child.pid, nextSignal);
        return;
      } catch {
        // Fall through to the direct child when the process group is already gone.
      }
    }
    processHandle.child.kill(nextSignal);
  };
  const gracefulSignal: NodeJS.Signals = processHandle.terminal ? 'SIGINT' : 'SIGTERM';
  signal(gracefulSignal);
  const stoppedGracefully = await Promise.race([
    closed,
    new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), DEV_STOP_TIMEOUT_MS)),
  ]);
  if (stoppedGracefully) return gracefulSignal === 'SIGINT' ? 'sigint' : 'sigterm';
  signal('SIGKILL');
  await closed;
  return 'sigkill';
}

function renderEntrySource(state: PluginState): string {
  return [
    "import { randomUUID } from 'node:crypto';",
    "import { appendFileSync } from 'node:fs';",
    "import type { PluginApi } from '@happier-dev/plugin-sdk';",
    "import type { ActionHandler } from '@happier-dev/plugin-sdk/runtime';",
    "import { readMessageState } from './lib/message';",
    '',
    `const revisionTag = ${JSON.stringify(state.revisionTag)};`,
    'const activationInstanceId = randomUUID();',
    'const markerPath = process.env.HAPPIER_PLUGINS_DEV_MARKER;',
    'const currentState = () => ({ revisionTag, entry: ' + JSON.stringify(state.entry) + ', ...readMessageState() });',
    'const appendMarker = (kind: string): void => {',
    '  if (!markerPath) return;',
    '  appendFileSync(markerPath, `${JSON.stringify({ kind, activationInstanceId, pid: process.pid, state: currentState() })}\\n`, "utf8");',
    '};',
    "appendMarker('module');",
    '',
    'const probe: ActionHandler = async () => {',
    "  appendMarker('invoke');",
    `  return { pluginId: ${JSON.stringify(PLUGIN_ID)}, ...currentState(), activationInstanceId, pid: process.pid };`,
    '};',
    '',
    'export function activate(api: PluginApi): () => void {',
    "  appendMarker('activate');",
    "  api.actions.register('probe', probe);",
    "  appendMarker('registered');",
    '  return () => {',
    "    appendMarker('cleanup');",
    '  };',
    '}',
    '',
  ].join('\n');
}

function renderMessageSource(transitive: string): string {
  return [
    "import { nestedValue } from './nested/base';",
    `export const readMessageState = () => ({ transitive: ${JSON.stringify(transitive)}, nested: nestedValue });`,
    '',
  ].join('\n');
}

async function configurePlugin(pluginRoot: string, sdkVersion: string, state: PluginState): Promise<void> {
  const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
  const packagePath = join(pluginRoot, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>;
  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify({
      ...manifest,
      id: PLUGIN_ID,
      version: '1.0.0',
      entrypoints: { daemon: './dist/index.js', development: './src/index.ts' },
      hostAccess: { required: [], optional: [] },
      contributes: {
        actions: [{
          id: 'probe',
          title: 'Plugin development live probe',
          scopes: ['global'],
          surfaces: ['cli'],
          placement: 'commandPalette',
          dangerLevel: 'safe',
        }],
        commands: [{
          id: 'probe-command',
          title: 'Plugin development live probe',
          path: ['plugins-dev-live', 'probe'],
          action: 'probe',
        }],
      },
    }, null, 2)}\n`, 'utf8'),
    writeFile(packagePath, `${JSON.stringify({
      ...packageJson,
      version: '1.0.0',
      dependencies: {
        ...(isRecord(packageJson.dependencies) ? packageJson.dependencies : {}),
        '@happier-dev/plugin-sdk': sdkVersion,
      },
    }, null, 2)}\n`, 'utf8'),
    mkdir(join(pluginRoot, 'src', 'lib', 'nested'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(pluginRoot, 'src', 'index.ts'), renderEntrySource(state), 'utf8'),
    writeFile(join(pluginRoot, 'src', 'lib', 'message.ts'), renderMessageSource(state.transitive), 'utf8'),
    writeFile(join(pluginRoot, 'src', 'lib', 'nested', 'base.ts'), `export const nestedValue = ${JSON.stringify(state.nested)};\n`, 'utf8'),
  ]);
}

async function readMarkerEvents(markerPath: string): Promise<MarkerEvent[]> {
  const raw = await readFile(markerPath, 'utf8').catch((error: unknown) => {
    if (isRecord(error) && error.code === 'ENOENT') return '';
    throw error;
  });
  return raw.trim().split(/\r?\n/u).filter(Boolean).map((line) => {
    const value: unknown = JSON.parse(line);
    if (
      !isRecord(value)
      || !['module', 'activate', 'registered', 'invoke', 'cleanup'].includes(String(value.kind))
      || typeof value.activationInstanceId !== 'string'
      || typeof value.pid !== 'number'
      || !isRecord(value.state)
    ) {
      fail(`Invalid plugin development marker event: ${line}`);
    }
    return value as MarkerEvent;
  });
}

export async function assertPluginExecutableEventsOwnedByDaemons(
  markerPath: string,
  allowedDaemonPids: ReadonlySet<number>,
  phase: string,
): Promise<void> {
  const unexpectedEvent = (await readMarkerEvents(markerPath))
    .find((event) => !allowedDaemonPids.has(event.pid));
  if (!unexpectedEvent) return;

  fail(
    `${phase} observed plugin executable event outside the allowed daemon processes: `
      + `kind=${unexpectedEvent.kind}, pid=${unexpectedEvent.pid}, `
      + `activation=${unexpectedEvent.activationInstanceId}; `
      + `allowed daemon pids=${[...allowedDaemonPids].sort((left, right) => left - right).join(',')}`,
  );
}

function readActionResult(envelope: Record<string, unknown>, label: string): ActionResult {
  const data = envelope.data;
  const result = isRecord(data) && isRecord(data.result) ? data.result : null;
  if (
    !result
    || result.pluginId !== PLUGIN_ID
    || typeof result.revisionTag !== 'string'
    || typeof result.entry !== 'string'
    || typeof result.transitive !== 'string'
    || typeof result.nested !== 'string'
    || typeof result.activationInstanceId !== 'string'
    || typeof result.pid !== 'number'
  ) {
    fail(`${label} returned an invalid action result: ${JSON.stringify(result)}`);
  }
  return result as ActionResult;
}

function assertState(actual: ActionResult, expected: PluginState, label: string): void {
  for (const key of ['revisionTag', 'entry', 'transitive', 'nested'] as const) {
    if (actual[key] !== expected[key]) {
      fail(`${label} returned ${key}=${actual[key]}, expected ${expected[key]}: ${JSON.stringify(actual)}`);
    }
  }
}

async function invokeProbe(params: Readonly<{
  cliEntrypoint: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  expected?: PluginState;
  label: string;
}>): Promise<ActionResult> {
  const envelope = await runPackedCliJson({
    ...params,
    args: ['plugins-dev-live', 'probe', '--json'],
    expectedKind: 'plugin_command',
  });
  const result = readActionResult(envelope, params.label);
  if (params.expected) assertState(result, params.expected, params.label);
  return result;
}

async function assertSingleActivation(
  markerPath: string,
  action: ActionResult,
  previousActivationId: string | null,
  label: string,
): Promise<Readonly<{ activationEvents: readonly string[] }>> {
  if (previousActivationId === action.activationInstanceId) {
    fail(`${label} reused the previous development activation graph`);
  }
  const events = (await readMarkerEvents(markerPath))
    .filter((event) => event.activationInstanceId === action.activationInstanceId);
  const activationEvents = events
    .filter((event) => event.kind !== 'invoke' && event.kind !== 'cleanup')
    .map((event) => event.kind);
  if (
    JSON.stringify(activationEvents) !== JSON.stringify(['module', 'activate', 'registered'])
    || events.some((event) => event.pid !== action.pid)
  ) {
    fail(`${label} did not execute one fresh daemon-owned graph: ${JSON.stringify(events)}`);
  }
  return { activationEvents };
}

async function assertRetiredActivationsFenced(params: Readonly<{
  markerPath: string;
  retiredActivationIds: ReadonlySet<string>;
  activeActivationId?: string;
}>): Promise<Readonly<{
  retiredActivationIds: readonly string[];
  cleanupCounts: Readonly<Record<string, number>>;
}>> {
  const events = await readMarkerEvents(params.markerPath);
  const activeRegisteredIndex = params.activeActivationId
    ? events.findIndex(
        (event) => (
          event.activationInstanceId === params.activeActivationId
          && event.kind === 'registered'
        ),
      )
    : -1;
  if (params.activeActivationId && activeRegisteredIndex < 0) {
    fail(`Active development activation ${params.activeActivationId} was not registered`);
  }
  const cleanupCounts: Record<string, number> = {};
  for (const activationInstanceId of params.retiredActivationIds) {
    const activationEvents = events.filter((event) => event.activationInstanceId === activationInstanceId);
    const cleanupIndex = activationEvents.findIndex((event) => event.kind === 'cleanup');
    const cleanupCount = activationEvents.filter((event) => event.kind === 'cleanup').length;
    cleanupCounts[activationInstanceId] = cleanupCount;
    if (cleanupCount !== 1) {
      fail(`Retired development activation ${activationInstanceId} cleaned up ${cleanupCount} times`);
    }
    if (activationEvents.slice(cleanupIndex + 1).some((event) => event.kind === 'invoke')) {
      fail(`Retired development activation ${activationInstanceId} accepted an invocation after cleanup`);
    }
    if (
      activeRegisteredIndex >= 0
      && events.slice(activeRegisteredIndex + 1).some(
        (event) => (
          event.activationInstanceId === activationInstanceId
          && event.kind === 'invoke'
        ),
      )
    ) {
      fail(
        `Retired development activation ${activationInstanceId} accepted an invocation after successor registration`,
      );
    }
  }
  if (params.activeActivationId) {
    const activeCleanupCount = events.filter(
      (event) => event.activationInstanceId === params.activeActivationId && event.kind === 'cleanup',
    ).length;
    if (activeCleanupCount !== 0) {
      fail(`Active development activation ${params.activeActivationId} cleaned up before daemon shutdown`);
    }
  }
  return {
    retiredActivationIds: [...params.retiredActivationIds].sort(),
    cleanupCounts,
  };
}

async function waitForAcceptedState(params: Readonly<{
  stream: DevChangeStream;
  cliEntrypoint: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  markerPath: string;
  expected: PluginState;
  previousActivationId: string | null;
  label: string;
}>): Promise<Readonly<{
  envelope: PluginsDevChangeEnvelope;
  action: ActionResult;
  activationEvents: readonly string[];
  acceptedEventsObserved: number;
}>> {
  const deadline = Date.now() + PLUGINS_DEV_CHANGE_TIMEOUT_MS;
  let acceptedEventsObserved = 0;
  let previousActivationId = params.previousActivationId;
  while (Date.now() < deadline) {
    const envelope = await params.stream.next(Math.max(1, deadline - Date.now()));
    if (!envelope.ok) {
      fail(`${params.label} was rejected: ${JSON.stringify(envelope.error)}`);
    }
    acceptedEventsObserved += 1;
    const action = await invokeProbe({
      cliEntrypoint: params.cliEntrypoint,
      cwd: params.cwd,
      env: params.env,
      label: `${params.label} accepted event ${acceptedEventsObserved}`,
    });
    const matchesExpected = (
      action.revisionTag === params.expected.revisionTag
      && action.entry === params.expected.entry
      && action.transitive === params.expected.transitive
      && action.nested === params.expected.nested
    );
    if (action.activationInstanceId === previousActivationId) {
      if (matchesExpected) {
        fail(`${params.label} reported acceptance without applying a fresh generation graph`);
      }
      continue;
    }
    const activation = await assertSingleActivation(
      params.markerPath,
      action,
      previousActivationId,
      params.label,
    );
    previousActivationId = action.activationInstanceId;
    if (matchesExpected) {
      return { envelope, action, ...activation, acceptedEventsObserved };
    }
  }
  fail(`Timed out waiting for ${params.label} to become callable`);
}

async function waitForRejectedChange(params: Readonly<{
  stream: DevChangeStream;
  cliEntrypoint: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  preserved: PluginState;
  preservedAction: ActionResult;
}>): Promise<Readonly<{
  envelope: PluginsDevChangeEnvelope;
  preservedAction: ActionResult;
  acceptedEventsBeforeRejection: number;
}>> {
  const deadline = Date.now() + PLUGINS_DEV_CHANGE_TIMEOUT_MS;
  let acceptedEventsBeforeRejection = 0;
  let lastHealthyAction = params.preservedAction;
  while (Date.now() < deadline) {
    const envelope = await params.stream.next(Math.max(1, deadline - Date.now()));
    if (!envelope.ok) {
      const preservedAction = await invokeProbe({
        ...params,
        expected: params.preserved,
        label: 'broken edit preservation',
      });
      if (preservedAction.activationInstanceId !== lastHealthyAction.activationInstanceId) {
        fail('Rejected edit replaced the last applied healthy activation');
      }
      return { envelope, preservedAction, acceptedEventsBeforeRejection };
    }
    acceptedEventsBeforeRejection += 1;
    lastHealthyAction = await invokeProbe({
      ...params,
      expected: params.preserved,
      label: `pre-rejection accepted event ${acceptedEventsBeforeRejection}`,
    });
  }
  fail('Timed out waiting for the broken development edit to be rejected');
}

export async function runPackedPluginsDev(candidate: PackedAuthorCandidate): Promise<Record<string, unknown>> {
  const platform = resolvePluginsDevPlatform(process.platform);
  const run = createRunDirs({ runLabel: `${platform.runLabel}-${candidate.runId}` });
  const testDir = run.testDir('plugins-dev-live');
  const tempRoot = await mkdtemp(join(tmpdir(), `happier-plugins-dev-${candidate.runId}-`));
  let server: StartedServer | null = null;
  let registry: Awaited<ReturnType<typeof startCandidateRegistry>> | null = null;
  let dev: ReturnType<typeof startPluginsDev> | null = null;
  let cliEntrypoint: string | null = null;
  let childEnv: NodeJS.ProcessEnv | null = null;
  let daemonStopped = false;
  let completed = false;
  let foregroundStop: string = 'not-started';
  const stages: Array<Record<string, unknown>> = [];
  const preserveFailureArtifacts = process.env.HAPPIER_PLUGINS_DEV_PRESERVE_FAILURE === '1';

  try {
    const [sdkBytes, cliBytes] = await Promise.all([
      readFile(candidate.sdk.tarballPath),
      readFile(candidate.cli.tarballPath),
    ]);
    if (sha512Sri(sdkBytes) !== candidate.sdk.integrity) fail('Packed SDK integrity mismatch');
    if (sha512Sri(cliBytes) !== candidate.cli.integrity) fail('Packed CLI integrity mismatch');
    stages.push({ id: 'candidate-integrity', ok: true });

    const sdkManifest = await readPackedPackageManifest(
      candidate.sdk.tarballPath,
      join(tempRoot, 'sdk-artifact'),
    );
    assertPackedPackageIdentity(sdkManifest, candidate.sdk, 'Packed SDK');
    registry = await startCandidateRegistry({ sdk: candidate.sdk, sdkBytes, packageManifest: sdkManifest });
    cliEntrypoint = await materializePackedCli({
      cliArtifact: candidate.cli,
      installRoot: join(tempRoot, 'cli-install'),
    });
    stages.push({
      id: 'packed-cli-materialized',
      ok: true,
      sdk: `${candidate.sdk.packageName}@${candidate.sdk.version}`,
      cli: `${candidate.cli.packageName}@${candidate.cli.version}`,
    });

    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);
    const happyHomeDir = join(tempRoot, 'happier-home');
    await mkdir(happyHomeDir, { recursive: true });
    await seedCliAuthForServer({
      cliHome: happyHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      secret: Uint8Array.from(randomBytes(32)),
    });
    const markerPath = join(tempRoot, 'plugin-execution.jsonl');
    childEnv = sanitizeDaemonEnvForSpawn({
      ...process.env,
      CI: '1',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_HOME_DIR: happyHomeDir,
      HAPPIER_PLUGINS_DEV_MARKER: markerPath,
      HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: String(ISOLATED_DAEMON_START_WAIT_TIMEOUT_MS),
      PATH: '',
    });
    stages.push({
      id: 'isolated-runtime',
      ok: true,
      home: 'ephemeral',
      authenticatedTestServer: true,
      inheritedStackAndDaemonAuthority: 'sanitized',
    });

    const externalRoot = join(tempRoot, 'external-author');
    const pluginRoot = join(externalRoot, 'plugin');
    await mkdir(externalRoot, { recursive: true });
    await runPackedCliJson({
      cliEntrypoint,
      cwd: externalRoot,
      env: childEnv,
      args: ['plugins', 'create', pluginRoot, '--id', PLUGIN_ID, '--sdk-version', candidate.sdk.version, '--json'],
      expectedKind: 'plugins_create',
    });
    const initialState: PluginState = {
      revisionTag: 'entry-1',
      entry: 'entry-1',
      transitive: 'transitive-1',
      nested: 'nested-1',
    };
    await configurePlugin(pluginRoot, candidate.sdk.version, initialState);
    stages.push({ id: 'external-plugin-created', ok: true, pluginId: PLUGIN_ID });

    await runPackedCliJson({
      cliEntrypoint,
      cwd: externalRoot,
      env: childEnv,
      args: [
        'plugins',
        'author',
        'install',
        pluginRoot,
        '--sdk-registry',
        registry.origin,
        '--json',
      ],
      expectedKind: 'plugins_author_install',
    });
    stages.push({ id: 'managed-author-dependencies', ok: true, systemPathEmpty: true });

    const installApproval = await approveInitialPluginInstallInTerminal({
      cliEntrypoint,
      pluginRoot,
      sdkRegistryOrigin: registry.origin,
      cwd: externalRoot,
      env: childEnv,
    });
    const installAction = await invokeProbe({
      cliEntrypoint,
      cwd: externalRoot,
      env: childEnv,
      expected: initialState,
      label: 'initial development install',
    });
    const daemonPid = await readPackedDaemonPid({ cliEntrypoint, cwd: externalRoot, env: childEnv });
    if (installAction.pid !== daemonPid) {
      fail(`Plugin executable ran outside the isolated daemon: action pid=${installAction.pid}, daemon pid=${daemonPid}`);
    }
    const installActivation = await assertSingleActivation(markerPath, installAction, null, 'initial development install');
    await assertPluginExecutableEventsOwnedByDaemons(
      markerPath,
      new Set([daemonPid]),
      'initial development install',
    );
    stages.push({
      id: 'initial-daemon-install',
      ok: true,
      install: installApproval,
      daemonPid,
      action: installAction,
      ...installActivation,
      allPluginExecutableEventsDaemonOwned: true,
    });

    dev = startPluginsDev({
      cliEntrypoint,
      pluginRoot,
      sdkRegistryOrigin: registry.origin,
      env: childEnv,
    });
    const initialDev = await waitForAcceptedState({
      stream: dev.changes,
      cliEntrypoint,
      cwd: externalRoot,
      env: childEnv,
      markerPath,
      expected: initialState,
      // The initial foreground observation may legitimately deduplicate the exact
      // source generation that the explicit development install already applied.
      previousActivationId: null,
      label: 'foreground dev initial observation',
    });
    stages.push({
      id: 'foreground-dev-started',
      ok: true,
      terminal: dev.terminal,
      event: initialDev.envelope,
      action: initialDev.action,
      activationEvents: initialDev.activationEvents,
      reusedExplicitInstallActivation:
        initialDev.action.activationInstanceId === installAction.activationInstanceId,
      mutationPolicy: 'initial-observation-may-reuse; actual-edits-require-fresh-activation',
    });

    const entryState: PluginState = { ...initialState, revisionTag: 'entry-2', entry: 'entry-2' };
    await writeFile(join(pluginRoot, 'src', 'index.ts'), renderEntrySource(entryState), 'utf8');
    const entryEdit = await waitForAcceptedState({
      stream: dev.changes,
      cliEntrypoint,
      cwd: externalRoot,
      env: childEnv,
      markerPath,
      expected: entryState,
      previousActivationId: initialDev.action.activationInstanceId,
      label: 'entry edit',
    });
    stages.push({
      id: 'entry-edit',
      ok: true,
      event: entryEdit.envelope,
      action: entryEdit.action,
      activationEvents: entryEdit.activationEvents,
    });

    const transitiveState: PluginState = { ...entryState, transitive: 'transitive-2' };
    await writeFile(
      join(pluginRoot, 'src', 'lib', 'message.ts'),
      renderMessageSource(transitiveState.transitive),
      'utf8',
    );
    const transitiveEdit = await waitForAcceptedState({
      stream: dev.changes,
      cliEntrypoint,
      cwd: externalRoot,
      env: childEnv,
      markerPath,
      expected: transitiveState,
      previousActivationId: entryEdit.action.activationInstanceId,
      label: 'transitive dependency edit',
    });
    stages.push({
      id: 'transitive-dependency-edit',
      ok: true,
      event: transitiveEdit.envelope,
      action: transitiveEdit.action,
      activationEvents: transitiveEdit.activationEvents,
    });

    const nestedState: PluginState = { ...transitiveState, nested: 'new-nested-2' };
    const newNestedDir = join(pluginRoot, 'src', 'lib', 'nested', 'created');
    await mkdir(newNestedDir, { recursive: true });
    await writeFile(join(newNestedDir, 'value.ts'), `export const createdNestedValue = ${JSON.stringify(nestedState.nested)};\n`, 'utf8');
    await writeFile(
      join(pluginRoot, 'src', 'lib', 'nested', 'base.ts'),
      "export { createdNestedValue as nestedValue } from './created/value';\n",
      'utf8',
    );
    const nestedEdit = await waitForAcceptedState({
      stream: dev.changes,
      cliEntrypoint,
      cwd: externalRoot,
      env: childEnv,
      markerPath,
      expected: nestedState,
      previousActivationId: transitiveEdit.action.activationInstanceId,
      label: 'new nested dependency edit',
    });
    if (nestedEdit.action.pid !== daemonPid || nestedEdit.action.pid === dev.child.pid) {
      fail('Development plugin executable did not remain exclusively daemon-owned');
    }
    stages.push({
      id: 'new-nested-dependency-edit',
      ok: true,
      event: nestedEdit.envelope,
      action: nestedEdit.action,
      activationEvents: nestedEdit.activationEvents,
      acceptedEventsObserved: nestedEdit.acceptedEventsObserved,
    });

    await writeFile(
      join(pluginRoot, 'src', 'lib', 'nested', 'base.ts'),
      "export { missingNestedValue as nestedValue } from './created/missing';\n",
      'utf8',
    );
    const rejected = await waitForRejectedChange({
      stream: dev.changes,
      cliEntrypoint,
      cwd: externalRoot,
      env: childEnv,
      preserved: nestedState,
      preservedAction: nestedEdit.action,
    });
    await assertPluginExecutableEventsOwnedByDaemons(
      markerPath,
      new Set([daemonPid]),
      'foreground development edits',
    );
    stages.push({
      id: 'broken-edit-preserves-last-applied',
      ok: true,
      event: rejected.envelope,
      preservedAction: rejected.preservedAction,
      acceptedEventsBeforeRejection: rejected.acceptedEventsBeforeRejection,
      allPluginExecutableEventsDaemonOwned: true,
    });

    foregroundStop = await stopForegroundProcess(dev);
    if (dev.terminal && foregroundStop !== 'sigint') {
      fail(`Real-terminal plugins dev did not stop cleanly on Ctrl-C: ${foregroundStop}`);
    }
    dev = null;

    const restart = await runCommand(
      process.execPath,
      [cliEntrypoint, ...ISOLATED_DAEMON_RESTART_ARGS],
      { cwd: externalRoot, env: childEnv, timeoutMs: COMMAND_TIMEOUT_MS },
    );
    assertCommandSucceeded(restart, 'Isolated packed daemon restart');
    const restartedDaemonPid = await readPackedDaemonPid({
      cliEntrypoint,
      cwd: externalRoot,
      env: childEnv,
    });
    if (restartedDaemonPid === daemonPid) {
      fail(`Packed daemon restart reused pid ${daemonPid}`);
    }
    const restartedAction = await invokeProbe({
      cliEntrypoint,
      cwd: externalRoot,
      env: childEnv,
      expected: nestedState,
      label: 'daemon restart recovery',
    });
    if (restartedAction.pid !== restartedDaemonPid) {
      fail(`Restarted development plugin ran outside the replacement daemon: action pid=${restartedAction.pid}, daemon pid=${restartedDaemonPid}`);
    }
    const restartActivation = await assertSingleActivation(
      markerPath,
      restartedAction,
      rejected.preservedAction.activationInstanceId,
      'daemon restart recovery',
    );
    const retiredBeforeRestart = new Set(
      (await readMarkerEvents(markerPath))
        .filter((event) => event.kind === 'activate')
        .map((event) => event.activationInstanceId),
    );
    retiredBeforeRestart.delete(restartedAction.activationInstanceId);
    const restartFencing = await assertRetiredActivationsFenced({
      markerPath,
      retiredActivationIds: retiredBeforeRestart,
      activeActivationId: restartedAction.activationInstanceId,
    });
    const allowedDaemonPids = new Set([daemonPid, restartedDaemonPid]);
    await assertPluginExecutableEventsOwnedByDaemons(
      markerPath,
      allowedDaemonPids,
      'daemon restart recovery',
    );
    stages.push({
      id: 'daemon-restart-recovers-committed-generation',
      ok: true,
      previousDaemonPid: daemonPid,
      restartedDaemonPid,
      action: restartedAction,
      activationEvents: restartActivation.activationEvents,
      staleGenerationFencing: restartFencing,
      allPluginExecutableEventsDaemonOwned: true,
    });

    const daemonStop = await runCommand(
      process.execPath,
      [cliEntrypoint, 'daemon', 'stop'],
      { cwd: externalRoot, env: childEnv, timeoutMs: 30_000 },
    );
    assertCommandSucceeded(daemonStop, 'Isolated packed daemon cleanup');
    daemonStopped = true;
    const finalFencing = await assertRetiredActivationsFenced({
      markerPath,
      retiredActivationIds: new Set([
        ...retiredBeforeRestart,
        restartedAction.activationInstanceId,
      ]),
    });
    await assertPluginExecutableEventsOwnedByDaemons(
      markerPath,
      allowedDaemonPids,
      'daemon shutdown',
    );
    stages.push({
      id: 'teardown',
      ok: true,
      foreground: foregroundStop,
      daemon: 'stopped',
      staleGenerationFencing: finalFencing,
      allPluginExecutableEventsDaemonOwned: true,
      tempRoot: 'removed-after-result',
    });

    completed = true;
    return {
      ok: true,
      scenario: platform.scenario,
      platform: { os: process.platform, arch: process.arch, release: osRelease(), node: process.version },
      candidate: {
        runId: candidate.runId,
        sdk: { version: candidate.sdk.version, integrity: candidate.sdk.integrity },
        cli: { version: candidate.cli.version, integrity: candidate.cli.integrity },
      },
      evidence: {
        platform: platform.evidencePlatform,
        qa: ['QA-003', 'QA-004-broken-import', platform.qaLabel],
        daemonExecutionPid: restartedAction.pid,
        finalHealthyActivation: restartedAction.activationInstanceId,
        restartRecovered: true,
        staleGenerationHandlersFenced: true,
        activationCleanupExactlyOnce: true,
        allPluginExecutableEventsDaemonOwned: true,
        firstTrustViaPresentUserTerminal: true,
        foregroundStoppedByCtrlC: foregroundStop === 'sigint',
      },
      stages,
      cleanup: { disposition: 'removed' },
    };
  } finally {
    if (dev) foregroundStop = await stopForegroundProcess(dev).catch(() => 'failed');
    if (cliEntrypoint && childEnv && !daemonStopped) {
      await runCommand(process.execPath, [cliEntrypoint, 'daemon', 'stop'], {
        cwd: tempRoot,
        env: childEnv,
        timeoutMs: 30_000,
      }).catch(() => undefined);
    }
    await registry?.close().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    if (completed || !preserveFailureArtifacts) {
      await rm(tempRoot, { recursive: true, force: true });
    } else {
      process.stderr.write(`plugins-dev diagnostic artifacts preserved at ${tempRoot}\n`);
    }
  }
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const startedAt = new Date().toISOString();
  let candidate: PackedAuthorCandidate | null = null;
  let platform: PluginsDevPlatformEvidence | null = null;
  try {
    platform = resolvePluginsDevPlatform(process.platform);
    candidate = await loadCandidate(argv);
    const result = await runPackedPluginsDev(candidate);
    process.stdout.write(`${JSON.stringify({
      ...result,
      startedAt,
      completedAt: new Date().toISOString(),
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      scenario: platform?.scenario ?? `plugins-dev-${process.platform}-unsupported`,
      candidate: candidate ? {
        runId: candidate.runId,
        sdk: { version: candidate.sdk.version, integrity: candidate.sdk.integrity },
        cli: { version: candidate.cli.version, integrity: candidate.cli.integrity },
      } : null,
      error: {
        code: platform
          ? `plugins_dev_${platform.evidencePlatform}_live_failed`
          : 'plugins_dev_unsupported_platform',
        message: error instanceof Error ? error.message : String(error),
      },
      cleanup: { disposition: 'attempted' },
      startedAt,
      completedAt: new Date().toISOString(),
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
