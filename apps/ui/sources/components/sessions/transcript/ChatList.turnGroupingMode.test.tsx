import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCapturedFlatListProps,
  legacyChatListHarnessState,
  renderLegacyChatList,
  resetLegacyChatListHarness,
} from './ChatList.legacyListTestHarness';
import { installLegacyChatListHarnessCommonModuleMocks } from './chatListLegacyHarnessTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedMessageViewProps: any[] = [];

const buildChatListItemsMock = vi.fn((..._args: any[]): any[] => []);

installLegacyChatListHarnessCommonModuleMocks();

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
    resetLegacyChatListHarness();
    capturedMessageViewProps = [];
    buildChatListItemsMock.mockClear();
  });

  it('renders turn items when transcriptGroupingMode is turns', async () => {
    legacyChatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    legacyChatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    legacyChatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    legacyChatListHarnessState.settingValues.transcriptListImplementation = 'flatlist_legacy';

    const messages = [
      { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
    ];
    legacyChatListHarnessState.sessionMessagesState = { isLoaded: true, messages };
    buildChatListItemsMock.mockImplementation((opts: any) => {
      if (opts?.includeCommittedMessages === false) return [];
      return messages.map((message) => ({
        kind: 'message',
        id: message.id,
        messageId: message.id,
        createdAt: message.createdAt,
        seq: null,
      }));
    });

    const screen = await renderLegacyChatList();

    const capturedFlatListProps = getCapturedFlatListProps();
    expect(capturedFlatListProps).toBeTruthy();
    expect(Array.isArray(capturedFlatListProps.data)).toBe(true);
    expect(capturedFlatListProps.data[0]?.kind).toBe('turn');
    expect(Array.from(new Set(capturedMessageViewProps.map((props) => props?.message?.id)))).toEqual(['u1', 'a1']);

    await screen.unmount();
  });

  it('does not group tool calls into tool-call groups when tool chrome mode is cards', async () => {
    legacyChatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    legacyChatListHarnessState.settingValues.transcriptGroupToolCalls = true;
    legacyChatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    legacyChatListHarnessState.settingValues.toolViewTimelineChromeMode = 'cards';
    legacyChatListHarnessState.settingValues.transcriptListImplementation = 'flatlist_legacy';

    const messages = [
      { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
      { kind: 'tool-call', id: 't1', localId: null, createdAt: 2, tool: { name: 'Bash' } },
      { kind: 'agent-text', id: 'a1', localId: null, createdAt: 3, text: 'a1' },
    ];
    legacyChatListHarnessState.sessionMessagesState = { isLoaded: true, messages };
    buildChatListItemsMock.mockImplementation((opts: any) => {
      if (opts?.includeCommittedMessages === false) return [];
      return messages.map((message) => ({
        kind: 'message',
        id: message.id,
        messageId: message.id,
        createdAt: message.createdAt,
        seq: null,
      }));
    });

    const screen = await renderLegacyChatList();

    const capturedFlatListProps = getCapturedFlatListProps();
    const firstTurn = capturedFlatListProps?.data[0]?.turn;
    expect(firstTurn).toBeTruthy();
    const kinds = (firstTurn.content ?? []).map((content: any) => content.kind);
    expect(kinds).not.toContain('tool_calls');

    await screen.unmount();
  });

  it('overlays main-chain transcript drafts onto the matching committed message instead of rendering a duplicate row', async () => {
    legacyChatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
    legacyChatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    legacyChatListHarnessState.settingValues.transcriptListImplementation = 'flatlist_legacy';

    legacyChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [
        { kind: 'agent-text', id: 'm1', localId: 'local-1', createdAt: 1, text: 'Committed' },
      ],
    };
    legacyChatListHarnessState.sessionTranscriptDraftMessagesState = [
      { kind: 'agent-text', id: 'draft:local-1', localId: 'local-1', createdAt: 2, text: 'Committed plus live draft tail', isThinking: false },
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

    const screen = await renderLegacyChatList();

    expect(capturedMessageViewProps.map((props) => props?.message?.id)).toEqual(['m1']);
    expect(capturedMessageViewProps[0]?.message?.text).toBe('Committed plus live draft tail');

    await screen.unmount();
  });
});
