import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import {
  legacyChatListHarnessState,
  renderLegacyChatList,
  resetLegacyChatListHarness,
} from './ChatList.legacyListTestHarness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const buildChatListItemsMock = vi.fn((..._args: any[]): any[] => []);

let renderedTurnViewProps: any[] = [];

vi.mock('@shopify/flash-list', () => ({
  FlashList: () => null,
}));

vi.mock('react-native', async () => (
    (await import('@/dev/testkit/harness/chatListHarness')).createLegacyChatListReactNativeMock()
));

vi.mock('@/utils/platform/responsive', () => ({
  useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
  useReducedMotionPreference: () => false,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => (
    (await import('@/dev/testkit/harness/chatListHarness')).createLegacyChatListStorageMock(importOriginal)
));

vi.mock('@/components/sessions/chatListItems', async () => (
  (await import('./ChatList.legacyListTestHarness')).createLegacyChatListItemsModuleMock(buildChatListItemsMock)
));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionProvider', () => ({
  TranscriptMotionProvider: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
  TranscriptEnterWrapper: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
  JumpToBottomButton: () => null,
}));

vi.mock('./ChatFooter', () => ({
  ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
  MessageView: () => React.createElement('MessageView'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
  TurnView: (props: any) => {
    renderedTurnViewProps.push(props);
    return React.createElement('TurnView', props);
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
    loadOlderMessages: vi.fn(),
    loadNewerMessages: vi.fn(),
    hasDeferredNewerMessages: () => false,
    getSyncTuning: () => ({
      transcriptWebInitialPinStabilizeMs: 0,
      transcriptWebInitialPinRetryIntervalMs: 250,
      transcriptForwardPrefetchThresholdPx: 800,
      transcriptBackwardPrefetchThresholdPx: 0,
      transcriptFlashListEstimatedItemSize: 48,
    }),
  },
}));

describe('ChatList (turn thinking expansion wiring)', () => {
  afterEach(() => {
    standardCleanup();
  });

  beforeEach(() => {
    resetLegacyChatListHarness();
    buildChatListItemsMock.mockReset();
    renderedTurnViewProps = [];
  });

  it('passes thinking expansion helpers into TurnView when in turns mode', async () => {
    legacyChatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    legacyChatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    legacyChatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    legacyChatListHarnessState.settingValues.transcriptListImplementation = 'flatlist_legacy';
    legacyChatListHarnessState.settingValues.sessionThinkingDisplayMode = 'inline';
    legacyChatListHarnessState.settingValues.sessionThinkingInlinePresentation = 'summary';

    const thinkingMessage = { kind: 'agent-text', id: 't1', localId: null, createdAt: 2, text: 'think', isThinking: true };
    const userMessage = { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' };
    legacyChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [userMessage, thinkingMessage],
    };
    buildChatListItemsMock.mockReturnValue([
      { kind: 'message', id: userMessage.id, messageId: userMessage.id, createdAt: userMessage.createdAt, seq: null },
      { kind: 'message', id: thinkingMessage.id, messageId: thinkingMessage.id, createdAt: thinkingMessage.createdAt, seq: null },
    ]);

    const screen = await renderLegacyChatList();

    const firstTurnProps = renderedTurnViewProps[0];
    expect(firstTurnProps).toBeTruthy();
    expect(typeof firstTurnProps.resolveThinkingExpanded).toBe('function');
    expect(typeof firstTurnProps.setThinkingExpanded).toBe('function');
    expect(firstTurnProps.resolveThinkingExpanded('t1')).toBe(false);

    await act(async () => {
      firstTurnProps.setThinkingExpanded('t1', true);
    });

    const lastTurnProps = renderedTurnViewProps[renderedTurnViewProps.length - 1];
    expect(lastTurnProps.resolveThinkingExpanded('t1')).toBe(true);

    await screen.unmount();
  });

  it('refreshes the turn message lookup when the messages map changes', async () => {
    legacyChatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    legacyChatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    legacyChatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    legacyChatListHarnessState.settingValues.transcriptListImplementation = 'flatlist_legacy';
    legacyChatListHarnessState.settingValues.sessionThinkingDisplayMode = 'inline';
    legacyChatListHarnessState.settingValues.sessionThinkingInlinePresentation = 'summary';

    const initialUserMessage = { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'initial user' };
    const initialAgentMessage = { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'initial answer', isThinking: false };
    legacyChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [initialUserMessage, initialAgentMessage],
    };
    buildChatListItemsMock.mockReturnValue([
      { kind: 'message', id: initialUserMessage.id, messageId: initialUserMessage.id, createdAt: initialUserMessage.createdAt, seq: null },
      { kind: 'message', id: initialAgentMessage.id, messageId: initialAgentMessage.id, createdAt: initialAgentMessage.createdAt, seq: null },
    ]);

    const { ChatList } = await import('./ChatList');
    const screen = await renderLegacyChatList();

    const firstTurnProps = renderedTurnViewProps[0];
    expect(firstTurnProps?.getMessageById?.('a1')?.text).toBe('initial answer');

    const updatedUserMessage = { ...initialUserMessage, text: 'updated user' };
    const updatedAgentMessage = { ...initialAgentMessage, text: 'updated answer' };
    legacyChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [updatedUserMessage, updatedAgentMessage],
    };

    await act(async () => {
      await screen.update(<ChatList session={{ ...legacyChatListHarnessState.sessionState }} />);
    });

    const lastTurnProps = renderedTurnViewProps[renderedTurnViewProps.length - 1];
    expect(lastTurnProps?.getMessageById?.('a1')?.text).toBe('updated answer');

    await screen.unmount();
  });
});
