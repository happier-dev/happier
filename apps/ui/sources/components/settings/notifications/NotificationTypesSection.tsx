import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import type { AttentionDeliveryPolicyV1 } from '@happier-dev/protocol';
import { Icon } from '@/components/ui/icons/Icon';

export type NotificationTypeEventId = 'ready' | 'permission_request' | 'user_action_request';

type NotificationTypesSectionProps = Readonly<{
    policy: AttentionDeliveryPolicyV1;
    pushEnabled: boolean;
    setEventEnabled: (event: NotificationTypeEventId, enabled: boolean) => void;
    setReadyPreviewEnabled: (enabled: boolean) => void;
}>;

export function NotificationTypesSection({
    policy,
    pushEnabled,
    setEventEnabled,
    setReadyPreviewEnabled,
}: NotificationTypesSectionProps): React.ReactElement {
    const { theme } = useUnistyles();
    const readyEnabled = policy.channels.expo_push.events.ready.enabled !== false && policy.events.ready.enabled !== false;
    const readyPreviewEnabled = policy.channels.expo_push.previewBehavior !== 'status_only';
    const permissionRequestsEnabled =
        policy.channels.expo_push.events.permission_request.enabled !== false
        && policy.events.permission_request.enabled !== false;
    const userActionsEnabled =
        policy.channels.expo_push.events.user_action_request.enabled !== false
        && policy.events.user_action_request.enabled !== false;

    return (
        <ItemGroup
            title={t('settingsNotifications.types.title')}
            footer={t('settingsNotifications.types.footer')}
        >
            <Item
                title={t('settingsNotifications.types.ready.title')}
                subtitle={t('settingsNotifications.types.ready.subtitle')}
                icon={<Icon name="check-circle" size={29} color={theme.colors.state.success.foreground} />}
                rightElement={(
                    <Switch
                        value={readyEnabled}
                        disabled={!pushEnabled}
                        onValueChange={(value) => setEventEnabled('ready', Boolean(value))}
                    />
                )}
                showChevron={false}
            />
            <Item
                title={t('settingsNotifications.types.readyPreview.title')}
                subtitle={t('settingsNotifications.types.readyPreview.subtitle')}
                icon={<Icon name="chat-circle-dots" size={29} color={theme.colors.text.secondary} />}
                rightElement={(
                    <Switch
                        value={readyPreviewEnabled}
                        disabled={!pushEnabled || !readyEnabled}
                        onValueChange={(value) => setReadyPreviewEnabled(Boolean(value))}
                    />
                )}
                showChevron={false}
            />
            <Item
                title={t('settingsNotifications.types.permissionRequests.title')}
                subtitle={t('settingsNotifications.types.permissionRequests.subtitle')}
                icon={<Icon name="hand" size={29} color={theme.colors.text.secondary} />}
                rightElement={(
                    <Switch
                        value={permissionRequestsEnabled}
                        disabled={!pushEnabled}
                        onValueChange={(value) => setEventEnabled('permission_request', Boolean(value))}
                    />
                )}
                showChevron={false}
            />
            <Item
                title={t('settingsNotifications.types.userActions.title')}
                subtitle={t('settingsNotifications.types.userActions.subtitle')}
                icon={<Icon name="chat-dots" size={29} color={theme.colors.text.secondary} />}
                rightElement={(
                    <Switch
                        value={userActionsEnabled}
                        disabled={!pushEnabled}
                        onValueChange={(value) => setEventEnabled('user_action_request', Boolean(value))}
                    />
                )}
                showChevron={false}
            />
        </ItemGroup>
    );
}
