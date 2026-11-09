import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installCodeViewCommonModuleMocks } from '@/components/ui/code/view/codeViewTestHelpers';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// The draft store is the persistence boundary: an in-memory one that records what Ask writes.
const draftStore = vi.hoisted(() => ({ drafts: [] as Array<{ filePath: string; includeInPrompt: boolean; anchor: { kind: string; startLine?: number; endLine?: number } }> }));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useLocalSetting: () => 1, storage: { getState: () => ({
        reviewCommentsDraftsByWorkspaceCacheKey: {},
        upsertWorkspaceReviewCommentDraft: (_key: string, draft: (typeof draftStore.drafts)[number]) => { draftStore.drafts.push(draft); },
    }) } } as never);
});
installCodeViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'android' });
    },
});

const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneContext } = await import('@/components/appShell/panes/AppPaneContext');
const { FileContentPanel } = await import('./FileContentPanel');
const { FileReadAskControls } = await import('./FileReadAskControls');
const { createNativeLineRangeSelection } = await import('@/components/ui/code/selection/nativeLineRangeSelection');
const { registerComposerPresentationTarget } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');

const scope = { serverId: 'native-ask-home', machineId: 'machine', rootPath: '/repo' };
const FILE = ['one', 'two', 'three', 'four', 'five'].join('\n');
// A file that already carries a comment draws every row (the list does not virtualize), without comment mode on.
const [EXISTING_COMMENT] = (await import('@/components/ui/code/selection/askSelectionModel')).buildAskSelectionDrafts({
    filePath: 'src/a.ts', source: 'file', text: FILE, ranges: [{ startLine: 1, endLine: 1 }] });
const [EXISTING_DIFF_COMMENT] = (await import('@/components/ui/code/selection/askSelectionModel')).buildAskSelectionDrafts({
    filePath: 'src/a.ts', source: 'diff', text: '', lines: (await import('@/components/ui/code/model/buildCodeLinesFromUnifiedDiff')).buildCodeLinesFromUnifiedDiff({
        unifiedDiff: '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three', hideFilePrelude: true }), ranges: [{ startLine: 1, endLine: 1 }] });
const DIFF = '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three';

function Page(props: Readonly<{ displayMode: 'file' | 'diff'; store: ReturnType<typeof createNativeLineRangeSelection>; sessionId?: string | null }>) {
    const text = props.displayMode === 'diff' ? DIFF : FILE;
    return (
        <AppPaneProvider>
            <FileContentPanel theme={{ colors: { text: { secondary: '#999' } } }} sessionId="s1" filePath="src/a.ts" language={null}
                displayMode={props.displayMode} fileContent={FILE} diffContent={props.displayMode === 'diff' ? DIFF : null}
                selectedLineKeys={new Set<string>()} lineSelectionEnabled={false} onToggleLine={vi.fn()} lineRangeAsk={props.store}
                reviewCommentsEnabled reviewCommentDrafts={[props.displayMode === 'diff' ? EXISTING_DIFF_COMMENT! : EXISTING_COMMENT!]} />
            <FileReadAskControls rootRef={{ current: null }} mode={props.displayMode === 'diff' ? 'diff' : 'code'} scopeId="pane" scope={scope}
                filePath="src/a.ts" text={text} sessionId={props.sessionId === undefined ? 's1' : props.sessionId} active lineRange={props.store} />
        </AppPaneProvider>
    );
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;

// The rows are the touch surface: a row reports its long-press and tap to the view that owns the gesture.
function rowFor(screen: Screen, code: string) {
    const row = screen.tree.root.findAll((node) => node.props?.line?.renderCodeText === code && typeof node.props.onPressLine === 'function')[0];
    expect(row, `row ${code}`).toBeDefined();
    return row!.props;
}
async function longPress(screen: Screen, code: string) {
    const row = rowFor(screen, code);
    await act(async () => row.onLongPressLine(row.line));
}
async function tap(screen: Screen, code: string) {
    const row = rowFor(screen, code);
    await act(async () => row.onPressLine(row.line));
}

describe('native arbitrary line-range selection reaches the shared Ask controls', () => {
    it('long-press then tap selects a File View range and Ask drafts it into the session composer', async () => {
        const store = createNativeLineRangeSelection();
        const focus = vi.fn();
        const dispose = registerComposerPresentationTarget({ kind: 'session', sessionId: 's1' }, { readRevision: () => 0, replace: () => 0, focusComposer: focus });
        draftStore.drafts.length = 0;
        const screen = await renderScreen(<Page displayMode="file" store={store} />);
        try {
            expect(screen.findByTestId('selection-bar-ask')).toBeNull();
            await longPress(screen, 'two');
            await tap(screen, 'four');
            expect(store.getSelection()).toMatchObject({ startLine: 2, endLine: 4, text: 'two\nthree\nfour' });
            await act(async () => { screen.pressByTestId('selection-bar-ask'); });
            expect(draftStore.drafts.map((draft) => [draft.filePath, draft.anchor.kind === 'range' ? [draft.anchor.startLine, draft.anchor.endLine] : null, draft.includeInPrompt]))
                .toEqual([['src/a.ts', [2, 4], true]]);
            expect(focus).toHaveBeenCalledTimes(1);
        } finally { dispose(); await screen.unmount(); }
    });

    it('tapping the lone selected row clears the selection and its bar', async () => {
        const store = createNativeLineRangeSelection();
        const screen = await renderScreen(<Page displayMode="file" store={store} />);
        try {
            await longPress(screen, 'three');
            expect(store.getSelection()).toMatchObject({ startLine: 3, endLine: 3 });
            expect(screen.findByTestId('selection-bar-ask')).not.toBeNull();
            await tap(screen, 'three');
            expect(store.getSelection()).toBeNull();
        } finally { await screen.unmount(); }
    });

    it('selects Changes rows on the side the change lands on', async () => {
        const store = createNativeLineRangeSelection();
        const screen = await renderScreen(<Page displayMode="diff" store={store} />);
        try {
            await longPress(screen, 'two');
            expect(store.getSelection()).toMatchObject({ startLine: 2, endLine: 2, side: 'before' });
            await tap(screen, 'TWO');
            expect(store.getSelection()).toMatchObject({ startLine: 2, endLine: 2, side: 'after' });
        } finally { await screen.unmount(); }
    });

    it('leaves comment mode to its own range gesture', async () => {
        const store = createNativeLineRangeSelection();
        const screen = await renderScreen(<FileContentPanel theme={{ colors: { text: { secondary: '#999' } } }} sessionId="s1" filePath="src/a.ts"
            language={null} displayMode="file" fileContent={FILE} diffContent={null} selectedLineKeys={new Set<string>()}
            lineSelectionEnabled={false} onToggleLine={vi.fn()} lineRangeAsk={store}
            reviewCommentsEnabled reviewCommentModeActive onUpsertReviewCommentDraft={vi.fn()} />);
        try {
            await longPress(screen, 'two');
            expect(store.getSelection()).toBeNull();
        } finally { await screen.unmount(); }
    });

    it('does not re-render the Ask controls when pane state they do not read changes', async () => {
        const store = createNativeLineRangeSelection();
        let dispatch!: ReturnType<typeof useAppPaneContext>['dispatch'];
        function Probe() { dispatch = useAppPaneContext(value => ({ dispatch: value.dispatch })).dispatch; return null; }
        let commits = 0;
        const screen = await renderScreen(
            <AppPaneProvider>
                <Probe />
                <React.Profiler id="ask" onRender={() => { commits += 1; }}>
                    <FileReadAskControls rootRef={{ current: null }} mode="code" scopeId="pane" scope={scope}
                        filePath="src/a.ts" text={FILE} sessionId="s1" active lineRange={store} />
                </React.Profiler>
            </AppPaneProvider>);
        try {
            commits = 0;
            await act(async () => { dispatch({ type: 'openRight', scopeId: 'pane', tabId: 'git' }); });
            await act(async () => { dispatch({ type: 'openRight', scopeId: 'pane', tabId: 'files' }); });
            expect(commits).toBe(0);
        } finally { await screen.unmount(); }
    });
});
