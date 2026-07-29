import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionMessagesFixture, createStorageStoreMock, renderScreen } from '@/dev/testkit';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The Legend renderer (default transcript renderer) schedules landing verification through
// requestAnimationFrame; this suite's bare environment does not provide one.
if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (callback: (time: number) => void) => (
        setTimeout(() => callback(Date.now()), 0) as unknown as number
    );
    (globalThis as any).cancelAnimationFrame = (handle: number) => {
        clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    };
}

const chatFooterPropsSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

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

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            FlatList: (props: any) =>
                React.createElement(
                    'FlatList',
                    null,
                    props.ListHeaderComponent ?? null,
                    props.ListFooterComponent ?? null,
                ),
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
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
            // The footer reads its banner state through this store hook (in-flight wave);
            // the testkit default stubs it to null, which hides the footer entirely.
            useSessionChatFooterState: () => ({
                controlledByUser: true,
                localControl: null,
                permissionsInUiWhileLocal: {},
            }),
            useSessionLatestThinkingMessageId: () => null,
            useSessionLatestThinkingMessageActivityAtMs: () => null,
            useMessage: () => null,
            useSetting: () => undefined,
        });
    },
});

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

describe('ChatList footer control override', () => {
    afterEach(() => {
        resetTranscriptCommonModuleMockState();
    });

    it('prefers the explicit controlledByUser override for the footer banner state', async () => {
        const { ChatList } = await import('./ChatList');

        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(<ChatList
                    session={session}
                    controlledByUserOverride={false}
                    onRequestSwitchToRemote={undefined}
                    externalControlFooter={null}
                />)).tree;

        expect(chatFooterPropsSpy).toHaveBeenCalled();
        expect(chatFooterPropsSpy.mock.calls.at(-1)?.[0]?.controlledByUser).toBe(false);

        act(() => {
            tree?.unmount();
        });
    });
});
