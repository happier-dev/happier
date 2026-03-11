import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFlatListProps: any = null;
let capturedMessageViewProps: any[] = [];

let sessionMessagesState: { messages: any[]; isLoaded: boolean } = { messages: [], isLoaded: true };
let sessionPendingState: { messages: any[] } = { messages: [] };
let sessionActionDraftsState: any[] = [];
let sessionState: any = null;
let transcriptDraftMessagesState: any[] = [];

const buildChatListItemsMock = vi.fn((..._args: any[]): any[] => []);

const settingValues: Record<string, any> = {};

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
      capturedFlatListProps = props;
      const data = Array.isArray(props?.data) ? props.data : [];
      const children = data.map((item: any, index: number) => {
        const key = typeof props?.keyExtractor === 'function' ? props.keyExtractor(item, index) : String(index);
        return ReactMod.createElement(ReactMod.Fragment, { key }, props.renderItem?.({ item, index }));
      });
      return ReactMod.createElement('FlatList', null, children);
    },
  };
});

vi.mock('@/utils/platform/responsive', () => ({
  useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useSession: () => sessionState,
  useSessionTranscriptIds: () => ({
    ids: [
      ...(sessionMessagesState.messages ?? []).map((m: any) => m.id),
      ...(transcriptDraftMessagesState ?? []).map((m: any) => m.id),
    ],
    isLoaded: sessionMessagesState.isLoaded,
  }),
  useSessionMessagesById: () => Object.fromEntries([
    ...(sessionMessagesState.messages ?? []).map((m: any) => [m.id, m]),
    ...(transcriptDraftMessagesState ?? []).map((m: any) => [m.id, m]),
  ]),
  useForkedTranscriptSnapshot: () => null,
  useSessionPendingMessages: () => sessionPendingState,
  useSessionActionDrafts: () => sessionActionDraftsState,
  useSessionTranscriptDraftMessages: () => transcriptDraftMessagesState,
  useSessionLatestThinkingMessageId: () => null,
  useSessionLatestThinkingMessageActivityAtMs: () => null,
  useMessage: (_sessionId: string, messageId: string) => {
    const committed = (sessionMessagesState.messages ?? []).find((m: any) => m.id === messageId);
    return committed ?? (transcriptDraftMessagesState ?? []).find((m: any) => m.id === messageId) ?? null;
  },
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

vi.mock('./ChatFooter', () => ({
  ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
  MessageView: (props: any) => {
    capturedMessageViewProps.push(props);
    return React.createElement('MessageView');
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

describe('ChatList (turn grouping mode)', () => {
  beforeEach(() => {
    capturedFlatListProps = null;
    capturedMessageViewProps = [];
    buildChatListItemsMock.mockClear();
    sessionMessagesState = { messages: [], isLoaded: true };
    sessionPendingState = { messages: [] };
    sessionActionDraftsState = [];
    transcriptDraftMessagesState = [];
    sessionState = {
      id: 'session-1',
      seq: 0,
      metadata: null,
      accessLevel: null,
      canApprovePermissions: true,
      agentState: null,
    };
    for (const k of Object.keys(settingValues)) delete settingValues[k];
  });

  it('renders turn items when transcriptGroupingMode is turns', async () => {
    settingValues.transcriptGroupingMode = 'turns';
    settingValues.transcriptGroupToolCalls = false;
    settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    settingValues.transcriptListImplementation = 'flatlist_legacy';

    const messages = [
      { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
    ];
    sessionMessagesState = { isLoaded: true, messages };
    buildChatListItemsMock.mockImplementation((opts: any) => {
      if (opts?.includeCommittedMessages === false) return [];
      return messages.map((m) => ({
        kind: 'message',
        id: m.id,
        messageId: m.id,
        createdAt: m.createdAt,
        seq: null,
      }));
    });

    const { ChatList } = await import('./ChatList');
    await act(async () => {
      renderer.create(<ChatList session={sessionState} />);
    });

    expect(capturedFlatListProps).toBeTruthy();
    expect(Array.isArray(capturedFlatListProps.data)).toBe(true);
    expect(capturedFlatListProps.data[0]?.kind).toBe('turn');
    expect(capturedMessageViewProps.map((props) => props?.message?.id)).toEqual(['u1', 'a1']);
  });

  it('does not group tool calls into tool-call groups when tool chrome mode is cards', async () => {
    settingValues.transcriptGroupingMode = 'turns';
    settingValues.transcriptGroupToolCalls = true;
    settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    settingValues.toolViewTimelineChromeMode = 'cards';
    settingValues.transcriptListImplementation = 'flatlist_legacy';

    const messages = [
      { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
      { kind: 'tool-call', id: 't1', localId: null, createdAt: 2, tool: { name: 'Bash' } },
      { kind: 'agent-text', id: 'a1', localId: null, createdAt: 3, text: 'a1' },
    ];
    sessionMessagesState = { isLoaded: true, messages };
    buildChatListItemsMock.mockImplementation((opts: any) => {
      if (opts?.includeCommittedMessages === false) return [];
      return messages.map((m) => ({
        kind: 'message',
        id: m.id,
        messageId: m.id,
        createdAt: m.createdAt,
        seq: null,
      }));
    });

    const { ChatList } = await import('./ChatList');
    await act(async () => {
      renderer.create(<ChatList session={sessionState} />);
    });

    const firstTurn = capturedFlatListProps.data[0]?.turn;
    expect(firstTurn).toBeTruthy();
    const kinds = (firstTurn.content ?? []).map((c: any) => c.kind);
    expect(kinds).not.toContain('tool_calls');
  });

  it('renders main-chain transcript drafts after committed messages', async () => {
    settingValues.transcriptGroupingMode = 'linear';
    settingValues.transcriptGroupToolCalls = false;
    settingValues.transcriptListImplementation = 'flatlist_legacy';

    const messages = [
      { kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'Committed' },
    ];
    sessionMessagesState = { isLoaded: true, messages };
    transcriptDraftMessagesState = [
      { kind: 'agent-text', id: 'draft:local-1', localId: 'local-1', createdAt: 2, text: 'Draft tail', isThinking: true },
    ];
    buildChatListItemsMock.mockImplementation((opts: any) => {
      if (opts?.includeCommittedMessages === false) return [];
      return (opts.messageIdsOldestFirst ?? []).map((id: string) => ({
        kind: 'message',
        id,
        messageId: id,
        createdAt: opts.messagesById[id]?.createdAt ?? 0,
        seq: null,
      }));
    });

    const { ChatList } = await import('./ChatList');
    await act(async () => {
      renderer.create(<ChatList session={sessionState} />);
    });

    expect(capturedMessageViewProps.map((props) => props?.message?.id)).toEqual(['draft:local-1', 'm1']);
    expect(capturedMessageViewProps[0]?.message?.text).toBe('Draft tail');
  });
});
