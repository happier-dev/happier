import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { VoiceLocalSttSchema, type VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { useLocalSttProviderSpecs } from '@/voice/settings/panels/localStt/providers/registry';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';
import { Icon } from '@/components/ui/icons/Icon';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { useVoiceSettingsSearchPrerequisite } from '@/voice/settings/VoiceSettingsSearchPrerequisite';
import { getVoiceContributedSettingRefs, useVoiceContributedSettingsDeclarations } from '@/voice/settings/useVoiceContributedSettingRefs';
import { getVoiceLocalNeuralSttSettingRefs } from '@/voice/settings/useVoiceSttSettingRefs';

export const VOICE_LOCAL_STT_SETTINGS = [VOICE_CONVERSATIONS_SETTINGS.settings.sttProvider,
  ...getVoiceLocalNeuralSttSettingRefs(VOICE_CONVERSATIONS_SETTINGS.settings)];

export function LocalVoiceSttGroup(props: {
  cfgStt: VoiceLocalSttSettings | any;
  /** A shared speech contribution's fields may already be drawn by Speak. */
  otherSpeechProviderId?: string;
  setStt: (next: VoiceLocalSttSettings | any) => void;
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
  daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
  /** Rows of the Hear section that follow the recognizer (how you talk, interrupting). */
  children?: React.ReactNode;
}) {
  const searchPrerequisite = useVoiceSettingsSearchPrerequisite();
  const { theme } = useUnistyles();
  const providerSpecs = useLocalSttProviderSpecs();
  const declarations = useVoiceContributedSettingsDeclarations('voiceConversations');
  const [openMenu, setOpenMenu] = React.useState<null | 'sttProvider'>(null);

  const normalized = React.useMemo(() => {
    try {
      return VoiceLocalSttSchema.parse(props.cfgStt ?? {});
    } catch {
      return VoiceLocalSttSchema.parse({});
    }
  }, [props.cfgStt]);

  const providerSpec = providerSpecs.find(spec => spec.id === normalized.provider);

  return (
    <ItemGroup
      title={t('settingsVoice.pages.conversations.hearTitle')}
      description={t('settingsVoice.pages.conversations.hearDescription')}
    >
      <SettingAnchor setting={VOICE_CONVERSATIONS_SETTINGS.settings.sttProvider}>
      <DropdownMenu
        open={openMenu === 'sttProvider'}
        onOpenChange={(next) => setOpenMenu(next ? 'sttProvider' : null)}
        variant="selectable"
        search={false}
        selectedId={normalized.provider}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          title: t('settingsVoice.pages.conversations.speechRecognitionTitle'),
        }}
        items={providerSpecs.map((spec) => ({
          id: spec.id,
          title: spec.title,
          subtitle: spec.subtitle,
          icon: <Icon name={spec.iconName as any} size={20} color={theme.colors.text.secondary} />,
        }))}
        onSelect={(id) => {
          props.setStt({ ...normalized, provider: id as any });
          setOpenMenu(null);
        }}
      />
      </SettingAnchor>

      {providerSpec ? (providerSpec.Settings ? (
        <providerSpec.Settings
          cfgStt={normalized}
          setStt={props.setStt}
          voice={props.voice}
          setVoice={props.setVoice}
          popoverBoundaryRef={props.popoverBoundaryRef}
          daemonRouteDiagnosticReason={props.daemonRouteDiagnosticReason}
        />
      ) : null) : (
        <Item title={t('common.unavailable')} />
      )}
      {providerSpecs.filter((spec) => spec.id !== providerSpec?.id).map((spec) => (
        searchPrerequisite({ settings: [
            ...(spec.id === props.otherSpeechProviderId ? [] : getVoiceContributedSettingRefs(declarations, spec.id)),
            ...(spec.id === 'local_neural' ? getVoiceLocalNeuralSttSettingRefs(VOICE_CONVERSATIONS_SETTINGS.settings) : []),
          ], reason: t('settingsVoice.pages.search.select', { choice: spec.title, control: t('settingsVoice.pages.conversations.speechRecognitionTitle') }) })
      ))}
      {props.children}
    </ItemGroup>
  );
}
