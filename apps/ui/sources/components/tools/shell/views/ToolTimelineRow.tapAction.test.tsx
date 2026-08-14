import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findTestInstanceByTypeWithProps, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installToolShellCommonModuleMocks } from './ToolView.testHelpers';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ensureSidechainMessagesLoadedMock = vi.fn(async () => 'loaded');
const pushSpy = vi.fn();
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: ensureSidechainMessagesLoadedMock,
    },
}));

vi.mock('@/utils/platform/navigateWithBlurOnWeb', () => ({
    navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
}));

installToolShellCommonModuleMocks({
    expoRouter: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: pushSpy,
                back: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => settings[key],
            },
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
});

vi.mock('@/components/ui/text/Text', async () => {
    return {
        Text: (props: any) => React.createElement('Text', props, props.children),
        TextInput: (props: any) => React.createElement('TextInput', props),
        TextSelectabilityScope: (props: any) => React.createElement('TextSelectabilityScope', props, props.children),
    };
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: (name: string) => name,
    formatMCPSubtitle: () => null,
}));

const specificToolViewMock = vi.fn((props: any) => React.createElement('SpecificToolView', props));
vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => specificToolViewMock,
}));

vi.mock('@/components/tools/shell/presentation/ToolSectionView', async (importOriginal) => {
    const { installToolSectionViewModuleMock } = await import('@/dev/testkit/mocks/toolSectionView');
    return installToolSectionViewModuleMock('host')(importOriginal);
});

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: (props: any) => React.createElement('CodeView', props),
}));

vi.mock('@/components/tools/shell/presentation/ToolHeaderActionsContext', () => ({
    ToolHeaderActionsContext: { Provider: ({ children }: any) => children },
}));

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: () => React.createElement('StructuredResultView'),
}));

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('@/components/tools/shell/presentation/ToolError', () => ({
    ToolError: () => React.createElement('ToolError'),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    DEFAULT_AGENT_ID: 'claude',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

let settings: Record<string, unknown> = {};

async function renderToolTimelineRow(overrides: Record<string, unknown> = {}) {
    const { ToolTimelineRow } = await import('./ToolTimelineRow');
    const tool: ToolCall = {
        name: 'read',
        state: 'completed',
        input: {},
        createdAt: 1,
        startedAt: 1,
        completedAt: 2,
        description: null,
        result: {},
        ...(overrides.tool as Record<string, unknown> | undefined),
    };

    return renderScreen(
        <ToolTimelineRow
            tool={tool}
            metadata={null}
            {...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'tool'))}
        />,
    );
}

function findHeaderTitleFontSize(screen: Awaited<ReturnType<typeof renderToolTimelineRow>>) {
    const titleText = findTestInstanceByTypeWithProps(screen, 'Text' as React.ElementType, { numberOfLines: 1 });
    expect(titleText).toBeTruthy();
    const style = titleText!.props?.style;
    const styleArray = Array.isArray(style) ? style : [style];
    const merged = Object.assign({}, ...styleArray.filter(Boolean));
    return merged.fontSize;
}

describe('ToolTimelineRow (tap action)', () => {
    beforeEach(() => {
        pushSpy.mockClear();
        navigateWithBlurOnWebSpy.mockClear();
        specificToolViewMock.mockClear();
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');
        settings = {
            toolViewDetailLevelDefault: 'title',
            toolViewDetailLevelDefaultLocalControl: 'summary',
            toolViewDetailLevelByToolName: {},
            toolViewExpandedDetailLevelDefault: 'summary',
            toolViewExpandedDetailLevelByToolName: {},
            toolViewTimelineFeedDefaultExpanded: false,
            toolViewTapAction: 'expand',
        };
    });

    afterEach(() => {
        standardCleanup();
    });

    it('toggles expand when tap action is expand', async () => {
        const screen = await renderToolTimelineRow({
            sessionId: 's1',
            messageId: 'm1',
        });

        expect(screen.findByTestId('tool-timeline-body')).toBeNull();
        expect(screen.findAllByType('SpecificToolView' as React.ElementType)).toHaveLength(0);

        await act(async () => {
            screen.pressByTestId('tool-timeline-row');
        });

        expect(screen.findByTestId('tool-timeline-body')).not.toBeNull();
        expect(screen.findAllByType('SpecificToolView' as React.ElementType)).toHaveLength(1);
    });

    it('keeps the header density stable when toggling expand', async () => {
        const screen = await renderToolTimelineRow({
            sessionId: 's1',
            messageId: 'm1',
        });

        const beforeFontSize = findHeaderTitleFontSize(screen);

        await act(async () => {
            screen.pressByTestId('tool-timeline-row');
        });

        expect(findHeaderTitleFontSize(screen)).toBe(beforeFontSize);
    });

    it('prefers a stable server route when tap action is open and the message is already persisted', async () => {
        settings.toolViewTapAction = 'open';

        const screen = await renderToolTimelineRow({
            tool: {
                id: 'call_read_1',
            },
            sessionId: 's1',
            messageId: 'server:server-msg-1',
        });

        await act(async () => {
            screen.pressByTestId('tool-timeline-row');
        });

        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(pushSpy).toHaveBeenCalledTimes(1);
        expect(pushSpy).toHaveBeenCalledWith('/session/s1/message/server%3Aserver-msg-1');
        expect(screen.findAllByType('SpecificToolView' as React.ElementType)).toHaveLength(0);
    });

    it('expands without routing or hydrating the sidechain when tool navigation is disabled', async () => {
        settings.toolViewTapAction = 'open';

        const screen = await renderToolTimelineRow({
            tool: {
                id: 'subagent_run_1',
                name: 'SubAgentRun',
            },
            sessionId: 's1',
            interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
        });

        expect(screen.getTextContent()).not.toContain('toolView.open');

        await act(async () => {
            screen.pressByTestId('tool-timeline-row');
        });
        await flushHookEffects();

        expect(pushSpy).not.toHaveBeenCalled();
        expect(screen.findAllByType('SpecificToolView' as React.ElementType)).toHaveLength(1);
        expect(ensureSidechainMessagesLoadedMock).not.toHaveBeenCalled();
    });

    it('auto-expands and shows waiting-for-response status for pending questions', async () => {
        const screen = await renderToolTimelineRow({
            tool: {
                name: 'AskUserQuestion',
                state: 'running',
                completedAt: null,
                permission: {
                    id: 'perm-1',
                    status: 'pending',
                    kind: 'user_action',
                },
            },
            sessionId: 's1',
            messageId: 'm1',
        });

        expect(screen.findByTestId('tool-timeline-body')).not.toBeNull();
        expect(screen.findAllByType('SpecificToolView' as React.ElementType)).toHaveLength(1);
        expect(screen.getTextContent()).toContain('status.waitingForYourResponse');
        expect(screen.getTextContent()).not.toContain('status.actionRequired');
    });

    it('keeps action-required status for pending non-question user actions', async () => {
        const screen = await renderToolTimelineRow({
            tool: {
                name: 'ExitPlanMode',
                state: 'running',
                completedAt: null,
                permission: {
                    id: 'perm-plan-1',
                    status: 'pending',
                    kind: 'user_action',
                },
            },
            sessionId: 's1',
            messageId: 'm-plan-1',
        });

        expect(screen.getTextContent()).toContain('status.actionRequired');
        expect(screen.getTextContent()).not.toContain('status.waitingForYourResponse');
    });

    it('shows a header error indicator only for failed tool rows', async () => {
        const failedScreen = await renderToolTimelineRow({
            tool: {
                name: 'SearchContent',
                state: 'error',
                result: {
                    content: 'ripgrep timed out',
                },
            },
        });

        expect(failedScreen.findByTestId('tool-timeline-row-error')).not.toBeNull();

        standardCleanup();

        const completedScreen = await renderToolTimelineRow({
            tool: {
                name: 'SearchContent',
                state: 'completed',
                result: {
                    content: 'ok',
                },
            },
        });

        expect(completedScreen.findByTestId('tool-timeline-row-error')).toBeNull();
    });

    it('reveals a parent-supplied pin alongside status indicators', async () => {
        const screen = await renderToolTimelineRow({
            tool: {
                name: 'SearchContent',
                state: 'error',
                result: {
                    content: 'ripgrep timed out',
                },
            },
            headerAction: { node: React.createElement('Pressable', { testID: 'tool-parent-pin-action' }), pinned: false },
        });

        expect(screen.findByTestId('tool-parent-pin-action')).toBeTruthy();
        expect(screen.findByTestId('tool-timeline-row-error')).toBeTruthy();
    });

    it('shows a header error indicator when tool_use_result is an error string even if the tool state is completed', async () => {
        const screen = await renderToolTimelineRow({
            tool: {
                name: 'SearchContent',
                state: 'completed',
                result: {
                    tool_use_result: 'Error: Ripgrep search timed out after 20 seconds.',
                },
            },
        });

        expect(screen.findByTestId('tool-timeline-row-error')).not.toBeNull();
    });

    it.each([
        {
            label: 'the top-level Happier tools envelope failed',
            result: {
                content: [{
                    type: 'text',
                    text: '{"v":1,"ok":false,"kind":"tools_call","error":{"code":"invalid_parameters","message":"invalid_parameters"}}\n\n\nCommand exited with code 1',
                }],
                details: {},
            },
        },
        {
            label: 'a delegate target inside the successful Happier tools envelope failed',
            result: {
                content: [{
                    type: 'text',
                    text: '{"v":1,"ok":true,"kind":"tools_call","data":{"source":"happier","tool":"subagents_delegate_start","isError":false,"output":{"intent":"delegate","sessionId":"cmst8oicm00xztmweb5hjqql6","results":[{"key":"agent:claude","ok":false,"error":"invalid_parameters","errorCode":"invalid_parameters"}]}}}\n',
                }],
                details: null,
            },
        },
    ])('shows a header error indicator when a completed tool result reports that $label', async ({ result }) => {
        const screen = await renderToolTimelineRow({
            tool: {
                name: 'Bash',
                state: 'completed',
                result,
            },
        });

        expect(screen.findByTestId('tool-timeline-row-error')).not.toBeNull();
    });

    it('keeps a completed aggregate result successful when every delegate target succeeded', async () => {
        const screen = await renderToolTimelineRow({
            tool: {
                name: 'Bash',
                state: 'completed',
                result: {
                    content: [{
                        type: 'text',
                        text: '{"v":1,"ok":true,"kind":"tools_call","data":{"source":"happier","tool":"subagents_delegate_start","isError":false,"output":{"intent":"delegate","sessionId":"session-1","results":[{"key":"agent:claude","ok":true}]}}}\n',
                    }],
                    details: null,
                },
            },
        });

        expect(screen.findByTestId('tool-timeline-row-error')).toBeNull();
    });

    it('does not treat unrelated JSON written by a successful tool as a tool-call failure envelope', async () => {
        const screen = await renderToolTimelineRow({
            tool: {
                name: 'Bash',
                state: 'completed',
                result: {
                    content: [{ type: 'text', text: '{"ok":false,"reason":"domain payload"}\n' }],
                    details: null,
                },
            },
        });

        expect(screen.findByTestId('tool-timeline-row-error')).toBeNull();
    });

    it('shows an error for an unavailable tool whose stdout contains a failed Happier tools envelope', async () => {
        const screen = await renderToolTimelineRow({
            tool: {
                name: 'subagents.delegate.start',
                state: 'unavailable',
                result: {
                    stdout: '{"v":1,"ok":false,"kind":"tools_call","error":{"code":"unknown_tool","message":"Unknown built-in Happier tool: subagents.delegate.start"}}\n',
                },
            },
        });

        expect(screen.findByTestId('tool-timeline-row-error')).not.toBeNull();

        standardCleanup();

        const neutralScreen = await renderToolTimelineRow({
            tool: {
                name: 'UnknownTool',
                state: 'unavailable',
                result: { stdout: '{"ok":false,"reason":"domain payload"}\n' },
            },
        });

        expect(neutralScreen.findByTestId('tool-timeline-row-error')).toBeNull();
    });

    it('shows only the error icon in the activity-row header and leaves the error text out of the line', async () => {
        const screen = await renderToolTimelineRow({
            tool: {
                name: 'CodexBash',
                state: 'error',
                input: {
                    command: 'python -m pytest v2/tests/ -q --tb=line --deselect v2/tests/web/test_rate_limiter.py',
                },
                description: 'Terminal(cmd: python -m pytest v2/tests/ -q --tb=line --deselect v2/tests/web/test_rate_limiter.py)',
                result: {
                    error: {
                        message: 'Request timed out',
                    },
                },
            },
        });

        const errorIcon = screen.findByTestId('tool-timeline-row-error');
        expect(errorIcon).toBeTruthy();
        if (!errorIcon) {
            throw new Error('Expected tool timeline row error indicator');
        }
        expect(screen.getTextContent()).not.toContain('Request timed out');
    });

    it('preloads sidechain messages when a Task tool is expanded', async () => {
        const screen = await renderToolTimelineRow({
            tool: {
                id: 'tool_task_1',
                name: 'Task',
            },
            sessionId: 's1',
            messageId: 'm1',
        });

        expect(ensureSidechainMessagesLoadedMock).not.toHaveBeenCalled();

        await act(async () => {
            screen.pressByTestId('tool-timeline-row');
        });
        await flushHookEffects();

        expect(ensureSidechainMessagesLoadedMock).toHaveBeenCalledWith('s1', 'tool_task_1');
    });

    it('shows a sidechain loading affordance while an expanded Task sidechain is in flight', async () => {
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('in_flight');

        const screen = await renderToolTimelineRow({
            tool: {
                id: 'tool_task_1',
                name: 'Task',
            },
            sessionId: 's1',
            messageId: 'm1',
        });

        await act(async () => {
            screen.pressByTestId('tool-timeline-row');
        });
        await flushHookEffects();

        expect(screen.findByTestId('tool-timeline-sidechain-hydration-status')).not.toBeNull();
    });

    it('shows a running indicator in the header for Task tools', async () => {
        const screen = await renderToolTimelineRow({
            tool: {
                name: 'Task',
                state: 'running',
                input: { description: 'Do stuff' },
                completedAt: null,
                result: null,
            },
            sessionId: 's1',
            messageId: 'm1',
        });

        expect(screen.findByTestId('tool-timeline-row-running')).toBeTruthy();
    });

    it('uses the neutral loading color in the header for running Task tools', async () => {
        const screen = await renderToolTimelineRow({
            tool: {
                name: 'Task',
                state: 'running',
                input: { description: 'Do stuff' },
                completedAt: null,
                result: null,
            },
            sessionId: 's1',
            messageId: 'm1',
        });

        const spinner = screen.findByTestId('tool-timeline-row-running');
        const spinnerStyle = flattenStyle(spinner?.props?.style);
        expect(spinner?.props?.color ?? spinnerStyle.borderColor).toBe('#555555');
    });
});
