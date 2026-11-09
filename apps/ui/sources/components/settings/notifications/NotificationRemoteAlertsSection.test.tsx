import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { applyLocalSettings, localSettingsParse } from '@/sync/domains/settings/localSettings';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { NotificationRemoteAlertsSection, type RemoteAlertRegistrationStatus } from './NotificationRemoteAlertsSection';

installSettingsViewCommonModuleMocks();

const CONFIRMED: RemoteAlertRegistrationStatus = {
    accountPolicy: 'current', supported: true, nativeAvailable: true,
    deviceEnrollment: 'enrolled', refreshing: false,
};

function SettingsHarness({ registration = CONFIRMED, nativeDevice = true, deviceOptedIn = true }: Readonly<{
    registration?: RemoteAlertRegistrationStatus;
    nativeDevice?: boolean;
    /** This device's remote-alert opt-in; an opted-in switch stays enabled so it can always be turned off. */
    deviceOptedIn?: boolean;
}>) {
    const [account, setAccount] = React.useState(() => accountSettingsParse({ sessionRemoteAlertsEnabled: true }));
    const [local, setLocal] = React.useState(() => localSettingsParse({ localNotificationsEnabled: false, deviceRemoteAlertsEnabled: deviceOptedIn }));
    return <NotificationRemoteAlertsSection
        homeName="Studio Home"
        accountEnabled={account.sessionRemoteAlertsEnabled}
        deviceEnabled={local.deviceRemoteAlertsEnabled}
        nativeDevice={nativeDevice}
        registration={registration}
        setAccountEnabled={(enabled) => setAccount((current) => accountSettingsParse({ ...current, sessionRemoteAlertsEnabled: enabled }))}
        setDeviceEnabled={(enabled) => setLocal((current) => applyLocalSettings(current, { deviceRemoteAlertsEnabled: enabled }))}
        refresh={() => undefined}
    />;
}

describe('NotificationRemoteAlertsSection', () => {
    it('keeps Account consent and device remote opt-out independent of local notification enablement', async () => {
        const screen = await renderSettingsView(<SettingsHarness />);
        const account = () => screen.findByTestId('settings-notifications-remote-account-switch')!;
        const device = () => screen.findByTestId('settings-notifications-remote-device-switch')!;
        expect(account()).not.toBeNull();
        expect(device()).not.toBeNull();
        expect(device().props.value).toBe(true);
        await act(async () => { device().props.onValueChange(false); });
        expect(device().props.value).toBe(false);
        expect(account().props.value).toBe(true);
        await act(async () => { account().props.onValueChange(false); });
        expect(account().props.value).toBe(false);
        expect(device().props.value).toBe(false);
    });

    it('allows withdrawal but refuses new consent or enrollment when support is unavailable', async () => {
        const screen = await renderSettingsView(<SettingsHarness registration={{
            ...CONFIRMED, accountPolicy: 'unavailable', supported: false, nativeAvailable: false, deviceEnrollment: 'unavailable',
        }} />);
        const account = () => screen.findByTestId('settings-notifications-remote-account-switch')!;
        const device = () => screen.findByTestId('settings-notifications-remote-device-switch')!;
        expect(account()).not.toBeNull();
        expect(account().props.disabled).toBe(false);
        await act(async () => { account().props.onValueChange(false); device().props.onValueChange(false); });
        expect(account().props.disabled).toBe(true);
        expect(device().props.disabled).toBe(true);
    });

    it('enables the device switch in place when native enrollment becomes available', async () => {
        const unavailable: RemoteAlertRegistrationStatus = {
            ...CONFIRMED,
            accountPolicy: 'unavailable',
            supported: false,
            nativeAvailable: false,
            deviceEnrollment: 'unavailable',
        };
        const screen = await renderSettingsView(<SettingsHarness registration={unavailable} deviceOptedIn={false} />);
        expect(screen.findByTestId('settings-notifications-remote-device-switch')?.props.disabled).toBe(true);

        await screen.update(<SettingsHarness registration={{
            ...CONFIRMED,
            deviceEnrollment: 'disabled',
        }} deviceOptedIn={false} />);

        expect(screen.findByTestId('settings-notifications-remote-device-switch')?.props.disabled).toBe(false);
    });

    it.each(['enrolling', 'removing'] as const)('announces the in-flight %s state instead of stale enrollment', async (deviceEnrollment) => {
        const screen = await renderSettingsView(<SettingsHarness registration={{
            ...CONFIRMED,
            deviceEnrollment,
        }} />);

        // The row renders through `SettingRow`: read the announced subtitle and the rendered busy state.
        const matches = screen.findAllByTestId('settings-notifications-remote-device');
        expect(matches.find((node) => typeof node.props.subtitle === 'string')?.props.subtitle)
            .toContain('settingsNotifications.remoteAlerts.pending');
        expect(matches.some((node) => node.props.accessibilityState?.busy === true)).toBe(true);
    });

    it.each(['current', 'stale', 'pending', 'unavailable'] as const)('shows the reported %s Home policy separately from consent', async (accountPolicy) => {
        const screen = await renderSettingsView(<SettingsHarness registration={{ ...CONFIRMED, accountPolicy }} />);
        expect(screen.findByTestId(`settings-notifications-remote-policy-${accountPolicy}`)).not.toBeNull();
    });

    it('does not offer native enrollment on web', async () => {
        const screen = await renderSettingsView(<SettingsHarness nativeDevice={false} />);
        expect(screen.findByTestId('settings-notifications-remote-account-switch')).not.toBeNull();
        expect(screen.findByTestId('settings-notifications-remote-device-switch')).toBeNull();
    });
});
