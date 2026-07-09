import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createToolCallMessageFixture, renderScreen } from '@/dev/testkit';
import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { installToolCallsGroupViewCommonModuleMocks } from '@/components/sessions/transcript/turns/toolCalls/toolCallsGroupViewTestHelpers';
import { createTranscriptSessionCommonPropsFixture, flattenStyleProp } from './toolCallsGroupUnitsTestFixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const messageViewCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const ensureSidechainsLoadedCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

installToolCallsGroupViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values?.ios ?? values?.default ?? null },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
});

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageViewWithSessionCommon: (props: any) => {
        messageViewCalls.push(props);
        return React.createElement('MessageViewWithSessionCommon', props);
    },
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: (props: any) => React.createElement('ToolView', props),
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: (props: any) => React.createElement('ToolTimelineRow', props),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: (props: any) => React.createElement('TranscriptEnterWrapper', { ...props, testID: 'transcript-enter-wrapper' }, props.children),
}));

vi.mock('@/hooks/session/useEnsureSidechainsLoaded', () => ({
    useEnsureSidechainsLoaded: (params: Record<string, unknown>) => {
        ensureSidechainsLoadedCalls.push(params);
    },
}));

const interaction = { canSendMessages: true, canApprovePermissions: true } as const;

function makeSubAgentMessage(): ToolCallMessage {
    return createToolCallMessageFixture({
        id: 'tool-msg-1',
        createdAt: 1,
        tool: {
            id: 'subagent_run_1',
            name: 'SubAgentRun',
            state: 'running',
            input: { sidechainId: 'sidechain_run_1', intent: 'review' },
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: null,
        },
    });
}

async function renderToolRow(props: Record<string, unknown>) {
    const { ToolCallsGroupUnitToolRowWithSessionCommon } = await import('./ToolCallsGroupUnitToolRow');
    const rowProps = {
        sessionId: 's1',
        groupId: 'toolCalls:t1:m1',
        metadata: null,
        interaction,
        message: createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
        expanded: true,
        ...createTranscriptSessionCommonPropsFixture(),
        ...props,
    } as React.ComponentProps<typeof ToolCallsGroupUnitToolRowWithSessionCommon>;
    return renderScreen(React.createElement(ToolCallsGroupUnitToolRowWithSessionCommon, rowProps));
}

describe('ToolCallsGroupUnitToolRow', () => {
    it('renders plain feed tool rows through ToolTimelineRow with the stable testIDs and enter wrapper', async () => {
        messageViewCalls.length = 0;
        const screen = await renderToolRow({
            message: createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
            expanded: false,
        });

        expect(screen.findAllByType('ToolTimelineRow' as React.ElementType)).toHaveLength(1);
        expect(messageViewCalls).toHaveLength(0);
        expect(screen.findByTestId('transcript-anchor-tool-call-m1')).not.toBeNull();
        expect(screen.findByTestId('transcript-tool-calls-tool-row')).not.toBeNull();
        expect(screen.findByTestId('transcript-enter-wrapper')).not.toBeNull();
    });

    it('renders cards tool rows through MessageView with the grouped layout context and forwarded commons', async () => {
        messageViewCalls.length = 0;
        const common = createTranscriptSessionCommonPropsFixture({
            toolChromeCommon: { toolViewTimelineChromeMode: 'cards' },
        });
        await renderToolRow({
            message: createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
            expanded: false,
            ...common,
        });

        expect(messageViewCalls).toHaveLength(1);
        expect(messageViewCalls[0]).toMatchObject({
            layoutContext: 'tool_calls_group',
            sessionId: 's1',
            forkCommon: common.forkCommon,
            messageDisplayCommon: common.messageDisplayCommon,
            toolChromeCommon: common.toolChromeCommon,
            toolRouteCommon: common.toolRouteCommon,
        });
    });

    it('renders structured feed tool rows through MessageView', async () => {
        messageViewCalls.length = 0;
        await renderToolRow({
            message: {
                ...createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
                meta: {
                    happier: {
                        kind: 'review_findings.v1',
                        payload: { findings: [] },
                    },
                },
            },
            expanded: false,
        });

        expect(messageViewCalls).toHaveLength(1);
    });

    it('keeps collapsed subagent rows on ToolTimelineRow and eager-loads their sidechains', async () => {
        messageViewCalls.length = 0;
        ensureSidechainsLoadedCalls.length = 0;
        const screen = await renderToolRow({
            message: makeSubAgentMessage(),
            expanded: false,
        });

        expect(screen.findAllByType('ToolTimelineRow' as React.ElementType)).toHaveLength(1);
        expect(messageViewCalls).toHaveLength(0);
        expect(ensureSidechainsLoadedCalls).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    enabled: true,
                    sessionId: 's1',
                    sidechainIds: ['sidechain_run_1'],
                }),
            ]),
        );
    });

    it('renders expanded subagent rows through MessageView without sidechain eager-loading', async () => {
        messageViewCalls.length = 0;
        ensureSidechainsLoadedCalls.length = 0;
        await renderToolRow({
            message: makeSubAgentMessage(),
            expanded: true,
        });

        expect(messageViewCalls).toHaveLength(1);
        expect(ensureSidechainsLoadedCalls.every((call) => call.enabled === false)).toBe(true);
    });

    it('disables sidechain loading and nested route ids when tool navigation is disabled', async () => {
        ensureSidechainsLoadedCalls.length = 0;
        const screen = await renderToolRow({
            message: createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
            expanded: false,
            interaction: {
                canSendMessages: false,
                canApprovePermissions: false,
                disableToolNavigation: true,
            },
        });

        const rows = screen.findAllByType('ToolTimelineRow' as React.ElementType);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.props.messageId).toBeUndefined();
        expect(ensureSidechainsLoadedCalls.every((call) => call.enabled === false)).toBe(true);
    });

    it('passes stable server route ids to grouped tool rows when server ids exist', async () => {
        const screen = await renderToolRow({
            message: {
                ...createToolCallMessageFixture({ id: 'internal-1', createdAt: 1 }),
                realID: 'server-msg-1',
                tool: { ...createToolCallMessageFixture({ id: 'internal-1', createdAt: 1 }).tool, id: 'call_read_1' },
            },
            expanded: true,
        });

        const rows = screen.findAllByType('ToolTimelineRow' as React.ElementType);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.props.messageId).toBe('server:server-msg-1');
    });

    it('passes a pin action to direct grouped feed rows when row identity facts are available', async () => {
        const onToggleToolPin = vi.fn();
        const screen = await renderToolRow({
            message: {
                ...createToolCallMessageFixture({ id: 'internal-1', createdAt: 1 }),
                realID: 'server-msg-1',
                seq: 11,
                transcriptBlockIndex: 3,
                tool: { ...createToolCallMessageFixture({ id: 'internal-1', createdAt: 1 }).tool, id: 'call_read_1' },
            },
            expanded: false,
            onToggleToolPin,
        });

        const rows = screen.findAllByType('ToolTimelineRow' as React.ElementType);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.props.headerAction).toBeTruthy();
    });

    it('does not reserve a grouped feed header action slot when tool pin identity facts are unavailable', async () => {
        const onToggleToolPin = vi.fn();
        const screen = await renderToolRow({
            message: {
                ...createToolCallMessageFixture({ id: 'internal-1', createdAt: 1 }),
                seq: undefined,
                transcriptBlockIndex: undefined,
                tool: { ...createToolCallMessageFixture({ id: 'internal-1', createdAt: 1 }).tool, id: 'call_read_1' },
            },
            expanded: false,
            onToggleToolPin,
        });

        const rows = screen.findAllByType('ToolTimelineRow' as React.ElementType);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.props.headerAction).toBeNull();
    });

    it('maps pending-permission running tools to canceled failures for inactive sessions', async () => {
        const screen = await renderToolRow({
            message: createToolCallMessageFixture({
                id: 'm1',
                createdAt: 1,
                tool: {
                    id: 'pending-tool-1',
                    name: 'AskUserQuestion',
                    state: 'running',
                    input: {},
                    createdAt: 1,
                    startedAt: 1,
                    completedAt: null,
                    description: null,
                    permission: { id: 'p1', status: 'pending' },
                },
            }),
            expanded: false,
            interaction: {
                canSendMessages: false,
                canApprovePermissions: false,
                permissionDisabledReason: 'inactive',
            },
        });

        const rows = screen.findAllByType('ToolTimelineRow' as React.ElementType);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.props.tool?.state).toBe('error');
        expect(rows[0]?.props.tool?.permission?.status).toBe('canceled');
    });

    it('renders position-invariant middle chrome regardless of expansion state', async () => {
        for (const expanded of [false, true]) {
            const screen = await renderToolRow({
                message: createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
                expanded,
                ...createTranscriptSessionCommonPropsFixture({
                    toolChromeCommon: { toolViewTimelineChromeMode: 'cards' },
                }),
            });

            const container = screen.findByTestId('transcript-tool-calls-unit-tool');
            const style = flattenStyleProp(container?.props.style);
            expect(style.marginHorizontal).toBe(16);
            expect(style.borderTopLeftRadius).toBeUndefined();
            expect(style.borderBottomLeftRadius).toBeUndefined();
            expect(style.backgroundColor).toBeTruthy();
            expect(style.marginBottom).toBeUndefined();

            const gutterLine = screen.findByTestId('transcript-tool-calls-unit-gutter-line');
            expect(gutterLine).not.toBeNull();
            expect(flattenStyleProp(gutterLine?.props.style).marginBottom).toBeUndefined();
        }
    });

    it('stacks consecutive cards tool rows tightly with no extra inter-row spacing', async () => {
        // Each grouped tool already renders its own ToolView card (with intrinsic
        // vertical margin) against the uniform unit-card background, so the row must
        // not add a second gap between consecutive tools — they read as one list.
        for (const expanded of [false, true]) {
            const screen = await renderToolRow({
                message: createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
                expanded,
                ...createTranscriptSessionCommonPropsFixture({
                    toolChromeCommon: { toolViewTimelineChromeMode: 'cards' },
                }),
            });

            const toolRow = screen.findByTestId('transcript-tool-calls-tool-row');
            const style = flattenStyleProp(toolRow?.props.style);
            expect(style.paddingBottom ?? 0).toBe(0);
            expect(style.marginBottom ?? 0).toBe(0);
        }
    });
});
