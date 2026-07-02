import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { createSessionItemRowViewModel } from './sessionItemRowViewModelTestFixture';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useProfileSpy = vi.hoisted(() => vi.fn(() => ({ id: 'u1' })));
const useSessionListRenderableWithServerScopeSpy = vi.hoisted(() => vi.fn(() => null));
const useHasUnreadMessagesSpy = vi.hoisted(() => vi.fn(() => false));

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
        pillLabel: () => ({ fontSize: 10, lineHeight: 12 }),
        tabular: () => ({ fontVariant: ['tabular-nums'] }),
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
            useHasUnreadMessages: useHasUnreadMessagesSpy,
            useProfile: useProfileSpy,
            useSessionListRenderableWithServerScope: useSessionListRenderableWithServerScopeSpy,
            useSessionListMeaningfulActivityAt: () => 0,
            useSetting: () => false,
        });
    },
});

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
    getSessionStatus: () => ({
        state: 'disconnected',
        isConnected: false,
        statusText: '',
        statusColor: 'status-color',
        statusDotColor: 'dot-color',
        isPulsing: false,
    }),
    useSessionStatus: () => ({
        state: 'disconnected',
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
        useSessionListRenderableWithServerScopeSpy.mockClear();
        useHasUnreadMessagesSpy.mockClear();
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
                rowViewModel={createSessionItemRowViewModel({
                    session,
                    overrides: {
                        isIdentityLoading: true,
                    },
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
                rowViewModel={createSessionItemRowViewModel({
                    session,
                    overrides: {
                        isIdentityLoading: true,
                    },
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
                rowViewModel={createSessionItemRowViewModel({
                    session,
                    overrides: {
                        isIdentityLoading: false,
                    },
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

    it('does not fall back to hot row hooks when a row view model is missing', async () => {
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            // @ts-expect-error Deliberately verifies stale runtime callers cannot re-enter the removed legacy hook path.
            <SessionItem
                session={createMetadataPendingSession('sess_missing_model')}
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

        expect(screen.findByTestId('session-list-item-sess_missing_model')).toBeNull();
        expect(useSessionListRenderableWithServerScopeSpy).not.toHaveBeenCalled();
        expect(useHasUnreadMessagesSpy).not.toHaveBeenCalled();
    });
});
