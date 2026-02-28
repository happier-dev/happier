import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

  const resolved = await resolveSharedManagedOpenCodeServerBaseUrl({
    withLock: async (fn) => await withOpenCodeServerFileLock(lockFile, fn),
    readState: async () => await readStateFile(statePath),
    writeState: async (state) => await writeStateFile(statePath, state),
    isPidAlive,
    probeHealth: params.probeHealth,
    startServer: async () => {
      const started = await startManagedOpenCodeServer({});
      return { baseUrl: started.baseUrl, pid: started.pid };
    },
  });

  return resolved.baseUrl;
}
