import { compareVersions } from '@happier-dev/cli-common/update';
import type { InstallableDependencyDescriptor } from '@happier-dev/protocol';
import { resolveManagedDependencyCommand, validateManagedDependencyCommand, type ManagedDependencyCommand } from '@happier-dev/cli-common/agents';
import { sessionProcessEnvironment, sessionWorkingDirectory } from '@/agent/runtime/lifecycle/hostedSessionScope';

import { getManagedBinaryDepStatus, resolveExistingManagedBinaryPath } from '@/capabilities/deps/managedBinary';
import { logger } from '@/ui/logger';
import type { RuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';

export function createConfiguredBinaryRuntimeInstallableAdapter(
  descriptor: InstallableDependencyDescriptor,
  hostAdapter: RuntimeInstallableAdapter,
): RuntimeInstallableAdapter {
  const declaration = descriptor.source.kind === 'github_release_binary' ? descriptor.source.launch : undefined;
  const binaryName = descriptor.binary.commands[0];
  if (!declaration || !binaryName) throw new Error(`${descriptor.display.name} launch declaration is unavailable`);
  const resolveManagedBin = (env: NodeJS.ProcessEnv) => resolveExistingManagedBinaryPath(descriptor, env);
  const hasExplicitOverride = (env: NodeJS.ProcessEnv) => Boolean(env[declaration.overrideEnvironmentKey]?.trim());
  const resolveSpawn = (env: NodeJS.ProcessEnv, resolveExistingManagedBinPath = resolveManagedBin) => resolveManagedDependencyCommand({
    binaryName, displayName: descriptor.display.name, declaration, env, resolveExistingManagedBinPath,
    currentWorkingDirectory: sessionWorkingDirectory(),
  });
  const validate = (spec: ManagedDependencyCommand, env: NodeJS.ProcessEnv) => validateManagedDependencyCommand(spec, binaryName, { env });

  return {
    ...hostAdapter,
    key: descriptor.key,
    capabilityId: descriptor.capabilityId,
    detectCapabilityStatus: (params) => getManagedBinaryDepStatus(descriptor, params),
    detectLaunchResolution: async (params = {}) => {
      const env = params.env ?? sessionProcessEnvironment();
      try {
        const resolved = resolveSpawn(env);
        const availability = validate(resolved, env);
        const managedPath = resolveManagedBin(env);
        return {
          availability,
          canAutoInstall: !hasExplicitOverride(env) && resolved.command === binaryName && !availability.ok,
          canBackgroundAutoUpdate: availability.ok && managedPath !== null && resolved.command === managedPath,
        };
      } catch (error) {
        return {
          availability: { ok: false, errorMessage: error instanceof Error ? error.message : `${descriptor.display.name} could not be resolved` },
          canAutoInstall: false, canBackgroundAutoUpdate: false,
        };
      }
    },
    resolveLaunchCommand: async (params = {}) => {
      const env = params.env ?? sessionProcessEnvironment();
      try {
        const explicitOverride = hasExplicitOverride(env);
        const managedPath = resolveManagedBin(env);
        const systemAvailable = validate({ command: binaryName, args: [] }, env).ok;
        const resolved = resolveSpawn(env, params.sourcePreference !== 'managed-first' && systemAvailable ? () => null : resolveManagedBin);
        const availability = validate(resolved, env);
        if (!availability.ok) return { ok: false, errorMessage: availability.errorMessage, canAutoInstall: !explicitOverride && resolved.command === binaryName };
        return {
          ok: true, command: resolved.command, args: resolved.args,
          source: explicitOverride ? 'user_config' : managedPath && resolved.command === managedPath ? 'managed' : resolved.command === binaryName ? 'system' : 'unknown',
        };
      } catch (error) {
        return { ok: false, errorMessage: error instanceof Error ? error.message : `${descriptor.display.name} could not be resolved`, canAutoInstall: false };
      }
    },
    runBackgroundAutoUpdateCheck: async () => {
      const status = await getManagedBinaryDepStatus(descriptor, { includeLatestVersion: true, onlyIfInstalled: true });
      if (!status.installed) return;
      const installedVersion = status.installedVersion;
      const latestVersion = status.latestVersionCheck?.ok ? status.latestVersionCheck.latestVersion : null;
      if (!installedVersion || !latestVersion || compareVersions(latestVersion, installedVersion) <= 0) return;
      const result = await hostAdapter.installOrUpgrade();
      if (!result.ok) logger.warn(`[${descriptor.key}] background upgrade failed: ${result.errorMessage}${result.logPath ? ` (install log: ${result.logPath})` : ''}`);
    },
  };
}
