import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installCodeViewCommonModuleMocks } from '../../view/codeViewTestHelpers';
import { buildCodeLinesFromUnifiedDiff } from '../../model/buildCodeLinesFromUnifiedDiff';
import { act } from 'react-test-renderer';

installCodeViewCommonModuleMocks();
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useSetting: createUseSettingMock({ values: { filesDiffFoldingEnabled: true, filesDiffFoldingContextThreshold: 4, filesDiffFoldingContextRadius: 1 } }) });
});

describe('unified diff Find reveal', () => {
    it('opens the context region holding the current match through the canonical fold owner', async () => {
        const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');
        const unifiedDiff = ['@@ -1,11 +1,11 @@', ...Array.from({ length: 10 }, (_, index) => ` context ${index}`), '-old', '+new'].join('\n');
        const target = buildCodeLinesFromUnifiedDiff({ unifiedDiff }).find((line) => line.renderCodeText === 'context 5')!;
        const screen = await renderScreen(<HappierUnifiedDiffViewer mode="unified" unifiedDiff={unifiedDiff}
            virtualized={false} findActive={true} scrollToLineId={target.id}
            findRangesByLineId={new Map([[target.id, [{ start: 0, end: target.renderCodeText.length, current: true }]]])} />);
        const current = screen.tree.root.findAll((node) => node.props.testID === 'find-match-current');
        expect(current.length).toBeGreaterThan(0);
        expect(current[current.length - 1].children.join('')).toBe('context 5');
        const foldAgain = screen.findByTestId('diff-find-fold-again');
        expect(foldAgain).not.toBeNull();
        await act(async () => { await screen.pressByTestId('diff-find-fold-again'); });
        expect(screen.tree.root.findAll((node) => node.props.testID === 'find-match-current')).toHaveLength(0);
    });
});
