import { join, win32 as win32Path } from 'node:path';

import { getReleaseRingCatalogEntry, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { buildLaunchAgentPlistXml, buildLaunchdPath } from './darwin';
import { buildServicePath, planServiceAction, renderSystemdServiceUnit, renderWindowsScheduledTaskWrapperPs1 } from '@happier-dev/cli-common/service';

export type DaemonServicePlatform = 'darwin' | 'linux' | 'win32';
export type DaemonServiceMode = 'user' | 'system';

export type DaemonServicePlannedFile = Readonly<{
  path: string;
  content: string;
  mode: number;
}>;

export type DaemonServicePlannedCommand = Readonly<{
  cmd: string;
  args: readonly string[];
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

export function sanitizeServiceInstanceId(instanceIdRaw: string): string {
  const value = String(instanceIdRaw ?? '').trim();
  if (!value) {
    throw new Error('Daemon service instance id is required');
  }
  // Keep launchd labels / unit names filesystem-safe and deterministic.
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
}

export function resolveDaemonServiceLaunchdLabel(instanceIdRaw: string, channel: PublicReleaseRingId = 'stable'): string {
  const instanceId = sanitizeServiceInstanceId(instanceIdRaw);
  const channelSegment = resolveDaemonServiceChannelSegment(channel);
  return channelSegment
    ? `${DAEMON_SERVICE_LAUNCHD_LABEL_PREFIX}.${channelSegment}.${instanceId}`
    : `${DAEMON_SERVICE_LAUNCHD_LABEL_PREFIX}.${instanceId}`;
}

export function resolveDaemonServiceSystemdUnitLabel(instanceIdRaw: string, channel: PublicReleaseRingId = 'stable'): string {
  const instanceId = sanitizeServiceInstanceId(instanceIdRaw);
  const channelSegment = resolveDaemonServiceChannelSegment(channel);
  return channelSegment
    ? `${DAEMON_SERVICE_SYSTEMD_UNIT_PREFIX}.${channelSegment}.${instanceId}`
    : `${DAEMON_SERVICE_SYSTEMD_UNIT_PREFIX}.${instanceId}`;
}

export function resolveDaemonServiceSystemdUnitName(instanceIdRaw: string, channel: PublicReleaseRingId = 'stable'): string {
  return `${resolveDaemonServiceSystemdUnitLabel(instanceIdRaw, channel)}.service`;
}

export function resolveLaunchAgentPlistPath(params: Readonly<{ userHomeDir: string; instanceId: string; channel?: PublicReleaseRingId }>): string {
  const label = resolveDaemonServiceLaunchdLabel(params.instanceId, params.channel ?? 'stable');
  return join(params.userHomeDir, 'Library', 'LaunchAgents', `${label}.plist`);
}

export function resolveSystemdUserUnitPath(params: Readonly<{ userHomeDir: string; instanceId: string; channel?: PublicReleaseRingId }>): string {
  const unitName = resolveDaemonServiceSystemdUnitName(params.instanceId, params.channel ?? 'stable');
  return join(params.userHomeDir, '.config', 'systemd', 'user', unitName);
}

export function resolveSystemdSystemUnitPath(params: Readonly<{ instanceId: string; channel?: PublicReleaseRingId }>): string {
  const unitName = resolveDaemonServiceSystemdUnitName(params.instanceId, params.channel ?? 'stable');
  return join('/etc', 'systemd', 'system', unitName);
}

export function resolveWindowsDaemonTaskName(params: Readonly<{ instanceId: string; channel?: PublicReleaseRingId }>): string {
  const label = resolveDaemonServiceSystemdUnitLabel(params.instanceId, params.channel ?? 'stable');
  return `Happier\\${label}`;
}

export function resolveWindowsDaemonWrapperPath(params: Readonly<{ happierHomeDir: string; instanceId: string; channel?: PublicReleaseRingId }>): string {
  const label = resolveDaemonServiceSystemdUnitLabel(params.instanceId, params.channel ?? 'stable');
  const home = String(params.happierHomeDir ?? '').trim();
  // When callers supply a POSIX absolute path (common in unit tests on macOS/Linux),
  // `win32.join("/tmp/...", ...)` yields a leading `\\tmp\\...` path which is relative on POSIX and can
  // accidentally write into the repo CWD. Treat POSIX absolute paths as POSIX paths.
  if (home.startsWith('/')) {
    return join(home, 'services', `${label}.ps1`);
  }
  return win32Path.join(home, 'services', `${label}.ps1`);
}

function buildDaemonServiceProgramArgs(params: Readonly<{ nodePath: string; entryPath: string }>): string[] {
  const nodePath = String(params.nodePath ?? '').trim();
  if (!nodePath) throw new Error('nodePath is required');
  const entryPath = String(params.entryPath ?? '').trim();
  if (entryPath) return [nodePath, entryPath, 'daemon', 'start-sync'];
  return [nodePath, 'daemon', 'start-sync'];
}

export function planDaemonServiceInstall(params: Readonly<{
  platform: DaemonServicePlatform;
  mode?: DaemonServiceMode;
  systemUser?: string;
  channel?: PublicReleaseRingId;
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
  const publicReleaseChannel = getReleaseRingCatalogEntry(channel).publicLabel;
  const channelSegment = resolveDaemonServiceChannelSegment(channel);
  const logPrefix = channelSegment ? `${channelSegment}.` : '';
  const label = resolveDaemonServiceLaunchdLabel(instanceId, channel);
  const unitLabel = resolveDaemonServiceSystemdUnitLabel(instanceId, channel);
  const unitName = resolveDaemonServiceSystemdUnitName(instanceId, channel);
  const programArgs = buildDaemonServiceProgramArgs({ nodePath: params.nodePath, entryPath: params.entryPath });

  if (params.platform === 'darwin') {
    const plistPath = resolveLaunchAgentPlistPath({ userHomeDir: params.userHomeDir, instanceId, channel });
    const stdoutPath = join(params.happierHomeDir, 'logs', `daemon-service.${logPrefix}${instanceId}.out.log`);
    const stderrPath = join(params.happierHomeDir, 'logs', `daemon-service.${logPrefix}${instanceId}.err.log`);

    const env: Record<string, string> = {
      PATH: buildLaunchdPath({ execPath: params.nodePath, homeDir: params.userHomeDir }),
      HAPPIER_HOME_DIR: params.happierHomeDir,
      HAPPIER_PUBLIC_RELEASE_CHANNEL: publicReleaseChannel,
      HAPPIER_ACTIVE_SERVER_ID: instanceId,
      HAPPIER_SERVER_URL: params.serverUrl,
      HAPPIER_WEBAPP_URL: params.webappUrl,
      HAPPIER_PUBLIC_SERVER_URL: params.publicServerUrl,
      HAPPIER_NO_BROWSER_OPEN: '1',
      HAPPIER_DAEMON_WAIT_FOR_AUTH: '1',
      // 0 = wait forever (service mode)
      HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS: '0',
    };

    const xml = buildLaunchAgentPlistXml({
      label,
      programArgs,
      env,
      stdoutPath,
      stderrPath,
      workingDirectory: '/tmp',
    });

    const uid = params.uid;
    const commands: DaemonServicePlannedCommand[] = [];
    if (typeof uid === 'number' && uid > 0) {
      // Back-compat: if the legacy (non-instance) service is enabled, disable it so it won't auto-load on login.
      if (instanceId === 'cloud') {
        commands.push({ cmd: 'launchctl', args: ['bootout', `gui/${uid}/${LEGACY_DAEMON_SERVICE_LAUNCHD_LABEL}`] });
        commands.push({ cmd: 'launchctl', args: ['disable', `gui/${uid}/${LEGACY_DAEMON_SERVICE_LAUNCHD_LABEL}`] });
      }
      commands.push({ cmd: 'launchctl', args: ['bootout', `gui/${uid}/${label}`] });
      commands.push({ cmd: 'launchctl', args: ['bootstrap', `gui/${uid}`, plistPath] });
      commands.push({ cmd: 'launchctl', args: ['enable', `gui/${uid}/${label}`] });
      commands.push({ cmd: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/${label}`] });
    }

    return {
      platform: 'darwin',
      files: [{ path: plistPath, content: xml, mode: 0o644 }],
      commands,
    };
  }

  if (params.platform === 'win32') {
    const wrapperPath = resolveWindowsDaemonWrapperPath({ happierHomeDir: params.happierHomeDir, instanceId, channel });
    const stdoutPath = win32Path.join(params.happierHomeDir, 'logs', `daemon-service.${logPrefix}${instanceId}.out.log`);
    const stderrPath = win32Path.join(params.happierHomeDir, 'logs', `daemon-service.${logPrefix}${instanceId}.err.log`);

    const wrapper = renderWindowsScheduledTaskWrapperPs1({
      workingDirectory: params.userHomeDir,
      programArgs,
      env: {
        HAPPIER_HOME_DIR: params.happierHomeDir,
        HAPPIER_PUBLIC_RELEASE_CHANNEL: publicReleaseChannel,
        HAPPIER_ACTIVE_SERVER_ID: instanceId,
        HAPPIER_SERVER_URL: params.serverUrl,
        HAPPIER_WEBAPP_URL: params.webappUrl,
        HAPPIER_PUBLIC_SERVER_URL: params.publicServerUrl,
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_DAEMON_WAIT_FOR_AUTH: '1',
        HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS: '0',
      },
      stdoutPath,
      stderrPath,
    });

    const taskName = resolveWindowsDaemonTaskName({ instanceId, channel });
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
    if (instanceId === 'cloud') {
      const legacyUnitLabel = DAEMON_SERVICE_SYSTEMD_UNIT_PREFIX;
      commands.push({ cmd: 'schtasks', args: ['/End', '/TN', `Happier\\${legacyUnitLabel}`] });
      commands.push({ cmd: 'schtasks', args: ['/Delete', '/F', '/TN', `Happier\\${legacyUnitLabel}`] });
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
    ? resolveSystemdSystemUnitPath({ instanceId, channel })
    : resolveSystemdUserUnitPath({ userHomeDir: params.userHomeDir, instanceId, channel });

  const unit = renderSystemdServiceUnit({
    description: `Happier CLI daemon (${instanceId})`,
    execStart: programArgs,
    workingDirectory: mode === 'system' ? params.userHomeDir : '%h',
    env: {
      PATH: buildServicePath({ execPath: params.nodePath, homeDir: params.userHomeDir, platform: 'linux' }),
      HAPPIER_HOME_DIR: params.happierHomeDir,
      HAPPIER_PUBLIC_RELEASE_CHANNEL: publicReleaseChannel,
      HAPPIER_ACTIVE_SERVER_ID: instanceId,
      HAPPIER_SERVER_URL: params.serverUrl,
      HAPPIER_WEBAPP_URL: params.webappUrl,
      HAPPIER_PUBLIC_SERVER_URL: params.publicServerUrl,
      HAPPIER_NO_BROWSER_OPEN: '1',
      HAPPIER_DAEMON_WAIT_FOR_AUTH: '1',
      HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS: '0',
    },
    restart: 'on-failure',
    runAsUser: mode === 'system' ? systemUser : '',
    wantedBy: mode === 'system' ? 'multi-user.target' : 'default.target',
  });

  const commands: DaemonServicePlannedCommand[] = [{ cmd: 'systemctl', args: [...prefix, 'daemon-reload'] }];
  if (instanceId === 'cloud') {
    commands.push({ cmd: 'systemctl', args: [...prefix, 'disable', '--now', LEGACY_DAEMON_SERVICE_SYSTEMD_UNIT_NAME] });
  }
  commands.push({ cmd: 'systemctl', args: [...prefix, 'enable', '--now', unitName] });

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
  instanceId: string;
  userHomeDir: string;
  happierHomeDir?: string;
  uid?: number;
}>): DaemonServiceUninstallPlan {
  const instanceId = sanitizeServiceInstanceId(params.instanceId);
  const channel: PublicReleaseRingId = params.channel ?? 'stable';
  const label = resolveDaemonServiceLaunchdLabel(instanceId, channel);
  const unitLabel = resolveDaemonServiceSystemdUnitLabel(instanceId, channel);
  const unitName = resolveDaemonServiceSystemdUnitName(instanceId, channel);

  if (params.platform === 'darwin') {
    const plistPath = resolveLaunchAgentPlistPath({ userHomeDir: params.userHomeDir, instanceId, channel });
    const uid = params.uid;
    const commands: DaemonServicePlannedCommand[] = [];
    if (typeof uid === 'number' && uid > 0) {
      commands.push({ cmd: 'launchctl', args: ['bootout', `gui/${uid}/${label}`] });
      commands.push({ cmd: 'launchctl', args: ['disable', `gui/${uid}/${label}`] });
      if (instanceId === 'cloud') {
        commands.push({ cmd: 'launchctl', args: ['bootout', `gui/${uid}/${LEGACY_DAEMON_SERVICE_LAUNCHD_LABEL}`] });
        commands.push({ cmd: 'launchctl', args: ['disable', `gui/${uid}/${LEGACY_DAEMON_SERVICE_LAUNCHD_LABEL}`] });
      }
    }

    const filesToRemove = [
      plistPath,
      ...(instanceId === 'cloud'
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
    const wrapperPath = resolveWindowsDaemonWrapperPath({ happierHomeDir, instanceId, channel });
    const taskName = resolveWindowsDaemonTaskName({ instanceId, channel });
    const plan = planServiceAction({
      backend: 'schtasks-user',
      action: 'uninstall',
      label: unitLabel,
      taskName,
      persistent: true,
    });
    const commands: DaemonServicePlannedCommand[] = [];
    if (instanceId === 'cloud') {
      const legacyUnitLabel = DAEMON_SERVICE_SYSTEMD_UNIT_PREFIX;
      commands.push({ cmd: 'schtasks', args: ['/End', '/TN', `Happier\\${legacyUnitLabel}`] });
      commands.push({ cmd: 'schtasks', args: ['/Delete', '/F', '/TN', `Happier\\${legacyUnitLabel}`] });
    }
    commands.push(...plan.commands.map((c) => ({ cmd: c.cmd, args: c.args })));
    const filesToRemove = [wrapperPath];
    if (instanceId === 'cloud') {
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
  const unitPath = mode === 'system'
    ? resolveSystemdSystemUnitPath({ instanceId, channel })
    : resolveSystemdUserUnitPath({ userHomeDir: params.userHomeDir, instanceId, channel });
  const legacyUnitPath = mode === 'system'
    ? join('/etc', 'systemd', 'system', LEGACY_DAEMON_SERVICE_SYSTEMD_UNIT_NAME)
    : join(params.userHomeDir, '.config', 'systemd', 'user', LEGACY_DAEMON_SERVICE_SYSTEMD_UNIT_NAME);
  return {
    platform: 'linux',
    filesToRemove: [
      unitPath,
      ...(instanceId === 'cloud'
        ? [legacyUnitPath]
        : []),
    ],
    commands: [
      { cmd: 'systemctl', args: [...prefix, 'disable', '--now', unitName] },
      { cmd: 'systemctl', args: [...prefix, 'stop', unitName] },
      ...(instanceId === 'cloud'
        ? [
            { cmd: 'systemctl', args: [...prefix, 'disable', '--now', LEGACY_DAEMON_SERVICE_SYSTEMD_UNIT_NAME] },
            { cmd: 'systemctl', args: [...prefix, 'stop', LEGACY_DAEMON_SERVICE_SYSTEMD_UNIT_NAME] },
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
  instanceId: string;
  userHomeDir: string;
  happierHomeDir?: string;
  uid?: number;
}>): Readonly<{ platform: DaemonServicePlatform; commands: DaemonServicePlannedCommand[] }> {
  const instanceId = sanitizeServiceInstanceId(params.instanceId);
  const channel: PublicReleaseRingId = params.channel ?? 'stable';
  const label = resolveDaemonServiceLaunchdLabel(instanceId, channel);
  const unitName = resolveDaemonServiceSystemdUnitName(instanceId, channel);
  const unitLabel = resolveDaemonServiceSystemdUnitLabel(instanceId, channel);

  if (params.platform === 'darwin') {
    const uid = params.uid;
    const plistPath = resolveLaunchAgentPlistPath({ userHomeDir: params.userHomeDir, instanceId, channel });
    if (typeof uid !== 'number' || uid <= 0) {
      return { platform: 'darwin', commands: [] };
    }

    if (params.action === 'stop') {
      return {
        platform: 'darwin',
        commands: [{ cmd: 'launchctl', args: ['bootout', `gui/${uid}/${label}`] }],
      };
    }

    if (params.action === 'restart' || params.action === 'start') {
      return {
        platform: 'darwin',
        commands: [
          { cmd: 'launchctl', args: ['bootstrap', `gui/${uid}`, plistPath] },
          { cmd: 'launchctl', args: ['enable', `gui/${uid}/${label}`] },
          { cmd: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/${label}`] },
        ],
      };
    }

    return { platform: 'darwin', commands: [{ cmd: 'launchctl', args: ['list', label] }] };
  }

  if (params.platform === 'win32') {
    const taskName = resolveWindowsDaemonTaskName({ instanceId, channel });
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
