import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { makeToolViewProps } from '../../shell/views/ToolView.testHelpers';
import { expectListSummary, makeCompletedTool } from '../core/listView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('GrepView', () => {
    it('shows a compact subset of matches by default', async () => {
        const { GrepView } = await import('./GrepView');

        const matches = Array.from({ length: 10 }, (_, i) => ({ excerpt: `match-${i}` }));
        const tool = makeCompletedTool('Grep', { pattern: 'test' }, { matches });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(GrepView, makeToolViewProps(tool)));
        });

        expectListSummary({
            tree,
            visibleValues: ['match-0', 'match-5'],
            hiddenValues: ['match-6'],
            moreLabel: '+4 more',
        });
    });

    it('expands to show more matches when detailLevel=full', async () => {
        const { GrepView } = await import('./GrepView');

        const matches = Array.from({ length: 10 }, (_, i) => ({ excerpt: `match-${i}` }));
        const tool = makeCompletedTool('Grep', { pattern: 'test' }, { matches });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(GrepView, makeToolViewProps(tool, { detailLevel: 'full' })));
        });

        expectListSummary({
            tree,
            visibleValues: ['match-0', 'match-9'],
            hiddenValues: ['+4 more'],
        });
    });
});
