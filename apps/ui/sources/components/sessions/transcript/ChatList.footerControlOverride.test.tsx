import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createPartialStorageModuleMock, createSessionMessagesFixture, createStorageStoreMock, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const chatFooterPropsSpy = vi.hoisted(() => vi.fn());

vi.mock('@shopify/flash-list', () => ({
    FlashList: () => null,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            FlatList: (props: any) =>
                                    React.createElement(
                                        'FlatList',
                                        null,
                                        props.ListHeaderComponent ?? null,
                                        props.ListFooterComponent ?? null,
                                    ),
                        }
    );
});

const session = {
    id: 'session-1',
    metadata: null,
    accessLevel: 'edit',
    canApprovePermissions: true,
    agentState: {
        controlledByUser: true,
        capabilities: null,
    },
} as any;

vi.mock('@/sync/domains/state/storage', async (importOriginal) =>
    await createPartialStorageModuleMock(importOriginal, {
        getStorage: () => createStorageStoreMock({
            sessionMessages: {
                'session-1': createSessionMessagesFixture(),
            },
        }),
        useSession: () => session,
        useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
        useSessionMessagesById: () => ({}),
        useForkedTranscriptSnapshot: () => null,
        useSessionPendingMessages: () => ({ messages: [], discarded: [], isLoaded: false }),
        useSessionActionDrafts: () => ([]),
        useSessionLatestThinkingMessageId: () => null,
        useSessionLatestThinkingMessageActivityAtMs: () => null,
        useMessage: () => null,
        useSetting: (key: string) => (key === 'transcriptListImplementation' ? 'flatlist_legacy' : undefined),
    }),
);

vi.mock('@/components/sessions/chatListItems', () => ({
    buildChatListItems: () => [],
    buildChatListItemsCached: () => ({ cache: null, items: [] }),
}));

vi.mock('./ChatFooter', () => ({
    ChatFooter: (props: any) => {
        chatFooterPropsSpy(props);
        return React.createElement('ChatFooter', props);
    },
}));

vi.mock('./MessageView', () => ({
    MessageView: () => React.createElement('MessageView'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: () => React.createElement('TurnView'),
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

describe('ChatList footer control override', () => {
    it('prefers the explicit controlledByUser override for the footer banner state', async () => {
        const { ChatList } = await import('./ChatList');

        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(<ChatList
                    session={session}
                    controlledByUserOverride={false}
                    onRequestSwitchToRemote={undefined}
                    directControlFooter={null}
                />)).tree;

        expect(chatFooterPropsSpy).toHaveBeenCalled();
        expect(chatFooterPropsSpy.mock.calls.at(-1)?.[0]?.controlledByUser).toBe(false);

        act(() => {
            tree?.unmount();
        });
    });
});
