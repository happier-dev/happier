/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createScmReviewedMarksRecordPort,
  ScmReviewedMarksRecordSchema,
} from '@happier-dev/protocol/scm/reviewedMarks';
import type { ScmReviewedMarksRecord } from '@happier-dev/protocol/scm/reviewedMarks';
import { buildReviewUnits } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import * as scmComparison from '@happier-dev/protocol/scm/comparison';
import type { ScmWorkingEntry } from '@happier-dev/protocol/scm';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storage';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { useReviewKeyboard } from './useReviewKeyboard';
import { useHunkReviewController, type HunkReviewSource } from './useHunkReviewController';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import { createScmReviewedMarksOperationsWithTransport } from '@/dev/testkit/harness/scmActionTransport';
import { buildChangedFilesReviewFileIndex } from '../changedFilesReviewFileIndex';
import { buildEditorChangeMarkers } from '@/components/ui/code/editor/editorChangeMarkers';
import { useEditorChangeMarkers } from '@/components/ui/code/editor/useEditorChangeMarkers';
import type {
  EditorDecoration,
  TextEditorHandle,
} from '@/components/ui/code/editor/codeEditorTypes';
import type { DiffHunkInfo, DiffViewerHunks } from '@/components/ui/code/diff/diffViewerTypes';
import { ChangedFilesReviewDiffBlock } from '../ChangedFilesReviewDiffBlock';
import { createChangedFilesReviewDiffStateSource } from '../ChangedFilesReviewDiffStore';
import { DiffReviewCommentsViewer } from '@/components/ui/code/diff/reviewComments/DiffReviewCommentsViewer';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);

const initialSettings = storage.getState().settings;
afterEach(() => {
  standardCleanup();
  storage.setState({ settings: initialSettings });
});
const patch = '@@ -1,3 +1,3 @@\n-old\n+new\n middle\n-before\n+after\n';

describe('hunk review through the shared keyboard and Account port', () => {
  it('marks and unmarks only the displayed file units through the existing Account record', async () => {
    const aKeys = buildReviewUnits('a.ts', undefined, patch).map(unit => unit.key);
    const bKeys = buildReviewUnits('b.ts', undefined, patch).map(unit => unit.key);
    const kv = createAccountKvHttpFixture();
    const operations = createScmReviewedMarksOperationsWithTransport({ source: { repositoryRootPath: '/repo',
      source: { kind: 'workingTree' }, changeKeys: [...aKeys, ...bKeys] }, credentials: { token: 'file-marks' },
      encryption: null, shouldContinue: () => true, request: async (path, init) => path.endsWith('/currentness')
        ? Response.json({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 })
        : await kv.handleFetch(new URL(path, 'https://file-marks.test'), init) ?? Response.json({}, { status: 404 }) });
    await operations.read();
    const marks = { get record() { return operations.recordSource.getSnapshot(); }, recordSource: operations.recordSource,
      pending: false, unavailableReason: null, setReviewed() {}, clear() {},
      setReviewedKeys: (keys: readonly string[], reviewed: boolean) => { void operations.setReviewedKeys(keys, reviewed); } };
    let controller!: ReturnType<typeof useHunkReviewController>;
    let renders = 0;
    function Review({ active }: { active: boolean }) {
      renders++;
      controller = useHunkReviewController({ source: { kind: 'live', root: '/repo' }, path: 'a.ts', unifiedDiff: patch,
        liveFiles: ['a.ts', 'b.ts'].map(path => ({ path, unifiedDiff: patch })), host: null, serverId: null, active, marks });
      return null;
    }
    const screen = await renderScreen(<Review active />);
    try {
      await act(async () => controller.fileReviewForPath('a.ts')?.setReviewed(true));
      await vi.waitFor(() => expect(operations.getSnapshot().record?.reviewedChangeKeys).toEqual(aKeys));
      expect(controller.fileReviewForPath('a.ts')?.reviewed).toBe(true);
      expect(controller.fileReviewForPath('b.ts')?.reviewed).toBe(false);
      await act(async () => controller.fileReviewForPath('a.ts')?.setReviewed(false));
      await vi.waitFor(() => expect(operations.getSnapshot().record?.reviewedChangeKeys).toEqual([]));
      expect(controller.fileReviewForPath('a.ts')?.reviewed).toBe(false);
      await screen.update(<Review active={false} />);
      const hiddenRenders = renders;
      await act(async () => { await operations.setReviewedKeys(aKeys, true); });
      expect(renders).toBe(hiddenRenders);
      await screen.update(<Review active />);
      expect(controller.fileReviewForPath('a.ts')?.reviewed).toBe(true);
    } finally {
      await screen.unmount();
      operations.retire();
    }
  });

  it('does no inventory classification or sorting on 55,559-file renders and cursor moves, and reorders real changes', async () => {
    // REVIEWRAIL #44 had 55,559 changed files. Observe the real classifier, never replace its policy.
    const classifications = vi.spyOn(scmComparison, 'classifyScmChangePath');
    const sorts = vi.spyOn(Array.prototype, 'sort');
    let liveFiles = Array.from({ length: 55_559 }, (_, index) => ({
      path: index === 1 ? 'yarn.lock' : `src/file-${index}.ts`,
      unifiedDiff: index === 0 ? patch : '', pending: index !== 0,
    }));
    let fileIndex = buildChangedFilesReviewFileIndex(liveFiles.map(file => ({ fullPath: file.path })));
    let path = liveFiles[0]!.path;
    let controller!: ReturnType<typeof useHunkReviewController>;
    const marks = { record: null, pending: false, unavailableReason: null,
      setReviewed() {}, setReviewedKeys() {}, clear() {} };
    function Review() {
      controller = useHunkReviewController({ source: { kind: 'live', root: '/repo' },
        liveFiles, fileIndex, path, unifiedDiff: path === liveFiles[0]!.path ? patch : '',
        host: null, serverId: null, marks, onNavigate: cursor => { path = cursor.path; } });
      return null;
    }
    try {
      const screen = await renderScreen(<Review />);
      expect(classifications.mock.calls.length).toBeLessThanOrEqual(liveFiles.length);
      classifications.mockClear();
      sorts.mockClear();
      for (let count = 0; count < 4; count += 1) await screen.update(<Review />);
      expect(controller.strip.nextFile).toBe('src/file-2.ts');
      await act(async () => controller.nextFile());
      expect(controller.cursor?.path).toBe('src/file-2.ts');
      expect(controller.strip.nextFile).toBe('src/file-3.ts');
      expect(classifications).not.toHaveBeenCalled();
      expect(sorts.mock.contexts.filter(value => Array.isArray(value) && value.some(item =>
        item && typeof item === 'object' && 'keys' in item && 'path' in item))).toHaveLength(0);
      path = liveFiles[0]!.path;
      await screen.update(<Review />);
      liveFiles = [liveFiles[0]!, { path: 'src/now-source.ts', unifiedDiff: '', pending: true }, ...liveFiles.slice(2)];
      fileIndex = buildChangedFilesReviewFileIndex(liveFiles.map(file => ({ fullPath: file.path })));
      await screen.update(<Review />);
      expect(controller.strip.nextFile).toBe('src/now-source.ts');
      expect(classifications.mock.calls.length).toBeLessThanOrEqual(liveFiles.length);
      classifications.mockClear();
      await act(async () => controller.nextFile());
      expect(controller.cursor?.path).toBe('src/now-source.ts');
      expect(controller.strip.nextFile).toBe('src/file-2.ts');
      expect(classifications).not.toHaveBeenCalled();
    } finally {
      classifications.mockRestore();
      sorts.mockRestore();
    }
  });
  it('reads no working entry per Discard decision across 55,559 changed files, and still refuses a hunk Discard on an added file', async () => {
    // Cold #47 capture: restrictionFor searched every working entry per mounted row and per render (2,875 ms).
    let entryPathReads = 0;
    const count = 55_559;
    const liveFiles = Array.from({ length: count }, (_, index) => ({ path: `src/file-${index}.ts`, unifiedDiff: patch, pending: false }));
    const liveEntries = liveFiles.map((file, index) => ({
      get path() { entryPathReads += 1; return file.path; },
      kind: index === count - 1 ? 'added' as const : 'modified' as const, hasIncludedDelta: false,
    }));
    const fileIndex = buildChangedFilesReviewFileIndex(liveFiles.map(file => ({ fullPath: file.path })));
    const path = liveFiles[count - 2]!.path;
    let controller!: ReturnType<typeof useHunkReviewController>;
    const marks = { record: null, pending: false, unavailableReason: null, setReviewed() {}, setReviewedKeys() {}, clear() {} };
    function Review() {
      controller = useHunkReviewController({ source: { kind: 'live', root: '/repo' }, liveFiles, liveEntries, fileIndex, path,
        unifiedDiff: patch, host: null, serverId: null, marks, onDiscard: () => {} });
      return null;
    }
    const screen = await renderScreen(<Review />);
    entryPathReads = 0;
    for (let render = 0; render < 4; render += 1) await screen.update(<Review />);
    // The rows a screen mounts near the end of the inventory.
    const mountedRows = liveFiles.slice(-25).map(file => controller.hunksForPath(file.path));
    expect(entryPathReads).toBe(0);
    expect(controller.discardCurrent).toBeTypeOf('function');
    expect(mountedRows[23]!.actions?.discard).toBeTypeOf('function');
    expect(mountedRows[24]!.actions?.discard).toBeUndefined();
  });
  it('retains kept changes offline while blocking every Keep and Reset entry point, then recovers', async () => {
    const units = buildReviewUnits('a.ts', undefined, patch);
    let record: ScmReviewedMarksRecord | null = null;
    const port = createScmReviewedMarksRecordPort({ source: { repositoryRootPath: '/repo', source: { kind: 'workingTree' },
      changeKeys: units.map(unit => unit.key) }, transport: {
      read: async () => ({ value: record, version: record ? 1 : -1 }),
      compareAndSet: async value => { record = ScmReviewedMarksRecordSchema.parse(value); return { success: true, version: 1 }; },
    } });
    await port.setReviewedKeys([units[0]!.key], true);
    const before = record;
    let unavailable: string | null = 'Machine offline. Retry when connected.';
    let review!: ReturnType<typeof useHunkReviewController>;
    function Review() {
      review = useHunkReviewController({ source: { kind: 'live', root: '/repo' }, path: 'a.ts', unifiedDiff: patch,
        host: { machineId: 'machine' }, serverId: null, writeUnavailableReason: unavailable,
        marks: { record, pending: false, unavailableReason: null, setReviewed: () => {},
          setReviewedKeys: (keys, reviewed) => { void port.setReviewedKeys(keys, reviewed); }, clear: () => { void port.clear(); } },
      });
      return null;
    }
    const screen = await renderScreen(<Review />);
    expect(review.changeActionsForKey(units[0]!.key)?.state).toBe('kept');
    expect(review.changeActionsForKey(units[0]!.key)?.disabledReason('keep')).toBe(unavailable);
    await act(async () => { review.changeActionsForKey(units[0]!.key)?.keep(); review.keepAll(); review.reset(); });
    expect(record).toBe(before);
    unavailable = null;
    await screen.update(<Review />);
    await act(async () => { review.changeActionsForKey(units[1]!.key)?.keep(); });
    expect(record).toMatchObject({ reviewedChangeKeys: units.map(unit => unit.key) });
  });
  it('publishes no new per-file hunk model for 20 unrelated editor draft renders and retains the displayed action authority', async () => {
    let controller!: ReturnType<typeof useHunkReviewController>;
    let renders = 0;
    let generation = 0;
    let contentHash = 'saved-v1';
    const asked: number[] = [];
    const discarded: { generation: number; expectedHash?: string }[] = [];
    const onAsk = () => { asked.push(generation); };
    let onDiscard = (target: { expectedHash?: string }) => { discarded.push({ generation: 0, expectedHash: target.expectedHash }); };
    const setReviewedKeys = () => {};
    const Consumer = React.memo((_props: { hunks: DiffViewerHunks }) => { renders += 1; return null; });
    const liveFiles = Array.from({ length: 300 }, (_, index) => ({ path: `file-${index}.ts`, unifiedDiff: patch }));
    const liveEntries = [{ path: liveFiles[0]!.path, kind: 'modified' as const, hasIncludedDelta: false }];
    function Review() {
      controller = useHunkReviewController({
        source: { kind: 'live', root: '/repo' }, path: liveFiles[0]!.path, unifiedDiff: patch,
        liveFiles, liveEntries, contentHash, host: null, serverId: null,
        onAsk, onDiscard,
        marks: { record: null, pending: false, unavailableReason: null, setReviewed: () => {}, clear: () => {}, setReviewedKeys },
      });
      return <Consumer hunks={controller.hunksForPath(liveFiles[0]!.path)} />;
    }
    const screen = await renderScreen(<Review />);
    const initial = controller.hunks;
    renders = 0;
    for (generation = 1; generation <= 20; generation += 1) await screen.update(<Review />);
    expect(renders).toBe(0);
    expect(controller.hunksForPath(liveFiles[0]!.path)).toBe(initial);
    generation = 20;
    await act(async () => initial.actions?.ask?.({ key: controller.reviewUnits[0]!.key } as DiffHunkInfo));
    expect(asked).toEqual([20]);
    contentHash = 'saved-v2';
    generation = 21;
    onDiscard = target => { discarded.push({ generation: 21, expectedHash: target.expectedHash }); };
    await screen.update(<Review />);
    expect(renders).toBe(1);
    expect(controller.hunks).not.toBe(initial);
    // An old row retains both its displayed hash and its authorizing action producer.
    await act(async () => initial.actions?.discard?.({ key: controller.reviewUnits[0]!.key } as DiffHunkInfo));
    expect(discarded).toEqual([{ generation: 0, expectedHash: 'saved-v1' }]);
  });
  it('opens a deferred captured file when moving past the last loaded change', async () => {
    const unifiedDiff = '@@ -1 +1 @@\n-old\n+new\n';
    let comparison = ScmComparisonSchema.parse({ id: 'capture', source: { kind: 'session', sessionId: 's1' },
      repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [],
        files: ['a.ts', 'b.ts'].map(path => ({ path, changeKind: 'modified', binary: false,
          generated: false, lockfile: false,
          evidence: path === 'a.ts' ? { state: 'available', unifiedDiff }
            : { state: 'deferred', reason: 'Opened-file evidence has not been read' },
          occurrences: [{ id: `${path}:first`, alias: `${path}:first`, path, position: 0,
            before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
        })) } });
    const port = createScmReviewedMarksRecordPort({ comparison, transport: {
      read: async () => ({ value: null, version: -1 }),
      compareAndSet: async () => ({ success: true, version: 0 }),
    } });
    const marks = { record: null, pending: false, unavailableReason: null,
      setReviewed: port.setReviewed, setReviewedKeys: port.setReviewedKeys, clear: port.clear };
    let controller!: ReturnType<typeof useHunkReviewController>;
    function Review() {
      const [path, setPath] = React.useState('a.ts');
      controller = useHunkReviewController({ source: { kind: 'captured', comparison }, path,
        unifiedDiff: comparison.inventory.files.find(file => file.path === path)?.evidence.unifiedDiff ?? '',
        host: null, serverId: null, fileViewed: null, marks, onNavigate: cursor => setPath(cursor.path) });
      return null;
    }
    const screen = await renderScreen(<Review />);
    expect(controller.reviewUnits).toHaveLength(1);
    await act(async () => controller.next());
    expect(controller.cursor).toEqual({ path: 'b.ts', key: null });
    comparison = ScmComparisonSchema.parse({ ...comparison, inventory: { ...comparison.inventory,
      files: comparison.inventory.files.map(file => ({ ...file, evidence: { state: 'available', unifiedDiff } })) } });
    await screen.update(<Review />);
    expect(controller.reviewUnits).toHaveLength(1);
    expect(controller.cursor?.path).toBe('b.ts');
    expect(controller.cursor?.key).toBe(controller.reviewUnits[0]!.key);
    await act(async () => controller.next());
    expect(controller.cursor?.path).toBe('a.ts');
  });
  it('preserves the published review model through a diff block repaint', async () => {
    const source = createChangedFilesReviewDiffStateSource();
    source.setDiffState('a.ts', { status: 'loaded', diff: patch, error: null });
    const hunks: DiffViewerHunks = { currentIndex: 0 };
    const drafts: readonly [] = [];
    const props = { sessionId: 's1', snapshotSignature: 'sig', filePath: 'a.ts', diffStateSource: source,
      reviewCommentsEnabled: true, reviewCommentDrafts: drafts, hunkReview: hunks };
    const screen = await renderScreen(<ChangedFilesReviewDiffBlock {...props} theme={createThemeFixture()} />);
    const published = screen.tree.root.findByType(DiffReviewCommentsViewer).props.hunks;
    await screen.update(<ChangedFilesReviewDiffBlock {...props} theme={createThemeFixture()} />);
    expect(screen.tree.root.findByType(DiffReviewCommentsViewer).props.hunks).toBe(published);
  });
  it.each([
    ['live', 'modified', true, 'staged'],
    ['live', 'renamed', false, 'renamed_or_copied'],
    ['live', 'copied', false, 'renamed_or_copied'],
    ['live', 'untracked', false, 'untracked'],
    ['live', 'added', true, 'added_file'],
    ['captured', 'modified', true, 'staged'],
    ['captured', 'renamed', false, 'renamed_or_copied'],
    ['captured', 'copied', false, 'renamed_or_copied'],
    ['captured', 'untracked', false, 'untracked'],
    ['captured', 'added', false, 'added_file'],
  ] as const)('projects %s %s eligibility before Discard without disabling Keep, Ask or navigation', async (kind, changeKind, staged, reason) => {
    const comparison = ScmComparisonSchema.parse({ id: 'capture', source: { kind: 'session', sessionId: 's1' },
      repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [{
        path: 'a.ts', changeKind, ...(changeKind === 'added' ? {} : { beforeBlobId: 'before' }),
        binary: false, generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: patch },
        occurrences: [{ id: 'first', alias: 'first', path: 'a.ts', position: 0,
          before: { startLine: 1, lineCount: 3 }, after: { startLine: 1, lineCount: 3 },
          layer: changeKind === 'untracked' ? 'untracked' : staged ? 'staged' : 'unstaged' }],
      }] } });
    const source: HunkReviewSource = kind === 'captured' ? { kind, comparison } : { kind, root: '/repo' };
    const liveEntries: Pick<ScmWorkingEntry, 'path' | 'kind' | 'hasIncludedDelta'>[] = [{ path: 'a.ts', kind: changeKind, hasIncludedDelta: staged }];
    const port = createScmReviewedMarksRecordPort({ source: { repositoryRootPath: '/repo', source: { kind: 'workingTree' },
      changeKeys: buildReviewUnits('a.ts', undefined, patch).map(unit => unit.key) }, transport: {
        read: async () => ({ value: null, version: -1 }), compareAndSet: async () => ({ success: true, version: 0 }),
      } });
    const discarded = vi.fn();
    const asked = vi.fn();
    let controller!: ReturnType<typeof useHunkReviewController>;
    function Review() {
      controller = useHunkReviewController({ source, path: 'a.ts', unifiedDiff: patch, liveEntries,
        host: null, serverId: null, onDiscard: discarded, onAsk: asked, marks: { record: null,
          pending: false, unavailableReason: null, setReviewed: () => {}, clear: () => {},
          setReviewedKeys: (keys, kept) => { void port.setReviewedKeys(keys, kept); } } });
      return null;
    }
    await renderScreen(<Review />);
    const row = { key: controller.reviewUnits[0]!.key } as DiffHunkInfo;
    if (reason === 'added_file') {
      expect(controller.discardCurrent).toBeUndefined();
      expect(controller.hunks.actions?.discard).toBeUndefined();
      expect(controller.changeActionsForKey(row.key)?.discard).toBeUndefined();
    } else {
      expect(controller.hunks.disabledReason?.(row, 'discard')).toBeTruthy();
      await act(async () => { controller.hunks.actions?.discard?.(row); });
      expect(controller.changeActionsForKey(row.key)?.disabledReason('discard')).toBeTruthy();
      await act(async () => { await controller.changeActionsForKey(row.key)?.discard?.(); });
      await act(async () => { controller.discardCurrent?.(); });
    }
    expect(controller.discardUnavailableReason).toBe(reason);
    expect(discarded).not.toHaveBeenCalled();
    expect(controller.hunks.disabledReason?.(row, 'keep')).toBeNull();
    expect(controller.hunks.actions?.keep).toBeTypeOf('function');
    await act(async () => { controller.askCurrent?.(); controller.next(); });
    expect(asked).toHaveBeenCalled();
    expect(controller.currentIndex).toBe(1);
    // A dirty editor transaction is not the on-disk SCM operation and remains available.
    const draft = controller.changeActionsForKey(row.key, { discardInDraft: async () => 'draft reverted' });
    expect(draft?.disabledReason('discard')).toBeNull();
    await act(async () => { expect(await draft?.discard?.()).toBe('draft reverted'); });
  });
  it('binds a tracked gutter change to review actions and reverts dirty text as one undoable edit', async () => {
    const marker = buildEditorChangeMarkers('a.ts', null, patch)[0]!;
    let text = 'inserted\nnew\nmiddle\nafter\n';
    const history: string[] = [];
    let press:
      | ((
          layer: 'change' | 'diagnostic' | 'blame',
          item: EditorDecoration,
        ) => void)
      | undefined;
    let replaceCount = 0;
    // The engine handle is the external editor boundary. The review owner and draft hunk engine stay real.
    const engine: TextEditorHandle = {
      getValue: () => text,
      flushPendingChange: async () => {},
      setDecorations: () => {},
      removeDecoration: () => {},
      onDecorationPress: (callback) => {
        press = callback;
        return () => {
          press = undefined;
        };
      },
      runCommand: (command) => {
        if (typeof command === 'object' && 'replaceDocument' in command) {
          history.push(text);
          text = command.replaceDocument;
          replaceCount += 1;
        } else if (command === 'undo') text = history.pop() ?? text;
      },
    };
    const discardOnDisk = vi.fn();
    const outOfDate = vi.fn();
    let discardDisabledReason: string | null = 'machine offline';
    let reviewed: readonly string[] = [];
    const port = createScmReviewedMarksRecordPort({
      source: {
        repositoryRootPath: '/repo',
        source: { kind: 'workingTree' },
        changeKeys: [marker.key],
      },
      transport: {
        read: async () => ({ value: null, version: -1 }),
        compareAndSet: async (value) => {
          reviewed =
            ScmReviewedMarksRecordSchema.parse(value).reviewedChangeKeys;
          return { success: true, version: 0 };
        },
      },
    });
    let review!: ReturnType<typeof useHunkReviewController>;
    let gutter!: ReturnType<typeof useEditorChangeMarkers>;
    function Review() {
      review = useHunkReviewController({
        source: { kind: 'live', root: '/repo' },
        path: 'a.ts',
        unifiedDiff: patch,
        contentHash: 'saved-hash',
        host: null,
        serverId: null,
        onDiscard: discardOnDisk,
        discardDisabledReason,
        onOutOfDate: outOfDate,
        marks: {
          record: null,
          pending: false, unavailableReason: null,
          setReviewed: () => {},
          clear: () => {},
          setReviewedKeys: (keys, kept) => {
            void port.setReviewedKeys(keys, kept);
          },
        },
      });
      gutter = useEditorChangeMarkers({
        editor: engine,
        active: true,
        seedKey: 'saved-v1',
        markers: [marker],
      });
      return null;
    }
    const screen = await renderScreen(
      <KeyboardShortcutProvider handlers={{}}>
        <Review />
      </KeyboardShortcutProvider>,
    );
    await act(async () => {
      press?.('change', { ...marker, startLine: 2, endLine: 2 });
    });
    expect(gutter.selected).toMatchObject({ key: marker.key, startLine: 2 });
    expect(review.changeActionsForKey).toBeTypeOf('function');
    const actions = review.changeActionsForKey(marker.key, {
      discardInDraft: () => gutter.revertInDraft(gutter.selected!),
    })!;
    expect(actions.disabledReason('discard')).toBeNull();
    await act(async () => {
      actions.keep();
    });
    expect(reviewed).toEqual([marker.key]);
    await act(async () => {
      expect(await actions.discard?.()).toEqual({
        ok: true,
        text: 'inserted\nold\nmiddle\nafter\n',
      });
    });
    expect(text).toBe('inserted\nold\nmiddle\nafter\n');
    expect(replaceCount).toBe(1);
    expect(discardOnDisk).not.toHaveBeenCalled();
    engine.runCommand?.('undo');
    expect(text).toBe('inserted\nnew\nmiddle\nafter\n');
    expect(
      review.changeActionsForKey(marker.key)?.disabledReason('discard'),
    ).toBe('machine offline');
    // A user edit inside the tracked region refuses rather than finding another occurrence or writing disk.
    text = 'inserted\nyours\nmiddle\nafter\n';
    await act(async () => {
      press?.('change', { ...marker, startLine: 2, endLine: 2 });
    });
    const edited = review.changeActionsForKey(marker.key, {
      discardInDraft: () => gutter.revertInDraft(gutter.selected!),
    })!;
    await act(async () => {
      expect(await edited.discard?.()).toEqual({
        ok: false,
        reason: 'moved_on',
      });
    });
    expect(text).toBe('inserted\nyours\nmiddle\nafter\n');
    expect(replaceCount).toBe(1);
    expect(discardOnDisk).not.toHaveBeenCalled();
    expect(review.changeActionsForKey('stale-key')).toBeNull();
    expect(outOfDate).not.toHaveBeenCalled();
    discardDisabledReason = null;
    await screen.update(
      <KeyboardShortcutProvider handlers={{}}>
        <Review />
      </KeyboardShortcutProvider>,
    );
    await act(async () => {
      await review.changeActionsForKey(marker.key)?.discard?.();
    });
    expect(discardOnDisk).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'a.ts',
        changeKey: marker.key,
        expectedHash: 'saved-hash',
      }),
    );
  });
  it('shares row selection, numbering and actions across files', async () => {
    const files = [
      { path: 'a.ts', unifiedDiff: patch },
      { path: 'b.ts', unifiedDiff: patch },
    ];
    let path = 'a.ts';
    let controller!: ReturnType<typeof useHunkReviewController>;
    const keep = vi.fn();
    const discard = vi.fn();
    const ask = vi.fn();
    function Review() {
      const [active, setActive] = React.useState(path);
      path = active;
      controller = useHunkReviewController({
        source: { kind: 'live', root: '/repo' },
        path: active,
        unifiedDiff: patch,
        liveFiles: files,
        host: null,
        serverId: null,
        marks: {
          record: null,
          pending: false, unavailableReason: null,
          setReviewed: () => {},
          setReviewedKeys: keep,
          clear: () => {},
        },
        onNavigate: (cursor) => setActive(cursor.path),
        onDiscard: discard,
        onAsk: ask,
      });
      return null;
    }
    await renderScreen(<Review />);
    // The Review list numbers rows across files; the File page counts changes within the open file.
    expect(controller.strip).toMatchObject({
      current: 1,
      total: 2,
      filesLeft: 2,
    });
    expect(controller.hunksForPath('a.ts').currentIndex).toBe(0);
    expect(controller.hunksForPath('b.ts').currentIndex).toBeNull();
    expect(controller.hunksForPath('b.ts').numbering?.offset()).toBe(2);
    expect(controller.hunksForPath('b.ts').numbering?.total()).toBe(4);
    await act(async () => {
      controller.next();
    });
    await act(async () => {
      controller.nextFile();
    });
    expect(path).toBe('b.ts');
    expect(controller.hunksForPath('a.ts').currentIndex).toBeNull();
    expect(controller.hunksForPath('b.ts').currentIndex).toBe(0);
    expect(controller.strip).toMatchObject({ current: 1, total: 2 });
    await act(async () => {
      controller.keepCurrent();
      controller.discardCurrent?.();
      controller.askCurrent?.();
    });
    const key = buildReviewUnits('b.ts', undefined, patch)[0]!.key;
    expect(keep).toHaveBeenCalledWith([key], true);
    expect(discard).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'b.ts', changeKey: key }),
    );
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'b.ts', changeKey: key }),
    );
  });
  it('phone review follows the reading line without moving the page, and Keep advances to the next open change', async () => {
    const three =
      '@@ -1,5 +1,5 @@\n-one\n+ONE\n a\n-two\n+TWO\n b\n-three\n+THREE\n';
    const keys = buildReviewUnits('a.ts', undefined, three).map(
      (unit) => unit.key,
    );
    let kept: readonly string[] = [keys[1]!];
    let controller!: ReturnType<typeof useHunkReviewController>;
    const navigated = vi.fn();
    function Review() {
      const [record, setRecord] = React.useState<readonly string[]>(kept);
      controller = useHunkReviewController({
        source: { kind: 'live', root: '/repo' },
        path: 'a.ts',
        unifiedDiff: three,
        host: null,
        serverId: null,
        onNavigate: navigated,
        marks: {
          record: {
            reviewedChangeKeys: record,
          } as unknown as ScmReviewedMarksRecord,
          pending: false, unavailableReason: null,
          setReviewed: () => {},
          clear: () => {},
          setReviewedKeys: (next, on) => {
            kept = on
              ? [...record, ...next]
              : record.filter((key) => !next.includes(key));
            setRecord(kept);
          },
        },
      });
      return null;
    }
    await renderScreen(<Review />);
    await act(async () => {
      controller.hunks.onHunks?.(
        buildReviewUnits('a.ts', undefined, three).map((unit, index) => ({
          index,
          hunkIndex: unit.hunkIndex,
          key: unit.key,
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          sectionHeading: '',
          rangeStart: index + 1,
          rangeEnd: index + 1,
          rangeSide: 'new' as const,
          firstChangeLineId: `line-${index}`,
          revealLineId: `line-${index}`,
          changeLineIds: [],
        })),
      );
    });
    const firstReveal = controller.revealHunk?.key;
    expect(firstReveal).toBe(keys[0]);
    // Scrolling to change 3 makes it the bar's target, without asking the page to scroll to it.
    await act(async () => {
      controller.followReadingLine(keys[2]!);
    });
    expect(controller.strip.current).toBe(3);
    expect(controller.currentHunk?.key).toBe(keys[2]);
    expect(controller.revealHunk).toBeNull();
    expect(navigated).not.toHaveBeenCalled();
    // Keep on the bar marks the change it targets, then glides to the next open change (2 is kept, so 1).
    await act(async () => {
      controller.keepCurrentAndAdvance();
    });
    expect(kept).toEqual([keys[1], keys[2]]);
    expect(controller.currentHunk?.key).toBe(keys[0]);
    expect(controller.revealHunk?.key).toBe(keys[0]);
    expect(navigated).toHaveBeenLastCalledWith({ path: 'a.ts', key: keys[0] });
    // The last open change completes the file and the cursor stays.
    await act(async () => {
      controller.keepCurrentAndAdvance();
    });
    expect(controller.strip.fileComplete).toBe(true);
    expect(controller.currentHunk?.key).toBe(keys[0]);
    // Letting a kept change go from its row (the phone long-press menu) makes it the current change, in place.
    const calls = navigated.mock.calls.length;
    await act(async () => {
      controller.hunks.actions?.keep?.({ key: keys[1]! } as DiffHunkInfo);
    });
    expect(kept).not.toContain(keys[1]);
    expect(controller.strip.fileComplete).toBe(false);
    expect(controller.currentHunk?.key).toBe(keys[1]);
    expect(controller.revealHunk).toBeNull();
    expect(navigated).toHaveBeenCalledTimes(calls);
    // An unknown reading-line key is ignored.
    await act(async () => {
      controller.followReadingLine('gone');
    });
    expect(controller.currentHunk?.key).toBe(keys[1]);
  });
  it('R keeps the current change, advances the comparison counter and rejects a stale row', async () => {
    storage.setState({
      settings: {
        ...initialSettings,
        keyboardSingleKeyShortcutsEnabled: true,
        keyboardShortcutOverridesV1: {},
        keyboardShortcutDisabledCommandIdsV1: [],
      },
    });
    let unifiedDiff = patch;
    let root = '/repo';
    let value: unknown = null;
    let version = -1;
    const keys = buildReviewUnits('a.ts', undefined, patch).map(
      (unit) => unit.key,
    );
    const port = createScmReviewedMarksRecordPort({
      source: {
        repositoryRootPath: '/repo',
        source: { kind: 'workingTree' },
        changeKeys: keys,
      },
      transport: {
        read: async () => ({ value, version }),
        compareAndSet: async (next) => {
          value = next;
          version += 1;
          return { success: true, version };
        },
      },
    });
    let controller!: ReturnType<typeof useHunkReviewController>;
    const outOfDate = vi.fn();
    function Review() {
      const [record, setRecord] = React.useState<ScmReviewedMarksRecord | null>(
        null,
      );
      const setReviewedKeys = React.useCallback(
        (selected: readonly string[], reviewed: boolean) => {
          void port.setReviewedKeys(selected, reviewed).then((result) => {
            if (result.success) setRecord(result.record);
          });
        },
        [],
      );
      controller = useHunkReviewController({
        source: { kind: 'live', root },
        path: 'a.ts',
        unifiedDiff,
        host: null,
        serverId: null,
        onOutOfDate: outOfDate,
        marks: {
          record,
          pending: false, unavailableReason: null,
          setReviewed: () => {},
          setReviewedKeys,
          clear: () => {},
        },
      });
      useReviewKeyboard(controller, { active: true });
      return null;
    }
    const screen = await renderScreen(
      <KeyboardShortcutProvider handlers={{}}>
        <Review />
      </KeyboardShortcutProvider>,
    );
    expect(controller.strip).toMatchObject({ total: 2, reviewed: 0 });
    const staleKeep = controller.keepCurrent;
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'r',
          code: 'KeyR',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(controller.strip).toMatchObject({
      total: 2,
      reviewed: 1,
      fileComplete: false,
    });
    expect((await port.read()).record.reviewedChangeKeys).toEqual([keys[0]]);
    unifiedDiff = patch.replace('+new', '+different');
    await screen.update(
      <KeyboardShortcutProvider handlers={{}}>
        <Review />
      </KeyboardShortcutProvider>,
    );
    await act(async () => {
      staleKeep();
    });
    expect(outOfDate).toHaveBeenCalledOnce();
    expect((await port.read()).record.reviewedChangeKeys).toEqual([keys[0]]);
    unifiedDiff = patch;
    await screen.update(
      <KeyboardShortcutProvider handlers={{}}>
        <Review />
      </KeyboardShortcutProvider>,
    );
    const beforeScopeChange = controller.keepCurrent;
    root = '/other-repository';
    await screen.update(
      <KeyboardShortcutProvider handlers={{}}>
        <Review />
      </KeyboardShortcutProvider>,
    );
    await act(async () => {
      beforeScopeChange();
    });
    expect(outOfDate).toHaveBeenCalledTimes(2);
    expect((await port.read()).record.reviewedChangeKeys).toEqual([keys[0]]);
  });
});
