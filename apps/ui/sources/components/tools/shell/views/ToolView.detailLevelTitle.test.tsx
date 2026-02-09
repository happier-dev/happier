import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { makeToolCall } from './ToolView.testHelpers';

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

vi.mock('@/agents/catalog/catalog', () => ({
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

const renderedStructuredSpy = vi.fn();
vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: (props: any) => {
        renderedStructuredSpy(props);
        return React.createElement('StructuredResultView', null);
    },
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

// Force the default tool detail level to "title" so the body is hidden.
vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'toolViewDetailLevelDefault') return 'title';
        if (key === 'toolViewDetailLevelDefaultLocalControl') return 'title';
        if (key === 'toolViewDetailLevelByToolName') return {};
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

describe('ToolView (detail level: title)', () => {
    it('hides the tool body even when a tool renderer exists', async () => {
        renderedToolViewSpy.mockReset();
        renderedStructuredSpy.mockReset();

        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
            result: { file: { content: 'hello' } },
        });

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
