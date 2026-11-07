import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { ItemList } from '@/components/ui/lists/ItemList';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { t } from '@/text';
import { useScrollRectIntoViewRegistry } from '@/components/ui/scroll/useScrollRectIntoView';
import { DictationSettingsSection } from '@/voice/dictation/DictationSettingsSection';
import { VoiceExecutionMachineSection } from '@/voice/settings/panels/VoiceExecutionMachineSection';
import { DaemonVoiceModelCatalogProvider } from '@/voice/settings/panels/modelCatalog/DaemonVoiceModelCatalogContext';
import { useVoiceSettingsReadinessInputs } from '@/voice/settings/useVoiceSettingsReadinessInputs';
import { useVoiceSettingsMutable } from '@/voice/settings/useVoiceSettingsMutable';
import {
  resolveVoiceSettingsRecoveryFocus,
  resolveVoiceSettingsRouteFocus,
} from '@/voice/settings/voiceSettingsRouteFocus';

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
  // A card that needs a machine opens the header's "Runs on" chooser: one machine control per page.
  const [machineChooserOpen, setMachineChooserOpen] = React.useState(false);
  const focusRecovery = React.useCallback((action: Parameters<typeof resolveVoiceSettingsRecoveryFocus>[0]) => {
    const focus = resolveVoiceSettingsRecoveryFocus(action);
    if (focus === 'execution_machine') setMachineChooserOpen(true);
    else if (focus) router.setParams({ focus: focus === 'local' ? 'provider' : focus });
  }, [router]);
  const [voice, setVoice] = useVoiceSettingsMutable();
  const { executionMachine, daemonModelCatalog, localAvailability, daemonRouteDiagnosticReason } =
    useVoiceSettingsReadinessInputs(voice, { purpose: 'dictation', probeMachine: true });
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
        >
          <SettingsPageHeader
            description={t('settingsVoice.pages.dictation.description')}
            actions={(
              <View testID="settings.voice.section.executionMachine" onLayout={onExecutionMachineSectionLayout}>
                <VoiceExecutionMachineSection
                  voice={voice}
                  setVoice={setVoice}
                  intent="dictation"
                  presentation="chip"
                  chooserOpen={machineChooserOpen}
                  onChooserOpenChange={setMachineChooserOpen}
                  popoverBoundaryRef={popoverBoundaryRef}
                />
              </View>
            )}
          />
          <View onLayout={onProviderSectionLayout}>
            <DictationSettingsSection
              voice={voice}
              setVoice={setVoice}
              popoverBoundaryRef={popoverBoundaryRef}
              executionMachineId={executionMachine.machineId}
              executionMachineSelectionKind={executionMachine.selectionKind}
              localAvailability={localAvailability}
              daemonRouteDiagnosticReason={daemonRouteDiagnosticReason}
              onRecoveryAction={focusRecovery}
            />
          </View>
        </ItemList>
      </DaemonVoiceModelCatalogProvider>
    </View>
  );
}
