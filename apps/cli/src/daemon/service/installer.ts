import { homedir } from 'node:os';

import { configuration } from '@/configuration';

import { applyDaemonServiceInstallPlan, applyDaemonServiceUninstallPlan } from './apply';
import { planDaemonServiceInstall, planDaemonServiceUninstall } from './plan';
import type { DaemonServiceMode } from './plan';
import { resolveDaemonServiceInstallRuntimeTarget } from './resolveDaemonServiceInstallRuntimeTarget';
import {
  discoverHappierServices,
  resolveDaemonServiceInstallConflictPlan,
  type DaemonServiceInstallStrategy,
  type DaemonServiceInstallTarget,
} from '@happier-dev/cli-common/happierRuntime';
import type { HappierServiceBackend } from '@happier-dev/cli-common/happierRuntime';
import {
  getReleaseRingCatalogEntry,
  normalizePublicReleaseRingId,
  resolvePublicReleaseRingIdForLabel,
  type PublicReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';

type SupportedPlatform = 'darwin' | 'linux' | 'win32';

function resolveSupportedPlatform(p: string): SupportedPlatform | null {
  if (p === 'darwin') return 'darwin';
  if (p === 'linux') return 'linux';
  if (p === 'win32') return 'win32';
  return null;
}

export async function installDaemonService(options: Readonly<{
  platform?: SupportedPlatform;
  uid?: number;
  userHomeDir?: string;
  happierHomeDir?: string;
  mode?: DaemonServiceMode;
  systemUser?: string;
  channel?: PublicReleaseRingId;
  instanceId?: string;
  strategy?: DaemonServiceInstallStrategy;
  serverUrl?: string;
  webappUrl?: string;
  publicServerUrl?: string;
  nodePath?: string;
  entryPath?: string;
  runCommands?: boolean;
}> = {}): Promise<void> {
  const platformInput = options.platform ?? process.platform;
  const platform = resolveSupportedPlatform(platformInput);
  if (!platform) {
    throw new Error('Daemon service installation is currently only supported on macOS, Linux, and Windows');
  }

  const uid = options.uid ?? (process.getuid ? process.getuid() : undefined);
  const userHomeDir = options.userHomeDir ?? homedir();
  const happierHomeDir = options.happierHomeDir ?? configuration.happyHomeDir;
  const instanceId = options.instanceId ?? configuration.activeServerId;
  // Daemon should prefer the local API URL when available (e.g. canonical HTTPS URL + local loopback HTTP).
  // We express this using env override semantics: HAPPIER_PUBLIC_SERVER_URL (canonical) + HAPPIER_SERVER_URL (API).
  const serverUrl = options.serverUrl ?? configuration.apiServerUrl;
  const webappUrl = options.webappUrl ?? configuration.webappUrl;
  const publicServerUrl = options.publicServerUrl ?? configuration.serverUrl;
  const explicitNodePath = options.nodePath ?? null;
  const explicitEntryPath = options.entryPath ?? null;
  const runtimeTarget = await resolveDaemonServiceInstallRuntimeTarget({
    currentExecPath: process.execPath,
    explicitNodePath,
    explicitEntryPath,
  });
  const strategy: DaemonServiceInstallStrategy = options.strategy
    ?? resolveDaemonServiceInstallerStrategyFromEnv(process.env);

  const discoveredServices = await discoverHappierServices({
    processEnv: process.env,
    platform,
  });
  const target: DaemonServiceInstallTarget = {
    platform,
    backend: resolveDaemonServiceBackend(platform, options.mode),
    ring: getReleaseRingCatalogEntry(
      normalizePublicReleaseRingId(options.channel ?? process.env.HAPPIER_DAEMON_SERVICE_CHANNEL ?? 'stable') || 'stable',
    ).publicLabel,
    instanceId,
    serverUrl,
  };
  const conflictPlan = resolveDaemonServiceInstallConflictPlan({
    target,
    strategy,
    services: discoveredServices.services,
  });

  if (!conflictPlan.exactTargetExists && strategy === 'require-explicit' && conflictPlan.competingServices.length > 0) {
    const serviceList = conflictPlan.competingServices.map((service) => service.label).join(', ');
    throw createDaemonServiceConflictError(
      `Competing daemon services detected: ${serviceList}. Re-run with --yes or --replace-existing=ring|all.`,
      conflictPlan.competingServices,
    );
  }

  if (!conflictPlan.exactTargetExists) {
    for (const service of conflictPlan.servicesToRemove) {
      await uninstallDaemonService({
        platform,
        uid,
        userHomeDir,
        happierHomeDir,
        mode: resolveDaemonServiceModeFromBackend(service.backend),
        channel: service.ring ? resolvePublicReleaseRingIdForLabel(service.ring) : undefined,
        instanceId: service.instanceId ?? undefined,
        runCommands: options.runCommands,
      });
    }
  }

  const plan = planDaemonServiceInstall({
    platform,
    mode: options.mode,
    systemUser: options.systemUser,
    channel: options.channel,
    instanceId,
    uid,
    userHomeDir,
    happierHomeDir,
    serverUrl,
    webappUrl,
    publicServerUrl,
    nodePath: runtimeTarget.nodePath,
    entryPath: runtimeTarget.entryPath,
  });
  await applyDaemonServiceInstallPlan(plan, { runCommands: options.runCommands });
}

function resolveDaemonServiceInstallerStrategyFromEnv(processEnv: NodeJS.ProcessEnv): DaemonServiceInstallStrategy {
  const raw = String(processEnv.HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY ?? '').trim().toLowerCase();
  if (raw === 'add') return 'add';
  if (raw === 'replace-ring') return 'replace-ring';
  if (raw === 'replace-all') return 'replace-all';
  return 'require-explicit';
}

function resolveDaemonServiceModeFromBackend(backend: string): DaemonServiceMode {
  return backend === 'systemd-system' || backend === 'schtasks-system' ? 'system' : 'user';
}

function resolveDaemonServiceBackend(platform: SupportedPlatform, mode?: DaemonServiceMode): HappierServiceBackend {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'win32') return mode === 'system' ? 'schtasks-system' : 'schtasks-user';
  return mode === 'system' ? 'systemd-system' : 'systemd-user';
}

function createDaemonServiceConflictError(message: string, conflicts: readonly unknown[]): Error {
  const error = new Error(message) as Error & { code: string; conflicts: readonly unknown[] };
  error.code = 'daemon_service_conflict';
  error.conflicts = conflicts;
  return error;
}

export async function uninstallDaemonService(options: Readonly<{
  platform?: SupportedPlatform;
  uid?: number;
  userHomeDir?: string;
  happierHomeDir?: string;
  mode?: DaemonServiceMode;
  channel?: PublicReleaseRingId;
  instanceId?: string;
  runCommands?: boolean;
}> = {}): Promise<void> {
  const platformInput = options.platform ?? process.platform;
  const platform = resolveSupportedPlatform(platformInput);
  if (!platform) {
    throw new Error('Daemon service uninstallation is currently only supported on macOS, Linux, and Windows');
  }

  const uid = options.uid ?? (process.getuid ? process.getuid() : undefined);
  const userHomeDir = options.userHomeDir ?? homedir();
  const happierHomeDir = options.happierHomeDir ?? configuration.happyHomeDir;
  const instanceId = options.instanceId ?? configuration.activeServerId;

  const plan = planDaemonServiceUninstall({
    platform,
    mode: options.mode,
    channel: options.channel,
    instanceId,
    uid,
    userHomeDir,
    happierHomeDir,
  });
  await applyDaemonServiceUninstallPlan(plan, { runCommands: options.runCommands });
}
