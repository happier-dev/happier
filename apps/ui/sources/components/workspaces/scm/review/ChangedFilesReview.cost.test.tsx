import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createThemeFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    createSessionFilesViewFixture,
    fileViewSnapshot,
    installSessionFilesViewBoundaries,
    prepareSessionFilesViewTestkit,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { scmFileStatusFromChange } from '@/scm/scmStatusFiles';

let cellRenders = 0;
// Hoist the native recycler boundary: the shared fixture's static imports also reach it.
vi.mock('@legendapp/list/react-native', async importOriginal => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(),
        renderItemLimit: 25, emitViewability: false, memoizeItems: true,
        onRenderItem: () => { cellRenders += 1; } }).module;
});
installSessionFilesViewBoundaries({ renderItemLimit: 25, emitViewability: false });

describe('Review work follows file and control demand', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
    beforeAll(prepareSessionFilesViewTestkit);
    afterEach(async () => { standardCleanup(); await fixture?.dispose(); fixture = undefined; });

    it('does no row work for idle host renders or comparison-header changes at 55,559 files', async () => {
        fixture = await createSessionFilesViewFixture();
        const { ChangedFilesReview } = await import('./ChangedFilesReview');
        const files = Array.from({ length: 55_559 }, (_, index) => scmFileStatusFromChange({
            path: `src/quiet-${index}.ts`, changeKind: 'modified', added: 1, removed: 0,
        }));
        const props = { sessionId: fixture.session.id, workspaceScope: fixture.scope, theme: createThemeFixture(),
            snapshot: fileViewSnapshot(), changedFilesViewMode: 'repository' as const,
            allRepositoryChangedFiles: files, sessionAttributedFiles: [], repositoryOnlyFiles: [],
            maxFiles: 1, maxChangedLines: 1, onFilePress() {}, initialCollapsedPaths: files.map(file => file.fullPath),
            comparisonChrome: { indexPlacement: 'phone' as const, renderBarLeading: () => null, renderHeader: () => null } };
        const screen = await renderScreen(<ChangedFilesReview {...props} />);
        try {
            cellRenders = 0;
            for (let i = 0; i < 5; i += 1) await screen.update(<ChangedFilesReview {...props} />);
            expect(cellRenders).toBe(0);
            await screen.update(<ChangedFilesReview {...props} comparisonChrome={{ ...props.comparisonChrome,
                renderHeader: () => <React.Fragment>Updated comparison title</React.Fragment> }} />);
            expect(cellRenders).toBe(0);
            await screen.pressByTestIdAsync('scm-change-collapse-src_quiet-0.ts');
            expect(cellRenders).toBe(1);
        } finally { await screen.unmount(); }
    });

    it('redraws only the changed file header when one repository file changes', async () => {
        fixture = await createSessionFilesViewFixture();
        const { ChangedFilesReview } = await import('./ChangedFilesReview');
        const files = Array.from({ length: 300 }, (_, index) => scmFileStatusFromChange({
            path: `src/change-${index}.ts`, changeKind: 'modified', added: 1, removed: 0,
        }));
        const props = { sessionId: fixture.session.id, workspaceScope: fixture.scope, theme: createThemeFixture(),
            snapshot: fileViewSnapshot(), changedFilesViewMode: 'repository' as const,
            allRepositoryChangedFiles: files, sessionAttributedFiles: [], repositoryOnlyFiles: [],
            maxFiles: 1, maxChangedLines: 1, onFilePress() {}, initialCollapsedPaths: files.map(file => file.fullPath),
            comparisonChrome: { indexPlacement: 'phone' as const, renderBarLeading: () => null, renderHeader: () => null } };
        const screen = await renderScreen(<ChangedFilesReview {...props} />);
        try {
            cellRenders = 0;
            await screen.update(<ChangedFilesReview {...props} allRepositoryChangedFiles={[
                { ...files[0]!, linesAdded: 2 }, ...files.slice(1),
            ]} />);
            expect(cellRenders).toBe(1);
            expect(screen.getTextContent()).toContain('+2');
            await screen.pressByTestIdAsync('scm-change-collapse-src_change-0.ts');
            await screen.pressByTestIdAsync('scm-change-collapse-src_change-1.ts');
            cellRenders = 0;
            await screen.update(<ChangedFilesReview {...props} allRepositoryChangedFiles={[
                { ...files[0]!, linesAdded: 3 }, ...files.slice(1),
            ]} />);
            expect(cellRenders, 'an unchanged expanded file does not consume another file\'s stats').toBe(1);
            expect(screen.getTextContent()).toContain('+3');
        } finally { await screen.unmount(); }
    });

    it('keeps existing rows and manual folds on a 59,165 to 59,167 working snapshot update', async () => {
        fixture = await createSessionFilesViewFixture();
        const { ChangedFilesReview } = await import('./ChangedFilesReview');
        const { DiffFilesListView } = await import('@/components/ui/code/diff/DiffFilesListView');
        const files = Array.from({ length: 59_165 }, (_, index) => scmFileStatusFromChange({
            path: `src/count-${index}.ts`, changeKind: 'modified', added: 1, removed: 0,
        }));
        const snapshotFor = (rows: typeof files, fetchedAt: number) => fileViewSnapshot({ fetchedAt,
            entries: rows.map(file => ({ path: file.fullPath, previousPath: null, kind: 'modified',
                includeStatus: ' ', pendingStatus: 'M', hasIncludedDelta: false, hasPendingDelta: true,
                stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false } })),
        });
        const props = { sessionId: fixture.session.id, workspaceScope: fixture.scope, theme: createThemeFixture(),
            snapshot: snapshotFor(files, 1), changedFilesViewMode: 'repository' as const,
            allRepositoryChangedFiles: files, sessionAttributedFiles: [], repositoryOnlyFiles: [],
            maxFiles: 1, maxChangedLines: 1, onFilePress() {},
            comparisonChrome: { indexPlacement: 'phone' as const, renderBarLeading: () => null, renderHeader: () => null } };
        const screen = await renderScreen(<ChangedFilesReview {...props} />);
        try {
            await screen.pressByTestIdAsync('scm-change-collapse-src_count-0.ts');
            const before = screen.tree.root.findByType(DiffFilesListView).props;
            expect(before.expandedKeys.has(files[0]!.fullPath)).toBe(false);
            cellRenders = 0;
            const nextFiles = [...files, ...['a', 'b'].map(suffix => scmFileStatusFromChange({
                path: `src/count-new-${suffix}.ts`, changeKind: 'modified', added: 1, removed: 0,
            }))];
            await screen.update(<ChangedFilesReview {...props} snapshot={snapshotFor(nextFiles, 2)} allRepositoryChangedFiles={nextFiles} />);
            const after = screen.tree.root.findByType(DiffFilesListView).props;
            expect.soft(after.expandedKeys.has(files[0]!.fullPath), 'an unrelated snapshot keeps the manual fold').toBe(false);
            expect.soft(cellRenders, 'unchanged mounted file rows are quiet').toBe(0);
            expect(after.files).toHaveLength(59_167);
            expect.soft(after.files[1]).toBe(before.files[1]);
        } finally { await screen.unmount(); }
    });

    it('refreshes image and PDF revision rows while preserving text and deleted-media facts', async () => {
        fixture = await createSessionFilesViewFixture();
        const { ChangedFilesReview } = await import('./ChangedFilesReview');
        const { DiffFilesListView } = await import('@/components/ui/code/diff/DiffFilesListView');
        const paths = ['src/quiet.ts', 'src/picture.png', 'src/document.pdf', 'src/deleted.mp4'];
        const files = paths.map(path => scmFileStatusFromChange({ path,
            changeKind: path.endsWith('.mp4') ? 'deleted' : 'modified', added: 1, removed: 0 }));
        const snapshot = fileViewSnapshot({ fetchedAt: 1, entries: paths.map(path => ({
            path, previousPath: null, kind: path.endsWith('.mp4') ? 'deleted' : 'modified',
            includeStatus: ' ', pendingStatus: path.endsWith('.mp4') ? 'D' : 'M', hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: !path.endsWith('.ts') },
        })) });
        const props = { sessionId: fixture.session.id, workspaceScope: fixture.scope, theme: createThemeFixture(), snapshot,
            changedFilesViewMode: 'repository' as const, allRepositoryChangedFiles: files,
            sessionAttributedFiles: [], repositoryOnlyFiles: [], maxFiles: 1, maxChangedLines: 1,
            initialCollapsedPaths: paths, onFilePress() {} };
        const screen = await renderScreen(<ChangedFilesReview {...props} />);
        try {
            const before = screen.tree.root.findByType(DiffFilesListView).props.files;
            cellRenders = 0;
            await screen.update(<ChangedFilesReview {...props} snapshot={{ ...snapshot, fetchedAt: 2 }} />);
            const after = screen.tree.root.findByType(DiffFilesListView).props.files;
            expect(after[0]).toBe(before[0]);
            for (const index of [1, 2]) {
                const previous = before[index];
                const next = after[index];
                if (!('snapshotSignature' in previous) || !('snapshotSignature' in next)
                    || !('imageCompare' in next) || typeof next.imageCompare !== 'object'
                    || next.imageCompare === null || !('signature' in next.imageCompare)) {
                    throw new Error('Expected image and PDF rows to carry revision comparison facts');
                }
                expect(next.snapshotSignature).not.toBe(previous.snapshotSignature);
                expect(next.imageCompare.signature).toBe(next.snapshotSignature);
            }
            expect(after[3]).toBe(before[3]);
            const deleted = after[3];
            if (!('imageCompare' in deleted) || typeof deleted.imageCompare !== 'object'
                || deleted.imageCompare === null || !('changeKind' in deleted.imageCompare)) {
                throw new Error('Expected the deleted media row to carry comparison facts');
            }
            expect(deleted.imageCompare.changeKind).toBe('deleted');
            expect(cellRenders).toBe(2);
        } finally { await screen.unmount(); }
    });

});
