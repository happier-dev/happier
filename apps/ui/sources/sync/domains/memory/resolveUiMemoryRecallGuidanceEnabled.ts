import { isMemoryRecallGuidanceSupported, type MemoryRecallGuidanceSurface } from '@happier-dev/protocol';

import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';
import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';
import { fetchDaemonMemoryStatus } from '@/sync/domains/memory/fetchDaemonMemoryStatus';
import { isDaemonMemorySearchUsable } from '@/sync/domains/memory/isDaemonMemorySearchUsable';

export async function resolveUiMemoryRecallGuidanceEnabled(args: Readonly<{
  settings: Record<string, unknown>;
  serverId: string | null | undefined;
  machineId: string | null | undefined;
  surfaces?: readonly MemoryRecallGuidanceSurface[];
  deps?: Readonly<{
    resolveLocalFeaturePolicyEnabled?: typeof resolveLocalFeaturePolicyEnabled;
    isActionEnabledInState?: typeof isActionEnabledInState;
    fetchDaemonMemoryStatus?: typeof fetchDaemonMemoryStatus;
    isDaemonMemorySearchUsable?: typeof isDaemonMemorySearchUsable;
  }>;
}>): Promise<boolean> {
  const readFeatureEnabled = args.deps?.resolveLocalFeaturePolicyEnabled ?? resolveLocalFeaturePolicyEnabled;
  if (!readFeatureEnabled('memory.search', args.settings as any)) {
    return false;
  }

  const readActionEnabled = args.deps?.isActionEnabledInState ?? isActionEnabledInState;
  if (!isMemoryRecallGuidanceSupported({
    surfaces: args.surfaces,
    isActionEnabled: (actionId, surface) => readActionEnabled({ settings: args.settings }, actionId, { surface }),
  })) {
    return false;
  }

  try {
    const readMemoryStatus = args.deps?.fetchDaemonMemoryStatus ?? fetchDaemonMemoryStatus;
    const isUsable = args.deps?.isDaemonMemorySearchUsable ?? isDaemonMemorySearchUsable;
    const status = await readMemoryStatus({
      serverId: args.serverId,
      machineId: args.machineId,
    });
    return isUsable(status);
  } catch {
    return false;
  }
}
