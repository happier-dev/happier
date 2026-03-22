import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import {
    buildLegacyChatListItems,
    renderLegacyChatList,
    resetLegacyChatListHarness,
    triggerLegacyChatListScroll,
} from './ChatList.legacyListTestHarness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const loadNewerMessages = vi.fn(async () => {});
const hasDeferredNewerMessages = vi.fn(() => true);
const getSyncTuning = vi.fn(() => ({ transcriptForwardPrefetchThresholdPx: 800, transcriptBackwardPrefetchThresholdPx: 0 }));

vi.mock('@shopify/flash-list', () => ({
    FlashList: () => null,
}));

vi.mock('react-native', async () => (
    (await import('@/dev/testkit/harness/chatListHarness')).createLegacyChatListReactNativeMock({
        platformOs: 'web',
    })
));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => (
    (await import('@/dev/testkit/harness/chatListHarness')).createLegacyChatListStorageMock(importOriginal)
));

vi.mock('@/components/sessions/chatListItems', async () => (
    (await import('./ChatList.legacyListTestHarness')).createLegacyChatListItemsModuleMock(buildLegacyChatListItems)
));

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

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (p: any) => p,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        loadOlderMessages: vi.fn(),
        loadNewerMessages,
        hasDeferredNewerMessages,
        getSyncTuning,
    },
}));

describe('ChatList (forward prefetch)', () => {
    beforeEach(() => {
        resetLegacyChatListHarness({
            platformOs: 'web',
        });

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
        await renderLegacyChatList();
        await triggerLegacyChatListScroll(200);

        expect(loadNewerMessages).toHaveBeenCalledTimes(1);
        expect(loadNewerMessages).toHaveBeenCalledWith('session-1');
    });

    it('does not prefetch newer messages when scroll is outside configured threshold', async () => {
        getSyncTuning.mockReturnValue({ transcriptForwardPrefetchThresholdPx: 100, transcriptBackwardPrefetchThresholdPx: 0 });

        await renderLegacyChatList();
        await triggerLegacyChatListScroll(200);

        expect(loadNewerMessages).not.toHaveBeenCalled();
    });
});
