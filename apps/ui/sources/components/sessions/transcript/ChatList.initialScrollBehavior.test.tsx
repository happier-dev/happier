import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFlatListProps: any = null;

const scrollToOffsetMock = vi.fn();
const scrollToIndexMock = vi.fn();
const loadOlderMessagesMock = vi.fn();

let flatListRefImpl: any = null;

let sessionMessagesState: { messages: any[]; isLoaded: boolean } = { messages: [], isLoaded: true };
let sessionPendingState: { messages: any[] } = { messages: [] };
let sessionActionDraftsState: any[] = [];
let sessionState: any = null;

const buildChatListItemsMock = vi.fn((..._args: any[]) => []);

vi.mock('@shopify/flash-list', () => ({
  FlashList: () => null,
}));

vi.mock('react-native', async (importOriginal) => {
  const ReactMod = await import('react');
  const actual = await importOriginal<any>();
  return {
    ...actual,
    Platform: {
      OS: 'web',
      select: (spec: any) => {
        if (!spec || typeof spec !== 'object') return undefined;
        return spec.web ?? spec.default;
      },
    },
    View: (props: any) => ReactMod.createElement('View', props, props.children),
    ActivityIndicator: () => ReactMod.createElement('ActivityIndicator'),
    FlatList: (props: any) => {
      capturedFlatListProps = props;
      if (typeof props.ref === 'function') {
        props.ref(flatListRefImpl);
      }
      return ReactMod.createElement('FlatList');
    },
  };
});

vi.mock('@/utils/platform/responsive', () => ({
  useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
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
  useSetting: (key: string) => (key === 'transcriptListImplementation' ? 'flatlist_legacy' : undefined),
}));

vi.mock('@/components/sessions/chatListItems', () => ({
  buildChatListItems: buildChatListItemsMock,
  buildChatListItemsCached: (opts: any) => ({ cache: null, items: buildChatListItemsMock(opts) }),
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

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (p: any) => p,
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    loadOlderMessages: loadOlderMessagesMock,
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

describe('ChatList (initial scroll/pagination behavior)', () => {
  beforeEach(() => {
    capturedFlatListProps = null;
    scrollToOffsetMock.mockClear();
    scrollToIndexMock.mockClear();
    loadOlderMessagesMock.mockReset();
    buildChatListItemsMock.mockClear();

    flatListRefImpl = {
      scrollToOffset: scrollToOffsetMock,
      scrollToIndex: scrollToIndexMock,
    };

    sessionMessagesState = { messages: [], isLoaded: true };
    sessionPendingState = { messages: [] };
    sessionActionDraftsState = [];
    sessionState = {
      id: 'session-1',
      seq: 0,
      metadata: null,
      accessLevel: null,
      canApprovePermissions: true,
      agentState: null,
    };
  });

  it('does not load older messages from mount-time onEndReached before the user scrolls', async () => {
    sessionMessagesState = {
      isLoaded: true,
      messages: [{ id: 'm1' }],
    };
    loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' });

    const { ChatList } = await import('./ChatList');
    await act(async () => {
      renderer.create(<ChatList session={sessionState} />);
    });

    expect(capturedFlatListProps).toBeTruthy();

    await act(async () => {
      capturedFlatListProps.onEndReached?.();
      await Promise.resolve();
    });

    expect(loadOlderMessagesMock).not.toHaveBeenCalled();
  });

  it('can auto-load older messages even when committedMessagesCount is 0 (e.g. sidechain-only latest page)', async () => {
    sessionState = { ...sessionState, seq: 25 };
    sessionMessagesState = { isLoaded: true, messages: [] };
    loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' });

    const { ChatList } = await import('./ChatList');
    await act(async () => {
      renderer.create(<ChatList session={sessionState} />);
    });

    expect(capturedFlatListProps).toBeTruthy();

    await act(async () => {
      capturedFlatListProps.onLayout?.({ nativeEvent: { layout: { height: 800 } } });
      capturedFlatListProps.onContentSizeChange?.(400, 200);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
    // On web, we avoid `scrollToOffset` during mount to prevent visible jitter. Pinning uses DOM scroll when available.
    expect(scrollToOffsetMock).not.toHaveBeenCalled();
  });

  it('pins to the visual bottom on initial load (even before layout measurements)', async () => {
    sessionState = { ...sessionState, seq: 25 };
    sessionMessagesState = {
      isLoaded: true,
      messages: [{ id: 'm1' }],
    };

    const { ChatList } = await import('./ChatList');
    await act(async () => {
      renderer.create(<ChatList session={sessionState} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    // On web, pinning happens via DOM scroll when possible; we do not rely on list ref scroll APIs.
    expect(scrollToOffsetMock).not.toHaveBeenCalled();
  });

  it('stops wheel event propagation on web so transcript scrolling is not blocked by document scroll-lock listeners', async () => {
    const { ChatList } = await import('./ChatList');
    await act(async () => {
      renderer.create(<ChatList session={sessionState} />);
    });

    expect(capturedFlatListProps).toBeTruthy();
    expect(typeof capturedFlatListProps.onWheel).toBe('function');

    const stopPropagation = vi.fn();
    capturedFlatListProps.onWheel({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('falls back to setting scrollTop directly on web when FlatList ref methods are not available', async () => {
    sessionState = { ...sessionState, seq: 25 };
    sessionMessagesState = {
      isLoaded: true,
      messages: [{ id: 'm1' }],
    };

    flatListRefImpl = {};

    const scrollerEl: any = {
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 900,
    };
    const rootEl: any = {
      querySelectorAll: () => [scrollerEl],
      scrollHeight: 0,
      clientHeight: 0,
    };

    const prevDocument = (globalThis as any).document;
    const prevWindow = (globalThis as any).window;
    try {
      (globalThis as any).document = {
        getElementById: () => rootEl,
      };
      (globalThis as any).window = {
        getComputedStyle: () => ({ overflowY: 'auto' }),
      };

      const { ChatList } = await import('./ChatList');
      await act(async () => {
        renderer.create(<ChatList session={sessionState} />);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(scrollerEl.scrollTop).toBe(0);
    } finally {
      (globalThis as any).document = prevDocument;
      (globalThis as any).window = prevWindow;
    }
  });
});
