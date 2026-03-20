import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let messageById: Record<string, any> = {};
let renderedToolCallsGroupViewProps: any[] = [];

vi.mock('react-native', async (importOriginal) => {
  const ReactMod = await import('react');
  const actual = await importOriginal<any>();
  return {
    ...actual,
    View: (props: any) => ReactMod.createElement('View', props, props.children),
  };
});

vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (value: any) => value },
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
  TranscriptEnterWrapper: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/transcript/turns/toolCalls/ToolCallsGroupView', () => ({
  ToolCallsGroupView: (props: any) => {
    renderedToolCallsGroupViewProps.push(props);
    return React.createElement('ToolCallsGroupView', props);
  },
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useMessagesByIds: (_sessionId: string, messageIds: readonly string[]) =>
    messageIds.map((id) => messageById[id]).filter(Boolean),
}));

describe('ToolCallsGroupRow', () => {
  beforeEach(() => {
    messageById = {};
    renderedToolCallsGroupViewProps = [];
  });

  it('uses the provided local lookup for tool rows that are not yet present in the global store', async () => {
    const toolMessageOne = {
      kind: 'tool-call',
      id: 'tool-1',
      localId: null,
      createdAt: 1,
      tool: { id: 'bash-1', name: 'Bash', state: 'completed', input: { command: 'pwd' } },
      children: [],
    };
    const toolMessageTwo = {
      kind: 'tool-call',
      id: 'tool-2',
      localId: null,
      createdAt: 2,
      tool: { id: 'bash-2', name: 'Bash', state: 'running', input: { command: 'ls' } },
      children: [],
    };

    const { ToolCallsGroupRow } = await import('./ToolCallsGroupRow');

    await act(async () => {
      renderer.create(
        React.createElement(ToolCallsGroupRow as any, {
          sessionId: 's1',
          toolCallsGroupId: 'group-1',
          toolMessageIds: ['tool-1', 'tool-2'],
          metadata: null,
          expanded: false,
          onSetExpanded: () => {},
          interaction: { canSendMessages: true, canApprovePermissions: true },
          getMessageById: (messageId: string) => {
            if (messageId === 'tool-1') return toolMessageOne;
            if (messageId === 'tool-2') return toolMessageTwo;
            return null;
          },
        }),
      );
    });

    expect(renderedToolCallsGroupViewProps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolMessages: [
            expect.objectContaining({ id: 'tool-1' }),
            expect.objectContaining({ id: 'tool-2' }),
          ],
          status: 'running',
        }),
      ]),
    );
  });
});
