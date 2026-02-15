import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { t } from '@/text';
import { formatVoiceTestFailureMessage } from '@/voice/local/formatVoiceTestFailureMessage';
import { getLocalTtsProviderSpec, localTtsProviderSpecs } from '@/voice/settings/panels/localTts/providers/registry';

export function LocalVoiceTtsGroup(props: {
  cfgTts: VoiceLocalTtsSettings;
  setTts: (next: VoiceLocalTtsSettings) => void;
  networkTimeoutMs: number;
  popoverBoundaryRef?: React.RefObject<any> | null;
}) {
  const { theme } = useUnistyles();
  const [openMenu, setOpenMenu] = React.useState<null | 'ttsProvider'>(null);

  const cfg = props.cfgTts;
  const providerSpec = getLocalTtsProviderSpec(cfg.provider);
  const setCfg = (patch: Partial<VoiceLocalTtsSettings>) => props.setTts({ ...cfg, ...patch });

  return (
    <ItemGroup title={t('settingsVoice.local.ttsBaseUrlTitle')}>
      <DropdownMenu
        open={openMenu === 'ttsProvider'}
        onOpenChange={(next) => setOpenMenu(next ? 'ttsProvider' : null)}
        variant="selectable"
        search={false}
        selectedId={cfg.provider}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        trigger={({ open, toggle }) => (
          <Item
            title={t('settingsVoice.local.ttsProvider')}
            subtitle={t('settingsVoice.local.ttsProviderSubtitle')}
            detail={providerSpec.detail}
            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
            onPress={toggle}
            showChevron={false}
            selected={false}
          />
        )}
        items={localTtsProviderSpecs.map((spec) => ({
          id: spec.id,
          title: spec.title,
          subtitle: spec.subtitle,
          icon: <Ionicons name={spec.iconName as any} size={22} color={theme.colors.textSecondary} />,
        }))}
        onSelect={(id) => {
          setCfg({ provider: id as any });
          setOpenMenu(null);
        }}
      />

      <Item
        title={t('settingsVoice.local.autoSpeak')}
        subtitle={t('settingsVoice.local.autoSpeakSubtitle')}
        rightElement={<Switch value={cfg.autoSpeakReplies} onValueChange={(v) => setCfg({ autoSpeakReplies: v })} />}
      />
      <Item
        title="Barge-in"
        rightElement={<Switch value={cfg.bargeInEnabled} onValueChange={(v) => setCfg({ bargeInEnabled: v })} />}
      />

      <providerSpec.Settings
        cfgTts={cfg}
        setTts={props.setTts}
        networkTimeoutMs={props.networkTimeoutMs}
        popoverBoundaryRef={props.popoverBoundaryRef}
      />

      <Item
        title={t('settingsVoice.local.testTts')}
        subtitle={t('settingsVoice.local.testTtsSubtitle')}
        onPress={() => {
          void (async () => {
            try {
              const sample = t('settingsVoice.local.testTtsSample');
              await getLocalTtsProviderSpec(cfg.provider).test({ cfgTts: cfg, networkTimeoutMs: props.networkTimeoutMs, sample });
            } catch (err) {
              Modal.alert(t('common.error'), formatVoiceTestFailureMessage(t('settingsVoice.local.testTtsFailed'), err));
            }
          })();
        }}
      />
    </ItemGroup>
  );
}
