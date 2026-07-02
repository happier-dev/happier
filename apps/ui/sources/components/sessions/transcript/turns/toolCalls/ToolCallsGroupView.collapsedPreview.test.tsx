import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createToolCallMessageFixture,
    renderToolCallsGroupView,
    standardCleanup,
} from '@/dev/testkit';
import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { createReducer } from '@/sync/reducer/reducer';
import { installToolCallsGroupViewCommonModuleMocks } from './toolCallsGroupViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let collapsedPreviewCount: number | null = 1;
const storageHookCalls = vi.hoisted(() => [] as string[]);
const messageViewMockState = vi.hoisted(() => ({
    messageViewCalls: [] as Array<Record<string, unknown>>,
    messageViewWithCommonCalls: [] as Array<Record<string, unknown>>,
}));
const flashListCompatMockState = vi.hoisted(() => ({
    getMappingKey: vi.fn((itemKey: string, index: number) => `mapped:${itemKey}:${index}`),
}));

installToolCallsGroupViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            AppState: { addEventListener: () => ({ remove: () => {} }) },
            Platform: { OS: 'ios', select: (values: any) => values?.ios ?? values?.default ?? null },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    text: {
                        secondary: '#555555',
                    },
                },
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    storageHookCalls.push(`useSetting:${key}`);
                    if (key === 'toolViewTimelineChromeMode') return 'activity_feed';
                    if (key === 'transcriptToolCallsCollapsedPreviewCount') return collapsedPreviewCount;
                    return null;
                },
                useSessionMessagesById: () => {
                    storageHookCalls.push('useSessionMessagesById');
                    return {};
                },
                useSessionMessagesReducerState: () => {
                    storageHookCalls.push('useSessionMessagesReducerState');
                    return createReducer();
                },
            },
        });
    },
});

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageView: (props: Record<string, unknown>) => {
        messageViewMockState.messageViewCalls.push(props);
        return React.createElement('MessageView', props);
    },
    MessageViewWithSessionCommon: (props: Record<string, unknown>) => {
        messageViewMockState.messageViewWithCommonCalls.push(props);
        return React.createElement('MessageViewWithSessionCommon', props);
    },
}));

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

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    useMappingHelper: () => ({
        getMappingKey: flashListCompatMockState.getMappingKey,
    }),
}));

describe('ToolCallsGroupView (collapsed preview)', () => {
    beforeEach(() => {
        storageHookCalls.length = 0;
        messageViewMockState.messageViewCalls = [];
        messageViewMockState.messageViewWithCommonCalls = [];
    });

    afterEach(() => {
        flashListCompatMockState.getMappingKey.mockClear();
        standardCleanup();
    });

    it('renders with parent-provided transcript session common without row-local session storage subscriptions', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { ToolCallsGroupViewWithSessionCommon } = await import('./ToolCallsGroupView');
        const reducerState = createReducer();
        const toolMessages: ToolCallMessage[] = [
            {
                ...createToolCallMessageFixture({ id: 'structured-tool', createdAt: 1 }),
                meta: {
                    happier: {
                        kind: 'review_findings.v1',
                        payload: { findings: [] },
                    },
                },
            } as ToolCallMessage,
        ];
        const forkCommon = {
            executionRunsEnabled: true,
            sessionForkSupportSource: null,
            sessionReplayEnabled: true,
            sessionReplayMaxSeedChars: 1000,
            sessionReplayStrategy: 'summary_plus_recent',
            sessionReplaySummaryRunnerV1: null,
        } as const;
        const messageDisplayCommon = {
            sessionThinkingDisplayMode: 'inline',
            sessionThinkingInlineChrome: 'plain',
            sessionThinkingInlinePresentation: 'full',
            transcriptMessageTimestampDisplayMode: 'always',
            transcriptMessageSelectionEnabled: false,
            transcriptMessageSendToSessionEnabled: false,
            transcriptStreamingMarkdownRenderingEnabled: true,
            transcriptStreamingPartialOutputEnabled: true,
            transcriptStreamingSettleDelayMs: 0,
            transcriptStreamingSmoothingEnabled: true,
            workspacePath: null,
        } as const;
        const toolChromeCommon = {
            toolViewTimelineChromeMode: 'activity_feed',
            transcriptToolCallsCollapsedPreviewCount: 1,
            transcriptToolCallsGroupShowBackground: false,
        } as const;
        const toolRouteCommon = {
            messagesById: {},
            reducerState,
        } as const;

        await renderScreen(
            <ToolCallsGroupViewWithSessionCommon
                id="toolCalls:1"
                status="completed"
                toolMessages={toolMessages}
                metadata={null}
                sessionId="s1"
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
                expanded={true}
                setExpanded={vi.fn()}
                forkCommon={forkCommon}
                messageDisplayCommon={messageDisplayCommon}
                toolChromeCommon={toolChromeCommon}
                toolRouteCommon={toolRouteCommon}
            />,
        );

        expect(storageHookCalls).toEqual([]);
        expect(messageViewMockState.messageViewCalls).toHaveLength(0);
        expect(messageViewMockState.messageViewWithCommonCalls).toHaveLength(1);
        expect(messageViewMockState.messageViewWithCommonCalls[0]).toMatchObject({
            forkCommon,
            messageDisplayCommon,
            toolChromeCommon,
            toolRouteCommon,
        });
    });

    it('does not allocate hidden body rows for large collapsed tool groups', async () => {
        collapsedPreviewCount = 3;

        const toolMessages = Array.from({ length: 200 }, (_, index) =>
            createToolCallMessageFixture({ id: `tool-${index + 1}`, createdAt: index + 1 }),
        );

        const screen = await renderToolCallsGroupView({
            toolMessages,
            expanded: false,
            setExpanded: vi.fn(),
        });

        expect(screen.findAllByTestId('transcript-tool-calls-preview-row')).toHaveLength(3);
        expect(screen.findAllByTestId('transcript-tool-calls-tool-row')).toHaveLength(0);
        const mappedKeys = flashListCompatMockState.getMappingKey.mock.calls.map(([key]) => key);
        expect(mappedKeys.every((key) => String(key).startsWith('preview:'))).toBe(true);
        expect(new Set(mappedKeys)).toEqual(new Set([
            'preview:tool-198',
            'preview:tool-199',
            'preview:tool-200',
        ]));
    });

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

    it('defaults to the newest three tool previews when the setting is unavailable', async () => {
        collapsedPreviewCount = null;

        const toolMessages = [
            createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
            createToolCallMessageFixture({ id: 'm2', createdAt: 2 }),
            createToolCallMessageFixture({ id: 'm3', createdAt: 3 }),
            createToolCallMessageFixture({ id: 'm4', createdAt: 4 }),
        ];

        const screen = await renderToolCallsGroupView({
            toolMessages,
            setExpanded: vi.fn(),
        });

        const previewIds = screen
            .findAllByTestId('transcript-tool-calls-preview-row')
            .map((p) => (p.props as any).children?.props?.messageId)
            .filter(Boolean);

        expect(previewIds).toEqual(['m2', 'm3', 'm4']);
        expect(screen.findAllByTestId('transcript-tool-calls-preview-more')).toHaveLength(1);
    });

    it('keeps stable web prepend anchors inside each collapsed preview row', async () => {
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

        expect(screen.findAllByTestId('transcript-anchor-tool-call-m2')).toHaveLength(1);
        expect(screen.findAllByTestId('transcript-anchor-tool-call-m3')).toHaveLength(1);
        expect(screen.findAllByTestId('transcript-tool-calls-preview-row')).toHaveLength(2);
    });

    it('updates collapsed previews to the newest tools when a tool is appended', async () => {
        const { ToolCallsGroupView } = await import('./ToolCallsGroupView');
        collapsedPreviewCount = 2;

        const initialToolMessages = [
            createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
            createToolCallMessageFixture({ id: 'm2', createdAt: 2 }),
        ];
        const nextToolMessages = [
            ...initialToolMessages,
            createToolCallMessageFixture({ id: 'm3', createdAt: 3 }),
        ];

        const screen = await renderToolCallsGroupView({
            toolMessages: initialToolMessages,
            expanded: false,
            setExpanded: vi.fn(),
        });

        const initialPreviewIds = screen
            .findAllByTestId('transcript-tool-calls-preview-row')
            .map((p) => (p.props as any).children?.props?.messageId)
            .filter(Boolean);
        expect(initialPreviewIds).toEqual(['m1', 'm2']);

        await act(async () => {
            await screen.update(
                <ToolCallsGroupView
                    id="toolCalls:1"
                    status="running"
                    toolMessages={nextToolMessages}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                    expanded={false}
                    setExpanded={vi.fn()}
                />,
            );
        });

        const previewIds = screen
            .findAllByTestId('transcript-tool-calls-preview-row')
            .map((p) => (p.props as any).children?.props?.messageId)
            .filter(Boolean);
        expect(previewIds).toEqual(['m2', 'm3']);
        expect(screen.findAllByTestId('transcript-tool-calls-preview-more')).toHaveLength(1);
    });

    it('uses FlashList recycling-aware keys for preview and expanded tool rows', async () => {
        collapsedPreviewCount = 2;
        const toolMessages = [
            createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
            createToolCallMessageFixture({ id: 'm2', createdAt: 2 }),
        ];

        await renderToolCallsGroupView({
            toolMessages,
            expanded: true,
            setExpanded: vi.fn(),
        });

        expect(flashListCompatMockState.getMappingKey).toHaveBeenCalledWith('m1', 0);
        expect(flashListCompatMockState.getMappingKey).toHaveBeenCalledWith('m2', 1);

        flashListCompatMockState.getMappingKey.mockClear();

        await renderToolCallsGroupView({
            toolMessages,
            expanded: false,
            setExpanded: vi.fn(),
        });

        expect(flashListCompatMockState.getMappingKey).toHaveBeenCalledWith('preview:m1', 0);
        expect(flashListCompatMockState.getMappingKey).toHaveBeenCalledWith('preview:m2', 1);
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

    it('uses the neutral loading color for a running tool group header', async () => {
        collapsedPreviewCount = 1;

        const toolMessages = [
            createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
        ];

        const screen = await renderToolCallsGroupView({
            toolMessages,
            status: 'running',
            setExpanded: vi.fn(),
        });

        const spinner = screen.findAllByType('ActivityIndicator' as any)[0];
        expect(spinner?.props?.color).toBe('#555555');
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

    it('does not request expansion when tapping the header while collapsed and hidden rows remain', async () => {
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

        const header = screen.findByTestId('transcript-tool-calls-header');
        expect(header?.props.onPress).toBeUndefined();
        expect(setExpanded).not.toHaveBeenCalled();
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
