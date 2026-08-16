import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createToolCallMessageFixture, renderScreen } from '@/dev/testkit';
import { installToolCallsGroupViewCommonModuleMocks } from '@/components/sessions/transcript/turns/toolCalls/toolCallsGroupViewTestHelpers';
import { createTranscriptSessionCommonPropsFixture, flattenStyleProp } from './toolCallsGroupUnitsTestFixtures';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Stamps a per-glyph testID so these assertions can name the glyph they expect, exactly as the
// retired `@expo/vector-icons` mock did. The global setup mock renders `Icon` as a bare host
// element, which carries props but no addressable id.
vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: any) => React.createElement('Icon', { ...props, testID: `icon:${props.name}` }),
    ICON_SIZE: { xs: 14, sm: 16, md: 20, lg: 24, xl: 29 },
}));

installToolCallsGroupViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios', select: (values: any) => values?.ios ?? values?.default ?? null },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
});

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: (props: any) => React.createElement('TranscriptEnterWrapper', props, props.children),
}));

const interaction = { canSendMessages: true, canApprovePermissions: true } as const;

async function renderHeaderRow(props: Record<string, unknown>) {
    const { ToolCallsGroupUnitHeaderRowWithSessionCommon } = await import('./ToolCallsGroupUnitHeaderRow');
    return renderScreen(React.createElement(ToolCallsGroupUnitHeaderRowWithSessionCommon, {
        sessionId: 's1',
        groupId: 'toolCalls:t1:m1',
        metadata: null,
        interaction,
        expanded: false,
        setExpanded: vi.fn(),
        ...createTranscriptSessionCommonPropsFixture(),
        ...props,
    } as any));
}

// The group cap's corner radius is the shared card token, not a number chosen here. Asserting the
// literal made a design-system change look like a regression; asserting the token keeps the real
// contract — top corners capped, bottom corners open — while letting the scale move.
const GROUP_CAP_RADIUS_PX = 12; // theme.borderRadius.xl

describe('ToolCallsGroupUnitHeaderRow', () => {
    it('shows the tool-calls title with count and a completed status icon when all tools completed', async () => {
        const screen = await renderHeaderRow({
            toolMessages: [
                createToolCallMessageFixture({ id: 'm1', createdAt: 1, tool: { state: 'completed' } as any }),
                createToolCallMessageFixture({ id: 'm2', createdAt: 2, tool: { state: 'completed' } as any }),
            ],
        });

        expect(screen.getTextContent()).toContain('session.toolCalls');
        expect(screen.getTextContent()).toContain('2');
        expect(screen.findByTestId('icon:check-circle')).not.toBeNull();
        expect(screen.findByTestId('icon:stack-simple')).not.toBeNull();
        expect(screen.findByTestId('icon:caret-up')).toBeNull();
    });

    it('derives a running status spinner when any tool is still running', async () => {
        const screen = await renderHeaderRow({
            toolMessages: [
                createToolCallMessageFixture({ id: 'm1', createdAt: 1, tool: { state: 'completed' } as any }),
                createToolCallMessageFixture({ id: 'm2', createdAt: 2, tool: { state: 'running' } as any }),
            ],
        });

        expect(screen.findAllByType('ActivityIndicator' as any).length).toBeGreaterThan(0);
        expect(screen.findByTestId('icon:check-circle')).toBeNull();
    });

    it('derives an error status when any tool errored and none are running', async () => {
        const screen = await renderHeaderRow({
            toolMessages: [
                createToolCallMessageFixture({ id: 'm1', createdAt: 1, tool: { state: 'completed' } as any }),
                createToolCallMessageFixture({ id: 'm2', createdAt: 2, tool: { state: 'error' } as any }),
            ],
        });

        expect(screen.findByTestId('icon:warning-circle')).not.toBeNull();
    });

    it('renders a failed aggregate when a completed delegate tool has a failed target result', async () => {
        const screen = await renderHeaderRow({
            toolMessages: [
                createToolCallMessageFixture({
                    id: 'm1',
                    createdAt: 1,
                    tool: {
                        name: 'Bash',
                        state: 'completed',
                        result: {
                            content: [{
                                type: 'text',
                                text: '{"v":1,"ok":true,"kind":"tools_call","data":{"source":"happier","tool":"subagents_delegate_start","isError":false,"output":{"intent":"delegate","sessionId":"cmst8oicm00xztmweb5hjqql6","results":[{"key":"agent:claude","ok":false,"error":"invalid_parameters","errorCode":"invalid_parameters"}]}}}\n',
                            }],
                            details: null,
                        },
                    } as any,
                }),
            ],
        });

        expect(screen.findByTestId('icon:warning-circle')).not.toBeNull();
        expect(screen.findByTestId('icon:check-circle')).toBeNull();
    });

    it('renders a failed aggregate for an unavailable tool with a failed Happier envelope in stdout', async () => {
        const screen = await renderHeaderRow({
            toolMessages: [
                createToolCallMessageFixture({
                    id: 'm1',
                    createdAt: 1,
                    tool: {
                        name: 'subagents.delegate.start',
                        state: 'unavailable',
                        result: {
                            stdout: '{"v":1,"ok":false,"kind":"tools_call","error":{"code":"unknown_tool","message":"Unknown built-in Happier tool: subagents.delegate.start"}}\n',
                        },
                    } as any,
                }),
            ],
        });

        expect(screen.findByTestId('icon:warning-circle')).not.toBeNull();
        expect(screen.findByTestId('icon:check-circle')).toBeNull();
    });

    it('stops reporting running for pending-permission tools in inactive sessions, like the grouped row', async () => {
        const screen = await renderHeaderRow({
            interaction: {
                canSendMessages: false,
                canApprovePermissions: false,
                permissionDisabledReason: 'inactive',
            },
            toolMessages: [
                createToolCallMessageFixture({
                    id: 'm1',
                    createdAt: 1,
                    tool: { state: 'running', permission: { id: 'p1', status: 'pending' } } as any,
                }),
            ],
        });

        // resolveInactiveSessionToolCallFailure cancels the pending permission, and the
        // canceled permission resolves to 'permission_blocked' — not running, not error —
        // exactly as ToolCallsGroupRow derives the grouped status today.
        expect(screen.findAllByType('ActivityIndicator' as any)).toHaveLength(0);
        expect(screen.findByTestId('icon:check-circle')).not.toBeNull();
    });

    it('keeps the header non-pressable while collapsed and collapses via setExpanded(false) when expanded', async () => {
        const setExpanded = vi.fn();
        const collapsed = await renderHeaderRow({
            toolMessages: [createToolCallMessageFixture({ id: 'm1', createdAt: 1 })],
            expanded: false,
            setExpanded,
        });

        const collapsedHeader = collapsed.findByTestId('transcript-tool-calls-header') as any;
        expect(collapsedHeader?.props.onPress).toBeUndefined();

        const expanded = await renderHeaderRow({
            toolMessages: [createToolCallMessageFixture({ id: 'm1', createdAt: 1 })],
            expanded: true,
            setExpanded,
        });

        expect(expanded.findByTestId('icon:caret-up')).not.toBeNull();
        await expanded.pressByTestIdAsync('transcript-tool-calls-header');
        expect(setExpanded).toHaveBeenCalledWith(false);
    });

    it('renders a cards top cap: background, top radii, no bottom radii, shared horizontal margin', async () => {
        const screen = await renderHeaderRow({
            toolMessages: [createToolCallMessageFixture({ id: 'm1', createdAt: 1 })],
            ...createTranscriptSessionCommonPropsFixture({
                toolChromeCommon: { toolViewTimelineChromeMode: 'cards' },
            }),
        });

        const container = screen.findByTestId('transcript-tool-calls-unit-header') as any;
        const style = flattenStyleProp(container?.props.style);
        expect(style.marginHorizontal).toBe(16);
        expect(style.borderTopLeftRadius).toBe(GROUP_CAP_RADIUS_PX);
        expect(style.borderTopRightRadius).toBe(GROUP_CAP_RADIUS_PX);
        expect(style.borderBottomLeftRadius).toBeUndefined();
        expect(style.backgroundColor).toBeTruthy();
        expect(style.marginBottom).toBeUndefined();
    });

    it('renders transparent chrome without radii in feed mode', async () => {
        const screen = await renderHeaderRow({
            toolMessages: [createToolCallMessageFixture({ id: 'm1', createdAt: 1 })],
        });

        const container = screen.findByTestId('transcript-tool-calls-unit-header') as any;
        const style = flattenStyleProp(container?.props.style);
        expect(style.marginHorizontal).toBe(16);
        expect(style.borderTopLeftRadius).toBeUndefined();
        expect(style.backgroundColor ?? 'transparent').toBe('transparent');
    });

    it('renders the feed-background top cap with horizontal padding and top vertical padding', async () => {
        const screen = await renderHeaderRow({
            toolMessages: [createToolCallMessageFixture({ id: 'm1', createdAt: 1 })],
            ...createTranscriptSessionCommonPropsFixture({
                toolChromeCommon: { transcriptToolCallsGroupShowBackground: true },
            }),
        });

        const container = screen.findByTestId('transcript-tool-calls-unit-header') as any;
        const style = flattenStyleProp(container?.props.style);
        expect(style.paddingHorizontal).toBe(10);
        expect(style.paddingTop).toBe(6);
        expect(style.paddingBottom).toBeUndefined();
        expect(style.borderTopLeftRadius).toBe(GROUP_CAP_RADIUS_PX);
        expect(style.borderBottomLeftRadius).toBeUndefined();
        expect(style.backgroundColor).toBeTruthy();
    });

    it('keeps the group-level web prepend anchor on the last tool message id', async () => {
        const screen = await renderHeaderRow({
            toolMessages: [
                createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
                createToolCallMessageFixture({ id: 'm2', createdAt: 2 }),
            ],
        });

        expect(screen.findByTestId('transcript-anchor-tool-group-m2')).not.toBeNull();
    });

    it('renders nothing for an empty group', async () => {
        const screen = await renderHeaderRow({ toolMessages: [] });
        expect(screen.findByTestId('transcript-tool-calls-header')).toBeNull();
    });
});
