import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFlashListProps: any = null;
const scrollToOffsetSpy = vi.fn();

let sessionMessagesState: { messages: any[]; isLoaded: boolean } = { messages: [], isLoaded: true };
let sessionPendingState: { messages: any[] } = { messages: [] };
let sessionActionDraftsState: any[] = [];
let sessionState: any = null;

const settingValues: Record<string, any> = {};

beforeEach(() => {
  capturedFlashListProps = null;
  scrollToOffsetSpy.mockClear();
  sessionMessagesState = {
    messages: [{ kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'hi' }],
    isLoaded: true,
  };
  sessionPendingState = { messages: [] };
  sessionActionDraftsState = [];
  // Use sessionSeq=0 to avoid triggering the initial-fill effect (which pins once unconditionally).
  sessionState = { id: 'session-1', seq: 0, metadata: null, accessLevel: null, canApprovePermissions: true };
  Object.keys(settingValues).forEach((k) => delete settingValues[k]);
});

vi.mock('@shopify/flash-list', () => ({
  FlashList: React.forwardRef((props: any, ref: any) => {
    capturedFlashListProps = props;
    const handle = { scrollToOffset: scrollToOffsetSpy, scrollToIndex: vi.fn() };
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
    Platform: { OS: 'ios', select: (values: any) => values?.ios ?? values?.default },
    View: (props: any) => ReactMod.createElement('View', props, props.children),
    Pressable: ({ children, ...props }: any) => ReactMod.createElement('Pressable', props, children),
    ActivityIndicator: () => ReactMod.createElement('ActivityIndicator'),
    FlatList: () => ReactMod.createElement('FlatList'),
  };
});

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

describe('ChatList (FlashList v2 pinned follow on content growth)', () => {
  it('pins to bottom when content size grows while pinned', async () => {
    const raf = (cb: any) => {
      cb(0);
      return 1;
    };
    (globalThis as any).requestAnimationFrame = raf;
    (globalThis as any).cancelAnimationFrame = () => {};

    const { ChatList } = await import('./ChatList');

    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(<ChatList session={sessionState} />);
    });

    expect(capturedFlashListProps).toBeTruthy();

    // Clear mount-time pin attempts; we want to assert pinning is driven by content-size growth.
    scrollToOffsetSpy.mockClear();

    await act(async () => {
      capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 500 } } });
      capturedFlashListProps.onContentSizeChange?.(0, 1000);
    });

    expect(scrollToOffsetSpy).toHaveBeenCalled();
    expect(scrollToOffsetSpy).toHaveBeenCalledWith({ offset: 500, animated: false });

    act(() => {
      tree?.unmount();
    });
  });
});
