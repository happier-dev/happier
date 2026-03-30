import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { createServerUrlComparableKey } from '@happier-dev/protocol';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { DaemonLocallyPersistedStateSchema, readSettings } from '@/persistence';
import { logger } from '@/ui/logger';
import { resolveDaemonServiceInstallationSnapshotFromEnv } from '@/daemon/service/cli';
import { resolveDaemonStateBasenameForRing } from '@/cli/runtime/publicReleaseChannel';
import { resolveMachineIdForServerFromSettings } from '@/daemon/resolveMachineIdForServerFromSettings';
type NormalizedDaemonState = Readonly<{
  pid: number;
  httpPort: number;
  startedAt: number;
  startedWithCliVersion: string;
  controlToken?: string;
}>;

type StopDaemonOptions = Readonly<{
  stopSessions?: boolean;
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
  return join(configuration.serversDir, serverId, resolveDaemonStateBasenameForRing(configuration.publicReleaseRing));
}

export type DaemonStatusEntry = Readonly<{
  serverId: string;
  name: string;
  serverUrl: string;
  comparableKey: string | null;
  daemonStatePath: string;
  auth?: Readonly<{
    authenticated: boolean;
    needsAuth: boolean;
    machineRegistered: boolean;
    machineId: string | null;
    accountId: string | null;
  }>;
  drift?: Readonly<{
    activeComparableKey: string | null;
    matchesActiveRelay: boolean | null;
  }>;
  service: Readonly<{
    installed: boolean;
    running?: boolean;
    platform?: string;
    installedPath?: string;
  }>;
  daemon: Readonly<{
    pid: number | null;
    httpPort: number | null;
    running: boolean;
    staleStateFile: boolean;
  }>;
}>;

function resolveComparableKey(rawUrl: string): string | null {
  const value = String(rawUrl ?? '').trim();
  if (!value) {
    return null;
  }
  try {
    return createServerUrlComparableKey(value);
  } catch {
    return null;
  }
}

function resolveCredentialPathCandidates(serverId: string): Readonly<{ primaryPath: string; legacyPath: string }> {
  const primaryPath = join(configuration.serversDir, serverId, 'access.key');
  const legacyPath = join(configuration.happyHomeDir, 'access.key');
  return { primaryPath, legacyPath };
}

async function readAuthTokenForServerId(serverId: string): Promise<string | null> {
  const { primaryPath, legacyPath } = resolveCredentialPathCandidates(serverId);
  const canUseLegacy = serverId === 'cloud' && existsSync(legacyPath) && !existsSync(primaryPath);

  const path = existsSync(primaryPath) ? primaryPath : canUseLegacy ? legacyPath : null;
  if (!path) return null;

  try {
    const raw = JSON.parse(await readFile(path, 'utf-8'));
    const token = typeof raw?.token === 'string' ? raw.token.trim() : '';
    return token ? token : null;
  } catch {
    return null;
  }
}

function resolveAccountIdFromToken(token: string | null): string | null {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!value) return null;
  try {
    const payload = decodeJwtPayload(value);
    return typeof payload?.sub === 'string' && payload.sub.trim() ? payload.sub.trim() : null;
  } catch {
    return null;
  }
}

function resolveServiceInstallationForServer(serverId: string, serverUrl: string): Readonly<{ installed: boolean }> {
  try {
    const snapshot = resolveDaemonServiceInstallationSnapshotFromEnv({
      processEnv: {
        ...process.env,
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: serverId,
        HAPPIER_DAEMON_SERVICE_SERVER_URL: serverUrl,
      },
    });
    return { installed: snapshot.installed };
  } catch {
    return { installed: false };
  }
}

export async function listDaemonStatusesForAllKnownServers(): Promise<DaemonStatusEntry[]> {
  const settings = await readSettings();
  const persistedServers = settings.servers ?? {};
  const servers: Record<string, { name?: string; serverUrl?: string }> = { ...persistedServers };
  const activeServerId = (configuration.activeServerId ?? '').toString().trim();
  if (activeServerId && !servers[activeServerId]) {
    servers[activeServerId] = {
      name: 'Active Server (current scope)',
      serverUrl: configuration.serverUrl,
    };
  }
  const serverIds = Object.keys(servers);
  const results: DaemonStatusEntry[] = [];
  const activeComparableKey = resolveComparableKey(configuration.publicServerUrl || configuration.serverUrl);

  for (const serverId of serverIds) {
    const profile = servers[serverId];
    const name = profile?.name ?? serverId;
    const serverUrl =
      (profile?.serverUrl ?? '').toString().trim() ||
      (serverId === activeServerId ? (configuration.serverUrl ?? '').toString().trim() : '');
    const daemonStatePath = resolveDaemonStatePath(serverId);
    const state = await readDaemonStateFromPath(daemonStatePath);
    const running = state ? isPidAlive(state.pid) : false;
    const staleStateFile = Boolean(state && !running);
    const comparableKey = resolveComparableKey(serverUrl);
    const serviceInstallation = resolveServiceInstallationForServer(serverId, serverUrl);
    const token = await readAuthTokenForServerId(serverId);
    const accountId = resolveAccountIdFromToken(token);
    const machineId = resolveMachineIdForServerFromSettings(settings, serverId, accountId);
    const authenticated = token != null;
    const machineRegistered = machineId != null;
    const needsAuth = !authenticated || !machineRegistered;
    const matchesActiveRelay = activeComparableKey && comparableKey ? activeComparableKey === comparableKey : null;
    results.push({
      serverId,
      name,
      serverUrl,
      comparableKey,
      daemonStatePath,
      auth: {
        authenticated,
        needsAuth,
        machineRegistered,
        machineId,
        accountId,
      },
      drift: {
        activeComparableKey,
        matchesActiveRelay,
      },
      service: {
        ...serviceInstallation,
        running: serviceInstallation.installed && running,
      },
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

async function stopDaemonViaHttpBestEffort(state: NormalizedDaemonState, opts: StopDaemonOptions): Promise<boolean> {
  try {
    const rawTimeout = process.env.HAPPIER_DAEMON_HTTP_TIMEOUT;
    const parsedTimeout = typeof rawTimeout === 'string' ? Number.parseInt(rawTimeout, 10) : Number.NaN;
    const timeout = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 10_000;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (state.controlToken) headers['x-happier-daemon-token'] = state.controlToken;

    const response = await fetch(`http://127.0.0.1:${state.httpPort}/stop`, {
      method: 'POST',
      headers,
      body: JSON.stringify(opts.stopSessions ? { stopSessions: true } : {}),
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
export async function stopAllDaemonsBestEffort(opts: StopDaemonOptions = {}): Promise<void> {
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

    const stopped = await stopDaemonViaHttpBestEffort(state, opts);
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
