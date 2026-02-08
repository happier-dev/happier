import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { repoRootDir } from '../paths';
import { spawnLoggedProcess, type SpawnedProcess } from '../process/spawnProcess';
import { ensureCliDistBuilt } from '../process/cliDist';

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

export async function readDaemonState(happyHomeDir: string): Promise<DaemonState | null> {
  const activeServerId = await resolveActiveServerIdFromSettings(happyHomeDir);
  const candidates: string[] = [];
  if (activeServerId) candidates.push(perServerDaemonStatePath(happyHomeDir, activeServerId));
  candidates.push(daemonStatePath(happyHomeDir));

  for (const candidate of candidates) {
    const state = await readDaemonStateFromPath(candidate);
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
    const res = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    if (res.status !== 0) return { ok: false, reason: 'inspect_failed' };
    const command = (res.stdout || '').trim();
    if (!command) return { ok: false, reason: 'inspect_failed' };
    return {
      ok: true,
      command,
      looksLikeDaemon: command.includes('daemon start-sync') && command.includes('apps/cli/dist/index.mjs'),
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return { ok: false, reason: 'ps_missing' };
    return { ok: false, reason: 'inspect_failed' };
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

  const stopRes = await fetch(`http://127.0.0.1:${state.httpPort}/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(2_000),
  }).catch(() => null);

  if (!stopRes) {
    // If the daemon isn't reachable, avoid waiting a full graceful timeout on stale state.
    // Fail closed before hard-killing: only kill if we can reliably inspect the PID.
    try {
      process.kill(state.pid, 0);
    } catch {
      return;
    }

    const hardKill = opts?.hardKill ?? true;
    if (!hardKill) return;

    await hardKillDaemonPid({ phase: 'unreachable', state, inspector });
    return;
  }

  const gracefulTimeoutMs = opts?.gracefulTimeoutMs ?? 30_000;
  const exited = await waitForPidExit(state.pid, gracefulTimeoutMs);
  if (exited) return;

  const hardKill = opts?.hardKill ?? true;
  if (!hardKill) return;

  // Best-effort hard stop to avoid leaking daemons across test runs.
  // Fail closed: only kill if it looks like our daemon.
  await hardKillDaemonPid({ phase: 'graceful-timeout', state, inspector });
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
  return sanitized;
}

export async function startTestDaemon(params: {
  testDir: string;
  happyHomeDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<StartedDaemon> {
  const cliDistEntrypoint = await ensureCliDistBuilt({ testDir: params.testDir, env: params.env });

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
    state = await waitForDaemonState(params.happyHomeDir, { timeoutMs: 45_000 });
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
