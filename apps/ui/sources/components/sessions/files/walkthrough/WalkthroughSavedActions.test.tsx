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
const { WalkthroughSavedActions } = await import('./WalkthroughSavedActions');

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
    it('discusses a native saved result at the current revision without a Session composer', async () => {
        const calls: unknown[] = [];
        const operations = createScmDiffSummaryResultOperations({ machineId: 'native-machine', shouldContinue: () => true,
            rpc: async (method, input) => { calls.push({ method, input }); return { success: true, result: withRevision(5), runId: 'native-run', inputId: 'actual-input' }; } });
        const screen = await renderScreen(<WalkthroughSavedActions result={SAVED} cwd="/repo" operations={operations}
            onResult={() => {}} nativeDiscussion />);
        await screen.pressByTestIdAsync('walkthrough-saved-discuss');
        await act(async () => screen.changeTextByTestId('walkthrough-saved-message', 'Why this approach?'));
        await screen.pressByTestIdAsync('walkthrough-saved-discuss-send');
        expect(calls).toEqual([{ method: 'scm.diffSummary.discuss', input: {
            cwd: '/repo', resultId: 'saved', expectedRevision: 4, message: 'Why this approach?',
        } }]);
    });
    it('writes the draft revision through the real operations owner and retains the draft on conflict', async () => {
        const calls: Array<{ method: string; input: unknown }> = [];
        const operations = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
            rpc: async (method, input) => { calls.push({ method, input }); return { success: false, errorCode: 'revision_conflict', error: 'Changed elsewhere', latestRevision: 5 }; } });
        const onResult = vi.fn();
        const screen = await renderScreen(<WalkthroughSavedActions result={SAVED} cwd="/repo" operations={operations} onResult={onResult} />);
        expect(calls).toEqual([]);
        await screen.pressByTestIdAsync('walkthrough-saved-edit');
        await act(async () => screen.changeTextByTestId('walkthrough-saved-title', 'My title'));
        await act(async () => screen.update(<WalkthroughSavedActions result={withRevision(5)} cwd="/repo" operations={operations} onResult={onResult} />));
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
        await screen.pressByTestIdAsync('walkthrough-saved-undo');
        expect(calls).toEqual([{ method: 'scm.diffSummary.result.undo', input: { cwd: '/repo', resultId: 'saved', expectedRevision: 5 } }]);
        expect(onResult).toHaveBeenCalledWith(restored);
    });

    it('edits stop prose and order without replacing the walkthrough output', async () => {
        const calls: unknown[] = [];
        const operations = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
            rpc: async (method, input) => { calls.push({ method, input }); return { success: true, result: withRevision(5) }; } });
        const screen = await renderScreen(<BoundActions operations={operations} />);
        await screen.pressByTestIdAsync('walkthrough-saved-edit');
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
        await screen.pressByTestIdAsync('walkthrough-saved-edit');
        await screen.pressByTestIdAsync('walkthrough-saved-stop-sheet');
        await screen.pressByTestIdAsync('walkthrough-saved-refine');
        await act(async () => screen.changeTextByTestId('walkthrough-saved-instructions', 'Explain the back gesture'));
        await screen.pressByTestIdAsync('walkthrough-saved-refine-send');
        expect(calls).toEqual([{ method: 'scm.diffSummary.refine', input: { cwd: '/repo', resultId: 'saved', expectedRevision: 4,
            output: 'walkthrough', instructions: 'Explain the back gesture', stopIds: ['sheet'] } }]);
        const { generator: _generator, ...withoutGenerator } = SAVED;
        await act(async () => screen.update(<WalkthroughSavedActions result={withoutGenerator} cwd="/repo" operations={operations} onResult={() => {}} />));
        expect(screen.findByTestId('walkthrough-saved-refine')).toBeNull();
        expect(screen.findByTestId('walkthrough-saved-add-summary')).toBeNull();
    });

    it('loads the latest revision on explicit conflict recovery without dropping the draft', async () => {
        const calls: unknown[] = [];
        const operations = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
            rpc: async (method, input) => { calls.push({ method, input });
                return method === 'scm.diffSummary.result.read' ? { success: true, result: withRevision(7) }
                    : { success: false, errorCode: 'revision_conflict', error: 'Changed', latestRevision: 7 }; } });
        const screen = await renderScreen(<BoundActions operations={operations} />);
        await screen.pressByTestIdAsync('walkthrough-saved-edit');
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
        await screen.pressByTestIdAsync('walkthrough-saved-add-summary');
        expect(calls).toEqual([{ method: 'scm.diffSummary.addOutputs', input: { cwd: '/repo', resultId: 'saved', expectedRevision: 4, outputs: ['summary'] } }]);
        expect(screen.findByTestId('walkthrough-saved-add-commitPlan')).toBeNull();
        await act(async () => screen.update(<WalkthroughSavedActions result={SAVED} cwd="/repo" operations={operations} onResult={() => {}} disabledReason="Offline" />));
        await screen.pressByTestIdAsync('walkthrough-saved-undo');
        expect(calls).toHaveLength(1);
    });

    it('merges exact adjacent stops while preserving the manually edited title', async () => {
        const calls: unknown[] = [];
        const operations = createScmDiffSummaryResultOperations({ sessionId: 'session', shouldContinue: () => true,
            rpc: async (method, input) => { calls.push({ method, input }); return { success: true, result: withRevision(5) }; } });
        const screen = await renderScreen(<BoundActions operations={operations} />);
        await screen.pressByTestIdAsync('walkthrough-saved-edit');
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
        await act(async () => screen.pressByTestId('walkthrough-saved-undo'));
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
        await screen.pressByTestIdAsync('walkthrough-saved-edit');
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
