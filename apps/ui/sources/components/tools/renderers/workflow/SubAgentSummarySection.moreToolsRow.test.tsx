import { renderWithSessionTranscriptSource, createTestSessionTranscriptSource } from '@/dev/testkit';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Message, ToolCall, ToolCallMessage } from "@happier-dev/session-core/messages";


const pushSpy = vi.fn();
function makeToolCall(overrides: Partial<ToolCall>): ToolCall {
    const now = 1;
    return {
        name: 'Unknown',
        state: 'completed',
        input: {},
        result: null,
        createdAt: now,
        startedAt: now,
        completedAt: now,
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

const { SubAgentSummarySection } = await import('./SubAgentSummarySection');

describe('SubAgentSummarySection (+N more tools row)', () => {
    it('does not crash when detailLevel changes from title to summary', async () => {
        const taskTool = makeToolCall({
            name: 'Task',
            state: 'running',
            input: { description: 'Hook stability check' },
            createdAt: 10,
            startedAt: 10,
            completedAt: null,
        });

        const toolMessages: Message[] = [];

        const screen = await renderWithSessionTranscriptSource(<SubAgentSummarySection
                    tool={taskTool}
                    metadata={null}
                    messages={toolMessages}
                    detailLevel="title"
                    sessionId="s1"
                    messageId="msg-task-1"
                />, createTestSessionTranscriptSource({ navigate: pushSpy }));

        await expect(screen.update(
                    <SubAgentSummarySection
                        tool={taskTool}
                        metadata={null}
                        messages={toolMessages}
                        detailLevel="summary"
                        sessionId="s1"
                        messageId="msg-task-1"
                    />,
        )).resolves.toBeUndefined();
    });

    it('does not crash when content appears after an initially empty render', async () => {
        const emptyTool = makeToolCall({
            name: 'Task',
            state: 'running',
            input: {},
            createdAt: 10,
            startedAt: 10,
            completedAt: null,
        });
        const toolWithContent: ToolCall = { ...emptyTool, input: { description: 'Now has content' } };

        const toolMessages: Message[] = [];

        const screen = await renderWithSessionTranscriptSource(<SubAgentSummarySection
                    tool={emptyTool}
                    metadata={null}
                    messages={toolMessages}
                    detailLevel="summary"
                    sessionId="s1"
                    messageId="msg-task-1"
                />, createTestSessionTranscriptSource({ navigate: pushSpy }));

        await expect(screen.update(
                    <SubAgentSummarySection
                        tool={toolWithContent}
                        metadata={null}
                        messages={toolMessages}
                        detailLevel="summary"
                        sessionId="s1"
                        messageId="msg-task-1"
                    />,
        )).resolves.toBeUndefined();
    });

    it.each(['Task', 'SubAgentRun'])('opens the %s destination from the +N tools row without a pane host', async name => {
        pushSpy.mockClear();

        const taskTool = makeToolCall({
            name,
            state: 'running',
            input: { description: 'Tool stress ideas', ...(name === 'SubAgentRun' ? { runId: 'run_7425823b-704c-445f-aa46-a2ceb57bcfa1' } : {}) },
            createdAt: 10,
            startedAt: 10,
            completedAt: null,
        });

        const toolMessages: Message[] = [
            makeToolCallMessage('m1', makeToolCall({ name: 'Read', input: { file_path: '/a.txt' }, createdAt: 11 })),
            makeToolCallMessage('m2', makeToolCall({ name: 'Glob', input: { pattern: '{package.json}' }, createdAt: 12 })),
            makeToolCallMessage('m3', makeToolCall({ name: 'Grep', input: { pattern: '\\\\bTODO\\\\b' }, createdAt: 13 })),
            makeToolCallMessage('m4', makeToolCall({ name: 'WebFetch', input: { url: 'https://example.com' }, createdAt: 14 })),
            makeToolCallMessage('m5', makeToolCall({ name: 'LS', input: { path: '.' }, createdAt: 15 })),
        ];

        const screen = await renderWithSessionTranscriptSource(<SubAgentSummarySection
            tool={taskTool}
            metadata={null}
            messages={toolMessages}
            detailLevel="summary"
            sessionId="s1"
            messageId="msg-task-1"
        />, createTestSessionTranscriptSource({ navigate: pushSpy }));

        const moreRow = screen.findByTestId('task-like-summary-more-tools');
        expect(typeof moreRow?.props?.onPress).toBe('function');

        const order = screen
            .findAll((node) =>
                node.props?.testID === 'task-like-summary-more-tools' ||
                node.props?.testID === 'task-like-summary-tool-item',
            )
            .map((node) => node.props?.testID);
        expect(order[0]).toBe('task-like-summary-more-tools');

        await screen.pressByTestIdAsync('task-like-summary-more-tools');
        expect(pushSpy).toHaveBeenCalledWith(name === 'SubAgentRun'
            ? '/session/s1/runs/run_7425823b-704c-445f-aa46-a2ceb57bcfa1'
            : '/session/s1/message/msg-task-1');
    });
});
