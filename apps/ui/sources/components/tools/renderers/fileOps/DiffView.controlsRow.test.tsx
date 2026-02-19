import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { makeToolCall, makeToolViewProps, findPressableByText } from '../../shell/views/ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (fn: any) => fn({
            colors: {
                text: '#111',
                textSecondary: '#666',
                textLink: '#08f',
                divider: '#ddd',
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                surfaceHighest: '#fafafa',
                diff: {
                    addedBg: '#e6ffed',
                    addedBorder: '#b7eb8f',
                    addedText: '#135200',
                    removedBg: '#ffecec',
                    removedBorder: '#ffa39e',
                    removedText: '#a8071a',
                },
                box: {
                    warning: { background: '#fff7e6', border: '#ffd591', text: '#ad6800' },
                },
            },
        }),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'showLineNumbersInToolViews') return false;
        if (key === 'wrapLinesInDiffs') return true;
        return undefined;
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/code/model/diff/diffViewModel', () => ({
    buildDiffBlocks: () => [],
    buildDiffFileEntries: () => ([
        { key: 'a', filePath: 'a.ts', added: 2, removed: 1, unifiedDiff: null, oldText: null, newText: null, kind: null },
        { key: 'b', filePath: 'b.ts', added: 1, removed: 0, unifiedDiff: null, oldText: null, newText: null, kind: null },
    ]),
}));

describe('DiffView (controls row)', () => {
    it('does not render the expand-all control inside the tool body', async () => {
        const { DiffView } = await import('./DiffView');

        const tool = makeToolCall({
            name: 'Diff',
            state: 'completed',
            input: { unified_diff: 'diff --git a/a.ts b/a.ts' },
            result: null,
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(DiffView, makeToolViewProps(tool)));
        });

        expect(findPressableByText(tree, 'machineLauncher.showAll')).toBeUndefined();
    });
});
