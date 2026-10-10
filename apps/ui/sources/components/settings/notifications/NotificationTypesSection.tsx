import * as React from 'react';

import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import type { AttentionDeliveryPolicyV1 } from '@happier-dev/protocol/account/settings/accountSettings';
import type { RemoteAlertAttentionDeliveryEventId } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicy';
import type { NotificationChannelRecordV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { NOTIFICATIONS_SETTINGS } from '@/components/settings/notifications/notificationsSettings';
import { readAccountNotificationPreference } from './notificationPreferences';

export type NotificationTypeEventId = RemoteAlertAttentionDeliveryEventId;

type NotificationTypesSectionProps = Readonly<{
    policy: AttentionDeliveryPolicyV1;
    builtin?: Extract<NotificationChannelRecordV1, { kind: 'expo_push' }> | null;
    pushEnabled: boolean;
    setEventEnabled: (event: NotificationTypeEventId, enabled: boolean) => void;
    setReadyPreviewEnabled: (enabled: boolean) => void;
    setRequestPreviewEnabled: (enabled: boolean) => void;
}>;

export function NotificationTypesSection({
    policy,
    builtin,
    pushEnabled,
    setEventEnabled,
    setReadyPreviewEnabled,
    setRequestPreviewEnabled,
}: NotificationTypesSectionProps): React.ReactElement {
    const readyEnabled = readAccountNotificationPreference(policy, 'ready', builtin) === true;
    const readyPreviewEnabled = readAccountNotificationPreference(policy, 'readyPreview', builtin) === true;
    const requestPreviewEnabled = readAccountNotificationPreference(policy, 'requestPreview', builtin) === true;
    const permissionRequestsEnabled = readAccountNotificationPreference(policy, 'permission_request', builtin) === true;
    const userActionsEnabled = readAccountNotificationPreference(policy, 'user_action_request', builtin) === true;
    const followUpdatesEnabled = readAccountNotificationPreference(policy, 'follow_update') === true;

    return (
        <ItemGroup
            title={t('settingsNotifications.types.title')}
            description={t('settingsNotifications.types.footer')}
        >
            <SettingRow
                setting={NOTIFICATIONS_SETTINGS.settings.typesReady}
                rightElement={(
                    <Switch
                        value={readyEnabled}
                        disabled={!pushEnabled}
                        onValueChange={(value) => setEventEnabled('ready', Boolean(value))}
                    />
                )}
                showChevron={false}
            />
            <SettingRow
                setting={NOTIFICATIONS_SETTINGS.settings.typesReadyPreview}
                rightElement={(
                    <Switch
                        value={readyPreviewEnabled}
                        disabled={!pushEnabled || !readyEnabled}
                        onValueChange={(value) => setReadyPreviewEnabled(Boolean(value))}
                    />
                )}
                showChevron={false}
            />
            <SettingRow
                setting={NOTIFICATIONS_SETTINGS.settings.typesRequestPreview}
                rightElement={(
                    <Switch
                        value={requestPreviewEnabled}
                        disabled={!pushEnabled || (!permissionRequestsEnabled && !userActionsEnabled)}
                        onValueChange={(value) => setRequestPreviewEnabled(Boolean(value))}
                    />
                )}
                showChevron={false}
            />
            <SettingRow
                setting={NOTIFICATIONS_SETTINGS.settings.typesPermissionRequests}
                rightElement={(
                    <Switch
                        value={permissionRequestsEnabled}
                        disabled={!pushEnabled}
                        onValueChange={(value) => setEventEnabled('permission_request', Boolean(value))}
                    />
                )}
                showChevron={false}
            />
            <SettingRow
                setting={NOTIFICATIONS_SETTINGS.settings.typesUserActions}
                rightElement={(
                    <Switch
                        value={userActionsEnabled}
                        disabled={!pushEnabled}
                        onValueChange={(value) => setEventEnabled('user_action_request', Boolean(value))}
                    />
                )}
                showChevron={false}
            />
            <SettingRow
                testID="settings-notifications-type-follow-update"
                setting={NOTIFICATIONS_SETTINGS.settings.following}
                rightElement={(
                    <Switch
                        value={followUpdatesEnabled}
                        disabled={!pushEnabled}
                        onValueChange={(value) => setEventEnabled('follow_update', Boolean(value))}
                    />
                )}
                showChevron={false}
            />
        </ItemGroup>
    );
}
