import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import {
  chatListHarnessState,
  renderChatListHarnessSession,
  resetChatListHarness,
} from '@/dev/testkit/harness/chatListHarness';
import { installChatListHarnessCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const buildChatListItemsMock = vi.fn((..._args: any[]): any[] => []);

let renderedMessageViewProps: any[] = [];

installChatListHarnessCommonModuleMocks();

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
  useReducedMotionPreference: () => false,
}));

vi.mock('@/components/sessions/chatListItems', async () => (
  (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessItemsModuleMock(buildChatListItemsMock)
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
  MessageView: (props: any) => {
    renderedMessageViewProps.push(props);
    return React.createElement('MessageView');
  },
  MessageViewWithSessionCommon: (props: any) => {
    renderedMessageViewProps.push(props);
    return React.createElement('MessageViewWithSessionCommon');
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

vi.mock('@/sync/sync', async () => (
  (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessSyncModuleMock()
));

describe('ChatList (turn thinking expansion wiring)', () => {
  afterEach(() => {
    standardCleanup();
  });

  beforeEach(() => {
    resetChatListHarness({
      syncTuningState: {
        transcriptForwardPrefetchThresholdPx: 800,
        transcriptEstimatedItemSizePx: 48,
      },
    });
    buildChatListItemsMock.mockReset();
    renderedMessageViewProps = [];
  });

  it('passes controlled thinking expansion into turn-derived message unit rows', async () => {
    chatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    chatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    chatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    chatListHarnessState.settingValues.sessionThinkingDisplayMode = 'inline';
    chatListHarnessState.settingValues.sessionThinkingInlinePresentation = 'summary';

    const thinkingMessage = { kind: 'agent-text', id: 't1', localId: null, createdAt: 2, text: 'think', isThinking: true };
    const userMessage = { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' };
    chatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [userMessage, thinkingMessage],
    };
    buildChatListItemsMock.mockReturnValue([
      { kind: 'message', id: userMessage.id, messageId: userMessage.id, createdAt: userMessage.createdAt, seq: null },
      { kind: 'message', id: thinkingMessage.id, messageId: thinkingMessage.id, createdAt: thinkingMessage.createdAt, seq: null },
    ]);

    const screen = await renderChatListHarnessSession();

    // Turns decompose into per-message unit rows (plan N2c); the list-owned controlled
    // thinking expansion reaches the thinking unit row through ChatListMessageRow.
    const firstThinkingProps = renderedMessageViewProps.find((p) => p?.message?.id === 't1');
    expect(firstThinkingProps).toBeTruthy();
    expect(firstThinkingProps?.thinkingExpanded).toBe(false);
    expect(typeof firstThinkingProps?.onThinkingExpandedChange).toBe('function');

    await act(async () => {
      firstThinkingProps.onThinkingExpandedChange(true);
    });

    const lastThinkingProps = [...renderedMessageViewProps].reverse().find((p) => p?.message?.id === 't1');
    expect(lastThinkingProps?.thinkingExpanded).toBe(true);

    await screen.unmount();
  });

  it('keeps unit rows reading live messages when the messages map changes', async () => {
    chatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    chatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    chatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    chatListHarnessState.settingValues.sessionThinkingDisplayMode = 'inline';
    chatListHarnessState.settingValues.sessionThinkingInlinePresentation = 'summary';

    const initialUserMessage = { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'initial user' };
    const initialAgentMessage = { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'initial answer', isThinking: false };
    chatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [initialUserMessage, initialAgentMessage],
    };
    buildChatListItemsMock.mockReturnValue([
      { kind: 'message', id: initialUserMessage.id, messageId: initialUserMessage.id, createdAt: initialUserMessage.createdAt, seq: null },
      { kind: 'message', id: initialAgentMessage.id, messageId: initialAgentMessage.id, createdAt: initialAgentMessage.createdAt, seq: null },
    ]);

    const { ChatList } = await import('./ChatList');
    const screen = await renderChatListHarnessSession();

    const firstUserProps = renderedMessageViewProps.find((p) => p?.message?.id === 'u1');
    expect(firstUserProps?.message?.text).toBe('initial user');

    const updatedUserMessage = { ...initialUserMessage, text: 'updated user' };
    const updatedAgentMessage = { ...initialAgentMessage, text: 'updated answer' };
    chatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [updatedUserMessage, updatedAgentMessage],
    };

    await act(async () => {
      // Message updates bump the session seq in production; the ChatList memo
      // (buildTranscriptRenderSignature) needs a signature-relevant change to re-render.
      await screen.update(<ChatList session={{ ...chatListHarnessState.sessionState, seq: 1 }} />);
    });

    const lastUserProps = [...renderedMessageViewProps].reverse().find((p) => p?.message?.id === 'u1');
    const lastAgentProps = [...renderedMessageViewProps].reverse().find((p) => p?.message?.id === 'a1');
    expect(lastUserProps?.message?.text).toBe('updated user');
    expect(lastAgentProps?.message?.text).toBe('updated answer');

    await screen.unmount();
  });

  it('passes transcript session common into turn-derived unit rows', async () => {
    chatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    chatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    chatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    chatListHarnessState.settingValues.sessionThinkingDisplayMode = 'inline';
    chatListHarnessState.settingValues.sessionThinkingInlinePresentation = 'summary';
    chatListHarnessState.settingValues.sessionThinkingInlineChrome = 'plain';
    chatListHarnessState.settingValues.transcriptStreamingSmoothingEnabled = false;
    chatListHarnessState.settingValues.transcriptStreamingSettleDelayMs = 0;
    chatListHarnessState.settingValues.transcriptStreamingPartialOutputEnabled = true;
    chatListHarnessState.settingValues.transcriptStreamingMarkdownRenderingEnabled = false;
    chatListHarnessState.settingValues.transcriptMessageTimestampDisplayMode = 'always';
    chatListHarnessState.settingValues.sessionReplayEnabled = false;
    chatListHarnessState.settingValues.sessionReplayStrategy = 'recent_messages';
    chatListHarnessState.settingValues.sessionReplaySummaryRunnerV1 = null;
    chatListHarnessState.settingValues.sessionReplayMaxSeedChars = 120_000;
    chatListHarnessState.settingValues.toolViewTimelineChromeMode = 'cards';
    chatListHarnessState.settingValues.transcriptToolCallsCollapsedPreviewCount = 1;
    chatListHarnessState.settingValues.transcriptToolCallsGroupShowBackground = false;

    const userMessage = { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' };
    const agentMessage = { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'answer', isThinking: false };
    chatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [userMessage, agentMessage],
    };
    buildChatListItemsMock.mockReturnValue([
      { kind: 'message', id: userMessage.id, messageId: userMessage.id, createdAt: userMessage.createdAt, seq: null },
      { kind: 'message', id: agentMessage.id, messageId: agentMessage.id, createdAt: agentMessage.createdAt, seq: null },
    ]);

    const screen = await renderChatListHarnessSession();

    const firstTurnProps = renderedMessageViewProps.find((p) => p?.message?.id === 'u1');
    expect(firstTurnProps?.messageDisplayCommon).toEqual(expect.objectContaining({
      sessionThinkingDisplayMode: 'inline',
      transcriptMessageTimestampDisplayMode: 'always',
    }));
    expect(firstTurnProps?.forkCommon).toEqual(expect.objectContaining({
      sessionReplayEnabled: false,
      sessionReplayStrategy: 'recent_messages',
    }));
    expect(firstTurnProps?.toolChromeCommon).toEqual(expect.objectContaining({
      toolViewTimelineChromeMode: 'cards',
      transcriptToolCallsCollapsedPreviewCount: 1,
    }));
    expect(firstTurnProps?.toolRouteCommon).toEqual(expect.objectContaining({
      messagesById: expect.any(Object),
    }));

    await screen.unmount();
  });
});
