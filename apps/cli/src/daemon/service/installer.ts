import { homedir } from 'node:os';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import { ensureJavaScriptRuntimeExecutable } from '@/runtime/js/ensureJavaScriptRuntimeExecutable';
import { buildMissingJavaScriptRuntimeMessage } from '@/runtime/js/buildMissingJavaScriptRuntimeMessage';
import { isBun } from '@/utils/runtime';

import { applyDaemonServiceInstallPlan, applyDaemonServiceUninstallPlan } from './apply';
import { planDaemonServiceInstall, planDaemonServiceUninstall } from './plan';
import type { DaemonServiceMode } from './plan';
import { resolveDaemonServiceRuntimeTarget } from './runtimeTarget';

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
  const runtimeExecutable = explicitNodePath
    ? null
    : await ensureJavaScriptRuntimeExecutable({
        isBunRuntime: isBun(),
        currentExecPath: process.execPath,
      });
  if (!explicitNodePath && !runtimeExecutable && !explicitEntryPath) {
    throw new ReferenceError(buildMissingJavaScriptRuntimeMessage('Daemon service installation'));
  }
  const runtimeTarget = resolveDaemonServiceRuntimeTarget({
    currentExecPath: process.execPath,
    runtimeExecutable,
    explicitNodePath,
    explicitEntryPath,
  });

  const plan = planDaemonServiceInstall({
    platform,
    mode: options.mode,
    systemUser: options.systemUser,
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

export async function uninstallDaemonService(options: Readonly<{
  platform?: SupportedPlatform;
  uid?: number;
  userHomeDir?: string;
  happierHomeDir?: string;
  mode?: DaemonServiceMode;
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
    instanceId,
    uid,
    userHomeDir,
    happierHomeDir,
  });
  await applyDaemonServiceUninstallPlan(plan, { runCommands: options.runCommands });
}
