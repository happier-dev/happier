import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useProfileSpy = vi.hoisted(() => vi.fn(() => ({ id: 'u1' })));
const useSessionSpy = vi.hoisted(() => vi.fn(() => null));
const useSessionListRenderableWithServerScopeSpy = vi.hoisted(() => vi.fn(() => null));
let hasUnreadMessagesValue = false;
let platformOs: 'ios' | 'android' | 'web' = 'web';
let workingIndicatorStyle: 'spinner' | 'pulse' = 'spinner';

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
            useSetting: (key: string) => key === 'sessionListNarrowWorkingIndicatorStyle' ? workingIndicatorStyle : undefined,
        });
    },
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: (props: any) => React.createElement('Avatar', props),
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

function createSession(id: string) {
    return createSessionFixture({
        id,
        active: true,
        activeAt: 1,
        createdAt: 1,
        updatedAt: 1,
        metadata: null,
        presence: 'online',
    });
}

describe('SessionItem activity time', () => {
    beforeEach(() => {
        hasUnreadMessagesValue = false;
        workingIndicatorStyle = 'spinner';
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
