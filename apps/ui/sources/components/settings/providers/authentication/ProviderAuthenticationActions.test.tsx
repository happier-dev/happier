import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ theme: { colors: { text: { secondary: '#777' } } } });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

describe('ProviderAuthenticationActions', () => {
    afterEach(() => standardCleanup());

    it('renders the contributed device-code action and dispatches its semantic kind', async () => {
        const onLaunchAuth = vi.fn();
        const { ProviderAuthenticationActions } = await import('./ProviderAuthenticationActions');
        const screen = await renderScreen(<ProviderAuthenticationActions
            canCheckNow={false}
            canLaunchAuth
            hasPrimaryLaunch
            hasDeviceCodeLaunch
            activeAuthLaunchKind={null}
            loginActionKind="login"
            onCheckNow={vi.fn()}
            onLaunchAuth={onLaunchAuth}
        />);

        const deviceItem = screen.findByProps({ testID: 'settings-provider-auth-device-code' });
        await pressTestInstanceAsync(deviceItem, 'device-code auth action');

        expect(onLaunchAuth).toHaveBeenCalledWith('device_code');
    });

    it('does not invent a primary action when only device-code authentication is contributed', async () => {
        const { ProviderAuthenticationActions } = await import('./ProviderAuthenticationActions');
        const screen = await renderScreen(<ProviderAuthenticationActions
            canCheckNow={false}
            canLaunchAuth
            hasPrimaryLaunch={false}
            hasDeviceCodeLaunch
            activeAuthLaunchKind={null}
            loginActionKind="login"
            onCheckNow={vi.fn()}
            onLaunchAuth={vi.fn()}
        />);

        expect(screen.findAllByProps({ testID: 'settings-provider-auth-login' })).toHaveLength(0);
        expect(screen.findAllByProps({ testID: 'settings-provider-auth-device-code' }).length).toBeGreaterThan(0);
    });

    it('disables every auth action while either terminal launch is active', async () => {
        const { ProviderAuthenticationActions } = await import('./ProviderAuthenticationActions');
        const screen = await renderScreen(<ProviderAuthenticationActions
            canCheckNow={false}
            canLaunchAuth
            hasPrimaryLaunch
            hasDeviceCodeLaunch
            activeAuthLaunchKind="device_code"
            loginActionKind="login"
            onCheckNow={vi.fn()}
            onLaunchAuth={vi.fn()}
        />);

        expect(screen.findByProps({ testID: 'settings-provider-auth-login' }).props.disabled).toBe(true);
        expect(screen.findByProps({ testID: 'settings-provider-auth-device-code' }).props.disabled).toBe(true);
    });
});
