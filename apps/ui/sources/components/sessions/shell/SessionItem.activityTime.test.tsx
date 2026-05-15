import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { lightTheme } from '@/theme';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useProfileSpy = vi.hoisted(() => vi.fn(() => ({ id: 'u1' })));
const useSessionSpy = vi.hoisted(() => vi.fn(() => null));
const useSessionListRenderableWithServerScopeSpy = vi.hoisted(() => vi.fn(() => null));
let hasUnreadMessagesValue = false;
let platformOs: 'ios' | 'android' | 'web' = 'web';
let workingIndicatorStyle: 'spinner' | 'pulse' = 'spinner';
let sessionListIdentityDisplay: 'avatar' | 'agentLogo' | 'none' = 'avatar';
let sessionListActiveColorMode: 'activityAndAttention' | 'attentionOnly' | 'allActive' = 'activityAndAttention';

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: 'TextInput',
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformOs;
                },
                select: (value: any) => value[platformOs] ?? value.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                prompt: vi.fn(),
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useHasUnreadMessages: () => hasUnreadMessagesValue,
            useProfile: useProfileSpy,
            useSession: useSessionSpy,
            useSessionListRenderableWithServerScope: useSessionListRenderableWithServerScopeSpy,
            useSessionListActivityTimeLabel: () => '1m',
            useSessionListMeaningfulActivityAt: () => 60_000,
            useSetting: (key: string) => {
                if (key === 'sessionListNarrowWorkingIndicatorStyle') return workingIndicatorStyle;
                if (key === 'sessionListIdentityDisplay') return sessionListIdentityDisplay;
                if (key === 'sessionListActiveColorModeV1') return sessionListActiveColorMode;
                return undefined;
            },
        });
    },
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: (props: any) => React.createElement('Avatar', props),
}));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: any) => React.createElement('AgentIcon', props),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: (flavor: string | null | undefined) => flavor === 'claude' ? 'claude' : null,
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/components/sessions/pendingBadge', () => ({
    formatPendingCountBadge: () => null,
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (_fn: unknown) => [false, vi.fn()],
}));

vi.mock('@/utils/errors/errors', () => ({
    HappyError: class HappyError extends Error {},
}));

vi.mock('@/utils/time/formatShortRelativeTime', () => ({
    formatShortRelativeTime: () => '1m',
}));

vi.mock('@/sync/ops', () => ({
    sessionStopWithServerScope: vi.fn(async () => ({ success: true })),
    sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
    sessionRename: vi.fn(async () => ({ success: true })),
}));

vi.mock('./sessionPinIcons', () => ({
    PinIcon: (props: Record<string, unknown>) => React.createElement('PinIcon', props),
    PinSlashIcon: (props: Record<string, unknown>) => React.createElement('PinSlashIcon', props),
}));

vi.mock('./sessionTagIcons', () => ({
    TagIcon: (props: Record<string, unknown>) => React.createElement('TagIcon', props),
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    getSessionAvatarId: () => 'avatar',
    getSessionStatus: () => mockSessionStatus,
    useSessionStatus: () => mockSessionStatus,
}));

type MockSessionStatus = Readonly<{
    state: 'thinking' | 'waiting';
    isConnected: boolean;
    statusText: string;
    shouldShowStatus: boolean;
    statusColor: string;
    statusDotColor: string;
    isPulsing: boolean;
}>;

const defaultSessionStatus: MockSessionStatus = {
    state: 'thinking',
    isConnected: true,
    statusText: 'Working on it',
    shouldShowStatus: true,
    statusColor: '#07f',
    statusDotColor: '#0f0',
    isPulsing: false,
};

let mockSessionStatus: MockSessionStatus = {
    ...defaultSessionStatus,
};

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    if (!style || typeof style !== 'object') {
        return {};
    }
    return style as Record<string, unknown>;
}

function createSession(
    id: string,
    metadata: ReturnType<typeof createSessionFixture>['metadata'] = null,
) {
    return createSessionFixture({
        id,
        active: true,
        activeAt: 1,
        createdAt: 1,
        updatedAt: 1,
        metadata,
        presence: 'online',
    });
}

function findRowContentStyle(screen: Awaited<ReturnType<typeof renderScreen>>, sessionId: string): Record<string, unknown> {
    const row = screen.findByTestId(`session-list-item-${sessionId}`);
    const children = row?.children ?? [];
    const content = children.find((child: unknown) => {
        if (!child || typeof child !== 'object' || !('props' in child)) return false;
        const style = flattenStyle((child as { props: { style?: unknown } }).props.style);
        return style.flex === 1;
    }) as { props: { style?: unknown } } | undefined;
    return flattenStyle(content?.props.style);
}

function findSessionTitleText(screen: Awaited<ReturnType<typeof renderScreen>>, title: string) {
    return screen.findAllByType('Text').find((node) => node.props.children === title);
}

function styleEntries(style: unknown): unknown[] {
    return Array.isArray(style) ? style : [style];
}

describe('SessionItem activity time', () => {
    beforeEach(() => {
        hasUnreadMessagesValue = false;
        workingIndicatorStyle = 'spinner';
        sessionListIdentityDisplay = 'avatar';
        sessionListActiveColorMode = 'activityAndAttention';
        platformOs = 'web';
        mockSessionStatus = {
            ...defaultSessionStatus,
        };
        useProfileSpy.mockClear();
        useSessionSpy.mockClear();
        useSessionListRenderableWithServerScopeSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders the meaningful activity timestamp instead of the raw session updatedAt', async () => {
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_1')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        expect(screen.findByTestId('session-list-item-sess_1')).toBeTruthy();
        expect(screen.getTextContent()).toContain('1m');
    });

    it('passes a stable unread indicator test id to the avatar when the row has unread activity', async () => {
        hasUnreadMessagesValue = true;

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_unread')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        expect(screen.findByType('Avatar' as any)?.props.unreadBadgeTestID).toBe('session-list-item-unread-indicator-sess_unread');
    });

    it('renders inactive sessions with a monochrome avatar even when the daemon still reports connected', async () => {
        mockSessionStatus = {
            ...defaultSessionStatus,
            isConnected: true,
        };

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSessionFixture({
                    id: 'sess_inactive_connected',
                    active: false,
                    activeAt: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    metadata: null,
                    presence: 'online',
                })}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        expect(screen.findByType('Avatar' as any)?.props.monochrome).toBe(true);
    });

    it('uses readable title metrics in very compact rows', async () => {
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_title')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        const rowStyle = flattenStyle(screen.findByTestId('session-list-item-sess_compact_title')?.props.style);
        expect(rowStyle.height).toBe(42);

        const title = screen.findAllByType('Text').find((node) => node.props.children === 'Session');
        const titleStyle = flattenStyle(title?.props.style);
        expect(titleStyle.fontSize).toBe(14);
        expect(titleStyle.lineHeight).toBe(18);
    });

    it('renders an 18px micro avatar in very compact web rows with title spacing', async () => {
        platformOs = 'web';
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_avatar_web')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.findByType('Avatar' as any)?.props).toMatchObject({
            id: 'avatar',
            size: 18,
        });
        expect(findRowContentStyle(screen, 'sess_compact_avatar_web').marginLeft).toBe(8);
    });

    it('uses a 20px micro avatar for very compact native phone rows', async () => {
        platformOs = 'ios';
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_avatar_phone')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.findByType('Avatar' as any)?.props.size).toBe(20);
        expect(findRowContentStyle(screen, 'sess_compact_avatar_phone').marginLeft).toBe(8);
    });

    it('renders the selected agent logo in the same narrow identity slot', async () => {
        sessionListIdentityDisplay = 'agentLogo';
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_agent_logo_narrow', { flavor: 'claude' } as any)}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.findAllByType('Avatar' as any)).toHaveLength(0);
        expect(screen.findByType('AgentIcon' as any)?.props).toMatchObject({
            agentId: 'claude',
            size: 14,
            testID: 'session-list-agent-logo-sess_agent_logo_narrow',
        });
        expect(findRowContentStyle(screen, 'sess_agent_logo_narrow').marginLeft).toBe(8);
    });

    it('passes the resolved title color to agent logos for active rows without attention', async () => {
        sessionListIdentityDisplay = 'agentLogo';
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_agent_logo_idle', { flavor: 'claude' } as any)}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        const titleStyle = flattenStyle(findSessionTitleText(screen, 'Session')?.props.style);
        const titleStyleEntries = styleEntries(findSessionTitleText(screen, 'Session')?.props.style);
        const explicitTitleColorStyle = titleStyleEntries[titleStyleEntries.length - 1] as { color?: unknown } | undefined;
        expect(titleStyle.color).toBe(lightTheme.colors.text.secondary);
        expect(explicitTitleColorStyle).toMatchObject({ color: titleStyle.color });
        expect(screen.findByType('AgentIcon' as any)?.props.color).toBe(explicitTitleColorStyle?.color);
    });

    it('can use the active title color for all active connected session rows', async () => {
        sessionListIdentityDisplay = 'agentLogo';
        sessionListActiveColorMode = 'allActive';
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_agent_logo_all_active', { flavor: 'claude' } as any)}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        const titleStyle = flattenStyle(findSessionTitleText(screen, 'Session')?.props.style);
        expect(titleStyle.color).toBe(lightTheme.colors.text.primary);
        expect(screen.findByType('AgentIcon' as any)?.props.color).toBe(titleStyle.color);
    });

    it('can keep working rows secondary when only attention rows use active color', async () => {
        sessionListIdentityDisplay = 'agentLogo';
        sessionListActiveColorMode = 'attentionOnly';
        mockSessionStatus = {
            state: 'thinking',
            isConnected: true,
            statusText: 'Working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        };
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_agent_logo_attention_only', { flavor: 'claude' } as any)}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        const titleStyle = flattenStyle(findSessionTitleText(screen, 'Session')?.props.style);
        expect(titleStyle.color).toBe(lightTheme.colors.text.secondary);
        expect(screen.findByType('AgentIcon' as any)?.props.color).toBe(titleStyle.color);
    });

    it('hides the session list identity slot across row densities when identity display is none', async () => {
        sessionListIdentityDisplay = 'none';
        const { SessionItem } = await import('./SessionItem');

        const detailed = await renderScreen(
            <SessionItem
                session={createSession('sess_identity_none_detailed')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );
        expect(detailed.findAllByType('Avatar' as any)).toHaveLength(0);
        expect(detailed.findAllByType('AgentIcon' as any)).toHaveLength(0);

        standardCleanup();

        const narrow = await renderScreen(
            <SessionItem
                session={createSession('sess_identity_none_narrow')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );
        expect(narrow.findAllByType('Avatar' as any)).toHaveLength(0);
        expect(narrow.findAllByType('AgentIcon' as any)).toHaveLength(0);
        expect(findRowContentStyle(narrow, 'sess_identity_none_narrow').marginLeft).toBe(0);
    });

    it('replaces trailing time with a spinner in very compact mode when the session is working', async () => {
        mockSessionStatus = {
            state: 'thinking',
            isConnected: true,
            statusText: 'Working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        };

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_active')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        const spinner = screen.findByTestId('session-item-trailing-working-spinner-sess_compact_active');
        expect(spinner).toBeTruthy();
        expect(flattenStyle(spinner?.props.style)).toMatchObject({
            width: 12,
            height: 12,
        });
        expect(screen.findAllByType('StatusDot')).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain('Working on it');
        expect(screen.getTextContent()).not.toContain('1m');
    });

    it('renders session status with the configured spinner and text', async () => {
        mockSessionStatus = {
            state: 'thinking',
            isConnected: true,
            statusText: 'Working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        };

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_status_plain')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                secondaryLineMode="status"
            />,
        );
        expect(screen.findByTestId('session-list-status-pill-sess_status_plain')).toBeNull();
        const spinner = screen.findByTestId('session-list-status-working-spinner-sess_status_plain');
        expect(spinner).toBeTruthy();
        expect(flattenStyle(spinner?.props.style)).toMatchObject({
            width: 12,
            height: 12,
        });
        expect(screen.findAllByType('StatusDot')).toHaveLength(0);
        const statusText = screen.findAllByType('Text').find((node) => node.props.children === 'Working on it');
        const flat = flattenStyle(statusText?.props.style);
        expect(flat.color).toBe('#07f');
        expect(flat.fontSize).toBe(12);
        expect(flat.lineHeight).toBe(16);
    });

    it('renders session status with the configured pulsing dot and text', async () => {
        workingIndicatorStyle = 'pulse';
        mockSessionStatus = {
            state: 'thinking',
            isConnected: true,
            statusText: 'Working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        };

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_status_plain_dot')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                secondaryLineMode="status"
            />,
        );

        const dots = screen.findAllByType('StatusDot');
        expect(dots).toHaveLength(1);
        expect(dots[0]?.props.color).toBe('#0f0');
        expect(dots[0]?.props.isPulsing).toBe(true);
        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(0);
    });

    it('does not render a subtitle in very compact mode for quiet online sessions', async () => {
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_quiet')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={true}
            />,
        );

        expect(screen.getTextContent()).not.toContain('online');
        expect(screen.findAllByType('StatusDot')).toHaveLength(0);
        expect(screen.getTextContent()).toContain('1m');
    });

    it('keeps the selected row background when a session is selected', async () => {
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };

        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_selected')}
                serverId="server_a"
                pinned={false}
                selected={true}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        expect(screen.findByTestId('session-list-item-sess_selected')?.props.accessibilityState).toMatchObject({
            selected: true,
        });
    });

    it('uses the row-specific renderable selector and currentUserId prop without subscribing to profile or full session state', async () => {
        const { SessionItem } = await import('./SessionItem');

        await renderScreen(
            <SessionItem
                session={createSession('sess_row_state')}
                currentUserId="u1"
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        expect(useSessionListRenderableWithServerScopeSpy).toHaveBeenCalledWith('server_a', 'sess_row_state');
        expect(useSessionSpy).not.toHaveBeenCalled();
        expect(useProfileSpy).not.toHaveBeenCalled();
    });

    it('uses start-side overflow ellipsis for path subtitles on web without reordering the path', async () => {
        platformOs = 'web';
        const { SessionItem } = await import('./SessionItem');
        const sessionPath = '~/Documents/Development/happier/dev';

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_path_web')}
                subtitleOverride={sessionPath}
                secondaryLineMode="path"
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        const outerSubtitle = screen.root.findAll((node) => {
            const style = flattenStyle(node.props?.style);
            return String(node.type) === 'Text'
                && node.props.numberOfLines === 1
                && style.writingDirection === 'rtl';
        })[0];
        const innerSubtitle = screen.root.findAll((node) =>
            String(node.type) === 'Text'
            && node.props.children === sessionPath,
        )[0];

        expect(screen.getTextContent()).toContain(sessionPath);
        expect(outerSubtitle).toBeTruthy();
        expect(innerSubtitle).toBeTruthy();
        expect(flattenStyle(outerSubtitle?.props.style)).toMatchObject({
            writingDirection: 'rtl',
            textAlign: 'left',
        });
        expect(flattenStyle(innerSubtitle?.props.style)).toMatchObject({
            writingDirection: 'ltr',
            unicodeBidi: 'isolate',
        });
    });

    it('uses native head ellipsis for path subtitles outside web', async () => {
        platformOs = 'ios';
        const { SessionItem } = await import('./SessionItem');
        const sessionPath = '~/Documents/Development/happier/dev';

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_path_native')}
                subtitleOverride={sessionPath}
                secondaryLineMode="path"
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        const subtitle = screen.root.findAll((node) =>
            String(node.type) === 'Text'
            && node.props.children === sessionPath
            && node.props.numberOfLines === 1,
        )[0];

        expect(subtitle?.props.ellipsizeMode).toBe('head');
    });
});
