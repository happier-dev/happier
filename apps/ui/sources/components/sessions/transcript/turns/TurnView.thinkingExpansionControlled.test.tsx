import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let renderedMessageViewProps: any[] = [];
let messageById: Record<string, any> = {};

vi.mock('react-native', async (importOriginal) => {
  const ReactMod = await import('react');
  const actual = await importOriginal<any>();
  return {
    ...actual,
    View: (props: any) => ReactMod.createElement('View', props, props.children),
  };
});

vi.mock('@/components/sessions/transcript/MessageView', () => ({
  MessageView: (props: any) => {
    renderedMessageViewProps.push(props);
    return React.createElement('MessageView', props);
  },
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
  TranscriptEnterWrapper: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/transcript/turns/toolCalls/ToolCallsGroupView', () => ({
  ToolCallsGroupView: () => React.createElement('ToolCallsGroupView'),
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useMessage: (_sessionId: string, messageId: string) => messageById[messageId] ?? null,
  useMessagesByIds: (_sessionId: string, messageIds: readonly string[]) =>
    messageIds.map((id) => messageById[id]).filter(Boolean),
}));

describe('TurnView (thinking expansion controlled)', () => {
  beforeEach(() => {
    renderedMessageViewProps = [];
    messageById = {};
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
    await act(async () => {
      renderer.create(
        React.createElement(TurnView as any, {
          turn,
          metadata: null,
          sessionId: 's1',
          activeThinkingMessageId: null,
          expandedToolCallsGroupIds: new Set(),
          setToolCallsGroupExpanded: () => {},
          interaction: { canSendMessages: true, canApprovePermissions: true },
          resolveThinkingExpanded,
          setThinkingExpanded,
        }),
      );
    });

    const thinkingProps = renderedMessageViewProps.find((p) => p?.message?.id === 't1');
    const normalProps = renderedMessageViewProps.find((p) => p?.message?.id === 'a1');

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
});
