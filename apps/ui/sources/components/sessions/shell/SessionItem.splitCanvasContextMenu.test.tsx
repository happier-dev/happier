import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    createModelBackedSessionItemTestComponent,
    type ModelBackedSessionItemTestProps,
} from './sessionItemRowViewModelTestFixture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type SessionItemProps = ModelBackedSessionItemTestProps;
type ContextMenuTestInstance = Readonly<{
    props: Readonly<{
        items?: readonly Readonly<{ id?: string }>[];
        onSelect?: (itemId: string) => void;
    }>;
}>;

const splitCanvasActionState = vi.hoisted(() => ({
    mode: 'none' as 'none' | 'open' | 'reveal',
    openInSplitRight: vi.fn(),
    openInSplitDown: vi.fn(),
    revealInSplit: vi.fn(),
}));

const themeColors = vi.hoisted(() => ({
    surface: '#fff',
    surfaceSelected: '#eee',
    divider: '#ddd',
    text: '#111',
    textSecondary: '#666',
    textLink: '#07f',
    input: { background: '#f0f0f0' },
    groupped: { background: '#f7f7f7' },
    status: { error: '#f00' },
    button: { primary: { tint: '#fff' } },
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios' },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: themeColors,
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useHasUnreadMessages: () => false,
                useProfile: () => ({
                    id: 'u1',
                    timestamp: 0,
                    firstName: null,
                    lastName: null,
                    username: null,
                    avatar: null,
                    linkedProviders: [],
                    connectedServices: [],
                    connectedServicesV2: [],
                    connectedServiceCredentialRevisionsV1: [],
                    connectedAccountsV4: [],
                    connectedAccountGroupsV4: [],
                }),
                useSession: () => null,
                useSessionListMeaningfulActivityAt: () => null,
            },
        });
    },
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));
vi.mock('@/components/ui/forms/dropdown/ContextMenu', () => ({
    ContextMenu: (props: Record<string, unknown>) => React.createElement('ContextMenu', props),
}));
vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: Record<string, unknown>) => React.createElement('Swipeable', props),
    GestureDetector: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('GestureDetector', props, props.children),
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
    Text: 'Text',
    TextInput: 'TextInput',
}));
vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    getSessionAvatarId: () => 'avatar',
    getSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
    }),
    useSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
    }),
}));
vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));
vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: 'AgentIcon',
}));
vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({
    ActivitySpinner: 'ActivitySpinner',
}));
vi.mock('@/components/sessions/pendingBadge', () => ({
    formatPendingCountBadge: () => null,
}));
vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));
vi.mock('@/components/sessions/canvas/useSessionSplitCanvasRowActions', () => ({
    useSessionSplitCanvasRowActions: () => splitCanvasActionState,
    useSessionSplitCanvasRowActionsForScope: () => splitCanvasActionState,
}));
vi.mock('@/components/sessions/canvas/SessionSplitCanvasDragHandle', () => ({
    SessionSplitCanvasDragHandle: (props: Record<string, unknown>) => React.createElement('SessionSplitCanvasDragHandle', props),
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
vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionStopWithServerScope: vi.fn(async () => ({ success: true })),
            sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
            sessionRename: vi.fn(async () => ({ success: true })),
        },
    });
});
vi.mock('@/utils/time/formatShortRelativeTime', () => ({
    formatShortRelativeTime: () => '1m',
}));
vi.mock('./sessionPinIcons', () => ({
    PinIcon: (props: Record<string, unknown>) => React.createElement('PinIcon', props),
    PinSlashIcon: (props: Record<string, unknown>) => React.createElement('PinSlashIcon', props),
}));
vi.mock('./sessionTagIcons', () => ({
    TagIcon: (props: Record<string, unknown>) => React.createElement('TagIcon', props),
}));

function createSession(id: string): SessionListRenderableSession {
    return {
        id,
        seq: 3,
        lastViewedSessionSeq: 2,
        latestTurnStatus: 'completed',
        createdAt: 1,
        updatedAt: 2,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 1,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

async function renderSessionItem(props: SessionItemProps) {
    const { SessionItem } = await import('./SessionItem');
    const ModelBackedSessionItem = createModelBackedSessionItemTestComponent(SessionItem);
    return renderScreen(<ModelBackedSessionItem {...props} />);
}

function findContextMenuWithItem(screen: Awaited<ReturnType<typeof renderSessionItem>>, itemId: string): ContextMenuTestInstance | null {
    return screen.root.findAll((node) => String(node.type) === 'ContextMenu').find((node) => (
        Array.isArray((node as ContextMenuTestInstance).props.items)
        && (node as ContextMenuTestInstance).props.items?.some((item) => item.id === itemId)
    )) as ContextMenuTestInstance | undefined ?? null;
}

describe('SessionItem split-canvas native context menu', () => {
    afterEach(() => {
        standardCleanup();
        splitCanvasActionState.mode = 'none';
        splitCanvasActionState.openInSplitRight.mockClear();
        splitCanvasActionState.openInSplitDown.mockClear();
        splitCanvasActionState.revealInSplit.mockClear();
    });

    it('keeps split-open entries composed into the native context menu', async () => {
        splitCanvasActionState.mode = 'open';

        const screen = await renderSessionItem({
            session: createSession('sess_split_native'),
            serverId: 'server_a',
            serverName: 'Server A',
            showServerBadge: true,
            selected: false,
            isFirst: true,
            isLast: true,
            isSingle: true,
            variant: 'default',
            compact: false,
            nativeContextMenuOpen: true,
            onNativeContextMenuOpenChange: vi.fn(),
        });

        const contextMenu = findContextMenuWithItem(screen, 'openInSplitRight');
        const itemIds = contextMenu?.props.items?.map((item) => item.id);
        expect(itemIds).toEqual(expect.arrayContaining([
            'openInSplitRight',
            'openInSplitDown',
            'rename',
            'stop',
            'archive',
        ]));

        await act(async () => {
            contextMenu?.props.onSelect?.('openInSplitDown');
        });

        expect(splitCanvasActionState.openInSplitDown).toHaveBeenCalledTimes(1);
        expect(splitCanvasActionState.openInSplitRight).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('keeps reveal-in-current-split composed into the native context menu', async () => {
        splitCanvasActionState.mode = 'reveal';

        const screen = await renderSessionItem({
            session: createSession('sess_reveal_native'),
            serverId: 'server_a',
            serverName: 'Server A',
            showServerBadge: true,
            selected: false,
            isFirst: true,
            isLast: true,
            isSingle: true,
            variant: 'default',
            compact: false,
            nativeContextMenuOpen: true,
            onNativeContextMenuOpenChange: vi.fn(),
        });

        const contextMenu = findContextMenuWithItem(screen, 'revealInCurrentSplit');
        const itemIds = contextMenu?.props.items?.map((item) => item.id);
        expect(itemIds).toContain('revealInCurrentSplit');
        expect(itemIds).not.toContain('openInSplitRight');
        expect(itemIds).not.toContain('openInSplitDown');

        await act(async () => {
            contextMenu?.props.onSelect?.('revealInCurrentSplit');
        });

        expect(splitCanvasActionState.revealInSplit).toHaveBeenCalledTimes(1);

        await screen.unmount();
    });
});
