import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { SPECIMEN_ANALYSIS_COMPLETE, SPECIMEN_COMPARISON, SPECIMEN_WALKTHROUGH } from '@/components/dev/changes/walkthroughSpecimenFixture';
import { buildWalkthroughReading } from './walkthroughReading';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { diffHunkNoteAnchors } from '@/components/ui/code/diff/diffHunkNoteAnchors';
import type { ScmComparison } from '@happier-dev/protocol';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

it('renders a many-hunk reading without traversing global stops or whole-file references per note', async () => {
    const { WalkthroughExplainNotes } = await import('./WalkthroughExplainNotes');
    const path = 'src/many.ts';
    const occurrences = Array.from({ length: 240 }, (_, index) => ({
        id: `change-${index}`, alias: `c${index}`, path, position: index,
        before: { startLine: index * 10 + 1, lineCount: 1 },
        after: { startLine: index * 10 + 1, lineCount: 1 },
    }));
    const comparison: ScmComparison = { ...SPECIMEN_COMPARISON, inventory: { state: 'complete', reasons: [], files: [{
        path, changeKind: 'modified', binary: false, generated: false, lockfile: false, occurrences,
        evidence: { state: 'available', unifiedDiff: [
            `diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
            ...occurrences.map((entry) => `@@ -${entry.before.startLine} +${entry.after.startLine} @@\n-before\n+after`),
        ].join('\n') + '\n' },
    }] } };
    const reading = buildWalkthroughReading({ comparison, walkthrough: { state: 'complete', value: {
        title: 'Many hunks', intro: SPECIMEN_WALKTHROUGH.intro, stops: occurrences.map((entry, index) => ({
            id: `stop-${index}`, title: `Change ${index}`, explanationMarkdown: 'First sentence. Additional detail.', changeRefs: [entry.id],
        })), otherChangeRefs: [],
    } }, analysis: null, reviewed: null });
    let stopVisits = 0;
    let referenceVisits = 0;
    const watchedStops = new Proxy(reading.stops, { get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) stopVisits += 1;
        return Reflect.get(target, property, receiver);
    } });
    const watchedHunks = reading.stopIdsByHunk.get(path)!.map((refs) => new Proxy(refs, { get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) referenceVisits += 1;
        return Reflect.get(target, property, receiver);
    } }));
    const watchedReading = { ...reading, stops: watchedStops, stopIdsByHunk: new Map([[path, watchedHunks]]) };
    const screen = await renderScreen(<>{occurrences.map((entry, hunkIndex) => <WalkthroughExplainNotes key={entry.id}
        reading={watchedReading} path={path} hunkIndex={hunkIndex} placement="column" />)}</>);
    expect(screen.findAllHostsByTestId(`walkthrough-explain-${path}`)).toHaveLength(occurrences.length);
    expect({ stopVisits, referenceVisits }).toEqual({ stopVisits: 0, referenceVisits: 0 });
});

it('places only the stops for the requested hunk and deduplicates later hunks in the file', async () => {
    const { WalkthroughExplainNotes } = await import('./WalkthroughExplainNotes');
    const reading = buildWalkthroughReading({ comparison: SPECIMEN_COMPARISON,
        walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH }, analysis: SPECIMEN_ANALYSIS_COMPLETE, reviewed: null });
    const path = SPECIMEN_COMPARISON.inventory.files.find((file) => file.path.endsWith('/SettingsModal.tsx'))!.path;
    const ids = reading.stopIdsByHunk.get(path)!;
    expect(ids.length).toBeGreaterThan(1);
    const notes = await renderScreen(<WalkthroughExplainNotes reading={reading} path={path} hunkIndex={0} placement="column" />);
    const titles = notes.findAll((node) => typeof node.type === 'string').flatMap((node) => node.children.filter((child) => typeof child === 'string'));
    const later = reading.stops.find((stop) => ids.slice(1).some((hunk) => hunk.includes(stop.id)) && !ids[0]!.includes(stop.id))!;
    expect(titles).not.toContain(later.title);
    const diff = SPECIMEN_COMPARISON.inventory.files.find((file) => file.path === path)!.evidence;
    expect(diff.state).toBe('available');
    if (diff.state !== 'available') throw new Error('The authored specimen must have exact patch evidence');
    const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: diff.unifiedDiff });
    const column = diffHunkNoteAnchors(diff.unifiedDiff, 'column');
    const inline = diffHunkNoteAnchors(diff.unifiedDiff, 'inline');
    expect(column.size).toBe(ids.length);
    expect(inline.size).toBe(ids.length);
    for (const [start, hunkIndex] of column) {
        const end = [...inline].find((entry) => entry[1] === hunkIndex)![0];
        const startIndex = lines.findIndex((line) => line.id === start);
        const endIndex = lines.findIndex((line) => line.id === end);
        expect(startIndex).toBeLessThanOrEqual(endIndex);
        expect(lines[startIndex]?.renderIsHeaderLine).toBe(false);
        expect(lines[endIndex]?.renderIsHeaderLine).toBe(false);
        expect(lines.slice(startIndex, endIndex + 1).some((line) => line.id.startsWith('h:'))).toBe(false);
    }
});

it('does not add empty hunk annotations on lines without notes or comments', async () => {
    const { DiffReviewCommentsViewer } = await import('@/components/ui/code/diff/reviewComments/DiffReviewCommentsViewer');
    const screen = await renderScreen(<DiffReviewCommentsViewer filePath="src/a.ts"
        unifiedDiff={'@@ -1 +1 @@\n-before\n+after\n'} reviewCommentsEnabled={false}
        reviewCommentDrafts={[]} renderAfterLine={() => null} />);
    const viewer = screen.findAll((node) => node.props.mode === 'unified' && node.props.filePath === 'src/a.ts')[0]!;
    const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: '@@ -1 +1 @@\n-before\n+after\n' });
    for (const line of lines) expect(viewer.props.renderAfterLine(line)).toBeNull();
});
