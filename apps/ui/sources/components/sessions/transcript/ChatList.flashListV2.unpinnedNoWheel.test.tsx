import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFlashListProps: any = null;

let sessionMessagesState: { messages: any[]; isLoaded: boolean } = { messages: [], isLoaded: true };
let sessionPendingState: { messages: any[] } = { messages: [] };
let sessionActionDraftsState: any[] = [];
let sessionState: any = null;

const settingValues: Record<string, any> = {};

beforeEach(() => {
  capturedFlashListProps = null;
  sessionMessagesState = {
    messages: [{ kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'hi' }],
    isLoaded: true,
  };
  sessionPendingState = { messages: [] };
  sessionActionDraftsState = [];
  // Use sessionSeq=0 to avoid triggering the initial-fill effect (pins unconditionally).
  sessionState = { id: 'session-1', seq: 0, metadata: null, accessLevel: null, canApprovePermissions: true };
  Object.keys(settingValues).forEach((k) => delete settingValues[k]);
});

vi.mock('@shopify/flash-list', () => ({
  FlashList: React.forwardRef((props: any, ref: any) => {
    capturedFlashListProps = props;
    const handle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
    if (typeof ref === 'function') ref(handle);
    else if (ref && typeof ref === 'object') ref.current = handle;
    return React.createElement('FlashList');
  }),
}));

vi.mock('react-native', async () => {
  const stub = await import('@/dev/reactNativeStub');
  const ReactMod = await import('react');
  return {
    ...stub,
    Platform: { OS: 'web', select: (values: any) => values?.web ?? values?.default },
    View: (props: any) => ReactMod.createElement('View', props, props.children),
    Pressable: ({ children, ...props }: any) => ReactMod.createElement('Pressable', props, children),
    ActivityIndicator: () => ReactMod.createElement('ActivityIndicator'),
    FlatList: () => ReactMod.createElement('FlatList'),
  };
});

vi.mock('@/utils/platform/responsive', () => ({
  useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useSession: () => sessionState,
  useSessionTranscriptIds: () => ({
    ids: (sessionMessagesState.messages ?? []).map((m: any) => m.id),
    isLoaded: sessionMessagesState.isLoaded,
  }),
  useSessionMessagesById: () => Object.fromEntries((sessionMessagesState.messages ?? []).map((m: any) => [m.id, m])),
  useForkedTranscriptSnapshot: () => null,
  useSessionPendingMessages: () => sessionPendingState,
  useSessionActionDrafts: () => sessionActionDraftsState,
  useSessionLatestThinkingMessageId: () => null,
  useSessionLatestThinkingMessageActivityAtMs: () => null,
  useMessage: () => null,
  useSetting: (key: string) => settingValues[key],
  getStorage: () => ({
    getState: () => ({
      sessionMessages: {
        [sessionState?.id ?? 'session-1']: {
          messagesById: Object.fromEntries((sessionMessagesState.messages ?? []).map((m: any) => [m.id, m])),
          messagesMap: Object.fromEntries((sessionMessagesState.messages ?? []).map((m: any) => [m.id, m])),
        },
      },
    }),
  }),
}));

vi.mock('@/components/sessions/chatListItems', () => ({
  buildChatListItems: ({ messageIdsOldestFirst, messagesById }: any) =>
    (messageIdsOldestFirst ?? []).map((id: string) => {
      const m = messagesById?.[id];
      return { kind: 'message', id: `msg:${id}`, messageId: id, createdAt: m?.createdAt ?? 0, seq: null };
    }),
  buildChatListItemsCached: (opts: any) => ({
    cache: null,
    items: (opts?.messageIdsOldestFirst ?? []).map((id: string) => {
      const m = opts?.messagesById?.[id];
      return { kind: 'message', id: `msg:${id}`, messageId: id, createdAt: m?.createdAt ?? 0, seq: null };
    }),
  }),
}));

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

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
  useReducedMotionPreference: () => false,
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
    loadNewerMessages: vi.fn(),
    hasDeferredNewerMessages: () => false,
    getSyncTuning: () => ({
      transcriptForwardPrefetchThresholdPx: 0,
      transcriptFlashListEstimatedItemSize: 120,
      transcriptWebInitialPinStabilizeMs: 3000,
      transcriptWebInitialPinRetryIntervalMs: 250,
    }),
  },
}));

describe('ChatList (FlashList v2, web) scroll pin intent without wheel events', () => {
  it('does not auto-repin on content size change after a large scroll away from bottom (scrollbar drag scenario)', async () => {
    // Set up transcript settings.
    settingValues.transcriptListImplementation = 'flash_v2';
    settingValues.transcriptScrollPinEnabled = true;
    settingValues.transcriptScrollAutoFollowWhenPinned = true;
    settingValues.transcriptScrollPinOffsetThresholdPx = 100;

    const scrollerEl: any = {
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 1500, // bottom (2000 - 500)
      isConnected: true,
    };

    const prevDocument = (globalThis as any).document;
    const prevWindow = (globalThis as any).window;
    const prevRaf = (globalThis as any).requestAnimationFrame;
    const prevCaf = (globalThis as any).cancelAnimationFrame;
    try {
      (globalThis as any).requestAnimationFrame = (cb: any) => {
        cb(0);
        return 1;
      };
      (globalThis as any).cancelAnimationFrame = () => {};
      (globalThis as any).document = {
        querySelector: () => scrollerEl,
        getElementById: () => ({ querySelectorAll: () => [scrollerEl] }),
      };
      (globalThis as any).window = {
        getComputedStyle: () => ({ overflowY: 'auto' }),
      };

      const { ChatList } = await import('./ChatList');

      await act(async () => {
        renderer.create(<ChatList session={sessionState} />);
      });

      expect(capturedFlashListProps).toBeTruthy();

      // Provide layout + content size so distance-from-bottom calculations work.
      await act(async () => {
        capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 500 } } });
        capturedFlashListProps.onContentSizeChange?.(0, 2000);
      });

      // Simulate an initial pinned scroll event (at bottom).
      await act(async () => {
        capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 1500 } } });
      });

      // Scrollbar drags begin with a pointer interaction on web (no wheel handler invoked).
      await act(async () => {
        capturedFlashListProps.onPointerDown?.({});
      });

      // Simulate a large scroll away from bottom via scrollbar drag (no wheel handler invoked).
      scrollerEl.scrollTop = 1000;
      await act(async () => {
        capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 1000 } } });
      });

      const scrollTopAfterUnpin = scrollerEl.scrollTop;

      // Content grows while user is away from bottom. We should NOT pin back to bottom.
      scrollerEl.scrollHeight = 2400;
      await act(async () => {
        capturedFlashListProps.onContentSizeChange?.(0, 2400);
      });

      expect(scrollerEl.scrollTop).toBe(scrollTopAfterUnpin);
    } finally {
      (globalThis as any).document = prevDocument;
      (globalThis as any).window = prevWindow;
      (globalThis as any).requestAnimationFrame = prevRaf;
      (globalThis as any).cancelAnimationFrame = prevCaf;
    }
  });

  it('treats trusted scroll events as user intent so a small scroll away from bottom does not get re-pinned during initial stabilization', async () => {
    settingValues.transcriptListImplementation = 'flash_v2';
    settingValues.transcriptScrollPinEnabled = true;
    settingValues.transcriptScrollAutoFollowWhenPinned = true;
    settingValues.transcriptScrollPinOffsetThresholdPx = 100;

    const scrollerEl: any = {
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 1500, // bottom (2000 - 500)
      isConnected: true,
    };

    const prevDocument = (globalThis as any).document;
    const prevWindow = (globalThis as any).window;
    const prevRaf = (globalThis as any).requestAnimationFrame;
    const prevCaf = (globalThis as any).cancelAnimationFrame;
    try {
      (globalThis as any).requestAnimationFrame = (cb: any) => {
        cb(0);
        return 1;
      };
      (globalThis as any).cancelAnimationFrame = () => {};
      (globalThis as any).document = {
        querySelector: () => scrollerEl,
        getElementById: () => ({ querySelectorAll: () => [scrollerEl] }),
      };
      (globalThis as any).window = {
        getComputedStyle: () => ({ overflowY: 'auto' }),
      };

      const { ChatList } = await import('./ChatList');

      await act(async () => {
        renderer.create(<ChatList session={sessionState} />);
      });

      expect(capturedFlashListProps).toBeTruthy();

      await act(async () => {
        capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 500 } } });
        capturedFlashListProps.onContentSizeChange?.(0, 2000);
      });

      // Start at bottom.
      await act(async () => {
        capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 1500 }, isTrusted: true } });
      });

      // User scrolls up slightly (within the pinned threshold), without wheel/pointer events.
      scrollerEl.scrollTop = 1480;
      await act(async () => {
        capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 1480 }, isTrusted: true } });
      });
      const scrollTopAfterSmallScroll = scrollerEl.scrollTop;

      // Content grows. If we incorrectly consider this still "pinned", we would snap back to bottom.
      scrollerEl.scrollHeight = 2400;
      await act(async () => {
        capturedFlashListProps.onContentSizeChange?.(0, 2400);
      });

      expect(scrollerEl.scrollTop).toBe(scrollTopAfterSmallScroll);
    } finally {
      (globalThis as any).document = prevDocument;
      (globalThis as any).window = prevWindow;
      (globalThis as any).requestAnimationFrame = prevRaf;
      (globalThis as any).cancelAnimationFrame = prevCaf;
    }
  });
});
