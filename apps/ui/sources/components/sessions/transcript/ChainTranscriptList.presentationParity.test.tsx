import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { makeToolCall, renderScreen } from '@/dev/testkit';
import type { Message } from '@/sync/domains/messages/messageTypes';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const settings = {
    transcriptGroupingMode: 'linear',
    transcriptGroupToolCalls: true,
    transcriptTurnToolCallsGroupStrategy: 'consecutive_tools',
    toolViewTimelineChromeMode: 'activity_feed',
    sessionThinkingDisplayMode: 'inline',
    sessionThinkingInlinePresentation: 'summary',
    transcriptThinkingPulseStaleMs: 30_000,
} as Record<string, unknown>;

const turnViewSpy = vi.fn();
const toolCallsGroupRowSpy = vi.fn();
const messageViewSpy = vi.fn();
let scrollToIndexSpy: ReturnType<typeof vi.fn> | null = null;

vi.mock('@/sync/sync', () => ({
    sync: {
        getSyncTuning: () => ({
            transcriptFlashListEstimatedItemSize: 120,
            transcriptMaxTurnEntriesPerListItem: 8,
        }),
    },
}));

installTranscriptCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => settings[key] ?? false,
        });
    },
});

vi.mock('@shopify/flash-list', () => ({
    FlashList: React.forwardRef((props: any, ref: any) => {
        scrollToIndexSpy = vi.fn();
        const instance = {
            scrollToIndex: scrollToIndexSpy,
            scrollToOffset: vi.fn(),
            scrollToEnd: vi.fn(),
        };
        if (typeof ref === 'function') ref(instance);
        else if (ref && typeof ref === 'object') ref.current = instance;

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
    }),
}));

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageView: (props: any) => {
        messageViewSpy(props);
        return React.createElement('MessageView', props);
    },
    MessageViewWithSessionCommon: (props: any) => {
        messageViewSpy(props);
        return React.createElement('MessageView', props);
    },
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: (props: any) => {
        turnViewSpy(props);
        return React.createElement('TurnView', props);
    },
    TurnViewWithSessionCommon: (props: any) => {
        turnViewSpy(props);
        return React.createElement('TurnView', props);
    },
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
    ToolCallsGroupRow: (props: any) => {
        toolCallsGroupRowSpy(props);
        return React.createElement('ToolCallsGroupRow', props);
    },
    ToolCallsGroupRowWithSessionCommon: (props: any) => {
        toolCallsGroupRowSpy(props);
        return React.createElement('ToolCallsGroupRow', props);
    },
}));

describe('ChainTranscriptList presentation parity', () => {
    beforeEach(() => {
        vi.resetModules();
        resetTranscriptCommonModuleMockState();
        settings.transcriptGroupingMode = 'linear';
        settings.transcriptGroupToolCalls = true;
        settings.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
        settings.toolViewTimelineChromeMode = 'activity_feed';
        settings.sessionThinkingDisplayMode = 'inline';
        settings.sessionThinkingInlinePresentation = 'summary';
        settings.transcriptThinkingPulseStaleMs = 30_000;
        turnViewSpy.mockReset();
        toolCallsGroupRowSpy.mockReset();
        messageViewSpy.mockReset();
        scrollToIndexSpy = null;
    });

    it('groups consecutive tool calls the same way as the main transcript when grouping is enabled', async () => {
        const { ChainTranscriptList } = await import('./ChainTranscriptList');

        const toolMessageOne: Message = {
            kind: 'tool-call',
            id: 'tool-msg-1',
            localId: null,
            createdAt: 1,
            tool: makeToolCall({ id: 'tool-1', name: 'Read', input: { file: 'a.ts' }, createdAt: 1 }),
            children: [],
        };
        const toolMessageTwo: Message = {
            kind: 'tool-call',
            id: 'tool-msg-2',
            localId: null,
            createdAt: 2,
            tool: makeToolCall({ id: 'tool-2', name: 'Read', input: { file: 'b.ts' }, createdAt: 2 }),
            children: [],
        };

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(ChainTranscriptList, {
                    sessionId: 's1',
                    messages: [toolMessageOne, toolMessageTwo],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                }))).tree;

        expect(toolCallsGroupRowSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 's1',
                toolMessageIds: ['tool-msg-1', 'tool-msg-2'],
            }),
        );
        expect(messageViewSpy).not.toHaveBeenCalled();
    });

    it('keeps a long turn-level tool run as one semantic group in turn layout', async () => {
        settings.transcriptGroupingMode = 'turns';
        settings.transcriptTurnToolCallsGroupStrategy = 'all_tools_in_turn';

        const { ChainTranscriptList } = await import('./ChainTranscriptList');

        const userMessage: Message = {
            kind: 'user-text',
            id: 'user-1',
            localId: null,
            createdAt: 1,
            text: 'Run the audit',
        };
        const toolMessages: Message[] = Array.from({ length: 200 }, (_, index) => ({
            kind: 'tool-call',
            id: `tool-msg-${index + 1}`,
            localId: null,
            createdAt: index + 2,
            tool: makeToolCall({
                id: `tool-${index + 1}`,
                name: 'Read',
                input: { file: `file-${index + 1}.ts` },
                createdAt: index + 2,
            }),
            children: [],
        }));

        await renderScreen(React.createElement(ChainTranscriptList, {
                    sessionId: 's1',
                    messages: [userMessage, ...toolMessages],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                }));

        expect(toolCallsGroupRowSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                toolMessageIds: toolMessages.map((message) => message.id),
            }),
        );
        const groupSizes = toolCallsGroupRowSpy.mock.calls
            .map(([props]) => Array.isArray(props?.toolMessageIds) ? props.toolMessageIds.length : 0);
        expect(groupSizes).not.toContain(8);
        expect(groupSizes.every((size) => size === 200)).toBe(true);
    });

    it('uses turn layout in tool transcripts when transcript layout is set to turns', async () => {
        settings.transcriptGroupingMode = 'turns';

        const { ChainTranscriptList } = await import('./ChainTranscriptList');

        const userMessage: Message = {
            kind: 'user-text',
            id: 'user-1',
            localId: null,
            createdAt: 1,
            text: 'Start a task',
        };
        const toolMessage: Message = {
            kind: 'tool-call',
            id: 'tool-msg-1',
            localId: null,
            createdAt: 2,
            tool: makeToolCall({ id: 'tool-1', name: 'Read', input: { file: 'a.ts' }, createdAt: 2 }),
            children: [],
        };

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(ChainTranscriptList, {
                    sessionId: 's1',
                    messages: [userMessage, toolMessage],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                }))).tree;

        expect(turnViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                turn: expect.objectContaining({
                    userMessageId: 'user-1',
                }),
            }),
        );
    });

    it('passes forced transcript permission prompts through to turn layouts', async () => {
        settings.transcriptGroupingMode = 'turns';

        const { ChainTranscriptList } = await import('./ChainTranscriptList');

        const userMessage: Message = {
            kind: 'user-text',
            id: 'user-1',
            localId: null,
            createdAt: 1,
            text: 'Start a subagent',
        };

        await renderScreen(React.createElement(ChainTranscriptList, {
                    sessionId: 's1',
                    messages: [userMessage],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                    forcePermissionPromptsInTranscript: true,
                }));

        expect(turnViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                forcePermissionPromptsInTranscript: true,
            }),
        );
    });

    it('does not auto-pin after local tool expansion before first content measurement', async () => {
        const { ChainTranscriptList } = await import('./ChainTranscriptList');

        const toolMessageOne: Message = {
            kind: 'tool-call',
            id: 'tool-msg-1',
            localId: null,
            createdAt: 1,
            tool: makeToolCall({ id: 'tool-1', name: 'Read', input: { file: 'a.ts' }, createdAt: 1 }),
            children: [],
        };
        const toolMessageTwo: Message = {
            kind: 'tool-call',
            id: 'tool-msg-2',
            localId: null,
            createdAt: 2,
            tool: makeToolCall({ id: 'tool-2', name: 'Read', input: { file: 'b.ts' }, createdAt: 2 }),
            children: [],
        };

        const screen = await renderScreen(React.createElement(ChainTranscriptList, {
            sessionId: 's1',
            messages: [toolMessageOne, toolMessageTwo],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
        }));

        const toolRow = screen.tree.root.findByType('ToolCallsGroupRow' as any);
        act(() => {
            toolRow.props.onSetExpanded({
                toolCallsGroupId: toolRow.props.toolCallsGroupId,
                toolMessageIds: toolRow.props.toolMessageIds,
                expanded: true,
            });
        });

        const list = screen.tree.root.findByType('FlashList' as any);
        act(() => {
            list.props.onLayout({ nativeEvent: { layout: { height: 300 } } });
            list.props.onContentSizeChange(0, 600);
        });

        expect(scrollToIndexSpy).not.toHaveBeenCalled();
    });

    it('keeps the initial auto-pin when local tool expansion does not change state', async () => {
        const { ChainTranscriptList } = await import('./ChainTranscriptList');

        const toolMessageOne: Message = {
            kind: 'tool-call',
            id: 'tool-msg-1',
            localId: null,
            createdAt: 1,
            tool: makeToolCall({ id: 'tool-1', name: 'Read', input: { file: 'a.ts' }, createdAt: 1 }),
            children: [],
        };
        const toolMessageTwo: Message = {
            kind: 'tool-call',
            id: 'tool-msg-2',
            localId: null,
            createdAt: 2,
            tool: makeToolCall({ id: 'tool-2', name: 'Read', input: { file: 'b.ts' }, createdAt: 2 }),
            children: [],
        };

        const screen = await renderScreen(React.createElement(ChainTranscriptList, {
            sessionId: 's1',
            messages: [toolMessageOne, toolMessageTwo],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
        }));

        const toolRow = screen.tree.root.findByType('ToolCallsGroupRow' as any);
        act(() => {
            toolRow.props.onSetExpanded({
                toolCallsGroupId: toolRow.props.toolCallsGroupId,
                toolMessageIds: toolRow.props.toolMessageIds,
                expanded: false,
            });
        });

        const list = screen.tree.root.findByType('FlashList' as any);
        const initialScrollToIndexSpy = scrollToIndexSpy;
        if (!initialScrollToIndexSpy) {
            throw new Error('Expected FlashList ref to provide scrollToIndex');
        }
        act(() => {
            list.props.onLayout({ nativeEvent: { layout: { height: 300 } } });
            list.props.onContentSizeChange(0, 600);
        });

        expect(initialScrollToIndexSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                index: 0,
                animated: false,
                viewPosition: 1,
            }),
        );
    });

    it('does not auto-pin after local thinking expansion before first content measurement', async () => {
        const { ChainTranscriptList } = await import('./ChainTranscriptList');

        const screen = await renderScreen(React.createElement(ChainTranscriptList, {
            sessionId: 's1',
            messages: [{
                kind: 'agent-text',
                id: 'agent-thinking-1',
                localId: null,
                createdAt: 1,
                text: 'thinking',
                isThinking: true,
            }],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
        }));

        const messageView = screen.tree.root.findByType('MessageView' as any);
        act(() => {
            messageView.props.onThinkingExpandedChange?.(true);
        });

        const list = screen.tree.root.findByType('FlashList' as any);
        act(() => {
            list.props.onLayout({ nativeEvent: { layout: { height: 300 } } });
            list.props.onContentSizeChange(0, 600);
        });

        expect(scrollToIndexSpy).not.toHaveBeenCalled();
    });

});
