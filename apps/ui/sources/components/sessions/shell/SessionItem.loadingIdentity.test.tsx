import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, createSessionListRenderableSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { createSessionItemRowViewModel } from './sessionItemRowViewModelTestFixture';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
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
    storage: async (importOriginal) => importOriginal(),
});

vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');

const storageModule = await import('@/sync/domains/state/storage');
const useSessionListRenderableWithServerScopeSpy = vi.spyOn(storageModule, 'useSessionListRenderableWithServerScope');
const useHasUnreadMessagesSpy = vi.spyOn(storageModule, 'useHasUnreadMessages');

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
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

vi.mock('./sessionPinIcons', () => ({
    PinIcon: (props: Record<string, unknown>) => React.createElement('PinIcon', props),
    PinSlashIcon: (props: Record<string, unknown>) => React.createElement('PinSlashIcon', props),
}));

vi.mock('./sessionTagIcons', () => ({
    TagIcon: (props: Record<string, unknown>) => React.createElement('TagIcon', props),
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
    return createSessionListRenderableSessionFixture({
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
        encryptionMode: 'plain',
        encryptedContentAvailability: 'ready',
    });
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('SessionItem loading identity', () => {
    beforeEach(() => {
        useSessionListRenderableWithServerScopeSpy.mockClear();
        useHasUnreadMessagesSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it.each([false, true])('renders identity placeholders instead of unknown metadata text while metadata is pending (compact=%s)', async (compact) => {
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
                variant="default"
                compact={compact}
            />,
        );

        const avatar = screen.findByTestId('session-list-avatar-loading-sess_loading');
        const title = screen.findByTestId('session-list-title-loading-sess_loading');
        const subtitle = screen.findByTestId('session-list-subtitle-loading-sess_loading');
        expect(avatar).toBeTruthy();
        expect(title).toBeTruthy();
        expect(subtitle).toBeTruthy();
        if (compact) {
            expect(flattenStyle(avatar?.props.style)).toMatchObject({ width: 30, height: 30 });
            expect(flattenStyle(title?.props.style)).toMatchObject({ width: '60%', height: 13 });
            expect(flattenStyle(subtitle?.props.style)).toMatchObject({ width: '42%', height: 9 });
        }
        expect(screen.getTextContent()).not.toContain('session.untitled');
    });

    it.each([false, true])('keeps a demand-pending identity still regardless of row attention animation (enabled=%s)', async (rowAttentionAnimationEnabled) => {
        const { buildSessionListRowViewModels } = await import('./sessionListRowViewModels');
        const { Animated } = await import('react-native');
        const loopSpy = vi.spyOn(Animated, 'loop').mockReturnValue({
            start: vi.fn(),
            stop: vi.fn(),
        } as any);
        const { SessionItem } = await import('./SessionItem');
        const session = createMetadataPendingSession('sess_offscreen_loading');
        const item = { type: 'session', sessionId: session.id, serverId: 'server_a',
            storageKind: 'persisted', groupKind: 'date', groupKey: 'date' } satisfies SessionListIndexItem;
        const [rowViewModel] = buildSessionListRowViewModels({
            listItems: [item],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[sessionAddressKey({ serverId: 'server_a', sessionId: session.id }), session]]),
            pinnedSessionKeys: new Set(), sessionTags: {}, selectedSessionId: null,
            showServerBadge: false, showPinnedServerBadge: false,
        });
        expect(rowViewModel?.isIdentityLoading).toBe(true);
        if (!rowViewModel) throw new Error('Expected canonical pending row');

        const screen = await renderScreen(
            <SessionItem
                session={session}
                rowViewModel={rowViewModel}
                serverId="server_a"
                pinned={false}
                selected={false}
                variant="default"
                compact={false}
                rowAttentionAnimationEnabled={rowAttentionAnimationEnabled}
            />,
        );

        expect(screen.findByTestId('session-list-title-loading-sess_offscreen_loading')).toBeTruthy();
        expect(loopSpy).not.toHaveBeenCalled();
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
                variant="default"
                compact={false}
            />,
        );

        expect(screen.findByTestId('session-list-avatar-loading-sess_unavailable')).toBeNull();
        expect(screen.findByTestId('session-list-title-loading-sess_unavailable')).toBeNull();
        expect(screen.findByTestId('session-list-subtitle-loading-sess_unavailable')).toBeNull();
        expect(screen.getTextContent()).toContain('session.untitled');
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
                variant="default"
                compact={false}
            />,
        );

        expect(screen.findByTestId('session-list-item-sess_missing_model')).toBeNull();
        expect(useSessionListRenderableWithServerScopeSpy).not.toHaveBeenCalled();
        expect(useHasUnreadMessagesSpy).not.toHaveBeenCalled();
    });
});
