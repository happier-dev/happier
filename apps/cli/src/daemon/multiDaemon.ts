import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createServerUrlComparableKey } from '@happier-dev/protocol/server/urls/serverUrlComparableKey';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import {
  resolveActiveServerAuthReadiness,
  type CredentialReadinessState,
  type MachineRegistrationState,
} from '@/auth/resolveActiveServerAuthReadiness';
import { configuration } from '@/configuration';
import { resolveDaemonStartupSourceServiceManagedState } from '@/daemon/ownership/daemonOwnershipMetadata';
import { DaemonLocallyPersistedStateSchema, inspectDaemonLockOwner, readSettings } from '@/persistence';
import { logger } from '@/ui/logger';
import { resolveDaemonServiceInstallationSnapshotFromEnv } from '@/daemon/service/cli';
import { resolveMachineIdForServerFromSettings } from '@/daemon/resolveMachineIdForServerFromSettings';
import { resolveDaemonStateCandidatePaths } from '@/daemon/ownership/daemonOwnershipPaths';
import { buildDaemonControlHttpHeaders } from '@/daemon/controlHttp';
import { DaemonStopIncompleteError, inspectPublishedDaemonPresence, observePublishedDaemonOwner, type PublishedDaemonOwnerObservation } from '@/daemon/controlClient';
import { isLoopbackHttpServerUrl } from '@/server/serverUrlClassification';
import { sanitizeServerIdForFilesystem } from '@/server/serverId';
import { isPidPresent } from '@happier-dev/cli-common/process';
import { selectServingDaemonService } from '@happier-dev/cli-common/systemTasks';
import type { DaemonStartupSource } from '@/daemon/ownership/daemonOwnershipMetadata';
type NormalizedDaemonState = Readonly<{
  pid: number;
  httpPort: number;
  startedAt: number;
  startedWithCliVersion: string;
  controlToken?: string;
  startupSource?: DaemonStartupSource;
  serviceLabel?: string;
  machineId?: string;
}>;

type StopDaemonOptions = Readonly<{
  stopSessions?: boolean;
}>;

function parseDaemonStateFromJson(value: unknown): NormalizedDaemonState | null {
  const parsed = DaemonLocallyPersistedStateSchema.safeParse(value);
  if (!parsed.success) return null;
  const data = parsed.data;
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
      machineId: typeof data.machineId === 'string' ? data.machineId.trim() || undefined : undefined,
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
  presence: Awaited<ReturnType<typeof inspectPublishedDaemonPresence>> | null;
}>> {
  const candidatePaths = resolveDaemonStateCandidatePaths({
    serverDir: join(configuration.serversDir, serverId),
    preferredRing: configuration.publicReleaseRing,
  });
  let firstReadableState: Readonly<{ daemonStatePath: string; state: NormalizedDaemonState; presence: Awaited<ReturnType<typeof inspectPublishedDaemonPresence>> }> | null = null;

  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) {
      continue;
    }
    const state = await readDaemonStateFromPath(candidatePath);
    if (!state) {
      continue;
    }
    const presence = await inspectPublishedDaemonPresence(state);
    if (presence.status === 'running') {
      return {
        daemonStatePath: candidatePath,
        state,
        presence,
      };
    }
    if (!firstReadableState || (firstReadableState.presence.status === 'not_running' && presence.status === 'unverified')) {
      firstReadableState = {
        daemonStatePath: candidatePath,
        state,
        presence,
      };
    }
  }

  return firstReadableState ?? {
    daemonStatePath: candidatePaths[0]!,
    state: null,
    presence: null,
  };
}

/** The daemon state in `serverId`'s lifecycle directory and whether its process is alive; `null` when none. */
export async function readDaemonStateForServerId(serverId: string): Promise<Readonly<{
  running: boolean;
  state: NormalizedDaemonState;
}> | null> {
  const { state } = await resolveDaemonStateForServer(serverId);
  return state ? { running: isPidPresent(state.pid), state } : null;
}

/**
 * Resolves one profile-scoped daemon control publication without consulting
 * the process-global lifecycle scope. Long-lived explicit-Home consumers use
 * this target to prevent a stack-scoped ambient override from selecting a
 * different Home's daemon.
 */
export async function resolveLiveDaemonControlTargetForServer(serverId: string): Promise<Readonly<{
  pid: number;
  httpPort: number;
  controlToken?: string;
}> | null> {
  const normalizedServerId = String(serverId ?? '').trim();
  if (!normalizedServerId) return null;
  const { state } = await resolveDaemonStateForServer(normalizedServerId);
  if (!state || !isPidPresent(state.pid)) return null;
  return {
    pid: state.pid,
    httpPort: state.httpPort,
    ...(state.controlToken ? { controlToken: state.controlToken } : {}),
  };
}

/**
 * The servers directory, rather than the mutable profile registry, is the
 * durable inventory of daemon publications. A removed profile can still own a
 * live daemon, and each release-ring basename is independently reachable
 * until its owner retires it.
 */
async function listPublishedDaemonStatePaths({ includeStartupLocks = false }: Readonly<{ includeStartupLocks?: boolean }> = {}): Promise<readonly string[]> {
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
      .filter((path) => existsSync(path) || (includeStartupLocks && existsSync(`${path}.lock`)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return [];
    throw error;
  }
}

function readLoopbackHttpEndpointPort(endpoint: string): number | null {
  if (!isLoopbackHttpServerUrl(endpoint)) return null;
  try {
    const url = new URL(endpoint);
    const port = url.port ? Number(url.port) : 80;
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Resolves a direct daemon Action ingress only when its loopback endpoint is
 * published by one live daemon in this CLI home. A loopback URL alone is not
 * enough: local Account servers retain their explicit-target behavior.
 */
export async function resolveLiveDaemonExternalActionEndpoint(
  endpoint: string,
): Promise<Readonly<{ machineId: string }> | null> {
  const port = readLoopbackHttpEndpointPort(endpoint);
  if (port === null) return null;

  let statePaths: readonly string[];
  try {
    statePaths = await listPublishedDaemonStatePaths();
  } catch (error) {
    logger.debug('[multi-daemon] failed to enumerate daemon Action endpoints', error);
    return null;
  }

  const machineIds = new Set<string>();
  for (const statePath of statePaths) {
    const state = await readDaemonStateFromPath(statePath);
    if (!state || state.httpPort !== port || (await inspectPublishedDaemonPresence(state)).status !== 'running') continue;
    if (state.machineId) machineIds.add(state.machineId);
  }
  return machineIds.size === 1 ? { machineId: [...machineIds][0]! } : null;
}

export type DaemonStatusEntry = Readonly<{
  serverId: string;
  name: string;
  serverUrl: string;
  comparableKey: string | null;
  daemonStatePath: string;
  auth?: Readonly<{
    authenticated: boolean;
    credentialState: CredentialReadinessState;
    needsAuth: boolean;
    machineRegistered: boolean;
    machineRegistrationState: MachineRegistrationState;
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
    presence: Awaited<ReturnType<typeof inspectPublishedDaemonPresence>>['status'];
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

type ServerServiceInstallation = Readonly<{ installed: boolean; platform?: string; installedPath?: string }>;

function resolveServiceInstallationSnapshot(
  params: Readonly<{ serverId: string; serverUrl: string; targetMode: 'pinned' | 'default-following' }>,
): ServerServiceInstallation {
  const snapshot = resolveDaemonServiceInstallationSnapshotFromEnv({
    processEnv: {
      ...process.env,
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: params.serverId,
      HAPPIER_DAEMON_SERVICE_SERVER_URL: params.serverUrl,
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: params.targetMode,
    },
  });
  return { installed: snapshot.installed, platform: snapshot.platform, installedPath: snapshot.installedPath };
}

/**
 * The background service that serves `serverId` on this computer: its own pinned service, else —
 * for the server this home's persisted selection names — the default-following service, which
 * follows that selection. Any other server has no service unless it has a pinned one.
 */
function resolveServiceInstallationForServer(
  params: Readonly<{ serverId: string; serverUrl: string; persistedActiveServerId: string }>,
): ServerServiceInstallation {
  const pinned = resolveServiceInstallationSnapshot({ ...params, targetMode: 'pinned' });
  const serving = selectServingDaemonService([
    ...(pinned.installed ? [{ targetMode: 'pinned' as const }] : []),
    ...(params.serverId === params.persistedActiveServerId ? [{ targetMode: 'default-following' as const }] : []),
  ]);
  return serving?.targetMode === 'default-following'
    ? resolveServiceInstallationSnapshot({ ...params, targetMode: 'default-following' })
    : pinned;
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
  // The default-following service follows the persisted selection, never this invocation's `--server`.
  const persistedActiveServerId = sanitizeServerIdForFilesystem(settings.activeServerId ?? 'cloud', 'cloud');
  const activeReadiness = activeServerId
    ? await resolveActiveServerAuthReadiness().catch(() => null)
    : null;

  for (const serverId of serverIds) {
    const profile = servers[serverId];
    const name = profile?.name ?? serverId;
    const serverUrl =
      (profile?.serverUrl ?? '').toString().trim() ||
      (serverId === activeServerId ? (configuration.serverUrl ?? '').toString().trim() : '');
    const { daemonStatePath, state, presence } = await resolveDaemonStateForServer(serverId);
    const running = presence?.status === 'running';
    const serviceManagedDaemonRunning = running
      && resolveDaemonStartupSourceServiceManagedState(state?.startupSource) === true;
    const staleStateFile = Boolean(state && presence?.status === 'not_running');
    const comparableKey = resolveComparableKey(serverUrl);
    const serviceInstallation = resolveServiceInstallationForServer({ serverId, serverUrl, persistedActiveServerId });
    const token = await readAuthTokenForServerId(serverId);
    const accountId = token ? readAccountIdFromToken(token) : null;
    const machineId = resolveMachineIdForServerFromSettings(settings, serverId, accountId);
    const credentialState: CredentialReadinessState = token == null
      ? 'missing'
      : serverId === activeServerId && activeReadiness
        ? activeReadiness.credentialState
        : 'unknown';
    const machineRegistrationState: MachineRegistrationState = machineId == null
      ? 'no-local-id'
      : settings.machineIdConfirmedByServerByServerId?.[serverId] === true
        ? 'server-confirmed'
        : 'local-only';
    const authenticated = credentialState === 'valid';
    const machineRegistered = machineRegistrationState === 'server-confirmed';
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
        credentialState,
        needsAuth,
        machineRegistered,
        machineRegistrationState,
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
        presence: presence?.status ?? 'not_running',
        staleStateFile,
      },
    });
  }

  return results;
}

async function waitForProcessDeath(observation: PublishedDaemonOwnerObservation, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!await observation.isPresent()) return true;
    await new Promise((r) => setTimeout(r, 75));
  }
  return !await observation.isPresent();
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

async function assertNoLiveDaemonPublicationAfterStop(hiddenPublicationPaths: ReadonlySet<string>): Promise<void> {
  let statePaths: readonly string[];
  try {
    // Re-enumerate through the same durable state owner after every originally
    // observed daemon has stopped. A successor can replace a predecessor's
    // state publication during its graceful shutdown, and this observer must
    // fail closed rather than let logout remove that successor's home.
    statePaths = await listPublishedDaemonStatePaths({ includeStartupLocks: true });
  } catch (error) {
    logger.debug('[multi-daemon] failed to re-enumerate daemon stop targets', error);
    throw new DaemonStopIncompleteError({ reason: 'control_client_failure' });
  }

  for (const statePath of statePaths) {
    const state = await readDaemonStateFromPath(statePath);
    if (!state) {
      if (existsSync(statePath)) throw new DaemonStopIncompleteError({ reason: 'control_client_failure' });
      const owner = await inspectDaemonLockOwner(`${statePath}.lock`, { unobservablePidIsUnverified: hiddenPublicationPaths.has(statePath) });
      if (owner.status === 'starting') {
        throw new DaemonStopIncompleteError({ reason: 'startup_in_progress', pid: owner.pid });
      }
      continue;
    }
    if (await observePublishedDaemonOwner(state, `${statePath}.lock`, { unobservablePidIsUnverified: hiddenPublicationPaths.has(statePath) }).isPresent()) {
      throw new DaemonStopIncompleteError({
        reason: 'graceful_stop_unconfirmed',
        pid: state.pid,
      });
    }
  }
}

export type DaemonsStopResult = Readonly<
  | { status: 'not_running' }
  | { status: 'stopped'; stoppedCount: number }
>;

/**
 * Best-effort stop for every durable daemon publication and startup lock in the current home.
 * Safety: does not force-kill processes; uses the daemon control HTTP endpoint.
 * State and lifecycle-lock cleanup remain owned by the exact daemon lock holder or the next
 * CLI lock acquisition; this cross-profile observer must not delete a successor publication.
 */
export async function stopAllDaemonsBestEffort(opts: StopDaemonOptions = {}): Promise<DaemonsStopResult> {
  let statePaths: readonly string[];
  try {
    statePaths = await listPublishedDaemonStatePaths({ includeStartupLocks: true });
  } catch (error) {
    logger.debug('[multi-daemon] failed to enumerate daemon stop targets', error);
    throw new DaemonStopIncompleteError({ reason: 'control_client_failure' });
  }
  let incomplete: DaemonStopIncompleteError | null = null;
  let stoppedCount = 0;
  const hiddenPublicationPaths = new Set<string>();
  for (const statePath of statePaths) {
    const state = await readDaemonStateFromPath(statePath);
    if (!state) {
      if (existsSync(statePath)) {
        incomplete ??= new DaemonStopIncompleteError({ reason: 'control_client_failure' });
        continue;
      }
      const owner = await inspectDaemonLockOwner(`${statePath}.lock`);
      if (owner.status === 'starting') {
        incomplete ??= new DaemonStopIncompleteError({ reason: 'startup_in_progress', pid: owner.pid });
      }
      continue;
    }

    const observation = observePublishedDaemonOwner(state, `${statePath}.lock`);
    if (!await observation.isPresent()) continue;

    const stopped = await stopDaemonViaHttpBestEffort(state, opts);
    if (!stopped) {
      incomplete ??= new DaemonStopIncompleteError({
        reason: 'control_client_failure',
        pid: state.pid,
      });
      continue;
    }

    observation.acknowledgeStop();
    if (!await waitForProcessDeath(observation, 2500)) {
      incomplete ??= new DaemonStopIncompleteError({
        reason: 'graceful_stop_unconfirmed',
        pid: state.pid,
      });
      continue;
    }
    stoppedCount += 1;
    if (observation.hasHiddenPid()) hiddenPublicationPaths.add(statePath);
  }
  if (incomplete) throw incomplete;
  await assertNoLiveDaemonPublicationAfterStop(hiddenPublicationPaths);
  return stoppedCount > 0 ? { status: 'stopped', stoppedCount } : { status: 'not_running' };
}
