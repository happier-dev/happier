import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook, flushHookEffects } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { createChangedFilesReviewDiffStateSource } from './ChangedFilesReviewDiffStore';
import { createChangedFilesReviewFind } from './useChangedFilesReviewFind';
import { useChangedFilesReviewDiffLoading } from './useChangedFilesReviewDiffLoading';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';

const patch = ['@@ -1,11 +1,11 @@', ...Array.from({ length: 10 }, (_, i) => ` context ${i}`), '-old', '+new'].join('\n');
const paths = ['a.ts', 'unloaded.ts', 'image.png', 'failed.ts'];

describe('review Find', () => {
    it('keeps snapshot-declared binary files partial even without a known extension or binary patch marker', () => {
        const source = createChangedFilesReviewDiffStateSource();
        source.setDiffState('binary.asset', { status: 'loaded', diff: '', error: null });
        const model = createChangedFilesReviewFind();
        const dispose = model.connect({ paths: ['binary.asset'], binaryPaths: new Set(['binary.asset']), diffStateSource: source, reveal: vi.fn() });
        model.open(); model.setQuery('needle');
        expect(model.status).toMatchObject({ kind: 'results', total: 0, coverage: 'partialErrors' });
        dispose();
    });

    it('uses the real loader for unopened files, searches folded text and reports binary/error coverage', async () => {
        const files: ScmFileStatus[] = paths.map((fullPath) => ({ fullPath, filePath: '', fileName: fullPath,
            status: 'modified', isIncluded: false, linesAdded: 1, linesRemoved: 1 }));
        const reveal = vi.fn();
        const fetchUnifiedDiffForPath = vi.fn(async ({ path }: { path: string }) => path === 'failed.ts'
            ? { success: false as const, error: 'unreadable' }
            : { success: true as const, diff: path === 'image.png' ? '' : patch });
        const { getCurrent } = await renderHook(() => {
            const [model] = React.useState(() => createChangedFilesReviewFind());
            const open = React.useSyncExternalStore(model.subscribe, () => model.getSnapshot().open);
            const { diffStateSource } = useChangedFilesReviewDiffLoading({ sessionId: 's', isRepo: true,
                reviewFiles: files, diffArea: 'both', requestedPaths: open ? paths : ['a.ts'],
                tooLarge: true, selectedPath: '', normalizeError: String, fallbackError: 'unreadable',
                fetchUnifiedDiffForPath });
            React.useEffect(() => model.connect({ paths, diffStateSource, reveal }), [model, diffStateSource]);
            return { model, diffStateSource };
        });
        expect(getCurrent().diffStateSource.getDiffState('unloaded.ts').status).toBe('idle');
        await act(() => { getCurrent().model.open(); getCurrent().model.setQuery('context 5'); });
        await flushHookEffects();
        const model = getCurrent().model;
        expect(model.status).toMatchObject({ kind: 'results', total: 2, current: 1, files: 2, coverage: 'partialErrors' });
        expect(model.getFileSnapshot('unloaded.ts').count).toBe(1);
        await act(() => { model.step(1); });
        expect(reveal).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: 'unloaded.ts' }));
        expect([...model.getFileSnapshot('unloaded.ts').ranges.values()].flat()).toEqual([{ start: 0, end: 9, current: true }]);
        await act(() => { model.close(); });
        expect(model.getFileSnapshot('unloaded.ts').ranges.size).toBe(0);
    });

    it('preserves the current match during later loads and emits only changed file decorations', () => {
        const source = createChangedFilesReviewDiffStateSource();
        source.setDiffState('a.ts', { status: 'loaded', diff: patch, error: null });
        const model = createChangedFilesReviewFind();
        const reveal = vi.fn();
        const dispose = model.connect({ paths: ['a.ts', 'b.ts'], diffStateSource: source, reveal });
        model.open(); model.setQuery('context 5');
        expect(model.status).toMatchObject({ kind: 'searching', total: 1 });
        const previous = model.getFileSnapshot('a.ts');
        const listener = vi.fn();
        model.subscribeFile('a.ts', listener);
        source.setDiffState('b.ts', { status: 'loaded', diff: patch, error: null });
        expect(model.status).toMatchObject({ kind: 'results', total: 2, current: 1, coverage: 'complete' });
        expect(model.getFileSnapshot('a.ts')).toBe(previous);
        expect(listener).not.toHaveBeenCalled();
        model.setOptions({ matchCase: false, regex: true }); model.setQuery('[');
        expect(model.status.kind).toBe('invalidPattern');
        expect(model.getFileSnapshot('a.ts').ranges.size).toBe(0);
        expect(reveal).toHaveBeenLastCalledWith(null);
        dispose();
    });
});
