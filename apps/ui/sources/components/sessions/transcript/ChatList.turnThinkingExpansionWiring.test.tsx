import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let sessionMessagesState: { messages: any[]; isLoaded: boolean } = { messages: [], isLoaded: true };
let sessionPendingState: { messages: any[] } = { messages: [] };
let sessionActionDraftsState: any[] = [];
let sessionState: any = null;
const settingValues: Record<string, any> = {};

const buildChatListItemsMock = vi.fn((..._args: any[]): any[] => []);

let renderedTurnViewProps: any[] = [];

vi.mock('@shopify/flash-list', () => ({
  FlashList: () => null,
}));

vi.mock('react-native', async (importOriginal) => {
  const ReactMod = await import('react');
  const actual = await importOriginal<any>();
  return {
    ...actual,
    Platform: {
      OS: 'web',
      select: (spec: any) => {
        if (!spec || typeof spec !== 'object') return undefined;
        return spec.web ?? spec.default;
      },
    },
    View: (props: any) => ReactMod.createElement('View', props, props.children),
    ActivityIndicator: () => ReactMod.createElement('ActivityIndicator'),
    FlatList: (props: any) => {
      const children = (props.data ?? []).map((item: any, index: number) =>
        ReactMod.createElement(
          ReactMod.Fragment,
          { key: props.keyExtractor?.(item, index) ?? String(index) },
          props.renderItem?.({ item, index }),
        ),
      );
      return ReactMod.createElement('FlatList', props, children);
    },
  };
});

vi.mock('@/utils/platform/responsive', () => ({
  useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
  useReducedMotionPreference: () => false,
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useSession: () => sessionState,
  useSessionTranscriptIds: () => ({
    ids: (sessionMessagesState.messages ?? []).map((m: any) => m.id),
    isLoaded: sessionMessagesState.isLoaded,
  }),
  useSessionMessagesById: () => Object.fromEntries((sessionMessagesState.messages ?? []).map((m: any) => [m.id, m])),
  useForkedTranscriptSnapshot: () => null,
  useSessionPendingMessages: () => sessionPendingState,
  useSessionActionDrafts: () => sessionActionDraftsState,
  useSessionLatestThinkingMessageId: () => null,
  useSessionLatestThinkingMessageActivityAtMs: () => null,
  useMessage: () => null,
  useSetting: (key: string) => settingValues[key],
  getStorage: () => ({
    getState: () => ({
      sessionMessages: {
        [sessionState?.id ?? 'session-1']: {
          messagesById: Object.fromEntries((sessionMessagesState.messages ?? []).map((m: any) => [m.id, m])),
          messagesMap: Object.fromEntries((sessionMessagesState.messages ?? []).map((m: any) => [m.id, m])),
        },
      },
    }),
  }),
}));

vi.mock('@/components/sessions/chatListItems', () => ({
  buildChatListItems: buildChatListItemsMock,
  buildChatListItemsCached: (opts: any) => ({ cache: null, items: buildChatListItemsMock(opts) }),
}));

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
  beforeEach(() => {
    sessionMessagesState = { messages: [], isLoaded: true };
    sessionPendingState = { messages: [] };
    sessionActionDraftsState = [];
    sessionState = {
      id: 'session-1',
      seq: 0,
      metadata: null,
      accessLevel: null,
      canApprovePermissions: true,
      agentState: null,
      thinking: false,
    };
    for (const k of Object.keys(settingValues)) delete settingValues[k];
    buildChatListItemsMock.mockReset();
    renderedTurnViewProps = [];
  });

  it('passes thinking expansion helpers into TurnView when in turns mode', async () => {
    settingValues.transcriptGroupingMode = 'turns';
    settingValues.transcriptGroupToolCalls = false;
    settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    settingValues.transcriptListImplementation = 'flatlist_legacy';
    settingValues.sessionThinkingDisplayMode = 'inline';
    settingValues.sessionThinkingInlinePresentation = 'summary';

    const thinkingMessage = { kind: 'agent-text', id: 't1', localId: null, createdAt: 2, text: 'think', isThinking: true };
    const userMessage = { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' };
    sessionMessagesState = { isLoaded: true, messages: [userMessage, thinkingMessage] };
    buildChatListItemsMock.mockReturnValue([
      { kind: 'message', id: userMessage.id, messageId: userMessage.id, createdAt: userMessage.createdAt, seq: null },
      { kind: 'message', id: thinkingMessage.id, messageId: thinkingMessage.id, createdAt: thinkingMessage.createdAt, seq: null },
    ]);

    const { ChatList } = await import('./ChatList');
    await act(async () => {
      renderer.create(<ChatList session={sessionState} />);
    });

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
  });

  it('refreshes the turn message lookup when the messages map changes', async () => {
    settingValues.transcriptGroupingMode = 'turns';
    settingValues.transcriptGroupToolCalls = false;
    settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    settingValues.transcriptListImplementation = 'flatlist_legacy';
    settingValues.sessionThinkingDisplayMode = 'inline';
    settingValues.sessionThinkingInlinePresentation = 'summary';

    const initialUserMessage = { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'initial user' };
    const initialAgentMessage = { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'initial answer', isThinking: false };
    sessionMessagesState = { isLoaded: true, messages: [initialUserMessage, initialAgentMessage] };
    buildChatListItemsMock.mockReturnValue([
      { kind: 'message', id: initialUserMessage.id, messageId: initialUserMessage.id, createdAt: initialUserMessage.createdAt, seq: null },
      { kind: 'message', id: initialAgentMessage.id, messageId: initialAgentMessage.id, createdAt: initialAgentMessage.createdAt, seq: null },
    ]);

    const { ChatList } = await import('./ChatList');
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ChatList session={sessionState} />);
    });

    const firstTurnProps = renderedTurnViewProps[0];
    expect(firstTurnProps?.getMessageById?.('a1')?.text).toBe('initial answer');

    const updatedUserMessage = { ...initialUserMessage, text: 'updated user' };
    const updatedAgentMessage = { ...initialAgentMessage, text: 'updated answer' };
    sessionMessagesState = { isLoaded: true, messages: [updatedUserMessage, updatedAgentMessage] };
    const rerenderedSessionState = { ...sessionState };

    await act(async () => {
      tree!.update(<ChatList session={rerenderedSessionState} />);
    });

    const lastTurnProps = renderedTurnViewProps[renderedTurnViewProps.length - 1];
    expect(lastTurnProps?.getMessageById?.('a1')?.text).toBe('updated answer');
  });
});
