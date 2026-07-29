import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import {
  chatListHarnessState,
  renderChatListHarnessSession,
  resetChatListHarness,
  triggerLegendChatListScroll,
  triggerLegendChatListWheel,
} from '@/dev/testkit/harness/chatListHarness';
import { installChatListHarnessCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installChatListHarnessCommonModuleMocks();

let previousRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
let previousCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;

vi.mock('@/components/sessions/chatListItems', async () => (
  (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessItemsModuleMock()
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
  TurnViewWithSessionCommon: () => React.createElement('TurnView'),
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

vi.mock('@/sync/sync', async () =>
  (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessSyncModuleMock({
    loadOlderMessages: vi.fn(),
    loadNewerMessages: vi.fn(),
    hasDeferredNewerMessages: () => false,
  })
);

describe('ChatList (jump-to-bottom)', () => {
  const viewportGeometry = {
    contentSize: { height: 3000, width: 400 },
    layoutMeasurement: { height: 600, width: 400 },
    isTrusted: true,
  } as const;

  async function detachFromTail() {
    // Seed detached Legend geometry, then drive a user wheel + the resulting scroll so the
    // adapter classifies the at-end flip out of following as USER-caused.
    chatListHarnessState.legendListState = {
      contentLength: 3000,
      scrollLength: 600,
      scroll: 200,
      isAtEnd: false,
      isNearEnd: false,
      isWithinMaintainScrollAtEndThreshold: false,
    };
    await triggerLegendChatListWheel(-100, { turns: 1 });
    await triggerLegendChatListScroll(200, viewportGeometry, { turns: 1 });
  }

  afterEach(() => {
    standardCleanup();
    globalThis.requestAnimationFrame = previousRequestAnimationFrame as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame as typeof globalThis.cancelAnimationFrame;
  });

  beforeEach(() => {
    previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
    // Timeout-based shim: the Legend adapter's bounded settle monitor re-schedules itself
    // via rAF, so a synchronous shim would recurse unboundedly.
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => (
      setTimeout(() => callback(Date.now()), 0) as unknown as number
    )) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((handle: number) => {
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    }) as typeof globalThis.cancelAnimationFrame;
    resetChatListHarness();
    chatListHarnessState.sessionState = {
      id: 'session-1',
      seq: 0,
      metadata: null,
      accessLevel: null,
      canApprovePermissions: true,
      agentState: null,
    };
    chatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
    chatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    chatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    chatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    chatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 72;
    chatListHarnessState.settingValues.transcriptScrollJumpToBottomEnabled = true;
    chatListHarnessState.settingValues.transcriptScrollJumpToBottomMinNewCount = 1;
    chatListHarnessState.settingValues.transcriptScrollJumpToBottomAnimateScroll = false;
    chatListHarnessState.settingValues.transcriptMotionPreset = 'off';
    chatListHarnessState.settingValues.transcriptAnimateNewItemsEnabled = false;
  });

  it('shows a jump-to-bottom button when unpinned and new messages arrive', async () => {
    const onViewportChange = vi.fn();
    chatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      ],
    };

    const screen = await renderChatListHarnessSession();
    const { ChatList } = await import('./ChatList');
    await screen.update(
      <ChatList
        session={{ ...chatListHarnessState.sessionState }}
        onViewportChange={onViewportChange}
      />,
    );

    // Scroll up (unpinned)
    await detachFromTail();

    // New message arrives
    chatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        ...(chatListHarnessState.sessionMessagesState.messages ?? []),
        { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'a2' },
      ],
    };

    await screen.update(
      <ChatList
        session={{ ...chatListHarnessState.sessionState }}
        onViewportChange={onViewportChange}
      />,
    );

    const jumpButtons = screen.findAllByTestId('transcript-jump-to-bottom');
    expect(jumpButtons.length).toBeGreaterThan(0);

    onViewportChange.mockClear();
    await act(async () => {
      jumpButtons[0]?.props.onPress();
    });

    expect(onViewportChange).toHaveBeenCalledWith({
      isPinned: true,
      offsetY: 0,
      shouldRestoreViewport: false,
    });

    await screen.unmount();
  });

  it('shows a jump-to-bottom button when an existing newest turn grows while unpinned', async () => {
    chatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    chatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
      ],
    };

    const screen = await renderChatListHarnessSession();

    await detachFromTail();

    chatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      ],
    };

    const { ChatList } = await import('./ChatList');
    await screen.update(<ChatList session={{ ...chatListHarnessState.sessionState }} />);

    const jumpButtons = screen.findAllByTestId('transcript-jump-to-bottom');
    expect(jumpButtons.length).toBeGreaterThan(0);

    await screen.unmount();
  });
});
