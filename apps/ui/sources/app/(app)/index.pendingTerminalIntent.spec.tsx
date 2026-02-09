import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { t } from '@/text';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

vi.mock('@/sync/api/capabilities/apiFeatures', async () => {
    const actual = await vi.importActual<any>('@/sync/api/capabilities/apiFeatures');
    return {
        ...actual,
        getServerFeatures: async () => ({
            features: {
                sharing: { session: { enabled: true }, public: { enabled: true }, contentKeys: { enabled: true }, pendingQueueV2: { enabled: true } },
                voice: { enabled: false, configured: false, provider: null },
                social: { friends: { enabled: false, allowUsername: false, requiredIdentityProviderId: null } },
                oauth: { providers: { github: { enabled: true, configured: true } } },
                auth: {
                    signup: { methods: [{ id: 'anonymous', enabled: true }] },
                    login: { requiredProviders: ['github'] },
                    providers: {
                        github: {
                            enabled: true,
                            configured: true,
                            restrictions: { usersAllowlist: false, orgsAllowlist: false, orgMatch: 'any' },
                            offboarding: { enabled: false, intervalSeconds: 600, mode: 'per-request-cache', source: 'github_app' },
                        },
                    },
                    misconfig: [],
                },
            },
        }),
    };
});

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => ({ publicKeyB64Url: 'abc123', serverUrl: 'https://company.example.test' }),
    setPendingTerminalConnect: vi.fn(),
    clearPendingTerminalConnect: vi.fn(),
}));

describe('/ (welcome) terminal connect intent notice', () => {
    it('shows terminal connect guidance when auth was initiated from a terminal link', async () => {
        vi.resetModules();
        const { default: Screen } = await import('./index');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });
        await act(async () => {});

        const textValues = tree!.root
            .findAll((n) => typeof n.props?.children === 'string')
            .map((n) => String(n.props.children));

        expect(textValues).toContain(t('terminal.connectTerminal'));
        expect(textValues).toContain(t('modals.pleaseSignInFirst'));

        act(() => {
            tree?.unmount();
        });
    });
});

