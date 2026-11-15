import { createActionSettingsProvider, type RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import type { isActionEnabled } from '@/settings/actionsSettings';
import { isMemoryRecallGuidanceSupported } from '@happier-dev/protocol/prompts/isMemoryRecallGuidanceSupported';
import type { MemoryRecallGuidanceSurface, MemorySettingsV1 } from '@happier-dev/protocol';

export async function resolveCliMemoryRecallGuidanceEnabled(args?: Readonly<{
  surfaces?: readonly MemoryRecallGuidanceSurface[];
  actionsSettingsProvider?: RuntimeActionSettingsProvider;
  deps?: Readonly<{
    isActionEnabled?: typeof isActionEnabled;
    readMemorySettingsFromDisk?: () => Promise<MemorySettingsV1>;
  }>;
}>): Promise<boolean> {
  const provider = args?.actionsSettingsProvider ?? createActionSettingsProvider();
  const settings = provider.getActionsSettings();
  const readActionEnabled: typeof isActionEnabled = args?.deps?.isActionEnabled
    ?? ((actionId, context) => isActionEnabledByActionsSettings(actionId, settings, context));
  if (!isMemoryRecallGuidanceSupported({
    surfaces: args?.surfaces,
    isActionEnabled: (actionId, surface) => readActionEnabled(actionId, { surface }),
  })) {
    return false;
  }

  try {
    const readMemorySettingsFromDisk =
      args?.deps?.readMemorySettingsFromDisk
      ?? (await import('../../../settings/memorySettings')).readMemorySettingsFromDisk;
    const settings = await readMemorySettingsFromDisk();
    return settings.enabled === true;
  } catch {
    return false;
  }
}
