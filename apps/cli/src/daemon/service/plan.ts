import { join, win32 as win32Path } from 'node:path';

import { buildLaunchAgentPlistXml, buildLaunchdPath } from './darwin';
import { buildSystemdUserUnit, escapeSystemdValue } from './systemdUser';
import { planServiceAction, renderWindowsScheduledTaskWrapperPs1 } from '@happier-dev/cli-common/service';

export type DaemonServicePlatform = 'darwin' | 'linux' | 'win32';

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

export function resolveDaemonServiceSystemdUnitLabel(instanceIdRaw: string): string {
  const instanceId = sanitizeServiceInstanceId(instanceIdRaw);
  return `${DAEMON_SERVICE_SYSTEMD_UNIT_PREFIX}.${instanceId}`;
}

export function resolveDaemonServiceSystemdUnitName(instanceIdRaw: string): string {
  return `${resolveDaemonServiceSystemdUnitLabel(instanceIdRaw)}.service`;
}

export function resolveLaunchAgentPlistPath(params: Readonly<{ userHomeDir: string; instanceId: string }>): string {
  const label = resolveDaemonServiceLaunchdLabel(params.instanceId);
  return join(params.userHomeDir, 'Library', 'LaunchAgents', `${label}.plist`);
}

export function resolveSystemdUserUnitPath(params: Readonly<{ userHomeDir: string; instanceId: string }>): string {
  const unitName = resolveDaemonServiceSystemdUnitName(params.instanceId);
  return join(params.userHomeDir, '.config', 'systemd', 'user', unitName);
}

export function resolveWindowsDaemonTaskName(params: Readonly<{ instanceId: string }>): string {
  const label = resolveDaemonServiceSystemdUnitLabel(params.instanceId);
  return `Happier\\${label}`;
}

export function resolveWindowsDaemonWrapperPath(params: Readonly<{ happierHomeDir: string; instanceId: string }>): string {
  const label = resolveDaemonServiceSystemdUnitLabel(params.instanceId);
  return win32Path.join(params.happierHomeDir, 'services', `${label}.ps1`);
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
  const unitLabel = resolveDaemonServiceSystemdUnitLabel(instanceId);
  const unitName = resolveDaemonServiceSystemdUnitName(instanceId);
  const programArgs = buildDaemonServiceProgramArgs({ nodePath: params.nodePath, entryPath: params.entryPath });

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
    const wrapperPath = resolveWindowsDaemonWrapperPath({ happierHomeDir: params.happierHomeDir, instanceId });
    const stdoutPath = win32Path.join(params.happierHomeDir, 'logs', `daemon-service.${instanceId}.out.log`);
    const stderrPath = win32Path.join(params.happierHomeDir, 'logs', `daemon-service.${instanceId}.err.log`);

    const wrapper = renderWindowsScheduledTaskWrapperPs1({
      workingDirectory: params.userHomeDir,
      programArgs,
      env: {
        HAPPIER_HOME_DIR: params.happierHomeDir,
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

    const taskName = resolveWindowsDaemonTaskName({ instanceId });
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

  const unitPath = resolveSystemdUserUnitPath({ userHomeDir: params.userHomeDir, instanceId });
  const unit = buildSystemdUserUnit({
    description: `Happier CLI daemon (${instanceId})`,
    execStart: programArgs.map(escapeSystemdValue).join(' '),
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
  if (instanceId === 'cloud') {
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
  happierHomeDir?: string;
  uid?: number;
}>): DaemonServiceUninstallPlan {
  const instanceId = sanitizeServiceInstanceId(params.instanceId);
  const label = resolveDaemonServiceLaunchdLabel(instanceId);
  const unitLabel = resolveDaemonServiceSystemdUnitLabel(instanceId);
  const unitName = resolveDaemonServiceSystemdUnitName(instanceId);

  if (params.platform === 'darwin') {
    const plistPath = resolveLaunchAgentPlistPath({ userHomeDir: params.userHomeDir, instanceId });
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
    const wrapperPath = resolveWindowsDaemonWrapperPath({ happierHomeDir, instanceId });
    const taskName = resolveWindowsDaemonTaskName({ instanceId });
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

  const unitPath = resolveSystemdUserUnitPath({ userHomeDir: params.userHomeDir, instanceId });
  return {
    platform: 'linux',
    filesToRemove: [
      unitPath,
      ...(instanceId === 'cloud'
        ? [join(params.userHomeDir, '.config', 'systemd', 'user', LEGACY_DAEMON_SERVICE_SYSTEMD_UNIT_NAME)]
        : []),
    ],
    commands: [
      { cmd: 'systemctl', args: ['--user', 'disable', '--now', unitName] },
      { cmd: 'systemctl', args: ['--user', 'stop', unitName] },
      ...(instanceId === 'cloud'
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
  happierHomeDir?: string;
  uid?: number;
}>): Readonly<{ platform: DaemonServicePlatform; commands: DaemonServicePlannedCommand[] }> {
  const instanceId = sanitizeServiceInstanceId(params.instanceId);
  const label = resolveDaemonServiceLaunchdLabel(instanceId);
  const unitName = resolveDaemonServiceSystemdUnitName(instanceId);
  const unitLabel = resolveDaemonServiceSystemdUnitLabel(instanceId);

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

  if (params.platform === 'win32') {
    const taskName = resolveWindowsDaemonTaskName({ instanceId });
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
