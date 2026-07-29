import * as React from 'react';
import { Platform, View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';
import {
  VoiceRuntimePlatformSchema,
  type VoiceRuntimePlatform,
} from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';

import { LANGUAGES } from '@/constants/Languages';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import {
  getLocalSttProviderSpec,
  localSttProviderSpecs,
} from '@/voice/settings/panels/localStt/providers/registry';
import type {
  VoiceDaemonRouteDiagnosticReason,
  VoiceProviderLocalAvailability,
} from '@/voice/settings/voiceProviderLocalAvailability';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';

import {
  voiceDictationSettingsDefaults,
} from './voiceDictationSettings';
import { resolveVoiceDictationReadiness } from './voiceDictationReadiness';

const voiceProviderRegistry = createDefaultVoiceProviderRegistry();

function resolveRuntimePlatform(): VoiceRuntimePlatform | 'unknown' {
  const parsed = VoiceRuntimePlatformSchema.safeParse(Platform.OS);
  return parsed.success ? parsed.data : 'unknown';
}

function readinessSubtitle(status: ReturnType<typeof resolveVoiceDictationReadiness>['status']): string {
  switch (status) {
    case 'ready':
      return t('settingsVoice.dictation.readiness.ready');
    case 'needs_setup':
      return t('settingsVoice.dictation.readiness.needsSetup');
    case 'installing':
      return t('settingsVoice.dictation.readiness.installing');
    case 'incompatible':
      return t('settingsVoice.dictation.readiness.incompatible');
    case 'unavailable':
      return t('settingsVoice.dictation.readiness.unavailable');
  }
}

export function DictationSettingsSection(props: Readonly<{
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
  executionMachineId: string | null;
  localAvailability: VoiceProviderLocalAvailability;
  daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
}>) {
  const { theme } = useUnistyles();
  const dictation = props.voice.dictation ?? voiceDictationSettingsDefaults;
  const [openMenu, setOpenMenu] = React.useState<null | 'provider' | 'language'>(null);
  const [checkedReadiness, setCheckedReadiness] = React.useState<ReturnType<
    typeof resolveVoiceDictationReadiness
  > | null>(null);
  const selectedId = dictation.sttBinding === 'same_as_local'
    ? 'same_as_local'
    : dictation.stt.provider;
  const providerSpec = dictation.sttBinding === 'explicit'
    ? getLocalSttProviderSpec(dictation.stt.provider)
    : null;
  const setDictation = (next: typeof dictation): void => {
    setCheckedReadiness(null);
    props.setVoice({ ...props.voice, dictation: next });
  };

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
          }}
          items={[
            {
              id: 'same_as_local',
              title: t('settingsVoice.dictation.sameAsLocal'),
              subtitle: t('settingsVoice.dictation.sameAsLocalSubtitle'),
              icon: (
                <Ionicons name="link-outline" size={22} color={theme.colors.text.secondary} />
              ),
            },
            ...localSttProviderSpecs.map((spec) => ({
              id: spec.id,
              title: spec.title,
              subtitle: spec.subtitle,
              icon: (
                <Ionicons
                  name={spec.iconName as any}
                  size={22}
                  color={theme.colors.text.secondary}
                />
              ),
            })),
          ]}
          onSelect={(id) => {
            if (id === 'same_as_local') {
              setDictation({ ...dictation, sttBinding: 'same_as_local' });
            } else {
              setDictation({
                ...dictation,
                sttBinding: 'explicit',
                stt: { ...dictation.stt, provider: id as typeof dictation.stt.provider },
              });
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
                <Ionicons name="sparkles-outline" size={20} color={theme.colors.text.secondary} />
              ),
            },
            ...LANGUAGES.flatMap((language) => typeof language.code === 'string' && language.code
              ? [{
                  id: language.code,
                  title: language.name,
                  subtitle: language.code,
                  icon: (
                    <Ionicons name="language-outline" size={20} color={theme.colors.text.secondary} />
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
            cfgStt={dictation.stt}
            setStt={(stt) => setDictation({ ...dictation, stt })}
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
          onPress={() => {
            setCheckedReadiness(resolveVoiceDictationReadiness({
              registry: voiceProviderRegistry,
              settings: { voice: props.voice },
              platform: resolveRuntimePlatform(),
              executionMachineId: props.executionMachineId,
              daemon: props.localAvailability.daemon ?? null,
            }));
          }}
        />
        {checkedReadiness ? (
          <Item
            testID="settings.voice.dictation.readiness"
            mode="info"
            title={t('settingsVoice.dictation.readiness.result')}
            subtitle={readinessSubtitle(checkedReadiness.status)}
            detail={checkedReadiness.providerId ?? undefined}
          />
        ) : null}
      </ItemGroup>
    </View>
  );
}
