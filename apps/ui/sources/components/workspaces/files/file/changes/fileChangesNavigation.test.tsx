import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { buildReviewUnits } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { renderScreen } from '@/dev/testkit';
import { useHunkReviewController } from '@/components/workspaces/scm/review/hunkReview/useHunkReviewController';
import { buildFileChangesLiveFiles } from './fileChangesNavigation';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('File page Changes: the next changed file', () => {
    it('offers and opens the next changed file once this file is reviewed (rv R2 / rvp P2)', async () => {
        const patch = '@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n';
        const kept = buildReviewUnits('src/b.ts', undefined, patch).map(unit => unit.key);
        let controller!: ReturnType<typeof useHunkReviewController>;
        const opened: string[] = [];
        function Page() {
            controller = useHunkReviewController({ source: { kind: 'live', root: '/repo' }, path: 'src/b.ts', unifiedDiff: patch,
                liveFiles: buildFileChangesLiveFiles(['src/a.ts', 'src/b.ts', 'src/c.ts'], 'src/b.ts', patch),
                host: null, serverId: null,
                marks: { record: { reviewedChangeKeys: kept } as never, pending: false, unavailableReason: null, setReviewed: () => {}, setReviewedKeys: () => {}, clear: () => {} },
                onNavigate: cursor => opened.push(cursor.path) });
            return null;
        }
        await renderScreen(<Page />);
        expect(controller.strip.fileComplete).toBe(true);
        expect(controller.strip.nextFile).toBe('src/c.ts');
        // Changes are counted within this file; the checkout's other changed files are counted as files (orchestrator r6 ruling).
        expect(controller.strip).toMatchObject({ current: 1, total: 1, filesLeft: 2 });
        await act(async () => { controller.nextFile(); });
        expect(opened).toEqual(['src/c.ts']);
    });
});

describe('File page Changes: the open file while its diff is empty', () => {
    it('is not counted as a file still to review, as before the shared list (only the other changed files are pending)', async () => {
        let controller!: ReturnType<typeof useHunkReviewController>;
        function Page() {
            controller = useHunkReviewController({ source: { kind: 'live', root: '/repo' }, path: 'src/b.ts', unifiedDiff: '',
                liveFiles: buildFileChangesLiveFiles(['src/a.ts', 'src/b.ts', 'src/c.ts'], 'src/b.ts', ''),
                host: null, serverId: null,
                marks: { record: null, pending: false, unavailableReason: null, setReviewed: () => {}, setReviewedKeys: () => {}, clear: () => {} },
                onNavigate: () => {} });
            return null;
        }
        await renderScreen(<Page />);
        expect(controller.strip.filesLeft).toBe(2);
    });
});

describe('File page Changes: the live file list across opens', () => {
    it('keeps one list for a changed-path list whichever changed file is open, and one review base per list', async () => {
        const { getLiveReviewBase } = await import('@/components/workspaces/scm/review/hunkReview/hunkReviewModel');
        const changedPaths = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
        const openA = buildFileChangesLiveFiles(changedPaths, 'src/a.ts', '@@ -1 +1 @@\n-x\n+y\n');
        const openB = buildFileChangesLiveFiles(changedPaths, 'src/b.ts', '');
        expect(openB).toBe(openA);
        expect(getLiveReviewBase(openB)).toBe(getLiveReviewBase(openA));
        // A file outside the changed list is still reviewable, without disturbing the shared list.
        const outside = buildFileChangesLiveFiles(changedPaths, 'src/z.ts', '');
        expect(outside).not.toBe(openA);
        expect(outside.map(file => file.path)).toEqual([...changedPaths, 'src/z.ts']);
    });
});
