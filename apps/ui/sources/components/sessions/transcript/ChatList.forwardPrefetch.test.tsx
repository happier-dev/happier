import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import {
    buildChatListHarnessItems,
    chatListHarnessState,
    createChatListHarnessWebScroller,
    renderChatListHarnessSession,
    resetChatListHarness,
    triggerLegendChatListScroll,
    triggerLegendChatListWheel,
    withChatListHarnessWebScrollerDom,
} from '@/dev/testkit/harness/chatListHarness';
import { installChatListHarnessCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const loadNewerMessages = vi.fn(async (_sessionId?: string) => {});
const hasDeferredNewerMessages = vi.fn(() => true);

installChatListHarnessCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessReactNativeMock({
            platformOs: 'web',
        }),
});

vi.mock('@/components/sessions/chatListItems', async () => (
    (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessItemsModuleMock(buildChatListHarnessItems)
));

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

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (p: any) => p,
}));

vi.mock('@/sync/sync', async () => (
    (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessSyncModuleMock({
        hasDeferredNewerMessages,
        loadNewerMessages,
    })
));

describe('ChatList (forward prefetch)', () => {
    beforeEach(() => {
        resetChatListHarness({
            platformOs: 'web',
            syncTuningState: { transcriptForwardPrefetchThresholdPx: 800 },
        });

        loadNewerMessages.mockClear();
        hasDeferredNewerMessages.mockClear();
        hasDeferredNewerMessages.mockReturnValue(true);
    });

    afterEach(() => {
        standardCleanup();
    });

    it('loads newer messages when unpinned and near bottom and deferred newer exists', async () => {
        const scroller = createChatListHarnessWebScroller({
            clientHeight: 500,
            scrollHeight: 1000,
            scrollTop: 200,
        });
        await withChatListHarnessWebScrollerDom(scroller, async () => {
            await renderChatListHarnessSession();
            loadNewerMessages.mockClear();
            scroller.scrollTop = 200;
            await triggerLegendChatListScroll(200);
        });

        expect(loadNewerMessages).toHaveBeenCalledTimes(1);
        expect(loadNewerMessages).toHaveBeenCalledWith('session-1');
    });

    it('does not prefetch newer messages when scroll is outside configured threshold', async () => {
        resetChatListHarness({
            platformOs: 'web',
            syncTuningState: { transcriptForwardPrefetchThresholdPx: 100 },
        });
        hasDeferredNewerMessages.mockReturnValue(true);

        const scroller = createChatListHarnessWebScroller({
            clientHeight: 500,
            scrollHeight: 1000,
            scrollTop: 200,
        });
        await withChatListHarnessWebScrollerDom(scroller, async () => {
            await renderChatListHarnessSession();
            // Detach from the tail first (user wheel + scroll): the pinned case is allowed to
            // drain regardless of distance, so the threshold contract needs an unpinned viewport.
            chatListHarnessState.legendListState = {
                contentLength: 1000,
                scrollLength: 500,
                scroll: 200,
                isAtEnd: false,
                isNearEnd: false,
                isWithinMaintainScrollAtEndThreshold: false,
            };
            await triggerLegendChatListWheel(-100, { turns: 1 });
            await triggerLegendChatListScroll(200, {}, { turns: 1 });
            loadNewerMessages.mockClear();
            scroller.scrollTop = 200;
            await triggerLegendChatListScroll(199, {}, { turns: 1 });
        });

        expect(loadNewerMessages).not.toHaveBeenCalled();
    });
});
