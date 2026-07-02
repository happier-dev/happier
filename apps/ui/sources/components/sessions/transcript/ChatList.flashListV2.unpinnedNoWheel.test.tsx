import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  flashListChatListHarnessState,
  renderFlashListChatList,
  resetFlashListChatListHarness,
  standardCleanup,
  withFlashListChatListWebScrollerDom,
} from '@/dev/testkit';
import {
  installTranscriptCommonModuleMocks,
  resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installTranscriptCommonModuleMocks({
  reactNative: async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListReactNativeMock({
      platformOs: 'web',
    }),
  storage: async (importOriginal) =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListStorageMock(importOriginal),
});

beforeEach(() => {
  resetTranscriptCommonModuleMockState();
  resetFlashListChatListHarness({ platformOs: 'web' });
  flashListChatListHarnessState.sessionMessagesState = {
    messages: [{ kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'hi' }],
    isLoaded: true,
  };
  flashListChatListHarnessState.sessionPendingState = { messages: [], discarded: [], isLoaded: true };
  flashListChatListHarnessState.sessionActionDraftsState = [];
  // Use sessionSeq=0 to avoid triggering the initial-fill effect (pins unconditionally).
  flashListChatListHarnessState.sessionState = {
    ...flashListChatListHarnessState.sessionState,
    id: 'session-1',
    seq: 0,
    metadata: null,
    accessLevel: null,
    canApprovePermissions: true,
  };
});

afterEach(() => {
  resetTranscriptCommonModuleMockState();
  standardCleanup();
});

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', async () =>
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListModuleMock()
);

vi.mock('@/utils/platform/responsive', () => ({
  useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

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
  MessageViewWithSessionCommon: () => React.createElement('MessageView'),
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
  PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
  SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
  TurnView: () => React.createElement('TurnView'),
  TurnViewWithSessionCommon: () => React.createElement('TurnView'),
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
    loadOlderMessages: vi.fn(async () => ({ loaded: 0, hasMore: false, status: 'no_more' as const })),
    loadNewerMessages: vi.fn(),
  })
);

describe('ChatList (FlashList v2, web) scroll pin intent without wheel events', () => {
  it('does not auto-repin on content size change after a large scroll away from bottom (scrollbar drag scenario)', async () => {
    // Set up transcript settings.
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 100;

    const scrollerEl: any = {
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 1500, // bottom (2000 - 500)
      isConnected: true,
    };

    await withFlashListChatListWebScrollerDom(scrollerEl, async () => {
      const { ChatList } = await import('./ChatList');

      const screen = await renderFlashListChatList(
        <ChatList session={flashListChatListHarnessState.sessionState} />
      );

      expect(screen.getCapturedFlashListProps()).toBeTruthy();

      // Provide layout + content size so distance-from-bottom calculations work.
      await screen.triggerInitialFill({
        layoutHeight: 500,
        contentHeight: 2000,
        contentWidth: 0,
      });

      // Simulate an initial pinned scroll event (at bottom).
      await screen.triggerScroll(1500);

      // Scrollbar drags begin with a pointer interaction on web (no wheel handler invoked).
      await screen.triggerPointerDown();

      // Simulate a large scroll away from bottom via scrollbar drag (no wheel handler invoked).
      scrollerEl.scrollTop = 1000;
      await screen.triggerScroll(1000);

      const scrollTopAfterUnpin = scrollerEl.scrollTop;

      // Content grows while user is away from bottom. We should NOT pin back to bottom.
      scrollerEl.scrollHeight = 2400;
      await screen.triggerContentSizeChange(0, 2400);

      expect(scrollerEl.scrollTop).toBe(scrollTopAfterUnpin);
    });
  });

  it('unpins on sustained non-programmatic upward movement within the pin threshold (scrollbar/keyboard, plan E3)', async () => {
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 100;

    const scrollerEl: any = {
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 1500, // bottom (2000 - 500)
      isConnected: true,
    };

    await withFlashListChatListWebScrollerDom(scrollerEl, async () => {
      const { ChatList } = await import('./ChatList');

      const screen = await renderFlashListChatList(
        <ChatList session={flashListChatListHarnessState.sessionState} />
      );

      expect(screen.getCapturedFlashListProps()).toBeTruthy();

      await screen.triggerInitialFill({
        layoutHeight: 500,
        contentHeight: 2000,
        contentWidth: 0,
      });

      // Establish the bottom baseline.
      await screen.triggerScroll(1500);

      // Scrollbar drag / keyboard scroll: two consecutive non-trusted upward frames with
      // NO wheel/pointer/touch handler involvement, both still within the pin threshold.
      scrollerEl.scrollTop = 1460;
      await screen.triggerScroll(1460);
      scrollerEl.scrollTop = 1430;
      await screen.triggerScroll(1430);

      const scrollTopAfterSustainedUpwardMovement = scrollerEl.scrollTop;

      // Content grows. Sustained upward movement mirrored the wheel unpin path, so the
      // viewport must NOT be pulled back to the bottom.
      scrollerEl.scrollHeight = 2400;
      await screen.triggerContentSizeChange(0, 2400);

      expect(scrollerEl.scrollTop).toBe(scrollTopAfterSustainedUpwardMovement);
    });
  });

  it('keeps the pin through a single upward height-churn frame within the threshold (no sustain, plan E3)', async () => {
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 100;

    const scrollerEl: any = {
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 1500,
      isConnected: true,
    };

    await withFlashListChatListWebScrollerDom(scrollerEl, async () => {
      const { ChatList } = await import('./ChatList');

      const screen = await renderFlashListChatList(
        <ChatList session={flashListChatListHarnessState.sessionState} />
      );

      expect(screen.getCapturedFlashListProps()).toBeTruthy();

      await screen.triggerInitialFill({
        layoutHeight: 500,
        contentHeight: 2000,
        contentWidth: 0,
      });
      await screen.triggerScroll(1500);

      // A single isolated upward frame within the threshold (virtualization noise) must not
      // unpin: bottom-follow growth keeps pinning to the bottom.
      scrollerEl.scrollTop = 1470;
      await screen.triggerScroll(1470);

      scrollerEl.scrollHeight = 2400;
      await screen.triggerContentSizeChange(0, 2400);

      // Still following: growth keeps the bottom-region distance (30px) instead of leaving
      // the viewport parked at the stale offset.
      expect(scrollerEl.scrollTop).toBe(1870);
    });
  });

  it('keeps FlashList stable while scroll distance remains below the jump-to-bottom reveal threshold', async () => {
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 100;
    flashListChatListHarnessState.settingValues.transcriptScrollJumpToBottomRevealViewportRatio = 0.5;

    const scrollerEl: any = {
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 1500,
      isConnected: true,
    };

    await withFlashListChatListWebScrollerDom(scrollerEl, async () => {
      const { ChatList } = await import('./ChatList');

      const screen = await renderFlashListChatList(
        <ChatList session={flashListChatListHarnessState.sessionState} />
      );

      expect(screen.getCapturedFlashListProps()).toBeTruthy();

      await screen.triggerInitialFill({
        layoutHeight: 500,
        contentHeight: 2000,
        contentWidth: 0,
      });
      await screen.triggerScroll(1500);
      await screen.triggerPointerDown();

      scrollerEl.scrollTop = 1380;
      await screen.triggerScroll(1380);
      const rendersAfterFirstHiddenDistance = flashListChatListHarnessState.flashListRenderCount;

      scrollerEl.scrollTop = 1370;
      await screen.triggerScroll(1370);
      scrollerEl.scrollTop = 1360;
      await screen.triggerScroll(1360);

      expect(flashListChatListHarnessState.flashListRenderCount).toBe(rendersAfterFirstHiddenDistance);
    });
  });

  it('treats trusted scroll events as user intent so a small scroll away from bottom does not get re-pinned during initial stabilization', async () => {
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 100;

    const scrollerEl: any = {
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 1500, // bottom (2000 - 500)
      isConnected: true,
    };

    await withFlashListChatListWebScrollerDom(scrollerEl, async () => {
      const { ChatList } = await import('./ChatList');

      const screen = await renderFlashListChatList(
        <ChatList session={flashListChatListHarnessState.sessionState} />
      );

      expect(screen.getCapturedFlashListProps()).toBeTruthy();

      await screen.triggerInitialFill({
        layoutHeight: 500,
        contentHeight: 2000,
        contentWidth: 0,
      });

      // Start at bottom.
      await screen.triggerScroll(1500, { isTrusted: true });

      // User scrolls up slightly (within the pinned threshold), without wheel/pointer events.
      scrollerEl.scrollTop = 1480;
      await screen.triggerScroll(1480, { isTrusted: true });
      const scrollTopAfterSmallScroll = scrollerEl.scrollTop;

      // Content grows. If we incorrectly consider this still "pinned", we would snap back to bottom.
      scrollerEl.scrollHeight = 2400;
      await screen.triggerContentSizeChange(0, 2400);

      expect(scrollerEl.scrollTop).toBe(scrollTopAfterSmallScroll);
    });
  });
});
