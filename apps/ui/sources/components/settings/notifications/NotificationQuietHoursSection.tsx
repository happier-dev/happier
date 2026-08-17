import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { AttentionDeviceOverridesV1 } from '@/sync/domains/settings/attentionDeviceOverridesV1';
import { t } from '@/text';
import type { AttentionDeliveryPolicyV1 } from '@happier-dev/protocol';
import { Icon } from '@/components/ui/icons/Icon';

const NIGHTLY_QUIET_HOURS_WINDOW = {
    startLocalTime: '22:00',
    endLocalTime: '07:00',
} as const;

type QuietHoursOverride = AttentionDeviceOverridesV1['quietHoursOverride'];
type QuietHoursPolicy = AttentionDeliveryPolicyV1['quietHours'];

type NotificationQuietHoursSectionProps = Readonly<{
    policy: AttentionDeliveryPolicyV1;
    deviceOverride: QuietHoursOverride;
    setAccountQuietHours: (quietHours: QuietHoursPolicy) => void;
    setDeviceQuietHoursOverride: (override: QuietHoursOverride) => void;
}>;

function resolveDefaultTimezone(policy: AttentionDeliveryPolicyV1): string {
    const configured = policy.quietHours.timezone.trim();
    if (configured.length > 0 && configured !== 'UTC') {
        return configured;
    }

    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || configured || 'UTC';
    } catch {
        return configured || 'UTC';
    }
}

function hasNightlyQuietHours(policy: AttentionDeliveryPolicyV1): boolean {
    return policy.quietHours.enabled === true
        && policy.quietHours.windows.some((window) => (
            window.startLocalTime === NIGHTLY_QUIET_HOURS_WINDOW.startLocalTime
            && window.endLocalTime === NIGHTLY_QUIET_HOURS_WINDOW.endLocalTime
            && (window.days === undefined || window.days.length === 0)
        ));
}

export function NotificationQuietHoursSection({
    policy,
    deviceOverride,
    setAccountQuietHours,
    setDeviceQuietHoursOverride,
}: NotificationQuietHoursSectionProps): React.ReactElement {
    const { theme } = useUnistyles();
    const accountEnabled = policy.quietHours.enabled === true;
    const accountNightlySelected = hasNightlyQuietHours(policy);

    const setAccountOff = React.useCallback(() => {
        setAccountQuietHours({
            enabled: false,
            timezone: resolveDefaultTimezone(policy),
            windows: [],
        });
    }, [policy, setAccountQuietHours]);

    const setAccountNightly = React.useCallback(() => {
        setAccountQuietHours({
            enabled: true,
            timezone: resolveDefaultTimezone(policy),
            windows: [
                {
                    ...NIGHTLY_QUIET_HOURS_WINDOW,
                },
            ],
        });
    }, [policy, setAccountQuietHours]);

    const setDeviceCustomNightly = React.useCallback(() => {
        setDeviceQuietHoursOverride({
            mode: 'custom',
            timezone: resolveDefaultTimezone(policy),
            windows: [
                {
                    ...NIGHTLY_QUIET_HOURS_WINDOW,
                },
            ],
        });
    }, [policy, setDeviceQuietHoursOverride]);

    return (
        <ItemGroup
            title={t('settingsNotifications.quietHours.title')}
            footer={t('settingsNotifications.quietHours.footer')}
        >
            <Item
                testID="settings-notifications-quiet-hours-account-off"
                title={t('settingsNotifications.quietHours.accountOffTitle')}
                subtitle={t('settingsNotifications.quietHours.accountOffSubtitle')}
                icon={<Icon name="bell" size={29} color={theme.colors.accent.blue} />}
                selected={!accountEnabled}
                onPress={setAccountOff}
                showChevron={false}
            />
            <Item
                testID="settings-notifications-quiet-hours-account-nightly"
                title={t('settingsNotifications.quietHours.accountNightlyTitle')}
                subtitle={t('settingsNotifications.quietHours.accountNightlySubtitle')}
                icon={<Icon name="moon" size={29} color={theme.colors.text.secondary} />}
                selected={accountNightlySelected}
                onPress={setAccountNightly}
                showChevron={false}
            />
            <Item
                testID="settings-notifications-quiet-hours-device-account"
                title={t('settingsNotifications.quietHours.deviceAccountTitle')}
                subtitle={t('settingsNotifications.quietHours.deviceAccountSubtitle')}
                icon={<Icon name="device-mobile" size={29} color={theme.colors.text.secondary} />}
                selected={deviceOverride.mode === 'account'}
                onPress={() => setDeviceQuietHoursOverride({ mode: 'account' })}
                showChevron={false}
            />
            <Item
                testID="settings-notifications-quiet-hours-device-disabled"
                title={t('settingsNotifications.quietHours.deviceDisabledTitle')}
                subtitle={t('settingsNotifications.quietHours.deviceDisabledSubtitle')}
                icon={<Icon name="bell-slash" size={29} color={theme.colors.text.secondary} />}
                selected={deviceOverride.mode === 'disabled'}
                onPress={() => setDeviceQuietHoursOverride({ mode: 'disabled' })}
                showChevron={false}
            />
            <Item
                testID="settings-notifications-quiet-hours-device-custom-nightly"
                title={t('settingsNotifications.quietHours.deviceCustomNightlyTitle')}
                subtitle={t('settingsNotifications.quietHours.deviceCustomNightlySubtitle')}
                icon={<Icon name="moon" size={29} color={theme.colors.text.secondary} />}
                selected={deviceOverride.mode === 'custom'}
                onPress={setDeviceCustomNightly}
                showChevron={false}
            />
        </ItemGroup>
    );
}
