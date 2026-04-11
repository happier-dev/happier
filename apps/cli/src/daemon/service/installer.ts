import { homedir } from 'node:os';

import { configuration } from '@/configuration';

import {
  applyDaemonServiceInstallPlan,
  applyDaemonServiceUninstallPlan,
  type DaemonServiceCommandFailureMode,
} from './apply';
import {
  resolveDaemonServiceInstallConflictPlan,
  type DaemonServiceInstallStrategy,
  type DaemonServiceInstallTarget,
} from './daemonInstallConflict';
import { assertDaemonServiceModeSupported } from './assertDaemonServiceModeSupported';
import { discoverInstalledDaemonServiceEntries } from './discoverInstalledDaemonServiceEntries';
import { planDaemonServiceInstall, planDaemonServiceUninstall } from './plan';
import type { DaemonServiceMode, DaemonServiceTargetMode } from './plan';
import { resolveDaemonServiceInstallRuntimeTarget } from './resolveDaemonServiceInstallRuntimeTarget';
import {
  normalizePublicReleaseRingId,
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
  targetMode?: DaemonServiceTargetMode;
  darwinInstallMode?: 'rebootstrap' | 'kickstart';
  instanceId?: string;
  strategy?: DaemonServiceInstallStrategy;
  serverUrl?: string;
  webappUrl?: string;
  publicServerUrl?: string;
  nodePath?: string;
  entryPath?: string;
  runCommands?: boolean;
  commandFailureMode?: DaemonServiceCommandFailureMode;
  startExisting?: boolean;
}> = {}): Promise<void> {
  const platformInput = options.platform ?? process.platform;
  const platform = resolveSupportedPlatform(platformInput);
  if (!platform) {
    throw new Error('Daemon service installation is currently only supported on macOS, Linux, and Windows');
  }
  assertDaemonServiceModeSupported(platform, options.mode === 'system' ? 'system' : 'user');

  const uid = options.uid ?? (process.getuid ? process.getuid() : undefined);
  const userHomeDir = options.userHomeDir ?? homedir();
  const happierHomeDir = options.happierHomeDir ?? configuration.happyHomeDir;
  const instanceId = options.instanceId ?? configuration.activeServerId;
  const envChannel = normalizePublicReleaseRingId(String(process.env.HAPPIER_DAEMON_SERVICE_CHANNEL ?? '').trim());
  const channel: PublicReleaseRingId = options.channel ?? (envChannel || 'stable');
  const targetMode: DaemonServiceTargetMode = options.targetMode ?? 'default-following';
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
    targetMode,
    processEnv: process.env,
  });
  const strategy: DaemonServiceInstallStrategy = options.strategy
    ?? resolveDaemonServiceInstallerStrategyFromEnv(process.env);

  const discoveredServices = await discoverInstalledDaemonServiceEntries({
    platform,
    userHomeDir,
    happierHomeDir,
    mode: options.mode === 'system' ? 'system' : 'user',
    serversById: {},
  });
  const target: DaemonServiceInstallTarget = {
    platform,
    targetMode,
    ring: channel,
    instanceId: targetMode === 'default-following' ? null : instanceId,
    happierHomeDir,
  };
  const conflictPlan = resolveDaemonServiceInstallConflictPlan({
    target,
    strategy,
    services: discoveredServices,
  });

  if (!conflictPlan.exactTargetExists && strategy === 'require-explicit' && conflictPlan.competingServices.length > 0) {
    const serviceList = conflictPlan.competingServices.map((service) => service.label).join(', ');
    throw createDaemonServiceConflictError(
      `Competing background services detected: ${serviceList}. Re-run with --yes or --replace-existing=ring|all.`,
      conflictPlan.competingServices,
    );
  }

  for (const service of conflictPlan.servicesToRemove) {
    await uninstallDaemonService({
      platform,
      uid,
      userHomeDir,
      happierHomeDir,
      mode: options.mode,
      channel: service.releaseChannel,
      targetMode: service.targetMode,
      instanceId: service.serverId,
      runCommands: options.runCommands,
      commandFailureMode: options.commandFailureMode,
    });
  }

  if (conflictPlan.exactTargetExists && options.startExisting !== true) {
    return;
  }

  const plan = planDaemonServiceInstall({
    platform,
      mode: options.mode,
      systemUser: options.systemUser,
      channel,
    targetMode,
    darwinInstallMode: options.darwinInstallMode,
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
  await applyDaemonServiceInstallPlan(plan, {
    runCommands: options.runCommands,
    commandFailureMode: options.commandFailureMode,
  });
}

function resolveDaemonServiceInstallerStrategyFromEnv(processEnv: NodeJS.ProcessEnv): DaemonServiceInstallStrategy {
  const raw = String(processEnv.HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY ?? '').trim().toLowerCase();
  if (raw === 'add') return 'add';
  if (raw === 'replace-ring') return 'replace-ring';
  if (raw === 'replace-all') return 'replace-all';
  return 'require-explicit';
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
  targetMode?: DaemonServiceTargetMode;
  instanceId?: string;
  runCommands?: boolean;
  commandFailureMode?: DaemonServiceCommandFailureMode;
}> = {}): Promise<void> {
  const platformInput = options.platform ?? process.platform;
  const platform = resolveSupportedPlatform(platformInput);
  if (!platform) {
    throw new Error('Daemon service uninstallation is currently only supported on macOS, Linux, and Windows');
  }
  assertDaemonServiceModeSupported(platform, options.mode === 'system' ? 'system' : 'user');

  const uid = options.uid ?? (process.getuid ? process.getuid() : undefined);
  const userHomeDir = options.userHomeDir ?? homedir();
  const happierHomeDir = options.happierHomeDir ?? configuration.happyHomeDir;
  const instanceId = options.instanceId ?? configuration.activeServerId;
  const envChannel = normalizePublicReleaseRingId(String(process.env.HAPPIER_DAEMON_SERVICE_CHANNEL ?? '').trim());
  const channel: PublicReleaseRingId = options.channel ?? (envChannel || 'stable');
  const targetMode: DaemonServiceTargetMode = options.targetMode ?? 'default-following';

  const plan = planDaemonServiceUninstall({
    platform,
    mode: options.mode,
    channel,
    targetMode,
    instanceId,
    uid,
    userHomeDir,
    happierHomeDir,
  });
  await applyDaemonServiceUninstallPlan(plan, {
    runCommands: options.runCommands,
    commandFailureMode: options.commandFailureMode,
  });
}
