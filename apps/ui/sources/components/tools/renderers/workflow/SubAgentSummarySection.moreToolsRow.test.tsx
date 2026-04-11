import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { Message, ToolCall, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { renderScreen } from '@/dev/testkit';
import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pushSpy = vi.fn();
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));

vi.mock('@/utils/platform/navigateWithBlurOnWeb', () => ({
    navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
}));

installWorkflowRendererCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (v: any) => v.web ?? v.default,
            },
            AppState: {
                currentState: 'active',
                addEventListener: () => ({ remove: () => {} }),
            },
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const expoRouterMock = createExpoRouterMock({
            router: { push: pushSpy },
        });
        return expoRouterMock.module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, vars?: any) =>
                key === 'tools.taskView.moreTools' ? `more:${vars?.count ?? ''}` : key,
        });
    },
});

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

describe('SubAgentSummarySection (+N more tools row)', () => {
    it('does not crash when detailLevel changes from title to summary', async () => {
        const { SubAgentSummarySection } = await import('./SubAgentSummarySection');

        const taskTool = makeToolCall({
            name: 'Task',
            state: 'running',
            input: { description: 'Hook stability check' },
            createdAt: 10,
            startedAt: 10,
            completedAt: null,
        });

        const toolMessages: Message[] = [];

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SubAgentSummarySection
                    tool={taskTool}
                    metadata={null}
                    messages={toolMessages}
                    detailLevel="title"
                    sessionId="s1"
                    messageId="msg-task-1"
                />)).tree;

        expect(() => {
            act(() => {
                tree!.update(
                    <SubAgentSummarySection
                        tool={taskTool}
                        metadata={null}
                        messages={toolMessages}
                        detailLevel="summary"
                        sessionId="s1"
                        messageId="msg-task-1"
                    />,
                );
            });
        }).not.toThrow();
    });

    it('does not crash when content appears after an initially empty render', async () => {
        const { SubAgentSummarySection } = await import('./SubAgentSummarySection');

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

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SubAgentSummarySection
                    tool={emptyTool}
                    metadata={null}
                    messages={toolMessages}
                    detailLevel="summary"
                    sessionId="s1"
                    messageId="msg-task-1"
                />)).tree;

        expect(() => {
            act(() => {
                tree!.update(
                    <SubAgentSummarySection
                        tool={toolWithContent}
                        metadata={null}
                        messages={toolMessages}
                        detailLevel="summary"
                        sessionId="s1"
                        messageId="msg-task-1"
                    />,
                );
            });
        }).not.toThrow();
    });

    it('renders the +N more tools row above the visible tools (and makes it tappable)', async () => {
        pushSpy.mockClear();
        navigateWithBlurOnWebSpy.mockClear();
        const { SubAgentSummarySection } = await import('./SubAgentSummarySection');

        const taskTool = makeToolCall({
            name: 'Task',
            state: 'running',
            input: { description: 'Tool stress ideas' },
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

        const screen = await renderScreen(<SubAgentSummarySection
            tool={taskTool}
            metadata={null}
            messages={toolMessages}
            detailLevel="summary"
            sessionId="s1"
            messageId="msg-task-1"
        />);

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
        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(pushSpy).toHaveBeenCalledWith('/session/s1/message/msg-task-1');
    });
});
