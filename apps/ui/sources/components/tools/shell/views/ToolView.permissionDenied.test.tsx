import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { collectHostText, makeToolCall } from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return { ...rn, AppState: rn.AppState, Platform: { ...rn.Platform, OS: 'ios', select: (v: any) => v.ios } };
});

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
                shadow: { color: '#000', opacity: 0.1 },
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/hooks/ui/useElapsedTime', () => ({
    useElapsedTime: () => 0,
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        Bash: {
            title: 'Bash',
        },
    },
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

vi.mock('../presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('../presentation/ToolError', () => ({
    ToolError: ({ message }: any) => React.createElement('Text', null, message),
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
        if (key === 'toolViewDetailLevelDefaultLocalControl') return 'summary';
        if (key === 'toolViewDetailLevelByToolName') return {};
        if (key === 'toolViewTapAction') return 'expand';
        if (key === 'toolViewExpandedDetailLevelDefault') return 'summary';
        if (key === 'toolViewExpandedDetailLevelByToolName') return {};
        return null;
    },
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'codex', 'gemini', 'opencode'],
    DEFAULT_AGENT_ID: 'codex',
    getAgentCore: (agentId: string) => ({
        toolRendering: { hideUnknownToolsByDefault: false },
        permissions: { modeGroup: agentId === 'codex' ? 'codexLike' : 'cliLike' },
    }),
    resolveAgentIdFromFlavor: (flavor: any) => {
        if (flavor === 'claude' || flavor === 'codex') return flavor;
        return null;
    },
}));

describe('ToolView (permission denied)', () => {
    it('keeps the inferred known tool title even when inference fallback is used', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            // Force inference fallback: tool name isn't known, but input.permission.toolName is.
            name: 'UnknownTool',
            description: 'execute',
            state: 'error',
            result: null,
            input: { permission: { toolName: 'Bash' } },
            permission: { id: 'perm1', status: 'denied', decision: 'denied' },
        });

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
            );
        });

        const flattened = collectHostText(tree!);
        expect(flattened).toContain('Bash');
        expect(flattened).toContain('errors.permissionDenied');
        // The raw tool description should not replace the known tool title.
        expect(flattened).not.toContain('execute');
    });

    it('does not attribute denial to Read Only mode for non-codexLike providers', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'Bash',
            description: 'Write',
            state: 'error',
            result: null,
            input: { command: "echo hi > /tmp/x" },
            permission: { id: 'perm1', status: 'denied' },
        });

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ToolView, {
                    tool,
                    metadata: { flavor: 'claude', permissionMode: 'read-only' } as any,
                    messages: [],
                    sessionId: 's1',
                    messageId: 'm1',
                }),
            );
        });

        const flattened = collectHostText(tree!);
        expect(flattened).toContain('errors.permissionDenied');
        expect(flattened.join('\n')).not.toContain('Denied by Read Only mode');
    });

    it('attributes denial to Read Only mode for codexLike providers', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'Bash',
            description: 'Write',
            state: 'error',
            result: null,
            input: { command: "echo hi > /tmp/x" },
            permission: { id: 'perm1', status: 'denied' },
        });

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ToolView, {
                    tool,
                    metadata: { flavor: 'codex', permissionMode: 'read-only' } as any,
                    messages: [],
                    sessionId: 's1',
                    messageId: 'm1',
                }),
            );
        });

        const flattened = collectHostText(tree!);
        expect(flattened.join('\n')).toContain('Denied by Read Only mode');
    });
});
