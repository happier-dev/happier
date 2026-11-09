import { basename, join, win32 as win32Path } from 'node:path';

import { getReleaseRingCatalogEntry, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import {
  IROH_RELAY_POLICY_ENV_KEY,
  IROH_RELAY_URLS_ENV_KEY,
  type IrohRelayEnvConfig,
} from '@happier-dev/iroh-native/node';
import { HOME_CARRIER_POLICY_ENV_KEY, type HomeApplicationCarrierEligibility } from '@happier-dev/cli-common/homeEnrollment';
import { FIRST_PARTY_INSTALL_HOME_ENV_KEY, resolveFirstPartyInstallHomeDir, validateDesktopBundleId } from '@happier-dev/cli-common/firstPartyRuntime';

import { buildLaunchAgentPlistXml, buildLaunchdPath } from './darwin';
import {
  buildServicePath,
  buildSetWindowsScheduledTaskEnabledPowerShellCommand,
  HAPPIER_CRITICAL_SLICE_NAME,
  planServiceAction,
  renderSystemdServiceUnit,
  renderWindowsScheduledTaskWrapperPs1,
  type PlannedCommand, type ServiceDefinitionRemoval, resolveServiceBackend, type PlannedCopy,
} from '@happier-dev/cli-common/service';
import { isServerIdFilesystemSafe } from '@/server/serverId';
import { resolveDaemonWindowsServiceLauncherInstallSpec } from './windowsServiceLauncher';

export type DaemonServicePlatform = 'darwin' | 'linux' | 'win32';
export type DaemonServiceMode = 'user' | 'system';
export type DaemonServiceTargetMode = 'pinned' | 'default-following';
/** Login-start preference; manual service start/stop remains independent. */
export type DaemonServiceAutostartMode = 'at-login' | 'on-demand';
export const DAEMON_SERVICE_AUTOSTART_ENV_KEY = 'HAPPIER_DAEMON_SERVICE_AUTOSTART';
export const DAEMON_SERVICE_BUNDLE_ID_ENV_KEY = 'HAPPIER_DAEMON_SERVICE_BUNDLE_ID';

export function parseDaemonServiceBundleId(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  return validateDesktopBundleId(value);
}

export function parseDaemonServiceAutostartMode(raw: string | null | undefined): DaemonServiceAutostartMode | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (value === 'at-login' || value === 'on-demand') return value;
  throw new Error(`Invalid --autostart value ${JSON.stringify(value)} (expected at-login|on-demand)`);
}

/**
 * Who manages an installed service. `desktop`: the desktop app created it (its setup or repair for
 * a server) and may change or remove it. `null`: no marker — the user installed it, and the app
 * leaves it alone. Requested on `service install` through the same-named env key and recorded in
 * the definition itself, so every later rewrite keeps it.
 */
export type DaemonServiceManagedBy = 'desktop';
export const DAEMON_SERVICE_MANAGED_BY_ENV_KEY = 'HAPPIER_DAEMON_SERVICE_MANAGED_BY';

/** `null` for an absent value; throws for anything but `desktop`, so a typo never installs a user-owned service silently. */
export function parseDaemonServiceManagedBy(raw: string | null | undefined): DaemonServiceManagedBy | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (value === 'desktop') return 'desktop';
  throw new Error(`invalid ${DAEMON_SERVICE_MANAGED_BY_ENV_KEY}: ${value} (expected "desktop")`);
}

export type DaemonServicePlannedFile = Readonly<{
  path: string;
  content: string;
  mode: number;
}>;

export type DaemonServicePlannedCommand = PlannedCommand & Readonly<{
  ignoreFailure?: boolean;
  /** Restore service state even if an earlier required command failed. */
  runOnFailure?: boolean;
}>;

export type DaemonServiceInstallPlan = Readonly<{
  platform: DaemonServicePlatform;
  files: DaemonServicePlannedFile[];
  copies?: PlannedCopy[];
  commands: DaemonServicePlannedCommand[];
}>;

export type DaemonServiceUninstallPlan = Readonly<{
  platform: DaemonServicePlatform;
  filesToRemove: string[];
  removals?: ServiceDefinitionRemoval[];
  commands: DaemonServicePlannedCommand[];
}>;

const DAEMON_SERVICE_LAUNCHD_LABEL_PREFIX = 'com.happier.cli.daemon';
const DAEMON_SERVICE_SYSTEMD_UNIT_PREFIX = 'happier-daemon';

const LEGACY_DAEMON_SERVICE_LAUNCHD_LABEL = 'com.happier.cli.daemon';
const LEGACY_DAEMON_SERVICE_SYSTEMD_UNIT_NAME = 'happier-daemon.service';

export function resolveDaemonServiceChannelSegment(channel: PublicReleaseRingId): '' | 'preview' | 'dev' {
  const label = getReleaseRingCatalogEntry(channel).publicLabel;
  return label === 'stable' ? '' : label;
}

function resolveLegacyChannelScopedDefaultFollowingIdentitySegment(channel: PublicReleaseRingId): string | null {
  const channelSegment = resolveDaemonServiceChannelSegment(channel);
  return channelSegment ? `${channelSegment}.default` : null;
}

export function sanitizeServiceInstanceId(instanceIdRaw: string): string {
  const value = String(instanceIdRaw ?? '').trim();
  if (!value) {
    throw new Error('Daemon service instance id is required');
  }
  // Keep launchd labels / unit names filesystem-safe and deterministic.
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
}

function resolveDaemonServiceIdentitySegment(params: Readonly<{
  instanceId: string;
  channel: PublicReleaseRingId;
  targetMode: DaemonServiceTargetMode;
}>): string {
  if (params.targetMode === 'default-following') {
    return 'default';
  }
  const rawInstanceId = String(params.instanceId ?? '').trim();
  const instanceId = sanitizeServiceInstanceId(rawInstanceId);
  const channelSegment = resolveDaemonServiceChannelSegment(params.channel);
  return channelSegment
    ? `${channelSegment}.${instanceId}`
    : instanceId;
}

function shouldApplyRawLegacyDefaultFollowingCleanup(params: Readonly<{
  targetMode: DaemonServiceTargetMode;
}>): boolean {
  return params.targetMode === 'default-following';
}

function shouldApplyLegacyChannelScopedDefaultFollowingCleanup(params: Readonly<{
  channel: PublicReleaseRingId;
  targetMode: DaemonServiceTargetMode;
}>): boolean {
  return params.targetMode === 'default-following'
    && resolveLegacyChannelScopedDefaultFollowingIdentitySegment(params.channel) !== null;
}

export function resolveDaemonServiceLaunchdLabel(
  instanceIdRaw: string,
  channel: PublicReleaseRingId = 'stable',
  targetMode: DaemonServiceTargetMode = 'pinned',
): string {
  return `${DAEMON_SERVICE_LAUNCHD_LABEL_PREFIX}.${resolveDaemonServiceIdentitySegment({
    instanceId: instanceIdRaw,
    channel,
    targetMode,
  })}`;
}

export function resolveDaemonServiceSystemdUnitLabel(
  instanceIdRaw: string,
  channel: PublicReleaseRingId = 'stable',
  targetMode: DaemonServiceTargetMode = 'pinned',
): string {
  return `${DAEMON_SERVICE_SYSTEMD_UNIT_PREFIX}.${resolveDaemonServiceIdentitySegment({
    instanceId: instanceIdRaw,
    channel,
    targetMode,
  })}`;
}

export function resolveDaemonServiceSystemdUnitName(
  instanceIdRaw: string,
  channel: PublicReleaseRingId = 'stable',
  targetMode: DaemonServiceTargetMode = 'pinned',
): string {
  return `${resolveDaemonServiceSystemdUnitLabel(instanceIdRaw, channel, targetMode)}.service`;
}

export function resolveLaunchAgentPlistPath(params: Readonly<{
  userHomeDir: string;
  instanceId: string;
  channel?: PublicReleaseRingId;
  targetMode?: DaemonServiceTargetMode;
}>): string {
  const label = resolveDaemonServiceLaunchdLabel(params.instanceId, params.channel ?? 'stable', params.targetMode ?? 'pinned');
  return join(params.userHomeDir, 'Library', 'LaunchAgents', `${label}.plist`);
}

export function resolveSystemdUserUnitPath(params: Readonly<{
  userHomeDir: string;
  instanceId: string;
  channel?: PublicReleaseRingId;
  targetMode?: DaemonServiceTargetMode;
}>): string {
  const unitName = resolveDaemonServiceSystemdUnitName(params.instanceId, params.channel ?? 'stable', params.targetMode ?? 'pinned');
  return join(params.userHomeDir, '.config', 'systemd', 'user', unitName);
}

export function resolveSystemdSystemUnitPath(params: Readonly<{
  instanceId: string;
  channel?: PublicReleaseRingId;
  targetMode?: DaemonServiceTargetMode;
}>): string {
  const unitName = resolveDaemonServiceSystemdUnitName(params.instanceId, params.channel ?? 'stable', params.targetMode ?? 'pinned');
  return join('/etc', 'systemd', 'system', unitName);
}

export function resolveWindowsDaemonTaskName(params: Readonly<{
  instanceId: string;
  channel?: PublicReleaseRingId;
  targetMode?: DaemonServiceTargetMode;
}>): string {
  const label = resolveDaemonServiceSystemdUnitLabel(params.instanceId, params.channel ?? 'stable', params.targetMode ?? 'pinned');
  return `Happier\\${label}`;
}

export function resolveWindowsDaemonWrapperPath(params: Readonly<{
  happierHomeDir: string;
  instanceId: string;
  channel?: PublicReleaseRingId;
  targetMode?: DaemonServiceTargetMode;
}>): string {
  const label = resolveDaemonServiceSystemdUnitLabel(
    params.instanceId,
    params.channel ?? 'stable',
    params.targetMode ?? 'pinned',
  );
  const home = String(params.happierHomeDir ?? '').trim();
  // When callers supply a POSIX absolute path (common in unit tests on macOS/Linux),
  // `win32.join("/tmp/...", ...)` yields a leading `\\tmp\\...` path which is relative on POSIX and can
  // accidentally write into the repo CWD. Treat POSIX absolute paths as POSIX paths.
  if (home.startsWith('/')) {
    return join(home, 'services', `${label}.ps1`);
  }
  return win32Path.join(home, 'services', `${label}.ps1`);
}

/**
 * Resolve the stdout/stderr log paths that the Windows scheduled-task wrapper
 * redirects into. This is the canonical path computation for both wrapper
 * rendering and post-mortem diagnostics, so those two call sites cannot drift.
 */
export function resolveWindowsDaemonServiceLogPaths(params: Readonly<{
  happierHomeDir: string;
  instanceId: string;
  channel?: PublicReleaseRingId;
  targetMode?: DaemonServiceTargetMode;
}>): { stdoutPath: string; stderrPath: string } {
  const channel = params.channel ?? 'stable';
  const targetMode = params.targetMode ?? 'pinned';
  const sanitizedInstanceId = sanitizeServiceInstanceId(params.instanceId);
  const logInstanceId = targetMode === 'default-following' ? 'default' : sanitizedInstanceId;
  const logPrefix = targetMode === 'default-following'
    ? ''
    : (() => {
        const channelSegment = resolveDaemonServiceChannelSegment(channel);
        return channelSegment ? `${channelSegment}.` : '';
      })();
  const home = String(params.happierHomeDir ?? '').trim();
  const usePosix = home.startsWith('/');
  const joinFn = usePosix ? join : win32Path.join;
  return {
    stdoutPath: joinFn(home, 'logs', `daemon-service.${logPrefix}${logInstanceId}.out.log`),
    stderrPath: joinFn(home, 'logs', `daemon-service.${logPrefix}${logInstanceId}.err.log`),
  };
}

function buildDaemonServiceProgramArgs(params: Readonly<{ nodePath: string; entryPath: string }>): string[] {
  const nodePath = String(params.nodePath ?? '').trim();
  if (!nodePath) throw new Error('nodePath is required');
  const entryPath = String(params.entryPath ?? '').trim();
  // `--takeover` is always set on service-managed daemon starts: the
  // background service is the legitimate owner of its relay profile, so if
  // a manual daemon squatted the lock (e.g. running from an older CLI) the
  // service should displace it on next launch. Without this, launchd
  // respawns indefinitely and the service appears "stopped" to users even
  // though it's actively crash-looping (see crash_looping finding).
  // Policy: to run a manual daemon yourself, stop the background service
  // first — it won't be respawning to fight you.
  if (entryPath) return [nodePath, entryPath, 'daemon', 'start-sync', '--takeover'];
  return [nodePath, 'daemon', 'start-sync', '--takeover'];
}

function resolvePinnedActiveServerId(params: Readonly<{
  targetMode: DaemonServiceTargetMode;
  activeServerId?: string | null;
}>): string | null {
  if (params.targetMode === 'default-following') {
    return null;
  }
  const activeServerId = String(params.activeServerId ?? '').trim();
  if (!activeServerId) {
    throw new Error('Pinned daemon service plans require an explicit active server id');
  }
  if (!isServerIdFilesystemSafe(activeServerId)) {
    throw new Error(`Pinned daemon service active server id is not filesystem-safe: ${activeServerId}`);
  }
  return activeServerId;
}

export type DaemonServiceInstallEnablement = 'enabled' | 'disabled';

export function planDaemonServiceInstall(params: Readonly<{
  platform: DaemonServicePlatform;
  mode?: DaemonServiceMode;
  systemUser?: string;
  channel?: PublicReleaseRingId;
  targetMode?: DaemonServiceTargetMode;
  darwinInstallMode?: 'rebootstrap' | 'kickstart';
  autostart?: DaemonServiceAutostartMode;
  /** A proven trigger-only rewrite need not restart the Linux daemon. */
  autostartTriggerChangeOnly?: boolean;
  bundleId?: string | null;
  /**
   * `disabled` keeps a service the person turned off at login turned off (R12 convergence rewrites
   * its launcher only). A stopped service stays stopped; a running one can be restarted below.
   */
  enablement?: DaemonServiceInstallEnablement;
  /** Preserve a running OS service independently from its login enablement. */
  preserveRunningWhenDisabled?: boolean;
  instanceId: string;
  activeServerId?: string | null;
  userHomeDir: string;
  happierHomeDir: string;
  firstPartyInstallHome?: string;
  serverUrl: string;
  webappUrl: string;
  publicServerUrl: string;
  nodePath: string;
  entryPath: string;
  irohRelayConfig?: IrohRelayEnvConfig;
  homeCarrierEligibility?: HomeApplicationCarrierEligibility;
  /** Recorded in the definition when set; see `DaemonServiceManagedBy`. */
  managedBy?: DaemonServiceManagedBy | null;
  uid?: number;
}>): DaemonServiceInstallPlan {
  const rawInstanceId = String(params.instanceId ?? '').trim();
  const instanceId = sanitizeServiceInstanceId(rawInstanceId);
  const channel: PublicReleaseRingId = params.channel ?? 'stable';
  const targetMode: DaemonServiceTargetMode = params.targetMode ?? 'pinned';
  const autostart = params.autostart ?? 'at-login';
  const bundleId = parseDaemonServiceBundleId(params.bundleId);
  const activeServerId = resolvePinnedActiveServerId({
    targetMode,
    activeServerId: params.activeServerId,
  });
  const publicReleaseChannel = getReleaseRingCatalogEntry(channel).publicLabel;
  const logInstanceId = targetMode === 'default-following' ? 'default' : instanceId;
  const logPrefix = targetMode === 'default-following'
    ? ''
    : (() => {
        const channelSegment = resolveDaemonServiceChannelSegment(channel);
        return channelSegment ? `${channelSegment}.` : '';
      })();
  const label = resolveDaemonServiceLaunchdLabel(instanceId, channel, targetMode);
  const unitLabel = resolveDaemonServiceSystemdUnitLabel(instanceId, channel, targetMode);
  const unitName = resolveDaemonServiceSystemdUnitName(instanceId, channel, targetMode);
  const programArgs = buildDaemonServiceProgramArgs({ nodePath: params.nodePath, entryPath: params.entryPath });
  const baseEnv: Record<string, string> = {
    HAPPIER_HOME_DIR: params.happierHomeDir,
    ...(params.firstPartyInstallHome?.trim()
      ? { [FIRST_PARTY_INSTALL_HOME_ENV_KEY]: resolveFirstPartyInstallHomeDir({
          HAPPIER_HOME_DIR: params.happierHomeDir,
          HOME: params.userHomeDir,
          USERPROFILE: params.userHomeDir,
          [FIRST_PARTY_INSTALL_HOME_ENV_KEY]: params.firstPartyInstallHome,
        }) }
      : {}),
    HAPPIER_PUBLIC_RELEASE_CHANNEL: publicReleaseChannel,
    HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
    HAPPIER_DAEMON_SERVICE_LABEL: label,
    HAPPIER_DAEMON_SERVICE_TARGET_MODE: targetMode,
    HAPPIER_NO_BROWSER_OPEN: '1',
    HAPPIER_DAEMON_WAIT_FOR_AUTH: '1',
    HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS: '0',
    ...(params.irohRelayConfig?.explicitlyConfigured
      ? {
          [IROH_RELAY_POLICY_ENV_KEY]: params.irohRelayConfig.relayPolicy,
          ...(params.irohRelayConfig.relayUrls.length > 0
            ? { [IROH_RELAY_URLS_ENV_KEY]: params.irohRelayConfig.relayUrls.join(',') }
            : {}),
        }
      : {}),
    ...(params.homeCarrierEligibility
      ? { [HOME_CARRIER_POLICY_ENV_KEY]: params.homeCarrierEligibility }
      : {}),
    ...(params.managedBy ? { [DAEMON_SERVICE_MANAGED_BY_ENV_KEY]: params.managedBy } : {}),
    // An explicit preference makes trigger-only changes visible to definition convergence.
    // Omitted legacy/terminal defaults keep their existing serialization.
    ...(params.autostart ? { [DAEMON_SERVICE_AUTOSTART_ENV_KEY]: params.autostart } : {}),
    ...(bundleId ? { [DAEMON_SERVICE_BUNDLE_ID_ENV_KEY]: bundleId } : {}),
  };
  const pinnedTargetEnv: Record<string, string> = targetMode === 'default-following'
    ? {}
    : {
        HAPPIER_ACTIVE_SERVER_ID: activeServerId ?? '',
        HAPPIER_SERVER_URL: params.serverUrl,
        HAPPIER_WEBAPP_URL: params.webappUrl,
        HAPPIER_PUBLIC_SERVER_URL: params.publicServerUrl,
      };

  if (params.platform === 'darwin') {
    const plistPath = resolveLaunchAgentPlistPath({ userHomeDir: params.userHomeDir, instanceId, channel, targetMode });
    const stdoutPath = join(params.happierHomeDir, 'logs', `daemon-service.${logPrefix}${logInstanceId}.out.log`);
    const stderrPath = join(params.happierHomeDir, 'logs', `daemon-service.${logPrefix}${logInstanceId}.err.log`);

    const env: Record<string, string> = {
      PATH: buildLaunchdPath({ execPath: params.nodePath, homeDir: params.userHomeDir }),
      ...baseEnv,
      ...pinnedTargetEnv,
    };

    const xml = buildLaunchAgentPlistXml({
      label,
      programArgs,
      env,
      stdoutPath,
      stderrPath,
      abandonProcessGroup: true,
      workingDirectory: '/tmp',
      runAtLoad: autostart === 'at-login',
      // SuccessfulExit KeepAlive implicitly arms RunAtLoad on macOS.
      keepAliveOnFailure: autostart === 'at-login',
      ...(bundleId ? { associatedBundleIdentifiers: [bundleId] } : {}),
    });

    const uid = params.uid;
    const commands: DaemonServicePlannedCommand[] = [];
    if (typeof uid === 'number' && uid > 0 && params.enablement === 'disabled' && !params.preserveRunningWhenDisabled) {
      // launchd keeps "disabled" in its override database (`launchctl disable`, read back by
      // `launchctl print-disabled`); a disabled job cannot be loaded, so it is unloaded and stays off.
      commands.push({ cmd: 'launchctl', args: ['bootout', `gui/${uid}/${label}`], ignoreFailure: true });
      commands.push({ cmd: 'launchctl', args: ['disable', `gui/${uid}/${label}`] });
    } else if (typeof uid === 'number' && uid > 0) {
      if (params.darwinInstallMode === 'kickstart') {
        commands.push({ cmd: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/${label}`] });
      } else {
      // Back-compat: if the legacy (non-instance) service is enabled, disable it so it won't auto-load on login.
        if (shouldApplyRawLegacyDefaultFollowingCleanup({ targetMode })) {
          commands.push({ cmd: 'launchctl', args: ['bootout', `gui/${uid}/${LEGACY_DAEMON_SERVICE_LAUNCHD_LABEL}`] });
          commands.push({ cmd: 'launchctl', args: ['disable', `gui/${uid}/${LEGACY_DAEMON_SERVICE_LAUNCHD_LABEL}`] });
        }
        commands.push({ cmd: 'launchctl', args: ['bootout', `gui/${uid}/${label}`] });
        commands.push({ cmd: 'launchctl', args: ['enable', `gui/${uid}/${label}`] });
        commands.push({ cmd: 'launchctl', args: ['bootstrap', `gui/${uid}`, plistPath] });
        commands.push({ cmd: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/${label}`] });
      }
      if (params.enablement === 'disabled') {
        commands.push({ cmd: 'launchctl', args: ['disable', `gui/${uid}/${label}`], runOnFailure: true });
      }
    }

    return {
      platform: 'darwin',
      files: [{ path: plistPath, content: xml, mode: 0o644 }],
      commands,
    };
  }

  if (params.platform === 'win32') {
    const wrapperPath = resolveWindowsDaemonWrapperPath({
      happierHomeDir: params.happierHomeDir,
      instanceId,
      channel,
      targetMode,
    });
    const { stdoutPath, stderrPath } = resolveWindowsDaemonServiceLogPaths({
      happierHomeDir: params.happierHomeDir,
      instanceId,
      channel,
      targetMode,
    });

    const wrapper = renderWindowsScheduledTaskWrapperPs1({
      workingDirectory: params.userHomeDir,
      programArgs,
      env: {
        ...baseEnv,
        ...pinnedTargetEnv,
      },
      stdoutPath,
      stderrPath,
    });

    const taskName = resolveWindowsDaemonTaskName({ instanceId, channel, targetMode });
    const basePlan = planServiceAction({
      backend: 'schtasks-user',
      action: 'install',
      label: unitLabel,
      definitionPath: wrapperPath,
      definitionContents: wrapper,
      taskName,
      windowsLauncher: resolveDaemonWindowsServiceLauncherInstallSpec(),
      persistent: autostart === 'at-login',
    });

    const commands: DaemonServicePlannedCommand[] = [];
    if (shouldApplyRawLegacyDefaultFollowingCleanup({ targetMode })) {
      const legacyUnitLabel = DAEMON_SERVICE_SYSTEMD_UNIT_PREFIX;
      commands.push({ cmd: 'schtasks', args: ['/End', '/TN', `Happier\\${legacyUnitLabel}`], ignoreFailure: true });
      commands.push({ cmd: 'schtasks', args: ['/Delete', '/F', '/TN', `Happier\\${legacyUnitLabel}`], ignoreFailure: true });
      // Note: legacy wrapper path is best-effort removed via filesToRemove on uninstall.
    }
    if (params.enablement === 'disabled') {
      // Restore login enablement independently from whether the existing task was running.
      commands.push(...basePlan.commands
        .filter((c) => params.preserveRunningWhenDisabled || !(c.cmd === 'schtasks' && c.args[0] === '/Run'))
        .map((c) => ({ cmd: c.cmd, args: c.args })));
      commands.push({
        cmd: 'powershell.exe',
        runOnFailure: true,
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          buildSetWindowsScheduledTaskEnabledPowerShellCommand({ qualifiedTaskName: taskName, enabled: false })],
      });
    } else {
      commands.push(...basePlan.commands.map((c) => ({ cmd: c.cmd, args: c.args })));
    }

    return {
      platform: 'win32',
      files: [{ path: wrapperPath, content: wrapper, mode: 0o644 }],
      copies: basePlan.copies,
      commands,
    };
  }

  const mode: DaemonServiceMode = params.mode === 'system' ? 'system' : 'user';
  const prefix = mode === 'system' ? [] : ['--user'];
  const systemUser = String(params.systemUser ?? '').trim();
  if (mode === 'system' && !systemUser) {
    throw new Error('systemUser is required');
  }

  const unitPath = mode === 'system'
    ? resolveSystemdSystemUnitPath({ instanceId, channel, targetMode })
    : resolveSystemdUserUnitPath({ userHomeDir: params.userHomeDir, instanceId, channel, targetMode });

  const unit = renderSystemdServiceUnit({
    description: targetMode === 'default-following' ? 'Happier CLI daemon (default)' : `Happier CLI daemon (${instanceId})`,
    execStart: programArgs,
    workingDirectory: mode === 'system' ? params.userHomeDir : '%h',
    env: {
      PATH: buildServicePath({ execPath: params.nodePath, homeDir: params.userHomeDir, platform: 'linux' }),
      ...baseEnv,
      ...pinnedTargetEnv,
    },
    killMode: 'process',
    umask: '0002',
    // The managed Linux guest provisions this user slice with a bounded
    // The managed Linux guest gives this slice a MemoryLow reservation. Future
    // daemon-owned control processes join it without a memory ceiling.
    slice: mode === 'user' ? HAPPIER_CRITICAL_SLICE_NAME : undefined,
    managedOomPreference: 'avoid',
    restart: 'on-failure',
    runAsUser: mode === 'system' ? systemUser : '',
    wantedBy: mode === 'system' ? 'multi-user.target' : 'default.target',
  });

  const commands: DaemonServicePlannedCommand[] = [{ cmd: 'systemctl', args: [...prefix, 'daemon-reload'] }];
  if (shouldApplyRawLegacyDefaultFollowingCleanup({ targetMode })) {
    commands.push({
      cmd: 'systemctl',
      args: [...prefix, 'disable', '--now', LEGACY_DAEMON_SERVICE_SYSTEMD_UNIT_NAME],
      ignoreFailure: true,
    });
  }
  if (params.enablement === 'disabled') {
    // Repair may have removed a previously running unit. Resume that observed activity explicitly;
    // otherwise try-restart never starts a stopped unit, while refreshing one still running.
    commands.push({ cmd: 'systemctl', args: [...prefix, 'disable', unitName] });
    commands.push({ cmd: 'systemctl', args: [...prefix, params.preserveRunningWhenDisabled ? 'restart' : 'try-restart', unitName] });
  } else {
    commands.push({ cmd: 'systemctl', args: [...prefix, autostart === 'at-login' ? 'enable' : 'disable', unitName] });
    if (!params.autostartTriggerChangeOnly) commands.push({ cmd: 'systemctl', args: [...prefix, 'restart', unitName] });
  }

  return {
    platform: 'linux',
    files: [{ path: unitPath, content: unit, mode: 0o644 }],
    commands,
  };
}

export function planDaemonServiceUninstall(params: Readonly<{
  platform: DaemonServicePlatform;
  mode?: DaemonServiceMode;
  channel?: PublicReleaseRingId;
  targetMode?: DaemonServiceTargetMode;
  instanceId: string;
  userHomeDir: string;
  happierHomeDir?: string;
  installedPath?: string;
  uid?: number;
}>): DaemonServiceUninstallPlan {
  const instanceId = sanitizeServiceInstanceId(params.instanceId);
  const channel: PublicReleaseRingId = params.channel ?? 'stable';
  const targetMode: DaemonServiceTargetMode = params.targetMode ?? 'pinned';
  const installedPath = String(params.installedPath ?? '').trim() || null;

  // Platform lifecycle and deletion ordering are owned by cli-common, including legacy jobs.
  function finish(candidatePaths: string[]): DaemonServiceUninstallPlan {
    const filesToRemove = [...new Set(installedPath ? [installedPath] : candidatePaths)];
    const commands: PlannedCommand[] = [];
    const removals: ServiceDefinitionRemoval[] = [];
    for (const path of filesToRemove) {
      const pathApi = params.platform === 'win32' ? win32Path : { basename };
      const extension = params.platform === 'win32' ? '.ps1' : params.platform === 'darwin' ? '.plist' : '.service';
      const serviceLabel = pathApi.basename(path, extension);
      const plan = planServiceAction({
        backend: resolveServiceBackend({ platform: params.platform, mode: params.mode }),
        action: 'uninstall', label: serviceLabel, definitionPath: path,
        taskName: `Happier\\${serviceLabel}`, uid: params.uid,
      });
      const offset = commands.length;
      commands.push(...plan.commands);
      removals.push(...(plan.removals ?? []).map((removal) => ({ ...removal, beforeCommandIndex: offset + removal.beforeCommandIndex })));
    }
    return { platform: params.platform, filesToRemove, commands, removals };
  }

  if (params.platform === 'darwin') {
    const plistPath = installedPath || resolveLaunchAgentPlistPath({ userHomeDir: params.userHomeDir, instanceId, channel, targetMode });
    const filesToRemove = [
      plistPath,
      ...(shouldApplyLegacyChannelScopedDefaultFollowingCleanup({ channel, targetMode })
        ? (() => {
            const legacyIdentitySegment = resolveLegacyChannelScopedDefaultFollowingIdentitySegment(channel);
            const legacyPath = legacyIdentitySegment
              ? join(params.userHomeDir, 'Library', 'LaunchAgents', `${DAEMON_SERVICE_LAUNCHD_LABEL_PREFIX}.${legacyIdentitySegment}.plist`)
              : null;
            return legacyPath && legacyPath !== plistPath
              ? [legacyPath]
              : [];
          })()
        : []),
      ...(shouldApplyRawLegacyDefaultFollowingCleanup({ targetMode })
        ? [join(params.userHomeDir, 'Library', 'LaunchAgents', `${LEGACY_DAEMON_SERVICE_LAUNCHD_LABEL}.plist`)]
        : []),
    ];
    return finish(filesToRemove);
  }

  if (params.platform === 'win32') {
    const happierHomeDir = String(params.happierHomeDir ?? '').trim();
    if (!happierHomeDir) {
      throw new Error('happierHomeDir is required for Windows service uninstall');
    }
    const wrapperPath = installedPath || resolveWindowsDaemonWrapperPath({ happierHomeDir, instanceId, channel, targetMode });
    const filesToRemove = [wrapperPath];
    if (shouldApplyLegacyChannelScopedDefaultFollowingCleanup({ channel, targetMode })) {
      const legacyIdentitySegment = resolveLegacyChannelScopedDefaultFollowingIdentitySegment(channel);
      if (legacyIdentitySegment) {
        const legacyPath = win32Path.join(happierHomeDir, 'services', `${DAEMON_SERVICE_SYSTEMD_UNIT_PREFIX}.${legacyIdentitySegment}.ps1`);
        if (legacyPath !== wrapperPath) {
          filesToRemove.push(legacyPath);
        }
      }
    }
    if (shouldApplyRawLegacyDefaultFollowingCleanup({ targetMode })) {
      filesToRemove.push(win32Path.join(happierHomeDir, 'services', `${DAEMON_SERVICE_SYSTEMD_UNIT_PREFIX}.ps1`));
    }
    return finish(filesToRemove);
  }

  const mode: DaemonServiceMode = params.mode === 'system' ? 'system' : 'user';
  const unitPath = installedPath || (mode === 'system'
    ? resolveSystemdSystemUnitPath({ instanceId, channel, targetMode })
    : resolveSystemdUserUnitPath({ userHomeDir: params.userHomeDir, instanceId, channel, targetMode }));
  const legacyScopedDefaultUnitName = shouldApplyLegacyChannelScopedDefaultFollowingCleanup({ channel, targetMode })
    ? (() => {
        const legacyIdentitySegment = resolveLegacyChannelScopedDefaultFollowingIdentitySegment(channel);
        return legacyIdentitySegment ? `${DAEMON_SERVICE_SYSTEMD_UNIT_PREFIX}.${legacyIdentitySegment}.service` : null;
      })()
    : null;
  const legacyScopedDefaultUnitPath = legacyScopedDefaultUnitName
    ? mode === 'system'
      ? join('/etc', 'systemd', 'system', legacyScopedDefaultUnitName)
      : join(params.userHomeDir, '.config', 'systemd', 'user', legacyScopedDefaultUnitName)
    : null;
  const legacyUnitPath = mode === 'system'
    ? join('/etc', 'systemd', 'system', LEGACY_DAEMON_SERVICE_SYSTEMD_UNIT_NAME)
    : join(params.userHomeDir, '.config', 'systemd', 'user', LEGACY_DAEMON_SERVICE_SYSTEMD_UNIT_NAME);
  return finish([
    unitPath,
    ...(legacyScopedDefaultUnitPath && legacyScopedDefaultUnitPath !== unitPath ? [legacyScopedDefaultUnitPath] : []),
    ...(shouldApplyRawLegacyDefaultFollowingCleanup({ targetMode })
      ? [legacyUnitPath]
      : []),
  ]);
}

export type DaemonServiceLifecycleAction = 'start' | 'stop' | 'restart' | 'status';

export function planDaemonServiceLifecycle(params: Readonly<{
  platform: DaemonServicePlatform;
  action: DaemonServiceLifecycleAction;
  mode?: DaemonServiceMode;
  channel?: PublicReleaseRingId;
  targetMode?: DaemonServiceTargetMode;
  instanceId: string;
  userHomeDir: string;
  happierHomeDir?: string;
  uid?: number;
  darwinStartMode?: 'rebootstrap' | 'kickstart';
  darwinRestartMode?: 'rebootstrap' | 'kickstart';
}>): Readonly<{ platform: DaemonServicePlatform; commands: DaemonServicePlannedCommand[] }> {
  const instanceId = sanitizeServiceInstanceId(params.instanceId);
  const channel: PublicReleaseRingId = params.channel ?? 'stable';
  const targetMode: DaemonServiceTargetMode = params.targetMode ?? 'pinned';
  const label = resolveDaemonServiceLaunchdLabel(instanceId, channel, targetMode);
  const unitName = resolveDaemonServiceSystemdUnitName(instanceId, channel, targetMode);
  const unitLabel = resolveDaemonServiceSystemdUnitLabel(instanceId, channel, targetMode);

  if (params.platform === 'darwin') {
    const uid = params.uid;
    const plistPath = resolveLaunchAgentPlistPath({ userHomeDir: params.userHomeDir, instanceId, channel, targetMode });
    if (typeof uid !== 'number' || uid <= 0) {
      return { platform: 'darwin', commands: [] };
    }

    if (params.action === 'stop') {
      return {
        platform: 'darwin',
        commands: [{ cmd: 'launchctl', args: ['bootout', `gui/${uid}/${label}`] }],
      };
    }

    if (
      (params.action === 'start' && params.darwinStartMode === 'kickstart')
      || (params.action === 'restart' && params.darwinRestartMode === 'kickstart')
    ) {
      return {
        platform: 'darwin',
        commands: [{ cmd: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/${label}`] }],
      };
    }

    if (params.action === 'restart' || params.action === 'start') {
      return {
        platform: 'darwin',
        commands: [
          // bootout may fail if service isn't currently loaded; enable is
          // idempotent; both are pre-steps whose real purpose is to put
          // launchd into the right state before bootstrap + kickstart. They
          // should never block the lifecycle.
          //
          // bootstrap is NOT ignored — if it fails we want to surface the
          // problem. The retry loop in apply.ts absorbs transient
          // launchd async-teardown failures (bootout completes async so the
          // following bootstrap can briefly fail until the teardown drains).
          { cmd: 'launchctl', args: ['bootout', `gui/${uid}/${label}`], ignoreFailure: true },
          { cmd: 'launchctl', args: ['enable', `gui/${uid}/${label}`], ignoreFailure: true },
          { cmd: 'launchctl', args: ['bootstrap', `gui/${uid}`, plistPath] },
          { cmd: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/${label}`] },
        ],
      };
    }

    return { platform: 'darwin', commands: [{ cmd: 'launchctl', args: ['print', `gui/${uid}/${label}`] }] };
  }

  if (params.platform === 'win32') {
    const taskName = resolveWindowsDaemonTaskName({ instanceId, channel, targetMode });
    if (params.action === 'status') {
      return { platform: 'win32', commands: [{ cmd: 'schtasks', args: ['/Query', '/TN', taskName, '/FO', 'LIST', '/V'] }] };
    }
    const action = params.action === 'start' ? 'start' : params.action === 'stop' ? 'stop' : 'restart';
    const backend = params.mode === 'system' ? 'schtasks-system' : 'schtasks-user';
    const happierHomeDir = String(params.happierHomeDir ?? '').trim();
    if (action !== 'start' && !happierHomeDir) {
      throw new Error('happierHomeDir is required for Windows service stop/restart');
    }
    const plan = planServiceAction({
      backend,
      action,
      label: unitLabel,
      definitionPath: action === 'start'
        ? undefined
        : resolveWindowsDaemonWrapperPath({ happierHomeDir, instanceId, channel, targetMode }),
      taskName,
      persistent: true,
    });
    return { platform: 'win32', commands: plan.commands.map((c) => ({ cmd: c.cmd, args: c.args })) };
  }

  const mode: DaemonServiceMode = params.mode === 'system' ? 'system' : 'user';
  const prefix = mode === 'system' ? [] : ['--user'];

  if (params.action === 'start') {
    return { platform: 'linux', commands: [{ cmd: 'systemctl', args: [...prefix, 'start', unitName] }] };
  }
  if (params.action === 'stop') {
    return { platform: 'linux', commands: [{ cmd: 'systemctl', args: [...prefix, 'stop', unitName] }] };
  }
  if (params.action === 'restart') {
    return { platform: 'linux', commands: [{ cmd: 'systemctl', args: [...prefix, 'restart', unitName] }] };
  }
  return {
    platform: 'linux',
    commands: [{ cmd: 'systemctl', args: [...prefix, 'status', unitName, '--no-pager'] }],
  };
}
