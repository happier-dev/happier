import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { makeToolViewProps } from '../../shell/views/ToolView.testHelpers';
import { makeCompletedTool, normalizedHostText } from '../core/truncationView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
    useUnistyles: () => ({ theme: { colors: { textSecondary: '#999', surfaceHigh: '#000' } } }),
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/utils/path/pathUtils', () => ({
    resolvePath: (p: string) => p,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: () => true,
}));

vi.mock('@/components/tools/shell/presentation/ToolDiffView', () => ({
    ToolDiffView: () => React.createElement('ToolDiffView', null),
}));

describe('PatchView', () => {
    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { PatchView } = await import('./PatchView');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    PatchView,
                    makeToolViewProps(tool, detailLevel ? { detailLevel } : {}),
                ),
            );
        });
        return tree;
    }

    it('shows an applied indicator when result.applied=true', async () => {
        const tree = await renderView(
            makeCompletedTool(
                'Patch',
                { changes: { '/tmp/a.txt': { type: 'add', add: { content: 'hi' } } } },
                { applied: true },
            ),
        );
        const renderedText = normalizedHostText(tree);
        expect(renderedText).toContain('Applied');
    });

    it('shows a deleted indicator when all changes are delete operations', async () => {
        const tree = await renderView(
            makeCompletedTool(
                'Patch',
                {
                    changes: {
                        '/tmp/a.txt': { type: 'delete', delete: { content: '' } },
                        '/tmp/b.txt': { type: 'delete', delete: { content: '' } },
                    },
                },
                { applied: true },
            ),
        );
        const renderedText = normalizedHostText(tree);
        expect(renderedText).toContain('Deleted');
    });

    it('renders a diff preview when detailLevel=full', async () => {
        const tree = await renderView(
            makeCompletedTool(
                'Patch',
                {
                    changes: {
                        '/tmp/a.txt': {
                            type: 'modify',
                            modify: { old_content: 'a\n', new_content: 'b\n' },
                        },
                    },
                },
                { applied: true },
            ),
            'full',
        );

        expect(tree.root.findAllByType('ToolDiffView' as any)).toHaveLength(1);
    });

    it('falls back to summary rendering in full mode when diff extraction is not possible', async () => {
        const tree = await renderView(
            makeCompletedTool(
                'Patch',
                {
                    changes: {
                        '/tmp/a.txt': { type: 'modify', modify: { old_content: 1, new_content: 2 } },
                    },
                },
                { applied: true },
            ),
            'full',
        );

        expect(tree.root.findAllByType('ToolDiffView' as any)).toHaveLength(0);
        const text = normalizedHostText(tree);
        expect(text).toContain('a.txt');
        expect(text).toContain('Applied');
    });

    it('does not show Deleted when changes include non-delete operations', async () => {
        const tree = await renderView(
            makeCompletedTool(
                'Patch',
                {
                    changes: {
                        '/tmp/a.txt': { type: 'delete', delete: { content: '' } },
                        '/tmp/b.txt': { type: 'add', add: { content: 'x' } },
                    },
                },
                { applied: true },
            ),
        );

        const text = normalizedHostText(tree);
        expect(text).toContain('Applied');
        expect(text).not.toContain('Deleted');
    });
});
