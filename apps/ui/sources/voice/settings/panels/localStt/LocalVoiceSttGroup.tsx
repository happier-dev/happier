import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { VoiceLocalSttSchema, type VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import { t } from '@/text';
import { getLocalSttProviderSpec, localSttProviderSpecs } from '@/voice/settings/panels/localStt/providers/registry';

export function LocalVoiceSttGroup(props: {
  cfgStt: VoiceLocalSttSettings | any;
  setStt: (next: VoiceLocalSttSettings | any) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
}) {
  const { theme } = useUnistyles();
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
        trigger={({ open, toggle }) => (
          <Item
            title="STT provider"
            subtitle="How speech is transcribed into text."
            detail={providerSpec.detail}
            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
            onPress={toggle}
            showChevron={false}
            selected={false}
          />
        )}
        items={localSttProviderSpecs.map((spec) => ({
          id: spec.id,
          title: spec.title,
          subtitle: spec.subtitle,
          icon: <Ionicons name={spec.iconName as any} size={22} color={theme.colors.textSecondary} />,
        }))}
        onSelect={(id) => {
          props.setStt({ ...normalized, provider: id as any });
          setOpenMenu(null);
        }}
      />

      <providerSpec.Settings cfgStt={normalized} setStt={props.setStt} popoverBoundaryRef={props.popoverBoundaryRef} />
    </ItemGroup>
  );
}

