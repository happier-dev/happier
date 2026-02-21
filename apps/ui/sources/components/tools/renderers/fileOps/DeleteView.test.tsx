import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { makeToolViewProps } from '../../shell/views/ToolView.testHelpers';
import { expectListSummary, makeCompletedTool } from '../core/listView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('DeleteView', () => {
    it('shows a compact subset of deleted files by default', async () => {
        const { DeleteView } = await import('./DeleteView');

        const tool = makeCompletedTool(
            'Delete',
            { file_paths: Array.from({ length: 10 }, (_, i) => `file-${i}.txt`) },
            { deleted: true },
        );

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(DeleteView, makeToolViewProps(tool)));
        });

        expectListSummary({
            tree,
            visibleValues: ['file-0.txt', 'file-7.txt'],
            hiddenValues: ['file-8.txt'],
            moreLabel: '+2 more',
        });
    });

    it('renders all deleted files in full view', async () => {
        const { DeleteView } = await import('./DeleteView');

        const tool = makeCompletedTool(
            'Delete',
            { file_paths: Array.from({ length: 10 }, (_, i) => `file-${i}.txt`) },
            { deleted: true },
        );

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(DeleteView, makeToolViewProps(tool, { detailLevel: 'full' })));
        });

        expectListSummary({
            tree,
            visibleValues: ['file-0.txt', 'file-9.txt'],
            hiddenValues: ['+2 more'],
        });
    });
});
