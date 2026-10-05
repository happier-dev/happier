import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { SegmentedChoiceItem, type SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import { Switch } from '@/components/ui/forms/Switch';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { VOICE_PRIVACY_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';

type VoiceUpdates = VoiceSettings['ui']['updates'];

/**
 * "While you talk": what reaches the voice service as sessions change during a conversation. The
 * session you are in and your other sessions are separate payloads with their own level; the
 * message options stay visible and say which choice unlocks them.
 */
export function VoiceLiveUpdatesSection(props: Readonly<{
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
}>) {
  const updates = props.voice.ui.updates;
  const setUpdates = (patch: Partial<VoiceUpdates>) => {
    props.setVoice({ ...props.voice, ui: { ...props.voice.ui, updates: { ...updates, ...patch } } });
  };
  const levelOptions = React.useMemo(() => [
    { id: 'none', label: t('settingsVoice.pages.privacy.liveNothing') },
    { id: 'activity', label: t('settingsVoice.pages.privacy.liveActivity') },
    { id: 'summaries', label: t('settingsVoice.pages.privacy.liveSummaries') },
    { id: 'snippets', label: t('settingsVoice.pages.privacy.liveMessages') },
  ] as const satisfies ReadonlyArray<SegmentedChoiceOption<VoiceUpdates['activeSession']>>, []);
  const otherModeOptions = React.useMemo(() => [
    { id: 'never', label: t('settingsVoice.pages.privacy.liveOtherModeNever') },
    { id: 'on_demand_only', label: t('settingsVoice.pages.privacy.liveOtherModeWhenAsked') },
    { id: 'auto', label: t('settingsVoice.pages.privacy.liveOtherModeAutomatically') },
  ] as const satisfies ReadonlyArray<SegmentedChoiceOption<VoiceUpdates['otherSessionsSnippetsMode']>>, []);
  const sendsMessages = updates.activeSession === 'snippets' || updates.otherSessions === 'snippets';
  const otherSendsMessages = updates.otherSessions === 'snippets';
  const messagesUnavailable = t('settingsVoice.pages.privacy.liveMessagesUnavailable');

  return (
    <SettingSection section={VOICE_PRIVACY_SETTINGS.sectionRefs.updates}>
      <ItemGroup
        title={t('settingsVoice.pages.privacy.liveTitle')}
        description={t('settingsVoice.pages.privacy.liveDescription')}
      >
        <SettingAnchor setting={VOICE_PRIVACY_SETTINGS.settings.activeSession}>
          <SegmentedChoiceItem
            title={t(VOICE_PRIVACY_SETTINGS.settings.activeSession.titleKey)}
            testIDPrefix="settings.voice.ui.updates.activeSession"
            value={updates.activeSession}
            onChange={(activeSession) => setUpdates({ activeSession })}
            options={levelOptions}
          />
        </SettingAnchor>
        <SettingAnchor setting={VOICE_PRIVACY_SETTINGS.settings.otherSessions}>
          <SegmentedChoiceItem
            title={t(VOICE_PRIVACY_SETTINGS.settings.otherSessions.titleKey)}
            testIDPrefix="settings.voice.ui.updates.otherSessions"
            value={updates.otherSessions}
            onChange={(otherSessions) => setUpdates({ otherSessions })}
            options={levelOptions}
          />
        </SettingAnchor>
        <SettingAnchor setting={VOICE_PRIVACY_SETTINGS.settings.snippetsMaxMessages}>
          <FieldValueItem
            testID="settings.voice.ui.updates.snippetsMaxMessages"
            fieldTestID="settings.voice.ui.updates.snippetsMaxMessages.field"
            title={t(VOICE_PRIVACY_SETTINGS.settings.snippetsMaxMessages.titleKey)}
            subtitle={sendsMessages ? undefined : messagesUnavailable}
            subtitleLines={0}
            kind="integer"
            stepper={{ min: 1, max: 10, step: 1 }}
            unit={t('settingsVoice.pages.privacy.messagesUnit')}
            disabled={!sendsMessages}
            value={String(updates.snippetsMaxMessages)}
            onCommit={(draft) => {
              const count = Math.floor(Number(draft));
              if (!Number.isFinite(count)) return String(updates.snippetsMaxMessages);
              const next = Math.max(1, Math.min(10, count));
              setUpdates({ snippetsMaxMessages: next });
              return String(next);
            }}
          />
        </SettingAnchor>
        <SettingRow
          setting={VOICE_PRIVACY_SETTINGS.settings.includeUserMessagesInSnippets}
          subtitle={sendsMessages ? undefined : messagesUnavailable}
          subtitleLines={0}
          disabled={!sendsMessages}
          rightElement={(
            <Switch
              testID="settings.voice.ui.updates.includeUserMessagesInSnippets"
              accessibilityLabel={t(VOICE_PRIVACY_SETTINGS.settings.includeUserMessagesInSnippets.titleKey)}
              value={updates.includeUserMessagesInSnippets}
              disabled={!sendsMessages}
              onValueChange={(includeUserMessagesInSnippets) => setUpdates({ includeUserMessagesInSnippets })}
            />
          )}
        />
        <SettingAnchor setting={VOICE_PRIVACY_SETTINGS.settings.otherSessionsSnippetsMode}>
          <SegmentedChoiceItem
            title={t(VOICE_PRIVACY_SETTINGS.settings.otherSessionsSnippetsMode.titleKey)}
            subtitle={otherSendsMessages ? undefined : t('settingsVoice.pages.privacy.liveOtherModeUnavailable')}
            subtitleLines={0}
            testIDPrefix="settings.voice.ui.updates.otherSessionsSnippetsMode"
            value={updates.otherSessionsSnippetsMode}
            disabled={!otherSendsMessages}
            onChange={(otherSessionsSnippetsMode) => setUpdates({ otherSessionsSnippetsMode })}
            options={otherModeOptions}
          />
        </SettingAnchor>
      </ItemGroup>
    </SettingSection>
  );
}
