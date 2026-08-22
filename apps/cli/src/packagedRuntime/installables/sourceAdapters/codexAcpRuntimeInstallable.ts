import { compareVersions } from '@happier-dev/cli-common/update';
import type { CapabilityId, InstallableDependencyDescriptor, InstallableKey } from '@happier-dev/protocol';

import {
  getCodexAcpDepStatus,
  installCodexAcp,
  resolveExistingCodexAcpManagedBinPath,
} from '@/capabilities/deps/codexAcp';
import { logger } from '@/ui/logger';
import type {
  RuntimeInstallableAdapter,
  RuntimeInstallableLaunchCommandResolution,
  RuntimeInstallableLaunchResolution,
} from '@/packagedRuntime/installables/registry';

type DetectDeps = Readonly<{
  resolveCodexAcpSpawn: () => { command: string; args: readonly string[] };
  validateCodexAcpSpawnAvailability: CodexAcpRuntimeInstallableContribution['validateAvailability'];
  resolveExistingCodexAcpManagedBinPath: typeof resolveExistingCodexAcpManagedBinPath;
}>;

export type CodexAcpRuntimeInstallableContribution = Readonly<{
  resolveSpawnSpec: (
    opts?: Readonly<{ env?: NodeJS.ProcessEnv }>,
    deps?: Readonly<{
      resolveExistingManagedBinPath?: (env?: NodeJS.ProcessEnv) => string | null;
    }>,
  ) => { command: string; args: readonly string[] };
  validateAvailability: (
    spec: Readonly<{ command: string; args: readonly string[] }>,
    opts?: Readonly<{ env?: NodeJS.ProcessEnv }>,
  ) => Readonly<{ ok: true } | { ok: false; errorMessage: string }>;
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
  contribution?: CodexAcpRuntimeInstallableContribution,
): Promise<RuntimeInstallableLaunchResolution> {
  const env = params.env ?? process.env;
  const resolveManagedBin =
    depsOverrides.resolveExistingCodexAcpManagedBinPath ?? resolveExistingCodexAcpManagedBinPath;
  const deps: DetectDeps = {
    resolveCodexAcpSpawn:
      depsOverrides.resolveCodexAcpSpawn ?? (() => contribution?.resolveSpawnSpec(
        { env },
        { resolveExistingManagedBinPath: resolveManagedBin },
      ) ?? (() => { throw new Error('Codex ACP runtime installable contribution is unavailable'); })()),
    validateCodexAcpSpawnAvailability:
      depsOverrides.validateCodexAcpSpawnAvailability
      ?? contribution?.validateAvailability
      ?? (() => ({ ok: false, errorMessage: 'Codex ACP runtime installable contribution is unavailable' })),
    resolveExistingCodexAcpManagedBinPath: resolveManagedBin,
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

export async function resolveCodexAcpLaunchCommand(
  params: Readonly<{
    env?: NodeJS.ProcessEnv;
    sourcePreference?: 'system-first' | 'managed-first';
  }> = {},
  depsOverrides: Partial<DetectDeps> = {},
  contribution?: CodexAcpRuntimeInstallableContribution,
): Promise<RuntimeInstallableLaunchCommandResolution> {
  const env = params.env ?? process.env;
  const resolveManagedBin =
    depsOverrides.resolveExistingCodexAcpManagedBinPath ?? resolveExistingCodexAcpManagedBinPath;
  const validateAvailability =
    depsOverrides.validateCodexAcpSpawnAvailability
    ?? contribution?.validateAvailability
    ?? (() => ({ ok: false as const, errorMessage: 'Codex ACP runtime installable contribution is unavailable' }));
  const explicitOverride = hasExplicitCodexAcpOverride(env);
  const managedPath = resolveManagedBin(env);
  const systemAvailable = validateAvailability({ command: 'codex-acp', args: [] }, { env }).ok;
  const preferSystem = params.sourcePreference !== 'managed-first';
  const resolveExistingManagedBinPath =
    preferSystem && systemAvailable
      ? () => null
      : resolveManagedBin;

  try {
    const resolved = depsOverrides.resolveCodexAcpSpawn
      ? depsOverrides.resolveCodexAcpSpawn()
      : contribution?.resolveSpawnSpec({ env }, { resolveExistingManagedBinPath })
        ?? (() => { throw new Error('Codex ACP runtime installable contribution is unavailable'); })();
    const availability = validateAvailability(resolved, { env });
    if (!availability.ok) {
      return {
        ok: false,
        errorMessage: availability.errorMessage,
        canAutoInstall: !explicitOverride && resolved.command === 'codex-acp',
      };
    }

    return {
      ok: true,
      command: resolved.command,
      args: resolved.args,
      source: explicitOverride
        ? 'user_config'
        : managedPath && resolved.command === managedPath
          ? 'managed'
          : resolved.command === 'codex-acp'
            ? 'system'
            : 'unknown',
    };
  } catch (error) {
    return {
      ok: false,
      errorMessage: error instanceof Error ? error.message : 'Codex ACP could not be resolved',
      canAutoInstall: false,
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

export function createCodexAcpRuntimeInstallableAdapter(
  descriptor: Readonly<Pick<InstallableDependencyDescriptor, 'key' | 'capabilityId'>>,
  contribution: CodexAcpRuntimeInstallableContribution,
): RuntimeInstallableAdapter {
  return {
    key: descriptor.key as InstallableKey,
    capabilityId: descriptor.capabilityId as Extract<CapabilityId, `dep.${string}`>,
    detectCapabilityStatus: getCodexAcpDepStatus,
    detectLaunchResolution: (params) => detectCodexAcpLaunchResolution(params, {}, contribution),
    resolveLaunchCommand: (params) => resolveCodexAcpLaunchCommand(params, {}, contribution),
    installOrUpgrade: installCodexAcp,
    runBackgroundAutoUpdateCheck: runCodexAcpBackgroundAutoUpdateCheck,
  };
}
