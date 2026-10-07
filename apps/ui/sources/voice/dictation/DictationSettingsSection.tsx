import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import {
  VoiceRuntimePlatformSchema,
  type VoiceRuntimePlatform,
} from '@happier-dev/protocol/voice/realtime/capabilities';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { LANGUAGES } from '@/constants/Languages';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { VOICE_DICTATION_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { restoreFocusToBestTarget } from '@/keyboard/focusReturn';
import {
  writeLocalDirectVoiceSettings,
  writeLocalConversationVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { useSettings } from '@/sync/domains/state/storage';
import { useSettingsVersion } from '@/sync/store/hooks';
import { t, tLoose } from '@/text';
import {
  getLocalSttProviderSpec,
  useLocalSttProviderSpecs,
} from '@/voice/settings/panels/localStt/providers/registry';
import type {
  VoiceDaemonRouteDiagnosticReason,
  VoiceProviderLocalAvailability,
} from '@/voice/settings/voiceProviderLocalAvailability';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { translateVoiceReadiness } from '@/voice/settings/panels/voiceProviderReadinessPresentation';
import { applyVoiceDictationEngineChoice } from '@/voice/registry/providerSelection';
import type { VoiceReadinessFact, VoiceRoleReadiness } from '@/voice/registry/readiness';
import { resolveLocalVoiceAdapterSettings } from '@/voice/local/localVoiceSettings';
import { inspectVoiceDictationSettingsReadiness, projectVoiceRawSpeechReadinessTargets } from '@/voice/settings/voiceProviderReadinessInspection';

import {
  voiceDictationSettingsDefaults,
} from './voiceDictationSettings';
import {
  resolveVoiceDictationNativeLocalNeuralModelSelection,
  resolveVoiceDictationReadiness,
} from './voiceDictationReadiness';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import { VoicePipelineView } from '@/voice/settings/pipeline/VoicePipelineView';
import { buildVoiceDictationPipeline } from '@/voice/settings/pipeline/voicePipelineSteps';
import { asIconName } from '@/components/ui/icons/asIconName';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';

const voiceProviderRegistry = createDefaultVoiceProviderRegistry();

type DictationReadinessCheck = Readonly<{
  providerId: string;
  nativeModelPackId: string | null;
  status: 'checking' | 'checked';
  nativeLocalNeuralModel: VoiceReadinessFact | null;
  rawCredentialAuthorization: 'ready' | 'approval_required' | 'unknown' | null;
  rawAuthorizationKey: string;
}>;

function resolveRuntimePlatform(): VoiceRuntimePlatform | 'unknown' {
  const parsed = VoiceRuntimePlatformSchema.safeParse(Platform.OS);
  return parsed.success ? parsed.data : 'unknown';
}

/** The automatic language's menu id; language codes never collide with it. */
const AUTOMATIC_LANGUAGE_ID = 'automatic';

/**
 * Shares selected Dictation facts with the hub. The passive check is the returned operation: the
 * Dictation page runs it when it opens and when the checked setup changes; the hub never does.
 */

export function useVoiceDictationReadinessModel(props: Readonly<{
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
  executionMachineId: string | null;
  executionMachineSelectionKind?: 'resolved' | 'selected_unreachable' | 'none';
  localAvailability: VoiceProviderLocalAvailability;
  daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
  onRecoveryAction?: (action: VoiceRoleReadiness['recoveryAction']) => void;
}>) {
  const { theme } = useUnistyles();
  const providerSpecs = useLocalSttProviderSpecs('dictation_stt');
  const accountSettings = useSettings();
  const savedSecretCatalog = useSavedSecretCatalog();
  const settingsVersion = useSettingsVersion();
  const dictation = props.voice.dictation ?? voiceDictationSettingsDefaults;
  const [openMenu, setOpenMenu] = React.useState<null | 'language'>(null);
  const [readinessCheck, setReadinessCheck] = React.useState<DictationReadinessCheck | null>(null);
  const nativeModelCheckInFlight = React.useRef(false);
  const providerControlRef = React.useRef<React.ComponentRef<typeof Pressable> | null>(null);
  const platform = resolveRuntimePlatform();
  const readinessSettings = { ...accountSettings, voice: props.voice };
  const nativeModelSelection = resolveVoiceDictationNativeLocalNeuralModelSelection({
    registry: voiceProviderRegistry,
    settings: readinessSettings,
    platform,
  });
  const selectedRawSpeechTarget = projectVoiceRawSpeechReadinessTargets(readinessSettings, voiceProviderRegistry, props.executionMachineId, 'dictation')[0] ?? null;
  const selectedRawSpeechContribution = selectedRawSpeechTarget?.contribution ?? null;
  const rawAuthorizationKey = JSON.stringify({
    target: selectedRawSpeechTarget,
    machineId: props.executionMachineId,
    realm: 'daemon',
    phase: 'speech',
    settingsVersion,
    savedSecretCatalog: {
      status: savedSecretCatalog.status,
      stale: savedSecretCatalog.stale,
      entries: savedSecretCatalog.sharedEntries.map((entry) => ({
        ref: entry.ref,
        revision: entry.revision,
        materialStatus: entry.materialStatus,
      })),
    },
  });
  const isCurrentReadinessCheck = readinessCheck !== null
    && readinessCheck.providerId === nativeModelSelection.providerId
    && readinessCheck.nativeModelPackId === nativeModelSelection.packId
    && readinessCheck.rawAuthorizationKey === rawAuthorizationKey;
  const isCheckingReadiness = readinessCheck?.status === 'checking';
  const checkedReadiness = isCurrentReadinessCheck && readinessCheck?.status === 'checked'
    ? resolveVoiceDictationReadiness({
        registry: voiceProviderRegistry,
        settings: readinessSettings,
        platform,
        executionMachineId: props.executionMachineId,
        executionMachineSelectionKind: props.executionMachineSelectionKind,
        localAvailability: props.localAvailability,
        nativeLocalNeuralModel: readinessCheck.nativeLocalNeuralModel ?? undefined,
        resolveSavedSecret: savedSecretCatalog.resolveReference,
        ...(selectedRawSpeechContribution && readinessCheck.rawCredentialAuthorization
          ? {
              rawCredentialAuthorization: {
                contribution: selectedRawSpeechContribution,
                machineId: props.executionMachineId,
                realm: 'daemon',
                phase: 'speech',
                status: readinessCheck.rawCredentialAuthorization,
              },
            }
          : {}),
      })
    : null;
  const recoveryAction = checkedReadiness?.recoveryAction ?? 'none';
  const recoveryActionHandler = recoveryAction === 'none'
    ? null
    : props.onRecoveryAction ?? null;
  const selectedId = dictation.sttBinding === 'same_as_local'
    ? 'same_as_local'
    : dictation.stt.provider;
  const localAdapter = resolveLocalVoiceAdapterSettings({ voice: props.voice });
  const selectedStt = dictation.sttBinding === 'explicit'
    ? dictation.stt
    : localAdapter.config.stt;
  const providerSpec = getLocalSttProviderSpec(selectedStt.provider, 'dictation_stt');
  const setDictation = (next: typeof dictation): void => {
    setReadinessCheck((current) => current?.status === 'checking' ? current : null);
    props.setVoice({ ...props.voice, dictation: next });
  };
  const checkSetup = React.useCallback(() => {
    if (nativeModelCheckInFlight.current || isCheckingReadiness) return;
    const { providerId, packId } = nativeModelSelection;
    if (!packId && !selectedRawSpeechContribution) {
      setReadinessCheck({
        providerId,
        nativeModelPackId: null,
        status: 'checked',
        nativeLocalNeuralModel: null,
        rawCredentialAuthorization: null,
        rawAuthorizationKey,
      });
      return;
    }

    // This ref only closes the native event-batching gap before the existing
    // checking state has rendered. It stores no request identity or history.
    nativeModelCheckInFlight.current = true;
    setReadinessCheck({
      providerId,
      nativeModelPackId: packId,
      status: 'checking',
      nativeLocalNeuralModel: null,
      rawCredentialAuthorization: null,
      rawAuthorizationKey,
    });
    void inspectVoiceDictationSettingsReadiness({ packId, rawTarget: selectedRawSpeechTarget }).then(({ nativeLocalNeuralModel, rawCredentialAuthorization }) => {
      nativeModelCheckInFlight.current = false;
      setReadinessCheck((current) => (
        current?.status === 'checking'
        && current.providerId === providerId
        && current.nativeModelPackId === packId
          ? {
              ...current,
              status: 'checked',
              nativeLocalNeuralModel,
              rawCredentialAuthorization,
            }
          : current
      ));
    });
  }, [isCheckingReadiness, nativeModelSelection, rawAuthorizationKey, selectedRawSpeechTarget]);
  const handleRecoveryAction = React.useCallback(() => {
    if (!recoveryActionHandler) return;
    if (recoveryAction === 'switch_provider') {
      restoreFocusToBestTarget(providerControlRef);
    }
    recoveryActionHandler(recoveryAction);
  }, [recoveryAction, recoveryActionHandler]);

  const engineOptions: ReadonlyArray<Readonly<{ id: string; title: string; subtitle?: string; iconName: IconName }>> = [
    ...providerSpecs.map((spec) => ({
      id: spec.id,
      title: spec.title,
      subtitle: spec.subtitle,
      iconName: asIconName(spec.iconName) ?? 'microphone',
    })),
    {
      id: 'same_as_local',
      title: t('settingsVoice.pages.dictation.sameAsConversations'),
      subtitle: t('settingsVoice.pages.dictation.sameAsConversationsUses', {
        engine: getLocalSttProviderSpec(localAdapter.config.stt.provider)?.title ?? localAdapter.config.stt.provider,
      }),
      iconName: 'link',
    },
  ];
  const selectEngine = (id: string) => {
    if (id === selectedId) return;
    const voice = applyVoiceDictationEngineChoice(props.voice, voiceProviderRegistry, id);
    if (!voice) return;
    setReadinessCheck((current) => current?.status === 'checking' ? current : null);
    props.setVoice(voice);
  };

  const projectReadiness = (settings: typeof readinessSettings) => resolveVoiceDictationReadiness({
    registry: voiceProviderRegistry, settings, platform,
    executionMachineId: props.executionMachineId,
    executionMachineSelectionKind: props.executionMachineSelectionKind,
    localAvailability: props.localAvailability,
    resolveSavedSecret: savedSecretCatalog.resolveReference,
  });
  const readiness = checkedReadiness ?? projectReadiness(readinessSettings);
  /** What choosing this engine would need, from the same readiness owner as the card. Only the page asks. */
  const readinessForEngine = (id: string): VoiceRoleReadiness | null => {
    if (id === selectedId) return readiness;
    const voice = applyVoiceDictationEngineChoice(props.voice, voiceProviderRegistry, id);
    return voice ? projectReadiness({ ...accountSettings, voice }) : null;
  };

  return {
    engineOptions, selectedId, theme, providerControlRef, selectEngine, providerSpec, selectedStt,
    dictation, setDictation, setReadinessCheck, localAdapter, openMenu, setOpenMenu,
    isCheckingReadiness, checkSetup, checkedReadiness, recoveryActionHandler, handleRecoveryAction,
    readinessCheckKey: JSON.stringify([nativeModelSelection.providerId, nativeModelSelection.packId, rawAuthorizationKey]),
    isCurrentReadinessCheck,
    readiness,
    readinessForEngine,
  };
}

export function DictationSettingsSection(props: Parameters<typeof useVoiceDictationReadinessModel>[0]) {
  const {
    engineOptions, selectedId, theme, providerControlRef, selectEngine, providerSpec, selectedStt,
    dictation, setDictation, setReadinessCheck, localAdapter, openMenu, setOpenMenu,
    isCheckingReadiness, checkSetup, recoveryActionHandler, handleRecoveryAction, readiness,
    readinessCheckKey, isCurrentReadinessCheck, readinessForEngine,
  } = useVoiceDictationReadinessModel(props);
  // Always-on card readiness (lab D): the model's passive check runs when this page opens and whenever
  // the engine, model pack or credential it checks changes. The hub reads the same model and never
  // renders this section, so it never probes. Passive only: no microphone, no audio.
  const checkSetupRef = React.useRef(checkSetup);
  checkSetupRef.current = checkSetup;
  React.useEffect(() => {
    if (!isCurrentReadinessCheck && !isCheckingReadiness) checkSetupRef.current();
  }, [readinessCheckKey, isCurrentReadinessCheck, isCheckingReadiness]);
  const executionMachine = useVoiceExecutionMachinePresentation();
  const dictationPipeline = React.useMemo(() => buildVoiceDictationPipeline({
    sttProviderId: selectedStt.provider,
    sttTitle: providerSpec?.title ?? selectedStt.provider,
    localNeuralExecution: selectedStt.localNeural?.execution ?? null,
    readiness,
    machine: { machineId: executionMachine.selectedMachineId, machineLabel: executionMachine.machineLabel },
  }), [executionMachine.machineLabel, executionMachine.selectedMachineId, providerSpec?.title, readiness, selectedStt]);

  return (
    <View testID="settings.voice.section.dictation">
      <SettingAnchor setting={VOICE_DICTATION_SETTINGS.settings.readiness}>
      <ItemGroup surface="none">
        <VoicePipelineView
          testID="settings.voice.dictation.pipeline"
          title={t('settingsVoice.intents.dictation.title')}
          purpose={t('settingsVoice.pages.dictation.pipelinePurpose')}
          pipeline={dictationPipeline}
          // The card carries the readiness and its recovery; the model's handler also returns focus.
          onRecoveryAction={recoveryActionHandler ? () => handleRecoveryAction() : undefined}
        />
      </ItemGroup>
      </SettingAnchor>
      <SettingAnchor setting={VOICE_DICTATION_SETTINGS.settings.provider}>
      <ItemGroup
        title={t('settingsVoice.pages.dictation.engineTitle')}
        description={t('settingsVoice.pages.dictation.engineDescription')}
        accessibilityRole="radiogroup"
        accessibilityLabel={t('settingsVoice.pages.dictation.engineTitle')}
      >
        {engineOptions.map((option) => {
          const selected = option.id === selectedId;
          const engineReadiness = readinessForEngine(option.id);
          const needsYou = engineReadiness && engineReadiness.status !== 'ready' ? engineReadiness : null;
          return (
            <Item
              key={option.id}
              testID={`settings.voice.dictation.engine.${encodeURIComponent(option.id)}`}
              icon={<Icon name={option.iconName} size={20} color={theme.colors.text.secondary} />}
              title={option.title}
              subtitle={option.subtitle}
              subtitleLines={0}
              subtitleAccessory={needsYou ? (
                <View
                  testID={`settings.voice.dictation.engine.${encodeURIComponent(option.id)}.needs`}
                  style={styles.engineNeeds}
                >
                  <StatusDot color={theme.colors.state.warning.foreground} size={6} />
                  <Text style={styles.engineNeedsText}>{translateVoiceReadiness(needsYou.reasonKey, { service: option.title })}</Text>
                </View>
              ) : undefined}
              accessibilityRole="radio"
              webRole="radio"
              selected={selected}
              pressableRef={selected ? providerControlRef : undefined}
              rightElement={selected ? <Icon name="check-circle" size={22} color={theme.colors.text.primary} /> : null}
              showChevron={false}
              onPress={() => selectEngine(option.id)}
            />
          );
        })}

        {providerSpec ? (
          <providerSpec.Settings
            cfgStt={selectedStt}
            setStt={(stt) => {
              if (dictation.sttBinding === 'explicit') {
                setDictation({ ...dictation, stt });
                return;
              }
              setReadinessCheck((current) => current?.status === 'checking' ? current : null);
              const nextLocalAdapterSettings = {
                ...localAdapter.config,
                stt,
              };
              props.setVoice(localAdapter.adapterId === 'local_direct'
                ? writeLocalDirectVoiceSettings(props.voice, nextLocalAdapterSettings)
                : writeLocalConversationVoiceSettings(props.voice, nextLocalAdapterSettings));
            }}
            voice={props.voice}
            setVoice={props.setVoice}
            popoverBoundaryRef={props.popoverBoundaryRef}
            daemonRouteDiagnosticReason={props.daemonRouteDiagnosticReason}
          />
        ) : null}
      </ItemGroup>
      </SettingAnchor>

      <ItemGroup title={t('settingsVoice.pages.dictation.languageTitle')}>
        <SettingAnchor setting={VOICE_DICTATION_SETTINGS.settings.language}>
          <DropdownMenu
            open={openMenu === 'language'}
            onOpenChange={(next) => setOpenMenu(next ? 'language' : null)}
            variant="selectable"
            search={true}
            searchPlaceholder={t('settingsVoice.preferredLanguage')}
            // An empty id reads as "nothing chosen"; automatic is a real choice with its own id.
            selectedId={dictation.language ?? AUTOMATIC_LANGUAGE_ID}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            popoverBoundaryRef={props.popoverBoundaryRef}
            itemTrigger={{
              title: t('settingsVoice.pages.dictation.dictateInTitle'),
              subtitle: t('settingsVoice.pages.dictation.dictateInDescription'),
              showSelectedSubtitle: false,
              itemProps: { subtitleLines: 0 },
            }}
            items={[
              {
                id: AUTOMATIC_LANGUAGE_ID,
                title: t('settingsVoice.pages.conversations.iSpeakAutomatic'),
                subtitle: t('settingsVoice.language.autoDetectSubtitle'),
                icon: (
                  <Icon name="sparkle" size={20} color={theme.colors.text.secondary} />
                ),
              },
              ...LANGUAGES.flatMap((language) => typeof language.code === 'string' && language.code
                ? [{
                    id: language.code,
                    title: language.name,
                    subtitle: language.code,
                    icon: (
                      <Icon name="translate" size={20} color={theme.colors.text.secondary} />
                    ),
                  }]
                : []),
            ]}
            onSelect={(id) => {
              setDictation({ ...dictation, language: id === AUTOMATIC_LANGUAGE_ID ? null : id });
              setOpenMenu(null);
            }}
          />
        </SettingAnchor>
      </ItemGroup>

    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  engineNeeds: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  engineNeedsText: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    flexShrink: 1,
    color: theme.colors.state.warning.foreground,
  },
}));
