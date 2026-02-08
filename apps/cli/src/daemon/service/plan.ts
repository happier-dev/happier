import { join } from 'node:path';

import { buildLaunchAgentPlistXml, buildLaunchdPath } from './darwin';
import { buildSystemdUserUnit, escapeSystemdValue } from './systemdUser';

export type DaemonServicePlatform = 'darwin' | 'linux';

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

// Back-compat exports: older codepaths (and some downstream builds) may still import these legacy names.
export const DAEMON_SERVICE_LAUNCHD_LABEL = LEGACY_DAEMON_SERVICE_LAUNCHD_LABEL;
export const DAEMON_SERVICE_SYSTEMD_UNIT_NAME = LEGACY_DAEMON_SERVICE_SYSTEMD_UNIT_NAME;

export function sanitizeServiceInstanceId(instanceIdRaw: string): string {
  const value = String(instanceIdRaw ?? '').trim();
  if (!value) {
    throw new Error('Daemon service instance id is required');
  }
  // Keep launchd labels / unit names filesystem-safe and deterministic.
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
}

export function resolveDaemonServiceLaunchdLabel(instanceIdRaw: string): string {
  const instanceId = sanitizeServiceInstanceId(instanceIdRaw);
  return `${DAEMON_SERVICE_LAUNCHD_LABEL_PREFIX}.${instanceId}`;
}

export function resolveDaemonServiceSystemdUnitName(instanceIdRaw: string): string {
  const instanceId = sanitizeServiceInstanceId(instanceIdRaw);
  return `${DAEMON_SERVICE_SYSTEMD_UNIT_PREFIX}.${instanceId}.service`;
}

export function resolveLaunchAgentPlistPath(params: Readonly<{ userHomeDir: string; instanceId: string }>): string {
  const label = resolveDaemonServiceLaunchdLabel(params.instanceId);
  return join(params.userHomeDir, 'Library', 'LaunchAgents', `${label}.plist`);
}

export function resolveSystemdUserUnitPath(params: Readonly<{ userHomeDir: string; instanceId: string }>): string {
  const unitName = resolveDaemonServiceSystemdUnitName(params.instanceId);
  return join(params.userHomeDir, '.config', 'systemd', 'user', unitName);
}

export function planDaemonServiceInstall(params: Readonly<{
  platform: DaemonServicePlatform;
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
  const label = resolveDaemonServiceLaunchdLabel(instanceId);
  const unitName = resolveDaemonServiceSystemdUnitName(instanceId);

  if (params.platform === 'darwin') {
    const plistPath = resolveLaunchAgentPlistPath({ userHomeDir: params.userHomeDir, instanceId });
    const stdoutPath = join(params.happierHomeDir, 'logs', `daemon-service.${instanceId}.out.log`);
    const stderrPath = join(params.happierHomeDir, 'logs', `daemon-service.${instanceId}.err.log`);

    const env: Record<string, string> = {
      PATH: buildLaunchdPath({ execPath: params.nodePath }),
      HAPPIER_HOME_DIR: params.happierHomeDir,
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
      programArgs: [params.nodePath, params.entryPath, 'daemon', 'start-sync'],
      env,
      stdoutPath,
      stderrPath,
      workingDirectory: '/tmp',
    });

    const uid = params.uid;
    const commands: DaemonServicePlannedCommand[] = [];
    if (typeof uid === 'number' && uid > 0) {
      // Back-compat: if the legacy (non-instance) service is enabled, disable it so it won't auto-load on login.
      if (instanceId === 'official') {
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

  const unitPath = resolveSystemdUserUnitPath({ userHomeDir: params.userHomeDir, instanceId });
  const unit = buildSystemdUserUnit({
    description: `Happier CLI daemon (${instanceId})`,
    execStart: `${escapeSystemdValue(params.nodePath)} ${escapeSystemdValue(params.entryPath)} daemon start-sync`,
    workingDirectory: '%h',
    env: {
      HAPPIER_HOME_DIR: params.happierHomeDir,
      HAPPIER_SERVER_URL: params.serverUrl,
      HAPPIER_WEBAPP_URL: params.webappUrl,
      HAPPIER_PUBLIC_SERVER_URL: params.publicServerUrl,
      HAPPIER_NO_BROWSER_OPEN: '1',
      HAPPIER_DAEMON_WAIT_FOR_AUTH: '1',
      HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS: '0',
    },
  });

  const commands: DaemonServicePlannedCommand[] = [
    { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
  ];
  if (instanceId === 'official') {
    commands.push({ cmd: 'systemctl', args: ['--user', 'disable', '--now', LEGACY_DAEMON_SERVICE_SYSTEMD_UNIT_NAME] });
  }
  commands.push({ cmd: 'systemctl', args: ['--user', 'enable', '--now', unitName] });

  return {
    platform: 'linux',
    files: [{ path: unitPath, content: unit, mode: 0o644 }],
    commands,
  };
}

export function planDaemonServiceUninstall(params: Readonly<{
  platform: DaemonServicePlatform;
  instanceId: string;
  userHomeDir: string;
  uid?: number;
}>): DaemonServiceUninstallPlan {
  const instanceId = sanitizeServiceInstanceId(params.instanceId);
  const label = resolveDaemonServiceLaunchdLabel(instanceId);
  const unitName = resolveDaemonServiceSystemdUnitName(instanceId);

  if (params.platform === 'darwin') {
    const plistPath = resolveLaunchAgentPlistPath({ userHomeDir: params.userHomeDir, instanceId });
    const uid = params.uid;
    const commands: DaemonServicePlannedCommand[] = [];
    if (typeof uid === 'number' && uid > 0) {
      commands.push({ cmd: 'launchctl', args: ['bootout', `gui/${uid}/${label}`] });
      commands.push({ cmd: 'launchctl', args: ['disable', `gui/${uid}/${label}`] });
      if (instanceId === 'official') {
        commands.push({ cmd: 'launchctl', args: ['bootout', `gui/${uid}/${LEGACY_DAEMON_SERVICE_LAUNCHD_LABEL}`] });
        commands.push({ cmd: 'launchctl', args: ['disable', `gui/${uid}/${LEGACY_DAEMON_SERVICE_LAUNCHD_LABEL}`] });
      }
    }

    const filesToRemove = [
      plistPath,
      ...(instanceId === 'official'
        ? [join(params.userHomeDir, 'Library', 'LaunchAgents', `${LEGACY_DAEMON_SERVICE_LAUNCHD_LABEL}.plist`)]
        : []),
    ];
    return { platform: 'darwin', filesToRemove, commands };
  }

  const unitPath = resolveSystemdUserUnitPath({ userHomeDir: params.userHomeDir, instanceId });
  return {
    platform: 'linux',
    filesToRemove: [
      unitPath,
      ...(instanceId === 'official'
        ? [join(params.userHomeDir, '.config', 'systemd', 'user', LEGACY_DAEMON_SERVICE_SYSTEMD_UNIT_NAME)]
        : []),
    ],
    commands: [
      { cmd: 'systemctl', args: ['--user', 'disable', '--now', unitName] },
      { cmd: 'systemctl', args: ['--user', 'stop', unitName] },
      ...(instanceId === 'official'
        ? [
            { cmd: 'systemctl', args: ['--user', 'disable', '--now', LEGACY_DAEMON_SERVICE_SYSTEMD_UNIT_NAME] },
            { cmd: 'systemctl', args: ['--user', 'stop', LEGACY_DAEMON_SERVICE_SYSTEMD_UNIT_NAME] },
          ]
        : []),
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
    ],
  };
}

export type DaemonServiceLifecycleAction = 'start' | 'stop' | 'restart' | 'status';

export function planDaemonServiceLifecycle(params: Readonly<{
  platform: DaemonServicePlatform;
  action: DaemonServiceLifecycleAction;
  instanceId: string;
  userHomeDir: string;
  uid?: number;
}>): Readonly<{ platform: DaemonServicePlatform; commands: DaemonServicePlannedCommand[] }> {
  const instanceId = sanitizeServiceInstanceId(params.instanceId);
  const label = resolveDaemonServiceLaunchdLabel(instanceId);
  const unitName = resolveDaemonServiceSystemdUnitName(instanceId);

  if (params.platform === 'darwin') {
    const uid = params.uid;
    const plistPath = resolveLaunchAgentPlistPath({ userHomeDir: params.userHomeDir, instanceId });
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

  if (params.action === 'start') {
    return { platform: 'linux', commands: [{ cmd: 'systemctl', args: ['--user', 'start', unitName] }] };
  }
  if (params.action === 'stop') {
    return { platform: 'linux', commands: [{ cmd: 'systemctl', args: ['--user', 'stop', unitName] }] };
  }
  if (params.action === 'restart') {
    return { platform: 'linux', commands: [{ cmd: 'systemctl', args: ['--user', 'restart', unitName] }] };
  }
  return {
    platform: 'linux',
    commands: [{ cmd: 'systemctl', args: ['--user', 'status', unitName, '--no-pager'] }],
  };
}
