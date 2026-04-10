import { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServiceListEntries } from '@/daemon/service/cli';
import { isDaemonServiceModeSupported } from '@/daemon/service/assertDaemonServiceModeSupported';
import type { DaemonServiceMode } from '@/daemon/service/plan';

import { buildBackgroundServiceRepairPlan } from './buildBackgroundServiceRepairPlan';

export async function resolveBackgroundServiceRepairPlanForCurrentRuntime(params: Readonly<{
  preferredMode: DaemonServiceMode;
  includeAllModes: boolean;
  systemUser: string;
}>): Promise<Readonly<{
  runtime: ReturnType<typeof resolveDaemonServiceCliRuntimeFromEnv>;
  services: readonly Awaited<ReturnType<typeof resolveDaemonServiceListEntries>>[number][];
  scannedModes: readonly DaemonServiceMode[];
  plan: ReturnType<typeof buildBackgroundServiceRepairPlan>;
}>> {
  const runtime = resolveDaemonServiceCliRuntimeFromEnv({
    mode: params.preferredMode,
    systemUser: params.systemUser,
  });
  const scannedModes = (params.includeAllModes
    ? (['user', 'system'] as const)
    : ([params.preferredMode] as const)
  ).filter((mode) => isDaemonServiceModeSupported(runtime.platform, mode));

  const serviceLists = await Promise.all(scannedModes.map(async (mode) => {
    const modeRuntime = resolveDaemonServiceCliRuntimeFromEnv({
      mode,
      systemUser: params.systemUser,
    });
    return await resolveDaemonServiceListEntries(modeRuntime, { mode });
  }));
  const services = serviceLists.flat();
  const plan = buildBackgroundServiceRepairPlan({
    currentReleaseChannel: runtime.channel,
    preferredMode: params.preferredMode,
    services,
  });

  return {
    runtime,
    services,
    scannedModes,
    plan,
  };
}
