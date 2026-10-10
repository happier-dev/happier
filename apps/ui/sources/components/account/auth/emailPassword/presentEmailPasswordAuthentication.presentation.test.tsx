import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { CustomModal } from '@/modal/components/CustomModal';
import type { CustomModalConfig, ModalConfig } from '@/modal/types';
import { t } from '@/text';
import { presentEmailPasswordAuthentication } from './presentEmailPasswordAuthentication';

// Exercise the real card and panel with the canonical native platform boundary;
// browser portal/focus behavior is covered separately by BaseModal's DOM tests.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative'))
    .createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push }) }));

let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
let unregister: (() => void) | undefined;

// The provider's Omit<ModalConfig, 'id'> loses union-specific fields; check the
// actual custom variant before rendering the configuration it published.
function isCustomModalConfig(config: Omit<ModalConfig, 'id'>): config is Omit<CustomModalConfig, 'id'> {
    return config.type === 'custom' && 'component' in config;
}

afterEach(async () => {
    await screen?.unmount();
    screen = null;
    unregister?.();
    unregister = undefined;
    await standardCleanup();
});

it('lets the real authentication panel own its visible heading across login and recovery', async () => {
    let shown: Omit<ModalConfig, 'id'> | undefined;
    unregister = Modal.registerProvider({
        showModal: (config) => { shown = config; return 'auth-presentation'; },
        hideModal: vi.fn(),
        hideAllModals: vi.fn(),
        updateCustomModalProps: vi.fn(),
    });
    presentEmailPasswordAuthentication({
        target: {
            endpointUrl: 'https://home.example.test',
            canonicalServerUrl: 'https://home.example.test',
            addressAnchorUrl: 'https://home.example.test',
            serverId: 'home',
            serverIdentityId: 'srv_home',
        },
        recoveryTarget: 'srv_home',
        action: 'login',
        mode: 'either',
        passwordReset: 'email',
        onAuthenticated: vi.fn(),
    });
    function config(): CustomModalConfig {
        if (!shown || !isCustomModalConfig(shown)) throw new Error('Authentication did not present a custom modal');
        return { ...shown, id: 'auth-presentation' };
    }
    const onClose = vi.fn();
    screen = await renderScreen(<CustomModal config={config()} visible onClose={onClose} />);
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
    // The recovery page must not remain underneath this modal's focus trap.
    expect(onClose).toHaveBeenCalledOnce();
});
