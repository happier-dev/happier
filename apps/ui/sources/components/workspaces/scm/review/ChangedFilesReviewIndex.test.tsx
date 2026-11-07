import * as React from 'react';
import { act } from 'react-test-renderer';
import { Dimensions } from 'react-native';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup, withPopoverWebGlobals } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { getStorage } from '@/sync/domains/state/storage';
import { ChangedFilesReviewIndex, ChangedFilesReviewIndexRowsScope, useChangedFilesReviewIndexLeadingRows } from './ChangedFilesReviewIndex';
import { DiffFilesListView } from '@/components/ui/code/diff/DiffFilesListView';
import { buildChangedFilesReviewFileIndex, ChangedFilesReviewPhoneFileControl } from './ChangedFilesReviewPhoneFileControl';
import { FilesystemBrowserRow } from '@/components/ui/filesystemBrowser/FilesystemBrowserRow';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { createChangedFilesReviewFind } from './useChangedFilesReviewFind';
import { createChangedFilesReviewDiffStateSource } from './ChangedFilesReviewDiffStore';
import { HAPPIER_TREE_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const initialSettings = getStorage().getState().settings;

/**
 * The review stream as ChangedFilesReview composes it: the index caption heads the review's own list and
 * the index rows are that list's leading rows (one scroll), so only the rows on screen are drawn.
 */
function ReviewStream(props: Readonly<{
    files: readonly ScmFileStatus[];
    placement: 'stream' | 'comparisonStream';
    commentCountByPath?: ReadonlyMap<string, number>;
    renderRowAccessory?: (path: string) => React.ReactNode;
    onFocusPath?: (path: string) => void;
}>) {
    const index = { files: props.files, activePath: null, commentCountByPath: props.commentCountByPath ?? NO_COMMENTS,
        onFocusPath: props.onFocusPath ?? noop, renderRowAccessory: props.renderRowAccessory ?? null, placement: props.placement, rootPath: '/repo' };
    const { leadingRows, rows } = useChangedFilesReviewIndexLeadingRows({ ...index, enabled: true });
    const header = React.useCallback(() => <ChangedFilesReviewIndex {...index} />, [index]);
    return <ChangedFilesReviewIndexRowsScope rows={rows}>
        <DiffFilesListView testID="review-list" files={[]} expandedKeys={NO_KEYS} onToggleExpanded={noop} canRenderInlineDiffs={false}
            wrapLines={false} showLineNumbers={false} showPrefix={false} virtualizeFileList
            drawDistanceMultiplier={REVIEW_DRAW_DISTANCE_MULTIPLIER} ListHeaderComponent={header} leadingRows={withoutKnownSizes(leadingRows)} />
    </ChangedFilesReviewIndexRowsScope>;
}
// ChangedFilesReview's draw distance for its list (a fraction of the window, past each edge of the viewport).
const REVIEW_DRAW_DISTANCE_MULTIPLIER = 0.75;
const NO_COMMENTS = new Map<string, number>();
// This host renderer delivers no layout callbacks (no ResizeObserver), so the recycler's known-size path
// never settles here and loops. Known sizes are covered with real DOM geometry in
// `VirtualizedList.web.dom.test.tsx`; these tests count rows drawn and behavior, not offsets.
const withoutKnownSizes = (rows: ReturnType<typeof useChangedFilesReviewIndexLeadingRows>['leadingRows']) => (
    rows ? { keys: rows.keys, render: rows.render, onViewableChange: rows.onViewableChange } : rows);
const NO_KEYS = new Set<string>();
const noop = () => {};

/** A public row accessory consumer, not a mocked row: it aborts excess presentation before 55k real rows can exhaust a worker. */
function rowDemandProbe(budget: number) {
    const requestedPaths = new Set<string>();
    const exhausted = new Error('index exceeded viewport row demand');
    class RowBudgetBoundary extends React.Component<React.PropsWithChildren, { exhausted: boolean }> {
        state = { exhausted: false };
        static getDerivedStateFromError(error: unknown) {
            if (error !== exhausted) throw error;
            return { exhausted: true };
        }
        render() { return this.state.exhausted ? null : this.props.children; }
    }
    const accessory = (path: string) => {
        requestedPaths.add(path);
        if (requestedPaths.size > budget) throw exhausted;
        return <Text>{path}</Text>;
    };
    return { requestedPaths, RowBudgetBoundary, accessory };
}

// The live Code-page control has 20 visible tree rows. A 300px viewport of the canonical compact row
// height, with one viewport above and below, bounds what any index presentation may draw.
const ROW_BUDGET = Math.ceil(300 / HAPPIER_TREE_ROW_METRICS.minHeightPx.precise) * 3;
// The review list draws the viewport plus its window-derived draw distance beyond each edge; never the inventory.
const streamRowBudget = () => Math.ceil((300 + 2 * Math.floor(Dimensions.get('window').height * REVIEW_DRAW_DISTANCE_MULTIPLIER))
    / HAPPIER_TREE_ROW_METRICS.minHeightPx.precise);

it.each(['comparisonStream', 'stream'] as const)('bounds %s index rows to the viewport with 55k changed files and keeps a fresh visible file reachable', async (placement) => {
    getStorage().setState({ settings: { ...initialSettings, scmChangedFilesLayout: 'list' } });
    const entries = files(55_545);
    const budget = streamRowBudget();
    const { requestedPaths, RowBudgetBoundary, accessory } = rowDemandProbe(budget);
    const view = (inventory: readonly ScmFileStatus[]) => <RowBudgetBoundary>
        <ReviewStream files={inventory} placement={placement} renderRowAccessory={accessory} />
    </RowBudgetBoundary>;
    const screen = await renderScreen(view(entries), { createNodeMock: listHost });
    expect(requestedPaths.size).toBeGreaterThan(0);
    expect(requestedPaths.size).toBeLessThanOrEqual(budget);
    expect(budget).toBeLessThan(200);
    // Totals stay whole: the caption counts every file, not the rows drawn.
    expect(screen.getTextContent()).toContain('55545');
    const freshPath = 'src/fresh-visible.ts';
    requestedPaths.clear();
    await screen.update(view([{ ...entries[0]!, fullPath: freshPath, fileName: 'fresh-visible.ts' }, ...entries.slice(1)]));
    expect(screen.getTextContent()).toContain(freshPath);
    expect(requestedPaths.has(entries.at(-1)!.fullPath)).toBe(false);
});

it('bounds rail rows to the viewport with 55k changed files and keeps a fresh visible file reachable', async () => {
    getStorage().setState({ settings: { ...initialSettings, scmChangedFilesLayout: 'list' } });
    const entries = files(55_545);
    const { requestedPaths, RowBudgetBoundary, accessory } = rowDemandProbe(ROW_BUDGET);
    const view = (inventory: readonly ScmFileStatus[]) => <RowBudgetBoundary>
        <ChangedFilesReviewIndex files={inventory} activePath={null} commentCountByPath={new Map()}
            onFocusPath={() => {}} placement="rail" renderRowAccessory={accessory} />
    </RowBudgetBoundary>;
    const screen = await renderScreen(view(entries), { createNodeMock: listHost });
    expect(requestedPaths.size).toBeGreaterThan(0);
    expect(requestedPaths.size).toBeLessThanOrEqual(ROW_BUDGET);
    expect(screen.getTextContent()).toContain('55545');
    requestedPaths.clear();
    await screen.update(view([{ ...entries[0]!, fullPath: 'src/fresh-rail.ts', fileName: 'fresh-rail.ts' }, ...entries.slice(1)]));
    expect(screen.getTextContent()).toContain('src/fresh-rail.ts');
    expect(requestedPaths.has(entries.at(-1)!.fullPath)).toBe(false);
});

it('a small stream index lists every file and a row focuses its file', async () => {
    getStorage().setState({ settings: { ...initialSettings, scmChangedFilesLayout: 'list' } });
    const entries = files(5);
    const focused: string[] = [];
    const screen = await renderScreen(<ReviewStream files={entries} placement="comparisonStream"
        commentCountByPath={new Map([[entries[4]!.fullPath, 3]])} onFocusPath={(path) => focused.push(path)} />, { createNodeMock: listHost });
    for (const entry of entries) expect(screen.getTextContent()).toContain(entry.fileName);
    // The change rows the index drew (ScmChangeRow is memoized, so match its props rather than its type).
    const rows = screen.findAll((node) => typeof node.type !== 'string' && node.props.layout === 'compact'
        && node.props.file != null && typeof node.props.onPress === 'function')
        .filter((row, index, all) => all.findIndex((other) => other.props.file.fullPath === row.props.file.fullPath) === index);
    expect(rows.map((row) => row.props.file.fullPath)).toEqual(entries.map((entry) => entry.fullPath));
    await act(async () => rows.at(-1)!.props.onPress());
    expect(focused).toEqual([entries[4]!.fullPath]);
});

let restoreWebGlobals: () => void;
beforeEach(() => { restoreWebGlobals = withPopoverWebGlobals(); });
afterEach(() => {
    standardCleanup();
    restoreWebGlobals();
    getStorage().setState({ settings: initialSettings });
});

function files(count = 80): ScmFileStatus[] {
    return Array.from({ length: count }, (_, index) => ({ fileName: `file-${index}.ts`, filePath: 'src',
        fullPath: `src/file-${index}.ts`, status: 'modified', isIncluded: false, linesAdded: 1, linesRemoved: 1 }));
}

// Host geometry is the platform boundary. The real dropdown measures its
// trigger before drawing its real menu; no Popover/menu logic is replaced.
const measuredHost = () => ({
    offsetTop: 0,
    offsetHeight: 48,
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 48, width: 320, height: 48 }),
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 320, 48),
});

// Host geometry as the browser hands it to the recycler: the list is a 300px viewport whose scroll events it
// listens to; every other box is one compact row tall.
const listHost = (element: Readonly<{ props?: Record<string, unknown> }>) => {
    const viewport = element.props?.['data-testid'] === 'review-list' || element.props?.testID === 'review-list';
    const height = viewport ? 300 : HAPPIER_TREE_ROW_METRICS.minHeightPx.precise;
    const host = {
        offsetTop: 0, offsetHeight: height, clientHeight: height, clientWidth: 320, scrollTop: 0, scrollLeft: 0, scrollHeight: height,
        // The host renderer creates no DOM children; Legend's reorder boundary still reads the collection.
        children: [],
        getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 320, bottom: height, width: 320, height }),
        measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 320, height),
        addEventListener: () => {}, removeEventListener: () => {},
        scrollTo: (options: Readonly<{ top?: number }> | number, y?: number) => {
            host.scrollTop = typeof options === 'number' ? (y ?? 0) : options.top ?? host.scrollTop;
        },
    };
    return host;
};

async function settleMenuPress(screen: Awaited<ReturnType<typeof renderScreen>>, testId: string) {
    await screen.pressByTestIdAsync(testId);
    // Dropdown opens/selects after its current press frame. Wait for that real
    // clock boundary inside act, rather than asserting against the closed menu.
    await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
    await flushHookEffects({ frames: 1 });
    // The renderer does not emit browser layout. Supply the open overlay's real geometry boundary
    // so its motion/visibility owner can admit presses rather than pressing a hidden tree.
    await act(async () => {
        for (const node of screen.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')) {
            node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 300 } } });
        }
    });
}

it('projects phone picker labels only while the list menu is open, without losing selection', async () => {
    getStorage().setState({ settings: { ...initialSettings, scmChangedFilesLayout: 'list' } });
    const entries = files();
    // The admitted inventory owns metadata/index construction, not opening the control.
    const fileIndex = buildChangedFilesReviewFileIndex(entries);
    const findModel = createChangedFilesReviewFind();
    const diffSource = createChangedFilesReviewDiffStateSource();
    const changedPath = entries[1]!.fullPath;
    const diff = (text: string) => `@@ -1 +1 @@\n-old\n+${text}\n`;
    diffSource.setDiffState(changedPath, { status: 'loaded', diff: diff('needle needle'), error: null });
    const disconnect = findModel.connect({ paths: [changedPath], diffStateSource: diffSource, reveal() {} });
    findModel.open(); findModel.setQuery('needle');
    let inactiveLabelReads = 0;
    for (const entry of entries.slice(1)) {
        const name = entry.fileName;
        Object.defineProperty(entry, 'fileName', { get: () => { inactiveLabelReads += 1; return name; } });
    }
    const selected: string[] = [];
    const screen = await renderScreen(<ChangedFilesReviewPhoneFileControl fileIndex={fileIndex} findModel={findModel} activePath={entries[0]!.fullPath}
        rootPath="/repo" commentCountByPath={new Map()} onFocusPath={(path) => selected.push(path)} />, { createNodeMock: measuredHost });
    expect(screen.getTextContent()).toContain('file-0.ts');
    expect(inactiveLabelReads).toBe(0);
    await settleMenuPress(screen, 'scm-comparison-file-trigger');
    expect(screen.getTextContent()).toContain('file-1.ts');
    // The admitted menu viewport is 300px. Only that window plus one above/below is demanded.
    expect(inactiveLabelReads).toBeLessThanOrEqual(Math.ceil(300 / MENU_ROW_METRICS.minHeightPx) * 3);
    expect(screen.findByTestId(`scm-review-find-count:${changedPath}`)).not.toBeNull();
    expect(screen.findByTestId(`scm-review-find-count:${changedPath}`)?.props.children).toBe('2');
    await act(async () => diffSource.setDiffState(changedPath, { status: 'loaded', diff: diff('needle needle needle'), error: null }));
    expect(screen.findByTestId(`scm-review-find-count:${changedPath}`)?.props.children).toBe('3');
    const replacement = entries.map((entry, index) => index === 1 ? { ...entry, fileName: 'fresh-file.ts' } : entry);
    await screen.update(<ChangedFilesReviewPhoneFileControl fileIndex={buildChangedFilesReviewFileIndex(replacement)} findModel={findModel} activePath={entries[0]!.fullPath}
        rootPath="/repo" commentCountByPath={new Map()} onFocusPath={(path) => selected.push(path)} />);
    expect(screen.getTextContent()).toContain('fresh-file.ts');
    const choice = screen.findAll((node) => node.props.accessibilityLabel === entries[1]!.fullPath
        && typeof node.props.onPress === 'function')[0];
    expect(choice).toBeDefined();
    await act(async () => {
        choice!.props.onPress();
        await vi.waitFor(() => expect(selected).toEqual([entries[1]!.fullPath]));
    });
    disconnect();
});

it('does not build discarded list metadata in tree mode and builds it when the person switches to list', async () => {
    getStorage().setState({ settings: { ...initialSettings, scmChangedFilesLayout: 'tree' } });
    const entries = files();
    let commentReads = 0;
    class Comments extends Map<string, number> {
        override get(path: string) { commentReads += 1; return super.get(path); }
    }
    const screen = await renderScreen(<ReviewStream files={entries} placement="comparisonStream"
        commentCountByPath={new Comments([[entries[0]!.fullPath, 2]])} />, { createNodeMock: listHost });
    expect(screen.findByTestId('scm-review-index')).not.toBeNull();
    expect(commentReads).toBe(0);
    await act(async () => getStorage().setState({ settings: { ...initialSettings, scmChangedFilesLayout: 'list' } }));
    // The list's rows are built for the rows drawn, never for the whole inventory.
    expect(commentReads).toBeGreaterThan(0);
    expect(commentReads).toBeLessThanOrEqual(streamRowBudget());
    expect(screen.getTextContent()).toContain('file-0.ts');
});

it('uses the admitted 54,935-file index for position changes and keeps a real replacement current', async () => {
    getStorage().setState({ settings: { ...initialSettings, scmChangedFilesLayout: 'list' } });
    const entries = files(54_935);
    let pathReads = 0;
    for (const entry of entries) {
        const path = entry.fullPath;
        Object.defineProperty(entry, 'fullPath', { enumerable: true, get() { pathReads += 1; return path; } });
    }
    let fileIndex = buildChangedFilesReviewFileIndex(entries);
    const props = { rootPath: '/repo', commentCountByPath: new Map<string, number>(), onFocusPath() {} };
    const screen = await renderScreen(<ChangedFilesReviewPhoneFileControl {...props} fileIndex={fileIndex} activePath="src/file-0.ts" />);
    pathReads = 0;
    await screen.update(<ChangedFilesReviewPhoneFileControl {...props} fileIndex={fileIndex} activePath="src/file-54934.ts" />);
    expect(pathReads).toBeLessThanOrEqual(4);
    expect(screen.getTextContent()).toContain('file-54934.ts');
    const dropdown = screen.findByType(DropdownMenu);
    expect(dropdown.props.itemSource.items).toHaveLength(54_935);
    expect(dropdown.props.itemSource.getItem(54_934)?.id).toBe('src/file-54934.ts');
    const replaced = [...entries];
    replaced[54_934] = { ...entries[54_934]!, fileName: 'current-file.ts', linesAdded: 7 };
    fileIndex = buildChangedFilesReviewFileIndex(replaced);
    pathReads = 0;
    await screen.update(<ChangedFilesReviewPhoneFileControl {...props} fileIndex={fileIndex} activePath="src/file-54934.ts" />);
    expect(pathReads).toBeLessThanOrEqual(4);
    expect(screen.getTextContent()).toContain('current-file.ts');
    expect(screen.findByType(DropdownMenu).props.itemSource.getItem(54_934)?.title).toBe('current-file.ts');
    const changed = [
        { ...entries[0]!, fullPath: 'src/added.ts', fileName: 'added.ts' },
        ...replaced.filter((file) => file.fullPath !== 'src/file-2.ts'),
    ];
    fileIndex = buildChangedFilesReviewFileIndex(changed);
    const selected: string[] = [];
    await screen.update(<ChangedFilesReviewPhoneFileControl {...props} fileIndex={fileIndex}
        activePath="src/file-54934.ts" onFocusPath={path => selected.push(path)} />);
    const source = screen.findByType(DropdownMenu).props.itemSource;
    for (const index of [0, Math.floor(changed.length / 2), changed.length - 1]) {
        const path = changed[index]!.fullPath;
        expect(source.indexById.get(path)).toBe(index);
        expect(source.getItem(index)?.id).toBe(path);
        await act(async () => screen.findByType(DropdownMenu).props.onSelect(source.getItem(index)!.id));
        expect(selected.at(-1)).toBe(path);
    }
    expect(source.indexById.has('src/file-2.ts')).toBe(false);
});

it('highlights the file being read in the phone tree picker without a separate review scope', async () => {
    getStorage().setState({ settings: { ...initialSettings, scmChangedFilesLayout: 'tree' } });
    const entries = files(2).map((file) => ({ ...file, filePath: '', fullPath: file.fileName }));
    const selected: string[] = [];
    const screen = await renderScreen(<ChangedFilesReviewPhoneFileControl fileIndex={buildChangedFilesReviewFileIndex(entries)} activePath={entries[1]!.fullPath}
        rootPath="/repo" commentCountByPath={new Map()} onFocusPath={(path) => selected.push(path)} />, { createNodeMock: measuredHost });
    await settleMenuPress(screen, 'scm-comparison-file-trigger');
    expect(screen.findAll((node) => node.type === FilesystemBrowserRow && node.props.selected)
        .map((node) => node.props.node.path)).toEqual([entries[1]!.fullPath]);
    await settleMenuPress(screen, `repository-tree-row-${entries[0]!.fullPath}`);
    expect(selected).toEqual([entries[0]!.fullPath]);
});
