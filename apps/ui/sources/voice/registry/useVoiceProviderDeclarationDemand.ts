import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { usePluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useVoiceExecutionMachineId } from '@/voice/credentials/useExecutionMachinePresentation';

/** Presented provider choices acquire declarations, independently of executable demand. */
export function useVoiceProviderDeclarationDemand(enabled = true): void {
  const presented = useLayoutPresentationActive();
  const machineId = useVoiceExecutionMachineId();
  const scope = useAccountSettingsScope();
  // AppShell observes this same cache and section set to publish Voice descriptors.
  // A narrower family read would leave its complete presentation unanswered.
  usePluginUiProjectionCurrentness({
    machineId,
    serverId: scope?.serverId,
    enabled: enabled && presented,
  });
}
