import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReviewUnits } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { createScmReviewedMarksRecordPort, ScmReviewedMarksRecordSchema,
    type ScmReviewedMarksRecord } from '@happier-dev/protocol/scm/reviewedMarks';

import { createThemeFixture, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries,
    prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { scmFileStatusFromChange } from '@/scm/scmStatusFiles';

installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { ChangedFilesReview } = await import('./ChangedFilesReview');
const { DiffFilesListView } = await import('@/components/ui/code/diff/DiffFilesListView');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => { await standardCleanup(); await fixture?.dispose(); fixture = undefined; });

describe('Review bodies follow their own file', () => {
    it('redraws no other mounted body when one file\'s diff loads or one change is kept, and renumbers only change rows', async () => {
        // PROD #98 (60,308 files): every mounted body redrew on each diff landing and hunk publish (20–38k renders per scroll step).
        fixture = await createSessionFilesViewFixture();
        const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
        const patchFor = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new ${path}\n`;
        const files = paths.map(path => scmFileStatusFromChange({ path, changeKind: 'modified', added: 1, removed: 1 }));
        let releaseFirst!: () => void;
        const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
        const fetchUnifiedDiffForPath = async ({ path }: Readonly<{ path: string }>) => {
            if (path === paths[0]) await firstReleased;
            return { success: true as const, diff: patchFor(path) };
        };
        const keys = paths.flatMap(path => buildReviewUnits(path, undefined, patchFor(path)).map(unit => unit.key));
        let record: ScmReviewedMarksRecord | null = null;
        const port = createScmReviewedMarksRecordPort({ source: { repositoryRootPath: '/workspace', source: { kind: 'workingTree' },
            changeKeys: keys }, transport: {
            read: async () => ({ value: record, version: record ? 1 : -1 }),
            compareAndSet: async value => { record = ScmReviewedMarksRecordSchema.parse(value); return { success: true, version: 1 }; },
        } });
        const marks = { get record() { return record; }, pending: false, unavailableReason: null,
            setReviewed: port.setReviewed, setReviewedKeys: port.setReviewedKeys, clear: port.clear };
        const hunkReview = { source: { kind: 'live' as const, root: '/workspace' }, host: null, serverId: null, marks };
        const props = { sessionId: fixture.session.id, workspaceScope: fixture.scope, theme: createThemeFixture(),
            snapshot: fileViewSnapshot(), changedFilesViewMode: 'repository' as const, allRepositoryChangedFiles: files,
            sessionAttributedFiles: [], repositoryOnlyFiles: [], maxFiles: 25, maxChangedLines: 2000, onFilePress() {},
            fetchUnifiedDiffForPath, hunkReview };
        const screen = await fixture.render(<ChangedFilesReview {...props} />);
        const frame = (path: string) => screen.findHostByTestId(`scm-review-diff-${path.replace('/', '_')}`)?.props;
        // The change rows (DiffHunkRow, a memo): one instance per drawn row.
        const changeRows = () => [...new Set(screen.tree.root.findAll(node => node.props.hunk !== undefined
            && node.props.review !== undefined && node.props.anchorRef === undefined).map(node => node.props))]
            .map(rowProps => screen.tree.root.find(node => node.props === rowProps));
        type Node = (typeof screen.tree.root);
        const textOf = (node: Node | string): string => typeof node === 'string' ? node : node.children.map(textOf).join('');
        const changeLabels = () => changeRows().map(textOf);
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('new src/d.ts'));
            expect(changeLabels().map(text => /Change \d+/.exec(text)?.[0])).toEqual(['Change 1', 'Change 2', 'Change 3']);
            const renderer = screen.tree.root.findByType(DiffFilesListView).props.renderInlineUnifiedDiff;
            const quiet = paths.slice(1).map(frame);
            await act(async () => { releaseFirst(); await firstReleased; });
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('new src/a.ts'));
            expect.soft(screen.tree.root.findByType(DiffFilesListView).props.renderInlineUnifiedDiff,
                'the per-file renderer keeps its identity when another file loads').toBe(renderer);
            expect.soft(paths.slice(1).map((path, index) => frame(path) === quiet[index]),
                'loaded bodies do not redraw for another file\'s diff').toEqual([true, true, true]);
            expect(changeLabels().map(text => /Change \d+/.exec(text)?.[0])).toEqual(['Change 1', 'Change 2', 'Change 3', 'Change 4']);

            const before = paths.map(frame);
            const row = changeRows()[2]!;
            await act(async () => { row.props.review.actions.keep(row.props.hunk); });
            await screen.update(fixture.wrap(<ChangedFilesReview {...props} hunkReview={{ ...hunkReview, marks: { ...marks } }} />));
            expect(changeRows()[2]!.props.review.stateOf(row.props.hunk)).toBe('kept');
            expect(frame(paths[2]!)).not.toBe(before[2]);
            expect.soft([0, 1, 3].map(index => frame(paths[index]!) === before[index]), 'Keep on one file redraws only that body')
                .toEqual([true, true, true]);

            // A theme switch still restyles every body.
            const theme = props.theme;
            const switched = { ...theme, colors: { ...theme.colors, border: { ...theme.colors.border, default: '#123456' } } };
            await screen.update(fixture.wrap(<ChangedFilesReview {...props} theme={switched} hunkReview={{ ...hunkReview, marks: { ...marks } }} />));
            const borderColors = (path: string) => screen.findHostByTestId(`scm-review-diff-${path.replace('/', '_')}`)!
                .findAll(node => typeof node.type === 'string').map(node => [node.props.style].flat(Infinity)
                    .find(style => style && typeof style === 'object' && 'borderColor' in style)?.borderColor).filter(Boolean);
            for (const path of paths) expect(borderColors(path)).toContain('#123456');
        } finally { await screen.unmount(); }
    });
});
