import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from '../transcriptTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let messageById: Record<string, any> = {};
let renderedToolCallsGroupViewProps: any[] = [];

installTranscriptCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useMessagesByIds: (_sessionId: string, messageIds: readonly string[]) =>
                messageIds.map((id) => messageById[id]).filter(Boolean),
        });
    },
});

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
  TranscriptEnterWrapper: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/transcript/turns/toolCalls/ToolCallsGroupView', () => ({
  ToolCallsGroupView: (props: any) => {
    renderedToolCallsGroupViewProps.push(props);
    return React.createElement('ToolCallsGroupView', props);
  },
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

    await renderScreen(React.createElement(ToolCallsGroupRow as any, {
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
        }));

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

  it('keeps pending-permission tool calls visible when the session is inactive (coerced to failed)', async () => {
    const toolMessageOne = {
      kind: 'tool-call',
      id: 'tool-1',
      localId: null,
      createdAt: 1,
      tool: {
        id: 'mcp-1',
        name: 'mcp__playwright__browser_navigate',
        state: 'running',
        input: { url: 'https://example.com' },
        permission: { id: 'perm-1', status: 'pending' },
      },
      children: [],
    };

    const { ToolCallsGroupRow } = await import('./ToolCallsGroupRow');

    await renderScreen(React.createElement(ToolCallsGroupRow as any, {
          sessionId: 's1',
          toolCallsGroupId: 'group-1',
          toolMessageIds: ['tool-1'],
          metadata: null,
          expanded: false,
          onSetExpanded: () => {},
          interaction: { canSendMessages: true, canApprovePermissions: false, permissionDisabledReason: 'inactive' },
          getMessageById: (messageId: string) => {
            if (messageId === 'tool-1') return toolMessageOne;
            return null;
          },
        }));

    expect(renderedToolCallsGroupViewProps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolMessages: [
            expect.objectContaining({
              id: 'tool-1',
              tool: expect.objectContaining({
                state: 'error',
                permission: expect.objectContaining({ status: 'canceled' }),
              }),
            }),
          ],
        }),
      ]),
    );
  });

  it('keeps completed tool calls visible when the session is inactive (and coerces pending-permission tools to failed)', async () => {
    const completedToolMessage = {
      kind: 'tool-call',
      id: 'tool-1',
      localId: null,
      createdAt: 1,
      tool: {
        id: 'bash-1',
        name: 'Bash',
        state: 'completed',
        input: { command: 'pwd' },
        permission: { id: 'perm-1', status: 'approved' },
      },
      children: [],
    };
    const pendingToolMessage = {
      kind: 'tool-call',
      id: 'tool-2',
      localId: null,
      createdAt: 2,
      tool: {
        id: 'mcp-1',
        name: 'mcp__playwright__browser_navigate',
        state: 'running',
        input: { url: 'https://example.com' },
        permission: { id: 'perm-2', status: 'pending' },
      },
      children: [],
    };

    const { ToolCallsGroupRow } = await import('./ToolCallsGroupRow');

    await renderScreen(React.createElement(ToolCallsGroupRow as any, {
          sessionId: 's1',
          toolCallsGroupId: 'group-1',
          toolMessageIds: ['tool-1', 'tool-2'],
          metadata: null,
          expanded: false,
          onSetExpanded: () => {},
          interaction: { canSendMessages: true, canApprovePermissions: false, permissionDisabledReason: 'inactive' },
          getMessageById: (messageId: string) => {
            if (messageId === 'tool-1') return completedToolMessage;
            if (messageId === 'tool-2') return pendingToolMessage;
            return null;
          },
        }));

    expect(renderedToolCallsGroupViewProps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolMessages: [
            expect.objectContaining({ id: 'tool-1' }),
            expect.objectContaining({
              id: 'tool-2',
              tool: expect.objectContaining({
                state: 'error',
                permission: expect.objectContaining({ status: 'canceled' }),
              }),
            }),
          ],
          status: 'completed',
        }),
      ]),
    );
  });
});

afterEach(() => {
    resetTranscriptCommonModuleMockState();
});
