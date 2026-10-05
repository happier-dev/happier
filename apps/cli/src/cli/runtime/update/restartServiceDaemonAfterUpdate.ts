import { spawnSync } from 'node:child_process';

import {
  formatPinnedDaemonServiceRestartCommand,
  planServiceDaemonsRestartAfterCliUpdate,
  resolveInstalledFirstPartyComponentPaths,
  resolveManagedCliToolNameForRing,
  type ManagedCliUpdateRestart,
  type ServiceDaemonBeforeCliUpdate,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { getReleaseRingCatalogEntry, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { readDaemonStateForServerId } from '@/daemon/multiDaemon';
import { resolveDaemonStartupSourceServiceManagedState } from '@/daemon/ownership/daemonOwnershipMetadata';
import { evaluateCurrentDaemonOwner, type DaemonOwnerEvaluation } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { happierHomeDirsMatch } from '@/daemon/ownership/happierHomeDirComparableKey';
import { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths } from '@/daemon/service/cli';
import {
  discoverInstalledDaemonServiceEntries,
  isInstalledDaemonServiceForHappierHome,
  readInstalledDaemonServiceManagedBy,
  resolveInstalledDaemonServiceDefinitionPath,
} from '@/daemon/service/discoverInstalledDaemonServiceEntries';
import { resolveDaemonServiceLaunchdLabel, type DaemonServiceTargetMode } from '@/daemon/service/plan';
import { resolveDaemonServiceDiscoveryTargets } from '@/daemon/service/resolveDaemonServiceDiscoveryTargets';
import { readSettings } from '@/persistence';
import { sanitizeServerIdForFilesystem } from '@/server/serverId';

/**
 * What an update does about the background service's daemon, decided from the owner observed
 * BEFORE the update (on Windows the update stops the payload's processes first, so only that
 * earlier observation still knows the service's daemon was running and must come back).
 *
 * Only a daemon this channel's own background service started is restarted (plan R10 D2, R13 S-8):
 * a manual daemon and another channel's service are left alone, and a service label this CLI does
 * not manage is named, never guessed at. The owner is the one serving this CLI's current server
 * selection: the default-following service, or that server's own pinned service. Other servers'
 * services are `planServiceDaemonsRestartAfterUpdate`'s (below): restarted when the update stopped
 * them, otherwise moved onto the installed CLI at their next start (`service start`, R3-4).
 */
export type ServiceDaemonRestartPlan = Readonly<
  | { kind: 'restart'; channel: PublicReleaseRingId; targetMode: DaemonServiceTargetMode; instanceId: string }
  | { kind: 'skip'; reason: 'not-running' | 'not-service-managed' | 'other-channel' }
  | { kind: 'unmanaged'; message: string }
>;

const SERVICE_TARGET_MODES: readonly DaemonServiceTargetMode[] = ['default-following', 'pinned'];

function restartCommandFor(channel: PublicReleaseRingId): string {
  return `${resolveManagedCliToolNameForRing(channel)} service restart`;
}

export function planServiceDaemonRestartAfterUpdate(params: Readonly<{
  channel: PublicReleaseRingId;
  ownerBeforeUpdate: DaemonOwnerEvaluation;
  processEnv?: NodeJS.ProcessEnv;
}>): ServiceDaemonRestartPlan {
  const processEnv = params.processEnv ?? process.env;
  const ownership = params.ownerBeforeUpdate;
  if (ownership.kind === 'none') {
    return { kind: 'skip', reason: 'not-running' };
  }
  const { owner } = ownership;
  if (owner.serviceManaged !== true) {
    return { kind: 'skip', reason: 'not-service-managed' };
  }
  const ownerChannel = owner.state.startedWithPublicReleaseChannel ?? null;
  if (ownerChannel !== null && ownerChannel !== getReleaseRingCatalogEntry(params.channel).publicLabel) {
    return { kind: 'skip', reason: 'other-channel' };
  }

  const serviceLabel = String(owner.state.serviceLabel ?? '').trim();
  const service = SERVICE_TARGET_MODES
    .map((targetMode) => {
      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ channel: params.channel, targetMode, processEnv });
      const paths = resolveDaemonServicePaths(runtime);
      return { targetMode, instanceId: runtime.instanceId, label: paths.label, runtime, paths };
    })
    .find((candidate) => serviceLabel !== '' && candidate.label === serviceLabel);
  if (!service || !isInstalledDaemonServiceForHappierHome({
    platform: service.runtime.platform,
    path: resolveInstalledDaemonServiceDefinitionPath({
      platform: service.runtime.platform, path: service.paths.installedPath, taskName: service.paths.taskName,
    }),
    expectedLabel: service.label,
    happierHomeDir: service.runtime.happierHomeDir,
  })) {
    return {
      kind: 'unmanaged',
      message: `The running background service (${serviceLabel || 'unknown label'}) is not one this CLI manages. Run: ${restartCommandFor(params.channel)}`,
    };
  }
  return { kind: 'restart', channel: params.channel, targetMode: service.targetMode, instanceId: service.instanceId };
}

/**
 * Restart the planned service daemon onto the CLI the channel's `current` names now, through the
 * CLI service owner run BY THAT CLI (`<current>/happier service restart`): only its own
 * ownership wait accepts its version as the owner, and that wait is the whole time budget. Then
 * the owner is re-read and must run `expectedVersion`. Throws when either is not proven — the
 * update transaction then restores the previous version and calls this again for it.
 */
export async function restartServiceDaemonOntoInstalledCli(params: Readonly<{
  plan: Extract<ServiceDaemonRestartPlan, { kind: 'restart' }>;
  expectedVersion: string;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<void> {
  const processEnv = params.processEnv ?? process.env;
  const { channel } = params.plan;
  const binaryPath = resolveInstalledFirstPartyComponentPaths({
    componentId: 'happier-cli',
    channel,
    processEnv,
  }).binaryPath;
  const result = spawnSync(binaryPath, ['service', 'restart'], {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...processEnv,
      HAPPIER_DAEMON_SERVICE_CHANNEL: channel,
      HAPPIER_PUBLIC_RELEASE_CHANNEL: getReleaseRingCatalogEntry(channel).publicLabel,
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: params.plan.targetMode,
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: params.plan.instanceId,
    },
  });
  if (result.status !== 0) {
    const detail = result.error instanceof Error ? result.error.message : `exit status ${result.status ?? 'unknown'}`;
    throw new Error(`the background service did not come back on ${params.expectedVersion} (${detail})`);
  }

  const ownership = await evaluateCurrentDaemonOwner();
  const runningVersion = ownership.kind === 'none' ? null : ownership.owner.state.startedWithCliVersion ?? null;
  if (runningVersion !== params.expectedVersion) {
    throw new Error(`the background service runs ${runningVersion ?? 'no daemon'} instead of ${params.expectedVersion}`);
  }
}

/** Another service of this Happier home and ring whose own service ran its daemon before the update. */
type OtherServiceDaemonBeforeUpdate = Readonly<{
  label: string;
  targetMode: DaemonServiceTargetMode;
  instanceId: string;
  /** The desktop management marker its definition carries (`null`: user-owned). */
  managedBy: 'desktop' | null;
  /** The server whose lifecycle directory holds this service's daemon state. */
  lifecycleServerId: string;
}>;

/**
 * Selectors an inherited environment can use to point the CLI at another server or lifecycle; each
 * restart of another server's service names that service instead.
 */
const INHERITED_SERVICE_SELECTOR_ENV_KEYS = [
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
  'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
  'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
] as const;

function serviceLabelOfPlan(plan: ServiceDaemonRestartPlan): string | null {
  return plan.kind === 'restart'
    ? resolveDaemonServiceLaunchdLabel(plan.instanceId, plan.channel, plan.targetMode)
    : null;
}

/**
 * Every other user-mode service of this Happier home and ring (besides `excludeLabel`, the invoking
 * server's own) whose own service was running its daemon, observed before the update.
 */
async function observeOtherServiceDaemonsBeforeUpdate(params: Readonly<{
  channel: PublicReleaseRingId;
  processEnv: NodeJS.ProcessEnv;
  excludeLabel: string | null;
}>): Promise<OtherServiceDaemonBeforeUpdate[]> {
  const runtime = resolveDaemonServiceCliRuntimeFromEnv({ channel: params.channel, processEnv: params.processEnv });
  const settings = await readSettings();
  // The default-following service serves the persisted selection, never this invocation's `--server`.
  const followedServerId = sanitizeServerIdForFilesystem(settings.activeServerId ?? 'cloud', 'cloud');
  const entries = (await Promise.all(
    resolveDaemonServiceDiscoveryTargets({
      platform: runtime.platform,
      mode: 'user',
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
    })
      .filter((target) => target.mode === 'user')
      .map(async (target) => await discoverInstalledDaemonServiceEntries({
        platform: runtime.platform,
        userHomeDir: target.userHomeDir,
        happierHomeDir: target.happierHomeDir,
        mode: target.mode,
        serversById: {},
      })),
  )).flat();

  const others: OtherServiceDaemonBeforeUpdate[] = [];
  for (const entry of entries) {
    if (entry.releaseChannel !== params.channel) continue;
    if (!happierHomeDirsMatch(entry.happierHomeDir, runtime.happierHomeDir, runtime.platform)) continue;
    // The label the service hands its daemon (`HAPPIER_DAEMON_SERVICE_LABEL`), which the daemon records.
    const label = resolveDaemonServiceLaunchdLabel(entry.serverId, entry.releaseChannel, entry.targetMode);
    if (label === params.excludeLabel || others.some((other) => other.label === label)) continue;
    const lifecycleServerId = entry.targetMode === 'pinned' ? entry.activeServerId ?? entry.serverId : followedServerId;
    const observed = await readDaemonStateForServerId(lifecycleServerId);
    if (
      !observed?.running
      || observed.state.serviceLabel !== label
      || resolveDaemonStartupSourceServiceManagedState(observed.state.startupSource, observed.state.serviceLabel) !== true
    ) {
      continue;
    }
    others.push({ label, targetMode: entry.targetMode, instanceId: entry.serverId, managedBy: entry.managedBy ?? null, lifecycleServerId });
  }
  return others;
}

async function restartOtherServiceDaemonOntoInstalledCli(params: Readonly<{
  channel: PublicReleaseRingId;
  service: OtherServiceDaemonBeforeUpdate;
  expectedVersion: string;
  processEnv: NodeJS.ProcessEnv;
}>): Promise<void> {
  const { channel, service } = params;
  const binaryPath = resolveInstalledFirstPartyComponentPaths({
    componentId: 'happier-cli',
    channel,
    processEnv: params.processEnv,
  }).binaryPath;
  const env: NodeJS.ProcessEnv = { ...params.processEnv };
  for (const key of INHERITED_SERVICE_SELECTOR_ENV_KEYS) delete env[key];
  const result = spawnSync(binaryPath, ['service', 'restart'], {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...env,
      HAPPIER_DAEMON_SERVICE_CHANNEL: channel,
      HAPPIER_PUBLIC_RELEASE_CHANNEL: getReleaseRingCatalogEntry(channel).publicLabel,
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: service.targetMode,
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: service.instanceId,
      // A pinned service's own server; the default-following one reads the persisted selection.
      ...(service.targetMode === 'pinned' ? { HAPPIER_ACTIVE_SERVER_ID: service.lifecycleServerId } : {}),
    },
  });
  if (result.status !== 0) {
    const detail = result.error instanceof Error ? result.error.message : `exit status ${result.status ?? 'unknown'}`;
    throw new Error(`the background service did not come back on ${params.expectedVersion} (${detail})`);
  }
  const observed = await readDaemonStateForServerId(service.lifecycleServerId);
  const runningVersion = observed?.running ? observed.state.startedWithCliVersion ?? null : null;
  if (runningVersion !== params.expectedVersion) {
    throw new Error(`the background service runs ${runningVersion ?? 'no daemon'} instead of ${params.expectedVersion}`);
  }
}

export type ServiceDaemonsRestartAfterUpdate = Readonly<{
  /** The invoking server's own service, addressed by the existing CLI owner. */
  plan: ServiceDaemonRestartPlan;
  /** Other servers' services of this home and ring whose daemons the update stopped and restarts. */
  otherLabels: readonly string[];
  /** The update transaction's restart step, or `null` when no service daemon is to come back. */
  restart: ManagedCliUpdateRestart | null;
}>;

/**
 * The one rule for which service daemons come back after a CLI update (one daemon per server,
 * plan R15 e): the invoking server's own service (`planServiceDaemonRestartAfterUpdate`) and —
 * when the update stops every daemon of the payload (`includeOtherServices`: the Windows quiesce) —
 * every other service of this Happier home and ring whose own service was running its daemon. All
 * of them are restarted and proven, each attempted. Only a service the update owns — the
 * default-following one and pinned services the desktop manages (`managedBy: desktop`) — fails the
 * step when it does not come back (so the transaction rolls back and runs it again for the previous
 * version); a user-owned service that does not is named through `reportUnownedRestartFailure`.
 * Elsewhere nothing stops other servers' daemons, so they move onto the installed CLI at their
 * next start.
 */
export async function planServiceDaemonsRestartAfterUpdate(params: Readonly<{
  channel: PublicReleaseRingId;
  ownerBeforeUpdate: DaemonOwnerEvaluation;
  includeOtherServices: boolean;
  processEnv?: NodeJS.ProcessEnv;
  reportUnownedRestartFailure?: (message: string) => void;
}>): Promise<ServiceDaemonsRestartAfterUpdate> {
  const processEnv = params.processEnv ?? process.env;
  const plan = planServiceDaemonRestartAfterUpdate({
    channel: params.channel,
    ownerBeforeUpdate: params.ownerBeforeUpdate,
    processEnv,
  });
  const others = params.includeOtherServices
    ? await observeOtherServiceDaemonsBeforeUpdate({
      channel: params.channel,
      processEnv,
      excludeLabel: serviceLabelOfPlan(plan),
    })
    : [];
  type RestartTarget = Extract<ServiceDaemonRestartPlan, { kind: 'restart' }> | OtherServiceDaemonBeforeUpdate;
  const candidates: ServiceDaemonBeforeCliUpdate<RestartTarget>[] = [];
  const pinnedRestartCommand = (serverId: string, instanceId: string) => formatPinnedDaemonServiceRestartCommand({
    toolName: resolveManagedCliToolNameForRing(params.channel), serverId, instanceId,
  });
  if (plan.kind === 'restart') {
    const runtime = resolveDaemonServiceCliRuntimeFromEnv({
      channel: plan.channel, targetMode: plan.targetMode, instanceId: plan.instanceId, processEnv,
    });
    candidates.push({
      label: resolveDaemonServiceLaunchdLabel(plan.instanceId, plan.channel, plan.targetMode),
      // This candidate was observed running under the current scope's own OS service.
      serviceInstalled: true, daemonRunning: true, serviceManaged: true,
      managedBy: readInstalledDaemonServiceManagedBy({ platform: runtime.platform, path: resolveDaemonServicePaths(runtime).installedPath }),
      ...(plan.targetMode === 'pinned' ? { restartCommand: pinnedRestartCommand(runtime.activeServerId, plan.instanceId) } : {}),
      target: plan,
    });
  }
  for (const service of others) {
    candidates.push({
      label: service.label, serviceInstalled: true, daemonRunning: true, serviceManaged: true,
      managedBy: service.managedBy,
      ...(service.targetMode === 'pinned' ? { restartCommand: pinnedRestartCommand(service.lifecycleServerId, service.instanceId) } : {}),
      target: service,
    });
  }
  const sharedPlan = planServiceDaemonsRestartAfterCliUpdate({
    defaultFollowing: candidates.find((service) => service.target.targetMode === 'default-following') ?? null,
    pinned: candidates.filter((service) => service.target.targetMode === 'pinned'),
    restartAndProve: async (target, expectedVersion) => {
      if ('channel' in target) {
        await restartServiceDaemonOntoInstalledCli({ plan: target, expectedVersion, processEnv });
      } else {
        await restartOtherServiceDaemonOntoInstalledCli({ channel: params.channel, service: target, expectedVersion, processEnv });
      }
    },
    reportUnownedRestartFailure: params.reportUnownedRestartFailure ?? ((message) => process.stderr.write(`${message}\n`)),
  });
  return { plan, otherLabels: others.map((service) => service.label), restart: sharedPlan.restart };
}
