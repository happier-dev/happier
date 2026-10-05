import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { VOICE_ADVANCED_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Switch } from '@/components/ui/forms/Switch';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import type { VoicePresenceContainer } from '@/components/voice/presence/useVoicePresenceContainer';
import { t } from '@/text';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Item } from '@/components/ui/lists/Item';
import { VoicePresenceContainerPreview } from '@/components/voice/presence/VoicePresenceContainerPreview';
import { getAvailableVoicePresenceContainers, resolveVoicePresenceContainer } from '@/components/voice/presence/useVoicePresenceContainer';
import { useDeviceType } from '@/utils/platform/responsive';

/** "Show live Voice as": each tile draws the real container at rest (no subscriptions). */
const PRESENCE_CONTAINERS = [
  { id: 'top_bar', labelKey: 'settingsVoice.ui.presenceContainer.topBar' },
  { id: 'island', labelKey: 'settingsVoice.ui.presenceContainer.island' },
  { id: 'orb', labelKey: 'settingsVoice.ui.presenceContainer.orb' },
] as const satisfies ReadonlyArray<{ id: VoicePresenceContainer; labelKey: string }>;

/**
 * Presentational only.
 *
 * `voice`/`setVoice` carry the **synced** Voice settings; `voicePresenceContainer`/`setVoicePresenceContainer`
 * carry a **device-local** preference. The section renders both and owns neither — the Voice
 * settings route reads MMKV through `useLocalSettingMutable` and hands the pair down. Reading
 * storage here would put a second owner behind the same switch.
 */
export function VoiceUiSection(props: {
  voice: VoiceSettings;
  setVoice: (next: VoiceSettings) => void;
  voicePresenceContainer: VoicePresenceContainer;
  setVoicePresenceContainer: (next: VoicePresenceContainer) => void;
  voiceHoldToTalkEnabled?: boolean;
  setVoiceHoldToTalkEnabled?: (next: boolean) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
}) {
  const ui = props.voice.ui;
  const deviceType = useDeviceType();
  const availableContainers = getAvailableVoicePresenceContainers(deviceType);

  const setUi = (patch: Partial<typeof ui>) => {
    props.setVoice({ ...props.voice, ui: { ...ui, ...patch } });
  };

  return (
    <>
      {props.setVoiceHoldToTalkEnabled && (
        <SettingSection section={VOICE_ADVANCED_SETTINGS.sectionRefs.input}>
          <ItemGroup title={t('voicePresence.howYouTalk')}>
            <SettingRow setting={VOICE_ADVANCED_SETTINGS.settings.holdToTalk} subtitleLines={0}
              rightElement={<Switch testID="settings.voice.ui.holdToTalk"
                accessibilityLabel={t('voicePresence.holdToTalkTitle')}
                value={props.voiceHoldToTalkEnabled === true}
                onValueChange={props.setVoiceHoldToTalkEnabled} />}
            />
          </ItemGroup>
        </SettingSection>
      )}
      <SettingSection section={VOICE_ADVANCED_SETTINGS.sectionRefs.surface}>
        <ItemGroup
          title={t('settingsVoice.pages.advanced.onScreenTitle')}
          description={t('settingsVoice.pages.advanced.onScreenDescription')}
        >
          <SettingAnchor setting={VOICE_ADVANCED_SETTINGS.settings.scopeDefault}>
            <SegmentedChoiceItem
              title={t(VOICE_ADVANCED_SETTINGS.settings.scopeDefault.titleKey)}
              subtitleLines={0}
              testIDPrefix="settings.voice.ui.scopeDefault"
              value={ui.scopeDefault}
              onChange={(scopeDefault) => setUi({ scopeDefault })}
              options={[
                { id: 'global', label: t('settingsVoice.pages.advanced.scopeGlobal'), description: t('settingsVoice.pages.advanced.scopeGlobalDescription') },
                { id: 'session', label: t('settingsVoice.pages.advanced.scopeSession'), description: t('settingsVoice.pages.advanced.scopeSessionDescription') },
              ]}
            />
          </SettingAnchor>

          <SettingAnchor setting={VOICE_ADVANCED_SETTINGS.settings.presenceContainer}>
            <Item
              title={t(VOICE_ADVANCED_SETTINGS.settings.presenceContainer.titleKey)}
              subtitle={t('settingsVoice.pages.advanced.showLiveAsDescription')}
              subtitleLines={0}
              showChevron={false}
              accessoryLayout="stacked"
              rightElement={(
                <SelectionTiles<VoicePresenceContainer>
                  variant="visual"
                  accessibilityLabel={t(VOICE_ADVANCED_SETTINGS.settings.presenceContainer.titleKey)}
                  testIdPrefix="settings.voice.ui.presenceContainer"
                  value={resolveVoicePresenceContainer(props.voicePresenceContainer, deviceType)}
                  onChange={(next) => { if (next) props.setVoicePresenceContainer(next); }}
                  options={PRESENCE_CONTAINERS.filter((container) => availableContainers.includes(container.id)).map((container) => ({
                    id: container.id,
                    title: t(container.labelKey),
                    preview: <VoicePresenceContainerPreview container={container.id} />,
                  }))}
                />
              )}
            />
          </SettingAnchor>

          <SettingRow
            setting={VOICE_ADVANCED_SETTINGS.settings.activityFeedEnabled}
            subtitleLines={0}
            rightElement={
              <Switch
                testID="settings.voice.ui.activityFeedEnabled"
                accessibilityLabel={t(VOICE_ADVANCED_SETTINGS.settings.activityFeedEnabled.titleKey)}
                value={ui.activityFeedEnabled}
                onValueChange={(v) => setUi({ activityFeedEnabled: v })}
              />
            }
          />
          <SettingRow
            setting={VOICE_ADVANCED_SETTINGS.settings.activityFeedAutoExpandOnStart}
            subtitle={ui.activityFeedEnabled ? undefined : t('settingsVoice.pages.advanced.autoOpenUnavailable')}
            subtitleLines={0}
            disabled={!ui.activityFeedEnabled}
            rightElement={
              <Switch
                testID="settings.voice.ui.activityFeedAutoExpandOnStart"
                accessibilityLabel={t(VOICE_ADVANCED_SETTINGS.settings.activityFeedAutoExpandOnStart.titleKey)}
                value={ui.activityFeedAutoExpandOnStart}
                disabled={!ui.activityFeedEnabled}
                onValueChange={(v) => setUi({ activityFeedAutoExpandOnStart: v })}
              />
            }
          />
        </ItemGroup>
      </SettingSection>

    </>
  );
}
