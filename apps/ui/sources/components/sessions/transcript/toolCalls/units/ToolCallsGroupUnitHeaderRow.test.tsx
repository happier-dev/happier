import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createToolCallMessageFixture, renderScreen } from '@/dev/testkit';
import { layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { installToolCallsGroupViewCommonModuleMocks } from '@/components/sessions/transcript/turns/toolCalls/toolCallsGroupViewTestHelpers';
import { createTranscriptSessionCommonPropsFixture, flattenStyleProp } from './toolCallsGroupUnitsTestFixtures';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installToolCallsGroupViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios', select: (values: any) => values?.ios ?? values?.default ?? null },
        });
    },
    icons: async () => {
        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return {
            ...createExpoVectorIconsMock(),
            Ionicons: (props: any) => React.createElement('Ionicons', { ...props, testID: `ionicons:${props.name}` }),
        };
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
// Install native/transport boundaries before collecting the real host graph;
// no case owns a cold graph import or its still-pending React lifetime.
const { ToolCallsGroupUnitHeaderRowWithSessionCommon } = await import('./ToolCallsGroupUnitHeaderRow');
const { ActivitySpinner } = await import('@/components/ui/feedback/ActivitySpinner');

async function renderHeaderRow(props: Record<string, unknown>) {
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

describe('ToolCallsGroupUnitHeaderRow', () => {
    it('keeps a hidden running group quiet while preserving error recovery', async () => {
        const common = createTranscriptSessionCommonPropsFixture();
        const screen = await renderHeaderRow({
            ...common,
            toolChromeCommon: { ...common.toolChromeCommon, showToolCalls: false },
            toolMessages: [createToolCallMessageFixture({ id: 'running' })],
        });
        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(0);
        expect(screen.findByTestId('transcript-tool-calls-header')).not.toBeNull();
        await screen.update(React.createElement(ToolCallsGroupUnitHeaderRowWithSessionCommon, {
            sessionId: 's1', groupId: 'group', metadata: null, interaction, expanded: false, setExpanded: vi.fn(),
            ...common, toolChromeCommon: { ...common.toolChromeCommon, showToolCalls: false },
            toolMessages: [createToolCallMessageFixture({ id: 'running' }),
                createToolCallMessageFixture({ id: 'error', tool: { ...createToolCallMessageFixture().tool, state: 'error' } })],
        }));
        expect(screen.findByTestId('tool-calls-group-status:error')).not.toBeNull();
    });
    it('shows the tool-calls title with count and a completed status icon when all tools completed', async () => {
        const screen = await renderHeaderRow({
            toolMessages: [
                createToolCallMessageFixture({ id: 'm1', createdAt: 1, tool: { state: 'completed' } as any }),
                createToolCallMessageFixture({ id: 'm2', createdAt: 2, tool: { state: 'completed' } as any }),
            ],
        });

        expect(screen.getTextContent()).toContain('session.toolCalls');
        expect(screen.getTextContent()).toContain('2');
        expect(screen.findByTestId('transcript-tool-calls-header')?.props.accessibilityLabel).toContain('2');
        expect(screen.findAllByProps({ name: 'check-circle' }).length).toBeGreaterThan(0);
        // Done is quiet: the group's check is drawn in the ink, never the success green.
        const { lightTheme } = await import('@/theme');
        expect(screen.findAllByProps({ name: 'check-circle' })[0]!.props.color).toBe(lightTheme.colors.text.secondary);
        expect(screen.findAllByProps({ name: 'stack-simple' }).length).toBeGreaterThan(0);
        expect(screen.findByType(DisclosureCaret).props.expanded).toBe(false);
    });

    it('derives a running status spinner when any tool is still running', async () => {
        const screen = await renderHeaderRow({
            toolMessages: [
                createToolCallMessageFixture({ id: 'm1', createdAt: 1, tool: { state: 'completed' } as any }),
                createToolCallMessageFixture({ id: 'm2', createdAt: 2, tool: { state: 'running' } as any }),
            ],
        });

        expect(screen.findAllByType(ActivitySpinner).length).toBeGreaterThan(0);
        expect(screen.findAllByProps({ name: 'check-circle' })).toHaveLength(0);
    });

    it('derives an error status when any tool errored and none are running', async () => {
        const screen = await renderHeaderRow({
            toolMessages: [
                createToolCallMessageFixture({ id: 'm1', createdAt: 1, tool: { state: 'completed' } as any }),
                createToolCallMessageFixture({ id: 'm2', createdAt: 2, tool: { state: 'error' } as any }),
            ],
        });

        expect(screen.findAllByProps({ name: 'warning-circle' }).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).toContain('common.error');
        expect(screen.findByTestId('tool-calls-group-status:error')).toMatchObject({
            props: {
                accessible: true,
                accessibilityLabel: 'common.error',
            },
        });
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

        expect(screen.findByTestId('tool-calls-group-status:error')).toMatchObject({
            props: {
                accessible: true,
                accessibilityLabel: 'common.error',
            },
        });
        expect(screen.findByTestId('tool-calls-group-status:completed')).toBeNull();
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

        expect(screen.findByTestId('tool-calls-group-status:error')).toMatchObject({
            props: {
                accessible: true,
                accessibilityLabel: 'common.error',
            },
        });
        expect(screen.findByTestId('tool-calls-group-status:completed')).toBeNull();
    });

    it('reports a blocked aggregate when any settled tool was denied instead of showing success', async () => {
        const screen = await renderHeaderRow({
            toolMessages: [
                createToolCallMessageFixture({
                    id: 'm0',
                    createdAt: 1,
                    tool: { state: 'completed' } as any,
                }),
                createToolCallMessageFixture({
                    id: 'm1',
                    createdAt: 2,
                    tool: { state: 'error', permission: { id: 'p1', status: 'denied' } } as any,
                }),
            ],
        });

        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(0);
        expect(screen.findAllByProps({ name: 'check-circle' })).toHaveLength(0);
        expect(screen.findAllByProps({ name: 'minus-circle' }).length).toBeGreaterThan(0);
        expect(screen.findByTestId('tool-calls-group-status:permission_denied')).toMatchObject({
            props: {
                accessible: true,
                accessibilityLabel: 'errors.permissionDenied',
            },
        });
        expect(screen.getTextContent()).toContain('errors.permissionDenied');
    });

    it('reports a refused Action call as refused instead of a success check', async () => {
        const text = JSON.stringify({ errorCode: 'unsupported_action', error: 'unsupported_action:session.stop',
            details: { cause: 'target_outside_led_subtree' } });
        const screen = await renderHeaderRow({
            toolMessages: [
                createToolCallMessageFixture({ id: 'm0', createdAt: 1, tool: { state: 'completed' } as any }),
                createToolCallMessageFixture({
                    id: 'm1',
                    createdAt: 2,
                    tool: { name: 'mcp__happier__action_execute', state: 'completed', input: { actionId: 'session.stop', input: {} },
                        result: { content: [{ type: 'text', text }], text } } as any,
                }),
            ],
        });

        expect(screen.findAllByProps({ name: 'check-circle' })).toHaveLength(0);
        expect(screen.findAllByProps({ name: 'minus-circle' }).length).toBeGreaterThan(0);
        expect(screen.findByTestId('tool-calls-group-status:refused')).toMatchObject({
            props: { accessible: true, accessibilityLabel: 'toolView.actionOutcome.refused' },
        });
    });

    const actionToolMessage = (id: string, createdAt: number, outcome: unknown) => {
        const text = JSON.stringify(outcome);
        return createToolCallMessageFixture({
            id, createdAt,
            tool: { name: 'mcp__happier__action_execute', state: 'completed', input: { actionId: 'session.stop', input: {} },
                result: { content: [{ type: 'text', text }], text } } as any,
        });
    };

    it.each([
        ['approval_rejected', 'approvals.status.rejected'],
        ['approval_canceled', 'approvals.status.canceled'],
    ])('uses the decision label for a %s group and a mixed summary', async (code, label) => {
        for (const mixed of [false, true]) {
            const screen = await renderHeaderRow({ toolMessages: [
                actionToolMessage('decision', 1, { errorCode: code, error: code }),
                ...(mixed ? [actionToolMessage('failure', 2, { errorCode: 'target_unavailable', error: 'target_unavailable' })] : []),
            ] });
            const status = screen.findByTestId(`tool-calls-group-status:${mixed ? 'error' : 'refused'}`);
            expect(status?.props.accessibilityLabel).toContain(label);
            expect(status?.props.accessibilityLabel).not.toContain('toolView.actionOutcome.refused');
        }
    });

    it('says a failed Action call failed in the header, in the word its row uses', async () => {
        const screen = await renderHeaderRow({
            toolMessages: [actionToolMessage('m1', 1, { errorCode: 'target_unavailable', error: 'target_unavailable' })],
        });

        expect(screen.findByTestId('tool-calls-group-status:error')).toMatchObject({
            props: { accessible: true, accessibilityLabel: 'toolView.actionOutcome.failed' },
        });
        expect(screen.findAllByProps({ name: 'check-circle' })).toHaveLength(0);
    });

    it('reads both outcomes of a group that failed and was refused, never a success check', async () => {
        const screen = await renderHeaderRow({
            toolMessages: [
                actionToolMessage('m1', 1, { errorCode: 'unsupported_action', error: 'unsupported_action:session.stop' }),
                actionToolMessage('m2', 2, { errorCode: 'target_unavailable', error: 'target_unavailable' }),
            ],
        });

        expect(screen.findByTestId('tool-calls-group-status:error')?.props.accessibilityLabel)
            .toBe('toolView.actionOutcome.mixed(failed=1,refused=1)');
        expect(screen.findAllByProps({ name: 'check-circle' })).toHaveLength(0);
        expect(screen.findAllByProps({ name: 'warning-circle' }).length).toBeGreaterThan(0);
    });

    it('reports inactive pending permissions as blocked instead of successful', async () => {
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

        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(0);
        expect(screen.findAllByProps({ name: 'check-circle' })).toHaveLength(0);
        expect(screen.findAllByProps({ name: 'minus-circle' }).length).toBeGreaterThan(0);
        expect(screen.findByTestId('tool-calls-group-status:permission_canceled')).toMatchObject({
            props: {
                accessibilityLabel: 'errors.permissionCanceled',
            },
        });
    });

    it('expands via the collapsed header and collapses via the expanded header', async () => {
        const setExpanded = vi.fn();
        const collapsed = await renderHeaderRow({
            toolMessages: [createToolCallMessageFixture({ id: 'm1', createdAt: 1 })],
            expanded: false,
            setExpanded,
        });

        expect(collapsed.findByTestId('transcript-tool-calls-header')?.props.accessibilityState).toMatchObject({ expanded: false });
        await collapsed.pressByTestIdAsync('transcript-tool-calls-header');
        expect(setExpanded).toHaveBeenCalledWith(true);

        const expanded = await renderHeaderRow({
            toolMessages: [createToolCallMessageFixture({ id: 'm1', createdAt: 1 })],
            expanded: true,
            setExpanded,
        });

        expect(expanded.findByType(DisclosureCaret).props.expanded).toBe(true);
        await expanded.pressByTestIdAsync('transcript-tool-calls-header');
        expect(setExpanded).toHaveBeenCalledWith(false);
    });

    it('renders a cards top cap: background, top radii, no bottom radii, shared horizontal margin', async () => {
        const { lightTheme } = await import('@/theme');
        const screen = await renderHeaderRow({
            toolMessages: [createToolCallMessageFixture({ id: 'm1', createdAt: 1 })],
            ...createTranscriptSessionCommonPropsFixture({
                toolChromeCommon: { toolViewTimelineChromeMode: 'cards' },
            }),
        });

        const container = screen.findByTestId('transcript-tool-calls-unit-header') as any;
        const style = flattenStyleProp(container?.props.style);
        expect(style.marginHorizontal).toBe(16);
        expect(style.borderTopLeftRadius).toBe(lightTheme.borderRadius.xl);
        expect(style.borderTopRightRadius).toBe(lightTheme.borderRadius.xl);
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
        const { lightTheme } = await import('@/theme');
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
        expect(style.borderTopLeftRadius).toBe(lightTheme.borderRadius.xl);
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

    // The header follows a message's action row, whose buttons overhang their band into the card's inset; the
    // header's hit area must not reach up into them (it keeps its full reach below, where nothing contends).
    it('keeps the header hit area off the message-action row above it', async () => {
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const screen = await renderScreen(React.createElement(HappierUiPlatformProvider, { platform: { platform: 'ios', colorScheme: 'light' } },
            React.createElement(ToolCallsGroupUnitHeaderRowWithSessionCommon, {
                sessionId: 's1', groupId: 'toolCalls:t1:m1', metadata: null, interaction, expanded: false, setExpanded: vi.fn(),
                ...createTranscriptSessionCommonPropsFixture(),
                toolMessages: [createToolCallMessageFixture({ id: 'm1', createdAt: 1 })],
            } as any)));
        const area = await layoutHitArea(() => screen.findByTestId('transcript-tool-calls-header'), { width: 338, height: 28 });
        expect(area.insets.top).toBeLessThanOrEqual(1.5);
        expect(area.insets.bottom).toBe(8);
    });

    it('renders nothing for an empty group', async () => {
        const screen = await renderHeaderRow({ toolMessages: [] });
        expect(screen.findByTestId('transcript-tool-calls-header')).toBeNull();
    });
});
