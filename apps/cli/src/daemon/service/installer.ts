import { homedir } from 'node:os';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';

import { applyDaemonServiceInstallPlan, applyDaemonServiceUninstallPlan } from './apply';
import { planDaemonServiceInstall, planDaemonServiceUninstall } from './plan';

type SupportedPlatform = 'darwin' | 'linux';

function resolveSupportedPlatform(p: string): SupportedPlatform | null {
  if (p === 'darwin') return 'darwin';
  if (p === 'linux') return 'linux';
  return null;
}

export async function installDaemonService(options: Readonly<{
  platform?: SupportedPlatform;
  uid?: number;
  userHomeDir?: string;
  happierHomeDir?: string;
  instanceId?: string;
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
    throw new Error('Daemon service installation is currently only supported on macOS and Linux');
  }

  const uid = options.uid ?? (process.getuid ? process.getuid() : undefined);
  const userHomeDir = options.userHomeDir ?? homedir();
  const happierHomeDir = options.happierHomeDir ?? configuration.happyHomeDir;
  const instanceId = options.instanceId ?? configuration.activeServerId;
  const serverUrl = options.serverUrl ?? configuration.serverUrl;
  const webappUrl = options.webappUrl ?? configuration.webappUrl;
  const publicServerUrl = options.publicServerUrl ?? configuration.publicServerUrl;
  const nodePath = options.nodePath ?? process.execPath;
  const entryPath = options.entryPath ?? join(projectPath(), 'dist', 'index.mjs');

  const plan = planDaemonServiceInstall({
    platform,
    instanceId,
    uid,
    userHomeDir,
    happierHomeDir,
    serverUrl,
    webappUrl,
    publicServerUrl,
    nodePath,
    entryPath,
  });
  await applyDaemonServiceInstallPlan(plan, { runCommands: options.runCommands });
}

export async function uninstallDaemonService(options: Readonly<{
  platform?: SupportedPlatform;
  uid?: number;
  userHomeDir?: string;
  instanceId?: string;
  runCommands?: boolean;
}> = {}): Promise<void> {
  const platformInput = options.platform ?? process.platform;
  const platform = resolveSupportedPlatform(platformInput);
  if (!platform) {
    throw new Error('Daemon service uninstallation is currently only supported on macOS and Linux');
  }

  const uid = options.uid ?? (process.getuid ? process.getuid() : undefined);
  const userHomeDir = options.userHomeDir ?? homedir();
  const instanceId = options.instanceId ?? configuration.activeServerId;

  const plan = planDaemonServiceUninstall({
    platform,
    instanceId,
    uid,
    userHomeDir,
  });
  await applyDaemonServiceUninstallPlan(plan, { runCommands: options.runCommands });
}
