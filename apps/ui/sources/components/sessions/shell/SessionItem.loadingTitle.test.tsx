import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useProfileSpy = vi.hoisted(() => vi.fn(() => ({ id: 'u1' })));
const useSessionListRenderableSpy = vi.hoisted(() => vi.fn(() => null));

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
            useSessionListRenderable: useSessionListRenderableSpy,
            useSessionListMeaningfulActivityAt: () => 0,
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

describe('SessionItem loading identity', () => {
    beforeEach(() => {
        useProfileSpy.mockClear();
        useSessionListRenderableSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders identity placeholders instead of unknown metadata text while metadata is pending', async () => {
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createMetadataPendingSession('sess_loading')}
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

    it('renders settled unknown identity instead of placeholders when metadata is unavailable', async () => {
        const { SessionItem } = await import('./SessionItem');

        const screen = await renderScreen(
            <SessionItem
                session={createMetadataUnavailableSession('sess_unavailable')}
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
});
