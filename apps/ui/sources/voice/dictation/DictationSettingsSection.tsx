import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import {
  VoiceRuntimePlatformSchema,
  type VoiceRuntimePlatform,
} from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';

import { LANGUAGES } from '@/constants/Languages';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
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
import { resolveVoiceProviderReadinessPresentation } from '@/voice/settings/panels/voiceProviderReadinessPresentation';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { selectVoiceSpeechProvider } from '@/voice/registry/providerSelection';
import type { VoiceReadinessFact, VoiceRoleReadiness } from '@/voice/registry/readiness';
import { resolveLocalVoiceAdapterSettings } from '@/voice/local/localVoiceSettings';
import { inspectRawCredentialAuthorizationReadiness } from '@/voice/credentials/rawCredentialAuthorizationClient';
import {
  resolveAccountVoiceCredentialSourceSelection,
  resolveSelectedVoiceCredentialRawGrants,
} from '@/voice/credentials/accountVoiceCredential';

import {
  voiceDictationSettingsDefaults,
} from './voiceDictationSettings';
import { readVoiceDictationNativeModelReadiness } from './voiceDictationNativeModelReadiness';
import {
  resolveVoiceDictationNativeLocalNeuralModelSelection,
  resolveVoiceDictationReadiness,
} from './voiceDictationReadiness';
import { Icon } from '@/components/ui/icons/Icon';

const voiceProviderRegistry = createDefaultVoiceProviderRegistry();

type DictationReadinessCheck = Readonly<{
  providerId: string;
  nativeModelPackId: string | null;
  status: 'checking' | 'checked';
  nativeLocalNeuralModel: VoiceReadinessFact | null;
  rawCredentialAuthorization: 'ready' | 'approval_required' | 'unknown' | null;
  rawAuthorizationKey: string;
}>;

function aggregateRawCredentialAuthorizationReadiness(
  statuses: readonly ('ready' | 'approval_required' | 'unknown')[],
): 'ready' | 'approval_required' | 'unknown' {
  if (statuses.some((status) => status === 'unknown')) return 'unknown';
  if (statuses.some((status) => status === 'approval_required')) return 'approval_required';
  return 'ready';
}

function resolveRuntimePlatform(): VoiceRuntimePlatform | 'unknown' {
  const parsed = VoiceRuntimePlatformSchema.safeParse(Platform.OS);
  return parsed.success ? parsed.data : 'unknown';
}

function readinessSubtitle(readiness: ReturnType<typeof resolveVoiceDictationReadiness>): string {
  if (readiness.status === 'ready') {
    return t('settingsVoice.dictation.readiness.ready');
  }
  const presentation = resolveVoiceProviderReadinessPresentation(readiness, tLoose);
  return [presentation.reason, presentation.action]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' · ');
}

export function DictationSettingsSection(props: Readonly<{
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
  const settingsVersion = useSettingsVersion();
  const dictation = props.voice.dictation ?? voiceDictationSettingsDefaults;
  const [openMenu, setOpenMenu] = React.useState<null | 'provider' | 'language'>(null);
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
  const selectedSpeechEntry = voiceProviderRegistry.get(nativeModelSelection.providerId);
  const selectedRawSpeechTarget = (() => {
    if (selectedSpeechEntry?.kind !== 'voice.speech-engine.v1'
      || selectedSpeechEntry.declaration?.kind !== 'speech'
      || !selectedSpeechEntry.declaration.credentials) return null;
    const contribution = {
      pluginId: selectedSpeechEntry.pluginId,
      localId: selectedSpeechEntry.declaration.id,
    };
    try {
      const source = resolveAccountVoiceCredentialSourceSelection({
        settings: accountSettings,
        contribution,
        credentialSlotId: selectedSpeechEntry.declaration.credentials.slot.id,
        purpose: {
          consumer: contribution,
          purpose: selectedSpeechEntry.declaration.credentials.slot.purpose,
        },
        machineId: props.executionMachineId,
      });
      const rawGrants = resolveSelectedVoiceCredentialRawGrants({
        declaration: selectedSpeechEntry.declaration,
        contribution,
        selection: source.selection,
        access: { realm: 'daemon', phase: 'speech' },
      });
      return rawGrants.length > 0 ? { contribution, rawGrants } : null;
    } catch {
      return null;
    }
  })();
  const selectedRawSpeechContribution = selectedRawSpeechTarget?.contribution ?? null;
  const rawAuthorizationKey = JSON.stringify({
    target: selectedRawSpeechTarget,
    machineId: props.executionMachineId,
    realm: 'daemon',
    phase: 'speech',
    settingsVersion,
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
    void Promise.all([
      packId ? readVoiceDictationNativeModelReadiness(packId) : Promise.resolve(null),
      selectedRawSpeechTarget
        ? Promise.all(selectedRawSpeechTarget.rawGrants.map((rawGrant) => (
            inspectRawCredentialAuthorizationReadiness(selectedRawSpeechTarget.contribution, rawGrant)
          ))).then(aggregateRawCredentialAuthorizationReadiness)
        : Promise.resolve(null),
    ]).then(([nativeLocalNeuralModel, rawCredentialAuthorization]) => {
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

  return (
    <View testID="settings.voice.section.dictation">
      <ItemGroup
        title={t('settingsVoice.dictation.title')}
        footer={t('settingsVoice.dictation.footer')}
      >
        <DropdownMenu
          open={openMenu === 'provider'}
          onOpenChange={(next) => setOpenMenu(next ? 'provider' : null)}
          variant="selectable"
          search={false}
          selectedId={selectedId}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{
            title: t('settingsVoice.dictation.provider'),
            subtitle: t('settingsVoice.dictation.providerSubtitle'),
            showSelectedSubtitle: false,
            itemProps: {
              testID: 'settings.voice.dictation.provider',
              pressableRef: providerControlRef,
            },
          }}
          items={[
            {
              id: 'same_as_local',
              title: t('settingsVoice.dictation.sameAsLocal'),
              subtitle: t('settingsVoice.dictation.sameAsLocalSubtitle'),
              icon: (
                <Icon name="link" size={20} color={theme.colors.text.secondary} />
              ),
            },
            ...providerSpecs.map((spec) => ({
              id: spec.id,
              title: spec.title,
              subtitle: spec.subtitle,
              icon: (
                <Icon
                  name={spec.iconName as any}
                  size={20}
                  color={theme.colors.text.secondary}
                />
              ),
            })),
          ]}
          onSelect={(id) => {
            if (id === 'same_as_local') {
              setDictation({ ...dictation, sttBinding: 'same_as_local' });
            } else {
              const voice = selectVoiceSpeechProvider(
                props.voice,
                voiceProviderRegistry,
                id,
                'dictation_stt',
              );
              if (voice) {
                setReadinessCheck((current) => current?.status === 'checking' ? current : null);
                props.setVoice({
                  ...voice,
                  dictation: {
                    ...dictation,
                    sttBinding: 'explicit',
                    stt: { ...dictation.stt, provider: id as typeof dictation.stt.provider },
                  },
                });
              }
            }
            setOpenMenu(null);
          }}
        />

        <DropdownMenu
          open={openMenu === 'language'}
          onOpenChange={(next) => setOpenMenu(next ? 'language' : null)}
          variant="selectable"
          search={true}
          searchPlaceholder={t('settingsVoice.preferredLanguage')}
          selectedId={dictation.language ?? ''}
          showCategoryTitles={false}
          matchTriggerWidth={true}
          connectToTrigger={true}
          rowKind="item"
          popoverBoundaryRef={props.popoverBoundaryRef}
          itemTrigger={{
            title: t('settingsVoice.dictation.language'),
            subtitle: t('settingsVoice.dictation.languageSubtitle'),
            showSelectedSubtitle: false,
          }}
          items={[
            {
              id: '',
              title: t('settingsVoice.language.autoDetect'),
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
            setDictation({ ...dictation, language: id || null });
            setOpenMenu(null);
          }}
        />

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

      <ItemGroup
        title={t('settingsVoice.dictation.readiness.title')}
        footer={t('settingsVoice.dictation.readiness.footer')}
      >
        <Item
          testID="settings.voice.dictation.checkSetup"
          title={t('settingsVoice.dictation.readiness.check')}
          subtitle={t('settingsVoice.dictation.readiness.checkSubtitle')}
          accessibilityRole="button"
          disabled={isCheckingReadiness}
          loading={isCheckingReadiness}
          onPress={isCheckingReadiness ? undefined : checkSetup}
        />
        {checkedReadiness ? (
          <Item
            testID="settings.voice.dictation.readiness"
            mode={recoveryActionHandler ? 'interactive' : 'info'}
            title={t('settingsVoice.dictation.readiness.result')}
            subtitle={readinessSubtitle(checkedReadiness)}
            accessibilityRole={recoveryActionHandler ? 'button' : undefined}
            onPress={recoveryActionHandler
              ? handleRecoveryAction
              : undefined}
          />
        ) : null}
      </ItemGroup>
    </View>
  );
}
