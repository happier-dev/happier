import { homedir } from 'node:os';

import { configuration } from '@/configuration';

import {
  applyDaemonServiceInstallPlan,
  applyDaemonServiceUninstallPlan,
  type DaemonServiceCommandFailureMode,
} from './apply';
import {
  resolveDaemonServiceInstallConflictPlan,
  type DaemonServiceInstallConflictPlan,
  type DaemonServiceInstallStrategy,
  type DaemonServiceInstallTarget,
} from './daemonInstallConflict';
import { assertDaemonServiceModeSupported } from './assertDaemonServiceModeSupported';
import {
  discoverInstalledDaemonServiceEntries,
  type InstalledDaemonServiceEntry,
} from './discoverInstalledDaemonServiceEntries';
import { planDaemonServiceInstall, planDaemonServiceUninstall } from './plan';
import type { DaemonServiceMode, DaemonServiceTargetMode } from './plan';
import { resolveDaemonServiceInstallRuntimeTarget } from './resolveDaemonServiceInstallRuntimeTarget';
import { resolveDaemonServiceDiscoveryTargets } from './resolveDaemonServiceDiscoveryTargets';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import {
  DAEMON_SERVICE_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS,
  resolveManagedCliReleaseChannel,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { doesInstalledDaemonServiceDefinitionMatchExpected } from './doesInstalledDaemonServiceDefinitionMatchExpected';
import { resolveHappierHomeDirComparableKey } from '@/daemon/ownership/happierHomeDirComparableKey';

type SupportedPlatform = 'darwin' | 'linux' | 'win32';

function resolveSupportedPlatform(p: string): SupportedPlatform | null {
  if (p === 'darwin') return 'darwin';
  if (p === 'linux') return 'linux';
  if (p === 'win32') return 'win32';
  return null;
}

function formatDaemonServiceLabels(services: readonly { label: string }[]): string {
  return services.map((service) => service.label).join(', ');
}

async function resolveDaemonServiceReleaseChannel(params: Readonly<{
  channel?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<PublicReleaseRingId> {
  if (params.channel) return params.channel;
  return (await resolveManagedCliReleaseChannel({
    argv: process.argv,
    processEnv: params.processEnv ?? process.env,
    envKeys: DAEMON_SERVICE_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS,
    markerFallback: 'always',
  })).ringId;
}

export type DaemonServiceInstallConflictNotice = Readonly<{
  blocking: boolean;
  message: string;
}>;

export function describeDaemonServiceInstallConflict(params: Readonly<{
  exactTargetExists: boolean;
  strategy: DaemonServiceInstallStrategy;
  conflictPlan: DaemonServiceInstallConflictPlan;
}>): DaemonServiceInstallConflictNotice | null {
  if (params.conflictPlan.competingServices.length === 0) {
    return null;
  }
  if (params.conflictPlan.foreignHomeConflicts.length > 0) {
    return {
      blocking: true,
      message: `Conflicting background services from another Happier home were detected: ${formatDaemonServiceLabels(params.conflictPlan.foreignHomeConflicts)}. Switch to that installation to manage its service or remove it manually before installing here.`,
    };
  }

  const serviceList = formatDaemonServiceLabels(params.conflictPlan.competingServices);
  if (params.strategy === 'replace-all' || params.strategy === 'replace-ring') {
    const removedServiceList = formatDaemonServiceLabels(params.conflictPlan.servicesToRemove);
    if (removedServiceList) {
      return {
        blocking: false,
        message: `Would remove competing background services before install: ${removedServiceList}.`,
      };
    }
    return {
      blocking: false,
      message: `Competing background services detected: ${serviceList}. No installed services match the selected replacement scope.`,
    };
  }

  if (params.strategy === 'add') {
    return {
      blocking: false,
      message: `Competing background services detected: ${serviceList}. This install would add another background service; use --replace-existing=ring|all to clean up stale services instead.`,
    };
  }

  return {
    blocking: !params.conflictPlan.exactTargetIsConverged,
    message: `Competing background services detected: ${serviceList}. Re-run with --yes or --replace-existing=ring|all.`,
  };
}

export type DaemonServiceInstallPreview = Readonly<{
  exactTargetExists: boolean;
  exactTargetIsConverged: boolean;
  exactTargetMatchesExpectedDefinition: boolean;
  strategy: DaemonServiceInstallStrategy;
  conflictPlan: DaemonServiceInstallConflictPlan;
  plan: ReturnType<typeof planDaemonServiceInstall>;
}>;

export async function previewDaemonServiceInstall(options: Readonly<{
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
}> = {}): Promise<DaemonServiceInstallPreview> {
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
  const channel = await resolveDaemonServiceReleaseChannel({ channel: options.channel });
  const targetMode: DaemonServiceTargetMode = options.targetMode ?? 'default-following';
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
  const discoveredServices = (await Promise.all(
    resolveDaemonServiceDiscoveryTargets({
      platform,
      mode: options.mode,
      userHomeDir,
      happierHomeDir,
    }).map(async (target) => await discoverInstalledDaemonServiceEntries({
      platform,
      userHomeDir: target.userHomeDir,
      happierHomeDir: target.happierHomeDir,
      mode: target.mode,
      serversById: {},
    })),
  ))
    .flat()
    .filter((service, index, allServices) =>
      allServices.findIndex((candidate) => candidate.path === service.path) === index,
    );
  const target: DaemonServiceInstallTarget = {
    platform,
    mode: options.mode === 'system' ? 'system' : 'user',
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
  const expectedInstalledFile = previewPlanFileForTarget({
    plan,
  });
  const exactTargetMatchesExpectedDefinition = conflictPlan.exactTargetExists && (
    !expectedInstalledFile
    || discoveredServices
      .filter((service) => matchesInstallTarget(service, target))
      .some((service) => service.path === expectedInstalledFile.path && doesInstalledDaemonServiceDefinitionMatchExpected({
        installedPath: service.path,
        expectedContents: expectedInstalledFile.content,
      }))
  );

  return {
    exactTargetExists: conflictPlan.exactTargetExists,
    exactTargetIsConverged: conflictPlan.exactTargetIsConverged,
    exactTargetMatchesExpectedDefinition: Boolean(exactTargetMatchesExpectedDefinition),
    strategy,
    conflictPlan,
    plan,
  };
}

function previewPlanFileForTarget(params: Readonly<{
  plan: ReturnType<typeof planDaemonServiceInstall>;
}>): { path: string; content: string } | null {
  return params.plan.files[0]
    ? {
        path: params.plan.files[0].path,
        content: params.plan.files[0].content,
      }
    : null;
}

function matchesInstallTarget(
  service: InstalledDaemonServiceEntry,
  target: DaemonServiceInstallTarget,
): boolean {
  if (service.platform !== target.platform) {
    return false;
  }
  if ((service.mode ?? 'user') !== target.mode) {
    return false;
  }
  if (service.targetMode !== target.targetMode) {
    return false;
  }
  if (resolveHappierHomeDirComparableKey(service.happierHomeDir) !== resolveHappierHomeDirComparableKey(target.happierHomeDir)) {
    return false;
  }
  if (target.targetMode === 'default-following') {
    return service.releaseChannel === target.ring;
  }
  return service.releaseChannel === target.ring && service.serverId === target.instanceId;
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
}> = {}): Promise<void> {
  const platformInput = options.platform ?? process.platform;
  const platform = resolveSupportedPlatform(platformInput);
  if (!platform) {
    throw new Error('Daemon service installation is currently only supported on macOS, Linux, and Windows');
  }
  const uid = options.uid ?? (process.getuid ? process.getuid() : undefined);
  const userHomeDir = options.userHomeDir ?? homedir();
  const happierHomeDir = options.happierHomeDir ?? configuration.happyHomeDir;
  const preview = await previewDaemonServiceInstall(options);
  const conflictNotice = describeDaemonServiceInstallConflict({
    exactTargetExists: preview.exactTargetExists,
    strategy: preview.strategy,
    conflictPlan: preview.conflictPlan,
  });

  if (conflictNotice?.blocking) {
    throw createDaemonServiceConflictError(
      conflictNotice.message,
      preview.conflictPlan.competingServices,
    );
  }

  for (const service of preview.conflictPlan.servicesToRemove) {
    await uninstallDaemonService({
      platform,
      uid,
      userHomeDir,
      happierHomeDir,
      mode: service.mode,
      channel: service.releaseChannel,
      targetMode: service.targetMode,
      instanceId: service.serverId,
      installedPath: service.path,
      runCommands: options.runCommands,
      commandFailureMode: options.commandFailureMode,
    });
  }

  if (preview.exactTargetIsConverged && preview.exactTargetMatchesExpectedDefinition) {
    return;
  }
  await applyDaemonServiceInstallPlan(preview.plan, {
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
  installedPath?: string;
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
  const channel = await resolveDaemonServiceReleaseChannel({ channel: options.channel });
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
    installedPath: options.installedPath,
  });
  await applyDaemonServiceUninstallPlan(plan, {
    runCommands: options.runCommands,
    commandFailureMode: options.commandFailureMode,
  });
}
