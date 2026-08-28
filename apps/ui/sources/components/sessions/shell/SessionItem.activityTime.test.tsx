import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    TREE_DROP_OVERLAY_KIND_NONE,
    type TreeDropOverlaySharedValues,
} from '@/components/ui/treeDragDrop/ui/treeDropOverlayTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionStatus } from '@/utils/sessions/sessionUtils';
import { lightTheme } from '@/theme';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import {
    createModelBackedSessionItemTestComponent,
    createSessionItemRowViewModel,
} from './sessionItemRowViewModelTestFixture';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useProfileSpy = vi.hoisted(() => vi.fn(() => ({ id: 'u1' })));
const useSessionSpy = vi.hoisted(() => vi.fn(() => null));
const useSessionListRenderableWithServerScopeSpy = vi.hoisted(() =>
    vi.fn<(serverId: string, sessionId: string) => SessionListRenderableSession | null>(() => null),
);
const formatShortRelativeTimeSpy = vi.hoisted(() => vi.fn((_timestamp: number) => '1m'));
let hasUnreadMessagesValue = false;
let platformOs: 'ios' | 'android' | 'web' = 'web';
let workingIndicatorStyle: 'spinner' | 'pulse' = 'spinner';
let sessionListIdentityDisplay: 'avatar' | 'agentLogo' | 'none' = 'avatar';
let sessionListActiveColorMode: 'activityAndAttention' | 'attentionOnly' | 'allActive' = 'activityAndAttention';

vi.mock('react-native-reanimated', () => ({
    Easing: {
        bezier: () => 'bezier',
        linear: 'linear',
    },
    default: { View: 'Animated.View' },
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: (factory: () => unknown) => factory(),
    withSpring: (value: unknown) => value,
}));

vi.mock('react-native-gesture-handler', () => ({
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
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

vi.mock('@/components/sessions/presentation/SessionAgentCatalogIdentityIcon', () => ({
    SessionAgentCatalogIdentityIcon: (props: Record<string, unknown>) =>
        React.createElement('SessionAgentCatalogIdentityIcon', props),
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
    formatShortRelativeTime: formatShortRelativeTimeSpy,
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
    getSessionStatus: (session: { hasPendingPermissionRequests?: boolean; thinking?: boolean }) =>
        session.thinking === true
            ? {
                  state: 'thinking',
                  isConnected: true,
                  statusText: 'Working on it',
                  shouldShowStatus: true,
                  statusColor: '#07f',
                  statusDotColor: '#0f0',
                  isPulsing: true,
              }
            : session.hasPendingPermissionRequests === true
            ? {
                  state: 'permission_required',
                  isConnected: true,
                  statusText: 'status.permissionRequired',
                  shouldShowStatus: true,
                  statusColor: '#f90',
                  statusDotColor: '#f90',
                  isPulsing: true,
              }
            : mockSessionStatus,
    useSessionStatus: () => mockSessionStatus,
}));

type MockSessionStatus = SessionStatus;

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

function createTreeDropOverlaySharedValues(): TreeDropOverlaySharedValues {
    return {
        overlayVisible: { value: 0 },
        overlayKind: { value: TREE_DROP_OVERLAY_KIND_NONE },
        overlayTop: { value: 0 },
        overlayHeight: { value: 0 },
        overlayLeft: { value: 0 },
        overlayRight: { value: 0 },
        overlayDepth: { value: 0 },
    };
}

async function importSessionItem() {
    const { SessionItem } = await import('./SessionItem');
    return createModelBackedSessionItemTestComponent(SessionItem, {
        resolveRowViewModelOverrides: () => ({
            sessionStatus: mockSessionStatus,
            hasUnreadMessages: hasUnreadMessagesValue,
            activityTimeLabel: '1m',
            workingIndicatorMode: workingIndicatorStyle,
            identityDisplay: sessionListIdentityDisplay,
            activeColorMode: sessionListActiveColorMode,
        }),
    });
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
        formatShortRelativeTimeSpy.mockReset();
        formatShortRelativeTimeSpy.mockImplementation(() => '1m');
        useProfileSpy.mockClear();
        useSessionSpy.mockClear();
        useSessionListRenderableWithServerScopeSpy.mockReset();
        useSessionListRenderableWithServerScopeSpy.mockReturnValue(null);
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders the meaningful activity timestamp instead of the raw session updatedAt', async () => {
        const SessionItem = await importSessionItem();

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

    it('renders the row view model activity timestamp for date-grouped lists', async () => {
        const updatedAt = 1_700_000_000_000 - 3 * 60 * 60 * 1000;
        const meaningfulActivityAt = 1_700_000_000_000 - 5 * 60 * 60 * 1000;
        formatShortRelativeTimeSpy.mockImplementation((timestamp: number) => timestamp === meaningfulActivityAt ? '5h' : 'unexpected');
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={{
                    ...createSession('sess_updated_at'),
                    createdAt: 1_700_000_000_000 - 5 * 60 * 60 * 1000,
                    updatedAt,
                    meaningfulActivityAt,
                } as SessionListRenderableSession}
                rowViewModelOverrides={{
                    activityTimeLabel: '5h',
                }}
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

        expect(screen.getTextContent()).toContain('5h');
        expect(screen.getTextContent()).not.toContain('1m');
    });

    it('keeps unread state out of the avatar because row attention owns the indicator', async () => {
        hasUnreadMessagesValue = true;

        const SessionItem = await importSessionItem();

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

        expect(screen.findByType('Avatar' as any)?.props).toMatchObject({
            hasUnreadMessages: false,
        });
        expect(screen.findByType('Avatar' as any)?.props.unreadBadgeTestID).toBeUndefined();
    });

    it('renders a stable minimal unread attention indicator instead of an avatar badge', async () => {
        hasUnreadMessagesValue = true;
        mockSessionStatus = {
            ...defaultSessionStatus,
            state: 'waiting',
            statusText: 'online',
            shouldShowStatus: false,
            isPulsing: false,
        };
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_unread_minimal')}
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

        expect(screen.findByTestId('session-list-attention-indicator-sess_unread_minimal-trailing-unread')).toBeTruthy();
        expect(screen.findByType('Avatar' as any)?.props.hasUnreadMessages).toBe(false);
    });

    it('shows ready-for-review status text for non-minimal completed unread turns', async () => {
        hasUnreadMessagesValue = true;
        mockSessionStatus = {
            ...defaultSessionStatus,
            state: 'waiting',
            statusText: 'online',
            shouldShowStatus: false,
            isPulsing: false,
        };
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={{
                    ...createSession('sess_ready_for_review'),
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1_000,
                    meaningfulActivityAt: 1_000,
                    latestReadyEventSeq: 10,
                    lastViewedSessionSeq: 9,
                    seq: 10,
                } as SessionListRenderableSession}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                secondaryLineMode="path"
                compact={false}
            />,
        );

        expect(screen.getTextContent()).toContain('status.readyForReview');
        expect(screen.findByTestId('session-list-status-subtitle-sess_ready_for_review-ready')).toBeTruthy();
    });

    it('shows failed status text before stale working text when the primary turn failed', async () => {
        hasUnreadMessagesValue = true;
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={{
                    ...createSession('sess_failed_primary_turn'),
                    thinking: true,
                    thinkingAt: 1_000,
                    latestTurnStatus: 'failed',
                    latestTurnStatusObservedAt: 1_100,
                    seq: 11,
                } as SessionListRenderableSession}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                secondaryLineMode="status"
                compact={false}
            />,
        );

        expect(screen.getTextContent()).toContain('status.error');
        expect(screen.getTextContent()).not.toContain('Working on it');
        expect(screen.findByTestId('session-list-status-subtitle-sess_failed_primary_turn-failed')).toBeTruthy();
    });

    it.each([
        ['web', 'working', 'status.workingExternally', 'working'],
        ['ios', 'working', 'status.workingExternally', 'working'],
        ['web', 'waiting', 'status.needsInputExternally', 'action_required'],
        ['web', 'idle', 'status.ready', 'ready'],
        ['web', 'unknown', 'status.externalStatusUnknown', 'none'],
    ] as const)('renders pushed external %s %s status while hosted control stays offline', async (platform, state, labelKey, indicator) => {
        platformOs = platform;
        mockSessionStatus = {
            ...defaultSessionStatus,
            state: 'disconnected',
            isConnected: false,
            statusText: 'status.offline',
            shouldShowStatus: true,
            isPulsing: false,
        };
        const SessionItem = await importSessionItem();
        const session = createSession('sess_external_status', {
            host: 'MacBook Pro',
            externalSessionV1: {
                v: 1,
                agentId: 'codex',
                machineId: 'machine-a',
                remoteSessionId: 'native-session-1',
                source: {
                    kind: 'codexHome',
                    home: '/Users/test/.codex',
                },
            },
        } as any);

        const screen = await renderScreen(
            <SessionItem
                session={session}
                rowViewModelOverrides={{
                    externalSessionRuntime: {
                        controlConnectivity: 'offline',
                        detachedActivity: 'unknown',
                        externalAgent: {
                            state,
                            labelKey,
                            tone: state === 'working'
                                ? 'live'
                                : state === 'waiting'
                                    ? 'attention'
                                    : state === 'idle'
                                        ? 'ready'
                                        : 'muted',
                            indicator: indicator === 'action_required' ? 'action' : indicator,
                            nextExpiryAtMs: null,
                        },
                    } as any,
                    externalSessionIdentity: {
                        agentId: 'codex',
                        agentLabel: 'agentInput.agent.codex',
                        machineLabel: 'MacBook Pro',
                        storageLabel: 'sessionsList.storageExternalFilter',
                        identityLabel: 'agentInput.agent.codex · MacBook Pro',
                        rowMetadataLabel: 'sessionsList.storageExternalFilter · agentInput.agent.codex · MacBook Pro',
                    },
                }}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                secondaryLineMode="path"
                compact={false}
            />,
        );

        expect(screen.getTextContent()).toContain(labelKey);
        expect(screen.getTextContent()).toContain(
            `${labelKey} · sessionsList.storageExternalFilter · agentInput.agent.codex · MacBook Pro`,
        );
        expect(screen.getTextContent()).not.toContain(
            'agentInput.agent.codex · sessionsList.storageExternalFilter · agentInput.agent.codex',
        );
        if (indicator === 'none') {
            expect(screen.findByTestId('session-list-attention-indicator-sess_external_status-secondary-none')).toBeNull();
        } else {
            expect(screen.findByTestId(
                `session-list-attention-indicator-sess_external_status-secondary-${indicator}`,
            )).toBeTruthy();
            expect(screen.findByTestId(
                'session-row-attention-indicator-sess_external_status-secondary',
            )?.props.accessibilityLabel).toBe(labelKey);
        }
        expect(screen.findByType('Avatar' as any)?.props.monochrome).toBe(true);
    });

    it('renders inactive sessions with a monochrome avatar even when the daemon still reports connected', async () => {
        mockSessionStatus = {
            ...defaultSessionStatus,
            isConnected: true,
        };

        const SessionItem = await importSessionItem();

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

    it('uses a tighter fixed row height and readable title metrics in very compact web rows', async () => {
        platformOs = 'web';
        const SessionItem = await importSessionItem();

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
        expect(rowStyle.height).toBe(34);

        const title = screen.findAllByType('Text').find((node) => node.props.children === 'Session');
        const titleStyle = flattenStyle(title?.props.style);
        expect(titleStyle.fontSize).toBe(12);
        expect(titleStyle.lineHeight).toBe(16);
    });

    it('renders an 18px micro avatar in very compact web rows with title spacing', async () => {
        platformOs = 'web';
        const SessionItem = await importSessionItem();

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
        const SessionItem = await importSessionItem();

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
        const rowStyle = flattenStyle(screen.findByTestId('session-list-item-sess_compact_avatar_phone')?.props.style);
        expect(rowStyle.height).toBe(42);
        const title = screen.findAllByType('Text').find((node) => node.props.children === 'Session');
        const titleStyle = flattenStyle(title?.props.style);
        expect(titleStyle.fontSize).toBe(14);
        expect(titleStyle.lineHeight).toBe(18);
        expect(findRowContentStyle(screen, 'sess_compact_avatar_phone').marginLeft).toBe(8);
    });

    it('renders the selected agent logo in the same narrow identity slot', async () => {
        sessionListIdentityDisplay = 'agentLogo';
        const SessionItem = await importSessionItem();

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
        expect(screen.findByType('SessionAgentCatalogIdentityIcon' as any)?.props).toMatchObject({
            agentId: 'claude',
            size: 14,
            serverId: 'server_a',
            testID: 'session-list-agent-logo-sess_agent_logo_narrow',
        });
        expect(findRowContentStyle(screen, 'sess_agent_logo_narrow').marginLeft).toBe(8);
    });

    it('keeps an external Agent identity and its exact Session scope in agent-logo mode', async () => {
        sessionListIdentityDisplay = 'agentLogo';
        const SessionItem = await importSessionItem();
        const session = {
            ...createSession('sess_external_agent_logo'),
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                agentPresentation: { agentId: 'acme.plugin/ultracode' },
            },
            ownerMetadataView: { machineId: 'machine_external' },
        } as any;

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_external"
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

        expect(screen.findAllByType('AgentIcon' as any)).toHaveLength(0);
        expect(screen.findByType('SessionAgentCatalogIdentityIcon' as any)?.props).toMatchObject({
            agentId: 'acme.plugin/ultracode',
            machineId: 'machine_external',
            serverId: 'server_external',
            size: 14,
            testID: 'session-list-agent-logo-sess_external_agent_logo',
        });
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
        const SessionItem = await importSessionItem();

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
        expect(screen.findByType('SessionAgentCatalogIdentityIcon' as any)?.props.color).toBe(explicitTitleColorStyle?.color);
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
        const SessionItem = await importSessionItem();

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
        expect(screen.findByType('SessionAgentCatalogIdentityIcon' as any)?.props.color).toBe(titleStyle.color);
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
        const SessionItem = await importSessionItem();

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
        expect(screen.findByType('SessionAgentCatalogIdentityIcon' as any)?.props.color).toBe(titleStyle.color);
    });

    it('hides the session list identity slot across row densities when identity display is none', async () => {
        sessionListIdentityDisplay = 'none';
        const SessionItem = await importSessionItem();

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
        expect(detailed.findAllByType('SessionAgentCatalogIdentityIcon' as any)).toHaveLength(0);

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
        expect(narrow.findAllByType('SessionAgentCatalogIdentityIcon' as any)).toHaveLength(0);
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

        const SessionItem = await importSessionItem();

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
                rowAttentionAnimationEnabled={false}
            />,
        );

        const spinner = screen.findByTestId('session-row-attention-indicator-spinner-sess_compact_active-trailing');
        expect(spinner).toBeTruthy();
        const spinnerStyle = flattenStyle(spinner?.props.style);
        expect(spinnerStyle).toMatchObject({
            width: 12,
            height: 12,
        });
        expect(spinnerStyle.animationName).toBeUndefined();
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

        const SessionItem = await importSessionItem();

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
        const spinner = screen.findByTestId('session-row-attention-indicator-spinner-sess_status_plain-secondary');
        expect(spinner).toBeTruthy();
        expect(flattenStyle(spinner?.props.style)).toMatchObject({
            width: 12,
            height: 12,
        });
        expect(screen.findAllByType('StatusDot')).toHaveLength(0);
        const statusText = screen.findAllByType('Text').find((node) => node.props.children === 'Working on it');
        const flat = flattenStyle(statusText?.props.style);
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

        const SessionItem = await importSessionItem();

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
                rowAttentionAnimationEnabled={false}
            />,
        );

        const dots = screen.findAllByType('StatusDot');
        expect(dots).toHaveLength(1);
        expect(dots[0]?.props.testID).toBe('session-row-attention-indicator-dot-sess_status_plain_dot-secondary');
        expect(dots[0]?.props.isPulsing).toBe(true);
        expect(dots[0]?.props.animationEnabled).toBe(false);
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

        const SessionItem = await importSessionItem();

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

        const SessionItem = await importSessionItem();

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

    it('uses the row view model and currentUserId prop without subscribing to profile or full session state', async () => {
        const SessionItem = await importSessionItem();

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

        expect(useSessionListRenderableWithServerScopeSpy).not.toHaveBeenCalled();
        expect(useSessionSpy).not.toHaveBeenCalled();
        expect(useProfileSpy).not.toHaveBeenCalled();
    });

    it('renders from a row view model without subscribing to row renderables', async () => {
        const SessionItem = await importSessionItem();
        const rowSession = createSession('sess_model_backed');

        const screen = await renderScreen(
            <SessionItem
                session={createSession('stale_prop_session')}
                rowViewModel={{
                    groupKey: 'group:model',
                    sessionKey: 'server_a:sess_model_backed',
                    session: rowSession,
                    sessionStatus: {
                        state: 'waiting',
                        isConnected: true,
                        statusText: 'online',
                        shouldShowStatus: false,
                        statusColor: '#34C759',
                        statusDotColor: '#34C759',
                        isPulsing: false,
                    },
                    externalSessionRuntime: null,
                    externalSessionIdentity: null,
                    isIdentityLoading: false,
                    nextRuntimeFreshnessAtMs: null,
                    hasUnreadMessages: true,
                    activityTimeLabel: '7m',
                    workingIndicatorMode: 'pulse',
                    identityDisplay: 'avatar',
                    activeColorMode: 'attentionOnly',
                    hideInactiveSessions: true,
                    isFirst: true,
                    isLast: true,
                    isSingle: true,
                    subtitleOverride: 'Model subtitle',
                    subtitleEllipsizeMode: 'head',
                    pinned: false,
                    showServerBadge: true,
                    selected: true,
                    tags: [],
                    secondaryLineMode: 'path',
                    workingPlacementRetained: false,
                    attentionStanding: false,
                    isAttentionStanding: false,
                    attentionStandingEnabled: false,
                    draft: null,
                }}
                serverId="server_a"
                serverName="Server A"
                pinned={false}
                selected={false}
                isFirst={false}
                isLast={false}
                isSingle={false}
                variant="default"
                compact={false}
            />,
        );

        expect(useSessionListRenderableWithServerScopeSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('session-list-item-sess_model_backed')?.props.accessibilityState).toMatchObject({
            selected: true,
        });
        expect(screen.findByType('Avatar' as any)?.props.hasUnreadMessages).toBe(false);
        expect(screen.findByType('Avatar' as any)?.props.unreadBadgeTestID).toBeUndefined();
        expect(screen.getTextContent()).toContain('7m');
    });

    it('uses list-row pending approval flags when the scoped store renderable is stale', async () => {
        useSessionListRenderableWithServerScopeSpy.mockReturnValue({
            ...createSession('sess_overlay_permission'),
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        });
        mockSessionStatus = {
            state: 'permission_required',
            isConnected: true,
            statusText: 'status.permissionRequired',
            shouldShowStatus: true,
            statusColor: '#f90',
            statusDotColor: '#f90',
            isPulsing: true,
        };
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={{
                    ...createSession('sess_overlay_permission'),
                    hasPendingPermissionRequests: true,
                    hasPendingUserActionRequests: false,
                }}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                secondaryLineMode="status"
                compact={false}
            />,
        );

        expect(screen.getTextContent()).toContain('status.permissionRequired');
    });

    it('uses overlaid permission state when the row view model session is stale', async () => {
        const staleSession = {
            ...createSession('sess_row_model_overlay_permission'),
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        };
        const overlaidSession = {
            ...staleSession,
            hasPendingPermissionRequests: true,
        };
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'Online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={overlaidSession}
                rowViewModel={createSessionItemRowViewModel({
                    session: staleSession,
                    overrides: {
                        sessionStatus: mockSessionStatus,
                        secondaryLineMode: 'status',
                        workingPlacementRetained: false,
                        attentionStanding: false,
                    },
                })}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                secondaryLineMode="status"
                compact={false}
            />,
        );

        expect(screen.getTextContent()).toContain('status.permissionRequired');
        expect(screen.findByTestId(
            'session-list-attention-indicator-sess_row_model_overlay_permission-secondary-permission_required',
        )).toBeTruthy();
    });

    it('uses row-model blocked pending count when the provided session omits it', async () => {
        const rowSession = {
            ...createSession('sess_row_model_overlay_blocked_pending'),
            pendingCount: 1,
            pendingBlockedCount: 1,
        };
        const providedSession = {
            ...createSession('sess_row_model_overlay_blocked_pending'),
            pendingCount: 1,
        };
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'Online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={providedSession}
                rowViewModel={createSessionItemRowViewModel({
                    session: rowSession,
                    overrides: {
                        sessionStatus: mockSessionStatus,
                        secondaryLineMode: 'status',
                        workingPlacementRetained: false,
                        attentionStanding: false,
                    },
                })}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                secondaryLineMode="status"
                compact={false}
            />,
        );

        expect(screen.getTextContent()).toContain('status.actionRequired');
        expect(screen.findByTestId(
            'session-list-attention-indicator-sess_row_model_overlay_blocked_pending-secondary-action_required',
        )).toBeTruthy();
    });

    it('uses explicit provided-session zero blocked pending count over stale row-model state', async () => {
        const rowSession = {
            ...createSession('sess_row_model_overlay_blocked_pending_zero'),
            pendingCount: 1,
            pendingBlockedCount: 1,
        };
        const providedSession = {
            ...createSession('sess_row_model_overlay_blocked_pending_zero'),
            pendingCount: 0,
            pendingBlockedCount: 0,
        };
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'Online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        const SessionItem = await importSessionItem();

        const screen = await renderScreen(
            <SessionItem
                session={providedSession}
                rowViewModel={createSessionItemRowViewModel({
                    session: rowSession,
                    overrides: {
                        sessionStatus: mockSessionStatus,
                        secondaryLineMode: 'status',
                        workingPlacementRetained: false,
                        attentionStanding: false,
                    },
                })}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                secondaryLineMode="status"
                compact={false}
            />,
        );

        expect(screen.findAllByTestId(
            'session-list-attention-indicator-sess_row_model_overlay_blocked_pending_zero-secondary-action_required',
        )).toHaveLength(0);
    });

    it('uses list placement action flags when the row view model session is stale', async () => {
        const { SessionListSessionItem } = await import('./sessionListSessionItem');
        const staleSession = {
            ...createSession('sess_action_overlay'),
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        };
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'Online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };

        const screen = await renderScreen(
            <SessionListSessionItem
                item={{
                    type: 'session',
                    sessionId: 'sess_action_overlay',
                    serverId: 'server_a',
                    groupKey: 'attention-promotion-v1',
                    groupKind: 'attention',
                    attentionPlacementReason: 'action_required',
                    variant: 'default',
                }}
                rowViewModel={createSessionItemRowViewModel({
                    session: staleSession,
                    overrides: {
                        sessionStatus: mockSessionStatus,
                        secondaryLineMode: 'status',
                        workingPlacementRetained: false,
                        attentionStanding: false,
                    },
                })}
                rowHeight={42}
                dragEnabled={false}
                treeRowId="session:sess_action_overlay"
                onDragStart={vi.fn()}
                resolveDropResult={() => ({
                    result: { instruction: { kind: 'idle' }, visual: { kind: 'none' } },
                    geometry: { kind: 'none' },
                })}
                onDropResult={vi.fn()}
                onTogglePinnedSessionKey={null}
                onSetTagsSessionKey={null}
                onNativeContextMenuOpenChangeSessionKey={null}
                draggingSessionKey={null}
                nativeContextMenuSessionKey={null}
                dataIndex={0}
                overlayShared={createTreeDropOverlaySharedValues()}
                onRegisterTreeRowBounds={vi.fn()}
                onUnregisterTreeRowBounds={vi.fn()}
                currentUserId="u1"
                allKnownTags={[]}
                tagsEnabled={false}
                compact={false}
                compactMinimal={false}
                rowAttentionAnimationEnabled={true}
                folderMoveTargets={[]}
            />,
        );

        expect(screen.getTextContent()).toContain('status.actionRequired');
        expect(screen.findByTestId(
            'session-list-attention-indicator-sess_action_overlay-secondary-action_required',
        )).toBeTruthy();
    });

    it('uses start-side overflow ellipsis for path subtitles on web without reordering the path', async () => {
        mockSessionStatus = {
            ...defaultSessionStatus,
            state: 'waiting',
            statusText: 'Online',
            shouldShowStatus: false,
            isPulsing: false,
        };
        platformOs = 'web';
        const SessionItem = await importSessionItem();
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
        mockSessionStatus = {
            ...defaultSessionStatus,
            state: 'waiting',
            statusText: 'Online',
            shouldShowStatus: false,
            isPulsing: false,
        };
        platformOs = 'ios';
        const SessionItem = await importSessionItem();
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

    it('shows the working indicator instead of only path and time in date-grouped rows', async () => {
        workingIndicatorStyle = 'spinner';
        mockSessionStatus = {
            ...defaultSessionStatus,
        };
        const SessionItem = await importSessionItem();
        const sessionPath = '~/Documents/Development/happier/dev';

        const screen = await renderScreen(
            <SessionItem
                session={{
                    ...createSession('sess_date_working'),
                    thinking: true,
                    thinkingAt: 2,
                }}
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

        expect(screen.findByTestId('session-row-attention-indicator-spinner-sess_date_working-secondary')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Working on it');
        expect(screen.getTextContent()).not.toContain(sessionPath);
    });
});
