/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { buildReviewUnits } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { createScmReviewedMarksRecordPort, ScmReviewedMarksRecordSchema,
    type ScmReviewedMarksRecord } from '@happier-dev/protocol/scm/reviewedMarks';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createScmFileViewedOperations } from '@/sync/ops/scmDiffSummary/fileViewed';
import { useHunkReviewController } from './useHunkReviewController';
import { buildChangedFilesReviewFileIndex } from '../changedFilesReviewFileIndex';
import { useScmFileViewedFile } from '@/components/sessions/files/comparison/useScmFileViewedState';
import type { DiffViewerHunks } from '@/components/ui/code/diff/diffViewerTypes';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
afterEach(standardCleanup);
const patch = '@@ -1,3 +1,3 @@\n-old\n+new\n middle\n-before\n+after\n';
const actions = { read: { action: { pluginId: 'example.forge', localId: 'read-viewed' } },
    set: { action: { pluginId: 'example.forge', localId: 'set-viewed' } } };

it('retains the source file-review model while an opened PR has no bound Account', async () => {
    const comparison = ScmComparisonSchema.parse({ id: 'pr-capture', source: { kind: 'pullRequest', locator: {
        providerId: 'example.forge', repository: 'example/repo', number: 17, fileViewedActions: actions,
    } }, repository: { rootPath: '/repo' }, endpoints: { after: 'head' }, freshness: 'current',
    inventory: { state: 'complete', reasons: [], files: [{ path: 'a.ts', changeKind: 'modified',
        binary: false, generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: patch },
        occurrences: [{ id: 'first', alias: 'first', path: 'a.ts', position: 0,
            before: { startLine: 1, lineCount: 3 }, after: { startLine: 1, lineCount: 3 } }],
    }] } });
    let record: ScmReviewedMarksRecord | null = null;
    const port = createScmReviewedMarksRecordPort({ comparison, transport: {
        read: async () => ({ value: record, version: record ? 0 : -1 }),
        compareAndSet: async value => { record = ScmReviewedMarksRecordSchema.parse(value); return { success: true, version: 0 }; },
    } });
    await port.setReviewedKeys(buildReviewUnits('a.ts', undefined, patch).map(unit => unit.key), true);
    const marks = { get record() { return record; }, pending: false, unavailableReason: null,
        setReviewed: port.setReviewed, clear: port.clear, setReviewedKeys: port.setReviewedKeys };
    let controller!: ReturnType<typeof useHunkReviewController>;
    function Review() {
        controller = useHunkReviewController({ source: { kind: 'captured', comparison },
            path: 'a.ts', unifiedDiff: patch, host: null, serverId: null, marks });
        return null;
    }
    await renderScreen(<Review />);
    expect(controller.strip).toMatchObject({ fileReviewKind: 'sourceViewed', fileCountsKnown: false,
        fileComplete: false, canKeepAll: false });
});

it('uses source Viewed for whole files without writing Keep keys and retains unchanged Keep on dismissal', async () => {
    const units = buildReviewUnits('a.ts', undefined, patch);
    const comparison = ScmComparisonSchema.parse({ id: 'capture', source: { kind: 'session', sessionId: 's1' },
        repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: ['a.ts', 'b.ts'].map(path => ({
            path, changeKind: 'modified', beforeBlobId: 'before', binary: false, generated: false, lockfile: false,
            evidence: { state: 'available', unifiedDiff: patch }, occurrences: [{ id: `${path}:first`, alias: `${path}:first`, path, position: 0,
                before: { startLine: 1, lineCount: 3 }, after: { startLine: 1, lineCount: 3 } }],
        })) } });
    let dismissed = false;
    const remoteWrites: string[] = [];
    const viewed = createScmFileViewedOperations({ actions,
        execute: async invocation => {
            if (invocation.action.localId === actions.read.action.localId) return { kind: 'ready', headOid: 'head', files: [
                { path: 'a.ts', state: dismissed ? 'dismissed' : 'unviewed' }, { path: 'b.ts', state: 'viewed' },
            ] };
            const input = invocation.input as { path: string; viewed: boolean };
            remoteWrites.push(input.path);
            return { kind: 'ready', path: input.path, state: input.viewed ? 'viewed' : 'unviewed' };
        } });
    await viewed.refresh();
    let controller!: ReturnType<typeof useHunkReviewController>;
    let record: ScmReviewedMarksRecord | null = null;
    let version = -1;
    let kvWrites = 0;
    const port = createScmReviewedMarksRecordPort({ comparison, transport: {
        read: async () => ({ value: record, version }),
        compareAndSet: async value => {
            record = ScmReviewedMarksRecordSchema.parse(value);
            version += 1;
            kvWrites += 1;
            return { success: true, version };
        },
    } });
    await port.setReviewedKeys([units[0]!.key], true);
    const initialRecord = record;
    const initialWrites = kvWrites;
    const marks = { get record() { return record; }, pending: false, unavailableReason: null,
        setReviewed: port.setReviewed, clear: port.clear, setReviewedKeys: port.setReviewedKeys };
    function Review() {
        controller = useHunkReviewController({ source: { kind: 'captured', comparison }, fileViewed: viewed,
            path: 'a.ts', unifiedDiff: patch, host: null, serverId: null, marks });
        return null;
    }
    await renderScreen(<Review />);
    expect(controller.strip).toMatchObject({ fileReviewKind: 'sourceViewed', fileComplete: false, filesLeft: 1, canKeepAll: false });
    await act(async () => { await controller.setFileViewed('a.ts', true); });
    expect(controller.strip).toMatchObject({ fileComplete: true, filesLeft: 0 });
    expect(record).toBe(initialRecord);
    await act(async () => controller.keepAll());
    expect(kvWrites).toBe(initialWrites);
    expect(remoteWrites).toEqual(['a.ts']);
    dismissed = true;
    await act(async () => { await viewed.refresh(); });
    expect(controller.fileViewedState.state).toBe('dismissed');
    expect(controller.strip).toMatchObject({ fileComplete: false, filesLeft: 1 });
    expect(controller.changeActionsForKey(units[0]!.key)?.state).toBe('kept');
    expect(controller.changeActionsForKey(units[1]!.key)?.state).toBe('open');
    await act(async () => controller.changeActionsForKey(units[1]!.key)?.keep());
    expect(record).toMatchObject({ reviewedChangeKeys: units.map(unit => unit.key) });
    expect(remoteWrites).toEqual(['a.ts']);
    viewed.retire();
});

it('updates one mounted file at 55,559 files without inventory reads or unrelated hunk-row renders', async () => {
    let pathReads = 0;
    let wholeListComputations = 0;
    const liveFiles = Array.from({ length: 55_559 }, (_, index) => ({
        get path() { pathReads += 1; return `src/file-${index}.ts`; },
        unifiedDiff: index === 0 ? patch : '', pending: index !== 0,
    }));
    const inventory = buildChangedFilesReviewFileIndex(liveFiles.map(file => ({ fullPath: file.path })));
    const fileIndex = { ...inventory,
        get orderedFileIndices() { wholeListComputations += 1; return inventory.orderedFileIndices; },
    };
    let acknowledge: (() => void) | undefined;
    const viewed = createScmFileViewedOperations({ actions,
        execute: async invocation => {
            if (invocation.action.localId === actions.read.action.localId) return { kind: 'ready', headOid: 'head',
                files: liveFiles.map(file => ({ path: file.path, state: 'unviewed' })) };
            const input = invocation.input as { path: string; viewed: boolean };
            return new Promise(resolve => { acknowledge = () => resolve({ kind: 'ready', path: input.path,
                state: input.viewed ? 'viewed' : 'unviewed' }); });
        } });
    await viewed.refresh();
    const renders = new Map<string, number>();
    const Row = React.memo(({ path, hunks: _hunks }: { path: string; hunks: DiffViewerHunks }) => {
        useScmFileViewedFile(viewed, path);
        renders.set(path, (renders.get(path) ?? 0) + 1);
        return null;
    });
    const mountedPaths = Array.from({ length: 25 }, (_, index) => `src/file-${index}.ts`);
    const marks = { record: null, pending: false, unavailableReason: null, setReviewed() {}, setReviewedKeys() {}, clear() {} };
    let controller!: ReturnType<typeof useHunkReviewController>;
    function Review() {
        controller = useHunkReviewController({ source: { kind: 'live', root: '/repo' }, path: 'src/file-0.ts', unifiedDiff: patch,
            liveFiles, fileIndex, fileViewed: viewed, host: null, serverId: null, marks });
        return <>{mountedPaths.map(path => <Row key={path} path={path} hunks={controller.hunksForPath(path)} />)}</>;
    }
    await renderScreen(<Review />);
    const before = mountedPaths.map(path => controller.hunksForPath(path));
    pathReads = 0;
    wholeListComputations = 0;
    renders.clear();
    let mutation = Promise.resolve(false);
    await act(async () => { mutation = controller.setFileViewed('src/file-1.ts', true); });
    expect(renders.get('src/file-1.ts')).toBe(1);
    await act(async () => { acknowledge?.(); await mutation; });
    expect(controller.strip.nextFile).toBe('src/file-2.ts');
    expect(controller.strip.filesLeft).toBe(55_558);
    expect(renders.get('src/file-1.ts')).toBe(2); // Pending, then acknowledged; only this row consumes both.
    expect([...renders.keys()]).toEqual(['src/file-1.ts']);
    expect(pathReads).toBe(0);
    expect(wholeListComputations).toBe(0);
    for (const [index, path] of mountedPaths.entries()) expect(controller.hunksForPath(path)).toBe(before[index]);
    viewed.retire();
});
