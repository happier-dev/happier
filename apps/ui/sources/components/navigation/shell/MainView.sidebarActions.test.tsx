import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());
const setSessionsListStorageTabSpy = vi.hoisted(() => vi.fn());

const sessionListState = vi.hoisted(() => ({
    data: [] as any[] | null,
}));

const directSessionsFeatureState = vi.hoisted(() => ({
    enabled: false,
}));

const localSettingsState = vi.hoisted(() => ({
    sessionsListStorageTab: 'persisted' as 'persisted' | 'direct',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
    usePathname: () => '/',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();

    return {
        ...actual,
    useFriendRequests: () => [],
    useSocketStatus: () => ({ status: 'connected' }),
    useRealtimeStatus: () => ({ status: 'idle' }),
    useLocalSettingMutable: (name: string) => {
        if (name === 'sessionsListStorageTab') {
            return [localSettingsState.sessionsListStorageTab, setSessionsListStorageTabSpy] as const;
        }
        throw new Error(`Unexpected local setting: ${name}`);
    },
    };
});

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

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string) => (
        featureId === 'sessions.direct'
            ? {
                state: directSessionsFeatureState.enabled ? 'enabled' : 'disabled',
                blockerCode: directSessionsFeatureState.enabled ? 'none' : 'feature_disabled',
                blockedBy: directSessionsFeatureState.enabled ? null : 'local_policy',
                diagnostics: [],
                evaluatedAt: 0,
                featureId: 'sessions.direct',
                scope: { scopeKind: 'main_selection' },
            }
            : null
    ),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
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

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
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

function findPressableByLabel(tree: renderer.ReactTestRenderer, label: string) {
    return tree.root.find((node) => (node.type as unknown) === 'Pressable' && node.props.accessibilityLabel === label);
}

describe('MainView sidebar actions', () => {
    let MainView: React.ComponentType<{ variant: 'phone' | 'sidebar' }>;

    beforeEach(() => {
        routerPushSpy.mockReset();
        setSessionsListStorageTabSpy.mockReset();
        sessionListState.data = [];
        directSessionsFeatureState.enabled = false;
        localSettingsState.sessionsListStorageTab = 'persisted';
    });

    beforeAll(async () => {
        MainView = (await import('./MainView')).MainView;
    }, 30_000);

    it('does not render sidebar action buttons (automations and new session)', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<MainView variant="sidebar" />);
        });

        expect(() => findPressableByLabel(tree!, 'New session')).toThrow();
        expect(() => findPressableByLabel(tree!, 'Open automations')).toThrow();
    });

    it('does not duplicate getting started guidance when primary pane is visible (home route)', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<MainView variant="sidebar" />);
        });

        expect(() => tree!.root.findByType('SessionGettingStartedGuidance')).toThrow();
    });

    it('renders direct session storage tabs in the sidebar empty state when direct sessions are enabled', async () => {
        directSessionsFeatureState.enabled = true;
        localSettingsState.sessionsListStorageTab = 'direct';

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<MainView variant="sidebar" />);
        });

        expect(() => tree!.root.findByProps({ testID: 'sessions-list-storage-tab:direct' })).not.toThrow();
    });

    it('renders the browse direct sessions action in the sidebar empty state when the direct tab is active', async () => {
        directSessionsFeatureState.enabled = true;
        localSettingsState.sessionsListStorageTab = 'direct';

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<MainView variant="sidebar" />);
        });

        expect(() => tree!.root.findByProps({ testID: 'direct-sessions-browse-button' })).not.toThrow();
    });
});
