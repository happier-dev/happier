import * as React from 'react';
import { View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useScrollRectIntoViewRegistry } from '@/components/ui/scroll/useScrollRectIntoView';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useHappierVoiceSupport } from '@/hooks/server/useHappierVoiceSupport';
import { t } from '@/text';
import { LANGUAGES } from '@/constants/Languages';

import { useVoiceSettingsMutable } from '@/voice/settings/useVoiceSettingsMutable';
import { VoiceProviderSection } from '@/voice/settings/panels/VoiceProviderSection';
import { VoicePrivacySection } from '@/voice/settings/panels/VoicePrivacySection';
import { VoiceUiSection } from '@/voice/settings/panels/VoiceUiSection';
import { BundledConversationSettingsSection } from '@/voice/settings/panels/BundledConversationSettingsSection';
import { LocalDirectSection } from '@/voice/settings/panels/LocalDirectSection';
import { LocalConversationSection } from '@/voice/settings/panels/LocalConversationSection';
import { VoiceExecutionMachineSection } from '@/voice/settings/panels/VoiceExecutionMachineSection';
import { resolveVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';
import {
  resolveVoiceDaemonModelKindAvailabilityFromCatalogState,
  resolveVoiceDaemonModelAvailabilityFromCatalogState,
  resolveVoiceDaemonRouteDiagnosticReason,
  useVoiceProviderLocalAvailability,
} from '@/voice/settings/voiceProviderLocalAvailability';
import type { VoiceProviderLocalAvailability } from '@/voice/settings/voiceProviderLocalAvailability';
import {
  parseLocalVoiceSttSettings,
  parseLocalVoiceTtsSettings,
  resolveLocalVoiceAdapterSettings,
} from '@/voice/local/localVoiceSettings';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { useDaemonVoiceModelCatalogState } from '@/voice/settings/panels/modelCatalog/useDaemonVoiceModelCatalogState';
import { DaemonVoiceModelCatalogProvider } from '@/voice/settings/panels/modelCatalog/DaemonVoiceModelCatalogContext';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import {
  readLocalConversationVoiceSettings,
  readLocalDirectVoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { VoiceDiagnosticsSettingsSection } from '@/voice/diagnostics/VoiceDiagnosticsSettingsSection';
import { resolveVoiceSettingsRouteFocus } from '@/voice/settings/voiceSettingsRouteFocus';
import { DictationSettingsSection } from '@/voice/dictation/DictationSettingsSection';
import { createVoiceDictationRuntimeSettingsSnapshot } from '@/voice/dictation/voiceDictationRuntimeSettings';
import { VoiceHistorySettingsEntry } from '@/voice/history/VoiceHistorySettingsEntry';

export default function VoiceSettingsScreen() {
  const routeParams = useLocalSearchParams<{ focus?: string | string[] }>();
  const routeFocus = resolveVoiceSettingsRouteFocus(routeParams.focus);
  const focusRegistry = useScrollRectIntoViewRegistry({
    activeKey: routeFocus,
    alignment: 'center',
    animated: false,
    once: true,
  });
  const onPrivacySectionLayout = React.useMemo(
    () => focusRegistry.registerItemLayout('privacy'),
    [focusRegistry.registerItemLayout],
  );
  const onProviderSectionLayout = React.useMemo(
    () => focusRegistry.registerItemLayout('provider'),
    [focusRegistry.registerItemLayout],
  );
  const { theme } = useUnistyles();
  const [voice, setVoice] = useVoiceSettingsMutable();
  const happierVoiceSupported = useHappierVoiceSupport();
  const providerId = resolveVoiceProviderId(voice.providerId);
  const dictationRuntimeSettings = React.useMemo(
    () => createVoiceDictationRuntimeSettingsSnapshot({ voice }),
    [voice],
  );
  const dictationLocalStt = parseLocalVoiceSttSettings(
    resolveLocalVoiceAdapterSettings(dictationRuntimeSettings).config.stt,
  );
  const daemonCatalogEnabled = providerId === 'local_direct'
    || providerId === 'local_conversation'
    || dictationLocalStt.provider === 'local_neural';
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
  const dictationDaemonModelAvailability = React.useMemo(
    () => resolveVoiceDaemonModelKindAvailabilityFromCatalogState({
      loading: daemonModelCatalog.state.loading,
      errorCode: daemonModelCatalog.state.errorCode,
      statuses: daemonModelCatalog.state.statuses,
      kind: 'stt_sherpa',
      selectedPackId: dictationLocalStt.localNeural.assetId,
    }),
    [
      daemonModelCatalog.state.errorCode,
      daemonModelCatalog.state.loading,
      daemonModelCatalog.state.statuses,
      dictationLocalStt.localNeural.assetId,
    ],
  );
  const localAvailability = useVoiceProviderLocalAvailability({
    daemonModelState: daemonModelAvailability.modelState,
    daemonRuntimeState: daemonModelAvailability.runtimeState,
    daemonMachineId,
  });
  const dictationLocalAvailability = React.useMemo<VoiceProviderLocalAvailability>(
    () => ({
      ...localAvailability,
      ...(localAvailability.daemon
        ? {
            daemon: {
              ...localAvailability.daemon,
              modelState: dictationDaemonModelAvailability.modelState,
              runtimeState: dictationDaemonModelAvailability.runtimeState,
            },
          }
        : {}),
    }),
    [dictationDaemonModelAvailability, localAvailability],
  );
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
                        <Ionicons name="sparkles-outline" size={20} color={theme.colors.text.secondary} />
                      </View>
                ),
              },
              ...LANGUAGES.flatMap((lang) => {
                const code = lang.code;
                if (typeof code !== 'string' || code.length === 0) return [];
                return [
                  {
                    id: code,
                    title: lang.name,
                    subtitle: code,
                    icon: (
                      <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name="language-outline" size={20} color={theme.colors.text.secondary} />
                      </View>
                    ),
                  },
                ];
              }),
            ]}
            onSelect={(id) => {
              const nextLanguage = id ? id : null;
              setVoice({
                ...voice,
                assistantLanguage: nextLanguage,
              });
              setOpenMenu(null);
            }}
          />
        </ItemGroup>

        <DictationSettingsSection
          voice={voice}
          setVoice={setVoice}
          popoverBoundaryRef={popoverBoundaryRef}
          executionMachineId={executionMachine.machineId}
          localAvailability={dictationLocalAvailability}
          daemonRouteDiagnosticReason={daemonRouteDiagnosticReason}
        />

        <VoiceUiSection voice={voice} setVoice={setVoice} popoverBoundaryRef={popoverBoundaryRef} />

        <BundledConversationSettingsSection voice={voice} setVoice={setVoice} popoverBoundaryRef={popoverBoundaryRef} />
        <VoiceExecutionMachineSection
          voice={voice}
          setVoice={setVoice}
          popoverBoundaryRef={popoverBoundaryRef}
        />
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

        <View
          testID="settings.voice.section.privacy"
          onLayout={onPrivacySectionLayout}
        >
          <VoicePrivacySection voice={voice} setVoice={setVoice} />
        </View>
        <VoiceHistorySettingsEntry />
        <VoiceDiagnosticsSettingsSection voice={voice} setVoice={setVoice} />
      </ItemList>
      </DaemonVoiceModelCatalogProvider>
    </View>
  );
}
