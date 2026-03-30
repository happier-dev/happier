import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installToolShellCommonModuleMocks, makeToolCall } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ensureSidechainMessagesLoadedMock = vi.fn(async () => 'loaded');

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: ensureSidechainMessagesLoadedMock,
    },
}));

const pushSpy = vi.fn();

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
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'toolViewDetailLevelDefault') return 'title';
                    if (key === 'toolViewDetailLevelDefaultLocalControl') return 'title';
                    if (key === 'toolViewDetailLevelByToolName') return {};
                    if (key === 'toolViewTapAction') return 'expand';
                    if (key === 'toolViewExpandedDetailLevelDefault') return 'summary';
                    if (key === 'toolViewExpandedDetailLevelByToolName') return {};
                    return null;
                },
            },
        });
    },
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    DEFAULT_AGENT_ID: 'claude',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        Read: { title: 'Read' },
    },
}));

const renderedToolViewSpy = vi.fn();

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => (props: any) => {
        renderedToolViewSpy(props);
        return React.createElement('SpecificToolView', null);
    },
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: (t: string) => t,
    formatMCPSubtitle: () => '',
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('../presentation/ToolSectionView', () => ({
    ToolSectionView: () => null,
}));

vi.mock('@/hooks/ui/useElapsedTime', () => ({
    useElapsedTime: () => 0,
}));

afterEach(() => {
    standardCleanup();
});

describe('ToolView (tap action: expand)', () => {
    it('toggles inline expansion even without navigation params', async () => {
        pushSpy.mockReset();
        renderedToolViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');

        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
            result: { file: { content: 'hello' } },
        });

        const screen = await renderScreen(React.createElement(ToolView, { tool, metadata: null }));

        expect(screen.findAllByType('SpecificToolView' as any)).toHaveLength(0);

        await act(async () => {
            screen.pressByTestId('tool-view-header-primary');
        });

        expect(screen.findAllByType('SpecificToolView' as any)).toHaveLength(1);
    });

    it('preloads sidechain messages when expanding Task tools', async () => {
        pushSpy.mockReset();
        renderedToolViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');

        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            id: 'tool_task_1',
            name: 'Task',
            input: { operation: 'run', description: 'Do stuff' },
            result: null,
        });

        const screen = await renderScreen(
            React.createElement(ToolView, { tool, metadata: null, sessionId: 's1', messageId: 'm1' }),
        );

        expect(ensureSidechainMessagesLoadedMock).not.toHaveBeenCalled();

        await act(async () => {
            screen.pressByTestId('tool-view-header-primary');
        });
        await flushHookEffects();

        expect(ensureSidechainMessagesLoadedMock).toHaveBeenCalledWith('s1', 'tool_task_1');
    });

    it('preloads sidechain messages when expanding SubAgentRun tools (prefers result.sidechainId when present)', async () => {
        pushSpy.mockReset();
        renderedToolViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');

        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            id: 'tool_subagent_1',
            name: 'SubAgentRun',
            input: { intent: 'delegate', backendId: 'claude' },
            result: { sidechainId: 'sidechain_run_123' },
        });

        const screen = await renderScreen(
            React.createElement(ToolView, { tool, metadata: null, sessionId: 's1', messageId: 'm1' }),
        );

        expect(ensureSidechainMessagesLoadedMock).not.toHaveBeenCalled();

        await act(async () => {
            screen.pressByTestId('tool-view-header-primary');
        });
        await flushHookEffects();

        expect(ensureSidechainMessagesLoadedMock).toHaveBeenCalledWith('s1', 'sidechain_run_123');
    });

    it('uses hitSlop for the secondary action icon to keep it easy to tap', async () => {
        pushSpy.mockReset();
        renderedToolViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');

        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
            result: { file: { content: 'hello' } },
        });

        const screen = await renderScreen(
            React.createElement(ToolView, { tool, metadata: null, sessionId: 's1', messageId: 'm1' }),
        );

        const secondaryAction = screen.findByTestId('tool-view-header-secondary');
        expect(secondaryAction?.props.hitSlop).toBe(15);
    });

    it('uses the stable server route for the secondary open action when the message is already persisted', async () => {
        pushSpy.mockReset();
        renderedToolViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            id: 'call_read_1',
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
            result: { file: { content: 'hello' } },
        });

        const screen = await renderScreen(
            React.createElement(ToolView, {
                tool,
                metadata: null,
                sessionId: 's1',
                messageId: 'server:server-msg-1',
            }),
        );

        const secondaryAction = screen.findByTestId('tool-view-header-secondary');
        expect(secondaryAction).toBeTruthy();

        await act(async () => {
            screen.pressByTestId('tool-view-header-secondary');
        });

        expect(pushSpy).toHaveBeenCalledWith('/session/s1/message/server%3Aserver-msg-1');
    });

    it('hides the secondary open action when tool navigation is disabled, even if the tool has its own id', async () => {
        pushSpy.mockReset();
        renderedToolViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            id: 'subagent_run_1',
            name: 'SubAgentRun',
            input: { intent: 'delegate' },
            result: { sidechainId: 'sidechain_run_1' },
        });

        const screen = await renderScreen(
            React.createElement(ToolView, {
                tool,
                metadata: null,
                sessionId: 's1',
                interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
            }),
        );

        expect(screen.findByTestId('tool-view-header-secondary')).toBeNull();
    });
});
