import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/agents/catalog', () => ({
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {
        Read: { title: 'Read' },
    },
}));

const renderedToolViewSpy = vi.fn();

vi.mock('./views/_registry', () => ({
    getToolFullViewComponent: () => null,
    getToolViewComponent: () => (props: any) => {
        renderedToolViewSpy(props);
        return React.createElement('SpecificToolView', null);
    },
}));

const renderedStructuredSpy = vi.fn();
vi.mock('./views/StructuredResultView', () => ({
    StructuredResultView: (props: any) => {
        renderedStructuredSpy(props);
        return React.createElement('StructuredResultView', null);
    },
}));

vi.mock('./PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

// Force the default tool detail level to "title" so the body is hidden.
vi.mock('@/sync/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'toolViewDetailLevelDefault') return 'title';
        if (key === 'toolViewDetailLevelDefaultLocalControl') return 'title';
        if (key === 'toolViewDetailLevelByToolName') return {};
        return null;
    },
}));

vi.mock('@/utils/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('./views/MCPToolView', () => ({
    formatMCPTitle: (t: string) => t,
}));

vi.mock('../CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('./ToolSectionView', () => ({
    ToolSectionView: () => null,
}));

vi.mock('@/hooks/useElapsedTime', () => ({
    useElapsedTime: () => 0,
}));

describe('ToolView (detail level: title)', () => {
    it('hides the tool body even when a tool renderer exists', async () => {
        renderedToolViewSpy.mockReset();
        renderedStructuredSpy.mockReset();

        const { ToolView } = await import('./ToolView');

        const tool: ToolCall = {
            name: 'Read',
            state: 'completed',
            input: { file_path: '/tmp/a.txt' },
            result: { file: { content: 'hello' } },
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ToolView, { tool, metadata: null }));
        });

        // Header still renders (baseline sanity).
        expect(tree.root.findAllByType('Text' as any).length).toBeGreaterThan(0);

        // Body renderers should not run at title-level.
        expect(renderedToolViewSpy).not.toHaveBeenCalled();
        expect(renderedStructuredSpy).not.toHaveBeenCalled();
        expect(tree.root.findAllByType('SpecificToolView' as any)).toHaveLength(0);
        expect(tree.root.findAllByType('StructuredResultView' as any)).toHaveLength(0);
    });
});

