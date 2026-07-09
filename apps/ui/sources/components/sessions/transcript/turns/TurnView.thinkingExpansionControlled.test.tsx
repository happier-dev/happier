import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from '../transcriptTestHelpers';
import type {
    TranscriptForkCommon,
    TranscriptMessageDisplayCommon,
    TranscriptToolChromeCommon,
    TranscriptToolRouteCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let renderedMessageViewProps: any[] = [];
let renderedMessageViewWithCommonProps: any[] = [];
let messageById: Record<string, any> = {};
let renderedToolCallsGroupRowProps: any[] = [];
let renderedToolCallsGroupRowWithCommonProps: any[] = [];
let renderedRollbackButtonProps: any[] = [];
const flashListCompatMockState = vi.hoisted(() => ({
  mappingKeyCalls: [] as Array<Readonly<{ index: number; itemKey: string | number | bigint }>>,
}));

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useMessage: (_sessionId: string, messageId: string) => messageById[messageId] ?? null,
            useMessagesByIds: (_sessionId: string, messageIds: readonly string[]) =>
                messageIds.map((id) => messageById[id]).filter(Boolean),
            useSessionForkSupportSource: () => null,
            useSessionMessagesById: () => ({}),
            useSessionMessagesReducerState: () => null,
            useSessionWorkspacePath: () => null,
            useSetting: () => null,
        });
    },
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => false,
}));

vi.mock('@/components/sessions/transcript/MessageView', () => ({
  MessageView: (props: any) => {
    renderedMessageViewProps.push(props);
    return React.createElement('MessageView', props);
  },
  MessageViewWithSessionCommon: (props: any) => {
    renderedMessageViewWithCommonProps.push(props);
    return React.createElement('MessageViewWithSessionCommon', props);
  },
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
  TranscriptEnterWrapper: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/transcript/turns/toolCalls/ToolCallsGroupView', () => ({
  ToolCallsGroupView: () => React.createElement('ToolCallsGroupView'),
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
  ToolCallsGroupRow: (props: any) => {
    renderedToolCallsGroupRowProps.push(props);
    return React.createElement('ToolCallsGroupRow', props);
  },
  ToolCallsGroupRowWithSessionCommon: (props: any) => {
    renderedToolCallsGroupRowWithCommonProps.push(props);
    return React.createElement('ToolCallsGroupRowWithSessionCommon', props);
  },
}));

vi.mock('@/components/sessions/transcript/TranscriptRollbackActionButton', () => ({
  TranscriptRollbackActionButton: (props: any) => {
    renderedRollbackButtonProps.push(props);
    return React.createElement('TranscriptRollbackActionButton', props);
  },
}));

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
  useMappingHelper: () => ({
    getMappingKey: (itemKey: string | number | bigint, index: number) => {
      flashListCompatMockState.mappingKeyCalls.push({ itemKey, index });
      return index;
    },
  }),
}));

function getRenderedMessageViewProps() {
  return [...renderedMessageViewProps, ...renderedMessageViewWithCommonProps];
}

function getRenderedToolCallsGroupRowProps() {
  return [...renderedToolCallsGroupRowProps, ...renderedToolCallsGroupRowWithCommonProps];
}

describe('TurnView (thinking expansion controlled)', () => {
  afterEach(() => {
    resetTranscriptCommonModuleMockState();
  });

  beforeEach(() => {
    renderedMessageViewProps = [];
    renderedMessageViewWithCommonProps = [];
    messageById = {};
    renderedToolCallsGroupRowProps = [];
    renderedToolCallsGroupRowWithCommonProps = [];
    renderedRollbackButtonProps = [];
    flashListCompatMockState.mappingKeyCalls = [];
  });

  it('forwards parent-provided transcript session common to nested message and tool rows', async () => {
    const messageDisplayCommon = {
      sessionThinkingDisplayMode: 'inline',
      sessionThinkingInlineChrome: 'plain',
      sessionThinkingInlinePresentation: 'summary',
      transcriptMessageTimestampDisplayMode: 'always',
      transcriptStreamingMarkdownRenderingEnabled: false,
      transcriptStreamingPartialOutputEnabled: true,
      transcriptStreamingSettleDelayMs: 0,
      transcriptStreamingSmoothingEnabled: false,
      transcriptMessageSelectionEnabled: true,
      transcriptMessageSendToSessionEnabled: false,
      workspacePath: null,
    } satisfies TranscriptMessageDisplayCommon;
    const forkCommon = {
      executionRunsEnabled: false,
      sessionForkSupportSource: null,
      sessionReplayEnabled: false,
      sessionReplayMaxSeedChars: 120_000,
      sessionReplayStrategy: 'recent_messages',
      sessionReplaySummaryRunnerV1: null,
    } satisfies TranscriptForkCommon;
    const toolChromeCommon = {
      toolViewTimelineChromeMode: 'cards',
      transcriptToolCallsCollapsedPreviewCount: 1,
      transcriptToolCallsGroupShowBackground: false,
    } satisfies TranscriptToolChromeCommon;
    const toolRouteCommon = {
      messagesById: {},
      reducerState: null,
    } satisfies TranscriptToolRouteCommon;
    messageById = {
      'agent-1': { kind: 'agent-text', id: 'agent-1', localId: null, createdAt: 1, text: 'reply', isThinking: false },
      'tool-1': { kind: 'tool-call', id: 'tool-1', localId: null, createdAt: 2, tool: { name: 'Bash', state: 'completed' }, children: [] },
    };
    const turn: any = {
      id: 'turn-1',
      userMessageId: null,
      content: [
        { kind: 'message', messageId: 'agent-1' },
        { kind: 'tool_calls', id: 'tool-group-1', toolMessageIds: ['tool-1'] },
      ],
    };

    const { TurnViewWithSessionCommon } = await import('./TurnView');
    await renderScreen(React.createElement(TurnViewWithSessionCommon as any, {
      turn,
      metadata: null,
      sessionId: 's1',
      activeThinkingMessageId: null,
      expandedToolCallsAnchorMessageIds: new Set(),
      setToolCallsGroupExpanded: () => {},
      interaction: { canSendMessages: true, canApprovePermissions: true },
      forkCommon,
      messageDisplayCommon,
      toolChromeCommon,
      toolRouteCommon,
    }));

    expect(renderedMessageViewProps).toHaveLength(0);
    expect(renderedMessageViewWithCommonProps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({ id: 'agent-1' }),
          forkCommon,
          messageDisplayCommon,
          toolChromeCommon,
          toolRouteCommon,
        }),
      ]),
    );
    expect(renderedToolCallsGroupRowProps).toHaveLength(0);
    expect(renderedToolCallsGroupRowWithCommonProps).toEqual([
      expect.objectContaining({
        toolMessageIds: ['tool-1'],
        forkCommon,
        messageDisplayCommon,
        toolChromeCommon,
        toolRouteCommon,
      }),
    ]);
  });

  it('routes mapped turn content keys through the FlashList mapping helper', async () => {
    messageById = {
      'agent-1': { kind: 'agent-text', id: 'agent-1', localId: null, createdAt: 1, text: 'reply', isThinking: false },
      'agent-2': { kind: 'agent-text', id: 'agent-2', localId: null, createdAt: 3, text: 'done', isThinking: false },
    };

    const turn: any = {
      id: 'turn-1',
      userMessageId: null,
      content: [
        { kind: 'message', messageId: 'agent-1' },
        { kind: 'tool_calls', id: 'tool-group-1', toolMessageIds: ['tool-1'] },
        { kind: 'message', messageId: 'agent-2' },
      ],
    };

    const { TurnView } = await import('./TurnView');
    await renderScreen(React.createElement(TurnView as any, {
          turn,
          metadata: null,
          sessionId: 's1',
          activeThinkingMessageId: null,
          expandedToolCallsAnchorMessageIds: new Set(),
          setToolCallsGroupExpanded: () => {},
          interaction: { canSendMessages: true, canApprovePermissions: true },
        }));

    expect(flashListCompatMockState.mappingKeyCalls).toEqual([
      { itemKey: 'agent-1', index: 0 },
      { itemKey: 'tool-group-1', index: 1 },
      { itemKey: 'agent-2', index: 2 },
    ]);
  });

  it('forwards the active thinking id only to the matching nested message row', async () => {
    messageById = {
      'user-1': { kind: 'user-text', id: 'user-1', localId: null, createdAt: 1, text: 'prompt' },
      'thinking-1': { kind: 'agent-text', id: 'thinking-1', localId: null, createdAt: 2, text: 'thinking', isThinking: true },
      'agent-1': { kind: 'agent-text', id: 'agent-1', localId: null, createdAt: 3, text: 'reply', isThinking: false },
    };
    const turn: any = {
      id: 'turn-1',
      userMessageId: 'user-1',
      content: [
        { kind: 'message', messageId: 'thinking-1' },
        { kind: 'message', messageId: 'agent-1' },
      ],
    };

    const { TurnView } = await import('./TurnView');
    await renderScreen(React.createElement(TurnView as any, {
          turn,
          metadata: null,
          sessionId: 's1',
          activeThinkingMessageId: 'thinking-1',
          expandedToolCallsAnchorMessageIds: new Set(),
          setToolCallsGroupExpanded: () => {},
          interaction: { canSendMessages: true, canApprovePermissions: true },
        }));

    const renderedMessageProps = getRenderedMessageViewProps();
    expect(renderedMessageProps.find((p) => p?.message?.id === 'thinking-1')?.activeThinkingMessageId).toBe('thinking-1');
    expect(renderedMessageProps.find((p) => p?.message?.id === 'user-1')?.activeThinkingMessageId).toBeNull();
    expect(renderedMessageProps.find((p) => p?.message?.id === 'agent-1')?.activeThinkingMessageId).toBeNull();
  });

  it('forwards list-owned thinking expansion state to MessageView for thinking messages', async () => {
    const thinkingMessage = { kind: 'agent-text', id: 't1', localId: null, createdAt: 1, text: 'think', isThinking: true };
    const normalMessage = { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'answer', isThinking: false };
    messageById = { t1: thinkingMessage, a1: normalMessage };
    const turn: any = {
      id: 'turn-1',
      userMessageId: null,
      content: [
        { kind: 'message', messageId: 't1' },
        { kind: 'message', messageId: 'a1' },
      ],
    };

    const resolveThinkingExpanded = vi.fn((messageId: string) => messageId === 't1');
    const setThinkingExpanded = vi.fn();

    const { TurnView } = await import('./TurnView');
    await renderScreen(React.createElement(TurnView as any, {
          turn,
          metadata: null,
          sessionId: 's1',
          activeThinkingMessageId: null,
          expandedToolCallsAnchorMessageIds: new Set(),
          setToolCallsGroupExpanded: () => {},
          interaction: { canSendMessages: true, canApprovePermissions: true },
          resolveThinkingExpanded,
          setThinkingExpanded,
        }));

    const renderedMessageProps = getRenderedMessageViewProps();
    const thinkingProps = renderedMessageProps.find((p) => p?.message?.id === 't1');
    const normalProps = renderedMessageProps.find((p) => p?.message?.id === 'a1');

    expect(resolveThinkingExpanded).toHaveBeenCalledWith('t1');
    expect(thinkingProps?.thinkingExpanded).toBe(true);
    expect(typeof thinkingProps?.onThinkingExpandedChange).toBe('function');
    expect(normalProps?.thinkingExpanded).toBeUndefined();
    expect(normalProps?.onThinkingExpandedChange).toBeUndefined();

    await act(async () => {
      thinkingProps.onThinkingExpandedChange(false);
    });
    expect(setThinkingExpanded).toHaveBeenCalledWith('t1', false);
  });

  it('treats a tool calls group as expanded when the expanded set contains any tool message id in the group', async () => {
    const tool1 = { kind: 'tool-call', id: 'tool-1', localId: null, createdAt: 1, tool: { name: 'Bash', state: 'completed' }, children: [] };
    const tool2 = { kind: 'tool-call', id: 'tool-2', localId: null, createdAt: 2, tool: { name: 'Bash', state: 'completed' }, children: [] };
    messageById = { 'tool-1': tool1, 'tool-2': tool2 };

    const turn: any = {
      id: 'turn-1',
      userMessageId: null,
      content: [
        { kind: 'tool_calls', id: 'tool-group-1', toolMessageIds: ['tool-1', 'tool-2'] },
      ],
    };

    const { TurnView } = await import('./TurnView');
    await renderScreen(React.createElement(TurnView as any, {
          turn,
          metadata: null,
          sessionId: 's1',
          activeThinkingMessageId: null,
          // Future behavior: expansion is anchored by tool message ids (stable across pagination/id churn),
          // not by the group id itself.
          expandedToolCallsAnchorMessageIds: new Set(['tool-2']),
          setToolCallsGroupExpanded: () => {},
          interaction: { canSendMessages: true, canApprovePermissions: true },
        }));

    const renderedToolGroupProps = getRenderedToolCallsGroupRowProps();
    expect(renderedToolGroupProps).toHaveLength(1);
    expect(renderedToolGroupProps[0]?.expanded).toBe(true);
  });

  it('forwards forced transcript permission prompts to nested message and tool-call rows', async () => {
    messageById = {
      'agent-1': { kind: 'agent-text', id: 'agent-1', localId: null, createdAt: 1, text: 'reply', isThinking: false },
      'tool-1': { kind: 'tool-call', id: 'tool-1', localId: null, createdAt: 2, tool: { name: 'Bash', state: 'running' }, children: [] },
    };

    const turn: any = {
      id: 'turn-1',
      userMessageId: null,
      content: [
        { kind: 'message', messageId: 'agent-1' },
        { kind: 'tool_calls', id: 'tool-group-1', toolMessageIds: ['tool-1'] },
      ],
    };

    const { TurnView } = await import('./TurnView');
    await renderScreen(React.createElement(TurnView as any, {
          turn,
          metadata: null,
          sessionId: 's1',
          activeThinkingMessageId: null,
          expandedToolCallsAnchorMessageIds: new Set(),
          setToolCallsGroupExpanded: () => {},
          interaction: { canSendMessages: true, canApprovePermissions: true },
          forcePermissionPromptsInTranscript: true,
        }));

    expect(getRenderedMessageViewProps()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({ id: 'agent-1' }),
          forcePermissionPromptsInTranscript: true,
        }),
      ]),
    );
    expect(getRenderedToolCallsGroupRowProps()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolMessageIds: ['tool-1'],
          forcePermissionPromptsInTranscript: true,
        }),
      ]),
    );
  });

  it('renders turn messages from the provided lookup when they are not yet in the global store', async () => {
    messageById = {};

    const agentMessage = { kind: 'agent-text', id: 'agent-sidechain-1', localId: null, createdAt: 1, text: 'sidechain reply', isThinking: false };
    const turn: any = {
      id: 'turn-1',
      userMessageId: null,
      content: [
        { kind: 'message', messageId: 'agent-sidechain-1' },
      ],
    };

    const { TurnView } = await import('./TurnView');
    await renderScreen(React.createElement(TurnView as any, {
          turn,
          metadata: null,
          sessionId: 's1',
          activeThinkingMessageId: null,
          expandedToolCallsAnchorMessageIds: new Set(),
          setToolCallsGroupExpanded: () => {},
          interaction: { canSendMessages: true, canApprovePermissions: true },
          getMessageById: (messageId: string) => (messageId === 'agent-sidechain-1' ? agentMessage : null),
        }));

    expect(getRenderedMessageViewProps()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({ id: 'agent-sidechain-1', text: 'sidechain reply' }),
        }),
      ]),
    );
  });

  it('renders ancestor-origin turn messages with read-only interaction and origin session id', async () => {
    messageById = {};

    const ancestorMessage = { kind: 'agent-text', id: 'ancestor-agent-1', localId: null, createdAt: 1, text: 'ancestor reply', isThinking: false };
    const turn: any = {
      id: 'turn-1',
      userMessageId: null,
      content: [
        { kind: 'message', messageId: 'ancestor-agent-1' },
      ],
    };

    const { TurnView } = await import('./TurnView');
    await renderScreen(React.createElement(TurnView as any, {
          turn,
          metadata: null,
          sessionId: 'child-session',
          activeThinkingMessageId: null,
          expandedToolCallsAnchorMessageIds: new Set(),
          setToolCallsGroupExpanded: () => {},
          interaction: { canSendMessages: true, canApprovePermissions: true },
          getMessageById: (messageId: string) => (messageId === 'ancestor-agent-1' ? ancestorMessage : null),
          getMessageOrigin: (messageId: string) =>
            messageId === 'ancestor-agent-1'
              ? { sessionId: 'parent-session', isReadOnlyContext: true }
              : null,
        }));

    expect(getRenderedMessageViewProps()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({ id: 'ancestor-agent-1', text: 'ancestor reply' }),
          sessionId: 'parent-session',
          interaction: expect.objectContaining({
            canSendMessages: false,
            canApprovePermissions: false,
            permissionDisabledReason: 'readOnly',
            disableToolNavigation: true,
          }),
        }),
      ]),
    );
  });

  it('passes rollback actions through to the user message row instead of rendering a turn-level button', async () => {
    messageById = {
      'user-1': { kind: 'user-text', id: 'user-1', localId: null, createdAt: 1, text: 'prompt', seq: 1 },
      'agent-1': { kind: 'agent-text', id: 'agent-1', localId: null, createdAt: 2, text: 'reply', seq: 2, isThinking: false },
    };

    const turn: any = {
      id: 'turn-1',
      userMessageId: 'user-1',
      content: [
        { kind: 'message', messageId: 'agent-1' },
      ],
    };

    const { TurnView } = await import('./TurnView');
    await renderScreen(React.createElement(TurnView as any, {
          turn,
          metadata: null,
          sessionId: 's1',
          activeThinkingMessageId: null,
          expandedToolCallsAnchorMessageIds: new Set(),
          setToolCallsGroupExpanded: () => {},
          interaction: { canSendMessages: true, canApprovePermissions: true },
          resolveRollbackAction: (messageId: string) =>
            messageId === 'user-1'
              ? { target: { type: 'before_user_message', userMessageSeq: 1 }, restoredDraftText: 'prompt' }
              : null,
        }));

    expect(renderedRollbackButtonProps).toHaveLength(0);
    expect(getRenderedMessageViewProps()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({ id: 'user-1' }),
          rollbackAction: { target: { type: 'before_user_message', userMessageSeq: 1 }, restoredDraftText: 'prompt' },
        }),
      ]),
    );
  });
});
