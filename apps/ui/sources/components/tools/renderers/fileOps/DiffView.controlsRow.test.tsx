import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { makeToolCall, makeToolViewProps, findPressableByText } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit';
import { installFileOpsRendererCommonModuleMocks } from './fileOpsRendererTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installFileOpsRendererCommonModuleMocks({
    storage: async (_importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'showLineNumbersInToolViews') return false;
                if (key === 'wrapLinesInDiffs') return true;
                return undefined;
            },
            useSessionReviewCommentsDrafts: () => [],
            storage: { getState: () => ({ upsertSessionReviewCommentDraft: () => {}, deleteSessionReviewCommentDraft: () => {} }) },
        });
    },
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
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
        tree = (await renderScreen(React.createElement(DiffView, makeToolViewProps(tool)))).tree;

        expect(findPressableByText(tree, 'machineLauncher.showAll')).toBeUndefined();
    });
});
