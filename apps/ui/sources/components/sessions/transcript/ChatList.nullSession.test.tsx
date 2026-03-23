import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, it, expect, vi } from 'vitest';

import { createSessionMessagesFixture, createStorageStoreMock, renderScreen } from '@/dev/testkit';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@shopify/flash-list', () => ({
    FlashList: () => null,
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
});
