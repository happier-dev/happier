import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import {
  createFlashListChatListWebScroller,
  flashListChatListHarnessState,
  renderFlashListChatList,
  renderFlashListChatListSession,
  requireCapturedFlashListProps,
  resetFlashListChatListHarness,
  triggerFlashListChatListEndReached,
  triggerFlashListChatListInitialFill,
  triggerFlashListChatListScroll,
  withFlashListChatListWebScrollerDom,
} from '@/dev/testkit/harness/chatListHarness';
import { installFlashListChatListCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const scrollToOffsetMock = vi.fn();
const scrollToIndexMock = vi.fn();
const loadOlderMessagesMock = vi.fn();

let capturedToolGroupRowProps: any[] = [];
let flashListRefImpl: any = null;
let sessionViewportByIdState = new Map<string, { isPinned: boolean; offsetY: number; lastUpdatedAt: number; source: 'default' | 'observed' }>();

const buildChatListItemsMock = vi.fn((..._args: any[]) => ([] as any[]));

installFlashListChatListCommonModuleMocks();

async function renderCapturedFlashListFooter() {
  const capturedFlashListProps = requireCapturedFlashListProps();
  const footer = capturedFlashListProps.ListFooterComponent;
  expect(footer).toBeTruthy();

  let renderedItem: renderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderedItem = renderer.create(React.isValidElement(footer) ? footer : React.createElement(footer));
  });
  await act(async () => {
    renderedItem?.unmount();
  });
}

function recordWebScrollerScrollTopWrites(scrollerEl: { clientHeight: number; scrollHeight: number; scrollTop: number }): number[] {
  const writes: number[] = [];
  let scrollTopValue = scrollerEl.scrollTop;
  Object.defineProperty(scrollerEl, 'scrollTop', {
    configurable: true,
    enumerable: true,
    get: () => scrollTopValue,
    set: (value: number) => {
      writes.push(value);
      const maxScrollTop = Math.max(0, scrollerEl.scrollHeight - scrollerEl.clientHeight);
      scrollTopValue = Math.max(0, Math.min(value, maxScrollTop));
    },
  });
  return writes;
}

vi.mock('@/components/sessions/chatListItems', async () => (
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListItemsModuleMock(buildChatListItemsMock)
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
  TurnViewWithSessionCommon: () => React.createElement('TurnViewWithSessionCommon'),
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
  ToolCallsGroupRow: (props: any) => {
    capturedToolGroupRowProps.push(props);
    return React.createElement('ToolCallsGroupRow', props);
  },
  ToolCallsGroupRowWithSessionCommon: (props: any) => {
    capturedToolGroupRowProps.push(props);
    return React.createElement('ToolCallsGroupRow', props);
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
    getSessionViewport: (sessionId: string) => sessionViewportByIdState.get(sessionId) ?? null,
    getSyncTuning: () => ({
      transcriptForwardPrefetchThresholdPx: 0,
      transcriptBackwardPrefetchThresholdPx: 0,
      transcriptFlashListEstimatedItemSize: 120,
      transcriptWebInitialPinStabilizeMs: 3000,
      transcriptWebInitialPinRetryIntervalMs: 250,
      transcriptWebInitialPinRetryMilestonesMs: [16, 50, 100, 200, 400, 800],
      transcriptOlderLoadSpinnerDelayMs: 300,
      transcriptMaxTurnEntriesPerListItem: 8,
    }),
  },
}));

describe('ChatList (initial scroll/pagination behavior)', () => {
  afterEach(() => {
    standardCleanup();
  });

  beforeEach(() => {
    capturedToolGroupRowProps = [];
    scrollToOffsetMock.mockClear();
    scrollToIndexMock.mockClear();
    loadOlderMessagesMock.mockReset();
    buildChatListItemsMock.mockClear();
    sessionViewportByIdState = new Map();

    flashListRefImpl = {
      scrollToOffset: scrollToOffsetMock,
      scrollToIndex: scrollToIndexMock,
    };
    resetFlashListChatListHarness({ flashListRefHandle: flashListRefImpl });
    flashListChatListHarnessState.sessionState = {
      id: 'session-1',
      seq: 0,
      metadata: null,
      accessLevel: null,
      canApprovePermissions: true,
      agentState: null,
    };
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.transcriptToolCallsCollapsedPreviewCount = 5;
  });

  it('does not load older messages from mount-time onEndReached before the user scrolls', async () => {
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [{ id: 'm1' }],
    };
    loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' });

    const screen = await renderFlashListChatListSession({ flushOptions: { cycles: 0 } });

    requireCapturedFlashListProps();
    await triggerFlashListChatListEndReached();

    expect(loadOlderMessagesMock).not.toHaveBeenCalled();

    await screen.unmount();
  });

  it('can auto-load older messages even when committedMessagesCount is 0 (e.g. sidechain-only latest page)', async () => {
    flashListChatListHarnessState.sessionState = { ...flashListChatListHarnessState.sessionState, seq: 25 };
    flashListChatListHarnessState.sessionMessagesState = { isLoaded: true, messages: [] };
    loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' });

    const screen = await renderFlashListChatListSession({ flushOptions: { cycles: 0 } });

    requireCapturedFlashListProps();
    await triggerFlashListChatListInitialFill();

    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
    // On web, we avoid `scrollToOffset` during mount to prevent visible jitter. Pinning uses DOM scroll when available.
    expect(scrollToOffsetMock).not.toHaveBeenCalled();

    await screen.unmount();
  });

  it('can auto-load older messages even when session.seq is 0 (pagination cursor can still be ready)', async () => {
    flashListChatListHarnessState.sessionState = { ...flashListChatListHarnessState.sessionState, seq: 0 };
    flashListChatListHarnessState.sessionMessagesState = { isLoaded: true, messages: [] };
    loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' });

    const screen = await renderFlashListChatListSession({ flushOptions: { cycles: 0 } });

    requireCapturedFlashListProps();
    await triggerFlashListChatListInitialFill();

    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

    await screen.unmount();
  });

  it('keeps loading older pages past 10 attempts while the transcript is still short and progress continues', async () => {
    flashListChatListHarnessState.sessionState = { ...flashListChatListHarnessState.sessionState, seq: 250 };
    flashListChatListHarnessState.sessionMessagesState = { isLoaded: true, messages: [] };
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

    const screen = await renderFlashListChatListSession({ flushOptions: { cycles: 0 } });

    requireCapturedFlashListProps();
    await triggerFlashListChatListInitialFill({
      flushOptions: { cycles: 4 },
    });

    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(12);

    await screen.unmount();
  });

  it('pins to the visual bottom on initial load (even before layout measurements)', async () => {
    flashListChatListHarnessState.sessionState = { ...flashListChatListHarnessState.sessionState, seq: 25 };
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [{ id: 'm1' }],
    };

    const screen = await renderFlashListChatListSession({ flushOptions: { cycles: 0 } });

    // On web, pinning happens via DOM scroll when possible; we do not rely on list ref scroll APIs.
    expect(scrollToOffsetMock).not.toHaveBeenCalled();

    await screen.unmount();
  });

  it('stops wheel event propagation on web so transcript scrolling is not blocked by document scroll-lock listeners', async () => {
    const screen = await renderFlashListChatListSession({ flushOptions: { cycles: 0 } });

    const capturedFlashListProps = requireCapturedFlashListProps();
    expect(typeof capturedFlashListProps.onWheel).toBe('function');

    const stopPropagation = vi.fn();
    capturedFlashListProps.onWheel({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledTimes(1);

    await screen.unmount();
  });

  it('falls back to setting scrollTop directly on web when list ref methods are not available', async () => {
    flashListChatListHarnessState.sessionState = { ...flashListChatListHarnessState.sessionState, seq: 25 };
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [{ id: 'm1' }],
    };

    flashListRefImpl = {};
    flashListChatListHarnessState.flashListRefHandle = flashListRefImpl;

    const scrollerEl: any = createFlashListChatListWebScroller({
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 900,
    });
    const rootEl: any = {
      querySelectorAll: () => [scrollerEl],
      scrollHeight: 0,
      clientHeight: 0,
    };

    const prevDocument = (globalThis as any).document;
    const prevWindow = (globalThis as any).window;
    try {
      (globalThis as any).document = {
        querySelector: () => scrollerEl,
        getElementById: () => rootEl,
      };
      (globalThis as any).window = {
        location: prevWindow?.location ?? { hostname: 'localhost' },
        getComputedStyle: () => ({ overflowY: 'auto' }),
      };

      const screen = await renderFlashListChatListSession({ flushOptions: { cycles: 0 } });

      expect(scrollerEl.scrollTop).toBe(1500);
      await screen.unmount();
    } finally {
      (globalThis as any).document = prevDocument;
      (globalThis as any).window = prevWindow;
    }
  });

  it('corrects same-height passive web drift after a cold-open bottom pin without releasing live-tail', async () => {
    flashListChatListHarnessState.sessionState = { ...flashListChatListHarnessState.sessionState, seq: 452 };
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [{ id: 'm1', seq: 452 }],
    };
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 72;

    const scrollerEl = createFlashListChatListWebScroller({
      scrollHeight: 10732,
      clientHeight: 679,
      scrollTop: 0,
    });
    const scrollTopWrites = recordWebScrollerScrollTopWrites(scrollerEl);
    const onViewportChange = vi.fn();

    await withFlashListChatListWebScrollerDom(scrollerEl, async () => {
      const { ChatList } = await import('./ChatList');
      const screen = await renderFlashListChatList(
        <ChatList
          session={{ ...flashListChatListHarnessState.sessionState }}
          onViewportChange={onViewportChange}
        />,
        { flushOptions: { cycles: 0 } },
      );

      expect(scrollerEl.scrollTop).toBe(10053);

      onViewportChange.mockClear();
      scrollTopWrites.length = 0;
      scrollerEl.scrollTop = 9982;
      scrollTopWrites.length = 0;

      await triggerFlashListChatListScroll(
        9982,
        {
          contentSize: { height: 10732, width: 400 },
          layoutMeasurement: { height: 679, width: 400 },
        },
        { cycles: 1, turns: 1 },
      );

      expect(scrollTopWrites).toEqual([10732]);
      expect(scrollerEl.scrollTop).toBe(10053);
      expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({ isPinned: false }));
      expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({ shouldRestoreViewport: true }));

      await screen.unmount();
    });
  });

  it('uses DOM scroll metrics on web to decide scrollability (ignores inflated contentSize from collapsed subtrees)', async () => {
    flashListChatListHarnessState.sessionState = { ...flashListChatListHarnessState.sessionState, seq: 25 };
    flashListChatListHarnessState.sessionMessagesState = {
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
        location: prevWindow?.location ?? { hostname: 'localhost' },
        getComputedStyle: () => ({ overflowY: 'auto' }),
      };

      const screen = await renderFlashListChatListSession({ flushOptions: { cycles: 0 } });

      requireCapturedFlashListProps();
      await triggerFlashListChatListInitialFill({
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
    flashListChatListHarnessState.sessionState = { ...flashListChatListHarnessState.sessionState, seq: 25 };
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [{ id: 'm1', seq: 100 }],
    };

    buildChatListItemsMock.mockReturnValue([
      {
        kind: 'tool-calls-group',
        id: 'tool-group-1',
        toolMessageIds: Array.from({ length: 10 }, (_, i) => `tool-${i}`),
      },
    ]);

    loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' });

    const screen = await renderFlashListChatListSession({ flushOptions: { cycles: 0 } });

    requireCapturedFlashListProps();
    await triggerFlashListChatListInitialFill({
      flushOptions: { cycles: 4 },
    });
    await renderCapturedFlashListFooter();

    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
    expect(capturedToolGroupRowProps.at(-1)?.expanded).toBe(true);

    await screen.unmount();
  });

  it('does not auto-expand a huge tool calls group into one giant rendered row when the transcript cannot scroll', async () => {
    flashListChatListHarnessState.sessionState = { ...flashListChatListHarnessState.sessionState, seq: 25 };
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [{ id: 'm1', seq: 100 }],
    };

    buildChatListItemsMock.mockReturnValue([
      {
        kind: 'tool-calls-group',
        id: 'tool-group-1',
        toolMessageIds: Array.from({ length: 200 }, (_, i) => `tool-${i}`),
      },
    ]);

    loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' });

    const screen = await renderFlashListChatListSession({ flushOptions: { cycles: 0 } });

    requireCapturedFlashListProps();
    await triggerFlashListChatListInitialFill({
      flushOptions: { cycles: 4 },
    });
    await renderCapturedFlashListFooter();

    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
    expect(capturedToolGroupRowProps.at(-1)?.expanded).toBe(false);

    await screen.unmount();
  });

  it('auto-expands a tool calls group without pinning an observed unpinned entry', async () => {
    flashListChatListHarnessState.sessionState = { ...flashListChatListHarnessState.sessionState, seq: 25 };
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [{ id: 'm1', seq: 100 }],
    };
    sessionViewportByIdState.set('session-1', {
      isPinned: false,
      offsetY: 42,
      lastUpdatedAt: 1,
      source: 'observed',
    });

    buildChatListItemsMock.mockReturnValue([
      {
        kind: 'tool-calls-group',
        id: 'tool-group-1',
        toolMessageIds: Array.from({ length: 10 }, (_, i) => `tool-${i}`),
      },
    ]);

    loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' });

    const scrollEl = {
      clientHeight: 100,
      contains: () => true,
      isConnected: true,
      parentElement: null,
      querySelectorAll: () => [],
      scrollHeight: 100,
      scrollTop: 42,
    };
    const previousDocument = (globalThis as any).document;
    const previousWindow = (globalThis as any).window;
    try {
      (globalThis as any).document = {
        querySelector: () => scrollEl,
        getElementById: () => scrollEl,
      };
      (globalThis as any).window = {
        location: previousWindow?.location ?? { hostname: 'localhost' },
        getComputedStyle: () => ({ overflowY: 'auto' }),
      };

      const screen = await renderFlashListChatListSession({ flushOptions: { cycles: 0 } });

      requireCapturedFlashListProps();
      await triggerFlashListChatListInitialFill({
        contentHeight: 100,
        flushOptions: { cycles: 4 },
        layoutHeight: 100,
      });
      await flushHookEffects({ cycles: 4 });
      await renderCapturedFlashListFooter();

      expect(capturedToolGroupRowProps.at(-1)?.expanded).toBe(true);
      // The fake DOM intentionally starts at an observed unpinned offset. If auto-expand tried to
      // pin the transcript, this write would be clobbered.
      expect(scrollEl.scrollTop).toBe(42);

      await screen.unmount();
    } finally {
      (globalThis as any).document = previousDocument;
      (globalThis as any).window = previousWindow;
    }
  });

  it('auto-expands a tool calls group even if the group only appears after the initial fill completes', async () => {
    flashListChatListHarnessState.sessionState = { ...flashListChatListHarnessState.sessionState, seq: 25 };
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [{ id: 'm1', seq: 100 }],
    };

    const toolGroupTurnItem = {
      kind: 'tool-calls-group',
      id: 'tool-group-1',
      toolMessageIds: Array.from({ length: 10 }, (_, i) => `tool-${i}`),
    };

    // First render: no tool calls group at all (simulates a render before the tool-call messages are present).
    buildChatListItemsMock.mockReturnValue([]);
    loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' });

    const { ChatList } = await import('./ChatList');
    const screen = await renderFlashListChatListSession({ flushOptions: { cycles: 0 } });

    requireCapturedFlashListProps();
    await triggerFlashListChatListInitialFill({
      flushOptions: { cycles: 4 },
    });

    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
    expect(capturedToolGroupRowProps).toHaveLength(0);

    // Next render: tool calls group exists, but the initial-fill effect should not need to re-run.
    flashListChatListHarnessState.sessionMessagesState = {
      ...flashListChatListHarnessState.sessionMessagesState,
      messages: [...flashListChatListHarnessState.sessionMessagesState.messages, { id: 'm2', seq: 101 }],
    };
    buildChatListItemsMock.mockReturnValue([toolGroupTurnItem] as any);
    await screen.update(<ChatList session={{ ...flashListChatListHarnessState.sessionState }} followBottomIntentKey="tool-group-visible" />);
    await flushHookEffects({ cycles: 4 });
    await renderCapturedFlashListFooter();

    expect(capturedToolGroupRowProps.at(-1)?.expanded).toBe(true);

    await screen.unmount();
  });
});
