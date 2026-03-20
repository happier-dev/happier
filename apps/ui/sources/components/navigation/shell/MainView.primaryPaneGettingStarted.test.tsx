import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionListState = vi.hoisted(() => ({
    data: [] as any[] | null,
}));

const buildPolicyState = vi.hoisted(() => ({
    decision: 'neutral' as 'allow' | 'deny' | 'neutral',
}));

const setSessionsListStorageTabSpy = vi.hoisted(() => vi.fn());

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

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: async () => {} }),
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
            return ['persisted', setSessionsListStorageTabSpy] as const;
        }
        throw new Error(`Unexpected local setting: ${name}`);
    },
    useSetting: (key: string) => {
        if (key === 'serverSelectionGroups') return [];
        if (key === 'serverSelectionActiveTargetKind') return 'main_selection';
        if (key === 'serverSelectionActiveTargetId') return '';
        return null;
    },
    useSettings: () => ({}),
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

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({
        state: 'disabled',
        blockerCode: 'feature_disabled',
        blockedBy: 'local_policy',
        diagnostics: [],
        evaluatedAt: 0,
        featureId: 'sessions.direct',
        scope: { scopeKind: 'main_selection' },
    }),
}));

vi.mock('@/hooks/ui/useTabState', () => ({
    useTabState: () => ({
        activeTab: 'sessions',
        setActiveTab: async () => {},
        isLoading: false,
    }),
}));

vi.mock('@/sync/domains/features/featureBuildPolicy', () => ({
    getFeatureBuildPolicyDecision: () => buildPolicyState.decision,
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
        buildPolicyState.decision = 'neutral';
        setSessionsListStorageTabSpy.mockReset();
    });

    it('shows getting started guidance instead of a blank view', async () => {
        const { MainView } = await import('./MainView');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<MainView variant="phone" />);
        });

        expect(() => tree!.root.findByType('SessionGettingStartedGuidance')).not.toThrow();
    });

    it('shows a fallback view when getting started guidance is denied by build policy', async () => {
        buildPolicyState.decision = 'deny';
        const { MainView } = await import('./MainView');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<MainView variant="phone" />);
        });

        expect(() => tree!.root.findByProps({ testID: 'mainview-tablet-primary-pane-fallback' })).not.toThrow();
    });
});
