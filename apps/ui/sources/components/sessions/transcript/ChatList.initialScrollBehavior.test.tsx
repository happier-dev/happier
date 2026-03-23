import * as React from 'react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import {
  flushLegacyChatListEffects,
  legacyChatListHarnessState,
  renderLegacyChatList,
  requireCapturedFlatListProps,
  resetLegacyChatListHarness,
  triggerLegacyChatListEndReached,
  triggerLegacyChatListInitialFill,
} from './ChatList.legacyListTestHarness';
import { installLegacyChatListHarnessCommonModuleMocks } from './chatListLegacyHarnessTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedTurnViewProps: any = null;

const scrollToOffsetMock = vi.fn();
const scrollToIndexMock = vi.fn();
const loadOlderMessagesMock = vi.fn();

let flatListRefImpl: any = null;

const buildChatListItemsMock = vi.fn((..._args: any[]) => ([] as any[]));

installLegacyChatListHarnessCommonModuleMocks();

vi.mock('@/components/sessions/chatListItems', async () => (
  (await import('./ChatList.legacyListTestHarness')).createLegacyChatListItemsModuleMock(buildChatListItemsMock)
));

vi.mock('./ChatFooter', () => ({
  ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
  MessageView: () => React.createElement('MessageView'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
  TurnView: (props: any) => {
    capturedTurnViewProps = props;
    return React.createElement('TurnView');
  },
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
      transcriptBackwardPrefetchThresholdPx: 0,
      transcriptFlashListEstimatedItemSize: 120,
      transcriptWebInitialPinStabilizeMs: 3000,
      transcriptWebInitialPinRetryIntervalMs: 250,
    }),
  },
}));

describe('ChatList (initial scroll/pagination behavior)', () => {
  afterEach(() => {
    standardCleanup();
  });

  beforeEach(() => {
    capturedTurnViewProps = null;
    scrollToOffsetMock.mockClear();
    scrollToIndexMock.mockClear();
    loadOlderMessagesMock.mockReset();
    buildChatListItemsMock.mockClear();

    flatListRefImpl = {
      scrollToOffset: scrollToOffsetMock,
      scrollToIndex: scrollToIndexMock,
    };
    resetLegacyChatListHarness({ flatListRefValue: flatListRefImpl });
    legacyChatListHarnessState.sessionState = {
      id: 'session-1',
      seq: 0,
      metadata: null,
      accessLevel: null,
      canApprovePermissions: true,
      agentState: null,
    };
    legacyChatListHarnessState.settingValues.transcriptListImplementation = 'flatlist_legacy';
    legacyChatListHarnessState.settingValues.transcriptToolCallsCollapsedPreviewCount = 5;
  });

  it('does not load older messages from mount-time onEndReached before the user scrolls', async () => {
    legacyChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [{ id: 'm1' }],
    };
    loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' });

    const screen = await renderLegacyChatList({ flushOptions: { cycles: 0 } });

    requireCapturedFlatListProps();
    await triggerLegacyChatListEndReached();

    expect(loadOlderMessagesMock).not.toHaveBeenCalled();

    await screen.unmount();
  });

  it('can auto-load older messages even when committedMessagesCount is 0 (e.g. sidechain-only latest page)', async () => {
    legacyChatListHarnessState.sessionState = { ...legacyChatListHarnessState.sessionState, seq: 25 };
    legacyChatListHarnessState.sessionMessagesState = { isLoaded: true, messages: [] };
    loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' });

    const screen = await renderLegacyChatList({ flushOptions: { cycles: 0 } });

    requireCapturedFlatListProps();
    await triggerLegacyChatListInitialFill();

    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
    // On web, we avoid `scrollToOffset` during mount to prevent visible jitter. Pinning uses DOM scroll when available.
    expect(scrollToOffsetMock).not.toHaveBeenCalled();

    await screen.unmount();
  });

  it('can auto-load older messages even when session.seq is 0 (pagination cursor can still be ready)', async () => {
    legacyChatListHarnessState.sessionState = { ...legacyChatListHarnessState.sessionState, seq: 0 };
    legacyChatListHarnessState.sessionMessagesState = { isLoaded: true, messages: [] };
    loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' });

    const screen = await renderLegacyChatList({ flushOptions: { cycles: 0 } });

    requireCapturedFlatListProps();
    await triggerLegacyChatListInitialFill();

    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

    await screen.unmount();
  });

  it('keeps loading older pages past 10 attempts while the transcript is still short and progress continues', async () => {
    legacyChatListHarnessState.sessionState = { ...legacyChatListHarnessState.sessionState, seq: 250 };
    legacyChatListHarnessState.sessionMessagesState = { isLoaded: true, messages: [] };
    loadOlderMessagesMock
      .mockResolvedValueOnce({ loaded: 1, hasMore: true, status: 'loaded' })
      .mockResolvedValueOnce({ loaded: 1, hasMore: true, status: 'loaded' })
      .mockResolvedValueOnce({ loaded: 1, hasMore: true, status: 'loaded' })
      .mockResolvedValueOnce({ loaded: 1, hasMore: true, status: 'loaded' })
      .mockResolvedValueOnce({ loaded: 1, hasMore: true, status: 'loaded' })
      .mockResolvedValueOnce({ loaded: 1, hasMore: true, status: 'loaded' })
      .mockResolvedValueOnce({ loaded: 1, hasMore: true, status: 'loaded' })
      .mockResolvedValueOnce({ loaded: 1, hasMore: true, status: 'loaded' })
      .mockResolvedValueOnce({ loaded: 1, hasMore: true, status: 'loaded' })
      .mockResolvedValueOnce({ loaded: 1, hasMore: true, status: 'loaded' })
      .mockResolvedValueOnce({ loaded: 1, hasMore: true, status: 'loaded' })
      .mockResolvedValueOnce({ loaded: 1, hasMore: false, status: 'no_more' });

    const screen = await renderLegacyChatList({ flushOptions: { cycles: 0 } });

    requireCapturedFlatListProps();
    await triggerLegacyChatListInitialFill({
      flushOptions: { cycles: 4 },
    });

    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(12);

    await screen.unmount();
  });

  it('pins to the visual bottom on initial load (even before layout measurements)', async () => {
    legacyChatListHarnessState.sessionState = { ...legacyChatListHarnessState.sessionState, seq: 25 };
    legacyChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [{ id: 'm1' }],
    };

    const screen = await renderLegacyChatList({ flushOptions: { cycles: 0 } });

    // On web, pinning happens via DOM scroll when possible; we do not rely on list ref scroll APIs.
    expect(scrollToOffsetMock).not.toHaveBeenCalled();

    await screen.unmount();
  });

  it('stops wheel event propagation on web so transcript scrolling is not blocked by document scroll-lock listeners', async () => {
    const screen = await renderLegacyChatList({ flushOptions: { cycles: 0 } });

    const capturedFlatListProps = requireCapturedFlatListProps();
    expect(typeof capturedFlatListProps.onWheel).toBe('function');

    const stopPropagation = vi.fn();
    capturedFlatListProps.onWheel({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledTimes(1);

    await screen.unmount();
  });

  it('falls back to setting scrollTop directly on web when FlatList ref methods are not available', async () => {
    legacyChatListHarnessState.sessionState = { ...legacyChatListHarnessState.sessionState, seq: 25 };
    legacyChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [{ id: 'm1' }],
    };

    flatListRefImpl = {};
    legacyChatListHarnessState.flatListRefValue = flatListRefImpl;

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

      const screen = await renderLegacyChatList({ flushOptions: { cycles: 0 } });

      expect(scrollerEl.scrollTop).toBe(0);
      await screen.unmount();
    } finally {
      (globalThis as any).document = prevDocument;
      (globalThis as any).window = prevWindow;
    }
  });

  it('uses DOM scroll metrics on web to decide scrollability (ignores inflated contentSize from collapsed subtrees)', async () => {
    legacyChatListHarnessState.sessionState = { ...legacyChatListHarnessState.sessionState, seq: 25 };
    legacyChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [{ id: 'm1' }],
    };
    loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' });

    const rootEl: any = {
      scrollHeight: 500,
      clientHeight: 500,
      scrollTop: 0,
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

      const screen = await renderLegacyChatList({ flushOptions: { cycles: 0 } });

      requireCapturedFlatListProps();
      await triggerLegacyChatListInitialFill({
        contentHeight: 2000,
        flushOptions: { cycles: 2 },
        layoutHeight: 500,
      });

      expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
      await screen.unmount();
    } finally {
      (globalThis as any).document = prevDocument;
      (globalThis as any).window = prevWindow;
    }
  });

  it('auto-expands the newest tool calls group when the transcript cannot scroll and the group has hidden tools', async () => {
    legacyChatListHarnessState.sessionState = { ...legacyChatListHarnessState.sessionState, seq: 25 };
    legacyChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [{ id: 'm1', seq: 100 }],
    };

    buildChatListItemsMock.mockReturnValue([
      {
        id: 'turn-1',
        kind: 'turn',
        createdAt: 123,
        turn: {
          userMessageId: null,
          content: [
            {
              kind: 'tool_calls',
              id: 'tool-group-1',
              toolMessageIds: Array.from({ length: 10 }, (_, i) => `tool-${i}`),
            },
          ],
        },
      },
    ]);

    loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' });

    const screen = await renderLegacyChatList({ flushOptions: { cycles: 0 } });

    requireCapturedFlatListProps();
    await triggerLegacyChatListInitialFill({
      flushOptions: { cycles: 4 },
    });

    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
    expect(capturedTurnViewProps).toBeTruthy();
    expect(capturedTurnViewProps.expandedToolCallsAnchorMessageIds?.has('tool-9')).toBe(true);

    await screen.unmount();
  });

  it('auto-expands a tool calls group even if the group only appears after the initial fill completes', async () => {
    legacyChatListHarnessState.sessionState = { ...legacyChatListHarnessState.sessionState, seq: 25 };
    legacyChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [{ id: 'm1', seq: 100 }],
    };

    const toolGroupTurnItem = {
      id: 'turn-1',
      kind: 'turn',
      createdAt: 123,
      turn: {
        userMessageId: null,
        content: [
          {
            kind: 'tool_calls',
            id: 'tool-group-1',
            toolMessageIds: Array.from({ length: 10 }, (_, i) => `tool-${i}`),
          },
        ],
      },
    };

    // First render: no tool calls group at all (simulates a render before the tool-call messages are present).
    buildChatListItemsMock.mockReturnValue([]);
    loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' });

    const { ChatList } = await import('./ChatList');
    const screen = await renderLegacyChatList({ flushOptions: { cycles: 0 } });

    requireCapturedFlatListProps();
    await triggerLegacyChatListInitialFill({
      flushOptions: { cycles: 4 },
    });

    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
    expect(capturedTurnViewProps).toBeNull();

    // Next render: tool calls group exists, but the initial-fill effect should not need to re-run.
    legacyChatListHarnessState.sessionMessagesState = {
      ...legacyChatListHarnessState.sessionMessagesState,
      messages: [...legacyChatListHarnessState.sessionMessagesState.messages, { id: 'm2', seq: 101 }],
    };
    buildChatListItemsMock.mockReturnValue([toolGroupTurnItem] as any);
    await screen.update(<ChatList session={{ ...legacyChatListHarnessState.sessionState }} />);
    await flushLegacyChatListEffects({ cycles: 4 });

    expect(capturedTurnViewProps).toBeTruthy();
    expect(capturedTurnViewProps.expandedToolCallsAnchorMessageIds?.has('tool-9')).toBe(true);

    await screen.unmount();
  });
});
