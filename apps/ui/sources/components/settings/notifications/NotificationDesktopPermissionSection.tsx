import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { router } from 'expo-router';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';

import { useTauriNotificationPermissionDiagnostics } from './useTauriNotificationPermissionDiagnostics';

export function NotificationDesktopPermissionSection(): React.ReactElement {
    const permission = useTauriNotificationPermissionDiagnostics(true);
    const scope = useActiveServerAccountScope();

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

    return (
        <ItemGroup
            title={t('settingsNotifications.desktop.title')}
            description={t('settingsNotifications.desktop.footer')}
        >
            {permission.approval.approvalPending && permission.approval.approvalId && scope ? <ActionApprovalPendingNotice
                message={t('approvals.title')} onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(permission.approval.approvalId!)}?serverId=${encodeURIComponent(scope.serverId)}`)} /> : null}
            <Item
                testID="settings-notifications-desktop-permission"
                title={t('settingsNotifications.desktop.permission.title')}
                subtitle={permissionSubtitle}
                onPress={permission.status === 'granted'
                    ? undefined
                    : () => { void permission.requestPermission(); }}
                showChevron={permission.status !== 'granted'}
            />
        </ItemGroup>
    );
}
