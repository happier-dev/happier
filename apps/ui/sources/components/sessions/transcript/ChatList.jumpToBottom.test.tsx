import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFlatListProps: any = null;

let sessionMessagesState: { messages: any[]; isLoaded: boolean } = { messages: [], isLoaded: true };
let sessionPendingState: { messages: any[] } = { messages: [] };
let sessionActionDraftsState: any[] = [];
let sessionState: any = null;

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
      select: (values: any) => values?.web ?? values?.default,
    },
    View: (props: any) => ReactMod.createElement('View', props, props.children),
    Pressable: ({ children, ...props }: any) => ReactMod.createElement('Pressable', props, children),
    ActivityIndicator: () => ReactMod.createElement('ActivityIndicator'),
    FlatList: (props: any) => {
      capturedFlatListProps = props;
      const children: any[] = [];
      if (props.ListHeaderComponent) children.push(props.ListHeaderComponent);
      if (Array.isArray(props.data) && typeof props.renderItem === 'function') {
        for (const item of props.data) {
          children.push(props.renderItem({ item }));
        }
      }
      if (props.ListFooterComponent) children.push(props.ListFooterComponent);
      return ReactMod.createElement('FlatList', null, ...children);
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
  useMessage: (_sessionId: string, messageId: string) => {
    const byId = Object.fromEntries((sessionMessagesState.messages ?? []).map((m: any) => [m.id, m]));
    return byId[messageId] ?? null;
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
  buildChatListItems: ({ messageIdsOldestFirst, messagesById, pendingMessages, actionDrafts }: any) => {
    const items: any[] = [];
    for (const id of messageIdsOldestFirst || []) {
      const m = messagesById?.[id];
      if (!m) continue;
      items.push({ kind: 'message', id: m.id, messageId: m.id, createdAt: m.createdAt, seq: null });
    }
    if ((pendingMessages || []).length > 0) items.push({ kind: 'pending-queue', id: 'pending-queue', pendingMessages, discardedMessages: [] });
    for (const d of actionDrafts || []) items.push({ kind: 'action-draft', id: `draft:${d.id}`, draft: d });
    return items;
  },
  buildChatListItemsCached: (opts: any) => ({
    cache: null,
    items: (() => {
      const items: any[] = [];
      for (const id of opts?.messageIdsOldestFirst || []) {
        const m = opts?.messagesById?.[id];
        if (!m) continue;
        items.push({ kind: 'message', id: m.id, messageId: m.id, createdAt: m.createdAt, seq: null });
      }
      if ((opts?.pendingMessages || []).length > 0) items.push({ kind: 'pending-queue', id: 'pending-queue', pendingMessages: opts?.pendingMessages, discardedMessages: [] });
      for (const d of opts?.actionDrafts || []) items.push({ kind: 'action-draft', id: `draft:${d.id}`, draft: d });
      return items;
    })(),
  }),
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
      transcriptForwardPrefetchThresholdPx: 0,
      transcriptBackwardPrefetchThresholdPx: 0,
    }),
  },
}));

describe('ChatList (jump-to-bottom)', () => {
  beforeEach(() => {
    capturedFlatListProps = null;
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

    settingValues.transcriptGroupingMode = 'linear';
    settingValues.transcriptGroupToolCalls = false;
    settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    settingValues.transcriptListImplementation = 'flatlist_legacy';

    settingValues.transcriptScrollPinEnabled = true;
    settingValues.transcriptScrollPinOffsetThresholdPx = 72;
    settingValues.transcriptScrollJumpToBottomEnabled = true;
    settingValues.transcriptScrollJumpToBottomMinNewCount = 1;
    settingValues.transcriptScrollJumpToBottomAnimateScroll = false;

    settingValues.transcriptMotionPreset = 'off';
    settingValues.transcriptAnimateNewItemsEnabled = false;
  });

  it('shows a jump-to-bottom button when unpinned and new messages arrive', async () => {
    sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      ],
    };

    const { ChatList } = await import('./ChatList');
    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(<ChatList session={{ ...sessionState }} />);
    });

    // Scroll up (unpinned)
    await act(async () => {
      expect(typeof capturedFlatListProps.onScroll).toBe('function');
      capturedFlatListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 200 } } });
      await Promise.resolve();
    });

    // New message arrives
    sessionMessagesState = {
      isLoaded: true,
      messages: [
        ...sessionMessagesState.messages,
        { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'a2' },
      ],
    };

    await act(async () => {
      tree!.update(<ChatList session={{ ...sessionState }} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const jumpButtons = tree!.root.findAll((node) => {
      return (node as any).type === 'Pressable' && (node as any).props?.testID === 'transcript-jump-to-bottom';
    });
    expect(jumpButtons.length).toBe(1);
  });
});
