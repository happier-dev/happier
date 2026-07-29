import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, findTestInstanceByTypeWithProps, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installToolShellCommonModuleMocks } from './ToolView.testHelpers';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ensureSidechainMessagesLoadedMock = vi.fn(async () => 'loaded');
const pushSpy = vi.fn();
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));

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
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({ fallback: (key) => settings[key] }),
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
    const tool = {
        name: 'read',
        state: 'completed',
        input: {},
        createdAt: 1,
        startedAt: 1,
        completedAt: 2,
        description: null,
        result: {},
        ...(overrides.tool as Record<string, unknown> | undefined),
    } as any;

    return renderScreen(
        <ToolTimelineRow
            tool={tool}
            metadata={null}
            {...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'tool'))}
        />,
    );
}

function findHeaderTitleFontSize(screen: Awaited<ReturnType<typeof renderToolTimelineRow>>) {
    const titleText = findTestInstanceByTypeWithProps(screen, 'Text' as any, { numberOfLines: 1 });
    expect(titleText).toBeTruthy();
    const style = titleText!.props?.style;
    const styleArray = Array.isArray(style) ? style : [style];
    const merged = Object.assign({}, ...styleArray.filter(Boolean));
    return merged.fontSize;
}

function findSpinner(screen: Awaited<ReturnType<typeof renderToolTimelineRow>>) {
    return screen.findAll((node) => {
        const nodeType = node.type as unknown;
        return nodeType === 'ActivityIndicator' || node.props?.accessibilityRole === 'progressbar';
    })[0];
}

function readSpinnerColor(spinner: ReturnType<typeof findSpinner>) {
    const style = spinner?.props?.style;
    const styleArray = Array.isArray(style) ? style : [style];
    const mergedStyle = Object.assign({}, ...styleArray.filter(Boolean));
    return spinner?.props?.color ?? mergedStyle.borderColor;
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
        expect(screen.findAllByType('SpecificToolView' as any)).toHaveLength(0);

        await act(async () => {
            screen.pressByTestId('tool-timeline-row');
        });

        expect(screen.findByTestId('tool-timeline-body')).not.toBeNull();
        expect(screen.findAllByType('SpecificToolView' as any)).toHaveLength(1);
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
        expect(screen.findAllByType('SpecificToolView' as any)).toHaveLength(0);
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
        expect(screen.findAllByType('SpecificToolView' as any)).toHaveLength(1);
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
        expect(screen.findAllByType('SpecificToolView' as any)).toHaveLength(1);
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

    it('shows sidechain loading only while an expanded Task transcript request is in flight', async () => {
        const request = createDeferred<'loaded' | 'not_ready' | 'in_flight'>();
        ensureSidechainMessagesLoadedMock.mockReturnValueOnce(request.promise);

        const screen = await renderToolTimelineRow({
            tool: {
                id: 'tool_task_1',
                name: 'Task',
            },
            sessionId: 's1',
            messageId: 'm1',
            messages: [],
        });

        await act(async () => {
            screen.pressByTestId('tool-timeline-row');
        });
        await flushHookEffects();

        expect(screen.findByTestId('tool-sidechain-loading')).not.toBeNull();

        await act(async () => {
            request.resolve('loaded');
            await request.promise;
        });
        await flushHookEffects();

        expect(screen.findByTestId('tool-sidechain-loading')).toBeNull();
    });

    it('surfaces an unavailable affordance (not a perpetual spinner) when expanded sidechain hydration fails terminally', async () => {
        const previousMaxRetries = process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_MAX_RETRIES;
        process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_MAX_RETRIES = '0';
        try {
            ensureSidechainMessagesLoadedMock.mockResolvedValue('not_ready');

            const screen = await renderToolTimelineRow({
                tool: {
                    id: 'tool_task_1',
                    name: 'Task',
                },
                sessionId: 's1',
                messageId: 'm1',
                messages: [],
            });

            await act(async () => {
                screen.pressByTestId('tool-timeline-row');
            });
            await flushHookEffects();

            const statusNode = screen.findByTestId('tool-sidechain-loading');
            expect(statusNode).not.toBeNull();
            expect(screen.getTextContent()).toContain('common.unavailable');
            expect(statusNode?.findAllByProps({ accessibilityRole: 'progressbar' })).toHaveLength(0);
        } finally {
            if (previousMaxRetries === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_MAX_RETRIES;
            } else {
                process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_MAX_RETRIES = previousMaxRetries;
            }
        }
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

        expect(findSpinner(screen)).toBeTruthy();
    });

    it('uses the neutral loading color in the header for running Task tools', async () => {
        const screen = await renderToolTimelineRow({
            tool: {
                name: 'Task',
                state: 'running',
                completedAt: null,
                result: null,
            },
            sessionId: 's1',
            messageId: 'm1',
        });

        const spinner = findSpinner(screen);
        expect(readSpinnerColor(spinner)).toBe('#555555');
    });
});
