import * as React from 'react';
import { View } from 'react-native';

import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { ItemList } from '@/components/ui/lists/ItemList';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { useScrollRectIntoViewRegistry } from '@/components/ui/scroll/useScrollRectIntoView';
import { t } from '@/text';
import { BundledConversationSettingsSection } from '@/voice/settings/panels/BundledConversationSettingsSection';
import { LocalConversationSection } from '@/voice/settings/panels/LocalConversationSection';
import { LocalDirectSection } from '@/voice/settings/panels/LocalDirectSection';
import { VoiceExecutionMachineSection } from '@/voice/settings/panels/VoiceExecutionMachineSection';
import { VoiceConversationLanguageSection } from '@/voice/settings/panels/VoiceConversationLanguageSection';
import { DaemonVoiceModelCatalogProvider } from '@/voice/settings/panels/modelCatalog/DaemonVoiceModelCatalogContext';
import { VoiceDuringConversationSection, VoiceProviderSection } from '@/voice/settings/panels/VoiceProviderSection';
import {
  resolveVoiceSettingsRecoveryFocus,
  resolveVoiceSettingsRecoveryTarget,
  resolveVoiceSettingsRouteFocus,
} from '@/voice/settings/voiceSettingsRouteFocus';
import { useVoiceSettingsMutable } from '@/voice/settings/useVoiceSettingsMutable';
import { useVoiceSettingsReadinessInputs } from '@/voice/settings/useVoiceSettingsReadinessInputs';
import { useVoiceProviderSettingsRecovery } from '@/voice/settings/panels/realtime/VoiceProviderSettingsActions';

export function VoiceConversationsSettingsScreen() {
  const routeParams = useLocalSearchParams<{ focus?: string | string[] }>();
  const router = useRouter();
  const routeFocus = resolveVoiceSettingsRouteFocus(routeParams.focus);
  const focusRegistry = useScrollRectIntoViewRegistry({
    activeKey: routeFocus,
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
  const onLocalSectionLayout = React.useMemo(
    () => focusRegistry.registerItemLayout('local'),
    [focusRegistry.registerItemLayout],
  );
  // A card that needs a machine opens the header's "Runs on" chooser: one machine control per page.
  const [machineChooserOpen, setMachineChooserOpen] = React.useState(false);
  React.useEffect(() => {
    if (routeFocus === 'execution_machine') setMachineChooserOpen(true);
  }, [routeFocus]);
  const [voice, setVoice] = useVoiceSettingsMutable();
  const recoverProviderSettings = useVoiceProviderSettingsRecovery(voice);
  const focusRecovery = React.useCallback((action: Parameters<typeof resolveVoiceSettingsRecoveryTarget>[0]) => {
    if (recoverProviderSettings(action)) return;
    if (resolveVoiceSettingsRecoveryFocus(action) === 'execution_machine') {
      setMachineChooserOpen(true);
      return;
    }
    const target = resolveVoiceSettingsRecoveryTarget(action, voice.providerId);
    if (typeof target === 'string') router.push(target);
    else if (target) router.setParams(target.params ?? {});
  }, [recoverProviderSettings, router, voice.providerId]);
  const {
    happierVoiceSupported,
    executionMachine,
    daemonModelCatalog,
    localAvailability,
    daemonRouteDiagnosticReason,
  } = useVoiceSettingsReadinessInputs(voice, { purpose: 'conversation', probeMachine: true });
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
            description={t('settingsVoice.pages.conversations.description')}
            actions={(
              <View testID="settings.voice.section.executionMachine" onLayout={onExecutionMachineSectionLayout}>
                <VoiceExecutionMachineSection
                  voice={voice}
                  setVoice={setVoice}
                  intent="conversations"
                  presentation="chip"
                  chooserOpen={machineChooserOpen}
                  onChooserOpenChange={setMachineChooserOpen}
                  popoverBoundaryRef={popoverBoundaryRef}
                />
              </View>
            )}
          />
          <View
            testID="settings.voice.section.provider"
            onLayout={onProviderSectionLayout}
          >
            <VoiceProviderSection
              voice={voice}
              setVoice={setVoice}
              happierVoiceSupported={happierVoiceSupported}
              localAvailability={localAvailability}
              executionMachineId={executionMachine.machineId}
              executionMachineSelectedId={executionMachine.selectedMachineId}
              executionMachineSelectionKind={executionMachine.selectionKind}
              popoverBoundaryRef={popoverBoundaryRef}
              onRecoveryAction={focusRecovery}
              // One Account section: Pay with leads the service's own account group.
              renderServiceSettings={(accountLead) => (
                <BundledConversationSettingsSection
                  voice={voice}
                  popoverBoundaryRef={popoverBoundaryRef}
                  accountLead={accountLead}
                />
              )}
            />
          </View>
          {/* Lab C1/C2: Language follows the service (and a realtime service's own fields), before Hear. */}
          <VoiceConversationLanguageSection voice={voice} setVoice={setVoice} popoverBoundaryRef={popoverBoundaryRef} />
          <View testID="settings.voice.section.local" onLayout={onLocalSectionLayout}>
            <LocalDirectSection
              voice={voice}
              setVoice={setVoice}
              popoverBoundaryRef={popoverBoundaryRef}
              daemonRouteDiagnosticReason={daemonRouteDiagnosticReason}
            />
            <LocalConversationSection
              voice={voice}
              setVoice={setVoice}
              popoverBoundaryRef={popoverBoundaryRef}
              daemonRouteDiagnosticReason={daemonRouteDiagnosticReason}
            />
          </View>
          <VoiceDuringConversationSection voice={voice} setVoice={setVoice} />
        </ItemList>
      </DaemonVoiceModelCatalogProvider>
    </View>
  );
}
