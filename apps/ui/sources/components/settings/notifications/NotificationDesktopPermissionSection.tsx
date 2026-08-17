import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { useTauriNotificationPermissionDiagnostics } from './useTauriNotificationPermissionDiagnostics';
import { Icon } from '@/components/ui/icons/Icon';

export function NotificationDesktopPermissionSection(): React.ReactElement {
    const { theme } = useUnistyles();
    const permission = useTauriNotificationPermissionDiagnostics(true);

    const permissionSubtitle = React.useMemo(() => {
        switch (permission.status) {
            case 'checking':
                return t('settingsNotifications.desktop.permission.checkingSubtitle');
            case 'granted':
                return t('settingsNotifications.desktop.permission.grantedSubtitle');
            case 'error':
                return t('settingsNotifications.desktop.permission.errorSubtitle');
            case 'notGranted':
            default:
                return t('settingsNotifications.desktop.permission.notGrantedSubtitle');
        }
    }, [permission.status]);

    const permissionIconColor = permission.status === 'granted'
        ? theme.colors.state.success.foreground
        : permission.status === 'checking'
            ? theme.colors.text.secondary
            : theme.colors.state.neutral.foreground;

    return (
        <ItemGroup
            title={t('settingsNotifications.desktop.title')}
            footer={t('settingsNotifications.desktop.footer')}
        >
            <Item
                testID="settings-notifications-desktop-permission"
                title={t('settingsNotifications.desktop.permission.title')}
                subtitle={permissionSubtitle}
                icon={<Icon name="desktop" size={29} color={permissionIconColor} />}
                onPress={permission.status === 'granted'
                    ? undefined
                    : () => { void permission.requestPermission(); }}
                showChevron={permission.status !== 'granted'}
            />
        </ItemGroup>
    );
}
