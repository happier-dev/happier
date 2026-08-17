import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { ItemList } from '@/components/ui/lists/ItemList';
import { useScrollRectIntoViewRegistry } from '@/components/ui/scroll/useScrollRectIntoView';
import { createVoiceDictationRuntimeSettingsSnapshot } from '@/voice/dictation/voiceDictationRuntimeSettings';
import { DictationSettingsSection } from '@/voice/dictation/DictationSettingsSection';
import {
  parseLocalVoiceSttSettings,
  resolveLocalVoiceAdapterSettings,
} from '@/voice/local/localVoiceSettings';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import { VoiceExecutionMachineSection } from '@/voice/settings/panels/VoiceExecutionMachineSection';
import { DaemonVoiceModelCatalogProvider } from '@/voice/settings/panels/modelCatalog/DaemonVoiceModelCatalogContext';
import { useDaemonVoiceModelCatalogState } from '@/voice/settings/panels/modelCatalog/useDaemonVoiceModelCatalogState';
import { useVoiceSettingsMutable } from '@/voice/settings/useVoiceSettingsMutable';
import {
  resolveVoiceSettingsRecoveryFocus,
  resolveVoiceSettingsRouteFocus,
} from '@/voice/settings/voiceSettingsRouteFocus';
import {
  resolveVoiceDaemonModelKindAvailabilityFromCatalogState,
  resolveVoiceDaemonRouteDiagnosticReason,
  useVoiceProviderLocalAvailability,
  type VoiceProviderLocalAvailability,
} from '@/voice/settings/voiceProviderLocalAvailability';

const NO_DAEMON_MODEL_AVAILABILITY = Object.freeze({
  modelState: 'unknown' as const,
  runtimeState: 'unknown' as const,
});

export function VoiceDictationSettingsScreen() {
  const routeParams = useLocalSearchParams<{ focus?: string | string[] }>();
  const router = useRouter();
  const routeFocus = resolveVoiceSettingsRouteFocus(routeParams.focus);
  const focusRegistry = useScrollRectIntoViewRegistry({
    activeKey: routeFocus === 'local' ? 'provider' : routeFocus,
    alignment: 'center',
    animated: false,
    once: true,
  });
  const onProviderSectionLayout = React.useMemo(
    () => focusRegistry.registerItemLayout('provider'),
    [focusRegistry.registerItemLayout],
  );
  const onExecutionMachineSectionLayout = React.useMemo(
    () => focusRegistry.registerItemLayout('execution_machine'),
    [focusRegistry.registerItemLayout],
  );
  const focusRecovery = React.useCallback((action: Parameters<typeof resolveVoiceSettingsRecoveryFocus>[0]) => {
    const focus = resolveVoiceSettingsRecoveryFocus(action);
    if (focus) router.setParams({ focus: focus === 'local' ? 'provider' : focus });
  }, [router]);
  const [voice, setVoice] = useVoiceSettingsMutable();
  const executionMachine = useVoiceExecutionMachinePresentation();
  const dictationRuntimeSettings = React.useMemo(
    () => createVoiceDictationRuntimeSettingsSnapshot({ voice }),
    [voice],
  );
  const dictationLocalStt = parseLocalVoiceSttSettings(
    resolveLocalVoiceAdapterSettings(dictationRuntimeSettings).config.stt,
  );
  const daemonCatalogEnabled = dictationLocalStt.provider === 'local_neural'
    && resolveLocalNeuralExecutionPolicy({
      requestedExecution: dictationLocalStt.localNeural.execution,
    }).preferredExecution === 'daemon';
  const daemonMachineId = daemonCatalogEnabled ? executionMachine.machineId : null;
  const daemonModelCatalog = useDaemonVoiceModelCatalogState({
    enabled: daemonCatalogEnabled,
    refreshKey: daemonMachineId,
  });
  const dictationDaemonModelAvailability = React.useMemo(
    () => daemonCatalogEnabled
      ? resolveVoiceDaemonModelKindAvailabilityFromCatalogState({
        loading: daemonModelCatalog.state.loading,
        errorCode: daemonModelCatalog.state.errorCode,
        statuses: daemonModelCatalog.state.statuses,
        kind: 'stt_sherpa',
        selectedPackId: dictationLocalStt.localNeural.assetId,
      })
      : NO_DAEMON_MODEL_AVAILABILITY,
    [
      daemonCatalogEnabled,
      daemonModelCatalog.state.errorCode,
      daemonModelCatalog.state.loading,
      daemonModelCatalog.state.statuses,
      dictationLocalStt.localNeural.assetId,
    ],
  );
  const localAvailability = useVoiceProviderLocalAvailability({
    daemonModelState: dictationDaemonModelAvailability.modelState,
    daemonRuntimeState: dictationDaemonModelAvailability.runtimeState,
    daemonMachineId,
  });
  const dictationLocalAvailability = React.useMemo<VoiceProviderLocalAvailability>(() => ({
    ...localAvailability,
    ...(localAvailability.daemon ? {
      daemon: {
        ...localAvailability.daemon,
        modelState: dictationDaemonModelAvailability.modelState,
        runtimeState: dictationDaemonModelAvailability.runtimeState,
      },
    } : {}),
  }), [dictationDaemonModelAvailability, localAvailability]);
  const daemonRouteDiagnosticReason = React.useMemo(
    () => resolveVoiceDaemonRouteDiagnosticReason(dictationLocalAvailability),
    [dictationLocalAvailability],
  );
  const popoverBoundaryRef = React.useRef<any>(null);

  return (
    <View style={{ flex: 1 }} ref={popoverBoundaryRef}>
      <DaemonVoiceModelCatalogProvider value={daemonModelCatalog}>
        <ItemList
          ref={focusRegistry.scrollRef}
          onLayout={focusRegistry.onViewportLayout}
          onContentSizeChange={focusRegistry.onContentSizeChange}
          onScroll={focusRegistry.onScroll}
          scrollEventThrottle={16}
          style={{ paddingTop: 0 }}
        >
          <View onLayout={onProviderSectionLayout}>
            <DictationSettingsSection
              voice={voice}
              setVoice={setVoice}
              popoverBoundaryRef={popoverBoundaryRef}
              executionMachineId={executionMachine.machineId}
              executionMachineSelectionKind={executionMachine.selectionKind}
              localAvailability={dictationLocalAvailability}
              daemonRouteDiagnosticReason={daemonRouteDiagnosticReason}
              onRecoveryAction={focusRecovery}
            />
          </View>
          <View testID="settings.voice.section.executionMachine" onLayout={onExecutionMachineSectionLayout}>
            <VoiceExecutionMachineSection
              voice={voice}
              setVoice={setVoice}
              intent="dictation"
              popoverBoundaryRef={popoverBoundaryRef}
            />
          </View>
        </ItemList>
      </DaemonVoiceModelCatalogProvider>
    </View>
  );
}
