import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { collectHostText, makeToolCall } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    TouchableOpacity: 'TouchableOpacity',
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'ios', select: (v: any) => v.ios },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
    useUnistyles: () => ({
        theme: {
            colors: {
                surfaceHigh: '#fff',
                surfaceHighest: '#fff',
                text: '#000',
                textSecondary: '#666',
                warning: '#f90',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/hooks/ui/useElapsedTime', () => ({
    useElapsedTime: () => 123.4,
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: () => 'MCP',
    formatMCPSubtitle: () => '',
}));

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('../presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('../presentation/ToolError', () => ({
    ToolError: () => null,
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => React.createElement('PermissionFooter', null),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'toolViewDetailLevelDefault') return 'summary';
        if (key === 'toolViewDetailLevelDefaultLocalControl') return 'title';
        if (key === 'toolViewDetailLevelByToolName') return {};
        if (key === 'toolViewShowDebugByDefault') return false;
        return null;
    },
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'codex', 'gemini', 'opencode'],
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
    resolveAgentIdFromFlavor: () => null,
}));

describe('ToolView (permission pending)', () => {
    it('does not show elapsed time while waiting for permission', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'execute',
            state: 'running',
            input: { command: 'pwd' },
            result: null,
            completedAt: null,
            permission: { id: 'perm1', status: 'pending' },
        });

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
            );
        });

        const flattened = collectHostText(tree!);
        expect(flattened).not.toContain('123.4s');
    });

    it('shows elapsed time when running without pending permission', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'execute',
            state: 'running',
            input: { command: 'pwd' },
            result: null,
            completedAt: null,
            permission: undefined,
        });

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
            );
        });

        const flattened = collectHostText(tree!);
        expect(flattened).toContain('123.4s');
    });

    it('does not render PermissionFooter once the tool is completed', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'execute',
            state: 'completed',
            input: { command: 'pwd' },
            result: { stdout: '/tmp\n' },
            // Some providers can leave permission status stale; ToolView should not show action buttons in that case.
            permission: { id: 'perm1', status: 'pending' },
        });

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
            );
        });

        expect(tree!.root.findAllByType('PermissionFooter' as any).length).toBe(0);
    });
});
