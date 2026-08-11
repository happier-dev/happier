import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionItemTestRowModel, installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionStatus } from '@/utils/sessions/sessionUtils';
import type { SessionListRowModel } from './row/sessionListRowModelTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useProfileSpy = vi.hoisted(() => vi.fn(() => ({ id: 'u1' })));

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
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
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useHasUnreadMessages: () => false,
            useProfile: useProfileSpy,
            useSetting: () => false,
        });
    },
});

vi.mock('@/components/ui/feedback/ShimmerView', () => ({
    ShimmerView: (props: any) => React.createElement('ShimmerView', props, props.children),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
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
    formatShortRelativeTime: () => '',
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
    getSessionName: () => 'status.unknown',
    getSessionSubtitle: () => '',
    getSessionAvatarId: () => 'avatar',
    useSessionStatus: () => ({
        state: 'waiting',
        isConnected: false,
        statusText: '',
        shouldShowStatus: false,
        statusColor: 'status-color',
        statusDotColor: 'dot-color',
        isPulsing: false,
    }),
}));

function createMetadataPendingSession(id: string) {
    return createSessionFixture({
        id,
        active: false,
        activeAt: 1,
        createdAt: 1,
        updatedAt: 1,
        metadata: null,
        presence: 1,
    });
}

function createMetadataUnavailableSession(id: string): SessionListRenderableSession & { metadataUnavailable?: boolean } {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        archivedAt: null,
        metadata: null,
        metadataVersion: 1,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        metadataUnavailable: true,
    };
}

function createWaitingStatus(): SessionStatus {
    return {
        state: 'waiting',
        isConnected: false,
        statusText: '',
        shouldShowStatus: false,
        statusColor: 'status-color',
        statusDotColor: 'dot-color',
        isPulsing: false,
    };
}

function createMetadataPendingRowModel(id: string): SessionListRowModel {
    const session = createMetadataPendingSession(id);
    return {
        rowKey: `server_a:${id}`,
        sessionId: id,
        serverId: 'server_a',
        serverName: 'Server A',
        treeRowId: `session:server_a:${id}`,
        testID: `session-list-item-${id}`,
        dataIndex: 0,
        session,
        status: createWaitingStatus(),
        statusSignature: 'waiting|0|0||0|',
        nextRuntimeFreshnessAtMs: null,
        secondaryLineMode: 'path',
        attention: {
            listState: 'quiet',
            rowState: 'quiet',
        },
        presentation: {
            attentionIndicator: 'none',
            titleTone: 'quiet',
            secondaryLine: 'path',
        },
        activity: {
            mode: 'meaningful',
            timestamp: null,
            label: '',
            bucket: '',
        },
        isIdentityLoading: true,
        title: 'status.unknown',
        subtitle: '',
        subtitleEllipsizeMode: 'head',
        groupKey: 'group-a',
        groupKind: 'project',
        section: 'active',
        variant: 'default',
        folder: {
            id: null,
            depth: 0,
        },
        adjacency: {
            isFirst: true,
            isLast: true,
            isSingle: true,
        },
        isSelected: false,
        isPinned: false,
        isArchived: false,
        isActive: false,
        hasUnreadMessages: false,
        pendingCount: 0,
        agentActivityLabel: null,
        pendingBlockedCount: 0,
        tags: [],
        allKnownTags: [],
        tagsEnabled: false,
        currentUserId: 'u1',
        showServerBadge: false,
        compact: false,
        compactMinimal: false,
        identityDisplay: 'avatar',
        activeColorMode: 'activityAndAttention',
        workingIndicatorMode: 'spinner',
        workingIndicatorPaused: false,
        hideInactiveSessions: false,
    };
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function getRawStyle(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string): unknown {
    const node = screen.findByTestId(testID);
    if (!node) throw new Error(`expected ${testID} to exist`);
    return node.props.style;
}

describe('SessionItem loading identity', () => {
    beforeEach(() => {
        useProfileSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders identity placeholders instead of unknown metadata text while metadata is pending', async () => {
        const { SessionItem } = await import('./SessionItem');
        const session = createMetadataPendingSession('sess_loading');

        const screen = await renderScreen(
            <SessionItem
                session={session}
                rowModel={createSessionItemTestRowModel({ session, serverId: 'server_a', isFirst: true, isLast: true, isSingle: true })}
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

        expect(screen.findByTestId('session-list-avatar-loading-sess_loading')).toBeTruthy();
        expect(screen.findByTestId('session-list-title-loading-sess_loading')).toBeTruthy();
        expect(screen.findByTestId('session-list-subtitle-loading-sess_loading')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('status.unknown');
    });

    it('keeps compact identity placeholders in one static style entry before animated opacity', async () => {
        const { SessionItem } = await import('./SessionItem');
        const session = createMetadataPendingSession('sess_compact_loading');

        const screen = await renderScreen(
            <SessionItem
                session={session}
                rowModel={createSessionItemTestRowModel({
                    session,
                    serverId: 'server_a',
                    isFirst: true,
                    isLast: true,
                    isSingle: true,
                    compact: true,
                })}
                serverId="server_a"
                pinned={false}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={true}
            />,
        );

        const avatarStyle = getRawStyle(screen, 'session-list-avatar-loading-sess_compact_loading');
        expect(Array.isArray(avatarStyle)).toBe(true);
        expect((avatarStyle as readonly unknown[])[0]).toMatchObject({
            width: 30,
            height: 30,
            borderRadius: 999,
            backgroundColor: expect.any(String),
        });
        expect(flattenStyle((avatarStyle as readonly unknown[])[1])).toHaveProperty('opacity');

        const titleStyle = getRawStyle(screen, 'session-list-title-loading-sess_compact_loading');
        expect(Array.isArray(titleStyle)).toBe(true);
        expect((titleStyle as readonly unknown[])[0]).toMatchObject({
            width: '60%',
            height: 13,
            borderRadius: 7,
            backgroundColor: expect.any(String),
        });
        expect(flattenStyle((titleStyle as readonly unknown[])[1])).toHaveProperty('opacity');

        const subtitleStyle = getRawStyle(screen, 'session-list-subtitle-loading-sess_compact_loading');
        expect(Array.isArray(subtitleStyle)).toBe(true);
        expect((subtitleStyle as readonly unknown[])[0]).toMatchObject({
            width: '42%',
            height: 9,
            borderRadius: 999,
            backgroundColor: expect.any(String),
            marginTop: 2,
        });
        expect(flattenStyle((subtitleStyle as readonly unknown[])[1])).toHaveProperty('opacity');
    });

    it('renders settled unknown identity instead of placeholders when metadata is unavailable', async () => {
        const { SessionItem } = await import('./SessionItem');
        const session = createMetadataUnavailableSession('sess_unavailable');

        const screen = await renderScreen(
            <SessionItem
                session={session}
                rowModel={createSessionItemTestRowModel({
                    session,
                    serverId: 'server_a',
                    isFirst: true,
                    isLast: true,
                    isSingle: true,
                }, {
                    isIdentityLoading: false,
                    title: 'status.unknown',
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

        expect(screen.findByTestId('session-list-avatar-loading-sess_unavailable')).toBeNull();
        expect(screen.findByTestId('session-list-title-loading-sess_unavailable')).toBeNull();
        expect(screen.findByTestId('session-list-subtitle-loading-sess_unavailable')).toBeNull();
        expect(screen.getTextContent()).toContain('status.unknown');
    });

    it('renders identity placeholders for row-model rows while metadata is pending', async () => {
        const { SessionItem } = await import('./SessionItem');
        const rowModel = createMetadataPendingRowModel('sess_row_model_loading');

        const screen = await renderScreen(
            <SessionItem
                session={rowModel.session}
                rowModel={rowModel}
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

        expect(screen.findByTestId('session-list-avatar-loading-sess_row_model_loading')).toBeTruthy();
        expect(screen.findByTestId('session-list-title-loading-sess_row_model_loading')).toBeTruthy();
        expect(screen.findByTestId('session-list-subtitle-loading-sess_row_model_loading')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('status.unknown');
    });
});
