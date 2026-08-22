import * as React from 'react';
import { View } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Modal } from '@/modal';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

export function VoicePrivacySection(props: { voice: VoiceSettings; setVoice: (next: VoiceSettings) => void }) {
  const privacy = props.voice.privacy;
  const [currentUiContextModeMenuOpen, setCurrentUiContextModeMenuOpen] = React.useState(false);

  const setPrivacy = (patch: Partial<VoiceSettings['privacy']>) => {
    props.setVoice({
      ...props.voice,
      privacy: { ...privacy, ...patch },
    });
  };

  return (
    <ItemGroup
      title={t('settingsVoice.privacy.title')}
      footer={t('settingsVoice.privacy.footer')}
    >
      <DropdownMenu
        open={currentUiContextModeMenuOpen}
        onOpenChange={setCurrentUiContextModeMenuOpen}
        variant="selectable"
        search={false}
        selectedId={privacy.currentUiContextMode}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        itemTrigger={{
          title: t('settingsVoice.privacy.currentUiContextModeTitle'),
          subtitle: t('settingsVoice.privacy.currentUiContextModeSubtitle'),
          showSelectedSubtitle: false,
          itemProps: {
            testID: 'settings.voice.privacy.currentUiContextMode',
            subtitleLines: 0,
          },
        }}
        items={[
          {
            id: 'off',
            title: t('settingsVoice.privacy.currentUiContextMode.offTitle'),
            subtitle: t('settingsVoice.privacy.currentUiContextMode.offSubtitle'),
            icon: (
              <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="minus" size={20} />
              </View>
            ),
          },
          {
            id: 'on_demand',
            title: t('settingsVoice.privacy.currentUiContextMode.onDemandTitle'),
            subtitle: t('settingsVoice.privacy.currentUiContextMode.onDemandSubtitle'),
            icon: (
              <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="hand" size={20} />
              </View>
            ),
          },
          {
            id: 'automatic',
            title: t('settingsVoice.privacy.currentUiContextMode.automaticTitle'),
            subtitle: t('settingsVoice.privacy.currentUiContextMode.automaticSubtitle'),
            icon: (
              <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="sparkle" size={20} />
              </View>
            ),
          },
        ]}
        onSelect={(id) => {
          if (id === 'off' || id === 'on_demand' || id === 'automatic') {
            setPrivacy({ currentUiContextMode: id });
          }
          setCurrentUiContextModeMenuOpen(false);
        }}
      />
      <Item
        title={t('settingsVoice.privacy.shareSessionSummary')}
        subtitle={t('settingsVoice.privacy.shareSessionSummarySubtitle')}
        rightElement={(
          <Switch
            accessibilityLabel={t('settingsVoice.privacy.shareSessionSummary')}
            value={privacy.shareSessionSummary}
            onValueChange={(v) => setPrivacy({ shareSessionSummary: v })}
          />
        )}
      />
      <Item
        title={t('settingsVoice.privacy.shareRecentMessages')}
        subtitle={t('settingsVoice.privacy.shareRecentMessagesSubtitle')}
        rightElement={(
          <Switch
            accessibilityLabel={t('settingsVoice.privacy.shareRecentMessages')}
            value={privacy.shareRecentMessages}
            onValueChange={(v) => setPrivacy({ shareRecentMessages: v })}
          />
        )}
      />
      {privacy.shareRecentMessages ? (
        <Item
          title={t('settingsVoice.privacy.recentMessagesCount')}
          subtitle={t('settingsVoice.privacy.recentMessagesCountSubtitle')}
          detail={String(privacy.recentMessagesCount)}
          onPress={() => {
            fireAndForget((async () => {
              const raw = await Modal.prompt(
                t('settingsVoice.privacy.recentMessagesCount'),
                t('settingsVoice.privacy.recentMessagesCountSubtitle'),
                { inputType: 'numeric', placeholder: String(privacy.recentMessagesCount) },
              );
              if (raw === null) return;
              const next = Number(String(raw).trim());
              if (!Number.isFinite(next)) return;
              setPrivacy({ recentMessagesCount: Math.max(0, Math.min(50, Math.floor(next))) });
            })(), { tag: 'VoicePrivacySection.editRecentMessagesCount' });
          }}
        />
      ) : null}
      <Item
        title={t('settingsVoice.privacy.shareToolNames')}
        subtitle={t('settingsVoice.privacy.shareToolNamesSubtitle')}
        rightElement={(
          <Switch
            accessibilityLabel={t('settingsVoice.privacy.shareToolNames')}
            value={privacy.shareToolNames}
            onValueChange={(v) => setPrivacy({ shareToolNames: v })}
          />
        )}
      />
      <Item
        title={t('settingsVoice.privacy.shareDeviceInventory')}
        subtitle={t('settingsVoice.privacy.shareDeviceInventorySubtitle')}
        rightElement={(
          <Switch
            accessibilityLabel={t('settingsVoice.privacy.shareDeviceInventory')}
            value={privacy.shareDeviceInventory}
            onValueChange={(v) => setPrivacy({ shareDeviceInventory: v })}
          />
        )}
      />
      <Item
        title={t('settingsVoice.privacy.sharePermissionRequests')}
        subtitle={t('settingsVoice.privacy.sharePermissionRequestsSubtitle')}
        rightElement={(
          <Switch
            accessibilityLabel={t('settingsVoice.privacy.sharePermissionRequests')}
            value={privacy.sharePermissionRequests}
            onValueChange={(v) => setPrivacy({ sharePermissionRequests: v })}
          />
        )}
      />
    </ItemGroup>
  );
}
