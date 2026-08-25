import { isActionEnabledByEnv } from '@/settings/actionsSettings';
import {
  isMemoryRecallGuidanceSupported,
  type MemoryRecallGuidanceSurface,
  type MemorySettingsV1,
} from '@happier-dev/protocol';

export async function resolveCliMemoryRecallGuidanceEnabled(args?: Readonly<{
  surfaces?: readonly MemoryRecallGuidanceSurface[];
  deps?: Readonly<{
    isActionEnabledByEnv?: typeof isActionEnabledByEnv;
    readMemorySettingsFromDisk?: () => Promise<MemorySettingsV1>;
  }>;
}>): Promise<boolean> {
  const readActionEnabled = args?.deps?.isActionEnabledByEnv ?? isActionEnabledByEnv;
  if (!isMemoryRecallGuidanceSupported({
    surfaces: args?.surfaces,
    isActionEnabled: (actionId, surface) => readActionEnabled(actionId, { surface }),
  })) {
    return false;
  }

  try {
    const readMemorySettingsFromDisk =
      args?.deps?.readMemorySettingsFromDisk
      ?? (await import('@/settings/memorySettings')).readMemorySettingsFromDisk;
    const settings = await readMemorySettingsFromDisk();
    return settings.enabled === true;
  } catch {
    return false;
  }
}
