import * as React from 'react';

import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { resolveAttentionDeliveryPolicyDecision, type AttentionDeliveryPolicyV1 } from '@happier-dev/protocol/account/settings/accountSettings';
import type { RemoteAlertAttentionDeliveryEventId } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicy';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { NOTIFICATIONS_SETTINGS } from '@/components/settings/notifications/notificationsSettings';

export type NotificationTypeEventId = RemoteAlertAttentionDeliveryEventId;

type NotificationTypesSectionProps = Readonly<{
    policy: AttentionDeliveryPolicyV1;
    pushEnabled: boolean;
    setEventEnabled: (event: NotificationTypeEventId, enabled: boolean) => void;
    setReadyPreviewEnabled: (enabled: boolean) => void;
    setRequestPreviewEnabled: (enabled: boolean) => void;
}>;

export function NotificationTypesSection({
    policy,
    pushEnabled,
    setEventEnabled,
    setReadyPreviewEnabled,
    setRequestPreviewEnabled,
}: NotificationTypesSectionProps): React.ReactElement {
    const readyEnabled = policy.channels.expo_push.events.ready.enabled !== false && policy.events.ready.enabled !== false;
    const readyPreviewEnabled = policy.channels.expo_push.previewBehavior !== 'status_only';
    const requestPreviewEnabled = ['permission_request', 'user_action_request'].every(
        (event) => resolveAttentionDeliveryPolicyDecision({ policy, event, channel: 'expo_push', now: new Date(0) }).previewBehavior === 'include_preview',
    );
    const permissionRequestsEnabled =
        policy.channels.expo_push.events.permission_request.enabled !== false
        && policy.events.permission_request.enabled !== false;
    const userActionsEnabled =
        policy.channels.expo_push.events.user_action_request.enabled !== false
        && policy.events.user_action_request.enabled !== false;
    const followUpdatesEnabled =
        policy.channels.expo_push.events.follow_update.enabled !== false
        && policy.events.follow_update.enabled !== false;

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
