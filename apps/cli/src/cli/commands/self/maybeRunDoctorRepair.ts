import { spawnSync } from 'node:child_process';
import { resolveInstalledFirstPartyComponentPaths, resolveManagedCliToolNameForRing } from '@happier-dev/cli-common/firstPartyRuntime';
import { getReleaseRingPublicLabel, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { configuration } from '@/configuration';
import { resolveBackgroundServiceRepairPlanForCurrentRuntime } from '@/diagnostics/backgroundServiceRepair/resolveBackgroundServiceRepairPlanForCurrentRuntime';
import { resolveDaemonServiceCliRuntimeFromEnv } from '@/daemon/service/cli';

export async function maybeRunDoctorRepair(params: Readonly<{
  migrationRan: boolean;
  channel: PublicReleaseRingId;
}>): Promise<boolean> {
  if (params.migrationRan) {
    return false;
  }

  const runtime = resolveDaemonServiceCliRuntimeFromEnv({
    mode: 'user',
  });
  const repairState = await resolveBackgroundServiceRepairPlanForCurrentRuntime({
    preferredMode: 'user',
    includeAllModes: runtime.platform === 'linux',
    systemUser: '',
  });
  if (repairState.plan.actions.length === 0 && repairState.plan.manualWarnings.length === 0) {
    return false;
  }

  // Activation changes the installed CLI, not the code/version already loaded
  // by the updater. Diagnose and repair through the newly activated authority.
  const binaryPath = resolveInstalledFirstPartyComponentPaths({
    componentId: 'happier-cli', channel: params.channel, processEnv: process.env,
  }).binaryPath;
  const result = spawnSync(binaryPath, ['doctor', 'repair'], {
    stdio: 'inherit', windowsHide: true,
    env: {
      ...process.env,
      HAPPIER_HOME_DIR: configuration.happyHomeDir,
      HAPPIER_PUBLIC_RELEASE_CHANNEL: getReleaseRingPublicLabel(params.channel),
      HAPPIER_DAEMON_SERVICE_CHANNEL: params.channel,
      HAPPIER_DAEMON_SERVICE_NODE_PATH: binaryPath,
      HAPPIER_DAEMON_SERVICE_ENTRY_PATH: '',
    },
  });
  if (result.status !== 0) {
    const detail = result.error?.message ?? `exit status ${result.status ?? 'unknown'}`;
    console.warn(`The CLI update succeeded, but its follow-up repair failed (${detail}). Run \`${resolveManagedCliToolNameForRing(params.channel)} doctor repair\` to retry.`);
  }
  return true;
}
