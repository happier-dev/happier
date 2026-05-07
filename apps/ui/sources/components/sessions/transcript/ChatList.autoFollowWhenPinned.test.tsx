import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
  buildLegacyChatListItems,
  legacyChatListHarnessState,
  renderLegacyChatList,
  resetLegacyChatListHarness,
} from './ChatList.legacyListTestHarness';
import {
  clearSessionUiTelemetryMarks,
  markStreamingMessagesAppliedForSessionUiTelemetry,
} from '@/sync/runtime/performance/sessionUiTelemetry';
import { installLegacyChatListHarnessCommonModuleMocks } from './chatListLegacyHarnessTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const scrollToOffsetSpy = vi.fn();

installLegacyChatListHarnessCommonModuleMocks({
  reactNative: async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createLegacyChatListReactNativeMock({
      platformOs: 'ios',
    }),
});

vi.mock('@/components/sessions/chatListItems', () => ({
  buildChatListItems: buildLegacyChatListItems,
  buildChatListItemsCached: (opts: any) => ({
    cache: null,
    items: buildLegacyChatListItems(opts),
  }),
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
    }),
  },
}));

const chatListModulePromise = import('./ChatList');

describe('ChatList (auto-follow while pinned)', () => {
  beforeEach(() => {
    resetLegacyChatListHarness({
      platformOs: 'ios',
      flatListRefValue: {
        scrollToOffset: scrollToOffsetSpy,
        scrollToIndex: vi.fn(),
      },
    });
    scrollToOffsetSpy.mockClear();

    legacyChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
  });

  afterEach(() => {
    clearSessionUiTelemetryMarks();
    syncPerformanceTelemetry.configure({ enabled: false });
    syncPerformanceTelemetry.reset();
    standardCleanup();
  });

  it('pins to bottom when pinned and new activity arrives', async () => {
    const { ChatList } = await chatListModulePromise;
    (globalThis as any).requestAnimationFrame = (cb: any) => {
      cb(0);
      return 1;
    };
    (globalThis as any).cancelAnimationFrame = () => {};

    legacyChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      ],
    };

    const screen = await renderLegacyChatList();

    scrollToOffsetSpy.mockClear();

    legacyChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        ...legacyChatListHarnessState.sessionMessagesState.messages,
        { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'a2' },
      ],
    };

    await act(async () => {
      await screen.update(<ChatList session={{ ...legacyChatListHarnessState.sessionState }} />);
    });

    expect(scrollToOffsetSpy).toHaveBeenCalled();
  });

  it('records visible streaming update telemetry when a marked socket message reaches the transcript', async () => {
    const { ChatList } = await chatListModulePromise;
    syncPerformanceTelemetry.configure({
      enabled: true,
      slowThresholdMs: 1_000_000,
      flushIntervalMs: 60_000,
    });
    syncPerformanceTelemetry.reset();

    legacyChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
      ],
    };

    const screen = await renderLegacyChatList();

    markStreamingMessagesAppliedForSessionUiTelemetry({
      sessionId: legacyChatListHarnessState.sessionState.id,
      source: 'socketMessage',
      messages: [
        { id: 'a1' },
      ],
    });

    legacyChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        ...legacyChatListHarnessState.sessionMessagesState.messages,
        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      ],
    };

    await act(async () => {
      await screen.update(<ChatList session={{ ...legacyChatListHarnessState.sessionState }} />);
    });

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
  });
});
