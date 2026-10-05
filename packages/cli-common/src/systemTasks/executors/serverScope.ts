import { createRelayUrlComparableKeySafe } from '@happier-dev/protocol/server/relayDrift';
import { resolvePublicReleaseRingIdForLabel, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { resolveHappyHomeDirFromEnvironment } from '../../agents/resolveHappyHomeDir.js';
import { happierHomeDirsMatch, normalizeHomeDir } from '../../happierRuntime/daemonInstallConflict.js';
import { discoverHappierServices } from '../../happierRuntime/services/discoverHappierServices.js';
import type { HappierService } from '../../happierRuntime/types.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';
import type { HappierJsonExecutor } from './happierJsonExecutor.js';

/**
 * Which saved CLI server profile an explicit Home target is, and which server the terminal follows.
 *
 * 0.3 daemons are per-server: `happier --server <id> …` scopes one invocation to a saved profile
 * without touching the terminal's active selection. An explicitly selected Home (the desktop's
 * Personal Home) therefore gets its own pinned background service instead of repointing the
 * user's default-following one (R10 D3).
 */
export type LocalServerProfileScope = Readonly<{
  /** The saved profile that is this Home, or `null` when none is saved yet. */
  serverId: string | null;
  /** The server the terminal (and a default-following service) currently follows. */
  activeServerId: string | null;
  /** The installed service selected from this home's inventory; absent services stay null. */
  selectedService: HappierService | null;
  /** Which installed service serves the Home, selected by the shared pin-first rule. */
  targetMode: HappierServerScope['targetMode'];
  /**
   * `desktop` when setup's install marks the Home's pinned service as the desktop's (R15): it
   * creates that service, or the desktop already manages it. `null` when a service the user
   * installed serves the Home (it stays theirs) or the default-following service does.
   */
  managedBy?: 'desktop' | null;
}>;

/** An explicit Home: its URLs and, when known, its server identity (RV-11). */
export type LocalServerProfileTarget = Readonly<{
  serverUrl: string;
  localServerUrl?: string | null;
  serverIdentityId?: string | null;
}>;

export type HappierServerScope = Readonly<{
  serverId: string;
  targetMode: 'pinned' | 'default-following';
  /**
   * Ask the CLI to mark this pinned service as the desktop's (`HAPPIER_DAEMON_SERVICE_MANAGED_BY`;
   * honored only by `service install`, and kept by every later rewrite).
   */
  managedBy?: 'desktop' | null;
}>;

type ServerProfileSummary = Readonly<{
  id: string;
  serverUrl: string;
  localServerUrl: string | null;
  /** The Home identity the CLI recorded for this profile; absent until its daemon observed one. */
  homeServerIdentityId: string | null;
}>;

function readProfiles(parsed: unknown): Readonly<{ activeServerId: string | null; profiles: readonly ServerProfileSummary[] }> {
  const data = parsed && typeof parsed === 'object'
    ? (parsed as { data?: { activeServerId?: unknown; profiles?: unknown } }).data
    : undefined;
  const activeServerId = typeof data?.activeServerId === 'string' && data.activeServerId.trim()
    ? data.activeServerId.trim()
    : null;
  const profiles = Array.isArray(data?.profiles)
    ? data.profiles.flatMap((entry): ServerProfileSummary[] => {
        const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
        const id = typeof record?.id === 'string' ? record.id.trim() : '';
        const serverUrl = typeof record?.serverUrl === 'string' ? record.serverUrl.trim() : '';
        if (!id || !serverUrl) return [];
        const localServerUrl = typeof record?.localServerUrl === 'string' && record.localServerUrl.trim()
          ? record.localServerUrl.trim()
          : null;
        const homeServerIdentityId = typeof record?.homeServerIdentityId === 'string' && record.homeServerIdentityId.trim()
          ? record.homeServerIdentityId.trim()
          : null;
        return [{ id, serverUrl, localServerUrl, homeServerIdentityId }];
      })
    : [];
  return { activeServerId, profiles };
}

/**
 * The one saved profile that is `target`. The CLI keeps identity-distinct profiles that share one
 * endpoint (a Personal Home erased and recreated at the same loopback URL), so the Home identity
 * decides when it is known: the profile carrying it, else the one profile that has none yet (its
 * daemon has not recorded one). A match that stays ambiguous is refused, never resolved by order.
 */
function selectTargetProfile(
  profiles: readonly ServerProfileSummary[],
  target: LocalServerProfileTarget,
): ServerProfileSummary | null {
  const targetKeys = new Set([createRelayUrlComparableKeySafe(target.serverUrl), createRelayUrlComparableKeySafe(target.localServerUrl)].filter(
    (key): key is string => key !== null,
  ));
  const urlMatches = profiles.filter((profile) => (
    targetKeys.has(createRelayUrlComparableKeySafe(profile.serverUrl) ?? '')
    || (profile.localServerUrl !== null && targetKeys.has(createRelayUrlComparableKeySafe(profile.localServerUrl) ?? ''))
  ));
  const identity = target.serverIdentityId?.trim() || null;
  const candidates = identity
    ? (() => {
        const exact = urlMatches.filter((profile) => profile.homeServerIdentityId === identity);
        return exact.length > 0 ? exact : urlMatches.filter((profile) => profile.homeServerIdentityId === null);
      })()
    : urlMatches;
  if (candidates.length > 1) {
    throw new SystemTaskExecutionError(
      'server_profile_ambiguous',
      `The Happier CLI has ${candidates.length} saved profiles for ${target.serverUrl} (${candidates.map((profile) => profile.id).join(', ')}), so it cannot tell which one is this Home.`,
    );
  }
  return candidates[0] ?? null;
}

export async function readCurrentHappierServices(): Promise<readonly HappierService[]> {
  return (await discoverHappierServices({ processEnv: process.env })).services;
}

/**
 * Read-only: resolves the saved profile for `target`, the terminal's active server
 * (`happier server list --json`), and which service serves it (the OS service inventory). Nothing
 * is written, so it may run before any consent.
 */
export async function readLocalServerProfileScope(
  executor: HappierJsonExecutor,
  target: LocalServerProfileTarget,
  deps: Readonly<{
    readServices?: () => Promise<readonly HappierService[]>;
    happierHomeDir?: string | null;
    releaseRing?: PublicReleaseRingId;
    /** Lifecycle controls require proven desktop ownership; setup may inspect user services. */
    requireAppManaged?: boolean;
  }> = {},
): Promise<LocalServerProfileScope> {
  const { activeServerId, profiles } = readProfiles(await executor.runHappierJson(['server', 'list', '--json']));
  const serverId = selectTargetProfile(profiles, target)?.id ?? null;
  if (serverId === null) {
    if (deps.requireAppManaged) {
      throw new SystemTaskExecutionError('daemon_service_not_installed', 'No installed background service serves this Home.');
    }
    return { serverId, activeServerId, targetMode: 'pinned', managedBy: 'desktop', selectedService: null };
  }
  const services = await (deps.readServices ?? readCurrentHappierServices)();
  const happierHomeDir = deps.happierHomeDir === undefined
    ? resolveHappyHomeDirFromEnvironment(process.env)
    : deps.happierHomeDir;
  const selectedService = selectServerScopeService({ serverId, activeServerId, services, happierHomeDir, releaseRing: deps.releaseRing });
  const targetMode = selectedService?.targetMode ?? 'pinned';
  if (deps.requireAppManaged) {
    if (!selectedService) {
      throw new SystemTaskExecutionError('daemon_service_not_installed', 'No installed background service serves this Home.');
    }
    if (selectedService.verification !== 'verified') {
      throw new SystemTaskExecutionError('service_ownership_unverified', `Background service ${selectedService.label} could not be verified and was left unchanged.`);
    }
    if (!isAppManagedDaemonService(selectedService)) {
      throw new SystemTaskExecutionError('service_user_owned', `Background service ${selectedService.label} is managed outside Happier and was left unchanged.`);
    }
  }
  return {
    serverId,
    activeServerId,
    targetMode,
    selectedService,
    managedBy: targetMode === 'pinned' && (!selectedService || isAppManagedDaemonService(selectedService)) ? 'desktop' : null,
  };
}

function selectServerScopeService(params: Readonly<{
  serverId: string | null;
  activeServerId: string | null;
  services: readonly HappierService[];
  happierHomeDir: string | null;
  releaseRing?: PublicReleaseRingId;
}>): HappierService | null {
  if (params.serverId === null) return null;
  return selectServingDaemonService(params.services.filter((service) =>
    isInstalledDaemonServiceOfHappierHomeAndRing(service, params)
    && (service.targetMode === 'default-following'
      ? params.activeServerId === params.serverId
      : service.instanceId === params.serverId)));
}

/** One serving rule for installed candidates of a relay: its pin wins, else its default. */
export function selectServingDaemonService<T extends Readonly<{ targetMode?: 'pinned' | 'default-following' | null }>>(
  candidates: readonly T[],
): T | null {
  return candidates.find((candidate) => candidate.targetMode !== 'default-following')
    ?? candidates.find((candidate) => candidate.targetMode === 'default-following')
    ?? null;
}

export function isInstalledDaemonServiceOfHappierHomeAndRing(
  service: HappierService,
  params: Readonly<{ happierHomeDir: string | null; releaseRing?: PublicReleaseRingId }>,
): boolean {
  if (service.serviceType !== 'daemon' || !service.installed) return false;
  if (!isDaemonServiceOfHappierHome(service, params.happierHomeDir)) return false;
  return params.releaseRing === undefined
    || (service.ring !== null && resolvePublicReleaseRingIdForLabel(service.ring) === params.releaseRing);
}

/** Default-following belongs to Desktop; a pin needs a verified desktop management marker. */
export function isAppManagedDaemonService(service: HappierService): boolean {
  return service.serviceType === 'daemon' && service.installed && service.verification === 'verified'
    && (service.targetMode === 'default-following' || service.managedBy === 'desktop');
}

export async function readAppManagedDaemonServices(params: Readonly<{
  happierHomeDir: string | null;
  releaseRing: PublicReleaseRingId;
  readServices?: () => Promise<readonly HappierService[]>;
}>): Promise<readonly HappierService[]> {
  return (await (params.readServices ?? readCurrentHappierServices)()).filter((service) =>
    isInstalledDaemonServiceOfHappierHomeAndRing(service, params) && isAppManagedDaemonService(service));
}

/** A verified daemon service of this Happier home (an unknown home dir matches any). */
export function isVerifiedDaemonServiceOfHappierHome(service: HappierService, happierHomeDir: string | null): boolean {
  return service.verification === 'verified' && isDaemonServiceOfHappierHome(service, happierHomeDir);
}

function isDaemonServiceOfHappierHome(service: HappierService, happierHomeDir: string | null): boolean {
  if (service.serviceType !== 'daemon') return false;
  const expected = normalizeHomeDir(happierHomeDir, service.platform);
  return expected === null || happierHomeDirsMatch(service.happierHomeDir, happierHomeDir, service.platform);
}

/**
 * The selectors an inherited environment can use to point the CLI at another server, profile or
 * daemon lifecycle directory (the CLI's `configuration` reads exactly these). A stack-launched app
 * carries its stack's pin in them; `--server <id>` replaces the first five, but the lifecycle scope
 * would still put this Home's daemon state and lock in the stack's directory (R13 a).
 */
const INHERITED_SERVER_SELECTOR_ENV_KEYS = [
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  // Stronger service selectors must not override the explicit Home/profile or chosen CLI.
  'HAPPIER_DAEMON_SERVICE_SERVER_URL',
  'HAPPIER_DAEMON_SERVICE_WEBAPP_URL',
  'HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL',
  'HAPPIER_DAEMON_SERVICE_CHANNEL',
  'HAPPIER_DAEMON_SERVICE_NODE_PATH',
  'HAPPIER_DAEMON_SERVICE_ENTRY_PATH',
  'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
  'HAPPIER_DAEMON_SERVICE_PLATFORM',
  'HAPPIER_DAEMON_SERVICE_UID',
  'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_MODE',
  'HAPPIER_DAEMON_SERVICE_SYSTEM_USER',
  'HAPPIER_DAEMON_SERVICE_BUNDLE_ID',
  // The desktop management marker: only a scope that asks for it carries it (R15).
  'HAPPIER_DAEMON_SERVICE_MANAGED_BY',
] as const;

/**
 * Scopes every invocation to one saved server profile (`--server <id>`, never persisted) and to
 * that profile's service shape (`HAPPIER_DAEMON_SERVICE_TARGET_MODE`), so `service …` and
 * `daemon status` address this Home's own service and daemon. It is the one context rule for an
 * explicit Home (R13 a): no inherited selector competes with the profile the command names.
 */
export function scopeHappierJsonExecutor(
  executor: HappierJsonExecutor,
  scope: HappierServerScope | HappierServiceFollowingScope,
  processEnv: NodeJS.ProcessEnv = process.env,
): HappierJsonExecutor {
  const scopedArgs = (args: readonly string[]) => (scope.serverId === null ? [...args] : ['--server', scope.serverId, ...args]);
  const scopedEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const next: NodeJS.ProcessEnv = { ...env, HAPPIER_DAEMON_SERVICE_TARGET_MODE: scope.targetMode };
    for (const key of INHERITED_SERVER_SELECTOR_ENV_KEYS) delete next[key];
    if (scope.targetMode === 'pinned' && 'managedBy' in scope && scope.managedBy === 'desktop') {
      next.HAPPIER_DAEMON_SERVICE_MANAGED_BY = 'desktop';
    }
    return next;
  };
  const scopedOpts = <T extends Readonly<{ env?: NodeJS.ProcessEnv }>>(opts: T | undefined): T => ({
    ...(opts ?? {}) as T,
    env: scopedEnv(opts?.env ?? processEnv),
  });
  return {
    runHappierText: async (args, opts) => await executor.runHappierText(scopedArgs(args), scopedOpts(opts)),
    runHappierJson: async (args, opts) => await executor.runHappierJson(scopedArgs(args), scopedOpts(opts)),
  };
}

/**
 * The default-following service's own scope: no `--server`, so it keeps following the server this
 * home's terminal selected — it is never repointed at a Home.
 */
export type HappierServiceFollowingScope = Readonly<{ serverId: null; targetMode: 'default-following' }>;

export type HappierHomeServiceConvergence = Readonly<{
  converged: readonly string[];
  failed: ReadonlyArray<Readonly<{ label: string; message: string }>>;
}>;

/**
 * R12 — one CLI per Happier home and ring. After the one-CLI answer changes, every other verified
 * daemon service of this home and ring (the terminal's default-following service, other Homes'
 * pinned services) is reinstalled by `executor`'s CLI — the one the resolver now answers with —
 * through the CLI's own service-install owner, each at its own target: a pinned service keeps its
 * profile (`--server <its id>`), the default-following one keeps following. Its OS enablement is
 * kept: a service its manager does not start at login (`enabled === false`, from discovery) is
 * reinstalled with `--keep-disabled`; any other is installed (enabled and started) and, when it was
 * not running, stopped again — `service stop` leaves it enabled. `exclude` is
 * the service the calling setup run converges itself. Services of another home or ring are never
 * touched. Every service is attempted; failures are returned by label, never swallowed.
 */
export async function convergeHappierHomeServicesOntoCli(params: Readonly<{
  executor: HappierJsonExecutor;
  services: readonly HappierService[];
  happierHomeDir: string | null;
  releaseRing: PublicReleaseRingId;
  exclude: HappierServerScope | HappierServiceFollowingScope | null;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<HappierHomeServiceConvergence> {
  const converged: string[] = [];
  const failed: Array<Readonly<{ label: string; message: string }>> = [];
  for (const service of params.services) {
    if (!isInstalledDaemonServiceOfHappierHomeAndRing(service, params)) continue;
    const scope: HappierServerScope | HappierServiceFollowingScope | null = service.targetMode === 'default-following'
      ? { serverId: null, targetMode: 'default-following' }
      : service.instanceId
        ? { serverId: service.instanceId, targetMode: 'pinned' }
        : null;
    if (!scope) continue;
    if (params.exclude && params.exclude.targetMode === scope.targetMode
      && (scope.targetMode === 'default-following' || params.exclude.serverId === scope.serverId)) continue;
    const scoped = scopeHappierJsonExecutor(params.executor, scope, params.processEnv ?? process.env);
    try {
      if (service.verification !== 'verified' || service.enabled == null || service.running === null) {
        throw new SystemTaskExecutionError('service_inventory_unavailable', `Could not establish preservation state for background service ${service.label}`);
      }
      if (service.enabled === false) {
        // Turned off at login by the person: the CLI's install owner rewrites it and keeps it off
        // (it neither enables nor starts it), so nothing is stopped afterwards.
        await scoped.runHappierJson(['service', 'install', '--keep-disabled', '--json']);
      } else {
        await scoped.runHappierJson(['service', 'install', '--json']);
        if (!service.running) {
          await scoped.runHappierJson(['service', 'stop', '--json']);
        }
      }
      converged.push(service.label);
    } catch (error) {
      failed.push({ label: service.label, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { converged, failed };
}

export type HappierHomeServiceDisconnect = Readonly<{
  /**
   * `removed`: this Home's desktop-managed pinned service was uninstalled (and is gone).
   * `user_owned`: a pinned service the user installed serves it; it is left in place.
   * `no_service`: nothing of the desktop's serves it (no saved profile, no pinned service, or only
   * the default-following service, which follows the terminal's selection and is never removed here).
   */
  outcome: 'removed' | 'user_owned' | 'no_service';
  label: string | null;
}>;

/**
 * R15 — removing a Home from the app disconnects this computer from it first: the Home's pinned
 * service that the desktop created (`managedBy: desktop`) is uninstalled through the CLI's own
 * service owner, scoped to that service (`--server <id>`, pinned), and its removal is proven by
 * reading the inventory again. A service the user installed is never touched. An inventory that
 * cannot be read fails `service_inventory_unavailable` before anything changes; an uninstall that
 * left the service behind fails `service_uninstall_failed`.
 */
export async function disconnectHappierHomeService(params: Readonly<{
  executor: HappierJsonExecutor;
  target: LocalServerProfileTarget;
  releaseRing: PublicReleaseRingId;
  happierHomeDir?: string | null;
  readServices?: () => Promise<readonly HappierService[]>;
}>): Promise<HappierHomeServiceDisconnect> {
  const readServices = params.readServices ?? readCurrentHappierServices;
  const happierHomeDir = params.happierHomeDir === undefined
    ? resolveHappyHomeDirFromEnvironment(process.env)
    : params.happierHomeDir;
  const findOwnPinned = (services: readonly HappierService[], serverId: string) => services.find((service) =>
    isInstalledDaemonServiceOfHappierHomeAndRing(service, { happierHomeDir, releaseRing: params.releaseRing })
    && (service.targetMode ?? 'pinned') === 'pinned'
    && service.instanceId === serverId);
  const readInventory = async (): Promise<readonly HappierService[]> => {
    try {
      return await readServices();
    } catch (error) {
      throw new SystemTaskExecutionError(
        'service_inventory_unavailable',
        `This computer's background services could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  let serverId: string | null;
  try {
    serverId = selectTargetProfile(readProfiles(await params.executor.runHappierJson(['server', 'list', '--json'])).profiles, params.target)?.id ?? null;
  } catch (error) {
    if (error instanceof SystemTaskExecutionError && error.code === 'server_profile_ambiguous') throw error;
    throw new SystemTaskExecutionError(
      'service_inventory_unavailable',
      `The Happier CLI's saved Homes could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (serverId === null) return { outcome: 'no_service', label: null };
  const service = findOwnPinned(await readInventory(), serverId);
  if (!service) return { outcome: 'no_service', label: null };
  if (service.verification !== 'verified') {
    throw new SystemTaskExecutionError(
      'service_inventory_unavailable',
      `This computer's background service for this Home (${service.label}) could not be verified and was left unchanged.`,
    );
  }
  if (!isAppManagedDaemonService(service)) return { outcome: 'user_owned', label: service.label };

  try {
    await scopeHappierJsonExecutor(params.executor, { serverId, targetMode: 'pinned' })
      .runHappierJson(['service', 'uninstall', '--json']);
    const remainingService = findOwnPinned(await readServices(), serverId);
    if (remainingService) {
      throw new SystemTaskExecutionError(
        'service_uninstall_failed',
        `This computer's background service for this Home (${remainingService.label}) is still installed after uninstalling it.`,
      );
    }
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError'
      || (error instanceof SystemTaskExecutionError && error.code === 'cancelled'))) throw error;
    if (error instanceof SystemTaskExecutionError && error.code === 'service_uninstall_failed') throw error;
    throw new SystemTaskExecutionError(
      'service_uninstall_failed',
      `This computer's background service for this Home (${service.label}) could not be removed and verified: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { outcome: 'removed', label: service.label };
}
