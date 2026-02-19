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

const buildChatListItemsMock = vi.fn(() => []);

vi.mock('react-native', async (importOriginal) => {
  const ReactMod = await import('react');
  const actual = await importOriginal<any>();
  return {
    ...actual,
    Platform: { OS: 'web' },
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
  useSession: () => sessionState,
  useSessionMessages: () => sessionMessagesState,
  useSessionPendingMessages: () => sessionPendingState,
  useSessionActionDrafts: () => sessionActionDraftsState,
}));

vi.mock('@/components/sessions/chatListItems', () => ({
  buildChatListItems: (...args: any[]) => buildChatListItemsMock(...args),
}));

vi.mock('./ChatFooter', () => ({
  ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
  MessageView: () => React.createElement('MessageView'),
}));

vi.mock('@/components/sessions/pending/PendingUserTextMessageView', () => ({
  PendingUserTextMessageView: () => React.createElement('PendingUserTextMessageView'),
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
    loadOlderMessages: (...args: any[]) => loadOlderMessagesMock(...args),
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
    expect(scrollToOffsetMock).toHaveBeenCalledWith({ offset: 0, animated: false });
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

    expect(scrollToOffsetMock).toHaveBeenCalledWith({ offset: 0, animated: false });
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
