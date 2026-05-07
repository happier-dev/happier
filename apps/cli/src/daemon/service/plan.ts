import { basename, join, win32 as win32Path } from 'node:path';

import { getReleaseRingCatalogEntry, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { buildLaunchAgentPlistXml, buildLaunchdPath } from './darwin';
import { buildServicePath, planServiceAction, renderSystemdServiceUnit, renderWindowsScheduledTaskWrapperPs1 } from '@happier-dev/cli-common/service';

export type DaemonServicePlatform = 'darwin' | 'linux' | 'win32';
export type DaemonServiceMode = 'user' | 'system';
export type DaemonServiceTargetMode = 'pinned' | 'default-following';

export type DaemonServicePlannedFile = Readonly<{
  path: string;
  content: string;
  mode: number;
}>;

export type DaemonServicePlannedCommand = Readonly<{
  cmd: string;
  args: readonly string[];
  ignoreFailure?: boolean;
}>;

export type DaemonServiceInstallPlan = Readonly<{
  platform: DaemonServicePlatform;
  files: DaemonServicePlannedFile[];
  commands: DaemonServicePlannedCommand[];
}>;

export type DaemonServiceUninstallPlan = Readonly<{
  platform: DaemonServicePlatform;
  filesToRemove: string[];
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
  const instanceId = sanitizeServiceInstanceId(params.instanceId);
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

export function planDaemonServiceInstall(params: Readonly<{
  platform: DaemonServicePlatform;
  mode?: DaemonServiceMode;
  systemUser?: string;
  channel?: PublicReleaseRingId;
  targetMode?: DaemonServiceTargetMode;
  darwinInstallMode?: 'rebootstrap' | 'kickstart';
  instanceId: string;
  userHomeDir: string;
  happierHomeDir: string;
  serverUrl: string;
  webappUrl: string;
  publicServerUrl: string;
  nodePath: string;
  entryPath: string;
  uid?: number;
}>): DaemonServiceInstallPlan {
  const instanceId = sanitizeServiceInstanceId(params.instanceId);
  const channel: PublicReleaseRingId = params.channel ?? 'stable';
  const targetMode: DaemonServiceTargetMode = params.targetMode ?? 'pinned';
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
    HAPPIER_PUBLIC_RELEASE_CHANNEL: publicReleaseChannel,
    HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
    HAPPIER_DAEMON_SERVICE_LABEL: label,
    HAPPIER_DAEMON_SERVICE_TARGET_MODE: targetMode,
    HAPPIER_NO_BROWSER_OPEN: '1',
    HAPPIER_DAEMON_WAIT_FOR_AUTH: '1',
    HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS: '0',
  };
  const pinnedTargetEnv: Record<string, string> = targetMode === 'default-following'
    ? {}
    : {
        HAPPIER_ACTIVE_SERVER_ID: instanceId,
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
    });

    const uid = params.uid;
    const commands: DaemonServicePlannedCommand[] = [];
    if (typeof uid === 'number' && uid > 0) {
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
      persistent: true,
    });

    const commands: DaemonServicePlannedCommand[] = [];
    if (shouldApplyRawLegacyDefaultFollowingCleanup({ targetMode })) {
      const legacyUnitLabel = DAEMON_SERVICE_SYSTEMD_UNIT_PREFIX;
      commands.push({ cmd: 'schtasks', args: ['/End', '/TN', `Happier\\${legacyUnitLabel}`], ignoreFailure: true });
      commands.push({ cmd: 'schtasks', args: ['/Delete', '/F', '/TN', `Happier\\${legacyUnitLabel}`], ignoreFailure: true });
      // Note: legacy wrapper path is best-effort removed via filesToRemove on uninstall.
    }
    commands.push(...basePlan.commands.map((c) => ({ cmd: c.cmd, args: c.args })));

    return {
      platform: 'win32',
      files: [{ path: wrapperPath, content: wrapper, mode: 0o644 }],
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
  commands.push({ cmd: 'systemctl', args: [...prefix, 'enable', unitName] });
  commands.push({ cmd: 'systemctl', args: [...prefix, 'restart', unitName] });

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
  const label = resolveDaemonServiceLaunchdLabel(instanceId, channel, targetMode);
  const unitLabel = resolveDaemonServiceSystemdUnitLabel(instanceId, channel, targetMode);
  const unitName = resolveDaemonServiceSystemdUnitName(instanceId, channel, targetMode);
  const installedPath = String(params.installedPath ?? '').trim() || null;

  if (params.platform === 'darwin') {
    const plistPath = installedPath || resolveLaunchAgentPlistPath({ userHomeDir: params.userHomeDir, instanceId, channel, targetMode });
    const installedLabel = installedPath && plistPath.endsWith('.plist')
      ? basename(plistPath, '.plist')
      : label;
    const uid = params.uid;
    const commands: DaemonServicePlannedCommand[] = [];
    if (typeof uid === 'number' && uid > 0) {
      commands.push({ cmd: 'launchctl', args: ['bootout', `gui/${uid}/${installedLabel}`] });
      commands.push({ cmd: 'launchctl', args: ['disable', `gui/${uid}/${installedLabel}`] });
      if (shouldApplyLegacyChannelScopedDefaultFollowingCleanup({ channel, targetMode })) {
        const legacyIdentitySegment = resolveLegacyChannelScopedDefaultFollowingIdentitySegment(channel);
        const legacyLabel = legacyIdentitySegment
          ? `${DAEMON_SERVICE_LAUNCHD_LABEL_PREFIX}.${legacyIdentitySegment}`
          : null;
        if (legacyLabel && legacyLabel !== installedLabel) {
          commands.push({ cmd: 'launchctl', args: ['bootout', `gui/${uid}/${legacyLabel}`], ignoreFailure: true });
          commands.push({ cmd: 'launchctl', args: ['disable', `gui/${uid}/${legacyLabel}`], ignoreFailure: true });
        }
      }
      if (shouldApplyRawLegacyDefaultFollowingCleanup({ targetMode })) {
        commands.push({ cmd: 'launchctl', args: ['bootout', `gui/${uid}/${LEGACY_DAEMON_SERVICE_LAUNCHD_LABEL}`] });
        commands.push({ cmd: 'launchctl', args: ['disable', `gui/${uid}/${LEGACY_DAEMON_SERVICE_LAUNCHD_LABEL}`] });
      }
    }

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
    return { platform: 'darwin', filesToRemove, commands };
  }

  if (params.platform === 'win32') {
    const happierHomeDir = String(params.happierHomeDir ?? '').trim();
    if (!happierHomeDir) {
      throw new Error('happierHomeDir is required for Windows service uninstall');
    }
    const wrapperPath = installedPath || resolveWindowsDaemonWrapperPath({ happierHomeDir, instanceId, channel, targetMode });
    const installedUnitLabel = basename(wrapperPath, '.ps1');
    const taskName = `Happier\\${installedUnitLabel}`;
    const plan = planServiceAction({
      backend: 'schtasks-user',
      action: 'uninstall',
      label: unitLabel,
      taskName,
      persistent: true,
    });
    const commands: DaemonServicePlannedCommand[] = [];
    if (shouldApplyLegacyChannelScopedDefaultFollowingCleanup({ channel, targetMode })) {
      const legacyIdentitySegment = resolveLegacyChannelScopedDefaultFollowingIdentitySegment(channel);
      const legacyUnitLabel = legacyIdentitySegment
        ? `${DAEMON_SERVICE_SYSTEMD_UNIT_PREFIX}.${legacyIdentitySegment}`
        : null;
      if (legacyUnitLabel && legacyUnitLabel !== installedUnitLabel) {
        commands.push({ cmd: 'schtasks', args: ['/End', '/TN', `Happier\\${legacyUnitLabel}`], ignoreFailure: true });
        commands.push({ cmd: 'schtasks', args: ['/Delete', '/F', '/TN', `Happier\\${legacyUnitLabel}`], ignoreFailure: true });
      }
    }
    if (shouldApplyRawLegacyDefaultFollowingCleanup({ targetMode })) {
      const legacyUnitLabel = DAEMON_SERVICE_SYSTEMD_UNIT_PREFIX;
      commands.push({ cmd: 'schtasks', args: ['/End', '/TN', `Happier\\${legacyUnitLabel}`] });
      commands.push({ cmd: 'schtasks', args: ['/Delete', '/F', '/TN', `Happier\\${legacyUnitLabel}`] });
    }
    commands.push(...plan.commands.map((c) => ({ cmd: c.cmd, args: c.args })));
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
    return {
      platform: 'win32',
      filesToRemove,
      commands,
    };
  }

  const mode: DaemonServiceMode = params.mode === 'system' ? 'system' : 'user';
  const prefix = mode === 'system' ? [] : ['--user'];
  const unitPath = installedPath || (mode === 'system'
    ? resolveSystemdSystemUnitPath({ instanceId, channel, targetMode })
    : resolveSystemdUserUnitPath({ userHomeDir: params.userHomeDir, instanceId, channel, targetMode }));
  const installedUnitName = basename(unitPath);
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
  return {
    platform: 'linux',
    filesToRemove: [
      unitPath,
      ...(legacyScopedDefaultUnitPath && legacyScopedDefaultUnitPath !== unitPath ? [legacyScopedDefaultUnitPath] : []),
      ...(shouldApplyRawLegacyDefaultFollowingCleanup({ targetMode })
        ? [legacyUnitPath]
        : []),
    ],
    commands: [
      { cmd: 'systemctl', args: [...prefix, 'disable', '--now', installedUnitName] },
      { cmd: 'systemctl', args: [...prefix, 'stop', installedUnitName] },
      ...(legacyScopedDefaultUnitName && legacyScopedDefaultUnitName !== installedUnitName
        ? [
            {
              cmd: 'systemctl',
              args: [...prefix, 'disable', '--now', legacyScopedDefaultUnitName],
              ignoreFailure: true,
            },
            {
              cmd: 'systemctl',
              args: [...prefix, 'stop', legacyScopedDefaultUnitName],
              ignoreFailure: true,
            },
          ]
        : []),
      ...(shouldApplyRawLegacyDefaultFollowingCleanup({ targetMode })
        ? [
            {
              cmd: 'systemctl',
              args: [...prefix, 'disable', '--now', LEGACY_DAEMON_SERVICE_SYSTEMD_UNIT_NAME],
              ignoreFailure: true,
            },
            {
              cmd: 'systemctl',
              args: [...prefix, 'stop', LEGACY_DAEMON_SERVICE_SYSTEMD_UNIT_NAME],
              ignoreFailure: true,
            },
          ]
        : []),
      { cmd: 'systemctl', args: [...prefix, 'daemon-reload'] },
    ],
  };
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
    const plan = planServiceAction({
      backend: 'schtasks-user',
      action,
      label: unitLabel,
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
