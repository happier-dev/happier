import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import {
  flashListChatListHarnessState,
  renderFlashListChatListSession,
  resetFlashListChatListHarness,
} from '@/dev/testkit/harness/chatListHarness';
import { installFlashListChatListCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const buildChatListItemsMock = vi.fn((..._args: any[]): any[] => []);

let renderedTurnViewProps: any[] = [];

installFlashListChatListCommonModuleMocks();

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
  useReducedMotionPreference: () => false,
}));

vi.mock('@/components/sessions/chatListItems', async () => (
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListItemsModuleMock(buildChatListItemsMock)
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
  MessageViewWithSessionCommon: () => React.createElement('MessageViewWithSessionCommon'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
  TurnView: (props: any) => {
    renderedTurnViewProps.push(props);
    return React.createElement('TurnView', props);
  },
  TurnViewWithSessionCommon: (props: any) => {
    renderedTurnViewProps.push(props);
    return React.createElement('TurnViewWithSessionCommon', props);
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
    resetFlashListChatListHarness();
    buildChatListItemsMock.mockReset();
    renderedTurnViewProps = [];
  });

  it('passes thinking expansion helpers into TurnView when in turns mode', async () => {
    flashListChatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    flashListChatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    flashListChatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.sessionThinkingDisplayMode = 'inline';
    flashListChatListHarnessState.settingValues.sessionThinkingInlinePresentation = 'summary';

    const thinkingMessage = { kind: 'agent-text', id: 't1', localId: null, createdAt: 2, text: 'think', isThinking: true };
    const userMessage = { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' };
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [userMessage, thinkingMessage],
    };
    buildChatListItemsMock.mockReturnValue([
      { kind: 'message', id: userMessage.id, messageId: userMessage.id, createdAt: userMessage.createdAt, seq: null },
      { kind: 'message', id: thinkingMessage.id, messageId: thinkingMessage.id, createdAt: thinkingMessage.createdAt, seq: null },
    ]);

    const screen = await renderFlashListChatListSession();

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

  it('keeps turn message lookup available when the messages map changes', async () => {
    flashListChatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    flashListChatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    flashListChatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.sessionThinkingDisplayMode = 'inline';
    flashListChatListHarnessState.settingValues.sessionThinkingInlinePresentation = 'summary';

    const initialUserMessage = { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'initial user' };
    const initialAgentMessage = { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'initial answer', isThinking: false };
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [initialUserMessage, initialAgentMessage],
    };
    buildChatListItemsMock.mockReturnValue([
      { kind: 'message', id: initialUserMessage.id, messageId: initialUserMessage.id, createdAt: initialUserMessage.createdAt, seq: null },
      { kind: 'message', id: initialAgentMessage.id, messageId: initialAgentMessage.id, createdAt: initialAgentMessage.createdAt, seq: null },
    ]);

    const { ChatList } = await import('./ChatList');
    const screen = await renderFlashListChatListSession();

    const firstTurnProps = renderedTurnViewProps[0];
    expect(typeof firstTurnProps?.getMessageById).toBe('function');
    expect(firstTurnProps?.getMessageById?.('u1')?.text).toBe('initial user');

    const updatedUserMessage = { ...initialUserMessage, text: 'updated user' };
    const updatedAgentMessage = { ...initialAgentMessage, text: 'updated answer' };
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [updatedUserMessage, updatedAgentMessage],
    };

    await act(async () => {
      // Message updates bump the session seq in production; the ChatList memo
      // (buildTranscriptRenderSignature) needs a signature-relevant change to re-render.
      await screen.update(<ChatList session={{ ...flashListChatListHarnessState.sessionState, seq: 1 }} />);
    });

    const lastTurnProps = renderedTurnViewProps[renderedTurnViewProps.length - 1];
    expect(typeof lastTurnProps?.getMessageById).toBe('function');
    expect(lastTurnProps?.getMessageById?.('u1')?.text).toBe('updated user');
    expect(lastTurnProps?.getMessageById?.('a1')?.text).toBe('updated answer');

    await screen.unmount();
  });

  it('passes transcript session common into TurnView when in turns mode', async () => {
    flashListChatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    flashListChatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    flashListChatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.sessionThinkingDisplayMode = 'inline';
    flashListChatListHarnessState.settingValues.sessionThinkingInlinePresentation = 'summary';
    flashListChatListHarnessState.settingValues.sessionThinkingInlineChrome = 'plain';
    flashListChatListHarnessState.settingValues.transcriptStreamingSmoothingEnabled = false;
    flashListChatListHarnessState.settingValues.transcriptStreamingSettleDelayMs = 0;
    flashListChatListHarnessState.settingValues.transcriptStreamingPartialOutputEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptStreamingMarkdownRenderingEnabled = false;
    flashListChatListHarnessState.settingValues.transcriptMessageTimestampDisplayMode = 'always';
    flashListChatListHarnessState.settingValues.sessionReplayEnabled = false;
    flashListChatListHarnessState.settingValues.sessionReplayStrategy = 'recent_messages';
    flashListChatListHarnessState.settingValues.sessionReplaySummaryRunnerV1 = null;
    flashListChatListHarnessState.settingValues.sessionReplayMaxSeedChars = 120_000;
    flashListChatListHarnessState.settingValues.toolViewTimelineChromeMode = 'cards';
    flashListChatListHarnessState.settingValues.transcriptToolCallsCollapsedPreviewCount = 1;
    flashListChatListHarnessState.settingValues.transcriptToolCallsGroupShowBackground = false;

    const userMessage = { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' };
    const agentMessage = { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'answer', isThinking: false };
    flashListChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [userMessage, agentMessage],
    };
    buildChatListItemsMock.mockReturnValue([
      { kind: 'message', id: userMessage.id, messageId: userMessage.id, createdAt: userMessage.createdAt, seq: null },
      { kind: 'message', id: agentMessage.id, messageId: agentMessage.id, createdAt: agentMessage.createdAt, seq: null },
    ]);

    const screen = await renderFlashListChatListSession();

    const firstTurnProps = renderedTurnViewProps[0];
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
      reducerState: null,
    }));

    await screen.unmount();
  });
});
