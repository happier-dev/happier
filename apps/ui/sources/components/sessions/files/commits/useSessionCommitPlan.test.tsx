import * as React from 'react';
import '@/dev/testkit/harness/syncSingletonLoader';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScmDiffSummaryResultSchema, type ScmDiffSummaryResult } from '@happier-dev/protocol/scm';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { getAgentCore, getAgentStaticModels } from '@happier-dev/agents';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { SCM_DIFF_SUMMARY_SETTING_KEYS } from '@/settings/scmDiffSummary/settings';

const boundary = vi.hoisted(() => ({
    saved: null as ScmDiffSummaryResult | null,
    sessionId: '',
    read: null as (() => Promise<unknown>) | null,
    recover: null as (() => Promise<unknown>) | null,
    requests: [] as Array<Readonly<{ method: string; machineId?: string; sessionId?: string; payload?: unknown }>>,
}));

// Credential custody and the two remote transports are genuine system boundaries;
// result operations, Account lifetime, storage and proposal projection stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({ importOriginal, tokenStorage: {
        getCredentialsForServerUrl: async () => ({ token: `header.${Buffer.from(JSON.stringify({ sub: 'commit-plan-account' })).toString('base64')}.signature`, secret: 'fixture-secret' }),
    } });
});
async function remote(method: string): Promise<unknown> {
    if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
        'tool.executionRuns': { ok: true, data: { backends: { codex: { available: true, intents: ['scm_diff_summary'] } } } },
    } };
    if (method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return { runs: [] };
    if (method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST) {
        const saved = boundary.saved!;
        return { success: true, results: [{ cwd: '/repo/exact', sessionId: boundary.sessionId,
            resultId: saved.resultId, revision: saved.revision, comparisonId: saved.output.comparison!.id,
            source: saved.output.comparison!.source, bytes: 100, updatedAtMs: 1 }], count: 1, bytes: 100,
            sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 } };
    }
    if (method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ) return boundary.read ? boundary.read() : { success: true, result: boundary.saved };
    if (method === 'scm.diffSummary.commitPlan.recover') return boundary.recover!();
    if (method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE) return { success: false,
        errorCode: 'fixture_generation_rejected', error: 'The generation boundary was reached.' };
    throw new Error(`Unexpected remote method: ${method}`);
}
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const rpc = async (request: { method: string; machineId?: string; payload?: unknown }) => { boundary.requests.push(request); return remote(request.method); };
    // Method-specific external wire fixtures cannot express the transport's arbitrary R.
    return createServerScopedMachineRpcBoundaryMock(rpc as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope);
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async (importOriginal) => {
    const { createServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const rpc = async <R,>(request: { method: string; sessionId?: string; payload?: unknown }): Promise<R> => { boundary.requests.push(request); return await remote(request.method) as R; };
    return createServerScopedSessionRpcModuleMock({ importOriginal, overrides: {
        sessionRpcWithServerScope: rpc, sessionRpcWithServerAccountScope: rpc,
    } });
});

const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { standardCleanup } = await import('@/dev/testkit/cleanup/standardCleanup');
const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
const { getStorage } = await import('@/sync/domains/state/storage');
const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { useSessionCommitPlan } = await import('./useSessionCommitPlan');
const { useScmCommitPlan } = await import('./useScmCommitPlan');
const { useWorkspaceScmDiffSummaryBinding } = await import('@/components/projects/scm/useWorkspaceScmDiffSummaryBinding');
const { ScmCommitsView } = await import('./ScmCommitsView');
const initialStorage = getStorage().getState();

afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
    getStorage().setState(initialStorage, true);
    boundary.saved = null; boundary.read = null; boundary.recover = null;
    boundary.requests = [];
});

function savedResult(revision: number, status: 'unknown' | 'applying' | 'complete') {
    const head = 'a'.repeat(40);
    const plan = { groups: [{ id: 'g1', message: 'One commit', rationale: '', changeRefs: [] }], leftOutChangeRefs: [] };
    return ScmDiffSummaryResultSchema.parse({ resultId: 'poll-result', revision, canUndo: false,
        application: { acceptedRevision: 1, acceptance: { comparisonId: 'poll-comparison', repositoryRootPath: '/repo/exact',
            expectedHeadOid: head, expectedRef: 'refs/heads/main', ...plan }, status,
            steps: [{ groupId: 'g1', state: status === 'complete' ? 'published' : status === 'applying' ? 'writing' : 'unknown',
                ...(status === 'complete' ? { commitSha: 'b'.repeat(40) } : {}) }],
            nextGroupIndex: status === 'complete' ? 1 : 0, stopAfterCurrent: false },
        output: { success: true, resultId: 'poll-result', revision, sourceKey: 'poll-comparison',
            metadata: { sourceKey: 'poll-comparison', source: { kind: 'workingTree' } }, requestedOutputs: ['commitPlan'],
            comparison: { id: 'poll-comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/repo/exact' },
                endpoints: { before: head }, commitTarget: { headOid: head, ref: 'refs/heads/main' },
                inventory: { state: 'complete', files: [], reasons: [] } },
            outputs: { commitPlan: { state: 'complete', value: plan } },
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
        } });
}

async function mountProposal(sessionId: string, saved = savedResult(1, 'unknown')) {
    boundary.sessionId = sessionId;
    boundary.saved = saved;
    const home = await upsertServerProfile({ name: boundary.sessionId, serverUrl: `https://${sessionId}.example.test` });
    await setActiveServerId(home.id, { scope: 'device' });
    const machine = createMachineFixture({ id: 'machine:commit-progress', activeAt: Date.now() });
    const session = createSessionFixture({ id: boundary.sessionId, serverId: home.id, active: true,
        metadata: { path: '/repo/exact', host: 'tester.local', machineId: machine.id, flavor: 'codex' } });
    getStorage().setState({ sessions: { [session.id]: session }, machines: { [machine.id]: machine },
        machineListByServerId: { [home.id]: [machine] }, settings: { ...initialStorage.settings,
            experiments: true, featureToggles: { 'execution.runs': true } } });
    const latest: { current: ReturnType<typeof useSessionCommitPlan> | null } = { current: null };
    const visibility: { setEnabled: React.Dispatch<React.SetStateAction<boolean>> | null } = { setEnabled: null };
    function Probe() {
        const [enabled, setEnabled] = React.useState(true);
        visibility.setEnabled = setEnabled;
        latest.current = useSessionCommitPlan({ sessionId: session.id, serverId: home.id, enabled, branch: 'main' });
        return null;
    }
    const screen = await renderScreen(<Probe />);
    await vi.waitFor(() => expect(latest.current?.proposal?.application?.status).toBe(saved.application?.status));
    return { latest, screen, visibility };
}

async function mountWorkspaceProposal(saved = savedResult(1, 'unknown'), renderProposal = false) {
    boundary.sessionId = '';
    boundary.saved = saved;
    const home = await upsertServerProfile({ name: 'workspace-commit-plan', serverUrl: 'https://workspace-commit-plan.example.test' });
    await setActiveServerId(home.id, { scope: 'device' });
    const machine = createMachineFixture({ id: 'machine:workspace-commit-plan', activeAt: Date.now() });
    const profile = buildScmDiffSummaryModelProfiles({ backendTarget: { kind: 'backend', backendId: 'codex' },
        models: getAgentStaticModels('codex', { catalogOnly: true }), agentFormats: getAgentCore('codex')?.structuredOutput?.formats,
    }).find(candidate => candidate.structuredOutput === 'supported');
    expect(profile).toBeDefined();
    getStorage().setState({ sessions: {}, machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] },
        settings: { ...initialStorage.settings, experiments: true, featureToggles: { 'execution.runs': true },
            [SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]: profile!.catalogId } });
    const latest: { current: ReturnType<typeof useSessionCommitPlan> | null } = { current: null };
    const target: {
        setRoot: React.Dispatch<React.SetStateAction<string>> | null;
        setComparison: React.Dispatch<React.SetStateAction<SessionScmReviewComparison>> | null;
    } = { setRoot: null, setComparison: null };
    function Probe() {
        const [rootPath, setRoot] = React.useState('/repo/exact');
        const [comparison, setComparison] = React.useState<SessionScmReviewComparison>(() => ({ kind: 'workingTree', comparisonId: saved.output.comparison!.id }));
        target.setRoot = setRoot;
        target.setComparison = setComparison;
        const bound = useWorkspaceScmDiffSummaryBinding({ serverId: home.id, machineId: machine.id, rootPath, comparison, output: 'commitPlan' });
        latest.current = useScmCommitPlan({ bound });
        return renderProposal ? <ScmCommitsView plan={latest.current} branch="main" layout="wide" renderBar={() => null} /> : null;
    }
    const screen = await renderScreen(<Probe />);
    return { latest, screen, machine, home, target };
}

describe('exact workspace commit plans', () => {
    it('regenerates a restored proposal with its actually offered model without visiting the empty-state picker', async () => {
        const saved = ScmDiffSummaryResultSchema.parse({ ...savedResult(1, 'complete'), application: undefined });
        const { latest, machine } = await mountWorkspaceProposal(saved, true);
        await vi.waitFor(() => expect(latest.current?.phase).toBe('ready'));
        await vi.waitFor(() => expect(latest.current?.binding.launch.canLaunchExecutionRuns).toBe(true));
        expect(latest.current?.binding.selected.success).toBe(true);
        expect(latest.current?.actions.onRegenerate).toBeDefined();
        await act(async () => latest.current?.actions.onRegenerate?.());
        await vi.waitFor(() => expect(latest.current?.error).toBe('The generation boundary was reached.'));
        expect(boundary.requests.find(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE)).toMatchObject({
            machineId: machine.id, payload: { cwd: '/repo/exact', outputs: ['commitPlan'] },
        });
        expect(boundary.requests.every(request => !request.sessionId)).toBe(true);
    }, 120_000);

    it('restores and recovers the saved application without selecting or creating a Session', async () => {
        const { latest, machine } = await mountWorkspaceProposal();
        await vi.waitFor(() => expect(latest.current?.proposal?.outcome?.kind).toBe('unknown'));
        boundary.recover = async () => ({ success: true, result: savedResult(2, 'complete') });
        await act(async () => latest.current?.actions.onRecover?.());
        await vi.waitFor(() => expect(latest.current?.proposal?.groups[0]?.state).toBe('landed'));
        const recovery = boundary.requests.find(request => request.method === 'scm.diffSummary.commitPlan.recover');
        expect(recovery).toMatchObject({ machineId: machine.id, payload: { cwd: '/repo/exact', resultId: 'poll-result', expectedRevision: 1 } });
        expect(boundary.requests.every(request => !request.sessionId)).toBe(true);
        expect(getStorage().getState().sessions).toEqual({});
    }, 120_000);

    it('retires application observation when the selected checkout changes without cancelling the old application', async () => {
        const { latest, target } = await mountWorkspaceProposal();
        await vi.waitFor(() => expect(latest.current?.proposal?.outcome?.kind).toBe('unknown'));
        const recovery = createDeferred<unknown>();
        boundary.recover = () => recovery.promise;
        await act(async () => latest.current?.actions.onRecover?.());
        expect(latest.current?.busy).toBe(true);
        await act(async () => target.setRoot?.('/repo/other'));
        expect(latest.current?.proposal).toBeNull();
        expect(latest.current?.busy).toBe(false);
        await act(async () => recovery.resolve({ success: true, result: savedResult(2, 'complete') }));
        expect(latest.current?.proposal).toBeNull();
        expect(boundary.requests.some(request => request.method === 'scm.diffSummary.commitPlan.cancel')).toBe(false);
    }, 120_000);

    it('does not substitute pending changes or their application controls after selecting committed evidence', async () => {
        const { latest, target } = await mountWorkspaceProposal();
        await vi.waitFor(() => expect(latest.current?.proposal?.outcome?.kind).toBe('unknown'));
        await act(async () => target.setComparison?.({ kind: 'commit', commit: 'b'.repeat(40) }));
        expect(latest.current?.supportedComparison).toBe(false);
        expect(latest.current?.proposal).toBeNull();
        expect(latest.current?.actions.onCreate).toBeUndefined();
        expect(latest.current?.actions.onRecover).toBeUndefined();
        expect(latest.current?.addToSaved).toBeNull();
    }, 120_000);
});

describe('useSessionCommitPlan application progress', () => {
    it('keeps at most one slow progress read in flight and preserves progress and final publication', async () => {
        const { latest } = await mountProposal('slow-commit-progress');
        const slowRead = createDeferred<unknown>();
        const recovery = createDeferred<unknown>();
        let outstanding = 0;
        let maxOutstanding = 0;
        let reads = 0;
        boundary.read = async () => {
            reads += 1; outstanding += 1; maxOutstanding = Math.max(maxOutstanding, outstanding);
            try { return await slowRead.promise; } finally { outstanding -= 1; }
        };
        boundary.recover = () => recovery.promise;
        vi.useFakeTimers();
        await act(async () => latest.current?.actions.onRecover?.());
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
        expect(maxOutstanding).toBe(1);
        await act(async () => slowRead.resolve({ success: true, result: savedResult(2, 'applying') }));
        expect(latest.current?.proposal?.groups[0]?.state).toBe('writing');
        await act(async () => recovery.resolve({ success: true, result: savedResult(3, 'complete') }));
        expect(latest.current?.proposal?.groups[0]?.state).toBe('landed');
        expect(latest.current?.busy).toBe(false);
        const completedReads = reads;
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
        expect(reads).toBe(completedReads);
    }, 120_000);

    it('stops reading progress after the proposal view unmounts without cancelling its application', async () => {
        const { latest, screen } = await mountProposal('unmounted-commit-progress');
        const recovery = createDeferred<unknown>();
        boundary.recover = () => recovery.promise;
        let reads = 0;
        boundary.read = async () => { reads += 1; return { success: true, result: boundary.saved }; };
        vi.useFakeTimers();
        const idleTimers = vi.getTimerCount();
        await act(async () => latest.current?.actions.onRecover?.());
        expect(vi.getTimerCount()).toBe(idleTimers + 1);
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect(reads).toBe(1);
        await act(async () => screen.unmount());
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
        expect(reads).toBe(1);
        expect(vi.getTimerCount()).toBe(idleTimers);
        const complete = savedResult(3, 'complete');
        boundary.saved = complete;
        await act(async () => recovery.resolve({ success: true, result: complete }));
        vi.useRealTimers();
        const reopened = await mountProposal('unmounted-commit-progress', complete);
        expect(reopened.latest.current?.proposal?.groups[0]?.state).toBe('landed');
    }, 120_000);

    it('retires progress polling when a retained Git view is hidden and preserves the final current-Account result', async () => {
        const { latest, visibility } = await mountProposal('hidden-commit-progress');
        const recovery = createDeferred<unknown>();
        boundary.recover = () => recovery.promise;
        let reads = 0;
        boundary.read = async () => { reads += 1; return { success: true, result: boundary.saved }; };
        vi.useFakeTimers();
        const idleTimers = vi.getTimerCount();
        await act(async () => latest.current?.actions.onRecover?.());
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect(reads).toBe(1);
        await act(async () => visibility.setEnabled?.(false));
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
        expect(reads).toBe(1);
        expect(vi.getTimerCount()).toBe(idleTimers);
        boundary.saved = savedResult(3, 'complete');
        await act(async () => recovery.resolve({ success: true, result: boundary.saved }));
        await act(async () => visibility.setEnabled?.(true));
        expect(latest.current?.proposal?.groups[0]?.state).toBe('landed');
    }, 120_000);
});
