import { spawnSync } from 'node:child_process';

import {
  doesCliLauncherUseInstallation,
  formatPinnedDaemonServiceRestartCommand,
  planServiceDaemonsRestartAfterCliUpdate,
  resolveInstalledFirstPartyComponentPaths,
  resolveManagedCliToolNameForRing,
  type ManagedCliUpdateRestart,
  type ServiceDaemonBeforeCliUpdate,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { getReleaseRingCatalogEntry, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { readInstalledDaemonServiceDefinition } from '@/daemon/service/installer';
import { readDaemonServiceDefinitionLauncher } from '@/daemon/service/readDaemonServiceDefinitionLauncher';
import { isJavaScriptRuntimeExecutable } from '@/daemon/service/runtimeTarget';
import { readDaemonStateForServerId } from '@/daemon/multiDaemon';
import type { DaemonOwnerEvaluation } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { resolveDaemonStartupSourceServiceManagedState } from '@/daemon/ownership/daemonOwnershipMetadata';
import { happierHomeDirsMatch } from '@/daemon/ownership/happierHomeDirComparableKey';
import { resolveDaemonServiceCliRuntimeFromEnv } from '@/daemon/service/cli';
import {
  discoverInstalledDaemonServiceEntries,
  type InstalledDaemonServiceEntry,
} from '@/daemon/service/discoverInstalledDaemonServiceEntries';
import { resolveDaemonServiceDiscoveryTargets } from '@/daemon/service/resolveDaemonServiceDiscoveryTargets';
import { resolveDaemonServiceLaunchdLabel, type DaemonServiceTargetMode } from '@/daemon/service/plan';
import { readSettings } from '@/persistence';
import { sanitizeServerIdForFilesystem } from '@/server/serverId';

/** How to address one service's restart and read back its daemon. */
type ServiceRestartTarget = Readonly<{
  targetMode: DaemonServiceTargetMode;
  instanceId: string;
  /** The relay profile whose lifecycle directory holds this service's daemon state. */
  lifecycleServerId: string;
  /** Only the discovered legacy task needs its action rewritten. */
  windowsLauncherRepairPath?: string;
}>;

export type ServiceDaemonsRestartAfterUpdatePlan = Readonly<{
  /** The services whose daemons the update restarts. */
  labels: readonly string[];
  /** The update transaction's restart step, or `null` when no service daemon was running. */
  restart: ManagedCliUpdateRestart | null;
  /** The invoking daemon was started by a service label this CLI does not manage: named, never guessed at. */
  unmanagedMessage: string | null;
}>;

function restartCommandFor(channel: PublicReleaseRingId): string {
  return `${resolveManagedCliToolNameForRing(channel)} service restart`;
}

/**
 * Selectors an inherited environment can use to point the CLI at another relay or lifecycle; each
 * restart names its own service instead (a `--server` or a daemon's env must not redirect it).
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
  'HAPPIER_DAEMON_SERVICE_MANAGED_BY',
  'HAPPIER_DAEMON_SERVICE_BUNDLE_ID',
  'HAPPIER_DAEMON_SERVICE_AUTOSTART',
  'HAPPIER_DAEMON_SERVICE_NODE_PATH',
  'HAPPIER_DAEMON_SERVICE_ENTRY_PATH',
] as const;

async function listUserServicesOfThisHomeAndRing(
  channel: PublicReleaseRingId,
  processEnv: NodeJS.ProcessEnv,
): Promise<InstalledDaemonServiceEntry[]> {
  const runtime = resolveDaemonServiceCliRuntimeFromEnv({ channel, processEnv });
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
  return entries.filter((entry, index) =>
    entries.findIndex((other) => other.path === entry.path) === index
    && entry.releaseChannel === channel
    && happierHomeDirsMatch(entry.happierHomeDir, runtime.happierHomeDir));
}

async function observeServiceBeforeUpdate(
  entry: InstalledDaemonServiceEntry,
  target: ServiceRestartTarget,
  channel: PublicReleaseRingId,
): Promise<ServiceDaemonBeforeCliUpdate<ServiceRestartTarget>> {
  const observed = await readDaemonStateForServerId(target.lifecycleServerId);
  if (observed?.presence === 'unverified') {
    throw new Error(`Daemon presence is unverified for service relay ${target.lifecycleServerId}; retry the update when authenticated control is available`);
  }
  // The label the service hands its daemon (`HAPPIER_DAEMON_SERVICE_LABEL`), which the daemon records.
  const label = resolveDaemonServiceLaunchdLabel(entry.serverId, entry.releaseChannel, entry.targetMode);
  return {
    label,
    managedBy: entry.managedBy ?? null,
    ...(target.targetMode === 'pinned'
      ? {
          restartCommand: formatPinnedDaemonServiceRestartCommand({
            toolName: resolveManagedCliToolNameForRing(channel),
            serverId: target.lifecycleServerId,
            instanceId: target.instanceId,
          }),
        }
      : {}),
    serviceInstalled: true,
    daemonRunning: observed?.running === true,
    serviceManaged: observed !== null
      && observed.state.serviceLabel === label
      && resolveDaemonStartupSourceServiceManagedState(observed.state.startupSource, observed.state.serviceLabel) === true,
    target,
  };
}

/**
 * Which service daemons `happier self update` restarts, observed BEFORE the update: the
 * default-following service and every pinned service of this Happier home and ring whose own
 * service runs its daemon — through the one rule the desktop's `cli.update.v1` also uses
 * (`planServiceDaemonsRestartAfterCliUpdate`). On Windows the update stops every daemon of the
 * payload, and each of these comes back; a manual daemon and another ring's services are not the
 * update's to restart.
 */
export async function planServiceDaemonsRestartAfterUpdate(params: Readonly<{
  channel: PublicReleaseRingId;
  /** The invoking scope's owner, only to name a service label this CLI does not manage. */
  ownerBeforeUpdate?: DaemonOwnerEvaluation;
  processEnv?: NodeJS.ProcessEnv;
  /**
   * A user-owned pinned service did not come back after the update; it never rolls the update
   * back. The default names it on stderr.
   */
  reportUnownedRestartFailure?: (message: string) => void;
}>): Promise<ServiceDaemonsRestartAfterUpdatePlan> {
  const processEnv = params.processEnv ?? process.env;
  const services = await listUserServicesOfThisHomeAndRing(params.channel, processEnv);
  // The default-following service serves the persisted selection, never this invocation's `--server`.
  const settings = await readSettings();
  const followedServerId = sanitizeServerIdForFilesystem(settings.activeServerId ?? 'cloud', 'cloud');

  const defaultFollowing = services.filter((entry) => entry.targetMode === 'default-following');
  const observedDefaults = await Promise.all(defaultFollowing.map(async (entry) => await observeServiceBeforeUpdate(entry, {
    targetMode: 'default-following',
    instanceId: entry.serverId,
    lifecycleServerId: followedServerId,
    ...(entry.windowsLauncherUpgradeNeeded ? { windowsLauncherRepairPath: entry.path } : {}),
  }, params.channel)));
  const pinned = await Promise.all(services
    .filter((entry) => entry.targetMode === 'pinned')
    .map(async (entry) => await observeServiceBeforeUpdate(entry, {
      targetMode: 'pinned',
      instanceId: entry.serverId,
      lifecycleServerId: entry.activeServerId ?? entry.serverId,
      ...(entry.windowsLauncherUpgradeNeeded ? { windowsLauncherRepairPath: entry.path } : {}),
    }, params.channel)));

  const plan = planServiceDaemonsRestartAfterCliUpdate({
    // Legacy channel-scoped default units share the default's lifecycle; the one whose label
    // started the running daemon is the default-following service.
    defaultFollowing: observedDefaults.find((service) => service.serviceManaged) ?? observedDefaults[0] ?? null,
    pinned,
    restartAndProve: async (target, expectedVersion) => await restartServiceDaemonOntoInstalledCli({
      channel: params.channel,
      target,
      expectedVersion,
      processEnv,
    }),
    reportUnownedRestartFailure: params.reportUnownedRestartFailure ?? ((message) => {
      process.stderr.write(`${message}\n`);
    }),
  });

  const owner = params.ownerBeforeUpdate?.kind === 'none' ? null : params.ownerBeforeUpdate?.owner ?? null;
  const ownerLabel = String(owner?.state.serviceLabel ?? '').trim();
  const ownerChannel = owner?.state.startedWithPublicReleaseChannel ?? null;
  const unmanagedMessage = owner?.serviceManaged === true
    && (ownerChannel === null || ownerChannel === getReleaseRingCatalogEntry(params.channel).publicLabel)
    && !services.some((entry) => resolveDaemonServiceLaunchdLabel(entry.serverId, entry.releaseChannel, entry.targetMode) === ownerLabel)
    ? `The running background service (${ownerLabel || 'unknown label'}) is not one this CLI manages. Run: ${restartCommandFor(params.channel)}`
    : null;

  return { labels: plan.labels, restart: plan.restart, unmanagedMessage };
}

/**
 * Restart the planned service daemon onto the CLI the channel's `current` names now, through the
 * CLI service owner run BY THAT CLI (`<current>/happier daemon service restart`): only its own
 * ownership wait accepts its version as the owner, and that wait is the whole time budget. Then
 * the owner is re-read and must run `expectedVersion`. Throws when either is not proven — the
 * update transaction then restores the previous version and calls this again for it.
 */
async function restartServiceDaemonOntoInstalledCli(params: Readonly<{
  channel: PublicReleaseRingId;
  target: ServiceRestartTarget;
  expectedVersion: string;
  processEnv: NodeJS.ProcessEnv;
}>): Promise<void> {
  const { channel, target } = params;
  const installation = resolveInstalledFirstPartyComponentPaths({
    componentId: 'happier-cli',
    channel,
    processEnv: params.processEnv,
  });
  const binaryPath = installation.binaryPath;
  const env: NodeJS.ProcessEnv = { ...params.processEnv };
  for (const key of INHERITED_SERVICE_SELECTOR_ENV_KEYS) delete env[key];
  const serviceEnv: NodeJS.ProcessEnv = {
    ...env,
    HAPPIER_DAEMON_SERVICE_CHANNEL: channel,
    HAPPIER_PUBLIC_RELEASE_CHANNEL: getReleaseRingCatalogEntry(channel).publicLabel,
    HAPPIER_DAEMON_SERVICE_TARGET_MODE: target.targetMode,
    HAPPIER_DAEMON_SERVICE_INSTANCE_ID: target.instanceId,
    ...(target.targetMode === 'pinned' ? { HAPPIER_ACTIVE_SERVER_ID: target.lifecycleServerId } : {}),
  };
  if (target.windowsLauncherRepairPath) {
    const contents = readInstalledDaemonServiceDefinition(target.windowsLauncherRepairPath);
    const launcher = contents === null ? null : readDaemonServiceDefinitionLauncher({ platform: 'win32', contents });
    if (launcher && (launcher.length === 1 || (launcher.length === 2 && isJavaScriptRuntimeExecutable(launcher[0])))) {
      const managed = doesCliLauncherUseInstallation({ launcher: [launcher[launcher.length - 1]!], installationRoots: [installation.installRoot] });
      const repair = spawnSync(binaryPath, ['daemon', 'service', 'install', '--preserve-desktop-ownership'], {
        stdio: 'inherit', windowsHide: true,
        env: {
          ...serviceEnv,
          // Keep an external CLI exactly as installed. A payload of this installation follows
          // current, so repairing it cannot freeze a removed pre-update version.
          HAPPIER_DAEMON_SERVICE_NODE_PATH: managed ? binaryPath : launcher[0],
          HAPPIER_DAEMON_SERVICE_ENTRY_PATH: managed ? '' : launcher[1] ?? '',
        },
      });
      if (repair.status !== 0) {
        const detail = repair.error instanceof Error ? repair.error.message : `exit status ${repair.status ?? 'unknown'}`;
        throw new Error(`Windows background service launcher repair failed (${detail})`);
      }
      if (!managed) process.stderr.write(`Windows background service launcher repaired while preserving its external CLI (${launcher.join(' ')}). The service must provide ${params.expectedVersion}.\n`);
    } else {
      process.stderr.write(`Windows background service launcher needs repair: its custom CLI prefix cannot be preserved by automatic installation (${target.windowsLauncherRepairPath}). Run the service installer with the original CLI.\n`);
    }
  }
  // Installation preserves definition-owned autostart/management settings. Restart remains the
  // lifecycle owner that waits for the daemon, including on-demand tasks and rollback.
  const result = spawnSync(binaryPath, ['daemon', 'service', 'restart'], {
    stdio: 'inherit', windowsHide: true, env: serviceEnv,
  });
  if (result.status !== 0) {
    const detail = result.error instanceof Error ? result.error.message : `exit status ${result.status ?? 'unknown'}`;
    throw new Error(`the background service did not come back on ${params.expectedVersion} (${detail})`);
  }

  const observed = await readDaemonStateForServerId(target.lifecycleServerId);
  if (observed?.presence === 'unverified') {
    throw new Error(`Daemon presence is unverified for service relay ${target.lifecycleServerId}; retry the update when authenticated control is available`);
  }
  const runningVersion = observed?.running ? observed.state.startedWithCliVersion ?? null : null;
  if (runningVersion !== params.expectedVersion) {
    throw new Error(`the background service runs ${runningVersion ?? 'no daemon'} instead of ${params.expectedVersion}`);
  }
}
