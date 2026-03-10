import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { configuration } from '@/configuration';

import {
  getOpenCodeServerProcessInfoBestEffort,
  isOpenCodeServerPidAlive,
  type OpenCodeServerProcessInfo,
} from './openCodeServerProcessState';
import { withOpenCodeServerFileLock } from './openCodeServerFileLock';
import { startManagedOpenCodeServer } from './openCodeManagedServer';
import { terminateManagedOpenCodeServerPidBestEffort } from './terminateManagedOpenCodeServerPidBestEffort';

export type SharedManagedOpenCodeServerState = Readonly<{
  baseUrl: string;
  pid: number;
  startedAtMs: number;
  status?: 'starting' | 'ready' | 'failed';
  lastFailureAtMs?: number;
}>;

type ManagedServerProcessInfo = OpenCodeServerProcessInfo;

type ResolveDeps = Readonly<{
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  readState: () => Promise<SharedManagedOpenCodeServerState | null>;
  writeState: (state: SharedManagedOpenCodeServerState) => Promise<void>;
  isPidAlive: (pid: number) => boolean;
  probeHealth: (baseUrl: string) => Promise<boolean>;
  getProcessInfo?: (pid: number) => Promise<ManagedServerProcessInfo | null>;
  killPid?: (pid: number) => Promise<boolean> | boolean;
  startServer: (params?: {
    onSpawned?: (started: Readonly<{ baseUrl: string; pid: number }>) => void | Promise<void>;
  }) => Promise<{ baseUrl: string; pid: number }>;
  nowMs?: () => number;
}>;

function normalizeSharedManagedServerState(
  state: SharedManagedOpenCodeServerState,
): SharedManagedOpenCodeServerState {
  return {
    ...state,
    status: state.status === 'starting' || state.status === 'failed' ? state.status : 'ready',
  };
}

export function isLoopbackManagedOpenCodeBaseUrl(rawBaseUrl: string): boolean {
  const value = rawBaseUrl.trim();
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const port = Number.parseInt(url.port, 10);
    if (!Number.isFinite(port) || port <= 0) return false;

    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '::1') return true;
    if (host.startsWith('127.')) return true;
    return false;
  } catch {
    return false;
  }
}

export async function resolveSharedManagedOpenCodeServerBaseUrl(
  deps: ResolveDeps,
): Promise<{ baseUrl: string; didStart: boolean }> {
  return await deps.withLock(async () => {
    const rawState = await deps.readState();
    const state = rawState ? normalizeSharedManagedServerState(rawState) : null;
    if (state && deps.isPidAlive(state.pid) && isLoopbackManagedOpenCodeBaseUrl(state.baseUrl)) {
      const healthy = await deps.probeHealth(state.baseUrl).catch(() => false);
      if (healthy) {
        if (state.status === 'failed') {
          await deps.writeState({
            baseUrl: state.baseUrl,
            pid: state.pid,
            startedAtMs: state.startedAtMs,
            status: 'ready',
          });
        }
        return { baseUrl: state.baseUrl, didStart: false };
      }

      if (state.status === 'failed') {
        if (deps.getProcessInfo && deps.killPid) {
          const info = await deps.getProcessInfo(state.pid).catch(() => null);
          if (looksLikeOpenCodeServe(info)) {
            await invokeKillPidBestEffort(deps.killPid, state.pid);
          }
        }
      } else if (deps.getProcessInfo && deps.killPid) {
        const info = await deps.getProcessInfo(state.pid).catch(() => null);
        if (looksLikeOpenCodeServe(info)) {
          await invokeKillPidBestEffort(deps.killPid, state.pid);
        }
      }
    }

    const nowMs = deps.nowMs?.() ?? Date.now();
    let provisionalBaseUrl = '';
    let provisionalPid = -1;

    try {
      const started = await deps.startServer({
        onSpawned: async (spawned) => {
          provisionalBaseUrl = spawned.baseUrl;
          provisionalPid = spawned.pid;
          await deps.writeState({
            baseUrl: spawned.baseUrl,
            pid: spawned.pid,
            startedAtMs: nowMs,
            status: 'starting',
          });
        },
      });
      const nextState: SharedManagedOpenCodeServerState = {
        baseUrl: started.baseUrl,
        pid: started.pid,
        startedAtMs: nowMs,
        status: 'ready',
      };
      await deps.writeState(nextState);
      return { baseUrl: started.baseUrl, didStart: true };
    } catch (error) {
      if (provisionalBaseUrl && provisionalPid > 0) {
        await deps.writeState({
          baseUrl: provisionalBaseUrl,
          pid: provisionalPid,
          startedAtMs: nowMs,
          status: 'failed',
          lastFailureAtMs: nowMs,
        });
      }
      throw error;
    }
  });
}

function resolveStatePathFromEnv(): string {
  const raw = typeof process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH === 'string'
    ? process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH.trim()
    : '';
  if (raw) return raw;
  return join(configuration.happyHomeDir, 'opencode', 'managed-server.json');
}

async function readStateFile(statePath: string): Promise<SharedManagedOpenCodeServerState | null> {
  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const baseUrl = typeof (parsed as any).baseUrl === 'string' ? String((parsed as any).baseUrl).trim() : '';
    const pid = typeof (parsed as any).pid === 'number' ? (parsed as any).pid : Number((parsed as any).pid);
    const startedAtMs = typeof (parsed as any).startedAtMs === 'number' ? (parsed as any).startedAtMs : Number((parsed as any).startedAtMs);
    const statusRaw = typeof (parsed as any).status === 'string' ? String((parsed as any).status).trim() : '';
    const lastFailureAtMsRaw = typeof (parsed as any).lastFailureAtMs === 'number'
      ? (parsed as any).lastFailureAtMs
      : Number((parsed as any).lastFailureAtMs);
    if (!baseUrl) return null;
    if (!Number.isFinite(pid) || pid <= 0) return null;
    if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
    return {
      baseUrl,
      pid: Math.floor(pid),
      startedAtMs: Math.floor(startedAtMs),
      ...(statusRaw === 'starting' || statusRaw === 'failed' || statusRaw === 'ready' ? { status: statusRaw } : {}),
      ...(Number.isFinite(lastFailureAtMsRaw) && lastFailureAtMsRaw > 0 ? { lastFailureAtMs: Math.floor(lastFailureAtMsRaw) } : {}),
    };
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

export async function readSharedManagedOpenCodeServerStateBestEffort(): Promise<SharedManagedOpenCodeServerState | null> {
  const statePath = resolveStatePathFromEnv();
  return await readStateFile(statePath);
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
    isPidAlive: isOpenCodeServerPidAlive,
    probeHealth: params.probeHealth,
    getProcessInfo: async (pid) => await getProcessInfoBestEffort(pid),
    killPid: killPidBestEffort,
    startServer: async (startParams) => {
      const started = await startManagedOpenCodeServer({
        ...(xdgRootDir ? { xdgRootDir } : {}),
        ...(startParams?.onSpawned ? { onSpawned: startParams.onSpawned } : {}),
      });
      return { baseUrl: started.baseUrl, pid: started.pid };
    },
  });

  return resolved.baseUrl;
}

type StopDeps = Readonly<{
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  readState: () => Promise<SharedManagedOpenCodeServerState | null>;
  removeState: () => Promise<void>;
  isPidAlive: (pid: number) => boolean;
  probeHealth: (baseUrl: string) => Promise<boolean>;
  getProcessInfo: (pid: number) => Promise<ManagedServerProcessInfo | null>;
  killPid: (pid: number) => Promise<boolean> | boolean;
}>;

function looksLikeOpenCodeServe(info: ManagedServerProcessInfo | null): boolean {
  if (!info) return false;
  const name = info.name.toLowerCase();
  const cmd = info.cmd.toLowerCase();
  if (name.includes('opencode')) return true;
  if (cmd.includes('opencode') && cmd.includes('serve')) return true;
  return false;
}

async function getProcessInfoBestEffort(pid: number): Promise<ManagedServerProcessInfo | null> {
  return getOpenCodeServerProcessInfoBestEffort(pid);
}

async function invokeKillPidBestEffort(
  killPid: (pid: number) => Promise<boolean> | boolean,
  pid: number,
): Promise<boolean> {
  try {
    const didKill = await killPid(pid);
    return didKill !== false;
  } catch {
    return false;
  }
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

    const healthy = isLoopbackManagedOpenCodeBaseUrl(state.baseUrl)
      ? await deps.probeHealth(state.baseUrl).catch(() => false)
      : false;
    if (healthy) {
      const didKill = await invokeKillPidBestEffort(deps.killPid, state.pid);
      await deps.removeState().catch(() => {});
      return { didKill };
    }

    const info = await deps.getProcessInfo(state.pid).catch(() => null);
    if (looksLikeOpenCodeServe(info)) {
      const didKill = await invokeKillPidBestEffort(deps.killPid, state.pid);
      await deps.removeState().catch(() => {});
      return { didKill };
    }

    await deps.removeState().catch(() => {});
    return { didKill: false };
  });
}

async function probeOpenCodeHealthBestEffort(baseUrl: string): Promise<boolean> {
  if (!isLoopbackManagedOpenCodeBaseUrl(baseUrl)) return false;
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

async function killPidBestEffort(pid: number): Promise<boolean> {
  return await terminateManagedOpenCodeServerPidBestEffort(pid);
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
    isPidAlive: isOpenCodeServerPidAlive,
    probeHealth: async (baseUrl) => await probeOpenCodeHealthBestEffort(baseUrl),
    getProcessInfo: async (pid) => await getProcessInfoBestEffort(pid),
    killPid: killPidBestEffort,
  }).then(() => {}).catch(() => {});
}
