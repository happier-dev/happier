import * as React from 'react';

import type { SettingsBelowFoldSectionsProps } from '@/components/settings/settingsBelowFoldSectionTypes';
import { DesktopSettingsEntry } from '@/components/settings/desktop/DesktopSettingsEntry';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { t } from '@/text';

type SettingsSystemSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps, 'router' | 'theme'>>;

export const SettingsSystemSection = React.memo(function SettingsSystemSection({ router, theme }: SettingsSystemSectionProps) {
    return (
        <ItemGroup title={t('settings.system')}>
            <Item
                title={t('settings.servers')}
                subtitle={t('settings.serversSubtitle')}
                icon={<SafeIonicons name="server-outline" size={29} color={theme.colors.accent.blue} />}
                onPress={() => router.push(SETTINGS_ROUTES.servers)}
            />
            <Item
                testID="settings-system-status-item"
                title={t('settings.systemStatus')}
                subtitle={t('settings.systemStatusSubtitle')}
                icon={<SafeIonicons name="pulse-outline" size={29} color={theme.colors.accent.indigo} />}
                onPress={() => router.push(SETTINGS_ROUTES.systemStatus)}
            />
            <DesktopSettingsEntry />
            <Item
                title={t('settings.notifications')}
                subtitle={t('settings.notificationsSubtitle')}
                icon={<SafeIonicons name="notifications-outline" size={29} color={theme.colors.accent.blue} />}
                onPress={() => router.push(SETTINGS_ROUTES.notifications)}
            />
        </ItemGroup>
    );
});
