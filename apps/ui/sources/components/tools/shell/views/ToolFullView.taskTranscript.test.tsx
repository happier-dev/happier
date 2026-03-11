import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { makeToolCall } from './ToolView.testHelpers';
import type { Message } from '@/sync/domains/messages/messageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ensureSidechainMessagesLoadedMock = vi.fn(async () => 'loaded');

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: ensureSidechainMessagesLoadedMock,
        loadOlderSidechainMessages: vi.fn(),
        getSyncTuning: () => ({
            transcriptFlashListEstimatedItemSize: 120,
        }),
    },
}));

vi.mock('@shopify/flash-list', () => ({
    FlashList: (props: any) => {
        const data = Array.isArray(props.data) ? props.data : [];
        const header =
            props.ListHeaderComponent
                ? (typeof props.ListHeaderComponent === 'function' ? props.ListHeaderComponent() : props.ListHeaderComponent)
                : null;
        const footer =
            props.ListFooterComponent
                ? (typeof props.ListFooterComponent === 'function' ? props.ListFooterComponent() : props.ListFooterComponent)
                : null;

        return React.createElement(
            'FlashList',
            props,
            header,
            data.map((item: any, index: number) => {
                const key =
                    typeof props.keyExtractor === 'function'
                        ? props.keyExtractor(item, index)
                        : (item?.id ?? String(index));
                const child = typeof props.renderItem === 'function' ? props.renderItem({ item, index }) : null;
                return React.createElement('FlashListItem', { key }, child);
            }),
            footer,
        );
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: () => false,
    useSetting: () => false,
    useSessionTranscriptDraftMessages: () => [],
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

const renderedSpecificTaskViewSpy = vi.fn();
const renderedSpecificSubAgentRunViewSpy = vi.fn();

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: (toolName: string) => {
        if (toolName === 'Task') {
            return (props: any) => {
                renderedSpecificTaskViewSpy(props);
                return React.createElement('TaskSpecificView', null);
            };
        }
        if (toolName === 'SubAgentRun') {
            return (props: any) => {
                renderedSpecificSubAgentRunViewSpy(props);
                return React.createElement('SubAgentRunSpecificView', null);
            };
        }
        return null;
    },
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        Task: { title: 'Task' },
        SubAgentRun: { title: 'SubAgentRun' },
    },
}));

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: () => null,
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

const renderedMessageViewSpy = vi.fn();

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageView: (props: any) => {
        renderedMessageViewSpy(props);
        return React.createElement('MessageView', null);
    },
}));

describe('ToolFullView (Task transcript reuse)', () => {
    let ToolFullView: typeof import('./ToolFullView').ToolFullView;

    beforeAll(async () => {
        ({ ToolFullView } = await import('./ToolFullView'));
    }, 30000);

    beforeEach(() => {
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');
    });

    it('ensures the sidechain transcript is loaded for Task tools', async () => {
        const tool = makeToolCall({
            id: 'tool_task_1',
            name: 'Task',
            input: { operation: 'run', description: 'Explore' },
            result: null,
        });

        await act(async () => {
            renderer.create(
                React.createElement(ToolFullView, {
                    tool,
                    metadata: null,
                    messages: [],
                    sessionId: 's1',
                    interaction: { canSendMessages: true, canApprovePermissions: true },
                }),
            );
            await Promise.resolve();
        });

        expect(ensureSidechainMessagesLoadedMock).toHaveBeenCalledWith('s1', 'tool_task_1');
    });

    it('renders Task renderer as a header when Task transcript is empty (so the user still sees context)', async () => {
        renderedSpecificTaskViewSpy.mockReset();
        renderedMessageViewSpy.mockReset();

        const tool = makeToolCall({
            id: 'tool_task_1',
            name: 'Task',
            input: { operation: 'run', description: 'Explore' },
            result: { content: [{ type: 'text', text: 'Spawned successfully.' }] },
        });
        await act(async () => {
            renderer.create(
                React.createElement(ToolFullView, {
                    tool,
                    metadata: null,
                    messages: [],
                    sessionId: 's1',
                    interaction: { canSendMessages: true, canApprovePermissions: true },
                }),
            );
            await Promise.resolve();
        });

        expect(renderedSpecificTaskViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                detailLevel: 'full',
            }),
        );
        expect(renderedMessageViewSpy).not.toHaveBeenCalled();
        expect(ensureSidechainMessagesLoadedMock).toHaveBeenCalledWith('s1', 'tool_task_1');
    });

    it('ensures the sidechain transcript is loaded for SubAgentRun tools (prefers result.sidechainId when present)', async () => {
        const tool = makeToolCall({
            id: 'tool_subagent_1',
            name: 'SubAgentRun',
            input: { intent: 'delegate', backendId: 'claude' },
            result: { sidechainId: 'sidechain_run_123' },
        });

        await act(async () => {
            renderer.create(
                React.createElement(ToolFullView, {
                    tool,
                    metadata: null,
                    messages: [],
                    sessionId: 's1',
                    interaction: { canSendMessages: true, canApprovePermissions: true },
                }),
            );
            await Promise.resolve();
        });

        expect(ensureSidechainMessagesLoadedMock).toHaveBeenCalledWith('s1', 'sidechain_run_123');
    });

    it('renders Task sidechain messages through MessageView instead of Task renderer in full view', async () => {
        renderedSpecificTaskViewSpy.mockReset();
        renderedSpecificSubAgentRunViewSpy.mockReset();
        renderedMessageViewSpy.mockReset();

        const tool = makeToolCall({
            name: 'Task',
            input: { operation: 'run', description: 'Explore' },
            result: null,
        });
        const child: Message = {
            kind: 'agent-text',
            id: 'child-msg-1',
            localId: null,
            createdAt: 1000,
            text: 'Working...',
            isThinking: false,
        };
        await act(async () => {
            renderer.create(
                React.createElement(ToolFullView, {
                    tool,
                    metadata: null,
                    messages: [child],
                    sessionId: 's1',
                    interaction: { canSendMessages: true, canApprovePermissions: true },
                }),
            );
        });

        expect(renderedMessageViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                message: child,
                sessionId: 's1',
                interaction: expect.objectContaining({ disableToolNavigation: true }),
            }),
        );
        expect(renderedSpecificTaskViewSpy).not.toHaveBeenCalled();
        expect(renderedSpecificSubAgentRunViewSpy).not.toHaveBeenCalled();
    });

    it('renders SubAgentRun sidechain messages through MessageView instead of SubAgentRun renderer in full view', async () => {
        renderedSpecificTaskViewSpy.mockReset();
        renderedSpecificSubAgentRunViewSpy.mockReset();
        renderedMessageViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();

        const tool = makeToolCall({
            name: 'SubAgentRun',
            input: { intent: 'review', backendId: 'claude' },
            result: null,
        });
        const child: Message = {
            kind: 'agent-text',
            id: 'child-msg-2',
            localId: null,
            createdAt: 1001,
            text: 'Streaming...',
            isThinking: false,
        };
        await act(async () => {
            renderer.create(
                React.createElement(ToolFullView, {
                    tool,
                    metadata: null,
                    messages: [child],
                    sessionId: 's1',
                    interaction: { canSendMessages: true, canApprovePermissions: true },
                }),
            );
        });

        expect(renderedMessageViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                message: child,
                sessionId: 's1',
                interaction: expect.objectContaining({ disableToolNavigation: true }),
            }),
        );
        expect(renderedSpecificSubAgentRunViewSpy).not.toHaveBeenCalled();
    });

    it('renders Agent sidechain messages through MessageView in full view', async () => {
        renderedSpecificTaskViewSpy.mockReset();
        renderedSpecificSubAgentRunViewSpy.mockReset();
        renderedMessageViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();

        const tool = makeToolCall({
            name: 'Agent',
            input: { name: 'Alpha', team_name: 'probe' },
            result: null,
        });
        const child: Message = {
            kind: 'agent-text',
            id: 'child-msg-3',
            localId: null,
            createdAt: 1002,
            text: 'From Alpha: hello',
            isThinking: false,
        };
        await act(async () => {
            renderer.create(
                React.createElement(ToolFullView, {
                    tool,
                    metadata: null,
                    messages: [child],
                    sessionId: 's1',
                    interaction: { canSendMessages: true, canApprovePermissions: true },
                }),
            );
        });

        expect(renderedMessageViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                message: child,
                sessionId: 's1',
                interaction: expect.objectContaining({ disableToolNavigation: true }),
            }),
        );
        expect(renderedSpecificTaskViewSpy).not.toHaveBeenCalled();
        expect(renderedSpecificSubAgentRunViewSpy).not.toHaveBeenCalled();
    });

    it('renders Agent tools through the Task renderer header when the sidechain transcript is still empty', async () => {
        renderedSpecificTaskViewSpy.mockReset();
        renderedSpecificSubAgentRunViewSpy.mockReset();
        renderedMessageViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();

        const tool = makeToolCall({
            id: 'tool_agent_1',
            name: 'Agent',
            input: { name: 'Alpha', team_name: 'probe', description: 'Inspect repo, report one fact' },
            result: { content: [{ type: 'text', text: 'Spawned successfully.' }] },
        });
        await act(async () => {
            renderer.create(
                React.createElement(ToolFullView, {
                    tool,
                    metadata: { flavor: 'claude' } as any,
                    messages: [],
                    sessionId: 's1',
                    interaction: { canSendMessages: true, canApprovePermissions: true },
                }),
            );
            await Promise.resolve();
        });

        expect(renderedSpecificTaskViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                detailLevel: 'full',
            }),
        );
        expect(renderedMessageViewSpy).not.toHaveBeenCalled();
        expect(renderedSpecificSubAgentRunViewSpy).not.toHaveBeenCalled();
        expect(ensureSidechainMessagesLoadedMock).toHaveBeenCalledWith('s1', 'tool_agent_1');
    });
});
