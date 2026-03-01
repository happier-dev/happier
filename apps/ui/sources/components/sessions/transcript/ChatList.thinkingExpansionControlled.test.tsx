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

let renderedMessageViewProps: any[] = [];

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
  MessageView: (props: any) => {
    renderedMessageViewProps.push(props);
    return React.createElement('MessageView', props);
  },
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

describe('ChatList (thinking expansion controlled)', () => {
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
    renderedMessageViewProps = [];
  });

  it('controls inline thinking expansion via list-owned state (no per-row state)', async () => {
    settingValues.transcriptGroupingMode = 'linear';
    settingValues.transcriptListImplementation = 'flatlist_legacy';
    settingValues.sessionThinkingDisplayMode = 'inline';
    settingValues.sessionThinkingInlinePresentation = 'summary';

    const thinkingMessage = { kind: 'agent-text', id: 't1', localId: null, createdAt: 1, text: 'think', isThinking: true };
    const normalMessage = { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'answer', isThinking: false };
    sessionMessagesState = { isLoaded: true, messages: [thinkingMessage, normalMessage] };
    buildChatListItemsMock.mockReturnValue([
      { kind: 'message', id: thinkingMessage.id, messageId: thinkingMessage.id, createdAt: thinkingMessage.createdAt, seq: null },
      { kind: 'message', id: normalMessage.id, messageId: normalMessage.id, createdAt: normalMessage.createdAt, seq: null },
    ]);

    const { ChatList } = await import('./ChatList');
    await act(async () => {
      renderer.create(<ChatList session={sessionState} />);
    });

    const firstThinkingProps = renderedMessageViewProps.find((p) => p?.message?.id === 't1');
    const firstNormalProps = renderedMessageViewProps.find((p) => p?.message?.id === 'a1');

    expect(firstThinkingProps?.thinkingExpanded).toBe(false);
    expect(typeof firstThinkingProps?.onThinkingExpandedChange).toBe('function');
    expect(firstNormalProps?.thinkingExpanded).toBeUndefined();
    expect(firstNormalProps?.onThinkingExpandedChange).toBeUndefined();

    await act(async () => {
      firstThinkingProps.onThinkingExpandedChange(true);
    });

    const lastThinkingProps = [...renderedMessageViewProps].reverse().find((p) => p?.message?.id === 't1');
    expect(lastThinkingProps?.thinkingExpanded).toBe(true);
  });
});
