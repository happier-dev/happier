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
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';

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


vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
    getPermissionsInUiWhileLocal: () => ({}),
}));

// Compile the real transcript graph during collection, after installing its boundaries.
resetChatListHarness({ platformOs: 'ios' });
await import('./ChatList');

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
            sessionSurfaceKey: sessionAddressKey({ serverId: 'test-server', sessionId: 'session-1' }),
        }), { flushOptions: { cycles: 0 } });

        const legendRefHandle = chatListHarnessState.legendListRefHandle as {
            scrollToOffset: ReturnType<typeof vi.fn>;
            getState: () => { scroll: number };
            getNativeScrollRef?: () => unknown;
        };
        type Measure = (onSuccess: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => void;
        // Native measure includes the content transform; the host is at pageY 100
        // and its inner content at -100, while Legend still believes offset 0.
        const measureContent = vi.fn<Measure>((onSuccess) => onSuccess(0, 0, 600, 1200, 0, -100));
        const measureHost = vi.fn<Measure>((onSuccess) => onSuccess(0, 0, 600, 600, 0, 100));
        const innerView = { measure: measureContent };
        const scrollNode = { measure: measureHost };
        legendRefHandle.getNativeScrollRef = () => ({
            getInnerViewRef: () => innerView,
            getNativeScrollRef: () => scrollNode,
        });
        legendRefHandle.scrollToOffset.mockClear();

        // Details route push (screen blurs), then pop (screen refocuses).
        await act(async () => {
            setChatListHarnessSessionScreenFocused(false);
        });
        expect(measureContent).not.toHaveBeenCalled();
        expect(measureHost).not.toHaveBeenCalled();
        await act(async () => {
            setChatListHarnessSessionScreenFocused(true);
        });

        expect(measureContent).toHaveBeenCalledTimes(1);
        expect(measureHost).toHaveBeenCalledTimes(1);
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
            sessionSurfaceKey: sessionAddressKey({ serverId: 'test-server', sessionId: 'session-1' }),
        }), { flushOptions: { cycles: 0 } });

        const legendRefHandle = chatListHarnessState.legendListRefHandle as {
            getNativeScrollRef?: () => unknown;
        };
        const measure = vi.fn();
        legendRefHandle.getNativeScrollRef = () => ({
            getInnerViewRef: () => ({ measure }),
            getNativeScrollRef: () => ({ measure }),
        });

        // Re-assert focus without a preceding blur: no reveal transition, no revalidation.
        await act(async () => {
            setChatListHarnessSessionScreenFocused(true);
        });

        expect(measure).not.toHaveBeenCalled();

        await screen.unmount();
    });

});
