import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import { DaemonLocallyPersistedStateSchema, readSettings } from '@/persistence';
import { logger } from '@/ui/logger';

type NormalizedDaemonState = Readonly<{
  pid: number;
  httpPort: number;
  startedAt: number;
  startedWithCliVersion: string;
  controlToken?: string;
}>;

function parseDaemonStateFromJson(value: unknown): NormalizedDaemonState | null {
  const parsed = DaemonLocallyPersistedStateSchema.safeParse(value);
  if (!parsed.success) return null;
  const data = parsed.data as any;
  if (typeof data.pid !== 'number' || typeof data.httpPort !== 'number') return null;
  if ('startedAt' in data) {
    return {
      pid: data.pid,
      httpPort: data.httpPort,
      startedAt: data.startedAt,
      startedWithCliVersion: data.startedWithCliVersion,
      controlToken: typeof data.controlToken === 'string' ? data.controlToken : undefined,
    };
  }
  const startedAt = Date.parse(String(data.startTime ?? ''));
  return {
    pid: data.pid,
    httpPort: data.httpPort,
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    startedWithCliVersion: data.startedWithCliVersion,
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readDaemonStateFromPath(path: string): Promise<NormalizedDaemonState | null> {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8'));
    return parseDaemonStateFromJson(raw);
  } catch (error) {
    logger.debug(`[multi-daemon] failed to read daemon state: ${path}`, error);
    return null;
  }
}

function resolveDaemonStatePath(serverId: string): string {
  return join(configuration.serversDir, serverId, 'daemon.state.json');
}

export type DaemonStatusEntry = Readonly<{
  serverId: string;
  name: string;
  serverUrl: string;
  daemonStatePath: string;
  daemon: Readonly<{
    pid: number | null;
    httpPort: number | null;
    running: boolean;
    staleStateFile: boolean;
  }>;
}>;

export async function listDaemonStatusesForAllKnownServers(): Promise<DaemonStatusEntry[]> {
  const settings = await readSettings();
  const servers = settings.servers ?? {};
  const serverIds = Object.keys(servers);
  const results: DaemonStatusEntry[] = [];

  for (const serverId of serverIds) {
    const profile = servers[serverId];
    const name = profile?.name ?? serverId;
    const serverUrl = profile?.serverUrl ?? '';
    const daemonStatePath = resolveDaemonStatePath(serverId);
    const state = await readDaemonStateFromPath(daemonStatePath);
    const running = state ? isPidAlive(state.pid) : false;
    const staleStateFile = Boolean(state && !running);
    results.push({
      serverId,
      name,
      serverUrl,
      daemonStatePath,
      daemon: {
        pid: state?.pid ?? null,
        httpPort: state?.httpPort ?? null,
        running,
        staleStateFile,
      },
    });
  }

  return results;
}

async function waitForProcessDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 75));
  }
  return !isPidAlive(pid);
}

async function stopDaemonViaHttpBestEffort(state: NormalizedDaemonState): Promise<boolean> {
  try {
    const rawTimeout = process.env.HAPPIER_DAEMON_HTTP_TIMEOUT;
    const parsedTimeout = typeof rawTimeout === 'string' ? Number.parseInt(rawTimeout, 10) : Number.NaN;
    const timeout = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 10_000;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (state.controlToken) headers['x-happier-daemon-token'] = state.controlToken;

    const response = await fetch(`http://127.0.0.1:${state.httpPort}/stop`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(timeout),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Best-effort stop for all daemons found in known server profiles.
 * Safety: does not force-kill processes; uses the daemon control HTTP endpoint.
 * Also clears stale state files when the PID is not alive.
 */
export async function stopAllDaemonsBestEffort(): Promise<void> {
  const statuses = await listDaemonStatusesForAllKnownServers();
  for (const entry of statuses) {
    const statePath = entry.daemonStatePath;
    const state = await readDaemonStateFromPath(statePath);
    if (!state) continue;

    if (!isPidAlive(state.pid)) {
      try {
        await unlink(statePath);
      } catch {
        // ignore
      }
      continue;
    }

    const stopped = await stopDaemonViaHttpBestEffort(state);
    if (!stopped) continue;

    const exited = await waitForProcessDeath(state.pid, 2500);
    if (!exited) continue;

    try {
      await unlink(statePath);
    } catch {
      // ignore
    }
  }
}
