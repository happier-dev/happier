import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { accountSettingsScopeKeySuffix } from '@/sync/domains/settings/scope/accountSettingsScope';
import { QuietHoursScheduleEditor } from './QuietHoursScheduleEditor';
import type { AttentionQuietHoursInput } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicy';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { NOTIFICATIONS_SETTINGS } from '@/components/settings/notifications/notificationsSettings';
import type { AttentionDeviceOverridesV1 } from '@/sync/domains/settings/attentionDeviceOverridesV1';
import { t } from '@/text';
import type { AttentionDeliveryPolicyV1 } from '@happier-dev/protocol/account/settings/attentionDeliveryPolicy';
import {
    isNightlyQuietHoursWindowSet,
    NIGHTLY_QUIET_HOURS_WINDOW,
} from '@/activity/delivery/resolveQuietHoursState';
import { resolveNotificationQuietHoursTimezone } from './notificationPreferences';

type QuietHoursOverride = AttentionDeviceOverridesV1['quietHoursOverride'];
/** Both presets and the custom editor use the same declared setting writers. */
type QuietHoursOverrideChoice = Readonly<{ mode: 'account' | 'disabled' }>
    | Readonly<{ mode: 'custom'; timezone: string; windows: AttentionQuietHoursInput['windows'] }>;
type AccountQuietHoursChoice = 'off' | 'nightly' | 'custom';
type DeviceQuietHoursChoice = 'account' | 'disabled' | 'nightly' | 'custom';

type NotificationQuietHoursSectionProps = Readonly<{
    policy: AttentionDeliveryPolicyV1;
    deviceOverride: QuietHoursOverride;
    setAccountQuietHours: (value: 'off' | 'nightly' | AttentionQuietHoursInput) => Promise<boolean>;
    setDeviceQuietHoursOverride: (override: QuietHoursOverrideChoice) => Promise<boolean>;
}>;

function readDeviceTimezone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
        return '';
    }
}

/**
 * The schedule's own zone, shown only when it is not this device's. Quiet hours are local times in
 * an Account-wide zone, so a device in another zone is otherwise told "10 PM to 7 AM" while the
 * effective window is somewhere else entirely — the one reachable cross-device untruth here.
 */
function foreignScheduleTimezone(timezone: string | undefined): string | undefined {
    const configured = timezone?.trim();
    if (!configured) return undefined;
    const device = readDeviceTimezone();
    return device && configured !== device ? configured : undefined;
}

export function NotificationQuietHoursSection(props: NotificationQuietHoursSectionProps): React.ReactElement {
    const scope = useAccountSettingsScope();
    return <AccountQuietHoursSection key={scope ? accountSettingsScopeKeySuffix(scope) : 'unbound'} {...props} />;
}

function AccountQuietHoursSection({
    policy,
    deviceOverride,
    setAccountQuietHours,
    setDeviceQuietHoursOverride,
}: NotificationQuietHoursSectionProps): React.ReactElement {
    const [editing, setEditing] = React.useState<'account' | 'device' | null>(null);
    const accountEnabled = policy.quietHours.enabled === true;
    // Selected means "this row IS the configured schedule", so a foreign or richer schedule is
    // neither mislabelled nor silently replaced by pressing the preset.
    const accountNightlySelected = accountEnabled && isNightlyQuietHoursWindowSet(policy.quietHours.windows);
    const deviceNightlySelected = deviceOverride.mode === 'custom'
        && isNightlyQuietHoursWindowSet(deviceOverride.windows);
    const accountScheduleTimezone = accountEnabled ? foreignScheduleTimezone(policy.quietHours.timezone) : undefined;
    const deviceScheduleTimezone = deviceOverride.mode === 'custom'
        ? foreignScheduleTimezone(deviceOverride.timezone)
        : undefined;

    const setDeviceCustomNightly = React.useCallback(() => {
        setDeviceQuietHoursOverride({
            mode: 'custom',
            timezone: resolveNotificationQuietHoursTimezone(policy),
            windows: [
                {
                    ...NIGHTLY_QUIET_HOURS_WINDOW,
                },
            ],
        });
    }, [policy, setDeviceQuietHoursOverride]);

    const accountChoice: AccountQuietHoursChoice = !accountEnabled ? 'off' : accountNightlySelected ? 'nightly' : 'custom';
    const deviceChoice: DeviceQuietHoursChoice = deviceOverride.mode === 'account'
        ? 'account'
        : deviceOverride.mode === 'disabled'
            ? 'disabled'
            : deviceNightlySelected ? 'nightly' : 'custom';
    const withZone = (text: string, zone: string | undefined) => (zone ? `${text} · ${zone}` : text);

    return (
        <ItemGroup
            title={t('settingsNotifications.quietHours.title')}
            description={t('settingsNotifications.quietHours.footer')}
        >
            <SettingAnchor setting={NOTIFICATIONS_SETTINGS.settings.quietHoursAccount}>
                <SegmentedChoiceItem<AccountQuietHoursChoice>
                    // Remount when the schedule leaves the presets so no stale selection stays drawn.
                    key={accountChoice === 'custom' ? 'account-custom' : 'account-preset'}
                    testID="settings-notifications-quiet-hours-account"
                    testIDPrefix="settings-notifications-quiet-hours-account"
                    title={t(NOTIFICATIONS_SETTINGS.settings.quietHoursAccount.titleKey)}
                    // A schedule these presets do not describe is shown as such; choosing a preset replaces it.
                    subtitle={t('settingsNotifications.quietHours.customSubtitle')}
                    subtitleLines={0}
                    value={accountChoice}
                    onChange={(next) => {
                        if (next === 'custom') setEditing('account');
                        else { setEditing(null); void setAccountQuietHours(next); }
                    }}
                    options={[
                        { id: 'custom', label: t('settingsNotifications.quietHours.customShort'), description: t('settingsNotifications.quietHours.customSubtitle') },
                        { id: 'off', label: t('settingsNotifications.quietHours.offShort'), description: t('settingsNotifications.quietHours.accountOffSubtitle') },
                        {
                            id: 'nightly',
                            label: t('settingsNotifications.quietHours.nightlyShort'),
                            description: withZone(t('settingsNotifications.quietHours.accountNightlySubtitle'), accountScheduleTimezone),
                        },
                    ]}
                />
            </SettingAnchor>
            <ExpandableItem expanded={editing === 'account'} onExpandedChange={expanded => setEditing(expanded ? 'account' : null)}
                header={({ headerProps }) => <Item {...headerProps} testID="settings-notifications-quiet-hours-account-edit"
                    title={t('settingsNotifications.quietHours.editSchedule')} />}>
            {editing === 'account' ? <QuietHoursScheduleEditor
                testIDPrefix="settings-notifications-quiet-hours-account-editor"
                initial={{ enabled: true, timezone: policy.quietHours.timezone, windows: policy.quietHours.windows.map(window => ({
                    startLocalTime: window.startLocalTime, endLocalTime: window.endLocalTime,
                    ...(window.days ? { days: [...window.days] } : {}),
                })) }}
                onCancel={() => setEditing(null)}
                onSave={async value => { const saved = await setAccountQuietHours(value); if (saved) setEditing(null); return saved; }} /> : null}
            </ExpandableItem>
            <SettingAnchor setting={NOTIFICATIONS_SETTINGS.settings.quietHoursDevice}>
                <SegmentedChoiceItem<DeviceQuietHoursChoice>
                    key={deviceChoice === 'custom' ? 'device-custom' : 'device-preset'}
                    testID="settings-notifications-quiet-hours-device"
                    testIDPrefix="settings-notifications-quiet-hours-device"
                    title={t(NOTIFICATIONS_SETTINGS.settings.quietHoursDevice.titleKey)}
                    subtitle={t('settingsNotifications.quietHours.customSubtitle')}
                    subtitleLines={0}
                    value={deviceChoice}
                    onChange={(next) => {
                        if (next === 'custom') { setEditing('device'); return; }
                        setEditing(null);
                        if (next === 'account') void setDeviceQuietHoursOverride({ mode: 'account' });
                        else if (next === 'disabled') setDeviceQuietHoursOverride({ mode: 'disabled' });
                        else if (next === 'nightly') setDeviceCustomNightly();
                    }}
                    options={[
                        { id: 'custom', label: t('settingsNotifications.quietHours.customShort'), description: t('settingsNotifications.quietHours.customSubtitle') },
                        { id: 'account', label: t('settingsNotifications.quietHours.syncedShort'), description: t('settingsNotifications.quietHours.deviceAccountSubtitle') },
                        { id: 'disabled', label: t('settingsNotifications.quietHours.offShort'), description: t('settingsNotifications.quietHours.deviceDisabledSubtitle') },
                        {
                            id: 'nightly',
                            label: t('settingsNotifications.quietHours.nightlyShort'),
                            description: withZone(t('settingsNotifications.quietHours.deviceCustomNightlySubtitle'), deviceScheduleTimezone),
                        },
                    ]}
                />
            </SettingAnchor>
            <ExpandableItem expanded={editing === 'device'} onExpandedChange={expanded => setEditing(expanded ? 'device' : null)}
                header={({ headerProps }) => <Item {...headerProps} testID="settings-notifications-quiet-hours-device-edit"
                    title={t('settingsNotifications.quietHours.editSchedule')} />}>
            {editing === 'device' ? <QuietHoursScheduleEditor
                testIDPrefix="settings-notifications-quiet-hours-device-editor"
                initial={{ enabled: true,
                    timezone: deviceOverride.mode === 'custom' ? deviceOverride.timezone : policy.quietHours.timezone,
                    windows: (deviceOverride.mode === 'custom' ? deviceOverride.windows : policy.quietHours.windows).map(window => ({
                        startLocalTime: window.startLocalTime, endLocalTime: window.endLocalTime,
                        ...(window.days ? { days: [...window.days] } : {}),
                    })) }}
                onCancel={() => setEditing(null)}
                onSave={async ({ timezone, windows }) => { const saved = await setDeviceQuietHoursOverride({ mode: 'custom', timezone, windows });
                    if (saved) setEditing(null); return saved; }} /> : null}
            </ExpandableItem>
        </ItemGroup>
    );
}
