import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { VOICE_PRIVACY_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { Switch } from '@/components/ui/forms/Switch';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';

export function VoicePrivacySection(props: { voice: VoiceSettings; setVoice: (next: VoiceSettings) => void }) {
  const privacy = props.voice.privacy;
  const currentUiContextModeOptions = React.useMemo(() => [
    { id: 'off' as const, label: t('settingsVoice.pages.privacy.screenNever') },
    { id: 'on_demand' as const, label: t('settingsVoice.pages.privacy.screenWhenAsked') },
    { id: 'automatic' as const, label: t('settingsVoice.pages.privacy.screenAlways') },
  ], []);

  const setPrivacy = (patch: Partial<VoiceSettings['privacy']>) => {
    props.setVoice({
      ...props.voice,
      privacy: { ...privacy, ...patch },
    });
  };

  return (
    <SettingSection section={VOICE_PRIVACY_SETTINGS.sectionRefs.contextSharing}>
      <ItemGroup
        title={t('settingsVoice.pages.privacy.startTitle')}
        description={t('settingsVoice.pages.privacy.startDescription')}
      >
        <SettingAnchor setting={VOICE_PRIVACY_SETTINGS.settings.currentUiContextMode}>
          <SegmentedChoiceItem<VoiceSettings['privacy']['currentUiContextMode']>
            testID="settings.voice.privacy.currentUiContextMode"
            testIDPrefix="settings.voice.privacy.currentUiContextMode"
            title={t(VOICE_PRIVACY_SETTINGS.settings.currentUiContextMode.titleKey)}
            subtitle={t('settingsVoice.pages.privacy.screenDescription')}
            subtitleLines={0}
            value={privacy.currentUiContextMode}
            options={currentUiContextModeOptions}
            onChange={(currentUiContextMode) => setPrivacy({ currentUiContextMode })}
          />
        </SettingAnchor>
        <SettingRow
          setting={VOICE_PRIVACY_SETTINGS.settings.shareSessionSummary}
          rightElement={(
            <Switch
              accessibilityLabel={t(VOICE_PRIVACY_SETTINGS.settings.shareSessionSummary.titleKey)}
              value={privacy.shareSessionSummary}
              onValueChange={(v) => setPrivacy({ shareSessionSummary: v })}
            />
          )}
        />
        <SettingRow
          setting={VOICE_PRIVACY_SETTINGS.settings.shareRecentMessages}
          rightElement={(
            <Switch
              accessibilityLabel={t(VOICE_PRIVACY_SETTINGS.settings.shareRecentMessages.titleKey)}
              value={privacy.shareRecentMessages}
              onValueChange={(v) => setPrivacy({ shareRecentMessages: v })}
            />
          )}
        />
        <SettingAnchor setting={VOICE_PRIVACY_SETTINGS.settings.recentMessagesCount}>
          <FieldValueItem
            title={t(VOICE_PRIVACY_SETTINGS.settings.recentMessagesCount.titleKey)}
            subtitle={privacy.shareRecentMessages
              ? t('settingsVoice.pages.privacy.recentCountDescription')
              : t('settingsVoice.pages.privacy.recentCountUnavailable')}
            fieldTestID="settings.voice.privacy.recentMessagesCount.field"
            kind="integer"
            stepper={{ min: 0, step: 1 }}
            unit={t('settingsVoice.pages.privacy.messagesUnit')}
            disabled={!privacy.shareRecentMessages}
            value={String(privacy.recentMessagesCount)}
            onCommit={(draft) => {
              const next = Math.max(0, Math.floor(Number(draft)));
              if (!Number.isFinite(next)) return String(privacy.recentMessagesCount);
              setPrivacy({ recentMessagesCount: next });
              return String(next);
            }}
          />
        </SettingAnchor>
        <SettingRow
          setting={VOICE_PRIVACY_SETTINGS.settings.shareToolNames}
          rightElement={(
            <Switch
              accessibilityLabel={t(VOICE_PRIVACY_SETTINGS.settings.shareToolNames.titleKey)}
              value={privacy.shareToolNames}
              onValueChange={(v) => setPrivacy({ shareToolNames: v })}
            />
          )}
        />
        <SettingRow
          setting={VOICE_PRIVACY_SETTINGS.settings.sharePermissionRequests}
          rightElement={(
            <Switch
              accessibilityLabel={t(VOICE_PRIVACY_SETTINGS.settings.sharePermissionRequests.titleKey)}
              value={privacy.sharePermissionRequests}
              onValueChange={(v) => setPrivacy({ sharePermissionRequests: v })}
            />
          )}
        />
        <SettingRow
          setting={VOICE_PRIVACY_SETTINGS.settings.shareDeviceInventory}
          rightElement={(
            <Switch
              accessibilityLabel={t(VOICE_PRIVACY_SETTINGS.settings.shareDeviceInventory.titleKey)}
              value={privacy.shareDeviceInventory}
              onValueChange={(v) => setPrivacy({ shareDeviceInventory: v })}
            />
          )}
        />
      </ItemGroup>
    </SettingSection>
  );
}
