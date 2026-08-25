import * as React from 'react';
import { View } from 'react-native';

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { LANGUAGES } from '@/constants/Languages';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useScrollRectIntoViewRegistry } from '@/components/ui/scroll/useScrollRectIntoView';
import { useHappierVoiceSupport } from '@/hooks/server/useHappierVoiceSupport';
import {
  readLocalConversationVoiceSettings,
  readLocalDirectVoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import {
  parseLocalVoiceSttSettings,
  parseLocalVoiceTtsSettings,
} from '@/voice/local/localVoiceSettings';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { BundledConversationSettingsSection } from '@/voice/settings/panels/BundledConversationSettingsSection';
import { LocalConversationSection } from '@/voice/settings/panels/LocalConversationSection';
import { LocalDirectSection } from '@/voice/settings/panels/LocalDirectSection';
import { VoiceExecutionMachineSection } from '@/voice/settings/panels/VoiceExecutionMachineSection';
import { DaemonVoiceModelCatalogProvider } from '@/voice/settings/panels/modelCatalog/DaemonVoiceModelCatalogContext';
import { useDaemonVoiceModelCatalogState } from '@/voice/settings/panels/modelCatalog/useDaemonVoiceModelCatalogState';
import { VoiceProviderSection } from '@/voice/settings/panels/VoiceProviderSection';
import { resolveVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';
import {
  resolveVoiceSettingsRecoveryFocus,
  resolveVoiceSettingsRouteFocus,
} from '@/voice/settings/voiceSettingsRouteFocus';
import { useVoiceSettingsMutable } from '@/voice/settings/useVoiceSettingsMutable';
import {
  resolveVoiceDaemonModelAvailabilityFromCatalogState,
  resolveVoiceDaemonRouteDiagnosticReason,
  useVoiceProviderLocalAvailability,
} from '@/voice/settings/voiceProviderLocalAvailability';

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
  const { theme } = useUnistyles();
  const [voice, setVoice] = useVoiceSettingsMutable();
  const happierVoiceSupported = useHappierVoiceSupport();
  const providerId = resolveVoiceProviderId(voice.providerId);
  const daemonCatalogEnabled = providerId === 'local_direct'
    || providerId === 'local_conversation';
  const executionMachine = useVoiceExecutionMachinePresentation();
  const daemonMachineId = daemonCatalogEnabled ? executionMachine.machineId : null;
  const daemonModelCatalog = useDaemonVoiceModelCatalogState({
    enabled: daemonCatalogEnabled,
    refreshKey: daemonMachineId,
  });
  const activeLocalAdapter = providerId === 'local_direct'
    ? readLocalDirectVoiceSettings(voice)
    : readLocalConversationVoiceSettings(voice);
  const activeLocalStt = parseLocalVoiceSttSettings(activeLocalAdapter.stt);
  const activeLocalTts = parseLocalVoiceTtsSettings(activeLocalAdapter.tts);
  const requiresDaemonSttModel = activeLocalStt.provider === 'local_neural'
    && resolveLocalNeuralExecutionPolicy({
      requestedExecution: activeLocalStt.localNeural.execution,
    }).preferredExecution === 'daemon';
  const requiresDaemonTtsModel = activeLocalTts.provider === 'local_neural'
    && resolveLocalNeuralExecutionPolicy({
      requestedExecution: activeLocalTts.localNeural.execution,
    }).preferredExecution === 'daemon';
  const daemonModelAvailability = React.useMemo(
    () => resolveVoiceDaemonModelAvailabilityFromCatalogState({
      loading: daemonModelCatalog.state.loading,
      errorCode: daemonModelCatalog.state.errorCode,
      statuses: daemonModelCatalog.state.statuses,
      selectedSttPackId: activeLocalStt.localNeural?.assetId ?? null,
      selectedTtsPackId: activeLocalTts.localNeural?.assetId ?? null,
      requireStt: requiresDaemonSttModel,
      requireTts: requiresDaemonTtsModel,
    }),
    [
      activeLocalStt.localNeural?.assetId,
      activeLocalTts.localNeural?.assetId,
      daemonModelCatalog.state.errorCode,
      daemonModelCatalog.state.loading,
      daemonModelCatalog.state.statuses,
      requiresDaemonSttModel,
      requiresDaemonTtsModel,
    ],
  );
  const localAvailability = useVoiceProviderLocalAvailability({
    daemonModelState: daemonModelAvailability.modelState,
    daemonRuntimeState: daemonModelAvailability.runtimeState,
    daemonMachineId,
  });
  const daemonRouteDiagnosticReason = React.useMemo(
    () => resolveVoiceDaemonRouteDiagnosticReason(localAvailability),
    [localAvailability],
  );
  const popoverBoundaryRef = React.useRef<any>(null);
  const [openMenu, setOpenMenu] = React.useState<null | 'assistantLanguage'>(null);
  const effectiveAssistantLanguageId = voice.assistantLanguage ?? null;

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
            />
          </View>

          <View testID="settings.voice.section.executionMachine" onLayout={onExecutionMachineSectionLayout}>
            <VoiceExecutionMachineSection
              voice={voice}
              setVoice={setVoice}
              intent="conversations"
              popoverBoundaryRef={popoverBoundaryRef}
            />
          </View>

          <ItemGroup title={t('settingsVoice.languageTitle')} footer={t('settingsVoice.languageDescription')}>
            <DropdownMenu
              open={openMenu === 'assistantLanguage'}
              onOpenChange={(next) => setOpenMenu(next ? 'assistantLanguage' : null)}
              variant="selectable"
              search={true}
              searchPlaceholder={t('settingsVoice.preferredLanguage')}
              selectedId={effectiveAssistantLanguageId ?? ''}
              showCategoryTitles={false}
              matchTriggerWidth={true}
              connectToTrigger={true}
              rowKind="item"
              popoverBoundaryRef={popoverBoundaryRef}
              itemTrigger={{
                title: t('settingsVoice.preferredLanguage'),
                subtitle: t('settingsVoice.preferredLanguageSubtitle'),
                showSelectedSubtitle: false,
              }}
              items={[
                {
                  id: '',
                  title: t('settingsVoice.language.autoDetect'),
                  subtitle: t('settingsVoice.language.autoDetectSubtitle'),
                  icon: (
                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                      <Icon name="sparkle" size={20} color={theme.colors.text.secondary} />
                    </View>
                  ),
                },
                ...LANGUAGES.flatMap((lang) => {
                  const code = lang.code;
                  if (typeof code !== 'string' || code.length === 0) return [];
                  return [{
                    id: code,
                    title: lang.name,
                    subtitle: code,
                    icon: (
                      <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                        <Icon name="translate" size={20} color={theme.colors.text.secondary} />
                      </View>
                    ),
                  }];
                }),
              ]}
              onSelect={(id) => {
                setVoice({
                  ...voice,
                  assistantLanguage: id || null,
                });
                setOpenMenu(null);
              }}
            />
          </ItemGroup>

          <BundledConversationSettingsSection voice={voice} setVoice={setVoice} popoverBoundaryRef={popoverBoundaryRef} />
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
              daemonModelCatalog={daemonModelCatalog}
              daemonRouteDiagnosticReason={daemonRouteDiagnosticReason}
            />
          </View>
        </ItemList>
      </DaemonVoiceModelCatalogProvider>
    </View>
  );
}
