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
import { buildScmDiffSnapshotSignature } from '@/scm/diffCache/scmDiffCacheKey';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { buildScmFileReviewUnits } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { createScmReviewedMarksRecordPort, ScmReviewedMarksRecordSchema,
    type ScmReviewedMarksRecord } from '@happier-dev/protocol/scm/reviewedMarks';
import type { ScmFileViewedFile } from '@/sync/domains/scm/fileViewed';

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

    it('returns held rows without scanning the inventory for restored focus or renderer changes', async () => {
        fixture = await createSessionFilesViewFixture();
        const { ChangedFilesReview } = await import('./ChangedFilesReview');
        const { DiffFilesListView } = await import('@/components/ui/code/diff/DiffFilesListView');
        const files = Array.from({ length: 59_000 }, (_, index) => scmFileStatusFromChange({
            path: `src/return-${index}.ts`, changeKind: 'modified', added: 1, removed: 0,
        }));
        const props = { sessionId: fixture.session.id, workspaceScope: fixture.scope, theme: createThemeFixture(),
            snapshot: fileViewSnapshot(), changedFilesViewMode: 'repository' as const,
            allRepositoryChangedFiles: files, sessionAttributedFiles: [], repositoryOnlyFiles: [],
            maxFiles: 1, maxChangedLines: 1, onFilePress() {}, initialCollapsedPaths: files.slice(1).map(file => file.fullPath),
            activeReviewFile: { key: 'return-review', presented: true },
            comparisonChrome: { indexPlacement: 'phone' as const, renderBarLeading: () => null, renderHeader: () => null } };
        const screen = await renderScreen(<ChangedFilesReview {...props} />);
        try {
            const row = screen.findByTestId('scm-change-row-container:src_return-0.ts');
            expect(row).not.toBeNull();
            const held = screen.tree.root.findByType(DiffFilesListView).props.files;
            let unseenRowReads = 0;
            const lastRow = held.at(-1)!;
            const lastKey = lastRow.key;
            Object.defineProperty(lastRow, 'key', { configurable: true, get: () => { unseenRowReads += 1; return lastKey; } });
            await screen.update(<ChangedFilesReview {...props} activeReviewFile={{ ...props.activeReviewFile, presented: false }} />);
            unseenRowReads = 0;
            await screen.update(<ChangedFilesReview {...props} focusPath={files[0]!.fullPath} onFilePress={() => {}} />);
            expect(unseenRowReads, 'restoring focus and changing the renderer must not scan held rows').toBe(0);
            expect(screen.findByTestId('scm-change-row-container:src_return-0.ts')).toBe(row);
            expect(screen.tree.root.findByType(DiffFilesListView).props.files).toBe(held);
        } finally { await screen.unmount(); }
    });

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

    it('does not re-render for its own scroll position echoed back as initialScrollTop', async () => {
        // DEV scroll: the pane persisted the reader's scroll top and handed it back as initialScrollTop, re-rendering Review
        // (and, with a fresh theme proxy, every mounted body) for a value it reads only at mount.
        fixture = await createSessionFilesViewFixture();
        const { ChangedFilesReview } = await import('./ChangedFilesReview');
        const { DiffFilesListView } = await import('@/components/ui/code/diff/DiffFilesListView');
        const files = Array.from({ length: 30 }, (_, index) => scmFileStatusFromChange({
            path: `src/scroll-${index}.ts`, changeKind: 'modified', added: 1, removed: 0,
        }));
        const props = { sessionId: fixture.session.id, workspaceScope: fixture.scope, theme: createThemeFixture(),
            snapshot: fileViewSnapshot(), changedFilesViewMode: 'repository' as const,
            allRepositoryChangedFiles: files, sessionAttributedFiles: [], repositoryOnlyFiles: [],
            maxFiles: 1, maxChangedLines: 1, onFilePress() {}, initialScrollTop: null as number | null,
            comparisonChrome: { indexPlacement: 'phone' as const, renderBarLeading: () => null, renderHeader: () => null } };
        const screen = await renderScreen(<ChangedFilesReview {...props} />);
        try {
            const before = screen.tree.root.findByType(DiffFilesListView).props;
            for (const top of [120, 480, 960]) await screen.update(<ChangedFilesReview {...props} initialScrollTop={top} />);
            expect(screen.tree.root.findByType(DiffFilesListView).props, 'Review does not render for a mount-only scroll seed').toBe(before);
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

    it('publishes one changed diff row and no rows for 20 identical refreshes', async () => {
        fixture = await createSessionFilesViewFixture();
        const { act } = await import('react-test-renderer');
        const { ChangedFilesReviewDiffBlock } = await import('./ChangedFilesReviewDiffBlock');
        const { createChangedFilesReviewDiffStateSource } = await import('./ChangedFilesReviewDiffStore');
        const paths = Array.from({ length: 25 }, (_, index) => `src/local-${index}.ts`);
        const diff = (path: string, text: string) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${text}\n`;
        const source = createChangedFilesReviewDiffStateSource(paths.map(path => [path,
            { status: 'loaded', diff: diff(path, 'first'), error: null }] as const));
        const rendered: string[] = [];
        const theme = createThemeFixture();
        const screen = await renderScreen(<>{paths.map(path => <React.Profiler key={path} id={path}
            onRender={id => { rendered.push(id); }}><ChangedFilesReviewDiffBlock theme={theme}
                sessionId={fixture!.session.id} workspaceScope={fixture!.scope} filePath={path}
                snapshotSignature="one-checkout" diffStateSource={source} reviewCommentsEnabled={false}
                reviewCommentDrafts={[]} /></React.Profiler>)}</>);
        try {
            rendered.length = 0;
            for (let index = 0; index < 20; index++) await act(async () => source.setDiffState(paths[0]!,
                { status: 'loaded', diff: diff(paths[0]!, 'first'), error: null }));
            expect(rendered).toEqual([]);
            await act(async () => source.setDiffState(paths[0]!,
                { status: 'loaded', diff: diff(paths[0]!, 'changed-only-here'), error: null }));
            expect([...new Set(rendered)]).toEqual([paths[0]]);
            expect(screen.getTextContent()).toContain('changed-only-here');
        } finally { await screen.unmount(); }
    });

    it('updates a leading comparison row without redrawing file rows', async () => {
        fixture = await createSessionFilesViewFixture();
        const { DiffFilesListView } = await import('@/components/ui/code/diff/DiffFilesListView');
        let fileRenders = 0;
        const props = { files: Array.from({ length: 300 }, (_, index) => ({ key: `file-${index}`, added: 1, removed: 0 })),
            expandedKeys: new Set<string>(), onToggleExpanded() {}, canRenderInlineDiffs: false,
            wrapLines: true, showLineNumbers: true, showPrefix: true, virtualizeFileList: true,
            renderFileRow: ({ file }: { file: { key: string } }) => { fileRenders += 1; return <React.Fragment>{file.key}</React.Fragment>; } };
        const keys = ['comparison'];
        const screen = await renderScreen(<DiffFilesListView {...props}
            leadingRows={{ keys, render: () => <React.Fragment>Initial header</React.Fragment> }} />);
        try {
            expect(fileRenders).toBeGreaterThan(0);
            fileRenders = 0;
            await screen.update(<DiffFilesListView {...props}
                leadingRows={{ keys, render: () => <React.Fragment>Changed header</React.Fragment> }} />);
            expect(fileRenders).toBe(0);
            expect(screen.getTextContent()).toContain('Changed header');
        } finally { await screen.unmount(); }
    });

    it('keeps 25 mounted headers quiet on Viewed acknowledgement and K=2 refresh at 55,559 captured files, while diff and Keep changes reach rows', async () => {
        fixture = await createSessionFilesViewFixture();
        const { act } = await import('react-test-renderer');
        const { createScmFileViewedOperations } = await import('@/sync/ops/scmDiffSummary/fileViewed');
        const { ChangedFilesReview } = await import('./ChangedFilesReview');
        const { DiffFilesListView } = await import('@/components/ui/code/diff/DiffFilesListView');
        const { ScmComparisonFactSentence } = await import('@/components/sessions/files/comparison/ScmComparisonHeader');
        const paths = Array.from({ length: 55_559 }, (_, index) => `src/f3-${index}.ts`);
        const remote = new Map<string, NonNullable<ScmFileViewedFile['state']>>(paths.map(path => [path, 'unviewed']));
        const actions = { read: { action: { pluginId: 'example.forge', localId: 'read-viewed' } },
            set: { action: { pluginId: 'example.forge', localId: 'set-viewed' } } };
        let acknowledge: (() => void) | undefined;
        const viewed = createScmFileViewedOperations({ actions, execute: async invocation => {
            if (invocation.action.localId === 'read-viewed') return { kind: 'ready', headOid: 'head',
                files: paths.map(path => ({ path, state: remote.get(path) })) };
            const { path, viewed: next } = invocation.input as { path: string; viewed: boolean };
            return new Promise(resolve => { acknowledge = () => {
                remote.set(path, next ? 'viewed' : 'unviewed');
                resolve({ kind: 'ready', path, state: remote.get(path) });
            }; });
        } });
        await viewed.refresh();
        const files = paths.map(path => scmFileStatusFromChange({ path, changeKind: 'modified', added: 1, removed: 0 }));
        const snapshot = fileViewSnapshot({ entries: paths.map(path => ({ path, previousPath: null, kind: 'modified',
            includeStatus: ' ', pendingStatus: 'M', hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false } })) });
        const patch = '--- a/src/f3-0.ts\n+++ b/src/f3-0.ts\n@@ -1 +1 @@\n-old\n+first\n';
        const comparison = ScmComparisonSchema.parse({ id: 'f3-perf-pr', source: { kind: 'pullRequest', locator: {
            providerId: 'example.forge', repository: 'example/repo', number: 17, fileViewedActions: actions } },
            repository: { rootPath: '/repo' }, endpoints: { after: 'head' }, freshness: 'current',
            inventory: { state: 'complete', reasons: [], files: paths.map((path, index) => ({ path, changeKind: 'modified',
                binary: false, generated: false, lockfile: false,
                evidence: { state: 'available', unifiedDiff: index === 0 ? patch : '' },
                occurrences: index === 0 ? [{ id: 'first', alias: 'first', path, position: 0,
                    before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }] : [] })) } });
        let pathReads = 0;
        for (const file of comparison.inventory.files) {
            const path = file.path;
            Object.defineProperty(file, 'path', { get() { pathReads += 1; return path; }, configurable: true });
        }
        let record: ScmReviewedMarksRecord | null = null;
        const port = createScmReviewedMarksRecordPort({ comparison, transport: {
            read: async () => ({ value: record, version: record ? 0 : -1 }),
            compareAndSet: async value => { record = ScmReviewedMarksRecordSchema.parse(value); return { success: true, version: 0 }; },
        } });
        const marks = { get record() { return record; }, pending: false, unavailableReason: null,
            setReviewed: port.setReviewed, setReviewedKeys: port.setReviewedKeys, clear: port.clear };
        const props = { sessionId: fixture.session.id, workspaceScope: fixture.scope, theme: createThemeFixture(), snapshot,
            changedFilesViewMode: 'repository' as const, allRepositoryChangedFiles: files, sessionAttributedFiles: [], repositoryOnlyFiles: [],
            maxFiles: 1, maxChangedLines: 1, onFilePress() {}, evidenceOnly: true, initialCollapsedPaths: paths,
            focusPath: paths.at(-1), comparisonFiles: comparison.inventory.files,
            hunkReview: { source: { kind: 'captured' as const, comparison }, host: null, serverId: null, fileViewed: viewed, marks },
            comparisonChrome: { indexPlacement: 'phone' as const, renderBarLeading: () => null,
                renderHeader: (_coverage: unknown, facts?: { viewed: React.ReactNode }) => facts?.viewed } };
        const screen = await renderScreen(<ChangedFilesReview {...props} />);
        try {
            const listBefore = screen.tree.root.findByType(DiffFilesListView).props;
            const mountedPaths = new Set(screen.tree.root.findAll(node => node.props.source === viewed
                && typeof node.props.path === 'string').map(node => node.props.path));
            expect([...mountedPaths]).toEqual(paths.slice(0, 25));
            expect(listBefore.files).toHaveLength(paths.length);
            pathReads = 0;
            cellRenders = 0;
            let mutation = Promise.resolve(false);
            await act(async () => { mutation = viewed.setViewed(paths[1]!, true); });
            expect(cellRenders).toBe(0);
            expect(viewed.getFile(paths[1]!).pending).toBe(true);
            await act(async () => { acknowledge!(); await mutation; });
            expect.soft(cellRenders).toBe(0);
            expect.soft(pathReads).toBe(0);
            expect(viewed.getFile(paths[1]!)).toMatchObject({ state: 'viewed', pending: false });
            expect(screen.tree.root.findByType(ScmComparisonFactSentence).props.counts).toEqual([1, paths.length]);
            const listAfter = screen.tree.root.findByType(DiffFilesListView).props;
            expect.soft(listAfter.renderInlineUnifiedDiff).toBe(listBefore.renderInlineUnifiedDiff);
            cellRenders = 0;
            pathReads = 0;
            for (const path of [paths[0]!, paths[2]!]) remote.set(path, 'viewed');
            await act(async () => { await viewed.refresh(); });
            expect.soft(cellRenders).toBe(0);
            expect.soft(pathReads).toBe(0);
            expect(screen.tree.root.findByType(ScmComparisonFactSentence).props.counts).toEqual([3, paths.length]);
            cellRenders = 0;
            await act(async () => { await viewed.refresh(); });
            expect(cellRenders).toBe(0);

            const totalFiles = paths.length + 2;
            await screen.update(<ChangedFilesReview {...props} hideViewed fileViewedTotal={totalFiles} />);
            const visibleAfterHiding = screen.tree.root.findByType(DiffFilesListView).props.files;
            expect(visibleAfterHiding).toHaveLength(paths.length - 3);
            expect(visibleAfterHiding[0]?.key).toBe(paths[3]);
            expect(screen.tree.root.findByType(ScmComparisonFactSentence).props.counts).toEqual([3, totalFiles]);
            remote.set(paths[0]!, 'dismissed');
            remote.set(paths[3]!, 'viewed');
            await act(async () => { await viewed.refresh(); });
            const visibleAfterPush = screen.tree.root.findByType(DiffFilesListView).props.files;
            expect(visibleAfterPush).toHaveLength(paths.length - 3);
            expect(visibleAfterPush[0]?.key).toBe(paths[0]);
            await screen.update(<ChangedFilesReview {...props} />);

            // Only the expanded file consumes hunk controls. Collapsed headers stay quiet.
            await screen.pressByTestIdAsync('scm-change-collapse-src_f3-0.ts');
            cellRenders = 0;
            const unit = buildScmFileReviewUnits(comparison.inventory.files[0]!)[0]!;
            const beforeKeep = screen.tree.root.findByType(DiffFilesListView).props.renderInlineUnifiedDiff;
            await act(async () => { await port.setReviewedKeys([unit.key], true); });
            await screen.update(<ChangedFilesReview {...props} hunkReview={{ ...props.hunkReview, marks: { ...marks } }} />);
            const afterKeep = screen.tree.root.findByType(DiffFilesListView).props.renderInlineUnifiedDiff;
            expect(afterKeep, 'Keep reaches the body through its own file\'s model, not a new list renderer').toBe(beforeKeep);
            expect(cellRenders, 'Keep updates the expanded body without redrawing file headers').toBe(0);
            // The body reads its own file's model from the review source.
            const reviewOf = () => screen.tree.root.findAll(node => node.props.filePath === paths[0]
                && node.props.hunkReviewSource)[0]!.props.hunkReviewSource;
            expect(reviewOf().hunksFor(paths[0]).stateOf({ key: unit.key })).toBe('kept');
            cellRenders = 0;
            const updatedFile = { ...comparison.inventory.files[0]!, evidence: { state: 'available' as const,
                unifiedDiff: patch.replace('+first', '+changed') } };
            const updatedComparison = { ...comparison, inventory: { ...comparison.inventory,
                files: [updatedFile, ...comparison.inventory.files.slice(1)] } };
            await screen.update(<ChangedFilesReview {...props} comparisonFiles={updatedComparison.inventory.files}
                hunkReview={{ ...props.hunkReview, source: { kind: 'captured', comparison: updatedComparison } }} />);
            expect(cellRenders, 'fresh diff evidence updates the body without redrawing headers').toBe(0);
            const updatedUnits = reviewOf().reviewUnitsFor(paths[0]);
            expect(updatedUnits[0].key).not.toBe(unit.key);
            expect(reviewOf().hunksFor(paths[0]).stateOf({ key: updatedUnits[0].key })).toBe('open');
        } finally { await screen.unmount(); viewed.retire(); }
    });

    it('does not serialize the repository revision for a text diff, including on a real diff update', async () => {
        fixture = await createSessionFilesViewFixture();
        const { ChangedFilesReviewDiffBlock } = await import('./ChangedFilesReviewDiffBlock');
        const { createChangedFilesReviewDiffStateSource } = await import('./ChangedFilesReviewDiffStore');
        const marker = 'fileopen-serialized-path';
        const snapshot = fileViewSnapshot({ entries: Array.from({ length: 54_849 }, (_, index) => ({
            path: `${marker}/${index}.ts`, previousPath: null, kind: 'modified', includeStatus: ' ', pendingStatus: 'M',
            hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 1, isBinary: false },
        })) });
        const signature = buildScmDiffSnapshotSignature(snapshot);
        const diff = (tail: string) => `--- a/src/open.ts\n+++ b/src/open.ts\n@@ -1 +1 @@\n-old\n+${tail}\n`;
        const source = createChangedFilesReviewDiffStateSource([['src/open.ts', { status: 'loaded', diff: diff('first'), error: null }]]);
        const stringify = JSON.stringify;
        let serializedRevisionCharacters = 0;
        const serialization = vi.spyOn(JSON, 'stringify').mockImplementation((...args) => {
            const value: unknown = args[0];
            if (Array.isArray(value)) for (const entry of value) {
                if (typeof entry === 'string' && entry.includes(marker)) serializedRevisionCharacters += entry.length;
            }
            return Reflect.apply(stringify, JSON, args);
        });
        try {
            const screen = await renderScreen(<ChangedFilesReviewDiffBlock theme={createThemeFixture()} sessionId={fixture.session.id}
                workspaceScope={fixture.scope} snapshotSignature={signature} filePath="src/open.ts"
                diffStateSource={source} reviewCommentsEnabled={false} reviewCommentDrafts={[]} />);
            expect(serializedRevisionCharacters).toBe(0);
            const { act } = await import('react-test-renderer');
            await act(async () => source.setDiffState('src/open.ts', { status: 'loaded', diff: diff('changed'), error: null }));
            expect(screen.getTextContent()).toContain('changed');
            expect(serializedRevisionCharacters).toBe(0);
            await screen.unmount();
        } finally { serialization.mockRestore(); }
    });

    it('keeps every comparison file and fresh totals without building unused jump rows or rescanning on focus', async () => {
        fixture = await createSessionFilesViewFixture();
        const { ChangedFilesReview } = await import('./ChangedFilesReview');
        const { DiffFilesListView } = await import('@/components/ui/code/diff/DiffFilesListView');
        const prefix = 'fileopen-review-cost/';
        const paths = Array.from({ length: 2_000 }, (_, index) => `${prefix}file-${index}.ts`);
        const files = paths.map(path => scmFileStatusFromChange({ path, changeKind: 'modified', added: 1, removed: 0 }));
        const snapshot = fileViewSnapshot({ entries: paths.map(path => ({
            path, previousPath: null, kind: 'modified', includeStatus: ' ', pendingStatus: 'M', hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
        })) });
        const map = Array.prototype.map;
        const reduce = Array.prototype.reduce;
        let unusedJumpRows = 0;
        let coverageVisits = 0;
        let coverage: Readonly<{ fileCount: number; added: number; removed: number }> | undefined;
        const maps = vi.spyOn(Array.prototype, 'map').mockImplementation(function (this: unknown[], ...args) {
            const result: unknown[] = Reflect.apply(map, this, args);
            const first = result[0];
            if (first && typeof first === 'object' && 'id' in first && 'title' in first
                && typeof first.id === 'string' && first.id.startsWith(prefix)
                && typeof first.title === 'string' && first.title.startsWith('1 / ')) unusedJumpRows += result.length;
            return result;
        });
        const reductions = vi.spyOn(Array.prototype, 'reduce').mockImplementation(function (this: unknown[], ...args) {
            const first: unknown = this[0];
            if (first && typeof first === 'object' && 'fullPath' in first
                && typeof first.fullPath === 'string' && first.fullPath.startsWith(prefix)) coverageVisits += this.length;
            return Reflect.apply(reduce, this, args);
        });
        const props = {
            sessionId: fixture.session.id, workspaceScope: fixture.scope, theme: createThemeFixture(), snapshot,
            changedFilesViewMode: 'repository' as const, allRepositoryChangedFiles: files,
            sessionAttributedFiles: [], repositoryOnlyFiles: [], maxFiles: 1, maxChangedLines: 1, onFilePress: () => {},
            evidenceOnly: true,
            comparisonChrome: { indexPlacement: 'phone' as const,
                renderBarLeading: (next: NonNullable<typeof coverage>) => { coverage = next; return null; }, renderHeader: () => null },
        };
        try {
            const screen = await renderScreen(<ChangedFilesReview {...props} />);
            expect(screen.tree.root.findByType(DiffFilesListView).props.files).toHaveLength(paths.length);
            expect(coverage).toMatchObject({ fileCount: paths.length, added: paths.length, removed: 0 });
            expect.soft(unusedJumpRows).toBe(0);
            coverageVisits = 0;
            await screen.update(<ChangedFilesReview {...props} focusPath={paths[1]} />);
            expect(coverageVisits).toBe(0);
            expect(unusedJumpRows).toBe(0);
            const changed = fileViewSnapshot({ entries: snapshot.entries.map((entry, index) => index === 0
                ? { ...entry, stats: { ...entry.stats, pendingAdded: 7 } } : entry) });
            await screen.update(<ChangedFilesReview {...props} snapshot={changed}
                allRepositoryChangedFiles={files.map((file, index) => index === 0 ? { ...file, linesAdded: 7 } : file)} />);
            expect(coverage).toMatchObject({ fileCount: paths.length, added: paths.length + 6, removed: 0 });
            expect(screen.tree.root.findByType(DiffFilesListView).props.files).toHaveLength(paths.length);
            await screen.unmount();
        } finally { maps.mockRestore(); reductions.mockRestore(); }
    });
});
