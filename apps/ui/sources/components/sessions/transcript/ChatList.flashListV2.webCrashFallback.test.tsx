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
  sessionState = { id: 'session-1', seq: 0, metadata: null, accessLevel: null, canApprovePermissions: true, presence: 'online' };
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
    FlatList: (props: any) => ReactMod.createElement('FlatList', props),
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

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
  ToolCallsGroupRow: () => React.createElement('ToolCallsGroupRow'),
}));

vi.mock('@/components/sessions/transcript/forkContext/ForkDividerRow', () => ({
  ForkDividerRow: () => React.createElement('ForkDividerRow'),
}));

vi.mock('@/components/sessions/transcript/forkContext/injectForkContextRows', () => ({
  injectForkContextRows: ({ baseItems }: any) => baseItems,
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionProvider', () => ({
  TranscriptMotionProvider: ({ children }: any) => React.createElement('TranscriptMotionProvider', null, children),
}));

vi.mock('@/components/sessions/transcript/motion/resolveTranscriptMotionConfig', () => ({
  resolveTranscriptMotionConfig: () => ({}),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
  TranscriptEnterWrapper: ({ children }: any) => React.createElement('TranscriptEnterWrapper', null, children),
}));

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
  JumpToBottomButton: () => React.createElement('JumpToBottomButton'),
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
  useReducedMotionPreference: () => false,
}));

vi.mock('@/utils/sessions/deriveTranscriptInteraction', () => ({
  deriveTranscriptInteraction: () => ({ canSendMessages: true, canApprovePermissions: true, isSessionActive: true }),
}));

describe('ChatList (FlashList v2 web crash fallback)', () => {
  it('falls back to FlatList on web when FlashList throws "not enough layouts"', async () => {
    settingValues.transcriptListImplementation = 'flash_v2';

    const globalWindowContainer = globalThis as unknown as { window?: unknown };
    const prevWindow = globalWindowContainer.window;
    const listeners = new Map<string, EventListenerOrEventListenerObject[]>();
    try {
      globalWindowContainer.window = {
        addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
          const arr = listeners.get(type) ?? [];
          arr.push(fn);
          listeners.set(type, arr);
        },
        removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
          const arr = listeners.get(type) ?? [];
          listeners.set(
            type,
            arr.filter((f) => f !== fn),
          );
        },
      };

      const { ChatList } = await import('./ChatList');

      let tree: renderer.ReactTestRenderer | null = null;
      await act(async () => {
        tree = renderer.create(<ChatList session={sessionState} />);
      });
      expect(tree).not.toBeNull();

      expect(capturedFlashListProps).toBeTruthy();
      expect(listeners.get('error')?.length ?? 0).toBeGreaterThan(0);

      const errorMessage = 'index out of bounds, not enough layouts';
      const handler = (listeners.get('error') ?? [])[0];
      expect(typeof handler).toBe('function');

      const fakeEvent = {
        message: errorMessage,
        error: new Error(errorMessage),
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
      } as unknown as ErrorEvent;

      await act(async () => {
        (handler as EventListener)(fakeEvent);
      });

      // After the crash, we should render the legacy FlatList implementation instead of FlashList.
      const flatLists = tree!.root.findAllByType('FlatList');
      expect(flatLists.length).toBeGreaterThan(0);
      expect(tree!.root.findAllByType('FlashList').length).toBe(0);
    } finally {
      globalWindowContainer.window = prevWindow;
    }
  });
});
