import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import type { Message, ToolCall, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { renderScreen } from '@/dev/testkit';
import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installWorkflowRendererCommonModuleMocks();

/**
 * The summary rows inside a sub-agent card show TOOL-CALL status, not agent-activity status, so
 * their canonical owner is `ToolStatusIndicator` / `resolveToolStatusIndicatorKind` — the same one
 * every other tool row in the transcript uses — and not the agent-activity status slot.
 *
 * These cases are the ones a hand-rolled three-arm `state === 'running' | 'completed' | 'error'`
 * switch gets wrong, because `ToolCall.state` is not the whole truth: a tool can be `completed`
 * with an error result, and a tool can be `running` while its permission prompt is still open.
 * A second switch reports "done, green" for the first and "working" for the second.
 */

function makeToolCall(overrides: Partial<ToolCall>): ToolCall {
    return {
        name: 'Unknown',
        state: 'completed',
        input: {},
        result: null,
        createdAt: 1,
        startedAt: 1,
        completedAt: 1,
        description: null,
        permission: undefined,
        ...overrides,
    };
}

function makeToolCallMessage(id: string, tool: ToolCall): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: tool.createdAt ?? 1,
        tool,
        children: [],
    };
}

async function statusMarkFor(tool: ToolCall): Promise<Readonly<{ glyphs: string[]; spinners: number }>> {
    const { SubAgentSummarySection } = await import('./SubAgentSummarySection');

    const taskTool = makeToolCall({
        name: 'Task',
        state: 'running',
        input: { description: 'Status mark check' },
        createdAt: 10,
        startedAt: 10,
        completedAt: null,
    });
    const messages: Message[] = [makeToolCallMessage('m1', { ...tool, createdAt: 11 })];

    const screen = await renderScreen(
        <SubAgentSummarySection
            tool={taskTool}
            metadata={null}
            messages={messages}
            detailLevel="summary"
            sessionId="s1"
            messageId="msg-task-1"
        />,
    );

    const glyphs = screen.tree.root
        .findAll((node) => typeof (node.props as { name?: unknown })?.name === 'string' && node.props.size != null)
        .map((node) => (node.props as { name: string }).name);
    const spinners = screen.tree.root.findAll((node) => node.props?.accessibilityRole === 'progressbar').length;

    act(() => screen.tree.unmount());
    return { glyphs, spinners };
}

describe('SubAgentSummarySection status mark', () => {
    it('reads a completed tool that reported an error as an error, not as success', async () => {
        const { glyphs } = await statusMarkFor(makeToolCall({
            name: 'Read',
            state: 'completed',
            input: { file_path: '/a.txt' },
            result: { tool_use_result: 'Error: file not found' },
        }));

        expect(glyphs).toContain('x-circle');
        expect(glyphs).not.toContain('check-circle');
    });

    it('shows an open permission prompt instead of claiming the tool is working', async () => {
        const { glyphs, spinners } = await statusMarkFor(makeToolCall({
            name: 'Bash',
            state: 'running',
            input: { command: 'ls' },
            completedAt: null,
            permission: { id: 'p1', status: 'pending' },
        }));

        expect(glyphs).toContain('lock');
        expect(spinners).toBe(0);
    });

    it('still renders the ordinary outcomes', async () => {
        expect((await statusMarkFor(makeToolCall({ name: 'Read', state: 'completed' }))).glyphs)
            .toContain('check-circle');
        expect((await statusMarkFor(makeToolCall({ name: 'Read', state: 'error' }))).glyphs)
            .toContain('x-circle');
        expect((await statusMarkFor(makeToolCall({ name: 'Read', state: 'running', completedAt: null }))).spinners)
            .toBe(1);
    });
});
