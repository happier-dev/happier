import { homedir } from 'node:os';

import { configuration } from '@/configuration';
import {
  DAEMON_SERVICE_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS,
  resolveManagedCliReleaseChannel,
} from '@happier-dev/cli-common/firstPartyRuntime';

import {
  applyDaemonServiceInstallPlan,
  applyDaemonServiceUninstallPlan,
  type DaemonServiceCommandFailureMode,
} from './apply';
import {
  resolveDaemonServiceInstallConflictPlan,
  daemonServiceMatchesInstallTarget,
  type DaemonServiceInstallConflictPlan,
  type DaemonServiceInstallStrategy,
  type DaemonServiceInstallTarget,
} from './daemonInstallConflict';
import { assertDaemonServiceModeSupported } from './assertDaemonServiceModeSupported';
import { discoverInstalledDaemonServiceEntries } from './discoverInstalledDaemonServiceEntries';
import { planDaemonServiceInstall, planDaemonServiceUninstall, type DaemonServiceManagedBy } from './plan';
import type { DaemonServiceInstallEnablement, DaemonServiceMode, DaemonServiceTargetMode } from './plan';
import { resolveDaemonServiceInstallRuntimeTarget } from './resolveDaemonServiceInstallRuntimeTarget';
import { resolveDaemonServiceDiscoveryTargets } from './resolveDaemonServiceDiscoveryTargets';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { doesInstalledDaemonServiceDefinitionMatchExpected } from './doesInstalledDaemonServiceDefinitionMatchExpected';
import { resolveDaemonServiceIrohRelayConfig } from './resolveDaemonServiceIrohRelayConfig';
import { resolveDaemonServiceHomeCarrierPolicy } from './resolveDaemonServiceHomeCarrierPolicy';
import { readInstalledDaemonServiceInstallOptions, readInstalledDaemonServiceManagedBy } from './discoverInstalledDaemonServiceEntries';
import type { DaemonServiceAutostartMode } from './plan';
import type { IrohRelayEnvConfig } from '@happier-dev/iroh-native/node';
import type { HomeApplicationCarrierEligibility } from '@happier-dev/cli-common/homeEnrollment';
import { readBackgroundServiceActivity, readBackgroundServiceEnablement } from './readBackgroundServiceHealth';

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
  if (params.channel) {
    return params.channel;
  }
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
  const unverified = params.conflictPlan.competingServices.filter((service) => service.verification !== 'verified');
  if (unverified.length > 0) {
    return { blocking: true, message: `Background service ownership could not be verified: ${formatDaemonServiceLabels(unverified)}. Repair the service definition before installing here.` };
  }
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

/** One preservation owner for rewrites and repair's remove/reinstall/compensation. */
export function readDaemonServicePreservedInstallOptions(params: Readonly<{
  platform: SupportedPlatform;
  path: string;
  /** Passive repair preserves OS disablement; explicit install requests activation instead. */
  preserveEnablement?: Readonly<{ label: string; uid: number | null; mode?: DaemonServiceMode }>;
}>): Readonly<{
  autostart?: DaemonServiceAutostartMode;
  bundleId?: string | null;
  managedBy?: DaemonServiceManagedBy | null;
  irohRelayConfig: IrohRelayEnvConfig;
  homeCarrierEligibility?: HomeApplicationCarrierEligibility;
  enablement?: DaemonServiceInstallEnablement;
  preserveRunningWhenDisabled?: boolean;
}> {
  const installedService = { platform: params.platform, path: params.path };
  const options = {
    ...readInstalledDaemonServiceInstallOptions(installedService),
    managedBy: readInstalledDaemonServiceManagedBy(installedService),
    irohRelayConfig: resolveDaemonServiceIrohRelayConfig({ processEnv: {}, installedService }),
    homeCarrierEligibility: resolveDaemonServiceHomeCarrierPolicy({ processEnv: {}, installedService }),
  };
  if (!params.preserveEnablement) return options;
  const stateParams = { platform: params.platform, ...params.preserveEnablement };
  const enablement = readBackgroundServiceEnablement(stateParams);
  if (enablement === null) throw Object.assign(new Error(`Could not preserve OS enablement for background service ${stateParams.label}`), { code: 'service_inventory_unavailable' as const });
  if (enablement === 'enabled') return options;
  const activity = readBackgroundServiceActivity(stateParams);
  if (activity === 'unknown') throw Object.assign(new Error(`Could not preserve running state for disabled background service ${stateParams.label}`), { code: 'service_inventory_unavailable' as const });
  return { ...options, enablement, preserveRunningWhenDisabled: activity === 'active' };
}

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
  restartRunningDaemon?: boolean;
  /** `disabled`: keep a service the person turned off at login turned off (R12 convergence). */
  enablement?: DaemonServiceInstallEnablement;
  preserveRunningWhenDisabled?: boolean;
  instanceId?: string;
  activeServerId?: string;
  strategy?: DaemonServiceInstallStrategy;
  serverUrl?: string;
  webappUrl?: string;
  publicServerUrl?: string;
  nodePath?: string;
  entryPath?: string;
  irohRelayConfig?: IrohRelayEnvConfig;
  homeCarrierEligibility?: HomeApplicationCarrierEligibility;
  /** Omit to keep whatever marker the installed service carries (see `DaemonServiceManagedBy`). */
  managedBy?: DaemonServiceManagedBy;
  autostart?: DaemonServiceAutostartMode;
  bundleId?: string;
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
  const activeServerId = options.activeServerId ?? configuration.activeServerId;
  const channel = await resolveDaemonServiceReleaseChannel({
    channel: options.channel,
    processEnv: process.env,
  });
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
    channel,
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
    serverUrl: targetMode === 'pinned' ? publicServerUrl : null,
    followedServerId: targetMode === 'default-following' ? activeServerId : null,
  };
  const conflictPlan = resolveDaemonServiceInstallConflictPlan({
    target,
    strategy,
    services: discoveredServices,
  });
  const installedTarget = discoveredServices.find((service) => daemonServiceMatchesInstallTarget(service, target));
  const installedOptions = installedTarget ? readDaemonServicePreservedInstallOptions({ platform, path: installedTarget.path }) : null;
  const requestedIrohRelayConfig = resolveDaemonServiceIrohRelayConfig({ processEnv: process.env });
  const irohRelayConfig = requestedIrohRelayConfig.explicitlyConfigured
    ? requestedIrohRelayConfig
    : options.irohRelayConfig ?? installedOptions?.irohRelayConfig ?? requestedIrohRelayConfig;
  const homeCarrierEligibility = resolveDaemonServiceHomeCarrierPolicy({ processEnv: process.env })
    ?? options.homeCarrierEligibility
    ?? installedOptions?.homeCarrierEligibility;
  // Only an explicit request marks a service as the desktop's; every rewrite keeps the installed mark.
  const managedBy = options.managedBy ?? installedOptions?.managedBy;
  const installedAutostart = installedOptions?.autostart;
  const bundleId = options.bundleId ?? installedOptions?.bundleId;
  const autostart = options.autostart ?? installedAutostart;
  const buildPlan = (darwinInstallMode = options.darwinInstallMode, modeOptions: Readonly<{ autostart?: DaemonServiceAutostartMode; triggerOnly?: boolean }> = { autostart }) => planDaemonServiceInstall({
    platform,
    mode: options.mode,
    systemUser: options.systemUser,
    channel,
    targetMode,
    darwinInstallMode,
    enablement: options.enablement,
    preserveRunningWhenDisabled: options.preserveRunningWhenDisabled,
    instanceId,
    activeServerId,
    uid,
    userHomeDir,
    happierHomeDir,
    serverUrl,
    webappUrl,
    publicServerUrl,
    nodePath: runtimeTarget.nodePath,
    entryPath: runtimeTarget.entryPath,
    irohRelayConfig,
    homeCarrierEligibility,
    managedBy,
    bundleId,
    autostart: modeOptions.autostart,
    autostartTriggerChangeOnly: modeOptions.triggerOnly,
  });
  let plan = buildPlan();
  // Compare the whole prior definition: only a login-trigger change can preserve Linux activity.
  const priorFile = installedTarget && options.autostart ? buildPlan(options.darwinInstallMode, { autostart: installedAutostart }).files[0] : null;
  if (installedTarget && priorFile && options.restartRunningDaemon !== true
    && priorFile.path === installedTarget.path && doesInstalledDaemonServiceDefinitionMatchExpected({ installedPath: installedTarget.path, expectedContents: priorFile.content })) {
    plan = buildPlan(options.darwinInstallMode, { autostart, triggerOnly: true });
  }
  const expectedInstalledFile = previewPlanFileForTarget({
    plan,
  });
  const exactTargetMatchesExpectedDefinition = conflictPlan.exactTargetExists && (
    !expectedInstalledFile
    || discoveredServices
      .filter((service) => daemonServiceMatchesInstallTarget(service, target))
      .some((service) => service.path === expectedInstalledFile.path && doesInstalledDaemonServiceDefinitionMatchExpected({
        installedPath: service.path,
        expectedContents: expectedInstalledFile.content,
      }))
  );
  // kickstart runs launchd's loaded definition, not a newly written plist.
  if (platform === 'darwin' && options.darwinInstallMode === 'kickstart'
    && (!exactTargetMatchesExpectedDefinition || options.restartRunningDaemon === true || options.autostart !== undefined)) {
    plan = buildPlan('rebootstrap');
  }

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
  restartRunningDaemon?: boolean;
  /** `disabled`: keep a service the person turned off at login turned off (R12 convergence). */
  enablement?: DaemonServiceInstallEnablement;
  preserveRunningWhenDisabled?: boolean;
  instanceId?: string;
  activeServerId?: string;
  strategy?: DaemonServiceInstallStrategy;
  serverUrl?: string;
  webappUrl?: string;
  publicServerUrl?: string;
  nodePath?: string;
  entryPath?: string;
  irohRelayConfig?: IrohRelayEnvConfig;
  homeCarrierEligibility?: HomeApplicationCarrierEligibility;
  /** See `previewDaemonServiceInstall`: omitted keeps the installed marker. */
  managedBy?: DaemonServiceManagedBy;
  runCommands?: boolean;
  bundleId?: string;
  autostart?: DaemonServiceAutostartMode;
  /** Prepare the current owner only when installation will actually change its definition. */
  beforeApply?: () => Promise<void>;
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

  if (preview.exactTargetIsConverged && preview.exactTargetMatchesExpectedDefinition
    && options.restartRunningDaemon !== true && options.autostart === undefined) {
    return;
  }
  await options.beforeApply?.();
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
  const channel = await resolveDaemonServiceReleaseChannel({
    channel: options.channel,
    processEnv: process.env,
  });
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
