import {
  resolvePiShellBridgeAvailabilityForRuntime,
  type PiShellBridgeAvailability,
} from '@/backends/pi/shellBridge/resolvePiShellBridgeAvailability';
import type {
  DaemonSpawnHooks,
  DaemonSpawnRuntimeSelection,
  DaemonSpawnValidationResult,
} from '@/daemon/spawnHooks';
import { validateProviderCliSpawn } from '@/runtime/managedTools/validateProviderCliSpawn';

type PiDaemonShellBridgeContext = Readonly<{
  directory?: string;
  environmentVariables?: NodeJS.ProcessEnv;
}>;

type PiShellBridgeAvailabilityResolver = (
  context: PiDaemonShellBridgeContext,
) => PiShellBridgeAvailability;

const resolvePiDaemonShellBridgeAvailability: PiShellBridgeAvailabilityResolver = (context) =>
  resolvePiShellBridgeAvailabilityForRuntime({
    directory: context.directory,
    env: context.environmentVariables,
    includeProjectSettings: true,
  });

export async function validatePiDaemonSpawn(
  runtimeSelection: DaemonSpawnRuntimeSelection,
  resolveAvailability: PiShellBridgeAvailabilityResolver = resolvePiDaemonShellBridgeAvailability,
): Promise<DaemonSpawnValidationResult> {
  const cli = await validateProviderCliSpawn({ agentId: 'pi', processEnv: runtimeSelection.environmentVariables });
  if (!cli.ok) return cli;

  const availability = resolveAvailability({
    directory: runtimeSelection.directory,
    environmentVariables: runtimeSelection.environmentVariables,
  });
  if (availability.available) return { ok: true };

  return {
    ok: false,
    reasonCode: 'pi_shell_bridge_unavailable',
    errorMessage: availability.errorMessage,
  };
}

export const piDaemonSpawnHooks: DaemonSpawnHooks = {
  validateSpawn: validatePiDaemonSpawn,
};
