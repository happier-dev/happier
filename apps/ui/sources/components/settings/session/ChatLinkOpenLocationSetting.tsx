import * as React from 'react';
import { Platform } from 'react-native';

import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { useLocalSetting } from '@/sync/domains/state/storage';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { t } from '@/text';
import { isDesktopHost } from '@/utils/platform/desktopHost';

import { TRANSCRIPT_SETTINGS } from './transcriptSettings';

export function ChatLinkOpenLocationSetting() {
    const location = useLocalSetting('chatLinkOpenLocation');
    const { setSetting } = useSettingActionFeedback();
    const setting = TRANSCRIPT_SETTINGS.settings.chatLinkOpenLocation;
    const embeddedAvailable = Platform.OS !== 'web' || isDesktopHost();
    return <SettingAnchor setting={setting}>
        <SegmentedChoiceItem<LocalSettings['chatLinkOpenLocation']>
            title={t(setting.titleKey)}
            subtitle={t('settingsAppearance.chatLinks.description')}
            subtitleLines={0}
            testIDPrefix="settings.transcript.chatLinkOpenLocation"
            options={[
                { id: 'browser', label: t('settingsAppearance.chatLinks.browser') },
                ...(embeddedAvailable ? [{ id: 'embedded' as const, label: t('settingsAppearance.chatLinks.embedded') }] : []),
                { id: 'managed', label: t('settingsAppearance.chatLinks.managed') },
            ]}
            value={location}
            onChange={value => { void setSetting(setting, value); }}
        />
    </SettingAnchor>;
}
