import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, it, expect, vi } from 'vitest';

import { createSessionMessagesFixture, createStorageStoreMock, renderScreen } from '@/dev/testkit';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: React.forwardRef((props: any, ref: any) => {
        if (ref && typeof ref === 'object') {
            ref.current = { scrollToIndex: vi.fn(), scrollToOffset: vi.fn() };
        }
        const header =
            typeof props.ListHeaderComponent === 'function' ? props.ListHeaderComponent() : props.ListHeaderComponent;
        const footer =
            typeof props.ListFooterComponent === 'function' ? props.ListFooterComponent() : props.ListFooterComponent;
        return React.createElement('FlashList', props, header, footer);
    }),
    LayoutCommitObserver: ({ children, onCommitLayoutEffect }: any) => {
        React.useLayoutEffect(() => {
            onCommitLayoutEffect?.();
        });
        return React.createElement(React.Fragment, null, children);
    },
    useLayoutState: <T,>(initialValue: T) => React.useState(initialValue),
    useMappingHelper: () => ({
        getMappingKey: (_key: string | number, index: number) => index,
    }),
    useRecyclingState: <T,>(initialValue: T, dependencies: readonly unknown[], onReset?: () => void) => {
        const [state, setState] = React.useState(initialValue);
        React.useEffect(() => {
            setState(initialValue);
            onReset?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
        }, dependencies);
        return [state, setState] as const;
    },
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            FlatList: (props: any) => {
                // Render ListHeaderComponent so ListFooter executes (this is where the null session crash happened).
                return React.createElement('FlatList', null, props.ListHeaderComponent ?? null);
            },
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            getStorage: () => createStorageStoreMock({
                sessionMessages: {
                    'session-1': createSessionMessagesFixture(),
                },
            }),
            useSession: () => null,
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionMessagesById: () => ({}),
            useForkedTranscriptSnapshot: () => null,
            useSessionPendingMessages: () => ({ messages: [], discarded: [], isLoaded: false }),
            useSessionActionDrafts: () => ([]),
            useSessionLatestThinkingMessageId: () => null,
            useSessionLatestThinkingMessageActivityAtMs: () => null,
            useMessage: () => null,
            useSetting: (key: string) => (key === 'transcriptListImplementation' ? 'flatlist_legacy' : undefined),
        });
    },
});

vi.mock('@/components/sessions/chatListItems', () => ({
    buildChatListItems: () => [],
    buildChatListItemsCached: () => ({ cache: null, items: [] }),
}));

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
    MessageView: () => React.createElement('MessageView'),
    MessageViewWithSessionCommon: () => React.createElement('MessageView'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: () => React.createElement('TurnView'),
    TurnViewWithSessionCommon: () => React.createElement('TurnView'),
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
    PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
    SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
    getPermissionsInUiWhileLocal: () => ({}),
}));

describe('ChatList', () => {
    afterEach(() => {
        resetTranscriptCommonModuleMockState();
    });

    it('does not crash when useSession(sessionId) returns null in ListFooter', async () => {
        const { ChatList } = await import('./ChatList');

        const session = {
            id: 'session-1',
            metadata: null,
            accessLevel: null,
            canApprovePermissions: true,
        } as any;

        let tree: renderer.ReactTestRenderer | undefined;
        let thrown: unknown;
        try {
            tree = (await renderScreen(<ChatList session={session} />)).tree;
        } catch (error) {
            thrown = error;
        } finally {
            act(() => {
                tree?.unmount();
            });
        }

        expect(thrown).toBeUndefined();
    });

    it('keeps the transcript root shrinkable inside constrained split panes', async () => {
        const { ChatList } = await import('./ChatList');

        const session = {
            id: 'session-1',
            metadata: null,
            accessLevel: null,
            canApprovePermissions: true,
        } as any;

        const screen = await renderScreen(<ChatList session={session} />);

        const flashList = screen.tree.root.findByType('FlashList');
        const transcriptRoot = findAncestorWithStyle(flashList, (style) => {
            return (
                style != null &&
                typeof style === 'object' &&
                'flex' in style &&
                'minWidth' in style &&
                'overflow' in style
            );
        });

        expect(transcriptRoot?.props?.style).toEqual(
            expect.objectContaining({
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                overflow: 'hidden',
            }),
        );
    });
});

function findAncestorWithStyle(
    node: { parent?: { parent?: unknown; props?: { style?: unknown } } | null } | null | undefined,
    predicate: (style: unknown) => boolean,
) {
    let current = node?.parent ?? null;
    while (current) {
        const style = current.props?.style;
        if (predicate(style)) return current;
        if (Array.isArray(style) && style.some((entry) => predicate(entry))) return current;
        current = current.parent ?? null;
    }
    return null;
}
