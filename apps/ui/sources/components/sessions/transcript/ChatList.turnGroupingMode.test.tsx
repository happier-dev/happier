import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFlatListProps: any = null;

let sessionMessagesState: { messages: any[]; isLoaded: boolean } = { messages: [], isLoaded: true };
let sessionPendingState: { messages: any[] } = { messages: [] };
let sessionActionDraftsState: any[] = [];
let sessionState: any = null;

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
    Platform: { OS: 'web' },
    View: (props: any) => ReactMod.createElement('View', props, props.children),
    ActivityIndicator: () => ReactMod.createElement('ActivityIndicator'),
    FlatList: (props: any) => {
      capturedFlatListProps = props;
      return ReactMod.createElement('FlatList');
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
	      transcriptWebInitialPinStabilizeMs: 0,
	      transcriptWebInitialPinRetryIntervalMs: 250,
	      transcriptForwardPrefetchThresholdPx: 800,
	      transcriptFlashListEstimatedItemSize: 48,
	    }),
	  },
	}));

describe('ChatList (turn grouping mode)', () => {
  beforeEach(() => {
    capturedFlatListProps = null;
    buildChatListItemsMock.mockClear();
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
    };
    for (const k of Object.keys(settingValues)) delete settingValues[k];
  });

  it('renders turn items when transcriptGroupingMode is turns', async () => {
    settingValues.transcriptGroupingMode = 'turns';
    settingValues.transcriptTurnShowActivityGroup = false;
    settingValues.transcriptTurnActivityGroupStrategy = 'consecutive_tools';
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
  });
});
