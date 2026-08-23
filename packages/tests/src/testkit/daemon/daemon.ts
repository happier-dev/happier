import { readFile, readdir, stat } from 'node:fs/promises';
import { unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { repoRootDir } from '../paths';
import {
  inspectOwnedProcess,
  registerProcessOwnershipLease,
  resolveProcessOwnershipLeasesDir,
  sweepProcessOwnershipLeases,
} from '../process/processOwnershipLease';
import { spawnLoggedProcess, type SpawnedProcess } from '../process/spawnProcess';
import { resolveCliTestLaunchSpec, shouldUseCliSourceEntrypoint } from '../process/cliLaunchSpec';
import { DEFAULT_CLI_DIST_BUILD_TIMEOUT_MS } from '../process/cliDist';
import { terminateProcessTreeByPid } from '../process/processTree';
import { resolveDaemonSessionMarkerDirs } from './sessionMarkerDirs';

export type DaemonState = {
  pid: number;
  httpPort: number;
  controlToken?: string;
  startTime?: string;
  startedWithCliVersion?: string;
  lastHeartbeat?: string;
  daemonLogPath?: string;
};

export function daemonStatePath(happyHomeDir: string): string {
  return join(happyHomeDir, 'daemon.state.json');
}

function resolveDaemonCliSnapshotDir(params: { testDir: string; env: NodeJS.ProcessEnv }): string {
  const raw = (process.env.HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE ?? '').toString().trim().toLowerCase();
  if (raw === 'testdir' || raw === 'per-test' || raw === 'per_test' || raw === 'pertest') {
    return resolve(params.testDir, 'cli-dist');
  }

  if (shouldUseCliSourceEntrypoint(params.env)) {
    return resolve(repoRootDir(), '.project', 'tmp', 'cli-source-snapshot');
  }

  // Default to a shared snapshot to avoid paying the node_modules snapshot cost per test (which can
  // otherwise consume most of the core slow E2E timeout budget).
  return resolve(repoRootDir(), '.project', 'tmp', 'cli-dist-snapshot');
}

function resolveDaemonSnapshotNodeModulesMode(env: NodeJS.ProcessEnv): 'symlink' | 'copy' {
  const raw = (env.HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE ?? '').toString().trim().toLowerCase();
  if (raw === 'copy' || raw === 'symlink') {
    return raw;
  }

  // Source-entrypoint daemon runs resolve from the snapshot root with tsx. Keep snapshot node_modules
  // immutable by default so concurrent package-tree churn in the repo root cannot invalidate in-flight
  // daemon startup imports.
  if (shouldUseCliSourceEntrypoint(env)) {
    return 'copy';
  }

  return 'symlink';
}

async function resolveActiveServerIdFromSettings(happyHomeDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(happyHomeDir, 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as { schemaVersion?: number; activeServerId?: unknown } | null;
    if (!parsed || typeof parsed.schemaVersion !== 'number') return null;
    if (parsed.schemaVersion < 5) return null;
    if (typeof parsed.activeServerId !== 'string' || !parsed.activeServerId) return null;
    return parsed.activeServerId;
  } catch {
    return null;
  }
}

function perServerDaemonStatePath(happyHomeDir: string, serverId: string): string {
  return join(happyHomeDir, 'servers', serverId, 'daemon.state.json');
}

async function readDaemonStateFromPath(path: string): Promise<DaemonState | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DaemonState>;
    if (!parsed || typeof parsed.pid !== 'number' || typeof parsed.httpPort !== 'number') return null;
    return parsed as DaemonState;
  } catch {
    return null;
  }
}

async function listServerDaemonStateCandidates(happyHomeDir: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  const serversDir = join(happyHomeDir, 'servers');
  try {
    const entries = await readdir(serversDir, { withFileTypes: true });
    const candidates: Array<{ path: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidatePath = join(serversDir, entry.name, 'daemon.state.json');
      try {
        const s = await stat(candidatePath);
        candidates.push({ path: candidatePath, mtimeMs: s.mtimeMs });
      } catch {
        // ignore missing / unreadable
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

export async function readDaemonState(happyHomeDir: string): Promise<DaemonState | null> {
  const activeServerId = await resolveActiveServerIdFromSettings(happyHomeDir);
  const candidates: string[] = [];
  if (activeServerId) candidates.push(perServerDaemonStatePath(happyHomeDir, activeServerId));
  candidates.push(daemonStatePath(happyHomeDir));

  for (const candidate of candidates) {
    const state = await readDaemonStateFromPath(candidate);
    if (state) return state;
  }

  // Fallback: if settings.json is stale/mismatched, find the newest per-server daemon state.
  const perServerStates = await listServerDaemonStateCandidates(happyHomeDir);
  if (perServerStates.length === 0) return null;
  perServerStates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of perServerStates) {
    const state = await readDaemonStateFromPath(candidate.path);
    if (state) return state;
  }
  return null;
}

export async function waitForDaemonState(happyHomeDir: string, opts?: { timeoutMs?: number }): Promise<DaemonState> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await readDaemonState(happyHomeDir);
    if (state && state.httpPort > 0 && state.pid > 0) return state;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for daemon.state.json in ${happyHomeDir}`);
}

type ProcessInspectionResult =
  | { ok: true; command: string; looksLikeDaemon: boolean }
  | { ok: false; reason: 'ps_missing' | 'inspect_failed' };

function looksLikeDaemonCommand(command: string): boolean {
  const normalized = command.replaceAll('\\', '/');
  const hasStartSync = normalized.includes('daemon start-sync');
  const hasCliDistEntrypoint =
    normalized.includes('apps/cli/dist/index.mjs') ||
    normalized.includes('apps/cli/dist/index.js') ||
    (normalized.includes('apps/cli') && normalized.includes('dist/index.mjs')) ||
    (normalized.includes('apps/cli') && normalized.includes('dist/index.js')) ||
    normalized.includes('dist/index.mjs') ||
    normalized.includes('dist/index.js') ||
    normalized.includes('happier') && normalized.includes('daemon start-sync') && normalized.includes('dist/index');
  const hasCliSourceSnapshotEntrypoint =
    normalized.includes('tsx') &&
    normalized.includes('src/index.ts') &&
    (
      normalized.includes('apps/cli') ||
      normalized.includes('@happier-dev/cli') ||
      normalized.includes('/cli-dist-snapshot/src/index.ts') ||
      normalized.includes('/cli-dist/src/index.ts') ||
      (
        (normalized.includes('/.project/logs/e2e/') || normalized.includes('/.project/tmp/')) &&
        /\/cli-[^/\s]+\/src\/index\.ts(?:\s|$)/.test(normalized)
      )
    );
  return hasStartSync && (hasCliDistEntrypoint || hasCliSourceSnapshotEntrypoint);
}

function looksLikeTestDaemonLeaseCommand(command: string): boolean {
  return command.replaceAll('\\', '/').includes('daemon start-sync');
}

function inspectProcess(pid: number): ProcessInspectionResult {
  try {
    // Use wide output to avoid truncating long monorepo entrypoint paths. Truncation can cause
    // false negatives (and then we refuse to hard-kill a leaked daemon).
    let res = spawnSync('ps', ['-o', 'command=', '-p', String(pid), '-ww'], { encoding: 'utf8' });
    if (res.status !== 0) {
      res = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    }
    if (res.status !== 0) return { ok: false, reason: 'inspect_failed' };
    const command = String(res.stdout || '').trim();
    if (!command) return { ok: false, reason: 'inspect_failed' };
    return {
      ok: true,
      command,
      looksLikeDaemon: looksLikeDaemonCommand(command),
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return { ok: false, reason: 'ps_missing' };
    return { ok: false, reason: 'inspect_failed' };
  }
}

type DaemonSessionMarkerCandidate = Readonly<{
  pid: number;
  markerPath: string;
  startedBy: string;
  processCommandHash: string;
}>;

function hashCommand(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

function inspectProcessCommand(pid: number): string | null {
  try {
    // Use wide output to avoid truncation (PID reuse safety requires stable hashing).
    // Match the daemon's own marker hashing strategy (`ps-list` captures `args`).
    let res = spawnSync('ps', ['-o', 'args=', '-p', String(pid), '-ww'], { encoding: 'utf8' });
    if (res.status !== 0) {
      res = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
    }
    if (res.status !== 0) return null;
    const command = String(res.stdout || '').trim();
    return command || null;
  } catch {
    return null;
  }
}

async function listDaemonSessionMarkerCandidates(happyHomeDir: string): Promise<DaemonSessionMarkerCandidate[]> {
  const markerDirs = await resolveDaemonSessionMarkerDirs(happyHomeDir);
  const candidates: DaemonSessionMarkerCandidate[] = [];
  for (const markerDir of markerDirs) {
    let entries: string[] = [];
    try {
      entries = await readdir(markerDir);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (!name.startsWith('pid-') || !name.endsWith('.json')) continue;
      const markerPath = join(markerDir, name);
      try {
        const raw = await readFile(markerPath, 'utf8');
        const parsed = JSON.parse(raw) as any;
        const pid = typeof parsed?.pid === 'number' ? parsed.pid : Number(parsed?.pid);
        const startedBy = typeof parsed?.startedBy === 'string' ? parsed.startedBy.trim() : '';
        const processCommandHash = typeof parsed?.processCommandHash === 'string' ? parsed.processCommandHash.trim() : '';
        const markerHomeDir = typeof parsed?.happyHomeDir === 'string' ? parsed.happyHomeDir.trim() : '';

        if (!Number.isInteger(pid) || pid <= 1) continue;
        if (markerHomeDir && markerHomeDir !== happyHomeDir) continue;
        if (!startedBy) continue;
        if (!processCommandHash) continue;

        candidates.push({
          pid,
          markerPath,
          startedBy,
          processCommandHash,
        });
      } catch {
        // ignore unreadable markers
      }
    }
  }
  return candidates;
}

async function stopDaemonLeakedSessionsFromMarkersBestEffort(happyHomeDir: string): Promise<void> {
  const candidates = await listDaemonSessionMarkerCandidates(happyHomeDir);
  for (const marker of candidates) {
    if (marker.startedBy !== 'daemon') continue;

    const command = inspectProcessCommand(marker.pid);
    if (!command) continue;
    const hash = hashCommand(command);
    if (hash !== marker.processCommandHash) continue;

    await terminateProcessTreeByPid(marker.pid, { graceMs: 3_000, pollMs: 50 }).catch(() => {});
    await unlink(marker.markerPath).catch(() => {});
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      return true;
    }
  }
  return false;
}

async function waitForReplacementDaemonState(
  happyHomeDir: string,
  originalPid: number,
  opts?: { timeoutMs?: number },
): Promise<DaemonState> {
  const timeoutMs = opts?.timeoutMs ?? 45_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await readDaemonState(happyHomeDir);
    if (state && state.httpPort > 0 && state.pid > 0 && state.pid !== originalPid) {
      try {
        process.kill(state.pid, 0);
        return state;
      } catch {
        // Keep polling until the replacement process is observable.
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for replacement daemon.state.json in ${happyHomeDir}`);
}

type HardKillPhase = 'unreachable' | 'graceful-timeout' | 'replacement';

type DaemonStartupPhase =
  | 'sweepProcessOwnershipLeases'
  | 'resolveCliTestLaunchSpec'
  | 'stopExistingDaemon'
  | 'waitForDaemonState';

type DaemonStartupDiagnostics = Readonly<{
  phase: DaemonStartupPhase;
  timeoutMs?: number;
  testDir: string;
  happyHomeDir: string;
  stdoutPath: string;
  stderrPath: string;
  processPid?: number | null;
}>;

function parsePositiveInteger(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

const DEFAULT_DAEMON_STARTUP_PHASE_TIMEOUT_MS = 300_000;

function resolveDaemonStartupPhaseTimeoutMs(env: NodeJS.ProcessEnv, startupTimeoutMs: number | undefined): number {
  return parsePositiveInteger(env.HAPPIER_E2E_DAEMON_STARTUP_PHASE_TIMEOUT_MS)
    ?? startupTimeoutMs
    ?? DEFAULT_DAEMON_STARTUP_PHASE_TIMEOUT_MS;
}

function resolveDaemonCliDistBuildTimeoutMs(env: NodeJS.ProcessEnv): number {
  return parsePositiveInteger(env.HAPPIER_E2E_CLI_DIST_BUILD_TIMEOUT_MS ?? env.HAPPY_E2E_CLI_DIST_BUILD_TIMEOUT_MS)
    ?? DEFAULT_CLI_DIST_BUILD_TIMEOUT_MS;
}

function resolveDaemonLaunchSpecPhaseTimeoutMs(env: NodeJS.ProcessEnv, startupTimeoutMs: number | undefined): number {
  const explicitPhaseTimeoutMs = parsePositiveInteger(env.HAPPIER_E2E_DAEMON_STARTUP_PHASE_TIMEOUT_MS);
  if (explicitPhaseTimeoutMs != null) return explicitPhaseTimeoutMs;
  if (startupTimeoutMs != null) return startupTimeoutMs;
  return Math.max(DEFAULT_DAEMON_STARTUP_PHASE_TIMEOUT_MS, resolveDaemonCliDistBuildTimeoutMs(env));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function formatDaemonStartupDiagnostics(params: DaemonStartupDiagnostics): Promise<string> {
  const state = await readDaemonState(params.happyHomeDir).catch(() => null);
  const statePath = daemonStatePath(params.happyHomeDir);
  const processPid = params.processPid ?? null;
  const processStatus = processPid == null
    ? 'not-spawned'
    : isPidAlive(processPid)
      ? 'alive'
      : 'not-alive';

  return [
    `phase=${params.phase}`,
    params.timeoutMs == null ? null : `timeoutMs=${params.timeoutMs}`,
    `testDir=${params.testDir}`,
    `happyHomeDir=${params.happyHomeDir}`,
    `daemonStatePath=${statePath}`,
    `daemonStateExists=${state ? 'yes' : 'no'}`,
    state ? `daemonStatePid=${state.pid}` : null,
    state ? `daemonStateHttpPort=${state.httpPort}` : null,
    `processPid=${processPid == null ? 'not-spawned' : processPid}`,
    `processStatus=${processStatus}`,
    `stdoutPath=${params.stdoutPath}`,
    `stderrPath=${params.stderrPath}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ');
}

async function createDaemonStartupPhaseError(
  message: string,
  params: DaemonStartupDiagnostics,
): Promise<Error> {
  return new Error(`${message}. ${await formatDaemonStartupDiagnostics(params)}`);
}

async function runDaemonStartupPhase<T>(
  phase: DaemonStartupPhase,
  promise: Promise<T>,
  params: Omit<DaemonStartupDiagnostics, 'phase'>,
): Promise<T> {
  const timeoutMs = params.timeoutMs;
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = timeoutMs == null
      ? null
      : setTimeout(() => {
          if (settled) return;
          settled = true;
          void createDaemonStartupPhaseError(
            'Timed out during daemon startup',
            { ...params, phase },
          ).then(rejectPromise, rejectPromise);
        }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const causeMessage = error instanceof Error ? error.message : String(error);
        void createDaemonStartupPhaseError(
          `Daemon startup failed during ${phase}: ${causeMessage}`,
          { ...params, phase },
        ).then(rejectPromise, rejectPromise);
      },
    );
  });
}

function hardKillContext(params: { phase: HardKillPhase; state: DaemonState }): string {
  return `phase=${params.phase} pid=${params.state.pid} httpPort=${params.state.httpPort}`;
}

function throwHardKillError(params: { phase: HardKillPhase; state: DaemonState; message: string }): never {
  throw new Error(`${hardKillContext(params)} ${params.message}`);
}

async function hardKillDaemonPid(params: {
  phase: HardKillPhase;
  state: DaemonState;
  inspector: (pid: number) => ProcessInspectionResult;
}): Promise<void> {
  const inspected = params.inspector(params.state.pid);
  if (!inspected.ok) {
    if (inspected.reason === 'ps_missing') {
      throwHardKillError({
        phase: params.phase,
        state: params.state,
        message: 'cannot safely hard-kill: required process inspection command "ps" is unavailable on this platform.',
      });
    }
    throwHardKillError({
      phase: params.phase,
      state: params.state,
      message: 'cannot safely hard-kill: failed to inspect the process command line.',
    });
  }
  if (!inspected.looksLikeDaemon) {
    throwHardKillError({
      phase: params.phase,
      state: params.state,
      message: `refusing to hard-kill: daemon.state.json points to a non-daemon process (${inspected.command}).`,
    });
  }

  try {
    process.kill(params.state.pid, 'SIGTERM');
  } catch {
    return;
  }

  const exitedAfterTerm = await waitForPidExit(params.state.pid, 3_000);
  if (exitedAfterTerm) return;

  try {
    process.kill(params.state.pid, 'SIGKILL');
  } catch {
    // ignore
  }
}

export async function stopDaemonFromHomeDir(
  happyHomeDir: string,
  opts?: {
    gracefulTimeoutMs?: number;
    hardKill?: boolean;
    inspectProcess?: (pid: number) => ProcessInspectionResult;
  },
): Promise<void> {
  const state = await readDaemonState(happyHomeDir);
  if (!state) return;

  const inspector = opts?.inspectProcess ?? inspectProcess;

  const controlToken = typeof state.controlToken === 'string' ? state.controlToken.trim() : '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(controlToken ? { 'x-happier-daemon-token': controlToken } : {}),
  };

  const stopRes = await fetch(`http://127.0.0.1:${state.httpPort}/stop`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ stopSessions: true }),
    signal: AbortSignal.timeout(2_000),
  }).catch(() => null);

  // Treat auth failures like an unreachable daemon (don't wait full graceful timeout for a 401).
  if (!stopRes || stopRes.status === 401) {
    // If the daemon isn't reachable, avoid waiting a full graceful timeout on stale state.
    // Fail closed before hard-killing: only kill if we can reliably inspect the PID.
    let daemonPidAlive = false;
    try {
      process.kill(state.pid, 0);
      daemonPidAlive = true;
    } catch {
      daemonPidAlive = false;
    }

    const hardKill = opts?.hardKill ?? true;
    if (daemonPidAlive && hardKill) {
      await hardKillDaemonPid({ phase: 'unreachable', state, inspector });
    }

    // Even if the daemon is already gone, detached daemon-started sessions can remain.
    await stopDaemonLeakedSessionsFromMarkersBestEffort(happyHomeDir).catch(() => {});
    return;
  }

  const gracefulTimeoutMs = opts?.gracefulTimeoutMs ?? 30_000;
  const exited = await waitForPidExit(state.pid, gracefulTimeoutMs);
  if (exited) {
    // A daemon can still leave detached daemon-owned session processes behind even after
    // acknowledging /stop and exiting cleanly. Sweep marker-owned leftovers on the clean path too.
    await stopDaemonLeakedSessionsFromMarkersBestEffort(happyHomeDir).catch(() => {});
    return;
  }

  const hardKill = opts?.hardKill ?? true;
  if (!hardKill) return;

  // Best-effort hard stop to avoid leaking daemons across test runs.
  // Fail closed: only kill if it looks like our daemon.
  await hardKillDaemonPid({ phase: 'graceful-timeout', state, inspector });

  // If we had to hard-kill the daemon, it may not have had a chance to stop detached sessions.
  await stopDaemonLeakedSessionsFromMarkersBestEffort(happyHomeDir).catch(() => {});
}

export type StartedDaemon = {
  happyHomeDir: string;
  state: DaemonState;
  proc: SpawnedProcess;
  stop: () => Promise<void>;
};

export function resolveTestDaemonOwnershipLeasesDir(rootDir: string = repoRootDir()): string {
  return resolveProcessOwnershipLeasesDir({ rootDir, leaseKind: 'test-daemon' });
}

export function sanitizeDaemonEnvForSpawn(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  // Source-entrypoint E2E runs must not inherit a stack's pinned-dist fast path.
  if (shouldUseCliSourceEntrypoint(sanitized)) {
    sanitized.HAPPIER_CLI_SUBPROCESS_PREFER_TSX = '1';
    delete sanitized.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT;
    delete sanitized.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT;
  }
  delete sanitized.TMUX;
  delete sanitized.TMUX_PANE;
  delete sanitized.TMUX_TMPDIR;
  // Daemons should never inherit per-session attach/trace env. If they do, they can consume and
  // delete attach files intended for the actual session runner process, breaking provider e2e.
  delete sanitized.HAPPIER_SESSION_ATTACH_FILE;
  delete sanitized.HAPPY_SESSION_ATTACH_FILE;
  delete sanitized.HAPPIER_STACK_TOOL_TRACE_FILE;
  delete sanitized.HAPPY_STACK_TOOL_TRACE_FILE;
  // Test harness must not inherit host daemon/server selection overrides.
  // These can force a different active server id than the seeded test credentials
  // and cause false auth-gated daemon startup failures in non-interactive continuity lanes.
  delete sanitized.HAPPIER_ACTIVE_SERVER_ID;
  delete sanitized.HAPPIER_DAEMON_SERVICE_INSTANCE_ID;
  delete sanitized.HAPPIER_DAEMON_SERVICE_SERVER_URL;
  if (sanitized.HAPPIER_DISABLE_CAFFEINATE === undefined || sanitized.HAPPIER_DISABLE_CAFFEINATE === '') {
    sanitized.HAPPIER_DISABLE_CAFFEINATE = '1';
  }
  if (sanitized.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED === undefined || sanitized.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED === '') {
    sanitized.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED = '0';
  }
  return sanitized;
}

function resolveDaemonSubprocessEntrypointEnv(cliLaunchSpec: Readonly<{ command: string; args: string[] }>): NodeJS.ProcessEnv {
  if (cliLaunchSpec.command !== process.execPath) return {};
  if (cliLaunchSpec.args.length !== 1) return {};
  const entrypoint = cliLaunchSpec.args[0]?.trim() ?? '';
  if (!entrypoint.endsWith('.mjs')) return {};
  return {
    HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
    HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
  };
}

export async function startTestDaemon(params: {
  testDir: string;
  happyHomeDir: string;
  env: NodeJS.ProcessEnv;
  snapshotDir?: string;
  preparedDistSnapshotOnly?: boolean;
  startupTimeoutMs?: number;
  cleanupDescendantsOnExit?: boolean;
}): Promise<StartedDaemon> {
  if (params.preparedDistSnapshotOnly === true && !params.snapshotDir?.trim()) {
    throw new Error('startTestDaemon preparedDistSnapshotOnly requires an explicit snapshotDir');
  }
  const stdoutPath = resolve(params.testDir, 'daemon.stdout.log');
  const stderrPath = resolve(params.testDir, 'daemon.stderr.log');
  const phaseTimeoutMs = resolveDaemonStartupPhaseTimeoutMs(params.env, params.startupTimeoutMs);
  const cliDistBuildTimeoutMs = resolveDaemonCliDistBuildTimeoutMs(params.env);
  const launchSpecPhaseTimeoutMs = resolveDaemonLaunchSpecPhaseTimeoutMs(params.env, params.startupTimeoutMs);
  const baseDiagnostics = {
    testDir: params.testDir,
    happyHomeDir: params.happyHomeDir,
    stdoutPath,
    stderrPath,
    timeoutMs: phaseTimeoutMs,
  };

  const currentOwnerInspection = inspectOwnedProcess(process.pid);
  if (currentOwnerInspection.ok) {
    await runDaemonStartupPhase(
      'sweepProcessOwnershipLeases',
      sweepProcessOwnershipLeases({
        rootDir: repoRootDir(),
        leaseKind: 'test-daemon',
        currentOwnerPid: process.pid,
        currentOwnerStartTime: currentOwnerInspection.startTime,
        isOwnedProcessCommand: (command) => looksLikeTestDaemonLeaseCommand(command),
      }),
      baseDiagnostics,
    );
  }

  const cliLaunchSpec = await runDaemonStartupPhase(
    'resolveCliTestLaunchSpec',
    resolveCliTestLaunchSpec(
      {
        testDir: params.testDir,
        env: {
          ...params.env,
          HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: resolveDaemonSnapshotNodeModulesMode(params.env),
        },
      },
      {
        snapshotDir: params.snapshotDir ?? resolveDaemonCliSnapshotDir({ testDir: params.testDir, env: params.env }),
        preparedDistSnapshotOnly: params.preparedDistSnapshotOnly,
        skipDistIntegrityCheck: true,
        skipSourceFreshnessCheck: true,
        buildTimeoutMs: cliDistBuildTimeoutMs,
      },
    ),
    {
      ...baseDiagnostics,
      timeoutMs: launchSpecPhaseTimeoutMs,
    },
  );

  await runDaemonStartupPhase(
    'stopExistingDaemon',
    stopDaemonFromHomeDir(params.happyHomeDir).catch(() => {}),
    baseDiagnostics,
  );

  const proc = spawnLoggedProcess({
    command: cliLaunchSpec.command,
    args: [...cliLaunchSpec.args, 'daemon', 'start-sync'],
    cwd: cliLaunchSpec.cwd ?? repoRootDir(),
    env: {
      ...sanitizeDaemonEnvForSpawn(params.env),
      ...(cliLaunchSpec.env ?? {}),
      ...resolveDaemonSubprocessEntrypointEnv(cliLaunchSpec),
      CI: '1',
      HAPPIER_HOME_DIR: params.happyHomeDir,
    },
    stdoutPath,
    stderrPath,
    cleanupDescendantsOnExit: params.cleanupDescendantsOnExit,
  });

  await registerProcessOwnershipLease({
    rootDir: repoRootDir(),
    leaseKind: 'test-daemon',
    child: proc.child,
    ownerPid: process.pid,
    ownerStartTime: currentOwnerInspection.ok ? currentOwnerInspection.startTime : null,
    metadata: {
      happyHomeDir: params.happyHomeDir,
      testDir: params.testDir,
    },
  });

  let state: DaemonState;
  try {
    const startupTimeoutMs = phaseTimeoutMs;
    const exitStateGraceTimeoutMs = Math.min(startupTimeoutMs, 10_000);
    state = await runDaemonStartupPhase(
      'waitForDaemonState',
      Promise.race([
        waitForDaemonState(params.happyHomeDir, { timeoutMs: startupTimeoutMs }),
        new Promise<DaemonState>((resolveState, rejectState) => {
          proc.child.once('exit', (code, signal) => {
            void (async () => {
              try {
                const exitedState = await waitForDaemonState(params.happyHomeDir, { timeoutMs: exitStateGraceTimeoutMs });
                resolveState(exitedState);
              } catch {
                const detail = signal ? `signal=${String(signal)}` : `code=${String(code)}`;
                rejectState(
                  new Error(
                    `Daemon exited before writing daemon.state.json (${detail}). See logs: ${stdoutPath} and ${stderrPath}`,
                  ),
                );
              }
            })().catch((error) => rejectState(error instanceof Error ? error : new Error(String(error))));
          });
        }),
      ]),
      {
        ...baseDiagnostics,
        timeoutMs: startupTimeoutMs,
        processPid: proc.child.pid ?? null,
      },
    );
  } catch (e) {
    // If daemon startup fails, make sure we don't leak a background process.
    await stopDaemonFromHomeDir(params.happyHomeDir).catch(() => {});
    await proc.stop().catch(() => {});
    throw e;
  }

  return {
    happyHomeDir: params.happyHomeDir,
    state,
    proc,
    stop: async () => {
      await stopDaemonFromHomeDir(params.happyHomeDir).catch(() => {});
      await proc.stop().catch(() => {});
    },
  };
}

export async function replaceTestDaemonWithoutStoppingSessions(params: {
  testDir: string;
  happyHomeDir: string;
  env: NodeJS.ProcessEnv;
  originalDaemon?: StartedDaemon;
  snapshotDir?: string;
  stdoutPath?: string;
  stderrPath?: string;
}): Promise<DaemonState> {
  const originalState = await readDaemonState(params.happyHomeDir);
  if (!originalState || typeof originalState.pid !== 'number' || originalState.pid <= 0) {
    throw new Error(`Missing original daemon state for ${params.happyHomeDir}`);
  }

  const originalDaemonExit = params.originalDaemon
    ? new Promise<void>((resolveExit, rejectExit) => {
        const timeout = setTimeout(
          () => rejectExit(new Error(`Timed out waiting for daemon PID ${originalState.pid} to exit`)),
          30_000,
        );
        params.originalDaemon?.proc.child.once('exit', () => {
          clearTimeout(timeout);
          resolveExit();
        });
      })
    : waitForPidExit(originalState.pid, 30_000).then((exited) => {
        if (!exited) {
          throw new Error(`Timed out waiting for daemon PID ${originalState.pid} to exit`);
        }
      });

  await hardKillDaemonPid({
    phase: 'replacement',
    state: originalState,
    inspector: inspectProcess,
  });

  await originalDaemonExit;

  const cliLaunchSpec = await resolveCliTestLaunchSpec(
    {
      testDir: params.testDir,
      env: params.env,
    },
    {
      snapshotDir: params.snapshotDir ?? resolve(params.testDir, 'cli-dist'),
    },
  );

  const proc = spawnLoggedProcess({
    command: cliLaunchSpec.command,
    args: [...cliLaunchSpec.args, 'daemon', 'start-sync', '--takeover'],
    cwd: cliLaunchSpec.cwd ?? repoRootDir(),
    env: {
      ...sanitizeDaemonEnvForSpawn(params.env),
      ...(cliLaunchSpec.env ?? {}),
      ...resolveDaemonSubprocessEntrypointEnv(cliLaunchSpec),
      CI: '1',
      HAPPIER_HOME_DIR: params.happyHomeDir,
    },
    stdoutPath: params.stdoutPath ?? resolve(params.testDir, 'daemon.replace.stdout.log'),
    stderrPath: params.stderrPath ?? resolve(params.testDir, 'daemon.replace.stderr.log'),
  });

  try {
    return await waitForReplacementDaemonState(params.happyHomeDir, originalState.pid, { timeoutMs: 45_000 });
  } catch (error) {
    await stopDaemonFromHomeDir(params.happyHomeDir).catch(() => {});
    await proc.stop().catch(() => {});
    throw error;
  }
}

export async function withTestDaemon<T>(params: {
  testDir: string;
  happyHomeDir: string;
  env: NodeJS.ProcessEnv;
  run: (daemon: StartedDaemon) => Promise<T>;
}): Promise<T> {
  const daemon = await startTestDaemon({ testDir: params.testDir, happyHomeDir: params.happyHomeDir, env: params.env });
  try {
    return await params.run(daemon);
  } finally {
    await daemon.stop().catch(() => {});
  }
}
