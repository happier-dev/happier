import { readFile, readdir, stat } from 'node:fs/promises';
import { unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { repoRootDir } from '../paths';
import { spawnLoggedProcess, type SpawnedProcess } from '../process/spawnProcess';
import { ensureCliDistSnapshotEntrypoint } from '../process/cliDist';
import { terminateProcessTreeByPid } from '../process/processTree';

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
    const normalized = command.replaceAll('\\', '/');
    const hasStartSync = normalized.includes('daemon start-sync');
    const hasCliEntrypoint =
      normalized.includes('apps/cli/dist/index.mjs') ||
      normalized.includes('apps/cli/dist/index.js') ||
      (normalized.includes('apps/cli') && normalized.includes('dist/index.mjs')) ||
      (normalized.includes('apps/cli') && normalized.includes('dist/index.js')) ||
      normalized.includes('dist/index.mjs') ||
      normalized.includes('dist/index.js') ||
      normalized.includes('happier') && normalized.includes('daemon start-sync') && normalized.includes('dist/index');
    return {
      ok: true,
      command,
      looksLikeDaemon: hasStartSync && hasCliEntrypoint,
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

function daemonSessionMarkersDir(happyHomeDir: string): string {
  return join(happyHomeDir, 'tmp', 'daemon-sessions');
}

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
  const dir = daemonSessionMarkersDir(happyHomeDir);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const candidates: DaemonSessionMarkerCandidate[] = [];
  for (const name of entries) {
    if (!name.startsWith('pid-') || !name.endsWith('.json')) continue;
    const markerPath = join(dir, name);
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

type HardKillPhase = 'unreachable' | 'graceful-timeout';

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
  const hardKill = opts?.hardKill ?? true;

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

    if (daemonPidAlive && hardKill) {
      await hardKillDaemonPid({ phase: 'unreachable', state, inspector });
    }

    // Even if the daemon is already gone, detached daemon-started sessions can remain.
    await stopDaemonLeakedSessionsFromMarkersBestEffort(happyHomeDir).catch(() => {});
    return;
  }

  const gracefulTimeoutMs = opts?.gracefulTimeoutMs ?? 30_000;
  const exited = await waitForPidExit(state.pid, gracefulTimeoutMs);
  if (exited) return;

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

export function sanitizeDaemonEnvForSpawn(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  delete sanitized.TMUX;
  delete sanitized.TMUX_PANE;
  delete sanitized.TMUX_TMPDIR;
  // Daemons should never inherit per-session attach/trace env. If they do, they can consume and
  // delete attach files intended for the actual session runner process, breaking provider e2e.
  delete sanitized.HAPPIER_SESSION_ATTACH_FILE;
  delete sanitized.HAPPY_SESSION_ATTACH_FILE;
  delete sanitized.HAPPIER_STACK_TOOL_TRACE_FILE;
  delete sanitized.HAPPY_STACK_TOOL_TRACE_FILE;
  return sanitized;
}

export async function startTestDaemon(params: {
  testDir: string;
  happyHomeDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<StartedDaemon> {
  const snapshotDir = resolve(params.testDir, 'cli-dist');
  const cliDistEntrypoint = await ensureCliDistSnapshotEntrypoint(
    { testDir: params.testDir, env: params.env },
    { snapshotDir },
  );

  const proc = spawnLoggedProcess({
    command: process.execPath,
    args: [cliDistEntrypoint, 'daemon', 'start-sync'],
    cwd: repoRootDir(),
    env: {
      ...sanitizeDaemonEnvForSpawn(params.env),
      CI: '1',
      HAPPIER_HOME_DIR: params.happyHomeDir,
    },
    stdoutPath: resolve(params.testDir, 'daemon.stdout.log'),
    stderrPath: resolve(params.testDir, 'daemon.stderr.log'),
  });

  let state: DaemonState;
  try {
    state = await Promise.race([
      waitForDaemonState(params.happyHomeDir, { timeoutMs: 45_000 }),
      new Promise<never>((_, reject) => {
        proc.child.once('exit', (code, signal) => {
          const detail = signal ? `signal=${String(signal)}` : `code=${String(code)}`;
          reject(
            new Error(
              `Daemon exited before writing daemon.state.json (${detail}). See logs: ${resolve(params.testDir, 'daemon.stdout.log')} and ${resolve(params.testDir, 'daemon.stderr.log')}`,
            ),
          );
        });
      }),
    ]);
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
