import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionListState = vi.hoisted(() => ({
    data: [] as any[] | null,
}));

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        Platform: {
            ...(actual.Platform ?? {}),
            OS: 'ios',
        },
        View: 'View',
        Text: 'Text',
        Pressable: 'Pressable',
        ActivityIndicator: 'ActivityIndicator',
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                groupped: { background: '#fff' },
                header: { tint: '#111' },
                text: '#111',
                textSecondary: '#777',
                status: { connected: '#0f0', connecting: '#ff0', disconnected: '#f00', error: '#f00', default: '#777' },
                surface: '#fff',
                button: { primary: { background: '#0a84ff', tint: '#fff' } },
                fab: { background: '#0a84ff' },
            },
        },
    }),
    StyleSheet: {
        create: (factory: any) =>
            factory({
                colors: {
                    groupped: { background: '#fff' },
                    header: { tint: '#111' },
                    text: '#111',
                    textSecondary: '#777',
                    status: { connected: '#0f0', connecting: '#ff0', disconnected: '#f00', error: '#f00', default: '#777' },
                    surface: '#fff',
                    button: { primary: { background: '#0a84ff', tint: '#fff' } },
                    fab: { background: '#0a84ff' },
                },
            }),
    },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: async () => {} }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useFriendRequests: () => [],
    useSocketStatus: () => ({ status: 'connected' }),
    useRealtimeStatus: () => ({ status: 'idle' }),
}));

vi.mock('@/hooks/session/useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: () => sessionListState.data,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => true,
}));

vi.mock('@/hooks/server/useFriendsEnabled', () => ({
    useFriendsEnabled: () => true,
}));

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({ ready: true }),
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: true }),
}));

vi.mock('@/hooks/ui/useTabState', () => ({
    useTabState: () => ({
        activeTab: 'sessions',
        setActiveTab: async () => {},
        isLoading: false,
    }),
}));

vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: 'SessionGettingStartedGuidance',
}));

vi.mock('@/components/sessions/shell/SessionsList', () => ({
    SessionsList: 'SessionsList',
}));

vi.mock('@/components/ui/buttons/FABWide', () => ({
    FABWide: 'FABWide',
}));

vi.mock('@/components/ui/navigation/TabBar', () => ({
    TabBar: 'TabBar',
}));

vi.mock('@/components/navigation/shell/InboxView', () => ({
    InboxView: 'InboxView',
}));

vi.mock('@/components/settings/shell/SettingsViewWrapper', () => ({
    SettingsViewWrapper: 'SettingsViewWrapper',
}));

vi.mock('@/components/sessions/shell/SessionsListWrapper', () => ({
    SessionsListWrapper: 'SessionsListWrapper',
}));

vi.mock('@/components/navigation/Header', () => ({
    Header: 'Header',
}));

vi.mock('@/components/ui/navigation/HeaderLogo', () => ({
    HeaderLogo: 'HeaderLogo',
}));

vi.mock('@/components/voice/surface/VoiceSurface', () => ({
    VoiceSurface: 'VoiceSurface',
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    isUsingCustomServer: () => false,
}));

vi.mock('@/track', () => ({
    trackFriendsSearch: () => {},
}));

vi.mock('@/components/navigation/ConnectionStatusControl', () => ({
    ConnectionStatusControl: 'ConnectionStatusControl',
}));

describe('MainView (tablet primary pane)', () => {
    beforeEach(() => {
        sessionListState.data = [];
    });

    it('shows getting started guidance instead of a blank view', async () => {
        const { MainView } = await import('./MainView');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<MainView variant="phone" />);
        });

        expect(() => tree!.root.findByType('SessionGettingStartedGuidance')).not.toThrow();
    });
});
