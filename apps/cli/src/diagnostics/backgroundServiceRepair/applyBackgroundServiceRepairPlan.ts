import { installDaemonService, uninstallDaemonService } from '@/daemon/service/installer';

import type { BackgroundServiceRepairApplyRuntime, BackgroundServiceRepairPlan } from './types';

export async function applyBackgroundServiceRepairPlan(
  plan: BackgroundServiceRepairPlan,
  runtime: BackgroundServiceRepairApplyRuntime,
): Promise<Readonly<{ executedActions: readonly string[] }>> {
  const executedActions: string[] = [];

  for (const action of plan.actions) {
    if (action.kind === 'remove-service') {
      await uninstallDaemonService({
        platform: runtime.platform,
        uid: runtime.uid ?? undefined,
        userHomeDir: runtime.userHomeDir,
        happierHomeDir: runtime.happierHomeDir,
        mode: action.service.mode,
        channel: action.service.releaseChannel,
        targetMode: action.service.targetMode,
        instanceId: action.service.instanceId,
        runCommands: true,
      });
      executedActions.push(`remove:${action.service.label}`);
      continue;
    }

    await installDaemonService({
      platform: runtime.platform,
      uid: runtime.uid ?? undefined,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
      mode: action.mode,
      systemUser: runtime.systemUser || undefined,
      channel: action.releaseChannel,
      targetMode: 'default-following',
      runCommands: true,
    });
    executedActions.push(`install-default:${action.releaseChannel}`);
  }

  return { executedActions };
}
