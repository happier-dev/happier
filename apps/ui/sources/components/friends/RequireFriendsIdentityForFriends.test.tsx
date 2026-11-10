import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { t } from '@/text';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
installDisconnectedServerSocketBoundary();
const { RequireFriendsIdentityForFriendsBase } = await import('./RequireFriendsIdentityForFriends');
afterEach(standardCleanup);

type BaseProps = React.ComponentProps<typeof RequireFriendsIdentityForFriendsBase>;

async function renderBase(overrides: Partial<BaseProps>) {
    const props: BaseProps = {
        variant: 'username',
        isReady: false,
        connect: { kind: 'connect', providerId: 'github', providerName: 'GitHub' },
        onSaveUsername: () => {},
        onConnectProvider: () => {},
        children: <TextStub>CHILD</TextStub>,
        ...overrides,
    };
    return renderScreen(<RequireFriendsIdentityForFriendsBase {...props} />);
}

const continueWithGitHub = () => t('friends.providerGate.continueWith', { provider: 'GitHub' });

function TextStub(props: { children?: React.ReactNode }) {
    return <>{props.children}</>;
}

describe('RequireFriendsIdentityForFriendsBase', () => {
    it('claims a username, and names the configured provider as the other way in', async () => {
        const screen = await renderBase({});

        expect(screen.tree.findAllByProps({ children: 'CHILD' })).toHaveLength(0);
        expect(screen.findAllByProps({ accessibilityLabel: t('profile.username') }).length).toBeGreaterThan(0);
        expect(screen.findAllByProps({ accessibilityLabel: t('common.save') }).length).toBeGreaterThan(0);
        expect(screen.findAllByProps({ accessibilityLabel: continueWithGitHub() }).length).toBeGreaterThan(0);
    });

    it('offers no provider when this Home configured none', async () => {
        const screen = await renderBase({ connect: { kind: 'none' } });

        expect(screen.findAllByProps({ accessibilityLabel: t('common.save') }).length).toBeGreaterThan(0);
        expect(screen.findAllByProps({ accessibilityLabel: continueWithGitHub() })).toHaveLength(0);
        expect(screen.tree.findAll((node) => typeof node.props?.accessibilityLabel === 'string'
            && node.props.accessibilityLabel.includes('OAuth'))).toHaveLength(0);
    });

    it('prefills the username input when initialUsername is provided', async () => {
        const screen = await renderBase({ initialUsername: 'my_provider_name' });

        const usernameInputs = screen.findAllByProps({ accessibilityLabel: t('profile.username') });
        expect(usernameInputs.length).toBeGreaterThan(0);
        expect(usernameInputs[0]?.props?.value).toBe('my_provider_name');
    });

    it('renders a username hint when provided', async () => {
        const screen = await renderBase({ usernameHint: 'That name is already taken' });

        expect(screen.tree.findAllByProps({ children: 'That name is already taken' }).length).toBeGreaterThan(0);
    });

    it('asks only for the required provider on the provider step', async () => {
        const screen = await renderBase({ variant: 'provider' });

        expect(screen.tree.findAllByProps({ children: 'CHILD' })).toHaveLength(0);
        expect(screen.findAllByProps({ accessibilityLabel: continueWithGitHub() }).length).toBeGreaterThan(0);
        expect(screen.findAllByProps({ accessibilityLabel: t('common.save') })).toHaveLength(0);
    });

    it('says the required provider is missing instead of offering a control that cannot work', async () => {
        const screen = await renderBase({ variant: 'provider', connect: { kind: 'notConfigured', providerName: 'GitHub' } });

        expect(screen.findAllByProps({ accessibilityLabel: continueWithGitHub() })).toHaveLength(0);
        expect(screen.tree.findAllByProps({ title: t('friends.providerGate.notConfigured', { provider: 'GitHub' }) }).length).toBeGreaterThan(0);
    });

    it('renders children when identity is ready', async () => {
        const screen = await renderBase({
            isReady: true,
        });

        expect(screen.tree.findAllByProps({ children: 'CHILD' }).length).toBeGreaterThan(0);
    });
});
