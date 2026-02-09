import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { collectHostText, makeToolCall, makeToolViewProps } from '../../shell/views/ToolView.testHelpers';

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

describe('CodeSearchView', () => {
    it('shows a compact subset of matches by default', async () => {
        const { CodeSearchView } = await import('./CodeSearchView');

        const matches = Array.from({ length: 10 }, (_, i) => ({
            filePath: `/repo/file-${i}.ts`,
            line: i + 1,
            excerpt: `match-${i}`,
        }));
        const tool = makeToolCall({
            name: 'CodeSearch',
            state: 'completed',
            input: { query: 'test' },
            result: { matches },
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(CodeSearchView, makeToolViewProps(tool)));
        });

        const renderedText = collectHostText(tree);
        const normalized = renderedText.join(' ').replace(/\s+/g, ' ');
        expect(normalized).toContain('/repo/file-0.ts:1');
        expect(normalized).toContain('match-0');
        expect(normalized).toContain('/repo/file-5.ts:6');
        expect(normalized).toContain('match-5');
        expect(normalized).not.toContain('/repo/file-6.ts:7');
        expect(normalized).toContain('+ 4 more');
    });

    it('expands to show more matches when detailLevel=full', async () => {
        const { CodeSearchView } = await import('./CodeSearchView');

        const matches = Array.from({ length: 10 }, (_, i) => ({
            filePath: `/repo/file-${i}.ts`,
            line: i + 1,
            excerpt: `match-${i}`,
        }));
        const tool = makeToolCall({
            name: 'CodeSearch',
            state: 'completed',
            input: { query: 'test' },
            result: { matches },
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(CodeSearchView, makeToolViewProps(tool, { detailLevel: 'full' })),
            );
        });

        const renderedText = collectHostText(tree).join(' ').replace(/\s+/g, ' ');
        expect(renderedText).toContain('/repo/file-0.ts:1');
        expect(renderedText).toContain('match-0');
        expect(renderedText).toContain('/repo/file-9.ts:10');
        expect(renderedText).toContain('match-9');
        expect(renderedText).not.toContain('+4 more');
    });
});
