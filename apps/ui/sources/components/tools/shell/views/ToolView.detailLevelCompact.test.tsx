import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { makeToolCall } from './ToolView.testHelpers';

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
                success: '#0a0',
                shadow: { color: '#000', opacity: 0.1 },
                surfacePressedOverlay: 'rgba(0,0,0,0.04)',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/hooks/ui/useElapsedTime', () => ({
    useElapsedTime: () => 0.1,
}));

const renderedToolViewSpy = vi.fn();
vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => (props: any) => {
        renderedToolViewSpy(props);
        return React.createElement('SpecificToolView', null);
    },
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        edit: {
            title: 'Edit',
            extractSubtitle: () => 'file.ts',
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
    ToolError: () => null,
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => React.createElement('PermissionFooter', null),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptCollapsible', () => ({
    TranscriptCollapsible: ({ expanded, children }: any) =>
        expanded ? React.createElement(React.Fragment, null, children) : null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'toolViewDetailLevelDefault') return 'compact';
        if (key === 'toolViewDetailLevelDefaultLocalControl') return 'title';
        if (key === 'toolViewDetailLevelByToolName') return {};
        if (key === 'toolViewShowDebugByDefault') return false;
        if (key === 'toolViewTapAction') return 'expand';
        if (key === 'toolViewExpandedDetailLevelDefault') return 'summary';
        if (key === 'toolViewExpandedDetailLevelByToolName') return {};
        if (key === 'permissionPromptSurface') return 'transcript';
        return null;
    },
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'codex', 'gemini', 'opencode'],
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
    resolveAgentIdFromFlavor: () => null,
}));

function collectRenderedText(tree: renderer.ReactTestRenderer): string {
    const json = tree.toJSON();
    const collect = (node: any): string => {
        if (!node) return '';
        if (typeof node === 'string') return node;
        if (Array.isArray(node)) return node.map(collect).join('');
        return (node.children ?? []).map(collect).join('');
    };
    return collect(json);
}

describe('ToolView (detail level: compact)', () => {
    it('hides the tool body but still shows a compact inline subtitle', async () => {
        renderedToolViewSpy.mockReset();
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({ name: 'edit', state: 'running', input: {}, description: null, result: { ok: true } });

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(ToolView, { tool, metadata: null, messages: [] }));
        });

        expect(tree!.root.findAllByProps({ testID: 'tool-card-subtitle' })).toHaveLength(0);
        expect(collectRenderedText(tree!)).toContain('file.ts');

        // Body should not be mounted at compact level.
        expect(renderedToolViewSpy).not.toHaveBeenCalled();
        expect(tree!.root.findAllByType('SpecificToolView' as any)).toHaveLength(0);
    });
});
