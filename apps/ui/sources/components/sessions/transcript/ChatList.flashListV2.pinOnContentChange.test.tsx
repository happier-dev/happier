import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  flashListChatListHarnessState,
  renderFlashListChatList,
  resetFlashListChatListHarness,
  standardCleanup,
} from '@/dev/testkit';
import { triggerFlashListChatListLoad } from '@/dev/testkit/harness/chatListHarness';
import { transcriptViewportTelemetry } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import {
  installTranscriptCommonModuleMocks,
  resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const scrollToOffsetSpy = vi.fn();
const scrollToIndexSpy = vi.fn();
let previousRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
let previousCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;
const keyboardAvoidanceMockState = vi.hoisted(() => ({
  composerInsetProps: null as null | { onHeightChange?: (height: number) => void },
}));

installTranscriptCommonModuleMocks({
  reactNative: async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListReactNativeMock({
      platformOs: 'ios',
    }),
  storage: async (importOriginal) =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListStorageMock(importOriginal),
});

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(0) });
  resetTranscriptCommonModuleMockState();
  previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
  scrollToOffsetSpy.mockClear();
  scrollToIndexSpy.mockClear();
  keyboardAvoidanceMockState.composerInsetProps = null;
  resetFlashListChatListHarness({
    flashListRefHandle: { scrollToOffset: scrollToOffsetSpy, scrollToIndex: scrollToIndexSpy },
    platformOs: 'ios',
  });
  flashListChatListHarnessState.sessionMessagesState = {
    messages: [{ kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'hi' }],
    isLoaded: true,
  };
  flashListChatListHarnessState.sessionPendingState = { messages: [], discarded: [], isLoaded: true };
  flashListChatListHarnessState.sessionActionDraftsState = [];
  // Use sessionSeq=0 to avoid triggering the initial-fill effect (which pins once unconditionally).
  flashListChatListHarnessState.sessionState = {
    ...flashListChatListHarnessState.sessionState,
    id: 'session-1',
    seq: 0,
    metadata: null,
    accessLevel: null,
    canApprovePermissions: true,
  };
});

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', async () =>
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListModuleMock()
);

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

vi.mock('@/components/sessions/chatListItems', async () =>
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListItemsModuleMock(({ messageIdsOldestFirst, messagesById }: any) =>
    (messageIdsOldestFirst ?? []).map((id: string) => {
      const message = messagesById?.[id];
      return { kind: 'message', id: `msg:${id}`, messageId: id, createdAt: message?.createdAt ?? 0, seq: null };
    }),
  )
);

vi.mock('./ChatFooter', () => ({
  ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
  MessageView: () => React.createElement('MessageView'),
  MessageViewWithSessionCommon: () => React.createElement('MessageView'),
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
  PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
  SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
  TurnView: () => React.createElement('TurnView'),
  TurnViewWithSessionCommon: () => React.createElement('TurnView'),
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

vi.mock('@/components/sessions/keyboardAvoidance', () => ({
  ComposerKeyboardScrollInset: (props: { testID?: string; onHeightChange?: (height: number) => void }) => {
    keyboardAvoidanceMockState.composerInsetProps = props;
    return React.createElement('ComposerKeyboardScrollInset', props);
  },
  ComposerKeyboardFloatingInset: ({ children }: { children: React.ReactNode }) =>
    React.createElement('ComposerKeyboardFloatingInset', null, children),
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

vi.mock('@/sync/sync', async () =>
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListSyncModuleMock({
    loadOlderMessages: vi.fn(),
    loadNewerMessages: vi.fn(),
  })
);

async function settleNativeFlashListMount(screen: Awaited<ReturnType<typeof renderFlashListChatList>>) {
  await triggerFlashListChatListLoad(12, { turns: 1 });
  await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });
}

describe('ChatList (FlashList v2 pinned follow on content growth)', () => {
  afterEach(() => {
    globalThis.requestAnimationFrame = previousRequestAnimationFrame as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame as typeof globalThis.cancelAnimationFrame;
    vi.useRealTimers();
    transcriptViewportTelemetry.configure({ enabled: false, sink: null });
    resetTranscriptCommonModuleMockState();
    standardCleanup();
  });

  it('keeps native FlashList pinned when followed content grows after initial fill', async () => {
    const { ChatList } = await import('./ChatList');

    const screen = await renderFlashListChatList(
      <ChatList session={flashListChatListHarnessState.sessionState} />
    );

    expect(screen.getCapturedFlashListProps()).toBeTruthy();

    // Initial measured correction is allowed on native; this test owns later content growth.
    scrollToOffsetSpy.mockClear();

    await screen.triggerInitialFill({
      layoutHeight: 500,
      contentHeight: 1000,
      contentWidth: 0,
    });

    expect(scrollToOffsetSpy).not.toHaveBeenCalled();

    await settleNativeFlashListMount(screen);

    expect(scrollToOffsetSpy).not.toHaveBeenCalled();
    expect(scrollToIndexSpy).not.toHaveBeenCalled();
    scrollToOffsetSpy.mockClear();
    scrollToIndexSpy.mockClear();

    screen.getCapturedFlashListProps().onContentSizeChange?.(0, 1200);
    await screen.settle({ cycles: 1, turns: 1 });

    expect(scrollToOffsetSpy).not.toHaveBeenCalled();
    expect(scrollToIndexSpy).not.toHaveBeenCalled();
    expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
      startRenderingFromBottom: true,
      animateAutoScrollToBottom: false,
    });
  });

  it('records telemetry for native content-growth scroll writes', async () => {
    const telemetrySink = vi.fn();
    vi.stubGlobal('__DEV__', true);
    transcriptViewportTelemetry.configure({
      enabled: true,
      capacity: 16,
      sink: telemetrySink,
    });
    resetFlashListChatListHarness({
      flashListRefHandle: { scrollToOffset: scrollToOffsetSpy, scrollToIndex: scrollToIndexSpy },
      platformOs: 'ios',
      syncTuningState: {
        transcriptViewportTelemetryEnabled: true,
        transcriptViewportTelemetryMaxEvents: 16,
      },
    });
    flashListChatListHarnessState.sessionMessagesState = {
      messages: [{ kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'hi' }],
      isLoaded: true,
    };
    flashListChatListHarnessState.sessionState = {
      ...flashListChatListHarnessState.sessionState,
      id: 'session-telemetry',
      seq: 0,
      metadata: null,
      accessLevel: null,
      canApprovePermissions: true,
    };

    const { ChatList } = await import('./ChatList');
    const screen = await renderFlashListChatList(
      <ChatList session={flashListChatListHarnessState.sessionState} />
    );

    await screen.triggerInitialFill({
      layoutHeight: 500,
      contentHeight: 1000,
      contentWidth: 0,
    });
    await settleNativeFlashListMount(screen);
    telemetrySink.mockClear();
    scrollToOffsetSpy.mockClear();

    screen.getCapturedFlashListProps().onContentSizeChange?.(0, 1200);
    await screen.settle({ cycles: 1, turns: 1 });

    expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
      type: 'content-measured',
      reason: 'content-size-change',
      platform: 'ios',
      listImplementation: 'flash_v2',
      layoutHeight: 500,
      contentHeight: 1200,
    }));
    expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'scroll-write',
      reason: 'content-size-change',
    }));
    expect(telemetrySink.mock.calls.at(-1)?.[0]?.sessionId).toMatch(/^session:/);
    expect(telemetrySink.mock.calls.at(-1)?.[0]?.sessionId).not.toBe('session-telemetry');
  });

  it('keeps native FlashList pinned when the viewport height changes while following', async () => {
    const { ChatList } = await import('./ChatList');

    const screen = await renderFlashListChatList(
      <ChatList session={flashListChatListHarnessState.sessionState} />
    );

    await screen.triggerInitialFill({
      layoutHeight: 500,
      contentHeight: 1000,
      contentWidth: 0,
    });
    await settleNativeFlashListMount(screen);

    scrollToOffsetSpy.mockClear();

    await act(async () => {
      screen.getCapturedFlashListProps().onLayout?.({
        nativeEvent: {
          layout: {
            height: 420,
            width: 400,
          },
        },
      });
    });
    await screen.settle({ cycles: 1, turns: 1 });

    expect(scrollToOffsetSpy).not.toHaveBeenCalled();
    expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
      startRenderingFromBottom: true,
      animateAutoScrollToBottom: false,
    });
  });

  it('keeps native FlashList pinned when composer inset height changes while following', async () => {
    const { ChatList } = await import('./ChatList');

    const screen = await renderFlashListChatList(
      <ChatList session={flashListChatListHarnessState.sessionState} />
    );

    await screen.triggerInitialFill({
      layoutHeight: 500,
      contentHeight: 1000,
      contentWidth: 0,
    });
    await settleNativeFlashListMount(screen);

    scrollToOffsetSpy.mockClear();

    await act(async () => {
      keyboardAvoidanceMockState.composerInsetProps?.onHeightChange?.(180);
    });
    await screen.settle({ cycles: 1, turns: 1 });

    expect(scrollToOffsetSpy).not.toHaveBeenCalled();
    expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
      startRenderingFromBottom: true,
      animateAutoScrollToBottom: false,
    });
  });

  it('keeps native FlashList bottom maintenance write-free when composer inset is measured before content', async () => {
    const { ChatList } = await import('./ChatList');

    const screen = await renderFlashListChatList(
      <ChatList session={flashListChatListHarnessState.sessionState} />
    );

    expect(screen.getCapturedFlashListProps()).toBeTruthy();

    await act(async () => {
      keyboardAvoidanceMockState.composerInsetProps?.onHeightChange?.(180);
    });

    scrollToOffsetSpy.mockClear();

    await screen.triggerInitialFill({
      layoutHeight: 500,
      contentHeight: 1000,
      contentWidth: 0,
    });

    expect(scrollToOffsetSpy).not.toHaveBeenCalled();
    expect(scrollToIndexSpy).not.toHaveBeenCalled();
    await settleNativeFlashListMount(screen);

    expect(scrollToOffsetSpy).not.toHaveBeenCalled();
    expect(scrollToIndexSpy).not.toHaveBeenCalled();
    expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
      startRenderingFromBottom: true,
      animateAutoScrollToBottom: false,
    });
  });
});
