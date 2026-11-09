import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ScmDiffSummaryResultSchema, type ScmDiffSummaryResult } from '@happier-dev/protocol/scm';
import { SPECIMEN_ANALYSIS_COMPLETE, SPECIMEN_COMPARISON, SPECIMEN_WALKTHROUGH } from '@/components/dev/changes/walkthroughSpecimenFixture';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { createScmDiffSummaryResultOperationsWithTransport: createScmDiffSummaryResultOperations } = await import('@/dev/testkit/harness/scmActionTransport');
const { useWalkthroughSavedActions } = await import('./WalkthroughSavedActions');
const { ScmComparisonMoreMenu } = await import('@/components/sessions/files/comparison/ScmComparisonMoreMenu');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
type SavedActionsProps = NonNullable<Parameters<typeof useWalkthroughSavedActions>[0]>;
type Screen = Awaited<ReturnType<typeof renderScreen>>;

/** The host's composition: the operations are rows of the comparison bar's menu, their editors open in the column. */
function WalkthroughSavedActions(props: SavedActionsProps) {
    const saved = useWalkthroughSavedActions(props);
    return <>{saved.section ? <ScmComparisonMoreMenu sections={[saved.section]} /> : null}{saved.panel}</>;
}

function menuRows(screen: Screen): ReadonlyArray<{ id: string; testID?: string; title: string }> {
    const menu = screen.root.findAll((node) => node.type === DropdownMenu && node.props.testID === 'scm-comparison-more-menu')[0];
    return menu ? menu.props.items : [];
}

function offered(screen: Screen, testID: string): boolean {
    return menuRows(screen).some((row) => row.testID === testID);
}

/** Chooses an operation the way a person does: its row in the comparison menu. */
async function choose(screen: Screen, testID: string) {
    const menu = screen.root.find((node) => node.type === DropdownMenu && node.props.testID === 'scm-comparison-more-menu');
    const row = (menu.props.items as Array<{ id: string; testID?: string }>).find((item) => item.testID === testID);
    if (!row) throw new Error(`${testID} is not offered`);
    await act(async () => { await menu.props.onSelect(row.id); });
}

const SAVED = ScmDiffSummaryResultSchema.parse({
    resultId: 'saved', revision: 4, canUndo: true, generator: { backendTarget: { kind: 'backend', backendId: 'codex' } },
    output: { success: true, resultId: 'saved', revision: 4, sourceKey: SPECIMEN_COMPARISON.id,
        metadata: { sourceKey: SPECIMEN_COMPARISON.id, source: SPECIMEN_COMPARISON.source }, comparison: SPECIMEN_COMPARISON,
        requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH } }, analysis: SPECIMEN_ANALYSIS_COMPLETE },
});

function withRevision(revision: number): ScmDiffSummaryResult {
    return { ...SAVED, revision, output: { ...SAVED.output, revision } };
}

function BoundActions(props: Readonly<{ operations: ReturnType<typeof createScmDiffSummaryResultOperations> }>) {
    const [result, setResult] = React.useState(SAVED);
    return <WalkthroughSavedActions result={result} cwd="/repo" operations={props.operations} onResult={setResult} />;
}

describe('Walkthrough saved-result controls', () => {
    it('retains each Account/result draft across presentation remounts without publishing pane state while typing', async () => {
        const { AppPaneProvider, useAppPaneContext } = await import('@/components/appShell/panes/AppPaneProvider');
        let paneRenders = 0;
        function PaneObserver() {
            useAppPaneContext(context => context.state);
            paneRenders++;
            return null;
        }
        const operations = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
            rpc: async () => ({ success: true, result: SAVED }) });
        const node = (account: string, presentation: number) => <>
            <PaneObserver />
            <WalkthroughSavedActions key={presentation} result={SAVED} cwd="/repo" operations={operations} onResult={() => {}}
                paneScopeId="session:session" editorKey={JSON.stringify([account, SAVED.resultId])} />
        </>;
        const screen = await renderScreen(node('a', 0), { wrapper: ({ children }) => <AppPaneProvider>{children}</AppPaneProvider> });
        await choose(screen, 'walkthrough-saved-edit');
        const before = paneRenders;
        await act(async () => {
            for (const title of ['My', 'My unsaved', 'My unsaved title']) screen.changeTextByTestId('walkthrough-saved-title', title);
        });
        expect(paneRenders - before).toBe(0);
        await screen.update(node('b', 1));
        expect(screen.findByTestId('walkthrough-saved-title')).toBeNull();
        await choose(screen, 'walkthrough-saved-edit');
        expect(screen.findByTestId('walkthrough-saved-title')?.props.value).toBe(SPECIMEN_WALKTHROUGH.title);
        await screen.update(node('a', 2));
        expect(screen.findByTestId('walkthrough-saved-title')?.props.value).toBe('My unsaved title');
        await screen.pressByTestIdAsync('walkthrough-saved-cancel');
        await screen.update(node('a', 3));
        expect(screen.findByTestId('walkthrough-saved-title')).toBeNull();
    });

    it('offers its operations once, as rows of the comparison menu, and keeps the reading column for the reading', async () => {
        const operations = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
            rpc: async () => ({ success: true, result: SAVED }) });
        const screen = await renderScreen(<WalkthroughSavedActions result={SAVED} cwd="/repo" operations={operations} onResult={() => {}} />);
        // Nothing renders in the column until an operation is chosen: no loose row of buttons over the reading.
        expect(screen.findByTestId('walkthrough-saved-actions')).toBeNull();
        expect(menuRows(screen).map((row) => row.testID)).toEqual(['walkthrough-saved-edit', 'walkthrough-saved-undo',
            'walkthrough-saved-refine', 'walkthrough-saved-add-summary']);
        await choose(screen, 'walkthrough-saved-edit');
        expect(screen.findByTestId('walkthrough-saved-title')?.props.value).toBe(SPECIMEN_WALKTHROUGH.title);
    });
    it('leaves Undo to the update notice when the notice offers it', async () => {
        const operations = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
            rpc: async () => ({ success: true, result: SAVED }) });
        const screen = await renderScreen(<WalkthroughSavedActions result={SAVED} cwd="/repo" operations={operations} onResult={() => {}} undoInNotice />);
        expect(offered(screen, 'walkthrough-saved-undo')).toBe(false);
    });
    it('discusses a native saved result at the current revision without a Session composer', async () => {
        const calls: unknown[] = [];
        const operations = createScmDiffSummaryResultOperations({ machineId: 'native-machine', shouldContinue: () => true,
            rpc: async (method, input) => { calls.push({ method, input }); return { success: true, result: withRevision(5), runId: 'native-run', inputId: 'actual-input' }; } });
        const screen = await renderScreen(<WalkthroughSavedActions result={SAVED} cwd="/repo" operations={operations}
            onResult={() => {}} nativeDiscussion />);
        await choose(screen, 'walkthrough-saved-discuss');
        await act(async () => screen.changeTextByTestId('walkthrough-saved-message', 'Why this approach?'));
        await screen.pressByTestIdAsync('walkthrough-saved-discuss-send');
        expect(calls).toEqual([{ method: 'scm.diffSummary.discuss', input: {
            cwd: '/repo', resultId: 'saved', expectedRevision: 4, message: 'Why this approach?',
        } }]);
    });
    it('writes the draft revision through the real operations owner and retains the draft on conflict', async () => {
        const calls: Array<{ method: string; input: unknown }> = [];
        const makeOperations = () => createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
            rpc: async (method, input) => { calls.push({ method, input }); return { success: false, errorCode: 'revision_conflict', error: 'Changed elsewhere', latestRevision: 5 }; } });
        const operations = makeOperations();
        const onResult = vi.fn();
        const screen = await renderScreen(<WalkthroughSavedActions result={SAVED} cwd="/repo" operations={operations} onResult={onResult} />);
        expect(calls).toEqual([]);
        await choose(screen, 'walkthrough-saved-edit');
        await act(async () => screen.changeTextByTestId('walkthrough-saved-title', 'My title'));
        await act(async () => screen.update(<WalkthroughSavedActions result={withRevision(5)} cwd="/repo" operations={makeOperations()} onResult={onResult} />));
        await screen.pressByTestIdAsync('walkthrough-saved-stop-key');
        await screen.pressByTestIdAsync('walkthrough-saved-title-save');
        expect(calls).toEqual([{ method: 'scm.diffSummary.result.edit', input: { cwd: '/repo', resultId: 'saved', expectedRevision: 4,
            edit: { kind: 'renameWalkthrough', title: 'My title' } } }]);
        expect(screen.findByTestId('walkthrough-saved-title')?.props.value).toBe('My title');
        expect(screen.findByTestId('walkthrough-saved-error')).toBeTruthy();
        expect(onResult).not.toHaveBeenCalled();
    });

    it('undoes only on intent using the current revision and publishes the owner response', async () => {
        const calls: unknown[] = [];
        const restored = withRevision(6);
        const operations = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
            rpc: async (method, input) => { calls.push({ method, input }); return { success: true, result: restored }; } });
        const onResult = vi.fn();
        const screen = await renderScreen(<WalkthroughSavedActions result={withRevision(5)} cwd="/repo" operations={operations} onResult={onResult} />);
        expect(calls).toEqual([]);
        await choose(screen, 'walkthrough-saved-undo');
        expect(calls).toEqual([{ method: 'scm.diffSummary.result.undo', input: { cwd: '/repo', resultId: 'saved', expectedRevision: 5 } }]);
        expect(onResult).toHaveBeenCalledWith(restored);
    });

    it('edits stop prose and order without replacing the walkthrough output', async () => {
        const calls: unknown[] = [];
        const operations = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
            rpc: async (method, input) => { calls.push({ method, input }); return { success: true, result: withRevision(5) }; } });
        const screen = await renderScreen(<BoundActions operations={operations} />);
        await choose(screen, 'walkthrough-saved-edit');
        await screen.pressByTestIdAsync('walkthrough-saved-stop-why');
        await act(async () => screen.changeTextByTestId('walkthrough-saved-prose', 'My explanation'));
        await screen.pressByTestIdAsync('walkthrough-saved-prose-save');
        await screen.pressByTestIdAsync('walkthrough-saved-stop-why');
        await screen.pressByTestIdAsync('walkthrough-saved-move-down');
        expect(calls).toEqual([
            { method: 'scm.diffSummary.result.edit', input: { cwd: '/repo', resultId: 'saved', expectedRevision: 4, edit: { kind: 'editStop', stopId: 'why', explanationMarkdown: 'My explanation' } } },
            { method: 'scm.diffSummary.result.edit', input: { cwd: '/repo', resultId: 'saved', expectedRevision: 5, edit: { kind: 'reorderStops', stopIds: ['key', 'why', 'sheet', 'compact', 'test'] } } },
        ]);
    });

    it('targets a selected stop for refinement and hides generation without a saved generator', async () => {
        const calls: unknown[] = [];
        const operations = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
            rpc: async (method, input) => { calls.push({ method, input }); return { success: true, result: SAVED }; } });
        const screen = await renderScreen(<WalkthroughSavedActions result={SAVED} cwd="/repo" operations={operations} onResult={() => {}} />);
        await choose(screen, 'walkthrough-saved-edit');
        await screen.pressByTestIdAsync('walkthrough-saved-stop-sheet');
        await choose(screen, 'walkthrough-saved-refine');
        await act(async () => screen.changeTextByTestId('walkthrough-saved-instructions', 'Explain the back gesture'));
        await screen.pressByTestIdAsync('walkthrough-saved-refine-send');
        expect(calls).toEqual([{ method: 'scm.diffSummary.refine', input: { cwd: '/repo', resultId: 'saved', expectedRevision: 4,
            output: 'walkthrough', instructions: 'Explain the back gesture', stopIds: ['sheet'] } }]);
        const { generator: _generator, ...withoutGenerator } = SAVED;
        await act(async () => screen.update(<WalkthroughSavedActions result={withoutGenerator} cwd="/repo" operations={operations} onResult={() => {}} />));
        expect(offered(screen, 'walkthrough-saved-refine')).toBe(false);
        expect(offered(screen, 'walkthrough-saved-add-summary')).toBe(false);
    });

    it('loads the latest revision on explicit conflict recovery without dropping the draft', async () => {
        const calls: unknown[] = [];
        const operations = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
            rpc: async (method, input) => { calls.push({ method, input });
                return method === 'scm.diffSummary.result.read' ? { success: true, result: withRevision(7) }
                    : { success: false, errorCode: 'revision_conflict', error: 'Changed', latestRevision: 7 }; } });
        const screen = await renderScreen(<BoundActions operations={operations} />);
        await choose(screen, 'walkthrough-saved-edit');
        await act(async () => screen.changeTextByTestId('walkthrough-saved-title', 'My draft'));
        await screen.pressByTestIdAsync('walkthrough-saved-title-save');
        await screen.pressByTestIdAsync('walkthrough-saved-reload');
        expect(screen.findByTestId('walkthrough-saved-title')?.props.value).toBe('My draft');
        await screen.pressByTestIdAsync('walkthrough-saved-title-save');
        expect(calls[2]).toEqual({ method: 'scm.diffSummary.result.edit', input: { cwd: '/repo', resultId: 'saved', expectedRevision: 7,
            edit: { kind: 'renameWalkthrough', title: 'My draft' } } });
    });

    it('adds an output at the saved revision and keeps commit proposals pending-only', async () => {
        const calls: unknown[] = [];
        const operations = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
            rpc: async (method, input) => { calls.push({ method, input }); return { success: true, result: SAVED }; } });
        const screen = await renderScreen(<WalkthroughSavedActions result={SAVED} cwd="/repo" operations={operations} onResult={() => {}} />);
        await choose(screen, 'walkthrough-saved-add-summary');
        expect(calls).toEqual([{ method: 'scm.diffSummary.addOutputs', input: { cwd: '/repo', resultId: 'saved', expectedRevision: 4, outputs: ['summary'] } }]);
        expect(offered(screen, 'walkthrough-saved-add-commitPlan')).toBe(false);
        // Over pending changes the comparison already offers Propose commits (its Commits view adds the proposal to
        // this walkthrough); the saved result's own menu does not offer it a second time.
        const pendingComparison = { ...SPECIMEN_COMPARISON, source: { kind: 'workingTree' as const } };
        const pending = ScmDiffSummaryResultSchema.parse({ ...SAVED, output: { ...SAVED.output, comparison: pendingComparison,
            metadata: { ...SAVED.output.metadata, source: pendingComparison.source } } });
        await act(async () => screen.update(<WalkthroughSavedActions result={pending} cwd="/repo" operations={operations} onResult={() => {}} canGenerate />));
        expect(offered(screen, 'walkthrough-saved-add-summary')).toBe(true);
        expect(offered(screen, 'walkthrough-saved-add-commitPlan')).toBe(false);
        await act(async () => screen.update(<WalkthroughSavedActions result={SAVED} cwd="/repo" operations={operations} onResult={() => {}} disabledReason="Offline" />));
        await choose(screen, 'walkthrough-saved-undo');
        expect(calls).toHaveLength(1);
    });

    it('merges exact adjacent stops while preserving the manually edited title', async () => {
        const calls: unknown[] = [];
        const operations = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
            rpc: async (method, input) => { calls.push({ method, input }); return { success: true, result: withRevision(5) }; } });
        const screen = await renderScreen(<BoundActions operations={operations} />);
        await choose(screen, 'walkthrough-saved-edit');
        await screen.pressByTestIdAsync('walkthrough-saved-stop-key');
        await act(async () => screen.changeTextByTestId('walkthrough-saved-stop-title', 'My explanation title'));
        await screen.pressByTestIdAsync('walkthrough-saved-merge-next');
        expect(calls).toEqual([{ method: 'scm.diffSummary.result.edit', input: { cwd: '/repo', resultId: 'saved', expectedRevision: 4,
            edit: { kind: 'mergeStops', stopIds: ['key', 'sheet'], targetStopId: 'key', title: 'My explanation title',
                explanationMarkdown: `${SPECIMEN_WALKTHROUGH.stops[1]!.explanationMarkdown}\n\n${SPECIMEN_WALKTHROUGH.stops[2]!.explanationMarkdown}` } } }]);
    });

    it('does not replace a newer observed result with an older successful response', async () => {
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const deferred = createDeferred<unknown>();
        const operations = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true, rpc: () => deferred.promise });
        const onResult = vi.fn();
        const screen = await renderScreen(<WalkthroughSavedActions result={SAVED} cwd="/repo" operations={operations} onResult={onResult} />);
        await choose(screen, 'walkthrough-saved-undo');
        await act(async () => screen.update(<WalkthroughSavedActions result={withRevision(8)} cwd="/repo" operations={operations} onResult={onResult} />));
        await act(async () => deferred.resolve({ success: true, result: withRevision(5) }));
        expect(onResult).not.toHaveBeenCalled();
    });

    it('retains a removed stop draft after reloading but disables commands that cannot target it', async () => {
        const calls: unknown[] = [];
        const latest = withRevision(7);
        const merged = { ...latest, output: { ...latest.output, outputs: { walkthrough: { state: 'complete' as const,
            value: { ...SPECIMEN_WALKTHROUGH, stops: SPECIMEN_WALKTHROUGH.stops.filter((stop) => stop.id !== 'sheet')
                .map((stop) => stop.id === 'key' ? { ...stop, changeRefs: [...stop.changeRefs, ...SPECIMEN_WALKTHROUGH.stops[2]!.changeRefs] } : stop) } } } } };
        const operations = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
            rpc: async (method, input) => { calls.push({ method, input });
                return method === 'scm.diffSummary.result.read' ? { success: true, result: merged }
                    : { success: false, errorCode: 'revision_conflict', error: 'Merged elsewhere', latestRevision: 7 }; } });
        const screen = await renderScreen(<BoundActions operations={operations} />);
        await choose(screen, 'walkthrough-saved-edit');
        await screen.pressByTestIdAsync('walkthrough-saved-stop-sheet');
        await act(async () => screen.changeTextByTestId('walkthrough-saved-prose', 'My draft'));
        await screen.pressByTestIdAsync('walkthrough-saved-prose-save');
        await screen.pressByTestIdAsync('walkthrough-saved-reload');
        expect(screen.findByTestId('walkthrough-saved-prose')?.props.value).toBe('My draft');
        await screen.pressByTestIdAsync('walkthrough-saved-merge-next');
        await screen.pressByTestIdAsync('walkthrough-saved-prose-save');
        expect(calls).toHaveLength(2);
    });
});
