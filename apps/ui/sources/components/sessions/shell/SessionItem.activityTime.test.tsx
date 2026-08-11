import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { lightTheme } from '@/theme';
import type { Settings } from '@/sync/domains/settings/settings';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import type { SessionListRowModel } from './row/sessionListRowModelTypes';
import {
    resolveSessionRowAttentionState,
    resolveSessionRowPresentation,
} from './row/resolveSessionRowPresentation';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useProfileSpy = vi.hoisted(() => vi.fn(() => ({ id: 'u1' })));
const useSessionSpy = vi.hoisted(() => vi.fn(() => null));
const useSessionStatusSpy = vi.hoisted(() => vi.fn(() => mockSessionStatus));
const useSettingSpy = vi.hoisted(() => vi.fn());
const formatPendingCountBadgeSpy = vi.hoisted(() => vi.fn((pendingCount: number) => {
    if (!Number.isFinite(pendingCount) || pendingCount <= 0) {
        return null;
    }
    return pendingCount > 99 ? '99+' : String(Math.floor(pendingCount));
}));
const AvatarMock = 'Avatar' as unknown as React.ComponentType<{
    id?: string;
    size?: number;
    monochrome?: boolean;
    hasUnreadMessages?: boolean;
}>;
const AgentIconMock = 'AgentIcon' as unknown as React.ComponentType<{
    agentId?: string;
    size?: number;
    testID?: string;
    color?: string;
    style?: unknown;
}>;
let platformOs: 'ios' | 'android' | 'web' = 'web';
let isTabletDevice = false;

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
            useHasUnreadMessages: () => mockHasUnreadMessages,
            useProfile: useProfileSpy,
            useSession: useSessionSpy,
            useSetting: useSettingSpy,
        });
    },
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement(
        'DropdownMenu',
        props,
        typeof props.trigger === 'function' ? props.trigger({ toggle: vi.fn() }) : props.children,
    ),
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: 'AgentIcon',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: (flavor: string | null | undefined) => flavor === 'claude' || flavor === 'grok' ? flavor : null,
    getAgentPickerIconScale: (agentId: string) => agentId === 'grok' ? 1.25 : 1,
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/components/sessions/pendingBadge', () => ({
    formatPendingCountBadge: (pendingCount: number) => formatPendingCountBadgeSpy(pendingCount),
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => isTabletDevice,
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (_fn: unknown) => [false, vi.fn()],
}));

vi.mock('@/utils/errors/errors', () => ({
    HappyError: class HappyError extends Error {},
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
    useSessionStatus: useSessionStatusSpy,
}));

type MockSessionStatus = Readonly<{
    state: 'thinking' | 'waiting' | 'permission_required' | 'action_required';
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
    statusText: 'working on it',
    shouldShowStatus: true,
    statusColor: '#07f',
    statusDotColor: '#0f0',
    isPulsing: false,
};

let mockSessionStatus: MockSessionStatus = {
    ...defaultSessionStatus,
};
let mockListAttentionState: 'quiet' | 'unread' | 'pending' | 'ready' | 'failed' | 'thinking' | null = null;
let mockHasUnreadMessages = false;
let mockNarrowWorkingIndicatorStyle: 'spinner' | 'pulse' = 'spinner';
let mockAvatarStyle = 'meshGradientColumns';
let mockSessionListIdentityDisplay: 'avatar' | 'agentLogo' | 'none' = 'avatar';
let mockSessionListActiveColorMode: 'activityAndAttention' | 'attentionOnly' | 'allActive' = 'activityAndAttention';

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

function createSessionRowModel(overrides: Partial<SessionListRowModel> = {}): SessionListRowModel {
    const session = overrides.session ?? createSession(overrides.sessionId ?? 'sess_row_model');
    const sessionId = String(session.id);
    const serverId = overrides.serverId === undefined ? 'server_a' : overrides.serverId;
    const model: SessionListRowModel = {
        rowKey: `${serverId ?? 'local'}:${sessionId}`,
        sessionId,
        serverId,
        serverName: 'Server A',
        treeRowId: `session:${serverId ?? 'local'}:${sessionId}`,
        testID: `session-list-item-${sessionId}`,
        dataIndex: 0,
        session,
        status: {
            state: 'thinking',
            isConnected: true,
            statusText: 'model is working',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        },
        statusSignature: 'thinking:model is working',
        nextRuntimeFreshnessAtMs: null,
        secondaryLineMode: 'status',
        attention: {
            listState: 'thinking',
            rowState: 'working',
        },
        presentation: {
            attentionIndicator: 'working',
            titleTone: 'emphasized',
            secondaryLine: 'status',
        },
        activity: {
            mode: 'meaningful',
            timestamp: 1_700_000_000_000,
            label: '7m',
            bucket: '7m',
        },
        isIdentityLoading: false,
        title: 'Model Session',
        subtitle: 'Model Subtitle',
        subtitleEllipsizeMode: 'head',
        groupKey: 'recent',
        groupKind: null,
        section: 'recent',
        variant: 'default',
        folder: { id: null, depth: 0 },
        adjacency: { isFirst: true, isLast: true, isSingle: true },
        isSelected: true,
        isPinned: true,
        isArchived: false,
        isActive: true,
        hasUnreadMessages: false,
        pendingCount: 0,
        agentActivityLabel: null,
        pendingBlockedCount: 0,
        tags: ['model-tag'],
        allKnownTags: ['model-tag', 'other-tag'],
        tagsEnabled: true,
        currentUserId: 'u1',
        showServerBadge: true,
        compact: false,
        compactMinimal: false,
        identityDisplay: 'avatar',
        activeColorMode: 'activityAndAttention',
        workingIndicatorMode: 'spinner',
        workingIndicatorPaused: false,
        hideInactiveSessions: false,
    };
    return { ...model, ...overrides };
}

type SessionItemForTestProps = Omit<
    React.ComponentProps<(typeof import('./SessionItem'))['SessionItem']>,
    'rowModel'
> & {
    rowModel?: SessionListRowModel;
};

function createSessionRowModelForProps(props: SessionItemForTestProps): SessionListRowModel {
    const status = mockSessionStatus;
    const listState = mockListAttentionState ?? (
        status.state === 'waiting' ? 'quiet' : status.state
    );
    const rowState = resolveSessionRowAttentionState(listState);
    const isMinimal = Boolean(props.compact && props.compactMinimal);
    const density = isMinimal ? 'minimal' : props.compact ? 'compact' : 'default';
    const secondaryLineMode = props.secondaryLineMode ?? (props.variant === 'no-path' ? 'status' : 'path');
    const subtitle = props.subtitleOverride ?? 'Subtitle';
    return createSessionRowModel({
        session: props.session,
        sessionId: String(props.session.id),
        serverId: props.serverId ?? 'server_a',
        serverName: props.serverName ?? 'Server A',
        status,
        statusSignature: `${status.state}:${status.statusText}`,
        secondaryLineMode,
        attention: {
            listState,
            rowState,
        } as SessionListRowModel['attention'],
        presentation: resolveSessionRowPresentation({
            attentionState: rowState,
            density,
            requestedSecondaryLineMode: secondaryLineMode,
            hasPathSubtitle: Boolean(subtitle),
        }),
        activity: {
            mode: props.activityTimeMode === 'updatedAt' ? 'updatedAt' : 'meaningful',
            timestamp: typeof props.session.updatedAt === 'number' ? props.session.updatedAt : null,
            label: '1m',
            bucket: '1m',
        },
        title: 'Session',
        subtitle,
        subtitleEllipsizeMode: props.subtitleEllipsizeMode ?? 'head',
        variant: props.variant ?? 'default',
        folder: { id: null, depth: props.folderDepth ?? 0 },
        adjacency: {
            isFirst: props.isFirst ?? false,
            isLast: props.isLast ?? false,
            isSingle: props.isSingle ?? false,
        },
        isSelected: props.selected ?? false,
        isPinned: props.pinned ?? false,
        isArchived: props.session.archivedAt != null,
        isActive: props.session.active === true,
        hasUnreadMessages: mockHasUnreadMessages,
        pendingCount: props.session.pendingCount ?? 0,
        tags: props.tags ?? [],
        allKnownTags: props.allKnownTags ?? [],
        tagsEnabled: props.tagsEnabled ?? false,
        currentUserId: props.currentUserId ?? 'u1',
        showServerBadge: props.showServerBadge ?? false,
        compact: props.compact ?? false,
        compactMinimal: props.compactMinimal ?? false,
        identityDisplay: mockSessionListIdentityDisplay,
        activeColorMode: mockSessionListActiveColorMode,
        workingIndicatorMode: mockNarrowWorkingIndicatorStyle,
        workingIndicatorPaused: false,
        hideInactiveSessions: false,
    });
}

async function importSessionItemForTest() {
    const { SessionItem: ProductionSessionItem } = await import('./SessionItem');
    const SessionItem = (props: SessionItemForTestProps) => (
        <ProductionSessionItem
            {...props}
            rowModel={props.rowModel ?? createSessionRowModelForProps(props)}
        />
    );
    return { SessionItem };
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

function findWorkingSpinner(screen: Awaited<ReturnType<typeof renderScreen>>, sessionId: string) {
    return screen.findByTestId(`session-row-attention-indicator-spinner-${sessionId}`);
}

describe('SessionItem activity time', () => {
    beforeEach(() => {
        mockSessionStatus = {
            ...defaultSessionStatus,
        };
        mockListAttentionState = null;
        mockHasUnreadMessages = false;
        mockNarrowWorkingIndicatorStyle = 'spinner';
        mockAvatarStyle = 'meshGradientColumns';
        mockSessionListIdentityDisplay = 'avatar';
        mockSessionListActiveColorMode = 'activityAndAttention';
        platformOs = 'web';
        isTabletDevice = false;
        useProfileSpy.mockReset();
        useProfileSpy.mockImplementation(() => ({ id: 'u1' }));
        useSessionSpy.mockReset();
        useSessionSpy.mockImplementation(() => null);
        useSettingSpy.mockReset();
        formatPendingCountBadgeSpy.mockClear();
        useSettingSpy.mockImplementation((key: keyof Settings | string) => {
            if (key === 'sessionListNarrowWorkingIndicatorStyle') {
                return mockNarrowWorkingIndicatorStyle;
            }
            if (key === 'avatarStyle') {
                return mockAvatarStyle;
            }
            if (key === 'sessionListIdentityDisplay') {
                return mockSessionListIdentityDisplay;
            }
            if (key === 'sessionListActiveColorModeV1') {
                return mockSessionListActiveColorMode;
            }
            return undefined;
        });
        useSessionStatusSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('requires a row model instead of falling back to row-local store hooks', async () => {
        const { SessionItem } = await import('./SessionItem');

        await expect(renderScreen(
            // @ts-expect-error - this intentionally exercises the runtime guard for untyped callers.
            <SessionItem
                session={createSession('sess_missing_row_model')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        )).rejects.toThrow(/row model/i);

    });

    it('renders the meaningful activity timestamp instead of the raw session updatedAt', async () => {
        const { SessionItem } = await importSessionItemForTest();

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

    it('renders from a row model without row-local store, status, activity, attention, or setting hooks', async () => {
        const { SessionItem } = await importSessionItemForTest();
        const rowModel = createSessionRowModel();

        const screen = await renderScreen(
            <SessionItem
                rowModel={rowModel}
                session={createSession('stale_prop_session')}
                onMoveUp={vi.fn()}
                onMoveDown={vi.fn()}
                onMoveToFolder={vi.fn()}
                onMoveToWorkspaceRoot={vi.fn()}
            />,
        );

        expect(screen.findByTestId('session-list-item-sess_row_model')).toBeTruthy();
        expect(screen.findByTestId('session-list-status-subtitle-sess_row_model-working')).toBeTruthy();
        expect(screen.findByTestId('session-list-status-subtitle-text-sess_row_model-working')?.props.children).toBe('model is working');
        expect(screen.getTextContent()).toContain('Model Session');
        expect(screen.getTextContent()).toContain('7m');
        expect(screen.findByTestId('session-list-item-sess_row_model')?.props.accessibilityState).toMatchObject({
            selected: true,
        });
        expect(screen.findByTestId('session-list-item-sess_row_model')?.props.accessibilityActions).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'moveUp' }),
            expect.objectContaining({ name: 'moveDown' }),
            expect.objectContaining({ name: 'moveToFolder' }),
            expect.objectContaining({ name: 'moveToWorkspaceRoot' }),
        ]));
        expect(useSessionStatusSpy).not.toHaveBeenCalled();
        expect(useSettingSpy).not.toHaveBeenCalled();
    });

    it('renders background activity with the normal working spinner while retaining pending and unread row facts', async () => {
        const { SessionItem } = await importSessionItemForTest();
        const rowModel = createSessionRowModel({
            status: {
                state: 'background_active',
                isConnected: true,
                statusText: 'background activity',
                shouldShowStatus: true,
                statusColor: '#07f',
                statusDotColor: '#0f0',
                isPulsing: false,
            },
            attention: {
                listState: 'pending',
                rowState: 'pending',
            },
            presentation: resolveSessionRowPresentation({
                attentionState: 'pending',
                backgroundActive: true,
                density: 'default',
                requestedSecondaryLineMode: 'status',
                hasPathSubtitle: true,
            }),
            hasUnreadMessages: true,
            pendingCount: 2,
            workingIndicatorPaused: false,
        });

        const screen = await renderScreen(
            <SessionItem rowModel={rowModel} session={rowModel.session} />,
        );

        expect(rowModel.attention).toEqual({ listState: 'pending', rowState: 'pending' });
        expect(rowModel.hasUnreadMessages).toBe(true);
        expect(screen.findByTestId('session-list-status-subtitle-sess_row_model-pending')).toBeTruthy();
        expect(screen.findByTestId('session-row-attention-indicator-spinner-sess_row_model-secondary')).toBeTruthy();
        // The background line now renders the SESSION's status text, which is where the count
        // lives, instead of a second key the row would have to re-interpolate.
        expect(screen.findByTestId('session-list-status-subtitle-text-sess_row_model-pending')?.props.children)
            .toBe('background activity');
        expect(screen.getTextContent()).toContain('2');
    });

    it('renders the pending badge from the computed row-model pendingCount instead of the stale session value', async () => {
        const { SessionItem } = await importSessionItemForTest();
        const rowModel = createSessionRowModel({
            session: {
                ...createSession('sess_row_model'),
                pendingCount: 0,
            },
            pendingCount: 42,
        });

        const screen = await renderScreen(
            <SessionItem
                rowModel={rowModel}
                session={createSession('ignored_prop_session')}
            />,
        );

        expect(formatPendingCountBadgeSpy).toHaveBeenCalledWith(42);
        expect(screen.findAllByType('Text').some((node) => node.props.children === '42')).toBe(true);
    });

    it('keeps row-model action affordances stable when the row is hovered', async () => {
        const { SessionItem } = await importSessionItemForTest();
        const rowModel = createSessionRowModel({
            isSelected: false,
            activity: {
                mode: 'meaningful',
                timestamp: 1_700_000_000_000,
                label: '9m',
                bucket: '9m',
            },
        });

        const screen = await renderScreen(
            <SessionItem
                rowModel={rowModel}
                session={createSession('ignored_session')}
                onSetTags={vi.fn()}
                onTogglePinned={vi.fn()}
                onMoveToFolder={vi.fn()}
            />,
        );

        await act(async () => {
            screen.findByTestId('session-item-right-area')?.props.onPointerEnter?.({});
        });

        expect(screen.findByTestId('session-item-more-menu')).toBeTruthy();
        expect(screen.findByTestId('session-list-item-sess_row_model')?.props.accessibilityActions).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'moveToFolder' }),
        ]));
        expect(useSessionStatusSpy).not.toHaveBeenCalled();
        expect(useSettingSpy).not.toHaveBeenCalled();
    });

    it('renders the row-model activity timestamp for date-grouped lists', async () => {
        const { SessionItem } = await importSessionItemForTest();
        const rowModel = createSessionRowModel({
            session: {
                ...createSession('sess_updated_at'),
                createdAt: 1_700_000_000_000 - 5 * 60 * 60 * 1000,
                updatedAt: 1_700_000_000_000 - 3 * 60 * 60 * 1000,
                meaningfulActivityAt: 1_700_000_000_000 - 2 * 60 * 60 * 1000,
            },
            activity: {
                mode: 'updatedAt',
                timestamp: 1_700_000_000_000 - 2 * 60 * 60 * 1000,
                label: '2h',
                bucket: '2h',
            },
        });

        const screen = await renderScreen(
            <SessionItem
                rowModel={rowModel}
                session={createSession('ignored_session_timestamp')}
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

        expect(screen.getTextContent()).toContain('2h');
        expect(screen.getTextContent()).not.toContain('1m');
    });

    it('shows the working indicator instead of only path and time in date-grouped rows', async () => {
        mockSessionStatus = {
            state: 'thinking',
            isConnected: true,
            statusText: 'working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        };
        mockListAttentionState = 'thinking';
        const { SessionItem } = await importSessionItemForTest();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_date_working')}
                activityTimeMode="updatedAt"
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

        expect(screen.findByTestId('session-list-status-subtitle-sess_date_working-working')).toBeTruthy();
        expect(screen.findByTestId('session-list-attention-indicator-sess_date_working-secondary-working')).toBeTruthy();
        expect(findWorkingSpinner(screen, 'sess_date_working-secondary')).toBeTruthy();
        expect(screen.getTextContent()).toContain('working on it');
        expect(screen.getTextContent()).not.toContain('Subtitle');
    });

    it('renders one working indicator in very compact mode without working status text', async () => {
        mockSessionStatus = {
            state: 'thinking',
            isConnected: true,
            statusText: 'working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        };

        const { SessionItem } = await importSessionItemForTest();

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

        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_active')).toBeNull();
        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_active-trailing')).toBeTruthy();
        expect(screen.findByTestId('session-list-attention-indicator-sess_compact_active-trailing-working')).toBeTruthy();
        const spinner = findWorkingSpinner(screen, 'sess_compact_active-trailing');
        expect(spinner).toBeTruthy();
        expect(flattenStyle(spinner?.props.style)).toMatchObject({
            width: 12,
            height: 12,
            borderColor: lightTheme.colors.text.tertiary,
        });
        expect(screen.findAllByType('StatusDot')).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain('working on it');
        expect(screen.getTextContent()).not.toContain('1m');
    });

    it('renders the configured pulsing dot in very compact mode when selected', async () => {
        mockNarrowWorkingIndicatorStyle = 'pulse';
        mockSessionStatus = {
            state: 'thinking',
            isConnected: true,
            statusText: 'working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        };

        const { SessionItem } = await importSessionItemForTest();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_active_dot')}
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

        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_active_dot')).toBeNull();
        expect(screen.findByTestId('session-list-attention-indicator-sess_compact_active_dot-trailing-working')).toBeTruthy();
        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(0);
        const dots = screen.findAllByType('StatusDot');
        expect(dots).toHaveLength(1);
        expect(dots[0]?.props.isPulsing).toBe(true);
        expect(screen.getTextContent()).not.toContain('1m');
    });

    it('uses a tighter fixed row height in very compact mode', async () => {
        const { SessionItem } = await importSessionItemForTest();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_height')}
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

        const rowStyle = flattenStyle(screen.findByTestId('session-list-item-sess_compact_height')?.props.style);
        expect(rowStyle.height).toBe(34);
        expect(rowStyle.paddingHorizontal).toBe(8);

        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_height')).toBeNull();
    });

    it('renders an 18px micro avatar in very compact web rows', async () => {
        platformOs = 'web';
        const { SessionItem } = await importSessionItemForTest();

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

        const rowStyle = flattenStyle(screen.findByTestId('session-list-item-sess_compact_avatar_web')?.props.style);
        expect(rowStyle.height).toBe(34);
        expect(screen.findAllByType(AvatarMock)[0].props).toMatchObject({
            id: 'avatar',
            size: 18,
        });
        expect(findRowContentStyle(screen, 'sess_compact_avatar_web').marginLeft).toBe(8);
    });

    it('uses a 20px micro avatar for very compact native phone rows', async () => {
        platformOs = 'ios';
        isTabletDevice = false;
        const { SessionItem } = await importSessionItemForTest();

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

        const rowStyle = flattenStyle(screen.findByTestId('session-list-item-sess_compact_avatar_phone')?.props.style);
        expect(rowStyle.height).toBe(42);
        expect(screen.findAllByType(AvatarMock)[0].props.size).toBe(20);
        expect(findRowContentStyle(screen, 'sess_compact_avatar_phone').marginLeft).toBe(8);
    });

    it('renders the selected agent logo in the same narrow identity slot', async () => {
        mockSessionListIdentityDisplay = 'agentLogo';
        const { SessionItem } = await importSessionItemForTest();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_agent_logo_narrow', { flavor: 'grok' } as any)}
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

        expect(screen.findAllByType(AvatarMock)).toHaveLength(0);
        expect(screen.findAllByType(AgentIconMock)[0].props).toMatchObject({
            agentId: 'grok',
            size: 14,
            style: { transform: [{ scale: 1.25 }] },
            testID: 'session-list-agent-logo-sess_agent_logo_narrow',
        });
        expect(findRowContentStyle(screen, 'sess_agent_logo_narrow').marginLeft).toBe(8);
    });

    it('passes the resolved title color to agent logos for quiet active rows', async () => {
        mockSessionListIdentityDisplay = 'agentLogo';
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        mockListAttentionState = 'quiet';
        const { SessionItem } = await importSessionItemForTest();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_agent_logo_quiet', { flavor: 'claude' } as any)}
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
        expect(screen.findAllByType(AgentIconMock)[0].props.color).toBe(explicitTitleColorStyle?.color);
    });

    it('can use the active title color for all active connected session rows', async () => {
        mockSessionListIdentityDisplay = 'agentLogo';
        mockSessionListActiveColorMode = 'allActive';
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        mockListAttentionState = 'quiet';
        const { SessionItem } = await importSessionItemForTest();

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
        expect(screen.findAllByType(AgentIconMock)[0].props.color).toBe(titleStyle.color);
    });

    it('can keep working rows secondary when only attention rows use active color', async () => {
        mockSessionListIdentityDisplay = 'agentLogo';
        mockSessionListActiveColorMode = 'attentionOnly';
        mockSessionStatus = {
            state: 'thinking',
            isConnected: true,
            statusText: 'working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        };
        const { SessionItem } = await importSessionItemForTest();

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
        expect(screen.findAllByType(AgentIconMock)[0].props.color).toBe(titleStyle.color);
    });

    it('hides the session list identity slot across row densities when identity display is none', async () => {
        mockSessionListIdentityDisplay = 'none';
        const { SessionItem } = await importSessionItemForTest();

        const detailed = await renderScreen(
            <SessionItem
                session={createSession('sess_avatar_none_detailed')}
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
        expect(detailed.findAllByType(AvatarMock)).toHaveLength(0);
        expect(detailed.findAllByType(AgentIconMock)).toHaveLength(0);

        standardCleanup();

        const cozy = await renderScreen(
            <SessionItem
                session={createSession('sess_avatar_none_cozy')}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
                compactMinimal={false}
            />,
        );
        expect(cozy.findAllByType(AvatarMock)).toHaveLength(0);
        expect(cozy.findAllByType(AgentIconMock)).toHaveLength(0);

        standardCleanup();

        const narrow = await renderScreen(
            <SessionItem
                session={createSession('sess_avatar_none_narrow')}
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
        expect(narrow.findAllByType(AvatarMock)).toHaveLength(0);
        expect(narrow.findAllByType(AgentIconMock)).toHaveLength(0);
        expect(findRowContentStyle(narrow, 'sess_avatar_none_narrow').marginLeft).toBe(0);
    });

    it('keeps very compact web rows dense for the sidebar surface', async () => {
        platformOs = 'web';
        const { SessionItem } = await importSessionItemForTest();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_web')}
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

        const rowStyle = flattenStyle(screen.findByTestId('session-list-item-sess_compact_web')?.props.style);
        const titleStyle = flattenStyle(findSessionTitleText(screen, 'Session')?.props.style);

        expect(rowStyle.height).toBe(34);
        expect(titleStyle.fontSize).toBe(12);
        expect(titleStyle.lineHeight).toBe(16);
    });

    it('uses readable title metrics for very compact native phone rows', async () => {
        platformOs = 'ios';
        isTabletDevice = false;
        const { SessionItem } = await importSessionItemForTest();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_phone')}
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

        const rowStyle = flattenStyle(screen.findByTestId('session-list-item-sess_compact_phone')?.props.style);
        const titleStyle = flattenStyle(findSessionTitleText(screen, 'Session')?.props.style);

        expect(rowStyle.height).toBe(42);
        expect(titleStyle.fontSize).toBe(14);
        expect(titleStyle.lineHeight).toBe(18);
    });

    it('renders meaningful working status with canonical row indicator and themed text', async () => {
        mockSessionStatus = {
            state: 'thinking',
            isConnected: true,
            statusText: 'working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        };

        const { SessionItem } = await importSessionItemForTest();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_status_pill')}
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

        expect(screen.findByTestId('session-list-status-pill-sess_status_pill')).toBeNull();
        expect(screen.findByTestId('session-list-status-subtitle-sess_status_pill-working')).toBeTruthy();
        expect(screen.findByTestId('session-list-attention-indicator-sess_status_pill-secondary-working')).toBeTruthy();
        expect(screen.findByTestId('session-list-status-subtitle-text-sess_status_pill-working')?.props.children).toBe('working on it');
        const spinner = findWorkingSpinner(screen, 'sess_status_pill-secondary');
        expect(spinner).toBeTruthy();
        expect(flattenStyle(spinner?.props.style)).toMatchObject({
            width: 12,
            height: 12,
        });
        expect(screen.findAllByType('StatusDot')).toHaveLength(0);
        const statusText = screen.findAllByType('Text').find((node) => node.props.children === 'working on it');
        const flat = flattenStyle(statusText?.props.style);
        expect(flat.color).not.toBe('#07f');
        expect(flat.fontSize).toBe(12);
        expect(flat.lineHeight).toBe(16);
        expect(screen.getTextContent()).toContain('working on it');
    });

    it('renders the configured pulsing dot for working status subtitles outside very compact mode', async () => {
        mockNarrowWorkingIndicatorStyle = 'pulse';
        mockSessionStatus = {
            state: 'thinking',
            isConnected: true,
            statusText: 'working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        };

        const { SessionItem } = await importSessionItemForTest();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_status_pill_dot')}
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

        expect(screen.findByTestId('session-list-attention-indicator-sess_status_pill_dot-secondary-working')).toBeTruthy();
        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(0);
        const statusDots = screen.findAllByType('StatusDot');
        expect(statusDots).toHaveLength(1);
        expect(statusDots[0]?.props.isPulsing).toBe(true);
    });

    it('uses canonical list attention for ready row presentation', async () => {
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        mockListAttentionState = 'ready';

        const { SessionItem } = await importSessionItemForTest();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_ready')}
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

        expect(screen.findByTestId('session-list-status-subtitle-sess_ready-ready')).toBeTruthy();
        expect(screen.findByTestId('session-list-attention-indicator-sess_ready-secondary-ready')).toBeTruthy();
        expect(screen.findByTestId('session-list-status-subtitle-text-sess_ready-ready')?.props.children).toBe('status.readyForReview');
        expect(screen.getTextContent()).not.toContain('online');
    });

    it('does not show the legacy avatar unread badge for canonical ready rows', async () => {
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        mockListAttentionState = 'ready';
        mockHasUnreadMessages = true;

        const { SessionItem } = await importSessionItemForTest();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_ready_avatar')}
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

        expect(screen.findByTestId('session-list-status-subtitle-sess_ready_avatar-ready')).toBeTruthy();
        expect(screen.findAllByType(AvatarMock)[0].props.hasUnreadMessages).toBe(false);
    });

    it('renders canonical ready attention beside the trailing time in very compact mode', async () => {
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        mockListAttentionState = 'ready';

        const { SessionItem } = await importSessionItemForTest();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_ready')}
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

        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_ready')).toBeNull();
        expect(screen.findByTestId('session-list-attention-indicator-sess_compact_ready-trailing-ready')).toBeTruthy();
        expect(screen.findAllByType('StatusDot')).toHaveLength(1);
        expect(screen.getTextContent()).not.toContain('online');
        expect(screen.getTextContent()).toContain('1m');
    });

    it('renders canonical failed attention beside the trailing time in very compact mode', async () => {
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        mockListAttentionState = 'failed';

        const { SessionItem } = await importSessionItemForTest();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_failed')}
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

        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_failed')).toBeNull();
        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_failed-trailing')?.props.accessibilityLabel).toBe('status.error');
        expect(screen.findByTestId('session-list-attention-indicator-sess_compact_failed-trailing-failed')).toBeTruthy();
        expect(screen.findAllByType('StatusDot')).toHaveLength(1);
        expect(screen.getTextContent()).not.toContain('online');
        expect(screen.getTextContent()).toContain('1m');
    });

    it('renders canonical failed attention as a themed status subtitle outside very compact mode', async () => {
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };
        mockListAttentionState = 'failed';

        const { SessionItem } = await importSessionItemForTest();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_failed_status')}
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

        expect(screen.findByTestId('session-list-status-subtitle-sess_failed_status-failed')).toBeTruthy();
        expect(screen.findByTestId('session-list-attention-indicator-sess_failed_status-secondary-failed')).toBeTruthy();
        expect(screen.findByTestId('session-list-status-subtitle-text-sess_failed_status-failed')?.props.children).toBe('status.error');
        expect(screen.getTextContent()).not.toContain('online');
        const statusText = screen.findAllByType('Text').find((node) => node.props.children === 'status.error');
        expect(flattenStyle(statusText?.props.style).color).not.toBe('#34C759');
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

        const { SessionItem } = await importSessionItemForTest();

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

        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_quiet')).toBeNull();
        expect(screen.findAllByType('StatusDot')).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain('online');
        expect(screen.getTextContent()).toContain('1m');
    });

    it('renders a distinct accessible permission indicator in very compact mode', async () => {
        mockSessionStatus = {
            state: 'permission_required',
            isConnected: true,
            statusText: 'permission required',
            shouldShowStatus: true,
            statusColor: '#f90',
            statusDotColor: '#f90',
            isPulsing: true,
        };

        const { SessionItem } = await importSessionItemForTest();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_permission')}
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

        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_permission')).toBeNull();
        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_permission-trailing')?.props.accessibilityLabel).toBe('permission required');
        expect(screen.findByTestId('session-list-attention-indicator-sess_compact_permission-trailing-permission_required')).toBeTruthy();
        expect(screen.findAllByType('StatusDot')).toHaveLength(1);
        expect(screen.getTextContent()).not.toContain('permission required');
        expect(screen.getTextContent()).toContain('1m');
    });

    it('renders row-model pending approval state without consulting stale store renderables', async () => {
        const { SessionItem } = await importSessionItemForTest();
        const rowModel = createSessionRowModel({
            session: {
                ...createSession('sess_overlay_permission'),
                hasPendingPermissionRequests: true,
                hasPendingUserActionRequests: false,
            },
            status: {
                state: 'permission_required',
                isConnected: true,
                statusText: 'permission required',
                shouldShowStatus: true,
                statusColor: '#f90',
                statusDotColor: '#f90',
                isPulsing: true,
            },
            statusSignature: 'permission_required:permission required',
            attention: {
                listState: 'permission_required',
                rowState: 'permission_required',
            },
            presentation: resolveSessionRowPresentation({
                attentionState: 'permission_required',
                density: 'minimal',
                requestedSecondaryLineMode: 'path',
                hasPathSubtitle: true,
            }),
            compact: true,
            compactMinimal: true,
        });
        const screen = await renderScreen(
            <SessionItem
                rowModel={rowModel}
                session={createSession('ignored_overlay_permission')}
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

        expect(screen.findByTestId('session-list-attention-indicator-sess_overlay_permission-trailing-permission_required')).toBeTruthy();
        expect(useSessionStatusSpy).not.toHaveBeenCalled();
    });

    it('renders a distinct accessible action indicator in very compact mode', async () => {
        mockSessionStatus = {
            state: 'action_required',
            isConnected: true,
            statusText: 'action required',
            shouldShowStatus: true,
            statusColor: '#f90',
            statusDotColor: '#f90',
            isPulsing: true,
        };

        const { SessionItem } = await importSessionItemForTest();

        const screen = await renderScreen(
            <SessionItem
                session={createSession('sess_compact_action')}
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

        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_action')).toBeNull();
        expect(screen.findByTestId('session-row-attention-indicator-sess_compact_action-trailing')?.props.accessibilityLabel).toBe('action required');
        expect(screen.findByTestId('session-list-attention-indicator-sess_compact_action-trailing-action_required')).toBeTruthy();
        expect(screen.findAllByType('StatusDot')).toHaveLength(1);
        expect(screen.getTextContent()).not.toContain('action required');
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

        const { SessionItem } = await importSessionItemForTest();

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

    it('uses row-model ownership data without subscribing to profile or full session state', async () => {
        const { SessionItem } = await importSessionItemForTest();
        const rowModel = createSessionRowModel({
            session: createSession('sess_row_state'),
            currentUserId: 'u1',
        });

        await renderScreen(
            <SessionItem
                rowModel={rowModel}
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

        expect(useSessionStatusSpy).not.toHaveBeenCalled();
        expect(useSessionSpy).not.toHaveBeenCalled();
        expect(useProfileSpy).not.toHaveBeenCalled();
    });

    it('renders inactive online session avatars in monochrome', async () => {
        const { SessionItem } = await importSessionItemForTest();

        const screen = await renderScreen(
            <SessionItem
                session={{
                    ...createSession('sess_inactive_online'),
                    active: false,
                    presence: 'online',
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

        expect(screen.findAllByType(AvatarMock)[0].props.monochrome).toBe(true);
    });

    it('uses start-side overflow ellipsis for path subtitles on web without reordering the path', async () => {
        platformOs = 'web';
        mockSessionStatus = {
            ...defaultSessionStatus,
            state: 'waiting',
            statusText: 'online',
            shouldShowStatus: false,
            isPulsing: false,
        };
        mockListAttentionState = 'quiet';
        const { SessionItem } = await importSessionItemForTest();
        const sessionPath = '~/Documents/Development/happier/remote-dev';

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
        mockSessionStatus = {
            ...defaultSessionStatus,
            state: 'waiting',
            statusText: 'online',
            shouldShowStatus: false,
            isPulsing: false,
        };
        mockListAttentionState = 'quiet';
        const { SessionItem } = await importSessionItemForTest();
        const sessionPath = '~/Documents/Development/happier/remote-dev';

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
