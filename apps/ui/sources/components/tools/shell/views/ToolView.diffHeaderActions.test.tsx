import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { makeToolCall, findPressableByText } from './ToolView.testHelpers';

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
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#000',
                textSecondary: '#666',
                textLink: '#08f',
                warning: '#f90',
                surface: '#fff',
                surfaceHigh: '#eee',
                surfaceHighest: '#eee',
                divider: '#ddd',
                diff: {
                    addedBg: '#e6ffed',
                    addedBorder: '#b7eb8f',
                    addedText: '#135200',
                    removedBg: '#ffecec',
                    removedBorder: '#ffa39e',
                    removedText: '#a8071a',
                    hunkHeaderBg: '#f5f5f5',
                    hunkHeaderText: '#666',
                    contextText: '#333',
                },
                box: {
                    warning: { background: '#fff7e6', border: '#ffd591', text: '#ad6800' },
                },
            },
        },
    }),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        Diff: { title: 'tools.names.viewDiff', icon: () => null },
    },
}));

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: () => null,
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
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

vi.mock('@/components/ui/code/model/diff/diffViewModel', () => ({
    buildDiffBlocks: () => [],
    buildDiffFileEntries: () => ([
        { key: 'a', filePath: 'a.ts', added: 2, removed: 1, unifiedDiff: null, oldText: null, newText: null, kind: null },
        { key: 'b', filePath: 'b.ts', added: 1, removed: 0, unifiedDiff: null, oldText: null, newText: null, kind: null },
    ]),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'toolViewDetailLevelDefault') return 'summary';
        if (key === 'toolViewDetailLevelDefaultLocalControl') return 'summary';
        if (key === 'toolViewDetailLevelByToolName') return {};
        if (key === 'toolViewExpandedDetailLevelDefault') return 'summary';
        if (key === 'toolViewExpandedDetailLevelByToolName') return {};
        if (key === 'toolViewTapAction') return 'expand';
        if (key === 'showLineNumbersInToolViews') return false;
        if (key === 'wrapLinesInDiffs') return true;
        return null;
    },
}));

vi.mock('@/components/tools/renderers/core/_registry', async () => {
    const actual = await vi.importActual<any>('@/components/tools/renderers/fileOps/DiffView');
    return {
        getToolViewComponent: () => actual.DiffView,
    };
});

describe('ToolView (diff header actions)', () => {
    it('surfaces the expand-all control in the tool header for multi-file diffs', async () => {
        const { ToolView } = await import('./ToolView');

        const tool = makeToolCall({
            name: 'Diff',
            state: 'completed',
            input: { unified_diff: 'diff --git a/a.ts b/a.ts\ndiff --git a/b.ts b/b.ts' },
            result: null,
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ToolView, { tool, metadata: null, messages: [] }));
        });

        expect(findPressableByText(tree, 'machineLauncher.showAll')).toBeDefined();
    });
});
