import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createServerUrlComparableKey } from '@happier-dev/protocol';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { resolveDaemonStartupSourceServiceManagedState } from '@/daemon/ownership/daemonOwnershipMetadata';
import { DaemonLocallyPersistedStateSchema, readSettings } from '@/persistence';
import { logger } from '@/ui/logger';
import { resolveDaemonServiceInstallationSnapshotFromEnv } from '@/daemon/service/cli';
import { resolveMachineIdForServerFromSettings } from '@/daemon/resolveMachineIdForServerFromSettings';
import { resolveDaemonStateCandidatePaths } from '@/daemon/ownership/daemonOwnershipPaths';
import { buildDaemonControlHttpHeaders } from '@/daemon/controlHttp';
import { DaemonStopIncompleteError } from '@/daemon/controlClient';
import { isPidAliveBySignal } from '@/daemon/processRunState';
import type { DaemonStartupSource } from '@/daemon/ownership/daemonOwnershipMetadata';
type NormalizedDaemonState = Readonly<{
  pid: number;
  httpPort: number;
  startedAt: number;
  startedWithCliVersion: string;
  controlToken?: string;
  startupSource?: DaemonStartupSource;
  serviceLabel?: string;
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
      startupSource: typeof data.startupSource === 'string' ? data.startupSource : undefined,
      serviceLabel: typeof data.serviceLabel === 'string' ? data.serviceLabel : undefined,
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

async function resolveDaemonStateForServer(serverId: string): Promise<Readonly<{
  daemonStatePath: string;
  state: NormalizedDaemonState | null;
}>> {
  const candidatePaths = resolveDaemonStateCandidatePaths({
    serverDir: join(configuration.serversDir, serverId),
    preferredRing: configuration.publicReleaseRing,
  });
  let firstReadableState: Readonly<{ daemonStatePath: string; state: NormalizedDaemonState }> | null = null;

  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) {
      continue;
    }
    const state = await readDaemonStateFromPath(candidatePath);
    if (!state) {
      continue;
    }
    if (isPidAliveBySignal(state.pid)) {
      return {
        daemonStatePath: candidatePath,
        state,
      };
    }
    if (!firstReadableState) {
      firstReadableState = {
        daemonStatePath: candidatePath,
        state,
      };
    }
  }

  return firstReadableState ?? {
    daemonStatePath: candidatePaths[0]!,
    state: null,
  };
}

/**
 * The servers directory, rather than the mutable profile registry, is the
 * durable inventory of daemon publications. A removed profile can still own a
 * live daemon, and each release-ring basename is independently reachable
 * until its owner retires it.
 */
async function listDaemonStatePathsForStop(): Promise<readonly string[]> {
  try {
    const entries = await readdir(configuration.serversDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .flatMap((serverId) => resolveDaemonStateCandidatePaths({
        serverDir: join(configuration.serversDir, serverId),
        preferredRing: configuration.publicReleaseRing,
      }))
      .filter((path) => existsSync(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return [];
    throw error;
  }
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

async function resolveServiceInstallationForServer(serverId: string, serverUrl: string): Promise<Readonly<{ installed: boolean }>> {
  try {
    const snapshot = await resolveDaemonServiceInstallationSnapshotFromEnv({
      processEnv: {
        ...process.env,
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: serverId,
        HAPPIER_DAEMON_SERVICE_SERVER_URL: serverUrl,
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
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
    const { daemonStatePath, state } = await resolveDaemonStateForServer(serverId);
    const running = state ? isPidAliveBySignal(state.pid) : false;
    const serviceManagedDaemonRunning = running
      && resolveDaemonStartupSourceServiceManagedState(state?.startupSource) === true;
    const staleStateFile = Boolean(state && !running);
    const comparableKey = resolveComparableKey(serverUrl);
    const serviceInstallation = await resolveServiceInstallationForServer(serverId, serverUrl);
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
        running: serviceInstallation.installed && serviceManagedDaemonRunning,
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
    if (!isPidAliveBySignal(pid)) return true;
    await new Promise((r) => setTimeout(r, 75));
  }
  return !isPidAliveBySignal(pid);
}

async function stopDaemonViaHttpBestEffort(state: NormalizedDaemonState, opts: StopDaemonOptions): Promise<boolean> {
  try {
    const rawTimeout = process.env.HAPPIER_DAEMON_HTTP_TIMEOUT;
    const parsedTimeout = typeof rawTimeout === 'string' ? Number.parseInt(rawTimeout, 10) : Number.NaN;
    const timeout = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 10_000;
    const headers = buildDaemonControlHttpHeaders(state.controlToken);

    const response = await fetch(`http://127.0.0.1:${state.httpPort}/stop`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...(opts.stopSessions ? { stopSessions: true } : {}),
      }),
      signal: AbortSignal.timeout(timeout),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function assertNoLiveDaemonPublicationAfterStop(): Promise<void> {
  let statePaths: readonly string[];
  try {
    // Re-enumerate through the same durable state owner after every originally
    // observed daemon has stopped. A successor can replace a predecessor's
    // state publication during its graceful shutdown, and this observer must
    // fail closed rather than let logout remove that successor's home.
    statePaths = await listDaemonStatePathsForStop();
  } catch (error) {
    logger.debug('[multi-daemon] failed to re-enumerate daemon stop targets', error);
    throw new DaemonStopIncompleteError({ reason: 'control_client_failure' });
  }

  for (const statePath of statePaths) {
    const state = await readDaemonStateFromPath(statePath);
    if (!state) {
      throw new DaemonStopIncompleteError({ reason: 'control_client_failure' });
    }
    if (isPidAliveBySignal(state.pid)) {
      throw new DaemonStopIncompleteError({
        reason: 'graceful_stop_unconfirmed',
        pid: state.pid,
      });
    }
  }
}

/**
 * Best-effort stop for every published daemon state in the current home.
 * Safety: does not force-kill processes; uses the daemon control HTTP endpoint.
 * State and lifecycle-lock cleanup remain owned by the exact daemon lock holder or the next
 * CLI lock acquisition; this cross-profile observer must not delete a successor publication.
 */
export async function stopAllDaemonsBestEffort(opts: StopDaemonOptions = {}): Promise<void> {
  let statePaths: readonly string[];
  try {
    statePaths = await listDaemonStatePathsForStop();
  } catch (error) {
    logger.debug('[multi-daemon] failed to enumerate daemon stop targets', error);
    throw new DaemonStopIncompleteError({ reason: 'control_client_failure' });
  }
  let incomplete: DaemonStopIncompleteError | null = null;
  for (const statePath of statePaths) {
    const state = await readDaemonStateFromPath(statePath);
    if (!state) {
      incomplete ??= new DaemonStopIncompleteError({ reason: 'control_client_failure' });
      continue;
    }

    if (!isPidAliveBySignal(state.pid)) continue;

    const stopped = await stopDaemonViaHttpBestEffort(state, opts);
    if (!stopped) {
      incomplete ??= new DaemonStopIncompleteError({
        reason: 'control_client_failure',
        pid: state.pid,
      });
      continue;
    }

    if (!await waitForProcessDeath(state.pid, 2500)) {
      incomplete ??= new DaemonStopIncompleteError({
        reason: 'graceful_stop_unconfirmed',
        pid: state.pid,
      });
    }
  }
  if (incomplete) throw incomplete;
  await assertNoLiveDaemonPublicationAfterStop();
}
