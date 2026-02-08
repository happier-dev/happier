import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { t } from '@/text';
import {
    RequireFriendsIdentityForFriends,
    RequireFriendsIdentityForFriendsBase,
} from './RequireFriendsIdentityForFriends';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/hooks/useOAuthProviderConfigured', () => ({
    useOAuthProviderConfigured: () => true,
}));

vi.mock('@/hooks/useFriendsAllowUsernameSupport', () => ({
    useFriendsAllowUsernameSupport: () => false,
}));

vi.mock('@/hooks/useFriendsRequiredIdentityProviderId', () => ({
    useFriendsRequiredIdentityProviderId: () => 'fake',
}));

vi.mock('@/hooks/useFriendsIdentityReadiness', () => ({
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

vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/auth/providers/registry', () => {
    const provider = {
        id: 'fake',
        displayName: 'FakeHub',
        connectButtonColor: '#000000',
        getExternalSignupUrl: async () => 'https://example.test/auth',
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

vi.mock('@/auth/tokenStorage', () => ({
    TokenStorage: {
        setPendingExternalConnect: async () => {},
    },
}));

vi.mock('@/sync/apiUsername', () => ({
    setAccountUsername: async () => ({ username: 'x' }),
}));

vi.mock('@/utils/errors', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/errors')>();
    return { ...actual };
});

vi.mock('@/modal', () => ({
    Modal: {
        alert: async () => {},
    },
}));

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

vi.mock('@/sync/storageStore', () => ({
    storage: hoistedStorage.storage,
}));

type BaseProps = React.ComponentProps<typeof RequireFriendsIdentityForFriendsBase>;

function renderBase(overrides: Partial<BaseProps>): renderer.ReactTestRenderer {
    const props: BaseProps = {
        variant: 'username',
        isReady: false,
        providerDisplayName: 'GitHub',
        onSaveUsername: () => {},
        onConnectProvider: () => {},
        children: <TextStub>CHILD</TextStub>,
        ...overrides,
    };
    return renderer.create(<RequireFriendsIdentityForFriendsBase {...props} />);
}

function findByLabel(tree: renderer.ReactTestRenderer, label: string) {
    return tree.root.findAll((node) => node.props?.accessibilityLabel === label);
}

function TextStub(props: { children?: React.ReactNode }) {
    return <>{props.children}</>;
}

describe('RequireFriendsIdentityForFriendsBase', () => {
    it('renders a username gate when identity is not ready and variant=username', async () => {
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderBase({});
        });

        expect(tree!.root.findAllByProps({ children: 'CHILD' })).toHaveLength(0);
        expect(findByLabel(tree!, t('profile.username')).length).toBeGreaterThan(0);
        expect(findByLabel(tree!, t('common.save')).length).toBeGreaterThan(0);
        expect(findByLabel(tree!, t('friends.providerGate.connect', { provider: 'GitHub' })).length).toBeGreaterThan(0);
    });

    it('prefills the username input when initialUsername is provided', async () => {
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderBase({ initialUsername: 'my_provider_name' });
        });

        const usernameInputs = findByLabel(tree!, t('profile.username'));
        expect(usernameInputs.length).toBeGreaterThan(0);
        expect(usernameInputs[0]?.props?.value).toBe('my_provider_name');
    });

    it('renders a username hint when provided', async () => {
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderBase({ usernameHint: 'That name is already taken' });
        });

        expect(tree!.root.findAllByProps({ children: 'That name is already taken' }).length).toBeGreaterThan(0);
    });

    it('renders a provider-only gate when variant=provider', async () => {
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderBase({
                variant: 'provider',
                providerDisplayName: 'GitHub',
            });
        });

        expect(tree!.root.findAllByProps({ children: 'CHILD' })).toHaveLength(0);
        expect(findByLabel(tree!, t('friends.providerGate.connect', { provider: 'GitHub' })).length).toBeGreaterThan(0);
        expect(findByLabel(tree!, t('common.save'))).toHaveLength(0);
    });

    it('shows a configuration hint when Not available? is pressed', async () => {
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderBase({
                variant: 'provider',
                unavailableReason: 'OAuth not configured',
            });
        });

        expect(tree!.root.findAllByProps({ children: 'OAuth not configured' })).toHaveLength(0);

        const hintButtons = tree!.root.findAll(
            (node) =>
                node.props?.accessibilityLabel === t('friends.providerGate.notAvailable') &&
                typeof node.props?.onPress === 'function',
        );
        expect(hintButtons.length).toBeGreaterThan(0);

        await act(async () => {
            hintButtons[0]?.props?.onPress();
        });

        expect(tree!.root.findAllByProps({ children: 'OAuth not configured' }).length).toBeGreaterThan(0);
    });

    it('renders children when identity is ready', async () => {
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderBase({
                isReady: true,
            });
        });

        expect(tree!.root.findAllByProps({ children: 'CHILD' }).length).toBeGreaterThan(0);
    });
});

describe('RequireFriendsIdentityForFriends (wrapper)', () => {
    it('renders a provider gate using the required provider from features', async () => {
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(
                <RequireFriendsIdentityForFriends>
                    <TextStub>CHILD</TextStub>
                </RequireFriendsIdentityForFriends>,
            );
        });

        expect(tree!.root.findAllByProps({ children: 'CHILD' })).toHaveLength(0);
        expect(findByLabel(tree!, t('friends.providerGate.connect', { provider: 'FakeHub' })).length).toBeGreaterThan(0);
    });
});
