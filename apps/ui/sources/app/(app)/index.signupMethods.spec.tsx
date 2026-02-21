import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { createWelcomeFeaturesResponse } from './index.testHelpers';
import type { ServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));
vi.mock('react-native-typography', () => ({ iOSUIKit: { title3: {} } }));
vi.mock('@/components/navigation/shell/HomeHeader', () => ({ HomeHeaderNotAuth: () => null }));
vi.mock('@/components/navigation/shell/MainView', () => ({ MainView: () => null }));
vi.mock('@shopify/react-native-skia', () => ({}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: false,
        credentials: null,
        login: vi.fn(async () => {}),
        logout: vi.fn(async () => {}),
    }),
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => null,
    setPendingTerminalConnect: vi.fn(),
    clearPendingTerminalConnect: vi.fn(),
}));

const getReadyServerFeaturesMock = vi.fn(async () =>
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

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: getReadyServerFeaturesMock,
}));

const defaultWelcomeFeatures = createWelcomeFeaturesResponse({
    signupMethods: [
        { id: 'anonymous', enabled: false },
        { id: 'github', enabled: true },
    ],
    requiredProviders: ['github'],
    autoRedirectEnabled: false,
    autoRedirectProviderId: null,
    providerOffboardingIntervalSeconds: 600,
});

const getServerFeaturesSnapshotMock = vi.fn(async (_params?: unknown): Promise<ServerFeaturesSnapshot> => ({
    status: 'ready',
    features: defaultWelcomeFeatures,
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: getServerFeaturesSnapshotMock,
}));

describe('/ (welcome) signup methods', () => {
    beforeEach(() => {
        getReadyServerFeaturesMock.mockReset();
        getReadyServerFeaturesMock.mockResolvedValue(defaultWelcomeFeatures);
        getServerFeaturesSnapshotMock.mockReset();
        getServerFeaturesSnapshotMock.mockResolvedValue({ status: 'ready', features: defaultWelcomeFeatures });
    });

    it('shows Create account and provider option when both are enabled', async () => {
        vi.resetModules();
        const { t } = await import('@/text');
        const bothEnabled = createWelcomeFeaturesResponse({
            signupMethods: [
                { id: 'anonymous', enabled: true },
                { id: 'github', enabled: true },
            ],
            requiredProviders: [],
            autoRedirectEnabled: false,
            autoRedirectProviderId: null,
            providerOffboardingIntervalSeconds: 600,
        });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({ status: 'ready', features: bothEnabled });

        const { default: Screen } = await import('./index');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });
            if (!tree) {
                throw new Error('Expected welcome screen renderer');
            }

            let textValues: string[] = [];
            for (let turn = 0; turn < 10; turn += 1) {
                await act(async () => {});
                textValues = tree.root
                    .findAll((n) => typeof n.props?.children === 'string')
                    .map((n) => String(n.props.children));
                if (textValues.includes(t('welcome.createAccount')) && textValues.includes(t('welcome.signUpWithProvider', { provider: 'GitHub' }))) {
                    break;
                }
            }

            expect(textValues).toContain(t('welcome.createAccount'));
            expect(textValues).toContain(t('welcome.signUpWithProvider', { provider: 'GitHub' }));
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('hides Create account when anonymous signup is disabled and shows provider option', async () => {
        vi.resetModules();
        const { t } = await import('@/text');
        const { default: Screen } = await import('./index');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });
            if (!tree) {
                throw new Error('Expected welcome screen renderer');
            }

            let textValues: string[] = [];
            for (let turn = 0; turn < 10; turn += 1) {
                await act(async () => {});
                textValues = tree.root
                    .findAll((n) => typeof n.props?.children === 'string')
                    .map((n) => String(n.props.children));
                if (textValues.includes(t('welcome.signUpWithProvider', { provider: 'GitHub' }))) {
                    break;
                }
            }

            expect(textValues).not.toContain(t('welcome.createAccount'));
            expect(textValues).toContain(t('welcome.signUpWithProvider', { provider: 'GitHub' }));
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('shows a server unavailable notice and hides auth actions when the server cannot be reached', async () => {
        vi.resetModules();
        const { t } = await import('@/text');
        getReadyServerFeaturesMock.mockRejectedValueOnce(new Error('network'));
        getServerFeaturesSnapshotMock.mockClear();
        getServerFeaturesSnapshotMock.mockResolvedValue({ status: 'error', reason: 'network' });

        const { default: Screen } = await import('./index');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });
            if (!tree) throw new Error('Expected welcome screen renderer');

            for (let turn = 0; turn < 10; turn += 1) {
                await act(async () => {});
                const unavailableBlocks = tree.root.findAll((n) => n.props?.testID === 'welcome-server-unavailable');
                if (unavailableBlocks.length > 0) break;
            }

            expect(getServerFeaturesSnapshotMock).toHaveBeenCalled();

            const unavailableBlocks = tree.root.findAll((n) => n.props?.testID === 'welcome-server-unavailable');
            expect(unavailableBlocks).toHaveLength(1);
            const unavailableTextValues = unavailableBlocks[0]!.findAll((n) => typeof n.props?.children === 'string')
                .map((n) => String(n.props.children));

            expect(unavailableTextValues).toContain(t('welcome.serverUnavailableTitle'));
            expect(tree.root.findAll((n) => n.props?.testID === 'welcome-restore')).toHaveLength(0);
            expect(tree.root.findAll((n) => n.props?.testID === 'welcome-signup-provider')).toHaveLength(0);
            expect(tree.root.findAll((n) => n.props?.testID === 'welcome-create-account')).toHaveLength(0);
            expect(tree.root.findAll((n) => n.props?.testID === 'welcome-retry-server' && n.props?.accessibilityRole === 'button')).toHaveLength(1);
            expect(tree.root.findAll((n) => n.props?.testID === 'welcome-configure-server' && n.props?.accessibilityRole === 'button')).toHaveLength(1);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('shows a server incompatible notice and hides auth actions when the server features response is invalid', async () => {
        vi.resetModules();
        const { t } = await import('@/text');
        getServerFeaturesSnapshotMock.mockClear();
        getServerFeaturesSnapshotMock.mockResolvedValue({ status: 'unsupported', reason: 'invalid_payload' });

        const { default: Screen } = await import('./index');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });
            if (!tree) throw new Error('Expected welcome screen renderer');

            for (let turn = 0; turn < 10; turn += 1) {
                await act(async () => {});
                const blocks = tree.root.findAll((n) => n.props?.testID === 'welcome-server-unavailable');
                if (blocks.length > 0) break;
            }

            expect(getServerFeaturesSnapshotMock).toHaveBeenCalled();

            const blocks = tree.root.findAll((n) => n.props?.testID === 'welcome-server-unavailable');
            expect(blocks).toHaveLength(1);
            const textValues = blocks[0]!.findAll((n) => typeof n.props?.children === 'string')
                .map((n) => String(n.props.children));

            expect(textValues).toContain(t('welcome.serverIncompatibleTitle'));
            expect(tree.root.findAll((n) => n.props?.testID === 'welcome-restore')).toHaveLength(0);
            expect(tree.root.findAll((n) => n.props?.testID === 'welcome-signup-provider')).toHaveLength(0);
            expect(tree.root.findAll((n) => n.props?.testID === 'welcome-create-account')).toHaveLength(0);
            expect(tree.root.findAll((n) => n.props?.testID === 'welcome-retry-server' && n.props?.accessibilityRole === 'button')).toHaveLength(1);
            expect(tree.root.findAll((n) => n.props?.testID === 'welcome-configure-server' && n.props?.accessibilityRole === 'button')).toHaveLength(1);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
