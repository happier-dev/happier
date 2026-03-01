import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { configuration } from '@/configuration';

import { withOpenCodeServerFileLock } from './openCodeServerFileLock';
import { startManagedOpenCodeServer } from './openCodeManagedServer';

export type SharedManagedOpenCodeServerState = Readonly<{
  baseUrl: string;
  pid: number;
  startedAtMs: number;
}>;

type ResolveDeps = Readonly<{
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  readState: () => Promise<SharedManagedOpenCodeServerState | null>;
  writeState: (state: SharedManagedOpenCodeServerState) => Promise<void>;
  isPidAlive: (pid: number) => boolean;
  probeHealth: (baseUrl: string) => Promise<boolean>;
  startServer: () => Promise<{ baseUrl: string; pid: number }>;
  nowMs?: () => number;
}>;

export async function resolveSharedManagedOpenCodeServerBaseUrl(
  deps: ResolveDeps,
): Promise<{ baseUrl: string; didStart: boolean }> {
  return await deps.withLock(async () => {
    const state = await deps.readState();
    if (state && deps.isPidAlive(state.pid)) {
      const healthy = await deps.probeHealth(state.baseUrl).catch(() => false);
      if (healthy) return { baseUrl: state.baseUrl, didStart: false };
    }

    const started = await deps.startServer();
    const nowMs = deps.nowMs?.() ?? Date.now();
    const nextState: SharedManagedOpenCodeServerState = {
      baseUrl: started.baseUrl,
      pid: started.pid,
      startedAtMs: nowMs,
    };
    await deps.writeState(nextState);
    return { baseUrl: started.baseUrl, didStart: true };
  });
}

function resolveStatePathFromEnv(): string {
  const raw = typeof process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH === 'string'
    ? process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH.trim()
    : '';
  if (raw) return raw;
  return join(configuration.happyHomeDir, 'opencode', 'managed-server.json');
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readStateFile(statePath: string): Promise<SharedManagedOpenCodeServerState | null> {
  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const baseUrl = typeof (parsed as any).baseUrl === 'string' ? String((parsed as any).baseUrl).trim() : '';
    const pid = typeof (parsed as any).pid === 'number' ? (parsed as any).pid : Number((parsed as any).pid);
    const startedAtMs = typeof (parsed as any).startedAtMs === 'number' ? (parsed as any).startedAtMs : Number((parsed as any).startedAtMs);
    if (!baseUrl) return null;
    if (!Number.isFinite(pid) || pid <= 0) return null;
    if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
    return { baseUrl, pid: Math.floor(pid), startedAtMs: Math.floor(startedAtMs) };
  } catch {
    return null;
  }
}

async function writeStateFile(statePath: string, state: SharedManagedOpenCodeServerState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  await writeFile(tmp, JSON.stringify(state), 'utf8');
  await rename(tmp, statePath);
}

export async function ensureSharedManagedOpenCodeServerBaseUrl(params: Readonly<{
  probeHealth: (baseUrl: string) => Promise<boolean>;
}>): Promise<string> {
  const statePath = resolveStatePathFromEnv();
  const lockFile = `${statePath}.lock`;
  // By default, do not override XDG dirs for the managed server. In practice, OpenCode often stores
  // auth state under XDG data/state paths. Overriding those can make a managed server unable to
  // access credentials that have already been mirrored into the (isolated) HOME directory.
  //
  // If you need to isolate OpenCode’s XDG dirs (e.g. multi-user shared hosts), set:
  // `HAPPIER_OPENCODE_SERVER_XDG_ROOT_DIR=/path`.
  const xdgRootDirFromEnv = typeof process.env.HAPPIER_OPENCODE_SERVER_XDG_ROOT_DIR === 'string'
    ? process.env.HAPPIER_OPENCODE_SERVER_XDG_ROOT_DIR.trim()
    : '';
  const xdgRootDir = xdgRootDirFromEnv.length > 0 ? xdgRootDirFromEnv : null;

  const resolved = await resolveSharedManagedOpenCodeServerBaseUrl({
    withLock: async (fn) => await withOpenCodeServerFileLock(lockFile, fn),
    readState: async () => await readStateFile(statePath),
    writeState: async (state) => await writeStateFile(statePath, state),
    isPidAlive,
    probeHealth: params.probeHealth,
    startServer: async () => {
      const started = await startManagedOpenCodeServer({ ...(xdgRootDir ? { xdgRootDir } : {}) });
      return { baseUrl: started.baseUrl, pid: started.pid };
    },
  });

  return resolved.baseUrl;
}

type ManagedServerProcessInfo = Readonly<{
  name: string;
  cmd: string;
}>;

type StopDeps = Readonly<{
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  readState: () => Promise<SharedManagedOpenCodeServerState | null>;
  removeState: () => Promise<void>;
  isPidAlive: (pid: number) => boolean;
  probeHealth: (baseUrl: string) => Promise<boolean>;
  getProcessInfo: (pid: number) => Promise<ManagedServerProcessInfo | null>;
  killPid: (pid: number) => void;
}>;

function looksLikeOpenCodeServe(info: ManagedServerProcessInfo | null): boolean {
  if (!info) return false;
  const name = info.name.toLowerCase();
  const cmd = info.cmd.toLowerCase();
  if (name.includes('opencode')) return true;
  if (cmd.includes('opencode') && cmd.includes('serve')) return true;
  return false;
}

export async function stopSharedManagedOpenCodeServerFromState(
  deps: StopDeps,
): Promise<{ didKill: boolean }> {
  return await deps.withLock(async () => {
    const state = await deps.readState();
    if (!state) return { didKill: false };
    if (!deps.isPidAlive(state.pid)) {
      await deps.removeState().catch(() => {});
      return { didKill: false };
    }

    const healthy = await deps.probeHealth(state.baseUrl).catch(() => false);
    if (healthy) {
      deps.killPid(state.pid);
      await deps.removeState().catch(() => {});
      return { didKill: true };
    }

    const info = await deps.getProcessInfo(state.pid).catch(() => null);
    if (looksLikeOpenCodeServe(info)) {
      deps.killPid(state.pid);
      await deps.removeState().catch(() => {});
      return { didKill: true };
    }

    await deps.removeState().catch(() => {});
    return { didKill: false };
  });
}

async function probeOpenCodeHealthBestEffort(baseUrl: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800);
    timer.unref?.();
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/global/health`, { signal: ctrl.signal }).catch(() => null);
    clearTimeout(timer);
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

function killPidBestEffort(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    // Prefer killing the full process group (managed server is detached).
    process.kill(-pid);
    return;
  } catch {
    // fall through
  }
  try {
    process.kill(pid);
  } catch {
    // ignore
  }
}

export async function stopSharedManagedOpenCodeServerFromEnvBestEffort(): Promise<void> {
  const statePath = resolveStatePathFromEnv();
  const lockFile = `${statePath}.lock`;
  await stopSharedManagedOpenCodeServerFromState({
    withLock: async (fn) => await withOpenCodeServerFileLock(lockFile, fn),
    readState: async () => await readStateFile(statePath),
    removeState: async () => {
      await rm(statePath, { force: true }).catch(() => {});
    },
    isPidAlive,
    probeHealth: async (baseUrl) => await probeOpenCodeHealthBestEffort(baseUrl),
    getProcessInfo: async (pid) => {
      const mod = await import('ps-list').catch(() => null as any);
      const psList: null | (() => Promise<any[]>) = mod && typeof mod === 'function'
        ? mod
        : mod && typeof (mod as any).default === 'function'
          ? (mod as any).default
          : null;
      if (!psList) return null;
      const procs = await psList().catch(() => []);
      const proc = Array.isArray(procs) ? procs.find((p) => (p as any)?.pid === pid) : null;
      if (!proc) return null;
      const name = typeof (proc as any).name === 'string' ? String((proc as any).name) : '';
      const cmd = typeof (proc as any).cmd === 'string' ? String((proc as any).cmd) : '';
      if (!name && !cmd) return null;
      return { name, cmd };
    },
    killPid: killPidBestEffort,
  }).then(() => {}).catch(() => {});
}
