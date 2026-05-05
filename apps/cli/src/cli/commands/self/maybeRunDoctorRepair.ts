import { resolveBackgroundServiceRepairPlanForCurrentRuntime } from '@/diagnostics/backgroundServiceRepair/resolveBackgroundServiceRepairPlanForCurrentRuntime';
import { resolveDaemonServiceCliRuntimeFromEnv } from '@/daemon/service/cli';

import { handleServiceRepairCliCommand } from '../service/repair/handleServiceRepairCliCommand';

export async function maybeRunDoctorRepair(params: Readonly<{
  migrationRan: boolean;
}>): Promise<boolean> {
  if (params.migrationRan) {
    return false;
  }

  const runtime = resolveDaemonServiceCliRuntimeFromEnv({
    processEnv: process.env,
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

  await handleServiceRepairCliCommand({
    argv: ['repair'],
    commandPath: 'happier service',
  });
  return true;
}
