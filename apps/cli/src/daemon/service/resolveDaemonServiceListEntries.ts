import { readFileSync } from 'node:fs';

import { readSettings } from '@/persistence';

import { planDaemonServiceInstall, type DaemonServiceMode } from './plan';
import { discoverInstalledDaemonServiceEntries, isValidInstalledDaemonServiceFile } from './discoverInstalledDaemonServiceEntries';
import { resolveDaemonServiceInstallRuntimeTarget } from './resolveDaemonServiceInstallRuntimeTarget';

import type { DaemonServiceCliRuntime, DaemonServiceListEntry } from './cli';

function doesInstalledDaemonServiceDefinitionMatchExpected(params: Readonly<{
  installedPath: string;
  expectedContents: string;
}>): boolean {
  try {
    return readFileSync(params.installedPath, 'utf-8').trim() === params.expectedContents.trim();
  } catch {
    return false;
  }
}

export async function resolveDaemonServiceListEntries(
  runtime: DaemonServiceCliRuntime,
  options: Readonly<{ mode?: DaemonServiceMode; systemUser?: string; deep?: boolean }> = {},
): Promise<readonly DaemonServiceListEntry[]> {
  const settings = await readSettings();
  const resolvedEntries = await discoverInstalledDaemonServiceEntries({
    platform: runtime.platform,
    userHomeDir: runtime.userHomeDir,
    happierHomeDir: runtime.happierHomeDir,
    mode: options.mode === 'system' ? 'system' : 'user',
    serversById: (settings.servers ?? {}) as Readonly<Record<string, unknown>>,
    includeInvalidDefinitions: options.deep === true,
  });

  const mode = options.mode === 'system' ? 'system' : 'user';
  const systemUser = String(options.systemUser ?? '').trim();
  if (mode === 'system' && !systemUser) {
    return resolvedEntries;
  }

  const expectedDefaultRuntimeTarget = await resolveDaemonServiceInstallRuntimeTarget({
    allowBootstrap: false,
    currentExecPath: runtime.nodePath,
    targetMode: 'default-following',
    processEnv: {
      ...process.env,
      HAPPIER_HOME_DIR: runtime.happierHomeDir,
    },
  }).catch(() => ({
    nodePath: runtime.nodePath,
    entryPath: runtime.entryPath,
  }));

  const expectedDefaultPlan = planDaemonServiceInstall({
    platform: runtime.platform,
    mode,
    systemUser: mode === 'system' ? systemUser : undefined,
    channel: runtime.channel,
    targetMode: 'default-following',
    instanceId: runtime.instanceId,
    uid: runtime.uid ?? undefined,
    userHomeDir: runtime.userHomeDir,
    happierHomeDir: runtime.happierHomeDir,
    serverUrl: runtime.serverUrl,
    webappUrl: runtime.webappUrl,
    publicServerUrl: runtime.publicServerUrl,
    nodePath: expectedDefaultRuntimeTarget.nodePath,
    entryPath: expectedDefaultRuntimeTarget.entryPath,
  });
  const expectedDefaultFile = expectedDefaultPlan.files[0] ?? null;
  if (!expectedDefaultFile) {
    return resolvedEntries;
  }

  return resolvedEntries.map((entry) => {
    if (
      entry.targetMode !== 'default-following'
      || entry.releaseChannel !== runtime.channel
    ) {
      return entry;
    }

    return {
      ...entry,
      installedDefinitionMatchesExpected: entry.path === expectedDefaultFile.path
        && doesInstalledDaemonServiceDefinitionMatchExpected({
          installedPath: entry.path,
          expectedContents: expectedDefaultFile.content,
        }),
    };
  });
}

export async function resolveDaemonServiceInstallationSnapshotFromEnv(options: Readonly<{
  mode?: DaemonServiceMode;
  systemUser?: string;
  processEnv?: NodeJS.ProcessEnv;
}> = {}): Promise<Readonly<{
  platform: DaemonServiceCliRuntime['platform'];
  installed: boolean;
  installedPath: string;
  label: string;
}>> {
  const { resolveDaemonServiceCliRuntimeFromEnv } = await import('./daemonServiceCliRuntime');
  const { resolveDaemonServicePaths } = await import('./resolveDaemonServicePaths');

  const runtime = resolveDaemonServiceCliRuntimeFromEnv(options);
  const paths = resolveDaemonServicePaths(runtime, { mode: options.mode });
  return {
    platform: runtime.platform,
    installed: isValidInstalledDaemonServiceFile({
      platform: runtime.platform,
      path: paths.installedPath,
      expectedLabel: paths.label,
    }),
    installedPath: paths.installedPath,
    label: paths.label,
  };
}
