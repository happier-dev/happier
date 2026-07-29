import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chatListHarnessState,
  renderChatListHarnessSession,
  requireCapturedLegendListProps,
  resetChatListHarness,
} from '@/dev/testkit/harness/chatListHarness';
import { installChatListHarnessCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedMessageViewProps: any[] = [];

const buildChatListItemsMock = vi.fn((..._args: any[]): any[] => []);

installChatListHarnessCommonModuleMocks();

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
  MessageViewWithSessionCommon: (props: any) => {
    capturedMessageViewProps.push(props);
    return React.createElement('MessageView');
  },
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
  ToolView: (props: any) => React.createElement('ToolView', props),
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
  ToolTimelineRow: (props: any) => React.createElement('ToolTimelineRow', props),
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

describe('ChatList (turn grouping mode)', () => {
  beforeEach(() => {
    resetChatListHarness({
      syncTuningState: {
        transcriptForwardPrefetchThresholdPx: 800,
        transcriptEstimatedItemSizePx: 48,
        transcriptMaxTurnEntriesPerListItem: 3,
      },
    });
    capturedMessageViewProps = [];
    buildChatListItemsMock.mockClear();
  });

  it.each(['linear', 'turns'] as const)(
    'threads prior-era event emphasis through %s row projection without muting current-era events',
    async (groupingMode) => {
      chatListHarnessState.settingValues.transcriptGroupingMode = groupingMode;
      chatListHarnessState.settingValues.transcriptGroupToolCalls = false;
      chatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
      chatListHarnessState.sessionState = {
        ...chatListHarnessState.sessionState,
        active: true,
      };

      const messages = [
        {
          kind: 'agent-event',
          id: 'old-failure',
          createdAt: 1,
          event: { type: 'message', message: 'Old failure' },
        },
        {
          kind: 'agent-event',
          id: 'ready',
          createdAt: 2,
          event: { type: 'ready' },
        },
        {
          kind: 'agent-event',
          id: 'current-failure',
          createdAt: 3,
          event: { type: 'message', message: 'Current failure' },
        },
      ];
      chatListHarnessState.sessionMessagesState = { isLoaded: true, messages };
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

      const screen = await renderChatListHarnessSession();
      const byId = new Map(capturedMessageViewProps.map((props) => [props.message?.id, props]));

      expect(byId.get('old-failure')?.eventEmphasis).toBe('deemphasized');
      expect(byId.get('ready')?.eventEmphasis).toBeUndefined();
      expect(byId.get('current-failure')?.eventEmphasis).toBeUndefined();

      await screen.unmount();
    },
  );

  it('renders turn items when transcriptGroupingMode is turns', async () => {
    chatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    chatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    chatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';

    const messages = [
      { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
      { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
    ];
    chatListHarnessState.sessionMessagesState = { isLoaded: true, messages };
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

    const screen = await renderChatListHarnessSession();

    const capturedListProps = requireCapturedLegendListProps();
    expect(capturedListProps).toBeTruthy();
    expect(Array.isArray(capturedListProps.data)).toBe(true);
    // Turn mode projects turn-derived per-message unit rows (msg:-prefixed ids), not the
    // linear buildChatListItems output (unprefixed ids from the mock above).
    expect(capturedListProps.data.map((item: any) => item.id).sort()).toEqual(['msg:a1', 'msg:u1']);
    expect(capturedListProps.data.every((item: any) => item.kind === 'message')).toBe(true);
    expect(Array.from(new Set(capturedMessageViewProps.map((props) => props?.message?.id))).sort()).toEqual(['a1', 'u1']);

    await screen.unmount();
  });

  it('keeps oversized turns grouped as one transcript row', async () => {
    chatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    chatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    chatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';

    const messages = [
      { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'u1' },
      { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'a1' },
      { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, seq: 3, text: 'a2' },
      { kind: 'agent-text', id: 'a3', localId: null, createdAt: 4, seq: 4, text: 'a3' },
      { kind: 'agent-text', id: 'a4', localId: null, createdAt: 5, seq: 5, text: 'a4' },
    ];
    chatListHarnessState.sessionMessagesState = { isLoaded: true, messages };
    buildChatListItemsMock.mockImplementation((opts: any) => {
      if (opts?.includeCommittedMessages === false) return [];
      return messages.map((message) => ({
        kind: 'message',
        id: `msg:${message.id}`,
        messageId: message.id,
        createdAt: message.createdAt,
        seq: message.seq,
      }));
    });

    const screen = await renderChatListHarnessSession();

    const capturedListProps = requireCapturedLegendListProps();
    expect(capturedListProps).toBeTruthy();
    // Unit projection (plan N2c): the oversized turn decomposes into one stable unit row per
    // entry — every entry stays present exactly once; nothing is dropped by
    // transcriptMaxTurnEntriesPerListItem.
    expect(capturedListProps.data.map((item: any) => item.id).sort()).toEqual(
      ['msg:a1', 'msg:a2', 'msg:a3', 'msg:a4', 'msg:u1'],
    );
    expect(Array.from(new Set(capturedMessageViewProps.map((props) => props?.message?.id))).sort()).toEqual(
      ['a1', 'a2', 'a3', 'a4', 'u1'],
    );

    await screen.unmount();
  });

  it('does not group tool calls into tool-call groups when tool chrome mode is cards', async () => {
    chatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
    chatListHarnessState.settingValues.transcriptGroupToolCalls = true;
    chatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    chatListHarnessState.settingValues.toolViewTimelineChromeMode = 'cards';

    const messages = [
      { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
      { kind: 'tool-call', id: 't1', localId: null, createdAt: 2, tool: { name: 'Bash' } },
      { kind: 'agent-text', id: 'a1', localId: null, createdAt: 3, text: 'a1' },
    ];
    chatListHarnessState.sessionMessagesState = { isLoaded: true, messages };
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

    const screen = await renderChatListHarnessSession();

    const capturedListProps = requireCapturedLegendListProps();
    const kinds = capturedListProps.data.map((item: any) => item.kind);
    // Cards chrome mode disables tool-call grouping: no tool-group unit rows appear and the
    // tool call renders as its own message unit row.
    expect(kinds.every((kind: string) => !String(kind).startsWith('tool-group'))).toBe(true);
    expect(capturedListProps.data.map((item: any) => item.id)).toContain('msg:t1');

    await screen.unmount();
  });
});
