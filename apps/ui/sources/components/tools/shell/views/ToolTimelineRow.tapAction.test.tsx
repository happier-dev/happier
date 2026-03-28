import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findTestInstanceByTypeWithProps, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installToolShellCommonModuleMocks } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ensureSidechainMessagesLoadedMock = vi.fn(async () => 'loaded');
const pushSpy = vi.fn();

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: ensureSidechainMessagesLoadedMock,
    },
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

vi.mock('@/components/tools/shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement('ToolSectionView', null, children),
}));

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

describe('ToolTimelineRow (tap action)', () => {
    beforeEach(() => {
        pushSpy.mockClear();
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

        expect(pushSpy).toHaveBeenCalledTimes(1);
        expect(pushSpy).toHaveBeenCalledWith('/session/s1/message/server%3Aserver-msg-1');
        expect(screen.findAllByType('SpecificToolView' as any)).toHaveLength(0);
    });

    it('suppresses open-details routing when tool navigation is disabled, even if the tool has its own id', async () => {
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

        expect(pushSpy).not.toHaveBeenCalled();
        expect(screen.findAllByType('SpecificToolView' as any)).toHaveLength(1);
    });

    it('auto-expands and shows action-required status for pending user-action tools', async () => {
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
        expect(screen.getTextContent()).toContain('status.actionRequired');
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

        expect(screen.findAllByType('ActivityIndicator' as any).length).toBeGreaterThan(0);
    });
});
