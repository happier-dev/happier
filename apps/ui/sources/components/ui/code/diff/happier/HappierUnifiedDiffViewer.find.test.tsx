// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { installCodeViewCommonModuleMocks } from '../../view/codeViewTestHelpers';
import { buildCodeLinesFromUnifiedDiff } from '../../model/buildCodeLinesFromUnifiedDiff';
import { act } from 'react-test-renderer';

installCodeViewCommonModuleMocks();
const initialSettings = storage.getState().settings;
beforeEach(() => storage.setState({ settings: { ...initialSettings, filesDiffFoldingEnabled: true,
    filesDiffFoldingContextThreshold: 4, filesDiffFoldingContextRadius: 1 } }));
afterEach(() => {
    storage.setState({ settings: initialSettings });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

const textOf = (node: unknown): string => {
    if (typeof node === 'string') return node;
    const children = (node as { children?: unknown[] } | null)?.children;
    return Array.isArray(children) ? children.map(textOf).join('') : '';
};

describe('unified diff Find reveal', () => {
    it('lands after a folded match is revealed and its row is measured, even after the old retry window', async () => {
        const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');
        const unifiedDiff = ['@@ -1,11 +1,11 @@', ...Array.from({ length: 10 }, (_, index) => ` context ${index}`), '-old', '+new'].join('\n');
        const target = buildCodeLinesFromUnifiedDiff({ unifiedDiff }).find(line => line.renderCodeText === 'context 5')!;
        const screen = await renderScreen(<HappierUnifiedDiffViewer mode="unified" unifiedDiff={unifiedDiff} virtualized={false} />);
        expect(screen.tree.root.findAll(node => typeof node.type === 'string' && node.props.nativeID?.endsWith(`-${target.id}`))).toHaveLength(0);
        vi.useFakeTimers();
        const element = document.createElement('div');
        const scrollIntoView = vi.fn();
        element.scrollIntoView = scrollIntoView;
        try {
            await screen.update(<HappierUnifiedDiffViewer mode="unified" unifiedDiff={unifiedDiff} virtualized={false}
                findActive scrollToLineId={target.id} findRangesByLineId={new Map([[target.id, [{ start: 0, end: target.renderCodeText.length, current: true }]]])} />);
            expect(screen.findByTestId('diff-find-fold-again')).not.toBeNull();
            const row = screen.tree.root.findAll(node => typeof node.type === 'string' && node.props.nativeID?.endsWith(`-${target.id}`))[0]!;
            element.id = row.props.nativeID;
            await act(async () => { vi.advanceTimersByTime(5_000); });
            expect(scrollIntoView).not.toHaveBeenCalled();
            document.body.append(element);
            await act(async () => { row.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 1200, width: 400, height: 22 } } }); });
            expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'center' });
        } finally {
            await screen.unmount();
            element.remove();
            vi.useRealTimers();
        }
    });

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
        // Radius 1 keeps the first and last of the ten context lines, so eight were hidden and Find opened all of them.
        expect(textOf(screen.findByTestId('diff-find-opened-fold'))).toMatch(/\b8\b/);
        await act(async () => { await screen.pressByTestId('diff-find-fold-again'); });
        expect(screen.tree.root.findAll((node) => node.props.testID === 'find-match-current')).toHaveLength(0);
        expect(storage.getState().settings.filesDiffFoldingEnabled).toBe(true);
        expect(storage.getState().settings.filesDiffFoldingContextThreshold).toBe(4);
        expect(storage.getState().settings.filesDiffFoldingContextRadius).toBe(1);
    });
});
