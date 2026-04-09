import * as React from 'react';

import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import { isTauriDesktop } from '@/utils/platform/tauri';

import { DesktopSettingsIonicon } from './DesktopSettingsIonicon';

export const DesktopSettingsEntry = React.memo(function DesktopSettingsEntry() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const showDesktopSettings = isTauriDesktop();

    if (!showDesktopSettings) {
        return null;
    }

    return (
        <Item
            testID="settings-desktop-entry"
            title={t('settingsDesktop.title')}
            subtitle={t('settingsDesktop.footer')}
            icon={<DesktopSettingsIonicon name="desktop-outline" size={29} color={theme.colors.accent.blue} />}
            onPress={() => router.push('/settings/desktop')}
        />
    );
});
