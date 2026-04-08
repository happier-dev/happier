import { restartDaemonAndWait } from '@/daemon/restartDaemonAndWait';
import { installDaemonService } from '@/daemon/service/installer';
import { uninstallDiscoveredHappierService } from '@/daemon/service/uninstallDiscoveredHappierService';

import type { HappierRuntimeRepairPlan, HappierRuntimeRepairResult } from './types';

export async function applyHappierRuntimeRepairPlan(plan: HappierRuntimeRepairPlan): Promise<HappierRuntimeRepairResult> {
  const executedActions: HappierRuntimeRepairResult['executedActions'] = [];

  for (const action of plan.actions) {
    if (action.kind === 'restart-daemon') {
      const restarted = await restartDaemonAndWait();
      if (!restarted) {
        throw new Error('Failed to restart the daemon while applying doctor repair.');
      }
      executedActions.push({ kind: action.kind });
      continue;
    }

    if (action.kind === 'install-default-following-service') {
      await installDaemonService({
        mode: action.mode,
        runCommands: true,
        targetMode: 'default-following',
      });
      executedActions.push({ kind: action.kind });
      continue;
    }

    for (const service of action.services) {
      await uninstallDiscoveredHappierService({
        platform: service.platform,
        backend: service.backend,
        scope: service.scope,
        label: service.label,
        definitionPath: service.definitionPath,
        runCommands: true,
      });
    }
    executedActions.push({ kind: action.kind });
  }

  return {
    executedActions,
  };
}
