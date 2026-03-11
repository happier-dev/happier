import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { makeToolCall } from '@/components/tools/shell/views/ToolView.testHelpers';
import type { Message } from '@/sync/domains/messages/messageTypes';

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

vi.mock('@/sync/sync', () => ({
    sync: {
        getSyncTuning: () => ({
            transcriptFlashListEstimatedItemSize: 120,
        }),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => settings[key] ?? false,
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

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageView: (props: any) => {
        messageViewSpy(props);
        return React.createElement('MessageView', props);
    },
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: (props: any) => {
        turnViewSpy(props);
        return React.createElement('TurnView', props);
    },
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
    ToolCallsGroupRow: (props: any) => {
        toolCallsGroupRowSpy(props);
        return React.createElement('ToolCallsGroupRow', props);
    },
}));

describe('ChainTranscriptList presentation parity', () => {
    beforeEach(() => {
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
        await act(async () => {
            tree = renderer.create(
                React.createElement(ChainTranscriptList, {
                    sessionId: 's1',
                    messages: [toolMessageOne, toolMessageTwo],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                }),
            );
            await Promise.resolve();
        });

        expect(toolCallsGroupRowSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 's1',
                toolMessageIds: ['tool-msg-1', 'tool-msg-2'],
            }),
        );
        expect(messageViewSpy).not.toHaveBeenCalled();
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
        await act(async () => {
            tree = renderer.create(
                React.createElement(ChainTranscriptList, {
                    sessionId: 's1',
                    messages: [userMessage, toolMessage],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                }),
            );
            await Promise.resolve();
        });

        expect(turnViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                turn: expect.objectContaining({
                    userMessageId: 'user-1',
                }),
            }),
        );
    });

    it('renders draft transcript messages after committed messages in the same chain', async () => {
        const { ChainTranscriptList } = await import('./ChainTranscriptList');

        const committedMessage: Message = {
            kind: 'agent-text',
            id: 'msg-1',
            localId: null,
            createdAt: 1,
            text: 'Committed',
        };
        const draftMessage: Message = {
            kind: 'agent-text',
            id: 'draft:local-1',
            localId: 'local-1',
            createdAt: 2,
            text: 'Draft tail',
            isThinking: true,
        };

        await act(async () => {
            renderer.create(
                React.createElement(ChainTranscriptList, {
                    sessionId: 's1',
                    messages: [committedMessage],
                    draftMessages: [draftMessage],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                }),
            );
            await Promise.resolve();
        });

        expect(messageViewSpy.mock.calls.map((call) => call[0]?.message?.id)).toEqual(['msg-1', 'draft:local-1']);
        expect(messageViewSpy.mock.calls.at(-1)?.[0]?.message?.text).toBe('Draft tail');
    });
});
