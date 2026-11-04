/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ScmComparisonSchema, ScmDiffSummaryResultSchema } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { ScmComparison } from '@happier-dev/protocol/scm';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import type { DiscardChangeMessages } from '@/components/sessions/files/review/discardChange';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

// Account policy reads also cross HTTP before SCM dispatch; keep that boundary
// real-shaped alongside the Machine RPC boundary below.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);

const boundary = vi.hoisted(() => ({ calls: [] as Array<{ method: string; payload: unknown; accountId?: string | null }>,
    response: null as unknown, savedResponse: null as unknown, savedResponses: null as Record<string, unknown> | null, savedInventory: null as unknown,
    list: null as import('@/dev/testkit/mocks/legendList').CapturingLegendListMockState | null }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// The platform recycler has no viewport in the renderer; the testkit renders its rows while all Files domain logic remains real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    const mock = createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() });
    boundary.list = mock.state;
    return mock.module;
});
// Authenticated Machine RPC is the external boundary; source mapping, capture decoding and scope lifetime stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const rpc = async (request: { method: string; payload: unknown; accountId?: string | null }) => {
        boundary.calls.push(request);
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE) return boundary.response;
        if (request.method === RPC_METHODS.SCM_CHANGE_DISCARD) return boundary.response;
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST) return boundary.savedInventory ?? { success: true,
            results: [], count: 0, bytes: 0, sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 0 } };
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ && boundary.savedResponses) return boundary.savedResponses[(request.payload as { resultId: string }).resultId];
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ && boundary.savedResponse) return boundary.savedResponse;
        throw new Error(`Unexpected machine boundary: ${request.method}`);
    };
    return createServerScopedMachineRpcBoundaryMock(rpc as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope);
});
const { renderHook, renderScreen, standardCleanup, createSessionFixture, createMachineFixture } = await import('@/dev/testkit');
const { getStorage } = await import('@/sync/domains/state/storage');
const { useSessionCapturedScmComparison } = await import('./useSessionCapturedScmComparison');
const { useFileChangesScope } = await import('@/components/workspaces/files/file/changes/useFileChangesScope');
const { useFileChangesActions } = await import('@/components/workspaces/files/file/changes/useFileChangesActions');
// Router mounts after the app entry publishes the real sync runtime; reproduce that bootstrap.
await import('@/sync/syncEngine');
const { SessionScmReviewDetailsView } = await import('@/components/sessions/files/views/SessionScmReviewDetailsView');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { readSessionScmReviewTarget } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
const { loadSavedScmDiffSummaryResult, retireScmDiffSummaryScope } = await import('@/sync/ops/scmDiffSummary/generate');
const initialStorage = getStorage().getState();
const scopes: Array<{ serverId: string; accountId: string }> = [];
// Saved-result discovery is legitimate alongside capture; it is not a checkout read.
function comparisonCalls() {
    return boundary.calls.filter(call => call.method !== RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST
        && call.method !== RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ);
}
function PaneProbe({ scopeId }: { scopeId: string }) {
    return React.createElement('PaneProbe', { state: useAppPaneScope(scopeId).scopeState });
}
// The global UI cleanup resets runtimeFetch after every case. Reinstall the
// canonical HTTP boundary before the next case uses the real scoped request path.
beforeEach(() => installHomeGovernanceBoundaries(homes));
afterEach(async () => { standardCleanup(); for (const scope of scopes.splice(0)) retireScmDiffSummaryScope(scope);
    await homes.reset();
    getStorage().setState(initialStorage, true); boundary.calls = []; boundary.response = null; boundary.savedResponse = null; boundary.savedResponses = null; boundary.savedInventory = null; });

async function mount(comparison: SessionScmReviewComparison) {
    const sessionId = `capture-${comparison.kind}`;
    const serverId = await homes.addHome({ name: sessionId, serverUrl: `https://${sessionId}.example.test`, accountId: 'captured-account' });
    const machine = createMachineFixture({ id: `machine:${sessionId}`, activeAt: Date.now() });
    const session = createSessionFixture({ id: sessionId, serverId, active: true,
        metadata: { path: '/repo/exact', host: 'tester.local', machineId: machine.id, flavor: 'codex' } });
    getStorage().setState({ sessions: { [sessionId]: session }, machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
    return renderHook<ReturnType<typeof useSessionCapturedScmComparison>, ScmComparison | null>(
        (knownComparison) => useSessionCapturedScmComparison({ sessionId, serverId, comparison, knownComparison }), { initialProps: null });
}

// Review is only offered for a comparison that changed something.
const changedFile = { path: 'src/changed.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
    evidence: { state: 'available', unifiedDiff: 'diff --git a/src/changed.ts b/src/changed.ts\n--- a/src/changed.ts\n+++ b/src/changed.ts\n@@ -1 +1 @@\n-old\n+new\n' }, occurrences: [] } as const;

describe('Files reads the canonical captured comparison through authenticated RPC', () => {
    it('retains a completed turn capture when navigation pins it before switching to Files', async () => {
        const source = { kind: 'turnCheckpoint' as const, turnId: 'completed-turn' };
        const comparison = ScmComparisonSchema.parse({ id: 'f'.repeat(64), source,
            repository: { rootPath: '/repo/exact' }, endpoints: { before: 'turn-start', after: 'turn-final' },
            inventory: { state: 'complete', reasons: [], files: [changedFile] } });
        boundary.response = { success: true, comparison, metadata: { sourceKey: comparison.id, source } };
        const prior = await mount(source);
        await prior.unmount();
        boundary.calls = [];
        const sessionId = 'capture-turnCheckpoint';
        const serverId = getStorage().getState().sessions[sessionId]!.serverId!;
        const hook = await renderHook<ReturnType<typeof useSessionCapturedScmComparison>, SessionScmReviewComparison>((selector) => useSessionCapturedScmComparison({
            sessionId, serverId, comparison: selector,
        }), { initialProps: source });
        await vi.waitFor(() => expect(hook.getCurrent().comparison).toEqual(comparison));
        boundary.response = { success: false, errorCode: 'DIFF_UNAVAILABLE', error: 'A second read must not replace evidence already loaded.' };
        await hook.rerender({ ...source, comparisonId: comparison.id });
        expect(hook.getCurrent()).toMatchObject({ comparison, loading: false, error: null });
        expect(comparisonCalls()).toHaveLength(1);
        // A different pinned identity must still read its own evidence and
        // must never inherit this turn's previous successful comparison.
        await hook.rerender({ ...source, comparisonId: 'e'.repeat(64) });
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().comparison).toBeNull();
        expect(hook.getCurrent().error).toBeTruthy();
        expect(comparisonCalls()).toHaveLength(2);
    });
    it('reviews captured files with one keyboard cursor, numbering and content-key marks', async () => {
        const mounted = await mount({ kind: 'session' });
        await mounted.unmount();
        const sessionId = 'capture-session';
        const serverId = getStorage().getState().sessions[sessionId]!.serverId!;
        const { buildReviewUnits } = await import('@happier-dev/protocol/scm/comparisonOccurrences');
        const { createScmReviewedMarksRecordPort } = await import('@happier-dev/protocol/scm/reviewedMarks');
        const { CapturedComparisonFilesView } = await import('./CapturedComparisonFilesView');
        const { DiffViewer } = await import('@/components/ui/code/diff/DiffViewer');
        const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
        const comparison = ScmComparisonSchema.parse({ id: 'a'.repeat(64), source: { kind: 'session', sessionId },
            repository: { rootPath: '/repo/exact' }, endpoints: {}, inventory: { state: 'complete', reasons: [],
                files: ['a.ts', 'b.ts'].map(path => ({ ...changedFile, path, occurrences: [{
                    id: `capture:${path}`, alias: path, path, position: 0,
                    before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 },
                }] })) } });
        const diff = changedFile.evidence.unifiedDiff;
        const keys = ['a.ts', 'b.ts'].flatMap(path => buildReviewUnits(path, undefined, diff).map(unit => unit.key));
        let value: unknown = null;
        let version = -1;
        const port = createScmReviewedMarksRecordPort({ source: { repositoryRootPath: '/repo/exact',
            source: { kind: 'session', sessionId }, changeKeys: keys }, transport: {
            read: async () => ({ value, version }),
            compareAndSet: async next => { value = next; version += 1; return { success: true, version }; },
        } });
        getStorage().setState({ settings: { ...getStorage().getState().settings, keyboardShortcutsV2Enabled: true,
            keyboardSingleKeyShortcutsEnabled: true, keyboardShortcutOverridesV1: {}, keyboardShortcutDisabledCommandIdsV1: [] } });
        function Review() {
            const [record, setRecord] = React.useState<import('@happier-dev/protocol/scm/reviewedMarks').ScmReviewedMarksRecord | null>(null);
            return <CapturedComparisonFilesView comparison={comparison} sessionId={sessionId}
                workspaceScope={{ serverId, machineId: `machine:${sessionId}`, rootPath: '/repo/exact' }}
                marks={{ record, unavailableReason: null, setReviewed: () => {}, clear: () => {},
                    setReviewedKeys: (selected, reviewed) => { void port.setReviewedKeys(selected, reviewed).then(result => {
                        if (result.success) setRecord(result.record);
                    }); } }} maxFiles={10} maxChangedLines={100} />;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><Review /></KeyboardShortcutProvider>);
        const rows = () => screen.findAllByType(DiffViewer);
        await vi.waitFor(() => expect(rows()).toHaveLength(1));
        expect(rows()[0]!.props.hunks.numberTotal).toBe(2);
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', bubbles: true })); });
        // The recycler boundary has no viewport: report the rows revealed by the navigation scroll.
        const { DiffFilesListView } = await import('@/components/ui/code/diff/DiffFilesListView');
        await act(async () => screen.findByType(DiffFilesListView).props.onViewableItemsChanged({
            viewableItems: [0, 1].map(index => ({ index, isViewable: true, key: `${index}` })),
            changed: [],
        }));
        await vi.waitFor(() => expect(rows()).toHaveLength(2));
        expect(rows().map(row => row.props.hunks.numberOffset)).toEqual([0, 1]);
        expect(rows().map(row => row.props.hunks.currentIndex)).toEqual([null, 0]);
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', bubbles: true })); });
        await vi.waitFor(() => expect(value).toMatchObject({ reviewedChangeKeys: [keys[1]] }));
        const info = (await import('@/components/ui/code/diff/hunks/buildDiffHunkTable')).buildDiffHunkTable({ mode: 'unified', filePath: 'b.ts', unifiedDiff: diff }).hunks[0]!;
        expect(rows()[1]!.props.hunks.stateOf(info)).toBe('kept');
    });
    const messages = { moved_on: 'moved', update_required: 'update', unsupported: 'unsupported', unavailable: 'unavailable', unknown: 'unknown',
        discarded: 'discarded', restored: 'restored', kept_edited: 'edited', undone: 'undone', undo_conflict: 'conflict', undo: 'undo',
        note_failed: 'note failed', undo_unavailable: 'undo unavailable' } satisfies DiscardChangeMessages;
    it('offers restore-before-turn only for the turn scope while session keeps whole-file discard', async () => {
        const hook = await renderHook((selector: SessionScmReviewComparison) => useFileChangesActions({
            target: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo/exact' }, filePath: 'src/a.ts', selector,
            comparison: ScmComparisonSchema.parse({ id: 'a'.repeat(64),
                source: selector.kind === 'session' ? { kind: 'session', sessionId: 'session-a' } : selector,
                repository: { rootPath: '/repo/exact' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } }),
            messages, readCurrentText: async () => '', refresh: async () => {}, hasUnsavedEdits: () => false,
            onReplacedUnsavedEdits: () => {}, changed: true, confirmUnsaved: { title: 'Replace draft' },
        }), { initialProps: { kind: 'session' } });
        expect(hook.getCurrent().changes.discardAll).toBeTypeOf('function');
        expect(hook.getCurrent().changes.restoreBeforeTurn).toBeUndefined();
        await hook.rerender({ kind: 'turnCheckpoint', turnId: 'turn-4' });
        expect(hook.getCurrent().changes.discardAll).toBeTypeOf('function');
        expect(hook.getCurrent().changes.restoreBeforeTurn).toBeTypeOf('function');
    });
    it('keeps a rendered restore callback bound to its original file, turn and expected hash', async () => {
        const prior = await mount({ kind: 'session' });
        await prior.unmount();
        boundary.calls = [];
        const sessionId = 'capture-session';
        const serverId = getStorage().getState().sessions[sessionId]!.serverId!;
        const first = { path: 'src/a.ts', turnId: 'turn-4', hash: 'b'.repeat(64), comparisonId: 'a'.repeat(64) };
        const second = { path: 'src/b.ts', turnId: 'turn-8', hash: 'd'.repeat(64), comparisonId: 'c'.repeat(64) };
        const hook = await renderHook((selected: typeof first) => useFileChangesActions({
            target: { serverId, machineId: 'machine:capture-session', rootPath: '/repo/exact' },
            filePath: selected.path, selector: { kind: 'turnCheckpoint', turnId: selected.turnId }, expectedHash: selected.hash,
            comparison: ScmComparisonSchema.parse({ id: selected.comparisonId, source: { kind: 'turnCheckpoint', turnId: selected.turnId },
                repository: { rootPath: '/repo/exact' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } }),
            messages, readCurrentText: async () => '', refresh: async () => {}, hasUnsavedEdits: () => false,
            onReplacedUnsavedEdits: () => {}, changed: true, confirmUnsaved: { title: 'Replace draft' },
        }), { initialProps: first });
        const renderedRestore = hook.getCurrent().changes.restoreBeforeTurn!;
        await hook.rerender(second);
        boundary.response = { success: true, entries: [{ path: first.path, status: 'restored', hashBefore: first.hash, hashAfter: 'e'.repeat(64) }] };
        await act(async () => renderedRestore());
        expect(boundary.calls.find(call => call.method === RPC_METHODS.SCM_CHANGE_DISCARD)?.payload).toMatchObject({ entries: [{
            path: first.path, expectedHash: first.hash, against: { comparisonId: first.comparisonId, source: { kind: 'turnCheckpoint', turnId: first.turnId } },
        }] });
    });
    it('confirms whole-file restore only for unsaved editor content and retains it on cancellation', async () => {
        const prior = await mount({ kind: 'session' });
        await prior.unmount();
        boundary.calls = [];
        boundary.response = { success: true, entries: [{ path: 'src/a.ts', status: 'restored', hashBefore: 'b'.repeat(64), hashAfter: 'a'.repeat(64) }] };
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        vi.mocked(Modal.confirm).mockResolvedValue(false);
        const onReplacedUnsavedEdits = vi.fn();
        const sessionId = 'capture-session';
        const serverId = getStorage().getState().sessions[sessionId]!.serverId!;
        const hook = await renderHook((dirty: boolean) => useFileChangesActions({
            target: { serverId, machineId: 'machine:capture-session', rootPath: '/repo/exact' },
            filePath: 'src/a.ts', selector: { kind: 'workingTree' }, comparison: null, messages,
            readCurrentText: async () => '', refresh: async () => {}, hasUnsavedEdits: () => dirty,
            onReplacedUnsavedEdits, changed: true, confirmUnsaved: { title: 'Replace draft' },
        }), { initialProps: false });
        await act(async () => hook.getCurrent().changes.discardAll!());
        expect(boundary.calls.filter(call => call.method === RPC_METHODS.SCM_CHANGE_DISCARD)).toHaveLength(1);
        expect(Modal.confirm).not.toHaveBeenCalled();
        await hook.rerender(true);
        await act(async () => hook.getCurrent().changes.discardAll!());
        expect(Modal.confirm).toHaveBeenCalledOnce();
        expect(onReplacedUnsavedEdits).not.toHaveBeenCalled();
        expect(boundary.calls.filter(call => call.method === RPC_METHODS.SCM_CHANGE_DISCARD)).toHaveLength(1);
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        await act(async () => hook.getCurrent().changes.discardAll!());
        expect(onReplacedUnsavedEdits).toHaveBeenCalledOnce();
    });
    it('offers the existing whole-turn rollback when a restore is unsupported or has moved on', async () => {
        const prior = await mount({ kind: 'session' });
        await prior.unmount();
        boundary.calls = [];
        const sessionId = 'capture-session';
        const serverId = getStorage().getState().sessions[sessionId]!.serverId!;
        const comparison = ScmComparisonSchema.parse({ id: 'a'.repeat(64), source: { kind: 'turnCheckpoint', turnId: 'turn-4' },
            repository: { rootPath: '/repo/exact' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } });
        const offerWholeTurnRollback = vi.fn();
        const hook = await renderHook(() => useFileChangesActions({
            target: { serverId, machineId: 'machine:capture-session', rootPath: '/repo/exact' },
            filePath: 'src/a.ts', selector: { kind: 'turnCheckpoint', turnId: 'turn-4' }, comparison, messages,
            readCurrentText: async () => '', refresh: async () => {}, hasUnsavedEdits: () => false,
            onReplacedUnsavedEdits: () => {}, changed: true, confirmUnsaved: { title: 'Replace draft' }, offerWholeTurnRollback,
        }));
        for (const errorCode of ['DISCARD_UNSUPPORTED', 'CHANGE_MOVED_ON']) {
            boundary.response = { success: false, errorCode, error: errorCode };
            await act(async () => hook.getCurrent().changes.restoreBeforeTurn!());
        }
        expect(offerWholeTurnRollback.mock.calls).toEqual([['turn-4'], ['turn-4']]);
    });
    it('keeps Uncommitted live without captures while tab state changes and agent writes arrive', async () => {
        const prior = await mount({ kind: 'session' });
        await prior.unmount();
        boundary.calls = [];
        const sessionId = 'capture-session';
        const serverId = getStorage().getState().sessions[sessionId]!.serverId!;
        const hook = await renderHook((revision: number) => useFileChangesScope({
            host: { sessionId }, serverId, machine: { machineId: 'machine:capture-session', basePath: '/repo/exact' },
            identity: { machineId: 'machine:capture-session', basePath: '/repo/exact' },
            view: { changesScope: { kind: 'workingTree' } }, onChangesScopeChange: () => {}, latestTurnId: 'turn-4',
        }), { initialProps: 0 });
        for (const revision of [1, 2, 3]) await hook.rerender(revision);
        expect(hook.getCurrent().current).toEqual({ kind: 'workingTree' });
        expect(hook.getCurrent().comparison).toBeNull();
        expect(comparisonCalls()).toEqual([]);
        expect(hook.getCurrent().options.map(option => option.sourceKind).sort()).toEqual(['session', 'turnCheckpoint', 'workingTree']);
        const pinned = await renderHook(() => useFileChangesScope({
            host: { sessionId }, serverId, machine: { machineId: 'machine:capture-session', basePath: '/repo/exact' },
            identity: { machineId: 'machine:capture-session', basePath: '/repo/exact' }, active: false,
            onChangesScopeChange: () => {}, initialChanges: { kind: 'turnCheckpoint', turnId: 'turn-3', comparisonId: 'a'.repeat(64) }, latestTurnId: 'turn-4',
        }));
        expect(pinned.getCurrent().options.map(option => option.sourceKind).sort()).toEqual(['session', 'turnCheckpoint', 'workingTree']);
        expect(pinned.getCurrent().selector).toMatchObject({ turnId: 'turn-3', comparisonId: 'a'.repeat(64) });
    });
    it('restores a published walkthrough for Files Explain without first opening Walkthrough', async () => {
        const source = { kind: 'commit' as const, commit: 'saved-head' };
        const comparison = ScmComparisonSchema.parse({ id: 'published-comparison', source, repository: { rootPath: '/repo/exact' },
            endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } });
        const result = ScmDiffSummaryResultSchema.parse({ resultId: 'published-result', revision: 1, canUndo: false,
            output: { success: true, resultId: 'published-result', revision: 1, sourceKey: comparison.id,
                metadata: { sourceKey: comparison.id, source }, comparison, requestedOutputs: ['walkthrough'],
                outputs: { walkthrough: { state: 'complete', value: { title: 'Published reading', intro: 'Already generated', stops: [], otherChangeRefs: [] } } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } });
        boundary.response = { success: true, comparison, metadata: { sourceKey: comparison.id, source } };
        boundary.savedResponse = { success: true, result };
        boundary.savedInventory = { success: true, results: [{ cwd: '/repo/exact', sessionId: 'capture-commit',
            resultId: result.resultId, revision: result.revision, comparisonId: comparison.id, source, bytes: 1, updatedAtMs: 1 }],
            count: 1, bytes: 1, sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 } };
        const hook = await mount(source);
        await hook.unmount();
        const serverId = getStorage().getState().sessions['capture-commit']!.serverId!;
        scopes.push({ serverId, accountId: 'captured-account' });
        const screen = await renderScreen(<AppPaneProvider><SessionScmReviewDetailsView sessionId="capture-commit"
            serverId={serverId} scopeId="session:capture-commit" target={{ comparison: source, view: 'files' }} /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('captured-comparison-files')).toBeTruthy());
        await vi.waitFor(() => expect(screen.findByTestId('scm-comparison-explain')).toBeTruthy());
        expect(boundary.calls.some(call => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ)).toBe(true);
        expect(boundary.calls.some(call => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE)).toBe(false);
    });
    it('keeps the published reading visible when a newer saved attempt failed before writing anything', async () => {
        const source = { kind: 'commit' as const, commit: 'saved-head' };
        const comparison = ScmComparisonSchema.parse({ id: 'published-comparison', source, repository: { rootPath: '/repo/exact' },
            endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } });
        const saved = (resultId: string, walkthrough: unknown) => ScmDiffSummaryResultSchema.parse({ resultId, revision: 1, canUndo: false,
            output: { success: true, resultId, revision: 1, sourceKey: comparison.id, metadata: { sourceKey: comparison.id, source },
                comparison, requestedOutputs: ['walkthrough'], outputs: { walkthrough },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } });
        const published = saved('published-result', { state: 'complete', value: { title: 'Published reading', intro: 'Already generated', stops: [], otherChangeRefs: [] } });
        const failedLater = saved('failed-later-result', { state: 'failed', reason: 'Generation failed' });
        boundary.response = { success: true, comparison, metadata: { sourceKey: comparison.id, source } };
        boundary.savedResponses = { 'published-result': { success: true, result: published }, 'failed-later-result': { success: true, result: failedLater } };
        const listed = (resultId: string, updatedAtMs: number) => ({ cwd: '/repo/exact', sessionId: 'capture-commit', resultId, revision: 1,
            comparisonId: comparison.id, source, bytes: 1, updatedAtMs });
        // The inventory is newest first: the failed attempt is what a plain "first match" restores.
        boundary.savedInventory = { success: true, results: [listed('failed-later-result', 2), listed('published-result', 1)],
            count: 2, bytes: 2, sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 2 } };
        const hook = await mount(source);
        await hook.unmount();
        const serverId = getStorage().getState().sessions['capture-commit']!.serverId!;
        scopes.push({ serverId, accountId: 'captured-account' });
        const screen = await renderScreen(<AppPaneProvider><SessionScmReviewDetailsView sessionId="capture-commit"
            serverId={serverId} scopeId="session:capture-commit" target={{ comparison: source, view: 'files' }} /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('captured-comparison-files')).toBeTruthy());
        await vi.waitFor(() => expect(screen.findByTestId('scm-comparison-explain')).toBeTruthy());
    });
    it.each([
        { state: 'complete', reasons: [], before: 'initial-tree', after: 'initial-tree' },
        { state: 'unavailable', reasons: ['Session initial checkpoint is unavailable'], before: undefined, after: undefined },
    ] as const)('shows the Session checkpoint net as $state, preserving an empty reversion or missing baseline', async ({ state, reasons, before, after }) => {
        const source = { kind: 'session' as const };
        const comparison = ScmComparisonSchema.parse({ id: 's'.repeat(64), source: { ...source, sessionId: 'capture-session' },
            repository: { rootPath: '/repo/exact' }, endpoints: { before, after },
            inventory: { state, files: [], reasons } });
        boundary.response = { success: true, comparison, metadata: { sourceKey: comparison.id, source: comparison.source } };
        const hook = await mount(source);
        await hook.unmount();
        boundary.calls = [];
        const serverId = getStorage().getState().sessions['capture-session']!.serverId;
        const screen = await renderScreen(<AppPaneProvider><PaneProbe scopeId="session:capture-session" /><SessionScmReviewDetailsView sessionId="capture-session"
            serverId={serverId} scopeId="session:capture-session" target={{ comparison: source, view: 'files' }} /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('captured-comparison-files')).toBeTruthy());
        expect(Boolean(screen.findByTestId('captured-inventory-incomplete'))).toBe(state === 'unavailable');
        expect(comparisonCalls().map((call) => call.method)).toEqual([RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE]);
        const capturedView = screen.findByType((await import('./CapturedComparisonFilesView')).CapturedComparisonFilesView);
        expect(capturedView.props.comparison).toEqual(comparison);
        expect(capturedView.props.comparison.inventory.files).toEqual([]);
        const switchView = screen.findByType((await import('./ScmComparisonBar')).ScmComparisonViewSwitch);
        await act(async () => screen.pressByTestId('scm-comparison-view:walkthrough'));
        expect(screen.findByType('PaneProbe' as never).props.state.details.tabs[0]?.resource)
            .toMatchObject({ comparison: { kind: 'session', comparisonId: comparison.id }, view: 'walkthrough' });
        expect(switchView.props.view).toBe('files');
    });
    it.each([
        { kind: 'turnCheckpoint', turnId: 'deleted-file-turn' },
        { kind: 'branch', head: 'HEAD', base: 'main' },
        { kind: 'commit', commit: 'HEAD' },
        { kind: 'pullRequest', locator: { providerId: 'github', repository: 'owner/repo', number: 42 } },
    ] as const)('pins captured $kind evidence when Files opens its first Walkthrough', async (source) => {
        const deletedDiff = 'diff --git a/src/auth.js b/src/auth.js\ndeleted file mode 100644\n--- a/src/auth.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const allowed = true;\n';
        const comparison = ScmComparisonSchema.parse({ id: 'a'.repeat(64), source,
            repository: { rootPath: '/repo/exact' }, endpoints: { before: 'captured-before', after: 'captured-after' },
            inventory: { state: 'complete', files: source.kind === 'turnCheckpoint' ? [{ ...changedFile,
                path: 'src/auth.js', changeKind: 'deleted', evidence: { state: 'available', unifiedDiff: deletedDiff },
                occurrences: [{ id: 'capture:deleted-auth', alias: 'deleted-auth', path: 'src/auth.js', position: 0,
                    before: { startLine: 1, lineCount: 1 }, after: { startLine: 0, lineCount: 0 } }],
            }] : [], reasons: [] } });
        boundary.response = { success: true, comparison, metadata: { sourceKey: comparison.id, source } };
        const hook = await mount(source);
        await hook.unmount();
        boundary.calls = [];
        const sessionId = `capture-${source.kind}`;
        const scopeId = `session:${sessionId}`;
        const serverId = getStorage().getState().sessions[sessionId]!.serverId;
        const screen = await renderScreen(<AppPaneProvider><PaneProbe scopeId={scopeId} /><SessionScmReviewDetailsView
            sessionId={sessionId} serverId={serverId} scopeId={scopeId} target={{ comparison: source, view: 'files' }} /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('captured-comparison-files')).toBeTruthy());
        expect(screen.findByType((await import('./CapturedComparisonFilesView')).CapturedComparisonFilesView).props.comparison.endpoints)
            .toEqual(comparison.endpoints);
        if (source.kind === 'turnCheckpoint') {
            const { DiffViewer } = await import('@/components/ui/code/diff/DiffViewer');
            await vi.waitFor(() => expect(screen.findAllByType(DiffViewer)).toHaveLength(1));
            expect(screen.findByType(DiffViewer).props.unifiedDiff).toBe(deletedDiff);
        }
        await act(async () => screen.pressByTestId('scm-comparison-view:walkthrough'));
        expect(screen.findByType('PaneProbe' as never).props.state.details.tabs[0]?.resource)
            .toMatchObject({ comparison: { ...source, comparisonId: comparison.id }, view: 'walkthrough' });
        expect(comparisonCalls().map((call) => call.method)).toEqual([RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE]);
    });
    it('loads PR inventory before any narration or working-copy snapshot exists', async () => {
        const source = { kind: 'pullRequest' as const, locator: { providerId: 'github', repository: 'owner/repo', number: 42 } };
        const comparison = ScmComparisonSchema.parse({ id: 'pinned-pr', source, repository: { rootPath: '/repo/exact' },
            endpoints: { before: 'base-oid', after: 'head-oid' }, freshness: 'unknown', inventory: { state: 'incomplete', files: [], reasons: ['page_failed'] } });
        boundary.response = { success: true, comparison, metadata: { sourceKey: comparison.id, source } };
        const hook = await mount(source);
        await vi.waitFor(() => expect(hook.getCurrent().comparison).toEqual(comparison));
        expect(boundary.calls).toEqual([expect.objectContaining({ method: RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE,
            payload: { sessionId: 'capture-pullRequest', cwd: '/repo/exact', source, projection: { kind: 'index' } } })]);
    });
    it('reads a pinned identity and preserves an unavailable response without recapturing source', async () => {
        const source = { kind: 'commit' as const, commit: 'old-ref' };
        boundary.response = { success: false, error: 'saved_evidence_missing', errorCode: 'DIFF_UNAVAILABLE' };
        const comparisonId = 'c'.repeat(64);
        const hook = await mount({ ...source, comparisonId });
        await vi.waitFor(() => expect(hook.getCurrent().error).toBe('saved_evidence_missing'));
        expect(hook.getCurrent().comparison).toBeNull();
        expect(boundary.calls).toEqual([expect.objectContaining({ payload: { sessionId: 'capture-commit', cwd: '/repo/exact', source, comparisonId, projection: { kind: 'index' } } })]);
    });
    it('clears a failed read when exact saved evidence becomes available without recapturing', async () => {
        const source = { kind: 'commit' as const, commit: 'old-ref' };
        const id = 'c'.repeat(64);
        boundary.response = { success: false, error: 'saved_evidence_missing', errorCode: 'DIFF_UNAVAILABLE' };
        const hook = await mount({ ...source, comparisonId: id });
        await vi.waitFor(() => expect(hook.getCurrent().error).toBe('saved_evidence_missing'));
        const saved = ScmComparisonSchema.parse({ id, source, repository: { rootPath: '/repo/exact' }, endpoints: { before: 'before', after: 'after' },
            inventory: { state: 'complete', files: [], reasons: [] } });
        await hook.rerender(saved);
        expect(hook.getCurrent()).toMatchObject({ comparison: saved, loading: false, error: null });
        expect(boundary.calls).toHaveLength(1);
    });
    it('renders captured Files without a checkout snapshot or checkout RPCs', async () => {
        const source = { kind: 'pullRequest' as const, locator: { providerId: 'github', repository: 'owner/repo', number: 42 } };
        const comparison = ScmComparisonSchema.parse({ id: 'captured-ui', source, repository: { rootPath: '/repo/exact' },
            endpoints: { before: 'base-oid', after: 'head-oid' }, freshness: 'unknown', inventory: { state: 'incomplete', reasons: ['page_failed'], files: [
                { path: 'new.ts', previousPath: 'old.ts', changeKind: 'renamed', binary: false, generated: false, lockfile: false,
                    evidence: { state: 'available', unifiedDiff: 'diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-old\n+new\n' },
                    occurrences: [{ id: 'capture:new', alias: 'new', path: 'new.ts', position: 0,
                        before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }] },
                { path: 'missing.png', changeKind: 'added', binary: null, generated: false, lockfile: false,
                    evidence: { state: 'unavailable', reason: 'patch_unavailable' }, occurrences: [] },
                { path: 'captured-image.png', changeKind: 'added', binary: true, generated: false, lockfile: false,
                    evidence: { state: 'available', unifiedDiff: '' }, occurrences: [] },
            ] } });
        boundary.response = { success: true, comparison, metadata: { sourceKey: comparison.id, source } };
        const hook = await mount(source);
        await hook.unmount();
        boundary.calls = [];
        const serverId = getStorage().getState().sessions['capture-pullRequest']!.serverId;
        const screen = await renderScreen(<AppPaneProvider><SessionScmReviewDetailsView sessionId="capture-pullRequest"
            serverId={serverId} scopeId="session:capture-pullRequest" target={{ comparison: source, view: 'files' }} /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('captured-comparison-files')).toBeTruthy());
        expect(screen.findByTestId('captured-inventory-incomplete')).toBeTruthy();
        expect(screen.findByTestId('captured-comparison-freshness')).toBeTruthy();
        expect(screen.findByTestId('captured-comparison-endpoints')).toBeNull();
        expect(screen.findByTestId('captured-file-unavailable-missing.png')).toBeTruthy();
        expect(screen.findByTestId('scm-review-diff-area-menu')).toBeNull();
        expect(comparisonCalls().map((call) => call.method)).toEqual([RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE]);
    });
    it.each(['walkthrough', 'files'] as const)('cold-opens direct %s with one saved evidence read and no duplicate capture', async (view) => {
        const source = { kind: 'commit' as const, commit: 'old-ref' };
        boundary.response = { success: false, error: 'must_not_recapture', errorCode: 'DIFF_UNAVAILABLE' };
        const hook = await mount(source);
        await hook.unmount();
        boundary.calls = [];
        const serverId = getStorage().getState().sessions['capture-commit']!.serverId!;
        const scope = { serverId, accountId: 'captured-account' };
        scopes.push(scope);
        const id = 'c'.repeat(64);
        const result = ScmDiffSummaryResultSchema.parse({ resultId: 'saved-result', revision: 1, canUndo: false,
            output: { success: true, resultId: 'saved-result', revision: 1, sourceKey: id, metadata: { sourceKey: id, source },
                comparison: { id, source, repository: { rootPath: '/repo/exact' }, endpoints: { before: 'old-before', after: 'old-after' },
                    inventory: { state: 'complete', files: [{ ...changedFile, occurrences: [{
                        id: 'saved:changed', alias: 'changed', path: changedFile.path, position: 0,
                        before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 },
                    }] }], reasons: [] } }, requestedOutputs: ['walkthrough'],
                outputs: { walkthrough: { state: 'pending' } }, analysis: { suppliedChangeRefs: ['saved:changed'], analysedChangeRefs: [], remainingChangeRefs: ['saved:changed'] } } });
        boundary.savedResponse = { success: true, result };
        boundary.savedInventory = { success: true, results: [{ cwd: '/repo/exact', sessionId: 'capture-commit',
            resultId: result.resultId, revision: result.revision, comparisonId: id, source, bytes: 1, updatedAtMs: 1 }],
            count: 1, bytes: 1 };
        const screen = await renderScreen(<AppPaneProvider><SessionScmReviewDetailsView sessionId="capture-commit"
            serverId={serverId} scopeId="session:capture-commit" target={{ comparison: { ...source, comparisonId: id }, view }} /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('scm-comparison-start-review')?.props.disabled).toBe(false));
        expect(boundary.calls.filter((call) => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE).length).toBe(0);
        expect(boundary.calls.filter((call) => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ).length).toBe(1);
        expect(boundary.calls.find((call) => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ)?.payload)
            .toEqual({ cwd: '/repo/exact', resultId: 'saved-result' });
    });
    it('keeps captured Files readable and disables review with a reason when its Machine goes offline', async () => {
        const source = { kind: 'commit' as const, commit: 'old-ref' };
        const comparison = ScmComparisonSchema.parse({ id: 'offline-comparison', source, repository: { rootPath: '/repo/exact' }, endpoints: {},
            inventory: { state: 'complete', files: [{ ...changedFile, occurrences: [{
                id: 'offline:changed', alias: 'changed', path: changedFile.path, position: 0,
                before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 },
            }] }], reasons: [] } });
        boundary.response = { success: true, comparison, metadata: { sourceKey: comparison.id, source } };
        const hook = await mount(source);
        await hook.unmount();
        const sessionId = 'capture-commit';
        const serverId = getStorage().getState().sessions[sessionId]!.serverId!;
        const screen = await renderScreen(<AppPaneProvider><SessionScmReviewDetailsView sessionId={sessionId}
            serverId={serverId} scopeId={`session:${sessionId}`} target={{ comparison: source, view: 'files' }} /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('captured-comparison-files')).toBeTruthy());
        await vi.waitFor(() => expect(screen.findByTestId('scm-comparison-start-review')?.props.disabled).toBe(false));
        const machine = getStorage().getState().machineListByServerId[serverId]![0]!;
        await act(async () => getStorage().setState({ machines: { [machine.id]: { ...machine, active: false, activeAt: 1 } },
            machineListByServerId: { [serverId]: [{ ...machine, active: false, activeAt: 1 }] } }));
        const review = screen.findByTestId('scm-comparison-start-review');
        expect(review?.props.disabled).toBe(true);
        expect(review?.props.accessibilityHint).toEqual(expect.any(String));
        expect(screen.findHostByTestId('captured-comparison-files')).toBeTruthy();
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.show).mockClear();
        // Calling the owner handler directly must be safe even when a stale trigger fires.
        await act(async () => review!.props.onPress());
        expect(Modal.show).not.toHaveBeenCalled();
        const capturedView = screen.findByType((await import('@/components/sessions/files/views/SessionCapturedScmReviewDetailsView')).SessionCapturedScmReviewDetailsView);
        await act(async () => capturedView.findAll((node) => typeof node.props.onLayout === 'function')[0]!
            .props.onLayout({ nativeEvent: { layout: { width: 390 } } }));
        const menu = screen.findAllByType((await import('@/components/ui/forms/dropdown/DropdownMenu')).DropdownMenu)
            .find((node) => node.props.testID === 'scm-comparison-phone-actions')!;
        expect(menu.props.items.find((item: { id: string }) => item.id === 'start-review'))
            .toMatchObject({ disabled: true, subtitle: expect.any(String) });
        await act(async () => menu.props.onSelect('start-review'));
        expect(Modal.show).not.toHaveBeenCalled();
        await act(async () => getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } }));
        expect(screen.findAllByType((await import('@/components/ui/forms/dropdown/DropdownMenu')).DropdownMenu)
            .find((node) => node.props.testID === 'scm-comparison-phone-actions')!.props.items
            .find((item: { id: string }) => item.id === 'start-review').disabled).toBe(false);
    });
    it('recomposes phone Files into the standard header while keeping view and scope navigation reachable', async () => {
        const source = { kind: 'commit' as const, commit: 'old-ref' };
        const comparison = ScmComparisonSchema.parse({ id: 'phone-comparison', source, repository: { rootPath: '/repo/exact' }, endpoints: {},
            inventory: { state: 'complete', files: [], reasons: [] } });
        boundary.response = { success: true, comparison, metadata: { sourceKey: comparison.id, source } };
        const hook = await mount(source);
        await hook.unmount();
        const sessionId = 'capture-commit';
        const serverId = getStorage().getState().sessions[sessionId]!.serverId!;
        const scopeId = `session:${sessionId}`;
        const screen = await renderScreen(<AppPaneProvider><PaneProbe scopeId={scopeId} /><SessionScmReviewDetailsView sessionId={sessionId}
            serverId={serverId} scopeId={scopeId} target={{ comparison: source, view: 'files' }} /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findByTestId('captured-comparison-files')).toBeTruthy());
        const { SessionCapturedScmReviewDetailsView } = await import('@/components/sessions/files/views/SessionCapturedScmReviewDetailsView');
        const root = screen.findByType(SessionCapturedScmReviewDetailsView).findAll((node) => typeof node.props.onLayout === 'function')[0]!;
        await act(async () => root.props.onLayout({ nativeEvent: { layout: { width: 390 } } }));
        expect(screen.findByTestId('scm-comparison-bar')).toBeNull();
        expect(screen.findByTestId('scm-comparison-phone-more')).toBeTruthy();
        const menu = screen.findAllByType((await import('@/components/ui/forms/dropdown/DropdownMenu')).DropdownMenu)
            .find((node) => node.props.testID === 'scm-comparison-phone-actions')!;
        await act(async () => menu.props.onSelect('view:walkthrough'));
        expect(screen.findByType('PaneProbe' as never).props.state.details.tabs[0]?.resource)
            .toMatchObject({ comparison: { ...source, comparisonId: comparison.id }, view: 'walkthrough' });
    });
    it('shows saved reading coverage in phone Files and jumps between captured files without opening the checkout', async () => {
        const { SPECIMEN_COMPARISON, SPECIMEN_WALKTHROUGH, SPECIMEN_ANALYSIS_COMPLETE } = await import('@/components/dev/changes/walkthroughSpecimenFixture');
        const source = { kind: 'commit' as const, commit: 'saved-ref' };
        const comparison = ScmComparisonSchema.parse({ ...SPECIMEN_COMPARISON, source, id: 'd'.repeat(64), repository: { rootPath: '/repo/exact' } });
        boundary.response = { success: true, comparison, metadata: { sourceKey: comparison.id, source } };
        const hook = await mount(source);
        await hook.unmount();
        const serverId = getStorage().getState().sessions['capture-commit']!.serverId!;
        const scope = { serverId, accountId: 'captured-account' };
        scopes.push(scope);
        const result = ScmDiffSummaryResultSchema.parse({ resultId: 'phone-reading', revision: 1, canUndo: false,
            output: { success: true, resultId: 'phone-reading', revision: 1, sourceKey: comparison.id,
                metadata: { sourceKey: comparison.id, source }, comparison, requestedOutputs: ['walkthrough'],
                producer: { kind: 'generation', modelId: 'fixture-model' },
                outputs: { walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH } }, analysis: SPECIMEN_ANALYSIS_COMPLETE } });
        loadSavedScmDiffSummaryResult({ sessionId: 'capture-commit', scope, result });
        const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
        // Earlier cases deliberately leave retained pane navigation behind. This is a new
        // mounted destination instance, so exercise its navigation without inheriting theirs.
        const savedFilesScopeId = createSessionPaneScopeId('capture-commit', serverId, 'saved-phone-files');
        // The real Details surface feeds its current pane resource back into the view after navigation.
        function SavedFilesPane() {
            const pane = useAppPaneScope(savedFilesScopeId);
            const tab = pane.scopeState?.details.tabs.find((candidate) => candidate.kind === 'scmReview');
            const target = tab ? readSessionScmReviewTarget(tab.resource)
                : { comparison: { ...source, comparisonId: comparison.id }, view: 'files' as const };
            return <SessionScmReviewDetailsView sessionId="capture-commit" serverId={serverId}
                scopeId={savedFilesScopeId} target={target} />;
        }
        const screen = await renderScreen(<AppPaneProvider><SavedFilesPane /></AppPaneProvider>);
        await vi.waitFor(() => expect(screen.findHostByTestId('captured-comparison-files')).toBeTruthy());
        const owner = screen.findByType((await import('@/components/sessions/files/views/SessionCapturedScmReviewDetailsView')).SessionCapturedScmReviewDetailsView);
        await act(async () => owner.findAll((node) => typeof node.props.onLayout === 'function')[0]!
            .props.onLayout({ nativeEvent: { layout: { width: 390 } } }));
        // Captured Files can render from cache before the saved reading's
        // credential-backed Account binding has finished resolving.
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(SPECIMEN_WALKTHROUGH.title));
        expect(screen.findByTestId('walkthrough-analysis-fact')).toBeTruthy();
        expect(screen.findByTestId('scm-comparison-explain')?.props.accessibilityState?.checked).toBe(false);
        expect(screen.findByTestId('scm-comparison-layout:list')).toBeTruthy();
        expect(screen.findByTestId('scm-comparison-layout:tree')).toBeTruthy();
        expect(screen.findByTestId('scm-comparison-file-control')).toBeTruthy();
        await act(async () => screen.pressByTestId('scm-comparison-explain'));
        expect(screen.findByTestId('scm-comparison-explain')?.props.accessibilityState?.checked).toBe(true);
        await act(async () => screen.pressByTestId('scm-comparison-explain'));
        expect(screen.findByTestId('scm-comparison-explain')?.props.accessibilityState?.checked).toBe(false);
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const control = screen.findAllByType(DropdownMenu)
            .find((node) => node.props.testID === 'scm-comparison-file-picker')!;
        boundary.list!.refHandle.scrollToIndex.mockClear();
        const secondPath = comparison.inventory.files[1]!.path;
        await act(async () => control.props.onSelect(secondPath));
        await vi.waitFor(() => expect(boundary.list!.refHandle.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 1, animated: false })));
        // The real viewport boundary reports scrolling to a different file; the control follows it.
        await act(async () => screen.findHostByTestId('scm-review-list')!.props.onViewableItemsChanged({ viewableItems: [{ index: 2, isViewable: true }], changed: [] }));
        await vi.waitFor(() => expect(screen.findAllByType(DropdownMenu)
            .find((node) => node.props.testID === 'scm-comparison-file-picker')!.props.selectedId).toBe(comparison.inventory.files[2]!.path));
    });
});
import * as React from 'react';
