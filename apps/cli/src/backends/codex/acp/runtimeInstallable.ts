import { compareVersions } from '@happier-dev/cli-common/update';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol';

import {
  getCodexAcpDepStatus,
  installCodexAcp,
  resolveExistingCodexAcpManagedBinPath,
} from '@/capabilities/deps/codexAcp';
import { logger } from '@/ui/logger';
import type { RuntimeInstallableAdapter, RuntimeInstallableLaunchResolution } from '@/installables/runtime/runtimeInstallablesRegistry';

import { resolveCodexAcpSpawn } from './resolveCommand';
import { validateCodexAcpSpawnAvailability } from './spawnAvailability';

type DetectDeps = Readonly<{
  resolveCodexAcpSpawn: typeof resolveCodexAcpSpawn;
  validateCodexAcpSpawnAvailability: typeof validateCodexAcpSpawnAvailability;
  resolveExistingCodexAcpManagedBinPath: typeof resolveExistingCodexAcpManagedBinPath;
}>;

type BackgroundUpdateDeps = Readonly<{
  getCodexAcpDepStatus: typeof getCodexAcpDepStatus;
  installCodexAcp: typeof installCodexAcp;
}>;

function hasExplicitCodexAcpOverride(env: NodeJS.ProcessEnv): boolean {
  return typeof env.HAPPIER_CODEX_ACP_BIN === 'string' && env.HAPPIER_CODEX_ACP_BIN.trim().length > 0;
}

export async function detectCodexAcpLaunchResolution(
  params: Readonly<{ env?: NodeJS.ProcessEnv }> = {},
  depsOverrides: Partial<DetectDeps> = {},
): Promise<RuntimeInstallableLaunchResolution> {
  const env = params.env ?? process.env;
  const deps: DetectDeps = {
    resolveCodexAcpSpawn: depsOverrides.resolveCodexAcpSpawn ?? resolveCodexAcpSpawn,
    validateCodexAcpSpawnAvailability:
      depsOverrides.validateCodexAcpSpawnAvailability ?? validateCodexAcpSpawnAvailability,
    resolveExistingCodexAcpManagedBinPath:
      depsOverrides.resolveExistingCodexAcpManagedBinPath ?? resolveExistingCodexAcpManagedBinPath,
  };

  try {
    const resolved = deps.resolveCodexAcpSpawn();
    const availability = deps.validateCodexAcpSpawnAvailability(resolved, { env });
    const managedPath = deps.resolveExistingCodexAcpManagedBinPath(env);
    return {
      availability,
      canAutoInstall: !hasExplicitCodexAcpOverride(env) && resolved.command === 'codex-acp' && !availability.ok,
      canBackgroundAutoUpdate: availability.ok && managedPath !== null && resolved.command === managedPath,
    };
  } catch (error) {
    return {
      availability: {
        ok: false,
        errorMessage: error instanceof Error ? error.message : 'Codex ACP could not be resolved',
      },
      canAutoInstall: false,
      canBackgroundAutoUpdate: false,
    };
  }
}

export async function runCodexAcpBackgroundAutoUpdateCheck(
  depsOverrides: Partial<BackgroundUpdateDeps> = {},
): Promise<void> {
  const deps: BackgroundUpdateDeps = {
    getCodexAcpDepStatus: depsOverrides.getCodexAcpDepStatus ?? getCodexAcpDepStatus,
    installCodexAcp: depsOverrides.installCodexAcp ?? installCodexAcp,
  };

  const status = await deps.getCodexAcpDepStatus({ includeLatestVersion: true, onlyIfInstalled: true });
  if (status.installed !== true) return;

  const installedVersion = status.installedVersion;
  const latestVersion = status.latestVersionCheck?.ok ? status.latestVersionCheck.latestVersion : null;
  if (!installedVersion || !latestVersion) return;
  if (compareVersions(latestVersion, installedVersion) <= 0) return;

  const installResult = await deps.installCodexAcp();
  if (!installResult.ok) {
    logger.warn(
      `[codex-acp] background upgrade failed: ${installResult.errorMessage}${
        installResult.logPath ? ` (install log: ${installResult.logPath})` : ''
      }`,
    );
  }
}

export const codexAcpRuntimeInstallable: RuntimeInstallableAdapter = {
  key: INSTALLABLE_KEYS.CODEX_ACP,
  detectLaunchResolution: detectCodexAcpLaunchResolution,
  installOrUpgrade: installCodexAcp,
  runBackgroundAutoUpdateCheck: runCodexAcpBackgroundAutoUpdateCheck,
};
