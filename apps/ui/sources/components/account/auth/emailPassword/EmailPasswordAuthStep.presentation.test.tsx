import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { EmailPasswordAuthStep } from './EmailPasswordAuthStep';

// Exercise the real step and panel with the canonical native platform boundary.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative'))
    .createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push }) }));

let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;

afterEach(async () => {
    await screen?.unmount();
    screen = null;
    await standardCleanup();
});

it('lets the real authentication panel own its visible heading across login and recovery', async () => {
    const onClose = vi.fn();
    screen = await renderScreen(
        <EmailPasswordAuthStep
            target={{
                endpointUrl: 'https://home.example.test',
                canonicalServerUrl: 'https://home.example.test',
                addressAnchorUrl: 'https://home.example.test',
                serverId: 'home',
                serverIdentityId: 'srv_home',
            }}
            recoveryTarget="srv_home"
            action="login"
            mode="either"
            passwordReset="email"
            onAuthenticated={vi.fn()}
            onClose={onClose}
        />,
    );
    const headingCount = (key: Parameters<typeof t>[0]) => screen!.findAllByType(Text)
        .filter(node => node.props.children === t(key)).length;

    expect(headingCount('settingsAccount.nativePassword.title')).toBe(1);
    expect(screen.findByTestId('email-password-email')).not.toBeNull();
    expect(screen.findByTestId('email-password-password')).not.toBeNull();
    await screen.pressByTestIdAsync('email-password-forgot');
    expect(headingCount('settingsAccount.nativePassword.forgotTitle')).toBe(1);
    expect(headingCount('settingsAccount.nativePassword.title')).toBe(0);
    expect(screen.findByTestId('email-password-request-reset')).not.toBeNull();
    await screen.pressByTestIdAsync('email-password-forgot-back');
    expect(headingCount('settingsAccount.nativePassword.title')).toBe(1);
    expect(onClose).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('email-password-back');
    expect(onClose).toHaveBeenCalledOnce();
    onClose.mockClear();
    await screen.pressByTestIdAsync('email-password-forgot');
    await screen.pressByTestIdAsync('email-password-use-recovery-key');
    expect(push).toHaveBeenLastCalledWith({
        pathname: '/auth/password/recover',
        params: { target: 'srv_home' },
    });
    // The recovery page replaces this step rather than opening over it.
    expect(onClose).toHaveBeenCalledOnce();
});
