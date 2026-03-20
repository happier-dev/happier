import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { makeToolCall } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(async () => 'loaded'),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
    useUnistyles: () => ({ theme: { colors: { text: '#000', textSecondary: '#666', warning: '#f90', surfaceHigh: '#fff', surfaceHighest: '#fff' } } }),
}));

const pushSpy = vi.fn();
vi.mock('expo-router', () => ({
    useRouter: () => ({ push: pushSpy }),
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

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'toolViewDetailLevelDefault') return 'title';
        if (key === 'toolViewDetailLevelDefaultLocalControl') return 'title';
        if (key === 'toolViewDetailLevelByToolName') return {};
        if (key === 'toolViewTapAction') return 'expand';
        if (key === 'toolViewExpandedDetailLevelDefault') return 'summary';
        if (key === 'toolViewExpandedDetailLevelByToolName') return {};
        return null;
    },
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

describe('ToolView (tap action: expand)', () => {
    it('toggles inline expansion even without navigation params', async () => {
        pushSpy.mockReset();
        renderedToolViewSpy.mockReset();

        const { ToolView } = await import('./ToolView');
        const { sync } = await import('@/sync/sync');
        const ensureSidechainMessagesLoadedMock = sync.ensureSidechainMessagesLoaded as any;
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');

        const tool = makeToolCall({
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
            result: { file: { content: 'hello' } },
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ToolView, { tool, metadata: null }));
        });

        expect(tree.root.findAllByType('SpecificToolView' as any)).toHaveLength(0);

        const touchables = tree.root.findAllByType('TouchableOpacity' as any);
        expect(touchables.length).toBeGreaterThan(0);

        await act(async () => {
            touchables[0].props.onPress?.();
        });

        expect(tree.root.findAllByType('SpecificToolView' as any)).toHaveLength(1);
    });

    it('preloads sidechain messages when expanding Task tools', async () => {
        pushSpy.mockReset();
        renderedToolViewSpy.mockReset();

        const { ToolView } = await import('./ToolView');
        const { sync } = await import('@/sync/sync');
        const ensureSidechainMessagesLoadedMock = sync.ensureSidechainMessagesLoaded as any;
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');

        const tool = makeToolCall({
            id: 'tool_task_1',
            name: 'Task',
            input: { operation: 'run', description: 'Do stuff' },
            result: null,
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ToolView, { tool, metadata: null, sessionId: 's1', messageId: 'm1' }));
        });

        expect(ensureSidechainMessagesLoadedMock).not.toHaveBeenCalled();

        const touchables = tree.root.findAllByType('TouchableOpacity' as any);
        expect(touchables.length).toBeGreaterThan(0);

        await act(async () => {
            touchables[0].props.onPress?.();
            await Promise.resolve();
        });

        expect(ensureSidechainMessagesLoadedMock).toHaveBeenCalledWith('s1', 'tool_task_1');
    });

    it('preloads sidechain messages when expanding SubAgentRun tools (prefers result.sidechainId when present)', async () => {
        pushSpy.mockReset();
        renderedToolViewSpy.mockReset();

        const { ToolView } = await import('./ToolView');
        const { sync } = await import('@/sync/sync');
        const ensureSidechainMessagesLoadedMock = sync.ensureSidechainMessagesLoaded as any;
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');

        const tool = makeToolCall({
            id: 'tool_subagent_1',
            name: 'SubAgentRun',
            input: { intent: 'delegate', backendId: 'claude' },
            result: { sidechainId: 'sidechain_run_123' },
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ToolView, { tool, metadata: null, sessionId: 's1', messageId: 'm1' }));
        });

        expect(ensureSidechainMessagesLoadedMock).not.toHaveBeenCalled();

        const touchables = tree.root.findAllByType('TouchableOpacity' as any);
        expect(touchables.length).toBeGreaterThan(0);

        await act(async () => {
            touchables[0].props.onPress?.();
            await Promise.resolve();
        });

        expect(ensureSidechainMessagesLoadedMock).toHaveBeenCalledWith('s1', 'sidechain_run_123');
    });

    it('uses hitSlop for the secondary action icon to keep it easy to tap', async () => {
        pushSpy.mockReset();
        renderedToolViewSpy.mockReset();

        const { ToolView } = await import('./ToolView');
        const { sync } = await import('@/sync/sync');
        const ensureSidechainMessagesLoadedMock = sync.ensureSidechainMessagesLoaded as any;
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');

        const tool = makeToolCall({
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
            result: { file: { content: 'hello' } },
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ToolView, { tool, metadata: null, sessionId: 's1', messageId: 'm1' }));
        });

        const touchables = tree.root.findAllByType('TouchableOpacity' as any);
        const secondaryAction = touchables.find((t) => t.props.accessibilityLabel === 'toolView.open');
        expect(secondaryAction?.props.hitSlop).toBe(15);
    });

    it('uses the stable server route for the secondary open action when the message is already persisted', async () => {
        pushSpy.mockReset();
        renderedToolViewSpy.mockReset();
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            id: 'call_read_1',
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
            result: { file: { content: 'hello' } },
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ToolView, {
                    tool,
                    metadata: null,
                    sessionId: 's1',
                    messageId: 'server:server-msg-1',
                }),
            );
        });

        const touchables = tree.root.findAllByType('TouchableOpacity' as any);
        const secondaryAction = touchables.find((t) => t.props.accessibilityLabel === 'toolView.open');
        expect(secondaryAction).toBeTruthy();

        await act(async () => {
            secondaryAction!.props.onPress?.();
        });

        expect(pushSpy).toHaveBeenCalledWith('/session/s1/message/server%3Aserver-msg-1');
    });

    it('hides the secondary open action when tool navigation is disabled, even if the tool has its own id', async () => {
        pushSpy.mockReset();
        renderedToolViewSpy.mockReset();
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            id: 'subagent_run_1',
            name: 'SubAgentRun',
            input: { intent: 'delegate' },
            result: { sidechainId: 'sidechain_run_1' },
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ToolView, {
                    tool,
                    metadata: null,
                    sessionId: 's1',
                    interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                }),
            );
        });

        const touchables = tree.root.findAllByType('TouchableOpacity' as any);
        const secondaryAction = touchables.find((t) => t.props.accessibilityLabel === 'toolView.open');
        expect(secondaryAction).toBeUndefined();
    });
});
