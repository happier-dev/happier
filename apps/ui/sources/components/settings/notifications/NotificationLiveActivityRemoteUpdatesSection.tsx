import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';
import type {
    AttentionDeliveryPolicyV1,
    LiveActivityRemoteUpdateCapabilityDiagnostics,
} from '@happier-dev/protocol';

import type { AttentionDeviceOverridesV1 } from '@/sync/domains/settings/attentionDeviceOverridesV1';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { buildLiveActivityRemoteUpdateDiagnosticsRows } from './liveActivityRemoteUpdateDiagnostics';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

type NotificationLiveActivityRemoteUpdatesSectionProps = Readonly<{
    policy: AttentionDeliveryPolicyV1;
    deviceModeOverride: AttentionDeviceOverridesV1['liveActivities']['remoteUpdateModeOverride'];
    diagnostics: LiveActivityRemoteUpdateCapabilityDiagnostics;
}>;

function rowTestId(rowId: string): string {
    return `settings-notifications-live-activity-remote-updates-${rowId.replaceAll('_', '-')}`;
}

function rowDetailText(row: ReturnType<typeof buildLiveActivityRemoteUpdateDiagnosticsRows>[number]): string {
    const detail = t(row.detailKey);
    if (!row.diagnosticKeys || row.diagnosticKeys.length === 0) {
        return detail;
    }
    return `${detail} (${row.diagnosticKeys.join(', ')})`;
}

export function NotificationLiveActivityRemoteUpdatesSection({
    policy,
    deviceModeOverride,
    diagnostics,
}: NotificationLiveActivityRemoteUpdatesSectionProps): React.ReactElement {
    const { theme } = useUnistyles();
    const remotePolicy = policy.liveActivityRemoteUpdates;
    const rows = React.useMemo(() => buildLiveActivityRemoteUpdateDiagnosticsRows({
        preferredMode: remotePolicy.preferredMode,
        allowBackgroundWakeFallback: remotePolicy.allowBackgroundWakeFallback,
        deviceModeOverride: remotePolicy.enabled ? deviceModeOverride : 'disabled',
        diagnostics,
    }), [
        deviceModeOverride,
        diagnostics,
        remotePolicy.allowBackgroundWakeFallback,
        remotePolicy.enabled,
        remotePolicy.preferredMode,
    ]);

    return (
        <ItemGroup
            title={t('settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.title')}
            footer={t('settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.footer')}
        >
            {rows.map((row) => (
                <Item
                    key={row.id}
                    testID={rowTestId(row.id)}
                    title={t(row.titleKey)}
                    subtitle={t(row.subtitleKey)}
                    detail={rowDetailText(row)}
                    icon={(
                        <Icon
                            name={row.icon as IconName}
                            size={29}
                            color={row.detailKey.endsWith('.available') || row.detailKey.endsWith('.bestEffort')
                                ? theme.colors.state.success.foreground
                                : theme.colors.text.secondary}
                        />
                    )}
                    mode="info"
                    showChevron={false}
                />
            ))}
        </ItemGroup>
    );
}
