import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import {
  flashListChatListHarnessState,
  renderFlashListChatListSession,
  requireCapturedFlashListProps,
  resetFlashListChatListHarness,
  triggerFlashListChatListScroll,
} from '@/dev/testkit/harness/chatListHarness';
import { installFlashListChatListCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installFlashListChatListCommonModuleMocks();

let previousRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
let previousCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;

vi.mock('@/components/sessions/chatListItems', async () => (
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListItemsModuleMock()
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
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListSyncModuleMock({
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

  afterEach(() => {
    standardCleanup();
    globalThis.requestAnimationFrame = previousRequestAnimationFrame as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame as typeof globalThis.cancelAnimationFrame;
  });

  beforeEach(() => {
    previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
    resetFlashListChatListHarness();
    flashListChatListHarnessState.sessionState = {
      id: 'session-1',
      seq: 0,
      metadata: null,
      accessLevel: null,
      canApprovePermissions: true,
      agentState: null,
    };
    flashListChatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
    flashListChatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    flashListChatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 72;
    flashListChatListHarnessState.settingValues.transcriptScrollJumpToBottomEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollJumpToBottomMinNewCount = 1;
    flashListChatListHarnessState.settingValues.transcriptScrollJumpToBottomAnimateScroll = false;
    flashListChatListHarnessState.settingValues.transcriptMotionPreset = 'off';
    flashListChatListHarnessState.settingValues.transcriptAnimateNewItemsEnabled = false;
  });

  it('shows a jump-to-bottom button when unpinned and new messages arrive', async () => {
    const onViewportChange = vi.fn();
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      ],
    };

    const screen = await renderFlashListChatListSession();
    const { ChatList } = await import('./ChatList');
    await screen.update(
      <ChatList
        session={{ ...flashListChatListHarnessState.sessionState }}
        onViewportChange={onViewportChange}
      />,
    );
    requireCapturedFlashListProps();
    await screen.triggerInitialFill({ contentHeight: 3000, contentWidth: 400, layoutHeight: 600, layoutWidth: 400 });

    // Scroll up (unpinned)
    await triggerFlashListChatListScroll(200, viewportGeometry, { turns: 1 });

    // New message arrives
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        ...(flashListChatListHarnessState.sessionMessagesState.messages ?? []),
        { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'a2' },
      ],
    };

    await screen.update(
      <ChatList
        session={{ ...flashListChatListHarnessState.sessionState }}
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
    flashListChatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
      ],
    };

    const screen = await renderFlashListChatListSession();
    requireCapturedFlashListProps();
    await screen.triggerInitialFill({ contentHeight: 3000, contentWidth: 400, layoutHeight: 600, layoutWidth: 400 });

    await triggerFlashListChatListScroll(200, viewportGeometry, { turns: 1 });

    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      ],
    };

    const { ChatList } = await import('./ChatList');
    await screen.update(<ChatList session={{ ...flashListChatListHarnessState.sessionState }} />);

    const jumpButtons = screen.findAllByTestId('transcript-jump-to-bottom');
    expect(jumpButtons.length).toBeGreaterThan(0);

    await screen.unmount();
  });
});
