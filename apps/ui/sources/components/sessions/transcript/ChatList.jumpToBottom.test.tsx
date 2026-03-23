import * as React from 'react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import {
  legacyChatListHarnessState,
  renderLegacyChatList,
  requireCapturedFlatListProps,
  resetLegacyChatListHarness,
  triggerLegacyChatListScroll,
} from './ChatList.legacyListTestHarness';
import { installLegacyChatListHarnessCommonModuleMocks } from './chatListLegacyHarnessTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installLegacyChatListHarnessCommonModuleMocks();

vi.mock('@/components/sessions/chatListItems', async () => (
  (await import('./ChatList.legacyListTestHarness')).createLegacyChatListItemsModuleMock()
));

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
    }),
  },
}));

describe('ChatList (jump-to-bottom)', () => {
  afterEach(() => {
    standardCleanup();
  });

  beforeEach(() => {
    resetLegacyChatListHarness();
    legacyChatListHarnessState.sessionState = {
      id: 'session-1',
      seq: 0,
      metadata: null,
      accessLevel: null,
      canApprovePermissions: true,
      agentState: null,
    };
    legacyChatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
    legacyChatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    legacyChatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    legacyChatListHarnessState.settingValues.transcriptListImplementation = 'flatlist_legacy';
    legacyChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    legacyChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 72;
    legacyChatListHarnessState.settingValues.transcriptScrollJumpToBottomEnabled = true;
    legacyChatListHarnessState.settingValues.transcriptScrollJumpToBottomMinNewCount = 1;
    legacyChatListHarnessState.settingValues.transcriptScrollJumpToBottomAnimateScroll = false;
    legacyChatListHarnessState.settingValues.transcriptMotionPreset = 'off';
    legacyChatListHarnessState.settingValues.transcriptAnimateNewItemsEnabled = false;
  });

  it('shows a jump-to-bottom button when unpinned and new messages arrive', async () => {
    legacyChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      ],
    };

    const screen = await renderLegacyChatList();
    requireCapturedFlatListProps();

    // Scroll up (unpinned)
    await triggerLegacyChatListScroll(200);

    // New message arrives
    legacyChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        ...(legacyChatListHarnessState.sessionMessagesState.messages ?? []),
        { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'a2' },
      ],
    };

    const { ChatList } = await import('./ChatList');
    await screen.update(<ChatList session={{ ...legacyChatListHarnessState.sessionState }} />);

    const jumpButtons = screen.findAllByTestId('transcript-jump-to-bottom');
    expect(jumpButtons.length).toBeGreaterThan(0);

    await screen.unmount();
  });
});
