import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { ChangedFilesReviewNavigation as Navigation } from './ChangedFilesReviewNavigation';
import { useHunkReviewController } from './hunkReview/useHunkReviewController';
import { buildDiffHunkTable } from '@/components/ui/code/diff/hunks/buildDiffHunkTable';
import { createChangedFilesReviewDiffStateSource } from './ChangedFilesReviewDiffStore';
import { installFilesContentCommonModuleMocks } from './filesContentTestHelpers';

installFilesContentCommonModuleMocks();

function ChangedFilesReviewNavigation(props: Readonly<{
    paths: readonly string[]; activePath: string | null; onFocusPath: (path: string) => void;
    diffStateSource: ReturnType<typeof createChangedFilesReviewDiffStateSource>;
    onFocusLine: (target: { filePath: string; lineId: string } | null) => void;
}>) {
    const path = props.activePath && props.paths.includes(props.activePath) ? props.activePath : props.paths[0] ?? '';
    const controller = useHunkReviewController({ source: { kind: 'live', root: '/repo' }, path,
        unifiedDiff: props.diffStateSource.getDiffState(path).diff, host: null, serverId: null, enabled: false,
        liveFiles: props.paths.map(path => ({ path, unifiedDiff: props.diffStateSource.getDiffState(path).diff,
            pending: props.diffStateSource.getDiffState(path).status !== 'loaded' })),
        onNavigate: cursor => {
            if (cursor.path !== path) { props.onFocusPath(cursor.path); return; }
            const hunk = buildDiffHunkTable({ mode: 'unified', filePath: path, unifiedDiff: props.diffStateSource.getDiffState(path).diff })
                .hunks.find(hunk => hunk.key === cursor.key);
            if (hunk) props.onFocusLine({ filePath: path, lineId: hunk.firstChangeLineId });
        } });
    return <Navigation paths={props.paths} activePath={path} controller={controller} />;
}

describe('ChangedFilesReviewNavigation', () => {
    it('focuses neighboring files and stops at both ends of the current review scope', async () => {
        const visited: string[] = [];
        function Harness() {
            const [activePath, setActivePath] = React.useState<string | null>(null);
            return <ChangedFilesReviewNavigation diffStateSource={createChangedFilesReviewDiffStateSource()} onFocusLine={() => {}} paths={['a.ts', 'b.ts']} activePath={activePath} onFocusPath={(path) => {
                visited.push(path);
                setActivePath(path);
            }} />;
        }
        const screen = await renderScreen(<Harness />);
        expect(screen.findByTestId('scm-review-previous-file')?.props.disabled).toBe(true);
        await act(async () => { screen.findByTestId('scm-review-next-file')?.props.onPress(); });
        expect(visited).toEqual(['b.ts']);
        expect(screen.findByTestId('scm-review-next-file')?.props.disabled).toBe(true);
        await act(async () => { screen.findByTestId('scm-review-previous-file')?.props.onPress(); });
        expect(visited).toEqual(['b.ts', 'a.ts']);
    });

    it('uses the remaining scope when the previously focused file disappears', async () => {
        const visited: string[] = [];
        const screen = await renderScreen(<ChangedFilesReviewNavigation diffStateSource={createChangedFilesReviewDiffStateSource()} onFocusLine={() => {}} paths={['a.ts', 'c.ts']} activePath="removed.ts" onFocusPath={(path) => visited.push(path)} />);
        await act(async () => { screen.findByTestId('scm-review-next-file')?.props.onPress(); });
        expect(visited).toEqual(['c.ts']);
    });
    it('keeps hunk controls in the fixed navigation and targets only the active file', async () => {
        const source = createChangedFilesReviewDiffStateSource();
        const diff = '@@ -1 +1 @@\n-old\n+new\n@@ -30 +30 @@\n-before\n+after';
        source.setDiffState('a.ts', { status: 'loaded', diff, error: null });
        source.setDiffState('b.ts', { status: 'loaded', diff, error: null });
        const targets: Array<{ filePath: string; lineId: string }> = [];
        const onFocusLine = (target: { filePath: string; lineId: string } | null) => { if (target) targets.push(target); };
        const screen = await renderScreen(<ChangedFilesReviewNavigation paths={['a.ts']} activePath="a.ts" onFocusPath={() => {}} diffStateSource={source} onFocusLine={onFocusLine} />);
        expect(screen.findByTestId('scm-review-next-hunk')).toBeTruthy();
        await act(async () => { screen.findByTestId('scm-review-next-hunk')?.props.onPress(); });
        await act(async () => { screen.findByTestId('scm-review-next-hunk')?.props.onPress(); });
        expect(targets.at(-1)).toEqual({ filePath: 'a.ts', lineId: 'r:4' });
        expect(screen.findByTestId('scm-review-next-hunk')?.props.disabled).toBe(true);
        await act(async () => screen.tree.update(<ChangedFilesReviewNavigation paths={['a.ts', 'b.ts']} activePath="b.ts" onFocusPath={() => {}} diffStateSource={source} onFocusLine={onFocusLine} />));
        expect(screen.findByTestId('scm-review-previous-hunk')?.props.disabled).toBe(true);
        await act(async () => { screen.findByTestId('scm-review-next-hunk')?.props.onPress(); });
        expect(targets.at(-1)).toEqual({ filePath: 'b.ts', lineId: 'r:4' });
    });

});
