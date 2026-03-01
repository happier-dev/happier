import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFlashListProps: any = null;
let capturedMessageViewProps: any[] = [];

let sessionState: any = null;
let forkSnapshot: any = null;

const useMessageMock = vi.fn();

const settingValues: Record<string, any> = {};

beforeEach(() => {
  capturedFlashListProps = null;
  capturedMessageViewProps = [];
  useMessageMock.mockReset();
  Object.keys(settingValues).forEach((k) => delete settingValues[k]);

  sessionState = {
    id: 'child-1',
    seq: 10,
    metadata: null,
    accessLevel: null,
    canApprovePermissions: true,
    agentState: null,
  };

  forkSnapshot = {
    segments: [
      {
        sessionId: 'parent-1',
        isReadOnlyContext: true,
        cutoffSeqInclusive: 3,
        messageIdsOldestFirst: ['p1'],
      },
      {
        sessionId: 'child-1',
        isReadOnlyContext: false,
        cutoffSeqInclusive: null,
        messageIdsOldestFirst: ['c1'],
      },
    ],
    combinedMessageIdsOldestFirst: ['p1', 'c1'],
    combinedMessagesById: {
      p1: { kind: 'agent-text', id: 'p1', createdAt: 1, text: 'parent', isThinking: false },
      c1: { kind: 'agent-text', id: 'c1', createdAt: 2, text: 'child', isThinking: false },
    },
    messageOriginById: {
      p1: { sessionId: 'parent-1', isReadOnlyContext: true },
      c1: { sessionId: 'child-1', isReadOnlyContext: false },
    },
    isLoaded: true,
  };

  useMessageMock.mockImplementation((sessionId: string, messageId: string) => {
    return { kind: 'agent-text', id: messageId, createdAt: 1, text: `${sessionId}:${messageId}`, isThinking: false };
  });

  settingValues.transcriptListImplementation = 'flash_v2';
  settingValues.transcriptGroupingMode = 'linear';
  settingValues.transcriptAnimateNewItemsEnabled = false;
  settingValues.transcriptAnimateToolExpandCollapseEnabled = false;
  settingValues.transcriptAnimateThinkingEnabled = false;
});

vi.mock('@shopify/flash-list', () => ({
  FlashList: React.forwardRef((props: any, ref: any) => {
    capturedFlashListProps = props;
    const handle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
    if (typeof ref === 'function') ref(handle);
    else if (ref && typeof ref === 'object') ref.current = handle;
    const children = Array.isArray(props?.data)
      ? props.data.map((item: any, index: number) => {
          const key = typeof props?.keyExtractor === 'function' ? props.keyExtractor(item, index) : String(index);
          return React.createElement(React.Fragment, { key }, props.renderItem?.({ item, index }));
        })
      : null;
    return React.createElement('FlashList', null, children);
  }),
}));

vi.mock('react-native', async (importOriginal) => {
  const ReactMod = await import('react');
  const actual = await importOriginal<any>();
  return {
    ...actual,
    Platform: {
      ...(actual?.Platform ?? {}),
      OS: 'ios',
      select: (values: any) => values?.ios ?? values?.default,
    },
    View: (props: any) => ReactMod.createElement('View', props, props.children),
    Text: (props: any) => ReactMod.createElement('Text', props, props.children),
    Pressable: ({ children, ...props }: any) => ReactMod.createElement('Pressable', props, children),
    ActivityIndicator: () => ReactMod.createElement('ActivityIndicator'),
    FlatList: () => ReactMod.createElement('FlatList'),
  };
});

vi.mock('@/utils/platform/responsive', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    useHeaderHeight: () => 0,
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useSession: () => sessionState,
  useSessionTranscriptIds: () => ({ ids: ['c1'], isLoaded: true }),
  useSessionMessagesById: () => ({ c1: { kind: 'agent-text', id: 'c1', createdAt: 2, text: 'child', isThinking: false } }),
  useForkedTranscriptSnapshot: () => forkSnapshot,
  useSessionPendingMessages: () => ({ messages: [] }),
  useSessionActionDrafts: () => ([]),
  useSessionLatestThinkingMessageId: () => null,
  useSessionLatestThinkingMessageActivityAtMs: () => null,
  useMessage: useMessageMock,
  useSetting: (key: string) => settingValues[key],
  getStorage: () => ({
    getState: () => ({
      sessionMessages: {
        'parent-1': {
          messagesById: { p1: forkSnapshot.combinedMessagesById.p1 },
          messagesMap: { p1: forkSnapshot.combinedMessagesById.p1 },
        },
        'child-1': {
          messagesById: { c1: forkSnapshot.combinedMessagesById.c1 },
          messagesMap: { c1: forkSnapshot.combinedMessagesById.c1 },
        },
      },
    }),
  }),
}));

vi.mock('@/components/sessions/chatListItems', () => ({
  buildChatListItems: ({ messageIdsOldestFirst, messagesById }: any) =>
    (messageIdsOldestFirst ?? []).map((id: string) => {
      const m = messagesById?.[id];
      return { kind: 'message', id: `msg:${id}`, messageId: id, createdAt: m?.createdAt ?? 0, seq: 1 };
    }),
  buildChatListItemsCached: (opts: any) => ({
    cache: null,
    items: (opts?.messageIdsOldestFirst ?? []).map((id: string) => {
      const m = opts?.messagesById?.[id];
      return { kind: 'message', id: `msg:${id}`, messageId: id, createdAt: m?.createdAt ?? 0, seq: 1 };
    }),
  }),
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

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
  TurnView: () => React.createElement('TurnView'),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionProvider', () => ({
  TranscriptMotionProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/motion/resolveTranscriptMotionConfig', () => ({
  resolveTranscriptMotionConfig: () => ({ preset: 'off', animateThinkingEnabled: false }),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
  TranscriptEnterWrapper: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
  JumpToBottomButton: () => null,
}));

vi.mock('@/components/sessions/transcript/scroll/transcriptScrollPinController', async () => {
  const actual = await vi.importActual<any>('@/components/sessions/transcript/scroll/transcriptScrollPinController');
  return actual;
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
  useReducedMotionPreference: () => false,
}));

vi.mock('@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId', () => ({
  resolveActiveThinkingMessageId: () => null,
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
  getPermissionsInUiWhileLocal: () => ({}),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    loadOlderMessages: vi.fn(),
    loadOlderMessagesForkAware: vi.fn(),
    loadNewerMessages: vi.fn(),
    hasDeferredNewerMessages: () => false,
    getSyncTuning: () => ({
      transcriptForwardPrefetchThresholdPx: 0,
      transcriptFlashListEstimatedItemSize: 120,
      transcriptWebInitialPinStabilizeMs: 3000,
      transcriptWebInitialPinRetryIntervalMs: 250,
    }),
  },
}));

describe('ChatList (forked transcript)', () => {
  it('injects a fork divider row between ancestor context and child messages', async () => {
    const { ChatList } = await import('./ChatList');
    await act(async () => {
      renderer.create(<ChatList session={sessionState} />);
    });

    expect(capturedFlashListProps).toBeTruthy();
    const data = capturedFlashListProps.data ?? [];
    expect(Array.isArray(data)).toBe(true);

    const dividerIndex = data.findIndex((it: any) => it?.kind === 'fork-divider');
    expect(dividerIndex).toBe(1);
    expect(data[dividerIndex]).toEqual(
      expect.objectContaining({
        kind: 'fork-divider',
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        parentCutoffSeqInclusive: 3,
      }),
    );
  });

  it('disables permission approvals when the session is inactive (presence offline)', async () => {
    sessionState.presence = 'offline';

    const { ChatList } = await import('./ChatList');
    await act(async () => {
      renderer.create(<ChatList session={sessionState} />);
    });

    const childMessageView = capturedMessageViewProps.find((props) => props?.sessionId === 'child-1');
    expect(childMessageView).toBeTruthy();
    expect(childMessageView.interaction).toEqual(
      expect.objectContaining({
        canApprovePermissions: false,
        permissionDisabledReason: 'inactive',
      }),
    );
  });

  it('renders ancestor messages by reading them from their origin sessionId and marks them read-only', async () => {
    const { ChatList } = await import('./ChatList');
    await act(async () => {
      renderer.create(<ChatList session={sessionState} />);
    });

    expect(useMessageMock).toHaveBeenCalledWith('parent-1', 'p1');
    expect(useMessageMock).toHaveBeenCalledWith('child-1', 'c1');

    const firstMessageView = capturedMessageViewProps[0];
    expect(firstMessageView).toBeTruthy();
    expect(firstMessageView.sessionId).toBe('parent-1');
    expect(firstMessageView.interaction).toEqual(
      expect.objectContaining({
        canSendMessages: false,
        canApprovePermissions: false,
        permissionDisabledReason: 'readOnly',
        disableToolNavigation: true,
      }),
    );
  });
});
