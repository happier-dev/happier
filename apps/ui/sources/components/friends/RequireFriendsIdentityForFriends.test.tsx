import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { t } from '@/text';
import { renderScreen } from '@/dev/testkit';
import {
    RequireFriendsIdentityForFriends,
    RequireFriendsIdentityForFriendsBase,
} from './RequireFriendsIdentityForFriends';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/hooks/server/useOAuthProviderConfigured', () => ({
    useOAuthProviderConfigured: () => true,
}));

vi.mock('@/hooks/server/useFriendsAllowUsernameSupport', () => ({
    useFriendsAllowUsernameSupport: () => false,
}));

vi.mock('@/hooks/server/useFriendsRequiredIdentityProviderId', () => ({
    useFriendsRequiredIdentityProviderId: () => 'fake',
}));

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({
        isReady: false,
        isLoadingFeatures: false,
        reason: 'needsProvider',
        requiredProviderId: 'fake',
        requiredProviderDisplayName: 'FakeHub',
        requiredProviderConnected: false,
        requiredProviderLogin: null,
        gate: {
            isReady: false,
            gateVariant: 'provider',
            providerConnected: false,
            providerLogin: null,
            needsProviderConnection: true,
            needsUsername: false,
            suggestedUsername: null,
        },
    }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/auth/providers/registry', () => {
    const provider = {
        id: 'fake',
        displayName: 'FakeHub',
        connectButtonColor: '#000000',
        getExternalAuthUrl: async () => 'https://example.test/auth',
        getConnectUrl: async () => 'https://example.test/connect',
        finalizeConnect: async () => {},
        cancelConnectPending: async () => {},
        disconnect: async () => {},
    };
    return {
        authProviderRegistry: [provider],
        getAuthProvider: (id: string) => (id === 'fake' ? provider : null),
    };
});

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        setPendingExternalConnect: async () => {},
    },
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
}));

vi.mock('@/sync/api/account/apiUsername', () => ({
    setAccountUsername: async () => ({ username: 'x' }),
}));

vi.mock('@/utils/errors/errors', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/errors/errors')>();
    return { ...actual };
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: async () => {},
        },
    }).module;
});

const hoistedStorage = vi.hoisted(() => {
    const state = {
        profile: {
            id: 'a',
            timestamp: 0,
            firstName: null,
            lastName: null,
            username: null,
            avatar: null,
            linkedProviders: [] as unknown[],
            connectedServices: [] as unknown[],
        },
        applyProfile: () => {},
    };
    const storage = (<T,>(selector: (current: typeof state) => T) => selector(state)) as {
        <T>(selector: (current: typeof state) => T): T;
        getState: () => typeof state;
    };
    storage.getState = () => state;
    return { storage };
});

vi.mock('@/sync/domains/state/storageStore', () => ({
    storage: hoistedStorage.storage,
    getStorage: () => hoistedStorage.storage,
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => 1,
}));

type BaseProps = React.ComponentProps<typeof RequireFriendsIdentityForFriendsBase>;

async function renderBase(overrides: Partial<BaseProps>) {
    const props: BaseProps = {
        variant: 'username',
        isReady: false,
        providerDisplayName: 'GitHub',
        onSaveUsername: () => {},
        onConnectProvider: () => {},
        children: <TextStub>CHILD</TextStub>,
        ...overrides,
    };
    return renderScreen(<RequireFriendsIdentityForFriendsBase {...props} />);
}

function TextStub(props: { children?: React.ReactNode }) {
    return <>{props.children}</>;
}

describe('RequireFriendsIdentityForFriendsBase', () => {
    it('renders a username gate when identity is not ready and variant=username', async () => {
        const screen = await renderBase({});

        expect(screen.tree.findAllByProps({ children: 'CHILD' })).toHaveLength(0);
        expect(screen.findAllByProps({ accessibilityLabel: t('profile.username') }).length).toBeGreaterThan(0);
        expect(screen.findAllByProps({ accessibilityLabel: t('common.save') }).length).toBeGreaterThan(0);
        expect(screen.findAllByProps({ accessibilityLabel: t('friends.providerGate.connect', { provider: 'GitHub' }) }).length).toBeGreaterThan(0);
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

    it('renders a provider-only gate when variant=provider', async () => {
        const screen = await renderBase({
            variant: 'provider',
            providerDisplayName: 'GitHub',
        });

        expect(screen.tree.findAllByProps({ children: 'CHILD' })).toHaveLength(0);
        expect(screen.findAllByProps({ accessibilityLabel: t('friends.providerGate.connect', { provider: 'GitHub' }) }).length).toBeGreaterThan(0);
        expect(screen.findAllByProps({ accessibilityLabel: t('common.save') })).toHaveLength(0);
    });

    it('shows a configuration hint when Not available? is pressed', async () => {
        const screen = await renderBase({
            variant: 'provider',
            unavailableReason: 'OAuth not configured',
        });

        expect(screen.tree.findAllByProps({ children: 'OAuth not configured' })).toHaveLength(0);

        const hintButtons = screen.tree.findAll(
            (node) =>
                node.props?.accessibilityLabel === t('friends.providerGate.notAvailable') &&
                typeof node.props?.onPress === 'function',
        );
        expect(hintButtons.length).toBeGreaterThan(0);

        await act(async () => {
            hintButtons[0]?.props?.onPress();
        });

        expect(screen.tree.findAllByProps({ children: 'OAuth not configured' }).length).toBeGreaterThan(0);
    });

    it('renders children when identity is ready', async () => {
        const screen = await renderBase({
            isReady: true,
        });

        expect(screen.tree.findAllByProps({ children: 'CHILD' }).length).toBeGreaterThan(0);
    });
});

describe('RequireFriendsIdentityForFriends (wrapper)', () => {
    it('renders a provider gate using the required provider from features', async () => {
        const screen = await renderScreen(
            <RequireFriendsIdentityForFriends>
                <TextStub>CHILD</TextStub>
            </RequireFriendsIdentityForFriends>,
        );

        expect(screen.tree.findAllByProps({ children: 'CHILD' })).toHaveLength(0);
        expect(screen.findAllByProps({ accessibilityLabel: t('friends.providerGate.connect', { provider: 'FakeHub' }) }).length).toBeGreaterThan(0);
    });
});
