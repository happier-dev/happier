import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
  clearSessionUiTelemetryMarks,
  markStreamingMessagesAppliedForSessionUiTelemetry,
} from '@/sync/runtime/performance/sessionUiTelemetry';
import {
  buildFlashListChatListItems,
  flashListChatListHarnessState,
  renderFlashListChatListSession,
  resetFlashListChatListHarness,
} from '@/dev/testkit/harness/chatListHarness';
import { installFlashListChatListCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const scrollToOffsetSpy = vi.fn();
const scrollToIndexSpy = vi.fn();

installFlashListChatListCommonModuleMocks({
  reactNative: async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListReactNativeMock({
      platformOs: 'ios',
    }),
});

vi.mock('@/components/sessions/chatListItems', () => ({
  buildChatListItems: buildFlashListChatListItems,
  buildChatListItemsCached: (opts: any) => ({
    cache: null,
    items: buildFlashListChatListItems(opts),
  }),
}));

vi.mock('./ChatFooter', () => ({
  ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
  MessageView: () => React.createElement('MessageView'),
  MessageViewWithSessionCommon: () => React.createElement('MessageView'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
  TurnView: () => React.createElement('TurnView'),
  TurnViewWithSessionCommon: () => React.createElement('TurnView'),
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
  ToolCallsGroupRow: () => React.createElement('ToolCallsGroupRow'),
  ToolCallsGroupRowWithSessionCommon: () => React.createElement('ToolCallsGroupRow'),
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
  PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
  SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
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
      transcriptBackwardPrefetchThresholdPx: 0,
      transcriptFlashListEstimatedItemSize: 120,
      transcriptWebHotTailItemCount: 2,
      transcriptWebInitialPinStabilizeMs: 0,
      transcriptWebInitialPinRetryIntervalMs: 16,
      transcriptWebInitialPinRetryMilestonesMs: [16, 50, 100, 200, 400, 800],
      transcriptOlderLoadSpinnerDelayMs: 300,
    }),
  },
}));

const chatListModulePromise = import('./ChatList');

describe('ChatList (auto-follow while pinned)', () => {
  beforeEach(() => {
    resetFlashListChatListHarness({
      platformOs: 'ios',
      flashListRefHandle: {
        scrollToOffset: scrollToOffsetSpy,
        scrollToIndex: scrollToIndexSpy,
      },
    });
    scrollToOffsetSpy.mockClear();
    scrollToIndexSpy.mockClear();

    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
  });

  afterEach(() => {
    clearSessionUiTelemetryMarks();
    syncPerformanceTelemetry.configure({ enabled: false });
    syncPerformanceTelemetry.reset();
    standardCleanup();
  });

  it('keeps native FlashList bottom maintenance as the follow owner when pinned activity arrives', async () => {
    const { ChatList } = await chatListModulePromise;
    (globalThis as any).requestAnimationFrame = (cb: any) => {
      cb(0);
      return 1;
    };
    (globalThis as any).cancelAnimationFrame = () => {};

    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      ],
    };

    const screen = await renderFlashListChatListSession();

    scrollToOffsetSpy.mockClear();
    scrollToIndexSpy.mockClear();

    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        ...flashListChatListHarnessState.sessionMessagesState.messages,
        { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'a2' },
      ],
    };

    await act(async () => {
      await screen.update(
        // New committed activity bumps the session seq in production; the ChatList memo
        // (buildTranscriptRenderSignature) needs a signature-relevant change to re-render.
        <ChatList session={{ ...flashListChatListHarnessState.sessionState, seq: 1 }} />,
      );
    });
    await screen.settle();

    expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
      startRenderingFromBottom: true,
    });
    expect(scrollToOffsetSpy.mock.calls.length + scrollToIndexSpy.mock.calls.length).toBe(0);
  }, 120000);

  it('pins to bottom when a pending message appears while pinned before commit', async () => {
    const { ChatList } = await chatListModulePromise;
    (globalThis as any).requestAnimationFrame = (cb: any) => {
      cb(0);
      return 1;
    };
    (globalThis as any).cancelAnimationFrame = () => {};

    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      ],
    };
    flashListChatListHarnessState.sessionPendingState = {
      messages: [],
      discarded: [],
      isLoaded: true,
    };

    const screen = await renderFlashListChatListSession();

    scrollToOffsetSpy.mockClear();
    scrollToIndexSpy.mockClear();

    flashListChatListHarnessState.sessionPendingState = {
      messages: [
        {
          id: 'p1',
          localId: 'local-p1',
          createdAt: 3,
          updatedAt: 3,
          text: 'pending reply',
          rawRecord: {},
        },
      ],
      discarded: [],
      isLoaded: true,
    };

    await act(async () => {
      await screen.update(
        // New committed activity bumps the session seq in production; the ChatList memo
        // (buildTranscriptRenderSignature) needs a signature-relevant change to re-render.
        <ChatList session={{ ...flashListChatListHarnessState.sessionState, seq: 1 }} />,
      );
    });
    await screen.settle();

    expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
      startRenderingFromBottom: true,
    });
    expect(scrollToOffsetSpy.mock.calls.length + scrollToIndexSpy.mock.calls.length).toBe(0);
  }, 120000);

  it('records visible streaming update telemetry when a marked socket message reaches the transcript', async () => {
    const { ChatList } = await chatListModulePromise;
    syncPerformanceTelemetry.configure({
      enabled: true,
      slowThresholdMs: 1_000_000,
      flushIntervalMs: 60_000,
    });
    syncPerformanceTelemetry.reset();

    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
      ],
    };

    const screen = await renderFlashListChatListSession();

    markStreamingMessagesAppliedForSessionUiTelemetry({
      sessionId: flashListChatListHarnessState.sessionState.id,
      source: 'socketMessage',
      messages: [
        { id: 'a1' },
      ],
    });

    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        ...flashListChatListHarnessState.sessionMessagesState.messages,
        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      ],
    };

    await act(async () => {
      await screen.update(
        // New committed activity bumps the session seq in production; the ChatList memo
        // (buildTranscriptRenderSignature) needs a signature-relevant change to re-render.
        <ChatList session={{ ...flashListChatListHarnessState.sessionState, seq: 1 }} />,
      );
    });
    await screen.settle();

    const event = syncPerformanceTelemetry
      .snapshot()
      .events.find((candidate) => candidate.name === 'ui.sessions.streaming.visibleUpdate');

    expect(event).toBeTruthy();
    expect(event?.fields).toMatchObject({
      sourceSocketMessage: 1,
      sourceTranscriptStreamSegment: 0,
      committedMessages: 2,
    });
    expect(Object.values(event?.fields ?? {}).every((value) => typeof value === 'number')).toBe(true);
  }, 120000);

  it('pins to bottom when a committed message extends the newest turn while pinned', async () => {
    const { ChatList } = await chatListModulePromise;
    (globalThis as any).requestAnimationFrame = (cb: any) => {
      cb(0);
      return 1;
    };
    (globalThis as any).cancelAnimationFrame = () => {};

    flashListChatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    flashListChatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    flashListChatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
      ],
    };

    const screen = await renderFlashListChatListSession();

    scrollToOffsetSpy.mockClear();
    scrollToIndexSpy.mockClear();

    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      ],
    };

    await act(async () => {
      await screen.update(
        // New committed activity bumps the session seq in production; the ChatList memo
        // (buildTranscriptRenderSignature) needs a signature-relevant change to re-render.
        <ChatList session={{ ...flashListChatListHarnessState.sessionState, seq: 1 }} />,
      );
    });
    await screen.settle();

    expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
      startRenderingFromBottom: true,
    });
    expect(scrollToOffsetSpy.mock.calls.length + scrollToIndexSpy.mock.calls.length).toBe(0);
  }, 120000);

  it('pins to bottom when multiple committed messages extend the same newest turn while pinned', async () => {
    const { ChatList } = await chatListModulePromise;
    (globalThis as any).requestAnimationFrame = (cb: any) => {
      cb(0);
      return 1;
    };
    (globalThis as any).cancelAnimationFrame = () => {};

    flashListChatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    flashListChatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    flashListChatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      ],
    };

    const screen = await renderFlashListChatListSession();

    scrollToOffsetSpy.mockClear();
    scrollToIndexSpy.mockClear();

    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
        { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'a2' },
      ],
    };

    await act(async () => {
      await screen.update(
        // New committed activity bumps the session seq in production; the ChatList memo
        // (buildTranscriptRenderSignature) needs a signature-relevant change to re-render.
        <ChatList session={{ ...flashListChatListHarnessState.sessionState, seq: 1 }} />,
      );
    });
    await screen.settle();

    expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
      startRenderingFromBottom: true,
    });
    expect(scrollToOffsetSpy.mock.calls.length + scrollToIndexSpy.mock.calls.length).toBe(0);
  }, 120000);
});
