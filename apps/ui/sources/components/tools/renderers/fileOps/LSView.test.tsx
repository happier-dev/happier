import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { makeToolViewProps } from '@/dev/testkit';
import { expectListSummary, makeCompletedTool } from '../core/listView.testHelpers';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('LSView', () => {
    it('shows a compact subset of entries by default', async () => {
        const { LSView } = await import('./LSView');

        const entries = Array.from({ length: 50 }, (_, i) => `entry-${i}`);
        const tool = makeCompletedTool('LS', { path: '/tmp' }, { entries });

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(LSView, makeToolViewProps(tool)))).tree;

        expectListSummary({
            tree,
            visibleValues: ['entry-0', 'entry-7'],
            hiddenValues: ['entry-8'],
            moreLabel: '+42 more',
        });
    });

    it('expands to show more entries when detailLevel=full', async () => {
        const { LSView } = await import('./LSView');

        const entries = Array.from({ length: 50 }, (_, i) => `entry-${i}`);
        const tool = makeCompletedTool('LS', { path: '/tmp' }, { entries });

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(LSView, makeToolViewProps(tool, { detailLevel: 'full' })))).tree;

        expectListSummary({
            tree,
            visibleValues: ['entry-0', 'entry-39'],
            hiddenValues: ['entry-40'],
            moreLabel: '+10 more',
        });
    });
});
