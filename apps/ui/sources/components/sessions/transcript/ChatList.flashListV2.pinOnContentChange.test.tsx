import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  flashListChatListHarnessState,
  renderFlashListChatList,
  resetFlashListChatListHarness,
  standardCleanup,
  withFlashListChatListWebScrollerDom,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const scrollToOffsetSpy = vi.fn();

beforeEach(() => {
  scrollToOffsetSpy.mockClear();
  resetFlashListChatListHarness({
    flashListRefHandle: { scrollToOffset: scrollToOffsetSpy, scrollToIndex: vi.fn() },
    platformOs: 'ios',
  });
  flashListChatListHarnessState.sessionMessagesState = {
    messages: [{ kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'hi' }],
    isLoaded: true,
  };
  flashListChatListHarnessState.sessionPendingState = { messages: [], discarded: [], isLoaded: true };
  flashListChatListHarnessState.sessionActionDraftsState = [];
  // Use sessionSeq=0 to avoid triggering the initial-fill effect (which pins once unconditionally).
  flashListChatListHarnessState.sessionState = {
    ...flashListChatListHarnessState.sessionState,
    id: 'session-1',
    seq: 0,
    metadata: null,
    accessLevel: null,
    canApprovePermissions: true,
  };
});

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', async () =>
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListModuleMock()
);

vi.mock('react-native', async () => (
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListReactNativeMock({ platformOs: 'ios' })
));

vi.mock('@/utils/platform/responsive', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    useHeaderHeight: () => 0,
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) =>
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListStorageMock(importOriginal)
);

vi.mock('@/components/sessions/chatListItems', async () =>
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListItemsModuleMock(({ messageIdsOldestFirst, messagesById }: any) =>
    (messageIdsOldestFirst ?? []).map((id: string) => {
      const message = messagesById?.[id];
      return { kind: 'message', id: `msg:${id}`, messageId: id, createdAt: message?.createdAt ?? 0, seq: null };
    }),
  )
);

vi.mock('./ChatFooter', () => ({
  ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
  MessageView: () => React.createElement('MessageView'),
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
  PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
  SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
  TurnView: () => React.createElement('TurnView'),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionProvider', () => ({
  TranscriptMotionProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/motion/resolveTranscriptMotionConfig', () => ({
  resolveTranscriptMotionConfig: () => ({ preset: 'off', animateThinkingEnabled: false }),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
  TranscriptEnterWrapper: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
  JumpToBottomButton: () => null,
}));

vi.mock('@/components/sessions/transcript/scroll/transcriptScrollPinController', async () => {
  const actual: any = await vi.importActual('@/components/sessions/transcript/scroll/transcriptScrollPinController');
  return actual;
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
  useReducedMotionPreference: () => false,
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
  getPermissionsInUiWhileLocal: () => ({}),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (p: any) => p,
}));

vi.mock('@/sync/sync', async () =>
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListSyncModuleMock({
    loadOlderMessages: vi.fn(),
    loadNewerMessages: vi.fn(),
  })
);

describe('ChatList (FlashList v2 pinned follow on content growth)', () => {
  afterEach(() => {
    standardCleanup();
  });

  it('pins to bottom when content size grows while pinned', async () => {
    await withFlashListChatListWebScrollerDom(
      {},
      async () => {
        const { ChatList } = await import('./ChatList');

        const screen = await renderFlashListChatList(
          <ChatList session={flashListChatListHarnessState.sessionState} />
        );

        expect(screen.getCapturedFlashListProps()).toBeTruthy();

        // Clear mount-time pin attempts; we want to assert pinning is driven by content-size growth.
        scrollToOffsetSpy.mockClear();

        await screen.triggerInitialFill({
          layoutHeight: 500,
          contentHeight: 1000,
          contentWidth: 0,
        });

        expect(scrollToOffsetSpy).toHaveBeenCalled();
        expect(scrollToOffsetSpy).toHaveBeenCalledWith({ offset: 500, animated: false });
      },
    );
  });
});
