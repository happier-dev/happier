import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ScmComparisonSchema, ScmDiffSummaryResultSchema, type ScmDiffSummaryOutputKind } from '@happier-dev/protocol/scm';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const boundary = vi.hoisted(() => ({ inventory: null as unknown, results: {} as Record<string, unknown>, reads: [] as string[], methods: [] as string[], listInputs: [] as unknown[],
    runs: {} as Record<string, unknown>, runReads: [] as string[],
    draft: null as (() => Promise<unknown>) | null, stopped: [] as string[], stopResult: { ok: true } as unknown,
    undo: null as ((input: unknown) => unknown) | null,
    projection: null as (() => Promise<unknown>) | null }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// Authenticated Machine/Session RPCs are external boundaries; restoration and result state stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const rpc = async (request: { method: string; payload: unknown }) => {
        boundary.methods.push(request.method);
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE && boundary.projection) return boundary.projection();
        if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
            'tool.executionRuns': { ok: true, checkedAt: 1, data: { backends: { codex: { available: true, intents: ['scm_diff_summary'] } } } },
        } };
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_DRAFT_PULL_REQUEST) throw new Error('PR Run admission requires requester-carrying Home HTTP');
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST) { boundary.listInputs.push(request.payload); return boundary.inventory; }
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_UNDO && boundary.undo) return boundary.undo(request.payload);
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ) {
            const id = (request.payload as { resultId: string }).resultId;
            boundary.reads.push(id);
            return boundary.results[id];
        }
        throw new Error(`Unexpected machine boundary: ${request.method}`);
    };
    return createServerScopedMachineRpcBoundaryMock(rpc as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope);
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async importOriginal => {
    const { createServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const rpc = async <R,>(request: { method: string; payload: unknown }): Promise<R> => {
        if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return { runs: [] } as R;
        if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) {
            const runId = (request.payload as { runId: string }).runId;
            boundary.runReads.push(runId);
            if (boundary.runs[runId]) return boundary.runs[runId] as R;
        }
        if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) {
            boundary.stopped.push((request.payload as { runId: string }).runId);
            return boundary.stopResult as R;
        }
        return { ok: false, error: 'Run observation unavailable', errorCode: 'execution_run_not_found' } as R;
    };
    return createServerScopedSessionRpcModuleMock({ importOriginal, overrides: { sessionRpcWithServerScope: rpc, sessionRpcWithServerAccountScope: rpc } });
});
const { renderHook, standardCleanup, createSessionFixture, createMachineFixture, createDeferred, waitForTestEvent } = await import('@/dev/testkit');
const { getStorage } = await import('@/sync/domains/state/storage');
await import('@/sync/syncEngine');
const { useSessionScmWalkthrough, useScmWalkthroughState, useScmWalkthroughStates } = await import('./useSessionScmWalkthrough');
const { useScmResultReceiptUndo } = await import('./useScmResultReceiptUndo');
const { t } = await import('@/text');
const { readScmDiffSummaryPublicationReceipt } = await import('@/sync/domains/scm/diffSummary/publicationReceipt');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { useScmDiffSummaryBinding } = await import('../comparison/useScmDiffSummaryBinding');
const { useWorkspaceScmDiffSummaryBinding } = await import('@/components/projects/scm/useWorkspaceScmDiffSummaryBinding');
const { useSessionScmDraft } = await import('@/hooks/session/sourceControl/useSessionScmDraft');
const { useGitPullRequestBodyDraft } = await import('@/components/sessions/panes/git/pullRequest/useGitPullRequestBodyDraft');
const { useMachinePresenceSummary } = await import('@/components/sessions/model/useMachinePresenceSummary');
const { createScmRunActionHttpBoundary } = await import('@/dev/testkit/harness/scmActionTransport');
const { retireScmDiffSummaryScope, getScmDiffSummaryState } = await import('@/sync/ops/scmDiffSummary/generate');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
let serverId: string;
let capturedScope: ServerAccountScope;
let restorePrDraftSettings: (() => void) | undefined;
const accountId = 'restore-account';
const sessionId = 'restore-session';
const comparison = ScmComparisonSchema.parse({ id: 'same-comparison', source: { kind: 'workingTree' },
    repository: { rootPath: '/repo/exact' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } });
const reading = { state: 'complete', value: { title: 'Published reading', intro: '', stops: [], otherChangeRefs: [] } };
const proposal = { state: 'complete', value: { groups: [], leftOutChangeRefs: [] } };
function saved(resultId: string, outputs: unknown, requestedOutputs: ScmDiffSummaryOutputKind[]) {
    return ScmDiffSummaryResultSchema.parse({ resultId, revision: 1, canUndo: false,
        output: { success: true, resultId, revision: 1, sourceKey: comparison.id,
            metadata: { sourceKey: comparison.id, source: comparison.source }, comparison, requestedOutputs, outputs,
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } });
}
function inventory(results: ReturnType<typeof saved>[], sessionScoped = true) {
    boundary.results = Object.fromEntries(results.map(result => [result.resultId, { success: true, result }]));
    boundary.inventory = { success: true, results: results.map((result, index) => ({ cwd: '/repo/exact', ...(sessionScoped ? { sessionId } : {}),
        resultId: result.resultId, revision: result.revision, comparisonId: result.output.comparison!.id, source: result.output.comparison!.source,
        bytes: 1, updatedAtMs: results.length - index })), count: results.length, bytes: results.length,
        sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: results.length } };
}
beforeEach(async () => {
    boundary.inventory = null;
    boundary.results = {};
    boundary.reads = [];
    boundary.listInputs = [];
    boundary.methods = [];
    boundary.runs = {};
    boundary.runReads = [];
    boundary.draft = null;
    boundary.stopped = [];
    boundary.stopResult = { ok: true };
    boundary.undo = null;
    boundary.projection = null;
    installHomeGovernanceBoundaries(homes);
    serverId = await homes.addHome({ name: 'Restore', serverUrl: 'https://restore.example.test',
        serverIdentityId: 'srv_restore', accountId, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    capturedScope = account.accountOnlyLifetime.scope;
    account.dispose();
    (await createScmRunActionHttpBoundary({ serverUrl: 'https://restore.example.test', serverIdentityId: capturedScope.serverId,
        accountId, machineId: 'restore-machine', actionIds: ['scm.diffSummary.draftPullRequest'], execute() {
            boundary.methods.push(RPC_METHODS.SCM_DIFF_SUMMARY_DRAFT_PULL_REQUEST);
            if (!boundary.draft) throw new Error('Missing PR draft response fixture');
            return boundary.draft();
        } })).installOn(homes, serverId);
    const machine = createMachineFixture({ id: 'restore-machine', activeAt: Date.now() });
    const session = createSessionFixture({ id: sessionId, serverId, active: true,
        metadata: { path: '/repo/exact', host: 'test.local', machineId: machine.id, flavor: 'codex' } });
    getStorage().setState({ sessions: { [sessionId]: session }, machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
});
afterEach(async () => {
    standardCleanup();
    restorePrDraftSettings?.();
    restorePrDraftSettings = undefined;
    retireScmDiffSummaryScope(capturedScope);
    await homes.reset();
});

describe('saved output restoration', () => {
    it.each([undefined, null])('restores a bare Session exact address from its unique Home (route Home: %s)', async routeServerId => {
        const original = saved('bare-session-reading', { walkthrough: reading }, ['walkthrough']);
        boundary.results[original.resultId] = { success: true, result: original };
        const hook = await renderHook(() => useScmWalkthroughState({ sessionId }, { kind: 'workingTree',
            comparisonId: comparison.id, savedResult: { cwd: '/repo/exact', resultId: original.resultId } }, 'walkthrough', routeServerId));
        await waitForHomeGovernance(() => expect(hook.getCurrent().viewModel?.outputs?.walkthrough?.value).toEqual(reading.value));
        expect(hook.getCurrent().restoreState).toBe('ready');
        expect(boundary.reads).toEqual([original.resultId]);
        expect(boundary.listInputs).toEqual([]);
        await hook.rerender();
        expect(boundary.reads).toEqual([original.resultId]);
    });

    it('settles an unreadable Home binding and restores the exact saved reading on explicit Retry', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const readCredentials = TokenStorage.getCredentialsForServerUrl;
        const credentialRead = createDeferred<Awaited<ReturnType<typeof readCredentials>>>();
        let unreadable = true;
        // Device credential storage is the external boundary; scope resolution and restoration stay real.
        const storageRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation((...args) =>
            unreadable ? credentialRead.promise : readCredentials(...args));
        const original = saved('credential-recovery-reading', { walkthrough: reading }, ['walkthrough']);
        boundary.results[original.resultId] = { success: true, result: original };
        const target = { kind: 'workingTree' as const, comparisonId: comparison.id,
            savedResult: { cwd: '/repo/exact', resultId: original.resultId } };
        const hook = await renderHook(() => useScmWalkthroughState({ sessionId }, target, 'walkthrough', serverId));
        try {
            expect(hook.getCurrent().restoreState).toBe('restoring');
            await waitForHomeGovernance(() => expect(storageRead).toHaveBeenCalled());
            await act(async () => { credentialRead.reject(new Error('Device credential storage is unavailable')); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().restoreState).toBe('unavailable'));
            expect(boundary.reads).toEqual([]);
            unreadable = false;
            await act(async () => { hook.getCurrent().retryRestore(); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().viewModel?.outputs?.walkthrough?.value).toEqual(reading.value));
            expect(hook.getCurrent().restoreState).toBe('ready');
            expect(boundary.reads).toEqual([original.resultId]);
            expect(boundary.listInputs).toEqual([]);
        } finally {
            await hook.unmount();
            storageRead.mockRestore();
        }
    });

    it('settles an unknown Home instead of waiting for a read with no credential producer', async () => {
        const hook = await renderHook(() => useScmWalkthroughState({ sessionId }, { kind: 'workingTree',
            savedResult: { cwd: '/repo/exact', resultId: 'saved-reading' } }, 'walkthrough', 'missing-home'));
        await waitForHomeGovernance(() => expect(hook.getCurrent().restoreState).toBe('unavailable'));
        expect(boundary.reads).toEqual([]);
        expect(boundary.listInputs).toEqual([]);
    });

    it('does no retained-result selection walks for unrelated hosts while delivering selected result changes', async () => {
        const { loadSavedScmDiffSummaryResult, applySavedScmDiffSummaryResult, subscribeScmDiffSummaryState } = await import('@/sync/ops/scmDiffSummary/generate');
        const selected = saved('selected-reading', { walkthrough: reading }, ['walkthrough']);
        const selectedKey = loadSavedScmDiffSummaryResult({ sessionId, scope: capturedScope, result: selected })!;
        let unrelatedKey = '';
        let unrelated = selected;
        for (let index = 0; index < 999; index += 1) {
            unrelated = saved(`unrelated-reading-${index}`, { walkthrough: reading }, ['walkthrough']);
            unrelatedKey = loadSavedScmDiffSummaryResult({ sessionId: `unrelated-session-${index}`, scope: capturedScope, result: unrelated })!;
        }
        const mounted = await renderHook(() => useScmWalkthroughStates({ sessionId }, [
            { comparison: { kind: 'workingTree' }, output: 'walkthrough' },
        ], serverId, { restoreState: 'ready', retryRestore: () => {}, machineReachability: 'reachable' }));
        await waitForHomeGovernance(() => expect(mounted.getCurrent().viewModels[0]?.resultId).toBe(selected.resultId));
        const values = Object.values;
        let selectionEntryVisits = 0;
        // Instrument the language boundary, keeping the real selector and store path intact.
        const scan = vi.spyOn(Object, 'values').mockImplementation(value => {
            if (value === getScmDiffSummaryState().entriesByKey) selectionEntryVisits += Object.keys(value).length;
            return values(value);
        });
        const globalChanges = vi.fn();
        const unsubscribe = subscribeScmDiffSummaryState(globalChanges);
        try {
            await act(async () => {
                for (let revision = 2; revision <= 11; revision += 1) applySavedScmDiffSummaryResult(unrelatedKey,
                    { ...unrelated, revision, output: { ...unrelated.output, revision } });
            });
            console.info('WALKTHROUGH_UNRELATED_RESULT_SELECTION', JSON.stringify({ retainedResults: 1000,
                unrelatedChanges: 10, selectionEntryVisits, globalNotifications: globalChanges.mock.calls.length }));
            expect(selectionEntryVisits).toBe(0);
            expect(globalChanges).toHaveBeenCalledTimes(10);
            expect(mounted.getCurrent().viewModels[0]?.savedResult).toEqual(selected);
            await act(async () => applySavedScmDiffSummaryResult(selectedKey, { ...selected, revision: 2,
                output: { ...selected.output, revision: 2, outputs: { walkthrough: { ...reading, state: 'complete' as const,
                    value: { ...reading.value, title: 'Updated selected reading' } } } } }));
            expect(mounted.getCurrent().viewModels[0]?.outputs?.walkthrough?.value?.title).toBe('Updated selected reading');
            expect(globalChanges).toHaveBeenCalledTimes(11);
        } finally {
            scan.mockRestore();
            unsubscribe();
            await mounted.unmount();
        }
    });

    it('dispatches the saved selection list and restores while unrelated plugin hydration remains pending', async () => {
        const { useDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/useDaemonMergedProjectionInputs');
        const { DaemonContributionRegistryProjectionDescribeResponseSchema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const held = createDeferred<unknown>();
        boundary.projection = () => held.promise;
        inventory([saved('projection-independent-reading', { walkthrough: reading }, ['walkthrough'])]);
        const mounted = await renderHook(() => ({
            projection: useDaemonMergedProjectionInputs({ machineId: 'restore-machine', serverId, sections: ['settingsById'] }),
            walkthrough: useSessionScmWalkthrough(sessionId, { kind: 'workingTree' }, 'walkthrough', serverId),
        }));
        try {
            await waitForHomeGovernance(() => expect(boundary.methods).toContain(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE));
            await waitForHomeGovernance(() => expect(mounted.getCurrent().walkthrough?.savedResult?.resultId).toBe('projection-independent-reading'));
            expect(mounted.getCurrent().projection.phase).toBe('loading');
            expect(boundary.listInputs).toHaveLength(1);
            expect(boundary.reads).toEqual(['projection-independent-reading']);
            console.info('WALKTHROUGH_PROJECTION_INDEPENDENT', JSON.stringify({ list: boundary.listInputs.length,
                savedReads: boundary.reads.length, projectionPhase: mounted.getCurrent().projection.phase }));
        } finally {
            held.resolve(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
                projection: { v: 2, generation: 1 } }));
            await mounted.unmount();
        }
    });

    it('mounts a fresh keyless receipt as Undone from its exact saved result without inventory reads', async () => {
        const original = { ...saved('already-undone-receipt', { walkthrough: reading }, ['walkthrough']), canUndo: true };
        const undone = ScmDiffSummaryResultSchema.parse({ ...original, revision: 2, canUndo: false,
            output: { ...original.output, revision: 2 }, updateNotice: { kind: 'undo', revision: 2, affectedStopIds: [] } });
        boundary.results[original.resultId] = { success: true, result: undone };
        const receipt = readScmDiffSummaryPublicationReceipt(original.output,
            { status: 'published', canUndo: true, outputs: [{ kind: 'walkthrough', change: 'updated' }] });
        if (!receipt) throw new Error('Publication receipt is unavailable');
        const mounted = await renderHook(() => useScmResultReceiptUndo({ receipt, sessionId, serverId, canControl: true }));
        await waitForHomeGovernance(() => expect(mounted.getCurrent().undone).toBe(true));
        expect(mounted.getCurrent().onUndo).toBeUndefined();
        expect(mounted.getCurrent().error).toBeNull();
        expect(boundary.methods).toEqual([RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ]);
        await mounted.rerender();
        expect(boundary.methods).toEqual([RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ]);
    });

    it('hydrates a cold keyless receipt once and sends Undo without rereading its body', async () => {
        const original = { ...saved('cold-receipt', { walkthrough: reading }, ['walkthrough']), canUndo: true };
        const undone = ScmDiffSummaryResultSchema.parse({ ...original, revision: 2, canUndo: false,
            output: { ...original.output, revision: 2, outputs: { walkthrough: {
                state: 'complete', value: { ...reading.value, title: 'Before the update' },
            } } }, updateNotice: { kind: 'undo', revision: 2, affectedStopIds: [] } });
        boundary.results[original.resultId] = { success: true, result: original };
        boundary.undo = input => {
            expect(input).toEqual({ cwd: '/repo/exact', resultId: original.resultId, expectedRevision: original.revision });
            // The exact read must already have entered the real result store before CAS Undo.
            expect(Object.values(getScmDiffSummaryState().entriesByKey).map(entry => entry.savedResult)).toEqual([original]);
            return { success: true, result: undone };
        };
        const receipt = readScmDiffSummaryPublicationReceipt(original.output,
            { status: 'published', canUndo: true, outputs: [{ kind: 'walkthrough', change: 'updated' }] });
        if (!receipt) throw new Error('Publication receipt is unavailable');
        const mounted = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(serverId);
            return { ...useScmResultReceiptUndo({ receipt, sessionId, serverId, canControl: true }),
                scopeReady: binding?.isCurrent() === true };
        });
        await waitForHomeGovernance(() => expect(mounted.getCurrent().scopeReady).toBe(true));
        await waitForHomeGovernance(() => expect(mounted.getCurrent().onUndo).toBeTypeOf('function'));
        expect(Object.values(getScmDiffSummaryState().entriesByKey).map(entry => entry.savedResult)).toEqual([original]);
        expect(boundary.methods).toEqual([RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ]);

        await act(async () => mounted.getCurrent().onUndo?.());

        expect(boundary.methods).toEqual([RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ, RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_UNDO]);
        expect(Object.values(getScmDiffSummaryState().entriesByKey).map(entry => entry.savedResult)).toEqual([undone]);
        expect(mounted.getCurrent()).toMatchObject({ undoing: false, undone: true, failure: null, error: null });
        expect(mounted.getCurrent().onUndo).toBeUndefined();
    });

    it('undoes only the current loaded receipt through the revisioned Action and keeps the saved projection current', async () => {
        const { loadSavedScmDiffSummaryResult, applySavedScmDiffSummaryResult } = await import('@/sync/ops/scmDiffSummary/generate');
        const original = { ...saved('receipt-reading', { walkthrough: reading }, ['walkthrough']), canUndo: true };
        const scope = capturedScope;
        const key = loadSavedScmDiffSummaryResult({ sessionId, scope, result: original });
        if (!key) throw new Error('Saved reading is unavailable');
        const receipt = readScmDiffSummaryPublicationReceipt(original.output,
            { status: 'published', canUndo: true, outputs: [{ kind: 'walkthrough', change: 'updated' }] });
        if (!receipt) throw new Error('Publication receipt is unavailable');
        const mounted = await renderHook(({ currentReceipt, requestKey }) => {
            const { binding } = useServerCredentialAccountScopeBinding(serverId);
            const undo = useScmResultReceiptUndo({ receipt: currentReceipt, sessionId, serverId, canControl: true, requestKey });
            return { ...undo, scopeReady: binding?.isCurrent() === true };
        },
            { initialProps: { currentReceipt: receipt, requestKey: key as string | null } });
        await waitForHomeGovernance(() => expect(mounted.getCurrent().scopeReady).toBe(true));
        expect(mounted.getCurrent().onUndo).toBeTypeOf('function');
        await mounted.rerender({ currentReceipt: receipt, requestKey: key });
        expect(mounted.getCurrent().onUndo).toBeTypeOf('function');
        expect(boundary.methods).toEqual([]);
        const newer = ScmDiffSummaryResultSchema.parse({ ...original, revision: 2, output: { ...original.output, revision: 2 } });
        const staleCallback = mounted.getCurrent().onUndo!;
        await act(async () => applySavedScmDiffSummaryResult(key, newer));
        expect(mounted.getCurrent().onUndo).toBeUndefined();
        await act(async () => staleCallback());
        expect(boundary.methods).toEqual([]);
        const currentReceipt = readScmDiffSummaryPublicationReceipt(newer.output, receipt.publication);
        if (!currentReceipt) throw new Error('Current receipt is unavailable');
        await mounted.rerender({ currentReceipt, requestKey: key });
        const undone = ScmDiffSummaryResultSchema.parse({ ...newer, revision: 3, canUndo: false, output: { ...newer.output, revision: 3,
            outputs: { walkthrough: { state: 'complete', value: { ...reading.value, title: 'Before the update' } } } },
            updateNotice: { kind: 'undo', revision: 3, affectedStopIds: [] } });
        boundary.undo = input => {
            expect(input).toEqual({ cwd: '/repo/exact', resultId: newer.resultId, expectedRevision: newer.revision });
            return { success: true, result: undone };
        };
        boundary.results[newer.resultId] = { success: true, result: newer };
        await act(async () => mounted.getCurrent().onUndo?.());
        expect(boundary.methods).toEqual([RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_UNDO]);
        expect(getScmDiffSummaryState().entriesByKey[key]?.savedResult).toEqual(undone);
        expect(mounted.getCurrent().onUndo).toBeUndefined();
        expect(mounted.getCurrent().undone).toBe(true);
    });

    it.each(['revision_conflict', 'application_locked', 'nothing_to_undo'] as const)('forwards a warm receipt Undo refusal from the Action without a preflight read: %s', async errorCode => {
        const { loadSavedScmDiffSummaryResult } = await import('@/sync/ops/scmDiffSummary/generate');
        const original = { ...saved(`warm-refusal-${errorCode}`, { walkthrough: reading }, ['walkthrough']), canUndo: true };
        const key = loadSavedScmDiffSummaryResult({ sessionId, scope: capturedScope, result: original });
        if (!key) throw new Error('Saved reading is unavailable');
        const receipt = readScmDiffSummaryPublicationReceipt(original.output,
            { status: 'published', canUndo: true, outputs: [{ kind: 'walkthrough', change: 'updated' }] });
        if (!receipt) throw new Error('Publication receipt is unavailable');
        boundary.undo = () => ({ success: false, errorCode, error: 'Machine refused Undo',
            ...(errorCode === 'revision_conflict' ? { latestRevision: 2 } : {}) });
        const mounted = await renderHook(() => useScmResultReceiptUndo({ receipt, sessionId, serverId, canControl: true, requestKey: key }));
        await waitForHomeGovernance(() => expect(mounted.getCurrent().onUndo).toBeTypeOf('function'));
        await act(async () => mounted.getCurrent().onUndo?.());
        expect(boundary.methods).toEqual([RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_UNDO]);
        expect(mounted.getCurrent().failure).toMatchObject({ errorCode,
            ...(errorCode === 'revision_conflict' ? { latestRevision: 2 } : {}) });
        expect(getScmDiffSummaryState().entriesByKey[key]?.savedResult).toEqual(original);
    });

    it('reads a keyless receipt on mount and retains the changed-since fact for a later unrelated edit', async () => {
        const original = { ...saved('keyless-receipt', { walkthrough: reading }, ['walkthrough']), canUndo: true };
        const newer = ScmDiffSummaryResultSchema.parse({ ...original, revision: 2, output: { ...original.output, revision: 2 } });
        boundary.results[original.resultId] = { success: true, result: newer };
        const receipt = readScmDiffSummaryPublicationReceipt(original.output,
            { status: 'published', canUndo: true, outputs: [{ kind: 'walkthrough', change: 'updated' }] });
        if (!receipt) throw new Error('Publication receipt is unavailable');
        const mounted = await renderHook(({ currentReceipt }) => {
            const { binding } = useServerCredentialAccountScopeBinding(serverId);
            const undo = useScmResultReceiptUndo({ receipt: currentReceipt, sessionId, serverId, canControl: true });
            return { ...undo, scopeReady: binding?.isCurrent() === true };
        }, { initialProps: { currentReceipt: receipt } });
        await waitForHomeGovernance(() => expect(mounted.getCurrent().scopeReady).toBe(true));
        await waitForHomeGovernance(() => expect(mounted.getCurrent().failure?.errorCode).toBe('revision_conflict'));
        expect(boundary.methods).toEqual([RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ]);
        expect(mounted.getCurrent().failure).toMatchObject({ success: false, errorCode: 'revision_conflict', latestRevision: 2 });
        // A receipt whose walkthrough moved on says so about the walkthrough, not about an unsaved draft it never had.
        expect(mounted.getCurrent().error).toBe(t('walkthrough.receipt.changedSince'));
        expect(mounted.getCurrent().onUndo).toBeUndefined();
        expect(mounted.getCurrent().undone).toBe(false);

        const currentReceipt = readScmDiffSummaryPublicationReceipt(newer.output, receipt.publication);
        if (!currentReceipt) throw new Error('Current receipt is unavailable');
        await mounted.rerender({ currentReceipt });
        const undone = ScmDiffSummaryResultSchema.parse({ ...newer, revision: 3, canUndo: false, output: { ...newer.output, revision: 3,
            outputs: { walkthrough: { state: 'complete', value: { ...reading.value, title: 'Before the update' } } } },
            updateNotice: { kind: 'undo', revision: 3, affectedStopIds: [] } });
        boundary.undo = input => {
            expect(input).toEqual({ cwd: '/repo/exact', resultId: newer.resultId, expectedRevision: newer.revision });
            return { success: true, result: undone };
        };
        await act(async () => mounted.getCurrent().onUndo?.());
        expect(boundary.methods).toEqual([RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ, RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_UNDO]);
        expect(Object.values(getScmDiffSummaryState().entriesByKey).filter(entry => entry.savedResult?.resultId === undone.resultId)
            .map(entry => entry.savedResult)).toEqual([undone]);
        expect(mounted.getCurrent().onUndo).toBeUndefined();
        expect(mounted.getCurrent().failure).toBeNull();
    });

    it.each(['nothing_to_undo', 'application_locked'] as const)('does not offer Undo when the exact saved result is %s', async errorCode => {
        const original = { ...saved('unavailable-undo', { walkthrough: reading }, ['walkthrough']), canUndo: true };
        const current = ScmDiffSummaryResultSchema.parse({ ...original, canUndo: errorCode !== 'nothing_to_undo',
            ...(errorCode === 'application_locked' ? { application: { acceptedRevision: 1, status: 'applying', steps: [],
                nextGroupIndex: 0, stopAfterCurrent: false, acceptance: { groups: [], leftOutChangeRefs: [],
                    comparisonId: comparison.id, repositoryRootPath: '/repo/exact', expectedHeadOid: null, expectedRef: null } } } : {}) });
        boundary.results[original.resultId] = { success: true, result: current };
        const receipt = readScmDiffSummaryPublicationReceipt(original.output,
            { status: 'published', canUndo: true, outputs: [{ kind: 'walkthrough', change: 'updated' }] });
        if (!receipt) throw new Error('Publication receipt is unavailable');
        const mounted = await renderHook(() => {
            const { binding } = useServerCredentialAccountScopeBinding(serverId);
            return { ...useScmResultReceiptUndo({ receipt, sessionId, serverId, canControl: true }), scopeReady: binding?.isCurrent() === true };
        });
        await waitForHomeGovernance(() => expect(mounted.getCurrent().scopeReady).toBe(true));
        await waitForHomeGovernance(() => expect(boundary.methods).toEqual([RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ]));
        await act(async () => mounted.getCurrent().onUndo?.());
        expect(boundary.methods).toEqual([RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ]);
        expect(mounted.getCurrent().undone).toBe(false);
        expect(mounted.getCurrent().onUndo).toBeUndefined();
    });

    it.each([false, true])('shares the workspace binding inventory with its pending proposal projection (older proposal: %s)', async olderProposal => {
        const original = saved('workspace-reading', { walkthrough: reading }, ['walkthrough']);
        inventory([original, ...(olderProposal ? [saved('workspace-proposal', { commitPlan: proposal }, ['commitPlan'])] : [])], false);
        const target = { kind: 'workingTree' as const, comparisonId: comparison.id };
        const parent = await renderHook(() => {
            const bound = useWorkspaceScmDiffSummaryBinding({ machineId: 'restore-machine', rootPath: '/repo/exact', serverId,
                comparison: target, output: 'walkthrough', restoreSelections: [{ comparison: { kind: 'workingTree' }, output: 'commitPlan' }] });
            const plan = useScmWalkthroughState({ machineId: 'restore-machine', cwd: '/repo/exact' }, { kind: 'workingTree' }, 'commitPlan', serverId, bound.restoration);
            return { reading: bound.viewModel, plan };
        });
        await waitForHomeGovernance(() => expect(parent.getCurrent().plan.restoreState).toBe('ready'));
        expect(parent.getCurrent().reading?.resultId).toBe(original.resultId);
        expect(parent.getCurrent().plan.viewModel?.resultId ?? null).toBe(olderProposal ? 'workspace-proposal' : null);
        expect(boundary.methods.filter(method => method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST)).toHaveLength(1);
        expect(boundary.reads).toEqual([original.resultId, ...(olderProposal ? ['workspace-proposal'] : [])]);
    });
    it('acquires the comparison once for both parent outputs, including known absence and later publication', async () => {
        const original = saved('shared-reading', { walkthrough: reading }, ['walkthrough']);
        inventory([original]);
        const target = { kind: 'workingTree' as const, comparisonId: comparison.id };
        const parent = await renderHook(() => {
            const restored = useScmWalkthroughStates({ sessionId }, [
                { comparison: target, output: 'walkthrough' },
                { comparison: { kind: 'workingTree' }, output: 'commitPlan' },
            ], serverId);
            const child = useScmWalkthroughState({ sessionId }, target, 'walkthrough', serverId, restored.restoration);
            return { reading: child.viewModel, plan: restored.viewModels[1], restoreState: restored.restoration.restoreState };
        });
        await waitForHomeGovernance(() => expect(parent.getCurrent().reading?.resultId).toBe(original.resultId));
        expect(parent.getCurrent().plan).toBeNull();
        await waitForHomeGovernance(() => expect(parent.getCurrent().restoreState).toBe('ready'));
        expect(boundary.methods.filter(method => method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST)).toHaveLength(1);
        expect(boundary.reads).toEqual([original.resultId]);
        expect(boundary.listInputs).toEqual([{ query: { cwd: '/repo/exact', sessionId, comparisons: [
            { source: { kind: 'workingTree' }, comparisonId: comparison.id, outputs: ['walkthrough'] },
            { source: { kind: 'workingTree' }, outputs: ['commitPlan'] },
        ] } }]);
        const { applySavedScmDiffSummaryResult } = await import('@/sync/ops/scmDiffSummary/generate');
        const updated = ScmDiffSummaryResultSchema.parse({ ...original, revision: 2,
            output: { ...original.output, revision: 2, requestedOutputs: ['walkthrough', 'commitPlan'],
                outputs: { walkthrough: reading, commitPlan: proposal } } });
        await act(async () => { applySavedScmDiffSummaryResult(parent.getCurrent().reading!.requestKey!, updated); });
        await waitForHomeGovernance(() => expect(parent.getCurrent().plan?.outputs?.commitPlan?.value).toEqual(proposal.value));
        expect(parent.getCurrent().reading?.outputs?.walkthrough?.value).toEqual(reading.value);
        expect(boundary.methods.filter(method => method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST)).toHaveLength(1);
        expect(boundary.reads).toEqual([original.resultId]);
    });
    it('exposes a failed PR saved-result read with Retry instead of a machine/model prerequisite', async () => {
        await (await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage')).prepareSessionDraftPersistenceStorage();
        boundary.inventory = { success: false, errorCode: 'BACKEND_UNAVAILABLE', error: 'Read unavailable' };
        const form = await renderHook(() => useGitPullRequestBodyDraft({ sessionId, serverId, head: 'feature', base: 'main', body: '', setBody: () => {} }));
        await vi.waitFor(() => expect(form.getCurrent().restoreFailed).toBe(true));
        expect(form.getCurrent()).toMatchObject({ canDraft: false, prerequisite: null });
        inventory([]);
        await act(async () => form.getCurrent().retryRestore());
        await vi.waitFor(() => expect(form.getCurrent().restoreFailed).toBe(false));
        expect(boundary.methods).not.toContain(RPC_METHODS.SCM_DIFF_SUMMARY_DRAFT_PULL_REQUEST);
    });

    const draftComparison = ScmComparisonSchema.parse({ ...comparison, source: { kind: 'branch', head: 'feature', base: 'main' } });
    function draftResult(resultId: string, complete = false, unknown = false) {
        const original = saved(resultId, { summary: complete
            ? { state: 'complete', value: { summaryMarkdown: 'Changes', suggestedPrBody: 'Admitted description' } }
            : { state: 'pending' } }, ['summary']);
        return ScmDiffSummaryResultSchema.parse({ ...original, output: {
            ...original.output,
            comparison: draftComparison, metadata: { sourceKey: comparison.id, source: draftComparison.source },
            ...(unknown ? { admission: 'outcomeUnknown' } : { runId: 'draft-run' }),
        } });
    }
    async function mountPendingDraft(resultId: string | null) {
        await (await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage')).prepareSessionDraftPersistenceStorage();
        const owner = await renderHook(() => useSessionScmDraft({ sessionId, serverId }));
        const key = JSON.stringify(['restore-machine', '/repo/exact', 'feature', 'main']);
        await act(async () => owner.getCurrent().setPullRequest({ title: 'Changes', body: '', draft: false, base: 'main',
            bodyDraft: { key, attempt: resultId ? { bodyAtRequest: '', baselineResultId: null, baselineRevision: null, started: true, resultId } : null, candidate: null } }));
        const form = await renderHook(() => useGitPullRequestBodyDraft({ sessionId, serverId, head: 'feature', base: 'main', body: '', setBody: () => {} }));
        return { owner, form };
    }
    async function offerPrDraftModel() {
        const { createScmDiffSummaryModelCatalogHttpBoundary } = await import('@/dev/testkit/harness/scmDiffSummaryModelCatalogBoundary');
        const { buildScmDiffSummaryModelProfiles } = await import('@/settings/scmDiffSummary/models');
        const { SCM_DIFF_SUMMARY_SETTING_KEYS } = await import('@/settings/scmDiffSummary/settings');
        const target = { backendTarget: { kind: 'backend' as const, backendId: 'codex' },
            models: [{ id: 'pr-draft-model', name: 'PR draft model', capabilities: { structuredOutput: 'supported' as const } }] };
        const profile = buildScmDiffSummaryModelProfiles(target)[0]!;
        // These restoration cases exercise an admitted draft, with an explicitly offered model.
        // Catalog transport is the boundary; selection and readiness remain real.
        (await createScmDiffSummaryModelCatalogHttpBoundary({ serverUrl: 'https://restore.example.test',
            serverIdentityId: capturedScope.serverId, accountId, machineId: 'restore-machine', targets: [target] })).installOn(homes, serverId);
        const settings = getStorage().getState().settings;
        restorePrDraftSettings = () => getStorage().setState({ settings });
        getStorage().setState({ settings: { ...settings,
            [SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]: profile.catalogId } });
    }
    it('keeps an unknown PR draft pending and rereads its exact receipt to apply once without another Start', async () => {
        const uncertain = draftResult('draft-uncertain', false, true);
        inventory([draftResult('before-draft', true)]);
        await offerPrDraftModel();
        getStorage().setState({ settings: { ...getStorage().getState().settings, experiments: true, featureToggles: { 'execution.runs': true } } });
        (await import('@/dev/testkit/harness/machinePresence')).observeMachinePresenceForTest(capturedScope, ['restore-machine']);
        const response = createDeferred<unknown>();
        boundary.draft = () => response.promise;
        const mounted = await mountPendingDraft(null);
        const { owner } = mounted;
        await vi.waitFor(() => expect(mounted.form.getCurrent().canDraft, mounted.form.getCurrent().prerequisite ?? undefined).toBe(true));
        let pending: Promise<void> | undefined;
        await act(async () => { pending = mounted.form.getCurrent().draft(); });
        await vi.waitFor(() => expect(boundary.methods).toContain(RPC_METHODS.SCM_DIFF_SUMMARY_DRAFT_PULL_REQUEST));
        await mounted.form.unmount();
        const form = await renderHook(() => useGitPullRequestBodyDraft({ sessionId, serverId, head: 'feature', base: 'main', body: '', setBody: () => {} }));
        boundary.results[uncertain.resultId] = { success: true, result: uncertain };
        await act(async () => { response.resolve(uncertain.output); await pending; });
        expect(owner.getCurrent().draft.pullRequest?.bodyDraft?.attempt).toMatchObject({ resultId: uncertain.resultId });
        expect(form.getCurrent().admission).toBe('outcomeUnknown');
        expect(form.getCurrent()).toMatchObject({ drafting: true, canDraft: false, failure: null, runId: null });
        await act(async () => { await form.getCurrent().draft(); });
        expect(boundary.methods.filter(method => method === RPC_METHODS.SCM_DIFF_SUMMARY_DRAFT_PULL_REQUEST)).toHaveLength(1);
        const complete = draftResult(uncertain.resultId, true);
        boundary.results[uncertain.resultId] = { success: true, result: complete };
        boundary.methods = [];
        await act(async () => { await form.getCurrent().checkAdmission(); });
        await vi.waitFor(() => expect(owner.getCurrent().draft.pullRequest?.body).toBe('Admitted description'));
        expect(form.getCurrent().drafting).toBe(false);
        await act(async () => owner.getCurrent().setPullRequest(current => current ? { ...current, body: 'My later edit' } : current));
        await act(async () => { await form.getCurrent().checkAdmission(); });
        expect(owner.getCurrent().draft.pullRequest?.body).toBe('My later edit');
        expect(boundary.methods.every(method => method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ)).toBe(true);
    });
    it('ignores an unrelated restored result and checks the admitted PR draft identity', async () => {
        const unrelated = draftResult('unrelated-summary', true);
        inventory([unrelated]);
        const restoredRead = createDeferred<unknown>();
        boundary.results[unrelated.resultId] = restoredRead.promise;
        boundary.results['admitted-draft'] = { success: true, result: draftResult('admitted-draft', false, true) };
        const { owner, form } = await mountPendingDraft('admitted-draft');
        await vi.waitFor(() => expect(boundary.reads).toContain('unrelated-summary'));
        // A dispatched read is not a restored projection. Wait for the real form's commit,
        // so the single admission check uses its restored binding rather than an earlier callback.
        const restored = waitForTestEvent(form.subscribe, () => expect(Object.values(getScmDiffSummaryState().entriesByKey)
            .some(entry => entry.savedResult?.resultId === unrelated.resultId)).toBe(true));
        await act(async () => { restoredRead.resolve({ success: true, result: unrelated }); });
        await restored;
        expect(owner.getCurrent().draft.pullRequest?.body).toBe('');
        expect(owner.getCurrent().draft.pullRequest?.bodyDraft?.attempt).toMatchObject({ resultId: 'admitted-draft' });
        boundary.reads = [];
        await act(async () => { await form.getCurrent().checkAdmission(); });
        expect(boundary.reads).toContain('admitted-draft');
        expect(owner.getCurrent().draft.pullRequest?.body).toBe('');
    });
    it('cancels the admitted PR Run through the shared stop owner and clears only its pending attempt', async () => {
        inventory([draftResult('draft-to-cancel')]);
        const { owner, form } = await mountPendingDraft('draft-to-cancel');
        await vi.waitFor(() => expect(boundary.reads).toContain('draft-to-cancel'));
        await waitForTestEvent(form.subscribe, () => expect(form.getCurrent().runId).toBe('draft-run'));
        await act(async () => owner.getCurrent().setPullRequest(current => current?.bodyDraft ? { ...current, body: 'Keep my notes',
            bodyDraft: { ...current.bodyDraft, candidate: 'Earlier candidate' } } : current));
        const { normalizeActionsSettingsV1 } = await import('@happier-dev/protocol/actions/actionSettings');
        const settings = getStorage().getState().settings;
        const setStopPolicy = (enabled: boolean) => {
            const next = { ...settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                actions: { 'execution.run.stop': { enabled } } }) };
            getStorage().setState({ settings: next });
            homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: next }, version: enabled ? 3 : 2 } });
        };
        await act(async () => setStopPolicy(false));
        await act(async () => { await form.getCurrent().cancel!(); });
        expect(boundary.stopped).toEqual([]);
        expect(form.getCurrent().drafting).toBe(true);
        await act(async () => setStopPolicy(true));
        boundary.stopResult = { ok: false, error: 'Stop refused', errorCode: 'execution_run_stop_failed' };
        await act(async () => { await form.getCurrent().cancel!(); });
        expect(form.getCurrent()).toMatchObject({ drafting: true, canDraft: false });
        boundary.stopResult = { ok: true };
        await act(async () => { await form.getCurrent().cancel!(); });
        expect(boundary.stopped).toEqual(['draft-run', 'draft-run']);
        expect(form.getCurrent().drafting).toBe(false);
        expect(owner.getCurrent().draft.pullRequest?.body).toBe('Keep my notes');
        expect(owner.getCurrent().draft.pullRequest?.bodyDraft?.candidate).toBe('Earlier candidate');
    });
    it.each([false, true])('retains a PR draft acknowledgement across remount only while its Account is current (retired: %s)', async retired => {
        const original = saved('before-description', { summary: { state: 'complete', value: {
            summaryMarkdown: 'Previous summary', suggestedPrBody: 'Previous description',
        } } }, ['summary']);
        inventory([original]);
        await offerPrDraftModel();
        const request = createDeferred<unknown>();
        boundary.draft = () => request.promise;
        const mount = () => renderHook(() => useScmDiffSummaryBinding({ host: { sessionId }, serverId,
            machine: { machineId: 'restore-machine', basePath: '/repo/exact' }, machineReachable: true,
            canControl: true, canSend: true, launch: { canLaunchExecutionRuns: true },
            comparison: { kind: 'workingTree' }, output: 'summary' }));
        const sidebar = await mount();
        await vi.waitFor(() => expect(sidebar.getCurrent().viewModel?.resultId).toBe(original.resultId));
        await vi.waitFor(() => expect(sidebar.getCurrent().modelAvailable).toBe(true));
        let pending: ReturnType<ReturnType<typeof useScmDiffSummaryBinding>['onStart']> | undefined;
        await act(async () => { pending = sidebar.getCurrent().onStart(['summary'], { pullRequestDraft: {} }); });
        await vi.waitFor(() => expect(boundary.methods).toContain(RPC_METHODS.SCM_DIFF_SUMMARY_DRAFT_PULL_REQUEST));
        await sidebar.unmount();
        const details = await mount();
        if (retired) {
            boundary.inventory = { success: false, errorCode: 'result_unavailable', error: 'Retired Account' };
            await act(async () => homes.switchAccount(serverId, 'replacement-account'));
        }
        const arrived = saved('after-description', { summary: { state: 'complete', value: {
            summaryMarkdown: 'New summary', suggestedPrBody: 'New description',
        } } }, ['summary']);
        if (!retired) inventory([arrived]);
        let acknowledged: unknown;
        await act(async () => { request.resolve(arrived.output); acknowledged = await pending; });
        if (retired) {
            expect(details.getCurrent().viewModel).toBeNull();
            expect(Object.values(getScmDiffSummaryState().entriesByKey).some(entry => entry.latestOutput?.resultId === arrived.resultId)).toBe(false);
        } else {
            expect(acknowledged).toMatchObject({ ok: true, resultId: arrived.resultId, viewModel: { resultId: arrived.resultId } });
            await vi.waitFor(() => expect(details.getCurrent().viewModel).toMatchObject({
                status: 'succeeded', resultId: arrived.resultId, suggestedPrBody: 'New description',
            }));
        }
    });

    it('rechecks uncertain admission against the exact saved result without starting another Run', async () => {
        const original = saved('uncertain-start', { walkthrough: { state: 'pending' } }, ['walkthrough']);
        const uncertain = ScmDiffSummaryResultSchema.parse({ ...original, output: { ...original.output, admission: 'outcomeUnknown' } });
        inventory([uncertain]);
        const hook = await renderHook(() => useScmDiffSummaryBinding({ host: { sessionId }, serverId,
            machine: { machineId: 'restore-machine', basePath: '/repo/exact' }, machineReachable: true,
            canControl: true, canSend: false, launch: { canLaunchExecutionRuns: false },
            comparison: { kind: 'workingTree', comparisonId: comparison.id }, output: 'walkthrough' }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().viewModel?.status).toBe('unknown'));
        // Ignore initial hydration reads; only the explicit recheck's network effects matter.
        boundary.methods = [];
        await act(async () => { await hook.getCurrent().checkAdmission(); });
        // Model-catalog observation is independent of this receipt check. Keep all
        // SCM operations in the assertion so another generation still fails it.
        expect(boundary.methods.filter(method => method.startsWith('scm.diffSummary.')))
            .toEqual([RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ]);
        expect(hook.getCurrent().admission).toBe('outcomeUnknown');
        boundary.results[uncertain.resultId] = { success: true, result: ScmDiffSummaryResultSchema.parse({
            ...original, revision: 2, output: { ...original.output, revision: 2, runId: 'original-start' },
        }) };
        await act(async () => { await hook.getCurrent().checkAdmission(); });
        expect(hook.getCurrent().viewModel).toMatchObject({ status: 'running', admission: null, executionRunId: 'original-start', resultId: uncertain.resultId });
    });
    it.each(['hint', 'reconnect'] as const)('restores an unknown result from %s without listing for unrelated Run activity', async wake => {
        const { notifyExecutionRunActivity } = await import('@/sync/runtime/executionRuns/executionRunActivityBus');
        const { notifyScmDiffSummaryResultActivity } = await import('@/sync/ops/scmDiffSummary/resultActivity');
        inventory([]);
        const hook = await renderHook(() => useScmWalkthroughState({ sessionId }, { kind: 'workingTree' }, 'walkthrough', serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent().restoreState).toBe('ready'));
        expect(hook.getCurrent().viewModel).toBeNull();
        boundary.listInputs = [];
        for (let index = 0; index < 3; index += 1) {
            await act(async () => notifyExecutionRunActivity({ sessionId, serverId: capturedScope.serverId }, { runId: `unrelated-${index}` }));
        }
        expect(boundary.listInputs).toHaveLength(0);
        const published = saved('new-reading', { walkthrough: reading }, ['walkthrough']);
        inventory([published]);
        await act(async () => notifyScmDiffSummaryResultActivity(capturedScope.serverId,
            { type: 'scm-diff-summary-result-updated', machineId: 'other-machine', resultId: published.resultId, revision: 1 }));
        expect(boundary.listInputs).toHaveLength(0);
        if (wake === 'hint') {
            await act(async () => notifyScmDiffSummaryResultActivity(capturedScope.serverId,
                { type: 'scm-diff-summary-result-updated', machineId: 'restore-machine', resultId: published.resultId, revision: 1 }));
        } else {
            const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
            await act(async () => publishHomeAccountChange(capturedScope.serverId, undefined, { source: 'connected' }));
        }
        await waitForHomeGovernance(() => expect(hook.getCurrent().viewModel?.resultId).toBe(published.resultId));
        expect(boundary.listInputs).toHaveLength(1);
        expect(boundary.reads).toEqual([published.resultId]);
    });
    it('keeps saved reads off Run hints and reads one exact revision hint', async () => {
        const { notifyExecutionRunActivity, notifyExecutionRunActivityReconnect } = await import('@/sync/runtime/executionRuns/executionRunActivityBus');
        const { notifyScmDiffSummaryResultActivity } = await import('@/sync/ops/scmDiffSummary/resultActivity');
        const original = saved('linked-reading', { walkthrough: reading }, ['walkthrough']);
        const linked = ScmDiffSummaryResultSchema.parse({ ...original, output: { ...original.output, runId: 'reading-run' } });
        boundary.runs['reading-run'] = ExecutionRunGetResponseSchema.parse({ run: {
            runId: 'reading-run', callId: 'reading-call', sidechainId: 'reading-sidechain', intent: 'scm_diff_summary',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
            retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
        } });
        inventory([linked]);
        const hook = await renderHook(() => useScmDiffSummaryBinding({ host: { sessionId }, serverId,
            machine: { machineId: 'restore-machine', basePath: '/repo/exact' }, machineReachable: true,
            canControl: true, canSend: false, launch: { canLaunchExecutionRuns: false },
            comparison: { kind: 'workingTree', comparisonId: comparison.id }, output: 'walkthrough' }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().viewModel?.latestRun?.runId).toBe('reading-run'));
        boundary.reads = [];
        boundary.runReads = [];
        for (let index = 0; index < 20; index += 1) {
            await act(async () => notifyExecutionRunActivity({ sessionId, serverId: capturedScope.serverId }, { runId: `sibling-${index}` }));
        }
        expect(boundary.reads).toEqual([]);
        expect(boundary.runReads).toEqual([]);

        const updated = ScmDiffSummaryResultSchema.parse({ ...linked, revision: 2, output: { ...linked.output, revision: 2,
            outputs: { walkthrough: { ...reading, value: { ...reading.value, title: 'Current reading' } } } } });
        boundary.results[linked.resultId] = { success: true, result: updated };
        for (let index = 0; index < 3; index += 1) {
            await act(async () => notifyExecutionRunActivity({ sessionId, serverId: capturedScope.serverId }, { runId: 'reading-run' }));
            await vi.waitFor(() => expect(boundary.runReads).toHaveLength(index + 1));
        }
        expect(boundary.reads).toEqual([]);
        expect(hook.getCurrent().viewModel?.revision).toBe(1);
        await act(async () => notifyScmDiffSummaryResultActivity(capturedScope.serverId,
            { type: 'scm-diff-summary-result-updated', machineId: 'restore-machine', resultId: linked.resultId, revision: 2 }));
        await vi.waitFor(() => expect(hook.getCurrent().viewModel?.revision).toBe(2));
        expect(hook.getCurrent().viewModel?.outputs?.walkthrough?.value?.title).toBe('Current reading');
        expect(boundary.reads).toEqual([linked.resultId]);
        expect(boundary.runReads).toEqual(['reading-run', 'reading-run', 'reading-run']);
        for (const wake of [() => notifyExecutionRunActivity({ sessionId, serverId: capturedScope.serverId }), () => notifyExecutionRunActivityReconnect(capturedScope.serverId)]) {
            boundary.reads = [];
            boundary.runReads = [];
            await act(async () => wake());
            await vi.waitFor(() => expect(boundary.runReads).toEqual(['reading-run']));
            expect(boundary.reads).toEqual([]);
        }
    });
    it('discovers an unbound seeded discussion and observes the replacement linkage returned by its saved owner', async () => {
        const { notifyScmDiffSummaryResultActivity } = await import('@/sync/ops/scmDiffSummary/resultActivity');
        const { applySavedScmDiffSummaryResult } = await import('@/sync/ops/scmDiffSummary/generate');
        const original = saved('seeded-reading', { walkthrough: reading }, ['walkthrough']);
        inventory([original]);
        const hook = await renderHook(() => useScmDiffSummaryBinding({ host: { sessionId }, serverId,
            machine: { machineId: 'restore-machine', basePath: '/repo/exact' }, machineReachable: true,
            canControl: true, canSend: false, launch: { canLaunchExecutionRuns: false },
            comparison: { kind: 'workingTree', comparisonId: comparison.id }, output: 'walkthrough' }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().viewModel?.resultId).toBe(original.resultId));
        const bound = ScmDiffSummaryResultSchema.parse({ ...original, revision: 2, output: { ...original.output, revision: 2, runId: 'seed-run' } });
        const run = { runId: 'seed-run', callId: 'seed-call', sidechainId: 'seed-sidechain', intent: 'scm_diff_summary',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
            retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1 };
        boundary.runs['seed-run'] = ExecutionRunGetResponseSchema.parse({ run });
        boundary.results[original.resultId] = { success: true, result: bound };
        boundary.reads = [];
        await act(async () => notifyScmDiffSummaryResultActivity(capturedScope.serverId,
            { type: 'scm-diff-summary-result-updated', machineId: 'restore-machine', resultId: original.resultId, revision: 2 }));
        await vi.waitFor(() => expect(hook.getCurrent().viewModel?.latestRun?.runId).toBe('seed-run'));
        expect(boundary.reads).toEqual([original.resultId]);

        // The composer applies the bound result from discuss's Start response; observing it
        // must not depend on accepting an unrelated new-Run hint before that response arrives.
        const replacement = ScmDiffSummaryResultSchema.parse({ ...bound, revision: 3,
            output: { ...bound.output, revision: 3, runId: 'replacement-run' } });
        boundary.runs['replacement-run'] = ExecutionRunGetResponseSchema.parse({ run: { ...run, runId: 'replacement-run' } });
        await act(async () => applySavedScmDiffSummaryResult(hook.getCurrent().viewModel!.requestKey, replacement));
        await vi.waitFor(() => expect(hook.getCurrent().viewModel?.latestRun?.runId).toBe('replacement-run'));
    });
    it('keeps hydrated captured evidence through Home revalidation', async () => {
        const { useCapturedScmComparison } = await import('../comparison/useCapturedScmComparison');
        const observed: Array<unknown> = [];
        const hook = await renderHook(() => {
            const value = useCapturedScmComparison({ host: { sessionId }, serverId,
                machine: { machineId: 'restore-machine', basePath: '/repo/exact' },
                identity: { machineId: 'restore-machine', basePath: '/repo/exact' },
                comparison: { kind: 'workingTree', comparisonId: comparison.id }, knownComparison: comparison });
            observed.push(value.comparison);
            return value;
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().comparison).toEqual(comparison));
        const previous = hook.getCurrent().comparison;
        observed.length = 0;
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        await act(async () => { await upsertServerProfile({ serverUrl: 'https://restore.example.test', name: 'Reconnected' }); });
        expect(hook.getCurrent().comparison).toBe(previous);
        expect(observed.every(value => value === previous)).toBe(true);
    });
    it('retains hydrated readings through Home profile revalidation, but clears them on Account replacement', async () => {
        inventory([saved('kept-reading', { walkthrough: reading }, ['walkthrough'])]);
        const observations: Array<string | null | undefined> = [];
        const hook = await renderHook(() => {
            const value = useScmWalkthroughState({ sessionId }, { kind: 'workingTree' }, 'walkthrough', serverId);
            observations.push(value.viewModel?.resultId);
            return value;
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().viewModel?.resultId).toBe('kept-reading'));
        const original = hook.getCurrent().viewModel;
        observations.length = 0;
        boundary.inventory = { success: false, errorCode: 'result_unavailable', error: 'Transport reconnecting' };
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        await act(async () => { await upsertServerProfile({ serverUrl: 'https://restore.example.test', name: 'Reconnected Home' }); });
        expect(hook.getCurrent().viewModel).toBe(original);
        expect(observations.every(id => id === 'kept-reading')).toBe(true);
        await act(async () => { await homes.switchAccount(serverId, 'replacement-account'); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().viewModel).toBeNull());
    });
    it.each(['walkthrough', 'commitPlan'] as const)('settles an ambiguous Session target as unavailable for %s and recovers when its target resolves', async output => {
        inventory([]);
        const session = createSessionFixture({ id: sessionId, serverId, active: false,
            metadata: { path: '/repo/exact', host: 'shared.local' } });
        const machines = ['one', 'two'].map(id => createMachineFixture({ id, active: true, activeAt: Date.now(),
            metadata: { ...createMachineFixture().metadata!, host: 'shared.local' } }));
        getStorage().setState({ sessions: {}, machines: {}, machineListByServerId: { [serverId]: null },
            machineListStatusByServerId: { [serverId]: 'loading' } });
        const hook = await renderHook(() => useScmWalkthroughState({ sessionId }, { kind: 'workingTree' }, output, serverId));
        expect(hook.getCurrent().restoreState).toBe('restoring');
        await act(async () => { getStorage().setState({ sessions: { [sessionId]: session },
            machines: Object.fromEntries(machines.map(machine => [machine.id, machine])), machineListByServerId: { [serverId]: machines },
            machineListStatusByServerId: { [serverId]: 'idle' } }); });
        expect(hook.getCurrent()).toMatchObject({ viewModel: null, restoreState: 'unavailable' });
        expect(boundary.reads).toEqual([]);
        await act(async () => { hook.getCurrent().retryRestore(); });
        expect(hook.getCurrent().restoreState).toBe('unavailable');
        await act(async () => { getStorage().setState({ machines: { [machines[0]!.id]: machines[0]! },
            machineListByServerId: { [serverId]: [machines[0]!] } }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().restoreState).toBe('ready'));
    });
    it('keeps a known offline machine distinct from unknown presence without reading it', async () => {
        inventory([]);
        const machine = createMachineFixture({ id: 'restore-machine', active: false, activeAt: 1 });
        getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
        const hook = await renderHook(() => useScmWalkthroughState({ sessionId }, { kind: 'workingTree' }, 'walkthrough', serverId));
        expect(hook.getCurrent().restoreState).toBe('unavailable');
        expect(boundary.reads).toEqual([]);
    });
    it.each(['session', 'machine'] as const)('reads saved %s output with unknown presence, and retains it as presence flaps', async kind => {
        inventory([saved('unknown-presence', { walkthrough: reading, commitPlan: proposal }, ['walkthrough', 'commitPlan'])], kind === 'session');
        getStorage().setState({ machines: {}, machineListByServerId: { [serverId]: [] } });
        const host = kind === 'session' ? { sessionId } : { machineId: 'restore-machine', cwd: '/repo/exact' };
        const target = { kind: 'workingTree' as const };
        const hook = await renderHook(() => ({ ...useScmWalkthroughState(host, { ...target }, 'walkthrough', serverId),
            presence: useMachinePresenceSummary(serverId, 'restore-machine') }));
        expect(hook.getCurrent().presence.reachability).toBe('unknown');
        await waitForHomeGovernance(() => expect(hook.getCurrent().viewModel?.resultId).toBe('unknown-presence'));
        const original = hook.getCurrent().viewModel;
        const offline = createMachineFixture({ id: 'restore-machine', active: false, activeAt: 1 });
        await act(async () => { getStorage().setState({ machines: { [offline.id]: offline }, machineListByServerId: { [serverId]: [offline] } }); });
        expect(hook.getCurrent().presence.reachability).toBe('unreachable');
        expect(hook.getCurrent().viewModel).toBe(original);
        await act(async () => { getStorage().setState({ machines: {}, machineListByServerId: { [serverId]: [] } }); });
        await hook.rerender();
        expect(hook.getCurrent().presence.reachability).toBe('unknown');
        expect(hook.getCurrent().viewModel).toBe(original);
        expect(hook.getCurrent().restoreState).toBe('ready');
    });

    it('keeps unknown output restoring until its saved read settles, then restores or confirms empty', async () => {
        inventory([saved('pending-read', { commitPlan: proposal }, ['commitPlan'])]);
        const read = createDeferred<unknown>();
        boundary.results['pending-read'] = read.promise;
        const hook = await renderHook(() => useScmWalkthroughState({ sessionId }, { kind: 'workingTree' }, 'commitPlan', serverId));
        expect(hook.getCurrent()).toMatchObject({ viewModel: null, restoreState: 'restoring' });
        await waitForHomeGovernance(() => expect(boundary.reads).toContain('pending-read'));
        expect(hook.getCurrent()).toMatchObject({ viewModel: null, restoreState: 'restoring' });
        await act(async () => { read.resolve({ success: true, result: saved('pending-read', { commitPlan: proposal }, ['commitPlan']) }); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().viewModel?.resultId).toBe('pending-read'));
        expect(hook.getCurrent().restoreState).toBe('ready');
        await hook.rerender();
        const empty = await renderHook(() => useScmWalkthroughState({ sessionId }, { kind: 'commit', commit: 'other' }, 'commitPlan', serverId));
        await waitForHomeGovernance(() => expect(empty.getCurrent().restoreState).toBe('ready'));
        expect(empty.getCurrent().viewModel).toBeNull();
    });

    it('keeps a pending inventory restoring, then settles socket loss without repolling until explicit Retry', async () => {
        const pending = createDeferred<unknown>();
        boundary.inventory = pending.promise;
        const hook = await renderHook(() => useScmWalkthroughState({ sessionId }, { kind: 'workingTree' }, 'walkthrough', serverId));
        await waitForHomeGovernance(() => expect(boundary.listInputs).toHaveLength(1));
        expect(hook.getCurrent().restoreState).toBe('restoring');
        await act(async () => { pending.reject(new Error('Socket disconnected before the read completed')); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().restoreState).toBe('unavailable'));
        expect(hook.getCurrent().viewModel).toBeNull();
        for (let index = 0; index < 20; index++) await hook.rerender();
        expect(boundary.listInputs).toHaveLength(1);
        expect(boundary.reads).toEqual([]);
        inventory([]);
        await act(async () => { hook.getCurrent().retryRestore(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().restoreState).toBe('ready'));
        expect(boundary.listInputs).toHaveLength(2);
    });
    it.each(['inventory', 'read'] as const)('retains the typed %s failure for Commits until explicit recovery', async phase => {
        const failure = { success: false as const, errorCode: 'result_unavailable' as const, error: 'Captured comparison is unreadable.' };
        inventory([saved('failed-proposal', { commitPlan: proposal }, ['commitPlan'])]);
        if (phase === 'inventory') boundary.inventory = failure;
        else boundary.results['failed-proposal'] = failure;
        const hook = await renderHook(() => useScmWalkthroughState({ sessionId }, { kind: 'workingTree' }, 'commitPlan', serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent().restoreState).toBe('unavailable'));
        expect(hook.getCurrent()).toMatchObject({ restoreFailure: failure });
        for (let index = 0; index < 20; index++) await hook.rerender();
        expect(boundary.listInputs).toHaveLength(1);
        inventory([]);
        await act(async () => { hook.getCurrent().retryRestore(); });
        expect(hook.getCurrent().restoreFailure).toBeNull();
        await waitForHomeGovernance(() => expect(hook.getCurrent().restoreState).toBe('ready'));
        expect(hook.getCurrent().restoreFailure).toBeNull();
    });
    it('restores the newest valid commit proposal when its separate walkthrough failed', async () => {
        inventory([saved('newest-plan', { walkthrough: { state: 'failed', reason: 'Generation failed' }, commitPlan: proposal }, ['walkthrough', 'commitPlan']),
            saved('older-plan', { walkthrough: reading, commitPlan: proposal }, ['walkthrough', 'commitPlan'])]);
        const hook = await renderHook(() => useSessionScmWalkthrough(sessionId, { kind: 'workingTree', comparisonId: comparison.id }, 'commitPlan', serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent()).not.toBeNull());
        expect(hook.getCurrent()?.savedResult?.resultId).toBe('newest-plan');
        expect(hook.getCurrent()).toMatchObject({ status: 'succeeded', error: null });
    });
    it('skips a newer result that does not contain the requested output', async () => {
        inventory([saved('newest-summary', { summary: { state: 'complete', value: { summaryMarkdown: 'Summary only' } } }, ['summary']),
            saved('older-reading', { walkthrough: reading }, ['walkthrough'])]);
        const hook = await renderHook(() => useSessionScmWalkthrough(sessionId, { kind: 'workingTree', comparisonId: comparison.id }, 'walkthrough', serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.savedResult?.resultId).toBe('older-reading'));
    });
    it.each(['failed', 'cancelled'] as const)('retains a published requested output over a content-less %s attempt', async state => {
        inventory([saved('newest-attempt', { walkthrough: { state, reason: 'Stopped' } }, ['walkthrough']), saved('older-reading', { walkthrough: reading }, ['walkthrough'])]);
        const hook = await renderHook(() => useSessionScmWalkthrough(sessionId, { kind: 'workingTree', comparisonId: comparison.id }, 'walkthrough', serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.savedResult?.resultId).toBe('older-reading'));
    });
    it('keeps seeking a published reading after a refused Start and an older unfinished attempt', async () => {
        const attempt = saved('refused-start', { walkthrough: { state: 'failed', reason: 'Start refused' } }, ['walkthrough']);
        const failed = ScmDiffSummaryResultSchema.parse({ ...attempt,
            output: { ...attempt.output, success: false, errorCode: 'SUMMARY_FAILED', error: 'Start refused' } });
        inventory([failed, saved('older-writing', { walkthrough: { state: 'writing' } }, ['walkthrough']),
            saved('older-reading', { walkthrough: reading }, ['walkthrough'])]);
        const hook = await renderHook(() => useSessionScmWalkthrough(sessionId, { kind: 'workingTree', comparisonId: comparison.id }, 'walkthrough', serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.savedResult?.resultId).toBe('older-reading'));
    });
    it('shows the latest failed requested attempt when no usable requested output exists', async () => {
        inventory([saved('unrelated-plan', { commitPlan: proposal }, ['commitPlan']),
            saved('newest-attempt', { walkthrough: { state: 'failed', reason: 'Stopped' } }, ['walkthrough']),
            saved('older-writing', { walkthrough: { state: 'writing' } }, ['walkthrough'])]);
        const hook = await renderHook(() => useSessionScmWalkthrough(sessionId, { kind: 'workingTree', comparisonId: comparison.id }, 'walkthrough', serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.savedResult?.resultId).toBe('newest-attempt'));
    });
    it('keeps an in-progress requested output ahead of an older publication', async () => {
        inventory([saved('writing', { walkthrough: { state: 'writing' } }, ['walkthrough']), saved('older-reading', { walkthrough: reading }, ['walkthrough'])]);
        const hook = await renderHook(() => useSessionScmWalkthrough(sessionId, { kind: 'workingTree', comparisonId: comparison.id }, 'walkthrough', serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.savedResult?.resultId).toBe('writing'));
    });
    it('restarts restoration when the requested output changes while neither output is loaded', async () => {
        inventory([saved('reading', { walkthrough: reading }, ['walkthrough'])]);
        const hook = await renderHook((output: ScmDiffSummaryOutputKind) => useSessionScmWalkthrough(sessionId,
            { kind: 'workingTree', comparisonId: comparison.id }, output, serverId), { initialProps: 'commitPlan' });
        await waitForHomeGovernance(() => expect(boundary.reads).toContain('reading'));
        await hook.rerender('walkthrough');
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.savedResult?.resultId).toBe('reading'));
    });
    it.each([false, true])('keeps the newest proposal and the published reading with an exact reading selector (newer comparison: %s)', async newerComparison => {
        const latest = saved('newest-plan', { walkthrough: { state: 'failed', reason: 'Stopped' }, commitPlan: proposal }, ['walkthrough', 'commitPlan']);
        const newest = newerComparison ? ScmDiffSummaryResultSchema.parse({ ...latest,
            output: { ...latest.output, sourceKey: 'newer-comparison',
                metadata: { ...latest.output.metadata, sourceKey: 'newer-comparison' },
                comparison: { ...comparison, id: 'newer-comparison' } } }) : latest;
        inventory([newest,
            saved('older-plan', { walkthrough: reading, commitPlan: proposal }, ['walkthrough', 'commitPlan'])]);
        const target = { kind: 'workingTree' as const, comparisonId: comparison.id };
        const hook = await renderHook(() => {
            const restored = useScmWalkthroughStates({ sessionId }, [
                { comparison: target, output: 'walkthrough' },
                { comparison: { kind: 'workingTree' }, output: 'commitPlan' },
            ], serverId);
            return { reading: restored.viewModels[0], plan: restored.viewModels[1] };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().reading?.outputs?.walkthrough?.value).toBeDefined());
        expect(hook.getCurrent().plan?.savedResult?.resultId).toBe('newest-plan');
        expect(hook.getCurrent().reading?.savedResult?.resultId).toBe('older-plan');
        expect(boundary.methods.filter(method => method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST)).toHaveLength(1);
        expect(boundary.reads).toEqual(['newest-plan', 'older-plan']);
    });
});
