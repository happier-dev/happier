import { uninstallDaemonService } from '@/daemon/service/installer';
import { restartDaemonAndWait } from '@/daemon/restartDaemonAndWait';
import { resolvePublicReleaseRingIdForLabel } from '@happier-dev/release-runtime/releaseRings';

import type { HappierRuntimeRepairPlan, HappierRuntimeRepairResult } from './types';

function resolveModeFromScope(scope: 'user' | 'system'): 'user' | 'system' {
  return scope === 'system' ? 'system' : 'user';
}

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

    for (const service of action.services) {
      await uninstallDaemonService({
        platform: service.platform,
        mode: resolveModeFromScope(service.scope),
        channel: service.ring ? resolvePublicReleaseRingIdForLabel(service.ring) : undefined,
        instanceId: service.instanceId ?? undefined,
        runCommands: true,
      });
    }
    executedActions.push({ kind: action.kind });
  }

  return {
    executedActions,
  };
}
