import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { t } from '@/text';
import { createWelcomeFeaturesResponse } from './index.testHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));
vi.mock('react-native-typography', () => ({ iOSUIKit: { title3: {} } }));
vi.mock('@/components/HomeHeader', () => ({ HomeHeaderNotAuth: () => null }));
vi.mock('@/components/MainView', () => ({ MainView: () => null }));
vi.mock('@shopify/react-native-skia', () => ({}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: false,
        credentials: null,
        login: vi.fn(async () => {}),
        logout: vi.fn(async () => {}),
    }),
}));

vi.mock('@/sync/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => null,
    setPendingTerminalConnect: vi.fn(),
    clearPendingTerminalConnect: vi.fn(),
}));

const getServerFeaturesMock = vi.fn(async () =>
    createWelcomeFeaturesResponse({
        signupMethods: [
            { id: 'anonymous', enabled: false },
            { id: 'github', enabled: true },
        ],
        requiredProviders: ['github'],
        autoRedirectEnabled: false,
        autoRedirectProviderId: null,
        providerOffboardingIntervalSeconds: 600,
    }),
);

vi.mock('@/sync/apiFeatures', async () => {
    const actual = await vi.importActual<typeof import('@/sync/apiFeatures')>('@/sync/apiFeatures');
    return {
        ...actual,
        getServerFeatures: getServerFeaturesMock,
    };
});

describe('/ (welcome) signup methods', () => {
    it('hides Create account when anonymous signup is disabled and shows provider option', async () => {
        vi.resetModules();
        getServerFeaturesMock.mockClear();
        const { default: Screen } = await import('./index');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });
            await act(async () => {});

            const textValues = tree.root
                .findAll((n) => typeof n.props?.children === 'string')
                .map((n) => String(n.props.children));

            expect(textValues).not.toContain(t('welcome.createAccount'));
            expect(textValues).toContain(t('welcome.signUpWithProvider', { provider: 'GitHub' }));
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
