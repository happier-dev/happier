import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { standardCleanup } from '@/dev/testkit';
import {
    buildChatListHarnessItems,
    chatListHarnessState,
    renderChatList,
    resetChatListHarness,
    setChatListHarnessSessionScreenFocused,
} from '@/dev/testkit/harness/chatListHarness';
import { installChatListHarnessCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

installChatListHarnessCommonModuleMocks();

vi.mock('@/components/sessions/chatListItems', () => ({
    buildChatListItems: buildChatListHarnessItems,
    buildChatListItemsCached: (options: Parameters<typeof buildChatListHarnessItems>[0]) => ({
        cache: null,
        items: buildChatListHarnessItems(options),
    }),
}));

vi.mock('@/sync/sync', async () => (
    (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessSyncModuleMock()
));

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
    MessageView: () => React.createElement('MessageView'),
    MessageViewWithSessionCommon: () => React.createElement('MessageViewWithSessionCommon'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: () => React.createElement('TurnView'),
    TurnViewWithSessionCommon: () => React.createElement('TurnViewWithSessionCommon'),
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

describe('ChatList native screen-reveal viewport revalidation (S-E route-pop blank)', () => {
    beforeEach(() => {
        resetChatListHarness({ platformOs: 'ios' });
        chatListHarnessState.sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'oldest', localId: null, createdAt: 1, text: 'first' },
                { kind: 'agent-text', id: 'newest', localId: null, createdAt: 2, text: 'second', isThinking: false },
            ],
        };
    });

    afterEach(() => {
        standardCleanup();
    });

    it('re-observes the natively displayed offset when the session screen regains focus', async () => {
        // Live native S-E capture (2026-07-11): a tool-details route pop revealed the
        // transcript with Legend state desynced from the native scroll position and zero
        // scroll events to re-observe — a persistent blank window until the user's first
        // swipe. On focus-return the host must ask the renderer to revalidate the viewport
        // against the natively displayed offset.
        const { ChatList } = await import('./ChatList');
        const screen = await renderChatList(React.createElement(ChatList, {
            session: { ...chatListHarnessState.sessionState },
        }), { flushOptions: { cycles: 0 } });

        const legendRefHandle = chatListHarnessState.legendListRefHandle as {
            scrollToOffset: ReturnType<typeof vi.fn>;
            getState: () => { scroll: number };
            getNativeScrollRef?: () => unknown;
        };
        const scrollNode = { id: 'scroll-node' };
        const measureLayout = vi.fn((
            relativeTo: unknown,
            onSuccess: (x: number, y: number) => void,
        ) => {
            expect(relativeTo).toBe(scrollNode);
            // Native view displays offset 200 while Legend state believes 0.
            onSuccess(0, -200);
        });
        legendRefHandle.getNativeScrollRef = () => ({
            getInnerViewNode: () => ({ measureLayout }),
            getScrollableNode: () => scrollNode,
        });
        legendRefHandle.scrollToOffset.mockClear();

        // Details route push (screen blurs), then pop (screen refocuses).
        await act(async () => {
            setChatListHarnessSessionScreenFocused(false);
        });
        expect(measureLayout).not.toHaveBeenCalled();
        await act(async () => {
            setChatListHarnessSessionScreenFocused(true);
        });

        expect(measureLayout).toHaveBeenCalledTimes(1);
        expect(legendRefHandle.scrollToOffset).toHaveBeenCalledWith({
            animated: false,
            offset: 200,
        });

        await screen.unmount();
    });

    it('does not revalidate on the initial focused mount', async () => {
        const { ChatList } = await import('./ChatList');
        const screen = await renderChatList(React.createElement(ChatList, {
            session: { ...chatListHarnessState.sessionState },
        }), { flushOptions: { cycles: 0 } });

        const legendRefHandle = chatListHarnessState.legendListRefHandle as {
            getNativeScrollRef?: () => unknown;
        };
        const measureLayout = vi.fn();
        legendRefHandle.getNativeScrollRef = () => ({
            getInnerViewNode: () => ({ measureLayout }),
            getScrollableNode: () => ({ id: 'scroll-node' }),
        });

        // Re-assert focus without a preceding blur: no reveal transition, no revalidation.
        await act(async () => {
            setChatListHarnessSessionScreenFocused(true);
        });

        expect(measureLayout).not.toHaveBeenCalled();

        await screen.unmount();
    });

});
