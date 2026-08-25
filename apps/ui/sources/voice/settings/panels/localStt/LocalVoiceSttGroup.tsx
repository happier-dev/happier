import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { VoiceLocalSttSchema, type VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { getLocalSttProviderSpec, useLocalSttProviderSpecs } from '@/voice/settings/panels/localStt/providers/registry';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';
import { Icon } from '@/components/ui/icons/Icon';

export function LocalVoiceSttGroup(props: {
  cfgStt: VoiceLocalSttSettings | any;
  setStt: (next: VoiceLocalSttSettings | any) => void;
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
  daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
}) {
  const { theme } = useUnistyles();
  const providerSpecs = useLocalSttProviderSpecs();
  const [openMenu, setOpenMenu] = React.useState<null | 'sttProvider'>(null);

  const normalized = React.useMemo(() => {
    try {
      return VoiceLocalSttSchema.parse(props.cfgStt ?? {});
    } catch {
      return VoiceLocalSttSchema.parse({});
    }
  }, [props.cfgStt]);

  const providerSpec = getLocalSttProviderSpec(normalized.provider);

  return (
    <ItemGroup title={t('settingsVoice.local.sttBaseUrlTitle')}>
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
          title: t('settingsVoice.local.sttProvider'),
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

      {providerSpec ? (
        <providerSpec.Settings
          cfgStt={normalized}
          setStt={props.setStt}
          voice={props.voice}
          setVoice={props.setVoice}
          popoverBoundaryRef={props.popoverBoundaryRef}
          daemonRouteDiagnosticReason={props.daemonRouteDiagnosticReason}
        />
      ) : (
        <Item title={t('common.unavailable')} />
      )}
    </ItemGroup>
  );
}
