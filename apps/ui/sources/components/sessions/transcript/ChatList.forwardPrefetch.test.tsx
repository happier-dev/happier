import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import {
    buildFlashListChatListItems,
    createFlashListChatListWebScroller,
    renderFlashListChatListSession,
    resetFlashListChatListHarness,
    triggerFlashListChatListScroll,
    withFlashListChatListWebScrollerDom,
} from '@/dev/testkit/harness/chatListHarness';
import { installFlashListChatListCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const loadNewerMessages = vi.fn(async (_sessionId?: string) => {});
const hasDeferredNewerMessages = vi.fn(() => true);
const getSyncTuning = vi.fn(() => ({ transcriptForwardPrefetchThresholdPx: 800, transcriptBackwardPrefetchThresholdPx: 0 }));

installFlashListChatListCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListReactNativeMock({
            platformOs: 'web',
        }),
});

vi.mock('@/components/sessions/chatListItems', async () => (
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListItemsModuleMock(buildFlashListChatListItems)
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

const deferredNewerDrainInFlight = new Set<string>();

vi.mock('@/sync/sync', () => ({
    sync: {
        loadOlderMessages: vi.fn(),
        loadNewerMessages,
        hasDeferredNewerMessages,
        getSyncTuning,
        maybeDrainDeferredNewerMessages: (
            sessionId: string,
            viewport: { isPinned: boolean; distanceFromBottomPx: number },
        ) => {
            if (!sessionId || hasDeferredNewerMessages() !== true) return;
            const thresholdPx = getSyncTuning().transcriptForwardPrefetchThresholdPx;
            const nearBottom = viewport.isPinned || viewport.distanceFromBottomPx <= thresholdPx;
            if (!nearBottom || deferredNewerDrainInFlight.has(sessionId)) return;
            deferredNewerDrainInFlight.add(sessionId);
            void Promise.resolve(loadNewerMessages(sessionId)).catch(() => {}).finally(() => {
                deferredNewerDrainInFlight.delete(sessionId);
            });
        },
    },
}));

describe('ChatList (forward prefetch)', () => {
    beforeEach(() => {
        resetFlashListChatListHarness({
            platformOs: 'web',
        });

        deferredNewerDrainInFlight.clear();
        loadNewerMessages.mockClear();
        hasDeferredNewerMessages.mockClear();
        hasDeferredNewerMessages.mockReturnValue(true);
        getSyncTuning.mockClear();
        getSyncTuning.mockReturnValue({ transcriptForwardPrefetchThresholdPx: 800, transcriptBackwardPrefetchThresholdPx: 0 });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('loads newer messages when unpinned and near bottom and deferred newer exists', async () => {
        const scroller = createFlashListChatListWebScroller({
            clientHeight: 500,
            scrollHeight: 1000,
            scrollTop: 200,
        });
        await withFlashListChatListWebScrollerDom(scroller, async () => {
            await renderFlashListChatListSession();
            loadNewerMessages.mockClear();
            scroller.scrollTop = 200;
            await triggerFlashListChatListScroll(200);
        });

        expect(loadNewerMessages).toHaveBeenCalledTimes(1);
        expect(loadNewerMessages).toHaveBeenCalledWith('session-1');
    });

    it('does not prefetch newer messages when scroll is outside configured threshold', async () => {
        getSyncTuning.mockReturnValue({ transcriptForwardPrefetchThresholdPx: 100, transcriptBackwardPrefetchThresholdPx: 0 });

        const scroller = createFlashListChatListWebScroller({
            clientHeight: 500,
            scrollHeight: 1000,
            scrollTop: 200,
        });
        await withFlashListChatListWebScrollerDom(scroller, async () => {
            await renderFlashListChatListSession();
            loadNewerMessages.mockClear();
            scroller.scrollTop = 200;
            await triggerFlashListChatListScroll(200);
        });

        expect(loadNewerMessages).not.toHaveBeenCalled();
    });
});
