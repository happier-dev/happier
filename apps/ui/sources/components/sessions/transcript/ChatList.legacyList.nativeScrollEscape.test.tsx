import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import {
  flashListChatListHarnessState,
  renderFlashListChatListSession,
  requireCapturedFlashListProps,
  resetFlashListChatListHarness,
  triggerFlashListChatListInitialFill,
  triggerFlashListChatListScroll,
} from '@/dev/testkit/harness/chatListHarness';
import { installFlashListChatListCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';
import { transcriptViewportTelemetry } from './scroll/transcriptViewportTelemetry';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installFlashListChatListCommonModuleMocks({
  reactNative: async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListReactNativeMock({
      platformOs: 'ios',
    }),
});

vi.mock('@/components/sessions/chatListItems', async () =>
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListItemsModuleMock()
);

vi.mock('./ChatFooter', () => ({
  ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
  MessageView: () => React.createElement('MessageView'),
  MessageViewWithSessionCommon: () => React.createElement('MessageViewWithSessionCommon'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
  TurnView: () => React.createElement('TurnView'),
  TurnViewWithSessionCommon: () => React.createElement('TurnViewWithSessionCommon'),
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
  fireAndForget: (p: Promise<unknown>) => p,
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    loadOlderMessages: vi.fn(async () => ({ loaded: 0, hasMore: false, status: 'no_more' as const })),
    loadNewerMessages: vi.fn(),
    hasDeferredNewerMessages: () => false,
    getSessionViewport: () => null,
    getSyncTuning: () => ({
      transcriptForwardPrefetchThresholdPx: 0,
      transcriptBackwardPrefetchThresholdPx: 0,
      transcriptFlashListEstimatedItemSize: 120,
      transcriptWebInitialPinStabilizeMs: 3000,
      transcriptWebInitialPinRetryIntervalMs: 250,
      transcriptViewportTelemetryEnabled: true,
      transcriptViewportTelemetryMaxEvents: 32,
    }),
  },
}));

describe('ChatList (legacy native FlatList scroll escape)', () => {
  beforeEach(() => {
    resetFlashListChatListHarness({ platformOs: 'ios' });
    transcriptViewportTelemetry.configure({ enabled: false, sink: null });
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [{ kind: 'assistant-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'streaming...' }],
    };
  });

  afterEach(() => {
    transcriptViewportTelemetry.configure({ enabled: false, sink: null });
    standardCleanup();
  });

  it('disables native MVCP bottom maintenance when list drag begins', async () => {
    const screen = await renderFlashListChatListSession({ flushOptions: { cycles: 0 } });

    expect(requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual({
      autoscrollToTopThreshold: 72,
      minIndexForVisible: 0,
    });

    await act(async () => {
      requireCapturedFlashListProps().onScrollBeginDrag?.({});
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(requireCapturedFlashListProps().maintainVisibleContentPosition).toBeUndefined();

    await screen.unmount();
  });

  it('drops impossible huge negative native offsets without repinning', async () => {
    transcriptViewportTelemetry.configure({ enabled: true, capacity: 32 });
    const screen = await renderFlashListChatListSession({ flushOptions: { cycles: 0 } });

    await triggerFlashListChatListInitialFill({
      contentHeight: 24578,
      layoutHeight: 682,
      flushOptions: { cycles: 1, turns: 1 },
    });

    await triggerFlashListChatListScroll(-972759, { cycles: 1, turns: 1 });

    const events = transcriptViewportTelemetry.snapshot().events;
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'scroll-observed',
        reason: 'invalid-native-offset',
        offsetY: -972759,
      }),
    ]));
    expect(events.filter((event) => event.type === 'scroll-write')).toHaveLength(0);

    await screen.unmount();
  });
});
