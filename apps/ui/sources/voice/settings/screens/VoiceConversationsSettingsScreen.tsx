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
import { VoiceProviderSection } from '@/voice/settings/panels/VoiceProviderSection';
import {
  resolveVoiceSettingsRecoveryFocus,
  resolveVoiceSettingsRouteFocus,
} from '@/voice/settings/voiceSettingsRouteFocus';
import { useVoiceSettingsMutable } from '@/voice/settings/useVoiceSettingsMutable';
import { useVoiceConversationsReadinessInputs } from '@/voice/settings/useVoiceConversationsReadinessInputs';
import { VoiceSettingsSearchPrerequisite } from '@/voice/settings/VoiceSettingsSearchPrerequisite';

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
  const focusRecovery = React.useCallback((action: Parameters<typeof resolveVoiceSettingsRecoveryFocus>[0]) => {
    const focus = resolveVoiceSettingsRecoveryFocus(action);
    if (focus) router.setParams({ focus });
  }, [router]);
  const [voice, setVoice] = useVoiceSettingsMutable();
  const {
    happierVoiceSupported,
    executionMachine,
    daemonModelCatalog,
    localAvailability,
    daemonRouteDiagnosticReason,
  } = useVoiceConversationsReadinessInputs(voice, { probeMachine: true });
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
                  setVoice={setVoice}
                  popoverBoundaryRef={popoverBoundaryRef}
                  accountLead={accountLead}
                />
              )}
            />
          </View>
          {/* Lab C1/C2: Language follows the service (and a realtime service's own fields), before Hear. */}
          <VoiceConversationLanguageSection voice={voice} setVoice={setVoice} popoverBoundaryRef={popoverBoundaryRef} />
          <VoiceSettingsSearchPrerequisite intent="conversations" voice={voice} />
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
        </ItemList>
      </DaemonVoiceModelCatalogProvider>
    </View>
  );
}
