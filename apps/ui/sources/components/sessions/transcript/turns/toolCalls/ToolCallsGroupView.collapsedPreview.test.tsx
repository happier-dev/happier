import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createExpoVectorIconsMock,
    createToolCallMessageFixture,
    renderToolCallsGroupView,
    standardCleanup,
} from '@/dev/testkit';
import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { createReducer } from '@/sync/reducer/reducer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                        AppState: { addEventListener: () => ({ remove: () => {} }) },
                        Platform: { OS: 'ios', select: (values: any) => values?.ios ?? values?.default ?? null },
                    }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            card: '#fff',
            text: '#000',
            textSecondary: '#666',
            textDestructive: '#c00',
            agentEventText: '#666',
            success: '#0a0',
            surfacePressedOverlay: '#eee',
        },
    });
});

vi.mock('@expo/vector-icons', async () => createExpoVectorIconsMock());

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string) => key,
}));

let collapsedPreviewCount: number = 1;
vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSetting: (key: string) => {
                if (key === 'toolViewTimelineChromeMode') return 'activity_feed';
                if (key === 'transcriptToolCallsCollapsedPreviewCount') return collapsedPreviewCount;
                return null;
            },
            useSessionMessagesById: () => ({}),
            useSessionMessagesReducerState: () => createReducer(),
        },
    });
});

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: () => null,
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: (props: any) => React.createElement('ToolTimelineRow', props),
}));

vi.mock('@/components/tools/shell/views/timeline/ToolTimelinePreviewRow', () => ({
    ToolTimelinePreviewRow: (props: any) => React.createElement('ToolTimelinePreviewRow', props),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: (props: any) => React.createElement('TranscriptEnterWrapper', props, props.children),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptCollapsible', () => ({
    TranscriptCollapsible: (props: any) => React.createElement(
        'TranscriptCollapsible',
        props,
        props.expanded ? props.children : null,
    ),
}));

describe('ToolCallsGroupView (collapsed preview)', () => {
    afterEach(standardCleanup);

    it('renders the last N tool previews when collapsed', async () => {
        collapsedPreviewCount = 2;

        const toolMessages = [
            createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
            createToolCallMessageFixture({ id: 'm2', createdAt: 2 }),
            createToolCallMessageFixture({ id: 'm3', createdAt: 3 }),
        ];

        const screen = await renderToolCallsGroupView({
            toolMessages,
            setExpanded: vi.fn(),
        });

        const previews = screen.findAllByTestId('transcript-tool-calls-preview-row');
        expect(previews).toHaveLength(2);

        const previewIds = previews.map((p) => (p.props as any).children?.props?.messageId).filter(Boolean);
        expect(previewIds).toEqual(['m2', 'm3']);

        const moreRows = screen.findAllByTestId('transcript-tool-calls-preview-more');
        expect(moreRows).toHaveLength(1);

        const order = screen.findAll((node) =>
            (node.props as any).testID === 'transcript-tool-calls-preview-more' ||
            (node.props as any).testID === 'transcript-tool-calls-preview-row',
        )
            .map((n) => (n.props as any).testID);
        expect(order).toEqual([
            'transcript-tool-calls-preview-more',
            'transcript-tool-calls-preview-row',
            'transcript-tool-calls-preview-row',
        ]);
    });

    it('renders no previews when count is 0', async () => {
        collapsedPreviewCount = 0;

        const toolMessages = [
            createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
            createToolCallMessageFixture({ id: 'm2', createdAt: 2 }),
        ];

        const screen = await renderToolCallsGroupView({
            toolMessages,
            setExpanded: vi.fn(),
        });

        const previews = screen.findAllByTestId('transcript-tool-calls-preview-row');
        expect(previews).toHaveLength(0);

        const moreRows = screen.findAllByTestId('transcript-tool-calls-preview-more');
        expect(moreRows).toHaveLength(0);
    });

    it('clamps preview count to 15', async () => {
        collapsedPreviewCount = 999;

        const toolMessages = Array.from({ length: 20 }, (_, i) =>
            createToolCallMessageFixture({ id: `m${i + 1}`, createdAt: i + 1 }),
        );

        const screen = await renderToolCallsGroupView({
            toolMessages,
            setExpanded: vi.fn(),
        });

        const previews = screen.findAllByTestId('transcript-tool-calls-preview-row');
        expect(previews).toHaveLength(15);
    });

    it('requests expansion via setExpanded(true) when tapping the +N more row', async () => {
        collapsedPreviewCount = 1;

        const toolMessages = [
            createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
            createToolCallMessageFixture({ id: 'm2', createdAt: 2 }),
        ];
        const setExpanded = vi.fn();

        const screen = await renderToolCallsGroupView({
            toolMessages,
            setExpanded,
        });

        await act(async () => {
            screen.pressByTestId('transcript-tool-calls-preview-more');
        });

        expect(setExpanded).toHaveBeenCalledWith(true);
    });

    it('does not pass nested tool message ids when tool navigation is disabled', async () => {
        const { ToolCallsGroupView } = await import('./ToolCallsGroupView');
        collapsedPreviewCount = 2;

        const toolMessages = [
            createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
            createToolCallMessageFixture({ id: 'm2', createdAt: 2 }),
            createToolCallMessageFixture({ id: 'm3', createdAt: 3 }),
        ];

        const screen = await renderToolCallsGroupView({
            toolMessages,
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            setExpanded: vi.fn(),
        });

        const previewRows = screen.findAllByType('ToolTimelineRow');
        expect(previewRows.length).toBeGreaterThan(0);
        expect(previewRows.every((node) => node.props.messageId === undefined)).toBe(true);

        await act(async () => {
            await screen.update(
                <ToolCallsGroupView
                    id="toolCalls:1"
                    status="running"
                    toolMessages={toolMessages}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true }}
                    expanded={true}
                    setExpanded={vi.fn()}
                />,
            );
        });

        const expandedRows = screen.findAllByType('ToolTimelineRow');
        expect(expandedRows.length).toBe(toolMessages.length);
        expect(expandedRows.every((node) => node.props.messageId === undefined)).toBe(true);
    });

    it('passes stable route ids to grouped tool rows when server ids exist', async () => {
        collapsedPreviewCount = 2;

        const toolMessages: ToolCallMessage[] = [
            {
                ...createToolCallMessageFixture({ id: 'internal-1', createdAt: 1 }),
                realID: 'server-msg-1',
                tool: { ...createToolCallMessageFixture({ id: 'internal-1', createdAt: 1 }).tool, id: 'call_read_1' },
            } as ToolCallMessage,
            {
                ...createToolCallMessageFixture({ id: 'internal-2', createdAt: 2 }),
                realID: 'server-msg-2',
                tool: { ...createToolCallMessageFixture({ id: 'internal-2', createdAt: 2 }).tool, id: 'call_read_2' },
            } as ToolCallMessage,
        ];

        const screen = await renderToolCallsGroupView({
            toolMessages,
            expanded: true,
            setExpanded: vi.fn(),
        });

        const rows = screen.findAllByType('ToolTimelineRow');
        expect(rows).toHaveLength(2);
        expect(rows.map((node) => node.props.messageId)).toEqual(['server:server-msg-1', 'server:server-msg-2']);
    });
});
