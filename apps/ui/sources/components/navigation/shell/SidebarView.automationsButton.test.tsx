import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());

const automationsSupportState = vi.hoisted(() => ({
    enabled: true,
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
        confirm: vi.fn(),
        prompt: vi.fn(),
    },
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
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        useWindowDimensions: () => ({ width: 1200, height: 800 }),
    };
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                header: { tint: '#111' },
                groupped: { background: '#fff' },
                divider: '#ddd',
                surface: '#fff',
                shadow: { color: '#000' },
                text: '#111',
                textSecondary: '#777',
                fab: { background: '#000' },
                status: { error: '#f00' },
            },
        },
    }),
    StyleSheet: {
        create: (input: any) => {
            const theme = {
                colors: {
                    header: { tint: '#111' },
                    groupped: { background: '#fff' },
                    divider: '#ddd',
                    surface: '#fff',
                    shadow: { color: '#000' },
                    text: '#111',
                    textSecondary: '#777',
                    fab: { background: '#000' },
                    status: { error: '#f00' },
                },
            };
            return typeof input === 'function' ? input(theme, {}) : input;
        },
        hairlineWidth: 1,
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 56,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSocketStatus: () => ({ status: 'connected', lastError: null }),
    useFriendRequests: () => [],
    useSetting: () => false,
    useSyncError: () => null,
    useRealtimeStatus: () => 'disconnected',
}));

vi.mock('@/hooks/inbox/useInboxHasContent', () => ({
    useInboxHasContent: () => false,
}));

vi.mock('@/hooks/server/useFriendsEnabled', () => ({
    useFriendsEnabled: () => true,
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: automationsSupportState.enabled }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/runtime/appVariant', () => ({
    resolveVisibleAppEnvironmentBadge: () => null,
}));

vi.mock('@/config', () => ({
    config: { variant: 'prod' },
}));

vi.mock('@/sync/domains/server/serverContext', () => ({
    isStackContext: () => false,
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    isUsingCustomServer: () => false,
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/components/ui/buttons/FABWide', () => ({
    FABWide: (props: any) => React.createElement('FABWide', props),
}));

vi.mock('@/components/voice/surface/VoiceSurface', () => ({
    VoiceSurface: 'VoiceSurface',
}));

vi.mock('@/components/ui/popover', () => ({
    PopoverBoundaryProvider: ({ children }: any) => React.createElement('PopoverBoundaryProvider', null, children),
}));

vi.mock('@/components/navigation/ConnectionStatusControl', () => ({
    ConnectionStatusControl: 'ConnectionStatusControl',
}));

vi.mock('./MainView', () => ({
    MainView: 'MainView',
}));

function findPressableByLabel(tree: renderer.ReactTestRenderer, label: string) {
    return tree.root.find((node) => (node.type as unknown) === 'Pressable' && node.props.accessibilityLabel === label);
}

describe('SidebarView header automations button', () => {
    beforeEach(() => {
        routerPushSpy.mockReset();
        automationsSupportState.enabled = true;
    });

    it('shows automations button next to logo and navigates to automations', async () => {
        const { SidebarView } = await import('./SidebarView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SidebarView />);
        });

        const button = findPressableByLabel(tree!, 'Open automations');
        await act(async () => {
            button.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/automations');
    });

    it('does not render the wide FAB button in the sidebar', async () => {
        const { SidebarView } = await import('./SidebarView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SidebarView />);
        });

        expect(tree!.root.findAllByType('FABWide')).toHaveLength(0);
    });

    it('always includes VoiceSurface even when realtime is disconnected', async () => {
        const { SidebarView } = await import('./SidebarView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SidebarView />);
        });

        expect(tree!.root.findAllByType('VoiceSurface')).toHaveLength(1);
    });
});
