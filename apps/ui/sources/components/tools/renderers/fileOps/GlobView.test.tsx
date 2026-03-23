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

describe('GlobView', () => {
    it('shows a compact subset of matches by default', async () => {
        const { GlobView } = await import('./GlobView');

        const matches = Array.from({ length: 50 }, (_, i) => `/path/${i}.ts`);
        const tool = makeCompletedTool('Glob', { pattern: '**/*.ts' }, { matches });

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(GlobView, makeToolViewProps(tool)))).tree;

        expectListSummary({
            tree,
            visibleValues: ['/path/0.ts', '/path/7.ts'],
            hiddenValues: ['/path/8.ts'],
            moreLabel: '+42 more',
        });
    });

    it('expands to show more matches when detailLevel=full', async () => {
        const { GlobView } = await import('./GlobView');

        const matches = Array.from({ length: 50 }, (_, i) => `/path/${i}.ts`);
        const tool = makeCompletedTool('Glob', { pattern: '**/*.ts' }, { matches });

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(GlobView, makeToolViewProps(tool, { detailLevel: 'full' })))).tree;

        expectListSummary({
            tree,
            visibleValues: ['/path/0.ts', '/path/39.ts'],
            hiddenValues: ['/path/40.ts'],
            moreLabel: '+10 more',
        });
    });
});
