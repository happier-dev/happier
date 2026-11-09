import * as React from 'react';
import '@/dev/testkit/harness/syncSingletonLoader';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScmDiffSummaryResultSchema, ScmDiffSummaryResultListResponseSchema, ScmDiffSummaryGenerateOutputSchema, type ScmDiffSummaryResult } from '@happier-dev/protocol/scm';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { SCM_DIFF_SUMMARY_SETTING_KEYS } from '@/settings/scmDiffSummary/settings';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ScmDiffSummaryResultDeleteResponseSchema, ScmDiffSummaryResultEditInputSchema, ScmDiffSummaryResultResponseSchema } from '@happier-dev/protocol/scm/diffSummaryResult';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

const boundary = vi.hoisted(() => ({
    saved: null as ScmDiffSummaryResult | null,
    sessionId: '',
    read: null as (() => Promise<unknown>) | null,
    recover: null as (() => Promise<unknown>) | null,
    generate: null as (() => Promise<unknown>) | null,
    discard: null as ((method: string, payload: unknown) => Promise<unknown>) | null,
    listSaved: true,
    requests: [] as Array<Readonly<{ method: string; machineId?: string; sessionId?: string; payload?: unknown }>>,
}));

// Credential custody, Home HTTP and remote RPC transports are genuine system boundaries;
// result operations, Account lifetime, storage and proposal projection stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: false }).module);
const OFFERED_MODELS = [{ id: 'commit-plan-fixture-model', name: 'Offered fixture model',
    capabilities: { structuredOutput: 'supported' as const } }];
async function remote(method: string, payload?: unknown): Promise<unknown> {
    if ((method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_EDIT || method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_DELETE
        || method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_UNDO) && boundary.discard) return boundary.discard(method, payload);
    if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
        'tool.executionRuns': { ok: true, checkedAt: 1,
            data: { backends: { codex: { available: true, intents: ['scm_diff_summary'] } } } },
    } };
    if (method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return { runs: [] };
    if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) return ExecutionRunGetResponseSchema.parse({
        run: { runId: boundary.saved?.output.runId, callId: 'generator-call', sidechainId: 'generator-sidechain',
            intent: 'scm_diff_summary', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
            retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1 },
        structuredMeta: { kind: 'scm_diff_summary.v1', payload: boundary.saved?.output },
    });
    if (method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST) {
        const saved = boundary.saved!;
        return ScmDiffSummaryResultListResponseSchema.parse({ success: true, results: boundary.listSaved ? [{ cwd: '/repo/exact',
            ...(boundary.sessionId ? { sessionId: boundary.sessionId } : {}),
            resultId: saved.resultId, revision: saved.revision, comparisonId: saved.output.comparison!.id,
            source: saved.output.comparison!.source, bytes: 100, updatedAtMs: 1 }] : [], count: boundary.listSaved ? 1 : 0, bytes: boundary.listSaved ? 100 : 0,
            sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 } });
    }
    if (method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ) return boundary.read ? boundary.read() : { success: true, result: boundary.saved };
    if (method === 'scm.diffSummary.commitPlan.recover') return boundary.recover!();
    if (method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE) return boundary.generate ? boundary.generate() : ScmDiffSummaryGenerateOutputSchema.parse({ success: false,
        errorCode: 'SUMMARY_FAILED', error: 'The generation boundary was reached.' });
    throw new Error(`Unexpected remote method: ${method}`);
}
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const rpc = async (request: { method: string; machineId?: string; payload?: unknown }) => {
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE) throw new Error('Run admission requires requester-carrying Home HTTP');
        boundary.requests.push(request);
        return remote(request.method, request.payload);
    };
    // Method-specific external wire fixtures cannot express the transport's arbitrary R.
    return createServerScopedMachineRpcBoundaryMock(rpc as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope);
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async (importOriginal) => {
    const { createServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const rpc = async <R,>(request: { method: string; sessionId?: string; payload?: unknown }): Promise<R> => { boundary.requests.push(request); return await remote(request.method, request.payload) as R; };
    return createServerScopedSessionRpcModuleMock({ importOriginal, overrides: {
        sessionRpcWithServerScope: rpc, sessionRpcWithServerAccountScope: rpc,
    } });
});

const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { standardCleanup } = await import('@/dev/testkit/cleanup/standardCleanup');
const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
const { getStorage } = await import('@/sync/domains/state/storage');
const { createScmDiffSummaryModelCatalogHttpBoundary } = await import('@/dev/testkit/harness/scmDiffSummaryModelCatalogBoundary');
const { createScmRunActionHttpBoundary } = await import('@/dev/testkit/harness/scmActionTransport');
const { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } = await import('@happier-dev/protocol/acp/catalog/catalogRowsV1');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
const disposeActionLoader = await installRealActionExecutorModuleLoader();
afterAll(disposeActionLoader);
const { useSessionCommitPlan } = await import('./useSessionCommitPlan');
const { Modal } = await import('@/modal');
const { useScmCommitPlan } = await import('./useScmCommitPlan');
const { useWorkspaceScmDiffSummaryBinding } = await import('@/components/projects/scm/useWorkspaceScmDiffSummaryBinding');
const { ScmCommitsView } = await import('./ScmCommitsView');
const { RunWorkNotifications } = await import('@/components/sessions/work/RunWorkNotifications');
const { applySavedScmDiffSummaryResult, retireScmDiffSummaryScope } = await import('@/sync/ops/scmDiffSummary/generate');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { OtherAccountFollowV1Schema } = await import('@happier-dev/protocol/sessions/follow/accountFollow');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } = await import('@happier-dev/protocol/sessions/follow/changes');
const { SPECIMEN_COMPARISON } = await import('@/components/dev/changes/walkthroughSpecimenFixture');
const initialStorage = getStorage().getState();
let fixtureHomeId: string | null = null;

beforeEach(async () => { await homes.reset(); });
afterEach(async () => {
    standardCleanup();
    vi.useRealTimers();
    // Home transport teardown does not erase the Summary owner's retained
    // domain results. Retire this fixture's scope before the next case reuses it.
    if (fixtureHomeId) retireScmDiffSummaryScope({
        serverId: resolveServerProfileScopeIdForIdentifier(fixtureHomeId), accountId: 'commit-plan-account',
    });
    fixtureHomeId = null;
    getStorage().setState(initialStorage, true);
    boundary.saved = null; boundary.read = null; boundary.recover = null;
    boundary.generate = null; boundary.discard = null; boundary.listSaved = true;
    boundary.requests = [];
    await homes.reset();
});

async function addHome(name: string) {
    const id = await homes.addHome({ name, serverUrl: `https://${name}.example.test`,
        serverIdentityId: `srv_${name.replaceAll('-', '_')}`, accountId: 'commit-plan-account', accountEncryptionMode: 'plain', currentAccount: true });
    fixtureHomeId = id;
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { following: { enabled: true } } },
        capabilities: { serverIdentity: { serverIdentityId: `srv_${name.replaceAll('-', '_')}` } } });
    homes.answer(id, '/v1/features', { body: features });
    homes.answer(id, '/v1/features/authenticated', { body: features });
    primeServerFeaturesSnapshot({ serverId: id, snapshot: { status: 'ready', features } });
    homes.answer(id, ACP_CATALOG_ROWS_ROUTE_V1, { body: AcpCatalogRowReadResponseV1Schema.parse({ status: 'absent' }) });
    homes.answer(id, '/v2/account/follows/sources', { body: { follow: null } });
    return { id };
}

function proposalDiagnostic(plan: ReturnType<typeof useScmCommitPlan> | null) {
    const bound = plan?.binding;
    return JSON.stringify({ phase: plan?.phase, supportedComparison: plan?.supportedComparison,
        binding: bound ? { host: bound.host, scope: bound.scope, cwd: bound.cwd, machine: bound.machine,
            current: bound.isCurrent(), machineReachable: bound.machineReachable, canControl: bound.canControl,
            canSend: bound.canSend, launch: bound.launch, comparison: bound.comparison, selected: bound.selected,
            modelAvailable: bound.modelAvailable, error: bound.error,
            resultId: bound.viewModel?.resultId, revision: bound.viewModel?.revision,
            outputState: bound.viewModel?.outputs?.commitPlan?.state,
            captured: bound.capturedComparison ? { id: bound.capturedComparison.id,
                root: bound.capturedComparison.repository.rootPath, source: bound.capturedComparison.source } : null,
        } : null,
        rpc: boundary.requests, homePaths: homes.requests.map(request => request.path),
    });
}

function savedResult(revision: number, status: 'unknown' | 'applying' | 'complete') {
    const head = 'a'.repeat(40);
    const comparisonId = 'c'.repeat(64);
    const plan = { groups: [{ id: 'g1', message: 'One commit', rationale: '', changeRefs: [] }], leftOutChangeRefs: [] };
    return ScmDiffSummaryResultSchema.parse({ resultId: 'poll-result', revision, canUndo: false,
        application: { acceptedRevision: 1, acceptance: { comparisonId, repositoryRootPath: '/repo/exact',
            expectedHeadOid: head, expectedRef: 'refs/heads/main', ...plan }, status,
            steps: [{ groupId: 'g1', state: status === 'complete' ? 'published' : status === 'applying' ? 'writing' : 'unknown',
                ...(status === 'complete' ? { commitSha: 'b'.repeat(40) } : {}) }],
            nextGroupIndex: status === 'complete' ? 1 : 0, stopAfterCurrent: false },
        output: { success: true, resultId: 'poll-result', revision, sourceKey: comparisonId,
            metadata: { sourceKey: comparisonId, source: { kind: 'workingTree' } }, requestedOutputs: ['commitPlan'],
            comparison: { id: comparisonId, source: { kind: 'workingTree' }, repository: { rootPath: '/repo/exact' },
                endpoints: { before: head }, commitTarget: { headOid: head, ref: 'refs/heads/main' },
                inventory: { state: 'complete', files: [], reasons: [] } },
            outputs: { commitPlan: { state: 'complete', value: plan } },
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
        } });
}

async function pushResultUpdate(serverId: string, revision: number, resultId = 'poll-result', machineId = 'machine:commit-progress') {
    const { handleEphemeralSocketUpdate } = await import('@/sync/engine/socket/socket');
    await handleEphemeralSocketUpdate({ sourceServerId: serverId,
        update: { type: 'scm-diff-summary-result-updated', machineId, resultId, revision },
        addActivityUpdate: () => {}, addMachineActivityUpdate: () => {},
        getSessionEncryption: () => null, getSession: () => undefined, applyMessages: () => {} });
}

async function mountProposal(sessionId: string, saved = savedResult(1, 'unknown')) {
    boundary.sessionId = sessionId;
    boundary.saved = saved;
    const home = await addHome(sessionId);
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
    await vi.waitFor(() => expect(latest.current?.proposal?.application?.status, proposalDiagnostic(latest.current)).toBe(saved.application?.status));
    return { latest, screen, visibility, home };
}

async function mountWorkspaceProposal(saved = savedResult(1, 'unknown'), renderProposal = false, renderWhilePending = false, machineKnown = true) {
    boundary.sessionId = '';
    boundary.saved = saved;
    const home = await addHome('workspace-commit-plan');
    const machine = createMachineFixture({ id: 'machine:workspace-commit-plan', activeAt: Date.now() });
    const backendTarget = { kind: 'backend', backendId: 'codex' } as const;
    const profile = buildScmDiffSummaryModelProfiles({ backendTarget, models: OFFERED_MODELS })[0];
    if (!profile) throw new Error('The offered fixture model must name its backend target.');
    // The executing Machine's catalog is the only source of offered Summary models.
    (await createScmDiffSummaryModelCatalogHttpBoundary({ serverUrl: 'https://workspace-commit-plan.example.test',
        serverIdentityId: 'srv_workspace_commit_plan', accountId: 'commit-plan-account', machineId: machine.id,
        targets: [{ backendTarget, models: OFFERED_MODELS }] })).installOn(homes, home.id);
    (await createScmRunActionHttpBoundary({ serverUrl: 'https://workspace-commit-plan.example.test',
        serverIdentityId: 'srv_workspace_commit_plan', accountId: 'commit-plan-account', machineId: machine.id,
        actionIds: ['scm.diffSummary.generate'], execute(_actionId, input) {
            boundary.requests.push({ method: RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE, machineId: machine.id, payload: input });
            return remote(RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE, input);
        } })).installOn(homes, home.id);
    getStorage().setState({ profileScope: { serverId: home.id, accountId: 'commit-plan-account' },
        sessions: {}, machines: machineKnown ? { [machine.id]: machine } : {}, machineListByServerId: { [home.id]: machineKnown ? [machine] : [] },
        settings: { ...initialStorage.settings, experiments: true, featureToggles: { 'execution.runs': true },
            [SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]: profile.catalogId } });
    // A visible Run Follow control consumes the applied Account, not a saved-Home credential alone.
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
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
        // Reopening an already-restored proposal never visits the empty-state model picker.
        return renderProposal && (renderWhilePending || latest.current.phase === 'ready')
            ? <ScmCommitsView plan={latest.current} branch="main" layout="wide" renderBar={() => null} /> : null;
    }
    const screen = await renderScreen(<Probe />);
    return { latest, screen, machine, home, target };
}

describe('proposal discard Action policy', () => {
    it.each([
        { outputs: 'only', policy: 'waived' },
        { outputs: 'only', policy: 'defaultApproved' },
        { outputs: 'only', policy: 'defaultRejected' },
        { outputs: 'only', policy: 'required' },
        { outputs: 'only', policy: 'disabled' },
        { outputs: 'multiple', policy: 'waived' },
        { outputs: 'multiple', policy: 'defaultApproved' },
        { outputs: 'multiple', policy: 'required' },
        { outputs: 'multiple', policy: 'disabled' },
    ] as const)('uses the $outputs-output $policy Action policy for discard and retains revisioned Undo', async ({ outputs, policy }) => {
        const initial = savedResult(1, 'complete');
        const saved = ScmDiffSummaryResultSchema.parse({ ...initial, application: undefined,
            output: { ...initial.output,
                requestedOutputs: outputs === 'only' ? ['commitPlan'] : ['commitPlan', 'summary'],
                outputs: { ...initial.output.outputs, ...(outputs === 'multiple'
                    ? { summary: { state: 'complete', value: { summaryMarkdown: 'Keep this explanation' } } } : {}) } } });
        const removed = ScmDiffSummaryResultSchema.parse({ ...saved, revision: 2, canUndo: true,
            output: { ...saved.output, revision: 2, requestedOutputs: ['summary'],
                outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Keep this explanation' } } } } });
        const restored = ScmDiffSummaryResultSchema.parse({ ...saved, revision: 3,
            output: { ...saved.output, revision: 3 } });
        boundary.discard = async (method, input) => {
            if (method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_DELETE) {
                boundary.listSaved = false;
                return ScmDiffSummaryResultDeleteResponseSchema.parse({ success: true, resultId: saved.resultId,
                    comparisonId: saved.output.comparison!.id });
            }
            if (method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_EDIT) {
                const parsed = ScmDiffSummaryResultEditInputSchema.parse(input);
                expect(parsed).toEqual({ cwd: '/repo/exact', resultId: saved.resultId, expectedRevision: 1,
                    edit: { kind: 'removeOutput', output: 'commitPlan' } });
                boundary.saved = removed;
                return ScmDiffSummaryResultResponseSchema.parse({ success: true, result: removed });
            }
            boundary.saved = restored;
            return ScmDiffSummaryResultResponseSchema.parse({ success: true, result: restored });
        };
        const { latest, screen, home } = await mountProposal(`discard-${policy}-${outputs}`, saved);
        await vi.waitFor(() => expect(latest.current?.actions.onDiscard, proposalDiagnostic(latest.current)).toEqual(expect.any(Function)));
        const actionId = outputs === 'only' ? 'scm.diffSummary.result.delete' : 'scm.diffSummary.result.edit';
        const settings = { ...getStorage().getState().settings,
            actionsSettingsV1: normalizeActionsSettingsV1(policy === 'waived'
                ? { v: 1, approvalWaivedSurfaces: { [actionId]: ['ui'] } }
                : policy === 'disabled' ? { v: 1, actions: { [actionId]: { enabled: false } } }
                    : { v: 1 }) };
        if (policy === 'required') await homes.requireUiApproval(home.id, actionId);
        else homes.answer(home.id, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 2 } });
        const confirm = vi.spyOn(Modal, 'confirm').mockResolvedValue(policy === 'defaultApproved');
        try {
            await act(async () => { latest.current!.actions.onDiscard!(); });
            const method = outputs === 'only' ? RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_DELETE : RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_EDIT;
            if (policy === 'required' || policy === 'disabled' || policy === 'defaultRejected') {
                await vi.waitFor(() => expect(latest.current?.error).toEqual(expect.any(String)));
                expect(boundary.requests.filter(request => request.method === method)).toEqual([]);
                expect(latest.current?.proposal).not.toBeNull();
                expect(latest.current?.undoDiscard).toBeNull();
                if (policy === 'defaultRejected') expect(confirm).toHaveBeenCalledTimes(1);
                else expect(confirm).not.toHaveBeenCalled();
                if (policy === 'required') expect(homes.artifacts(home.id).list()).toHaveLength(1);
                return;
            }
            await vi.waitFor(() => expect(boundary.requests.filter(request => request.method === method)).toHaveLength(1));
            if (outputs === 'only' && policy === 'defaultApproved') expect(confirm).toHaveBeenCalledTimes(1);
            else expect(confirm).not.toHaveBeenCalled();
            if (outputs === 'multiple') {
                await vi.waitFor(() => expect(latest.current?.undoDiscard).not.toBeNull());
                await act(async () => { await latest.current!.undoDiscard!(); });
                expect(boundary.requests.find(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_UNDO)?.payload)
                    .toEqual({ cwd: '/repo/exact', resultId: saved.resultId, expectedRevision: 2 });
                expect(latest.current?.proposal).not.toBeNull();
            } else await vi.waitFor(() => expect(latest.current?.proposal).toBeNull());
        } finally { confirm.mockRestore(); await screen.unmount(); }
    });
});

describe('exact workspace commit plans', () => {
    it('shows the saved-read refusal reason in Commits and clears it after Retry', async () => {
        const failure = { success: false, errorCode: 'result_unavailable', error: 'The saved comparison could not be read.' };
        boundary.read = async () => failure;
        const { latest, screen } = await mountWorkspaceProposal(savedResult(1, 'complete'), true, true);
        await vi.waitFor(() => expect(latest.current?.phase).toBe('unavailable'));
        expect(latest.current?.binding.restoreFailure).toEqual(failure);
        expect(screen.getTextContent()).toContain(failure.error);
        boundary.read = null;
        await act(async () => { latest.current!.binding.retryRestore(); });
        await vi.waitFor(() => expect(latest.current?.phase).toBe('ready'));
        expect(screen.getTextContent()).not.toContain(failure.error);
        await screen.unmount();
    });
    it('restores the exact workspace proposal before its machine presence hydrates', async () => {
        const saved = savedResult(1, 'complete');
        const { latest, screen } = await mountWorkspaceProposal(saved, false, false, false);
        expect(latest.current?.binding.machineReachable).toBe(false);
        await vi.waitFor(() => expect(latest.current?.binding.viewModel?.resultId, proposalDiagnostic(latest.current)).toBe(saved.resultId));
        expect(latest.current?.phase).toBe('ready');
        await screen.unmount();
    });
    it('keeps the saved read explicitly restoring instead of advertising an empty proposal', async () => {
        const read = createDeferred<unknown>();
        boundary.read = () => read.promise;
        const saved = savedResult(1, 'complete');
        const { latest, screen } = await mountWorkspaceProposal(saved);
        await vi.waitFor(() => expect(boundary.requests.some(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ)).toBe(true));
        expect(latest.current?.binding.restoreState).toBe('restoring');
        expect(latest.current?.phase).toBe('restoring');
        await act(async () => { read.resolve({ success: true, result: saved }); });
        await vi.waitFor(() => expect(latest.current?.phase).toBe('ready'));
        expect(latest.current?.proposal?.outcome?.kind).toBe('complete');
        await screen.unmount();
    });

    it('keeps a previous saved proposal readable without treating its refresh as completion of a new admission', async () => {
        const initial = savedResult(1, 'complete');
        const saved = ScmDiffSummaryResultSchema.parse({ ...initial, application: undefined,
            output: { ...initial.output, runId: 'original-generator' } });
        boundary.listSaved = false;
        const admission = createDeferred<unknown>();
        let generations = 0;
        // Real admission precedes publication: revision0 names the Run, then the
        // Machine's revision1 hint makes its complete saved proposal readable.
        boundary.generate = () => ++generations === 1 ? Promise.resolve(ScmDiffSummaryGenerateOutputSchema.parse({
            ...saved.output, revision: 0, outputs: { commitPlan: { state: 'pending' } },
        })) : admission.promise;
        const { latest, screen, home, machine } = await mountWorkspaceProposal(saved, true, true);
        await vi.waitFor(() => expect(latest.current?.binding.modelAvailable, proposalDiagnostic(latest.current)).toBe(true));
        await vi.waitFor(() => expect(latest.current?.binding.launch.canLaunchExecutionRuns).toBe(true));
        await act(async () => { await latest.current!.binding.onStart(['commitPlan']); });
        await act(async () => { await pushResultUpdate(home.id, saved.revision, saved.resultId, machine.id); });
        await vi.waitFor(() => expect(latest.current?.binding.viewModel?.savedResult?.resultId).toBe(saved.resultId));
        let start!: ReturnType<ReturnType<typeof useSessionCommitPlan>['binding']['onStart']>;
        await act(async () => { start = latest.current!.binding.onStart(['commitPlan']); });
        await vi.waitFor(() => expect(generations).toBe(2));
        expect(latest.current?.binding.viewModel?.status, proposalDiagnostic(latest.current)).toBe('starting');
        expect(latest.current?.phase).toBe('ready');
        expect(latest.current?.isGenerating).toBe(true);
        expect(screen.findByTestId('commit-group:g1')).toBeTruthy();
        await act(async () => {
            admission.resolve(ScmDiffSummaryGenerateOutputSchema.parse({ success: false, errorCode: 'SUMMARY_FAILED', error: 'Retry failed.' }));
            await start;
        });
        expect(latest.current?.binding.generationFailure).toMatchObject({ reason: 'generationFailed', messageKey: 'walkthrough.notice.failedGeneric' });
        expect(latest.current?.error).toBeNull();
        expect(latest.current?.isGenerating).toBe(false);
        expect(screen.findByTestId('commit-group:g1')).toBeTruthy();
        expect(Boolean(screen.findByTestId('commit-proposal-notice-failed-reason'))).toBe(false);
        expect(screen.getTextContent()).not.toContain('Retry failed.');
    });

    it('starts a new attempt from a restored terminal admission failure instead of reselecting its receipt', async () => {
        const initial = savedResult(1, 'complete');
        const failed = ScmDiffSummaryResultSchema.parse({ ...initial, application: undefined,
            output: { ...initial.output, success: false, errorCode: 'SUMMARY_FAILED',
                error: 'Project launch requester custody is unavailable',
                outputs: { commitPlan: { state: 'failed', reason: 'Project launch requester custody is unavailable' } } } });
        const fresh = ScmDiffSummaryGenerateOutputSchema.parse({ ...initial.output,
            resultId: 'fresh-proposal', revision: 0, runId: 'fresh-generator',
            outputs: { commitPlan: { state: 'pending' } } });
        boundary.generate = async () => fresh;
        const { latest, screen, machine } = await mountWorkspaceProposal(failed, true, true);
        await vi.waitFor(() => expect(latest.current?.binding.restoreState).toBe('ready'));
        await vi.waitFor(() => expect(latest.current?.binding.modelAvailable, proposalDiagnostic(latest.current)).toBe(true));
        await vi.waitFor(() => expect(latest.current?.binding.launch.canLaunchExecutionRuns).toBe(true));
        expect(latest.current?.binding.viewModel?.savedResult?.resultId, proposalDiagnostic(latest.current)).toBe(failed.resultId);
        expect(latest.current?.binding.generationFailure).toMatchObject({ reason: 'generationFailed' });
        await act(async () => { screen.findByTestId('commit-proposal-start')!.props.onPress(); });
        await vi.waitFor(() => expect(boundary.requests.find(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE))
            .toMatchObject({ machineId: machine.id, payload: { cwd: '/repo/exact', outputs: ['commitPlan'], cachePolicy: { mode: 'bypass' } } }));
        await vi.waitFor(() => expect(latest.current?.binding.viewModel?.resultId).toBe('fresh-proposal'));
        expect(latest.current?.binding.viewModel?.executionRunId).toBe('fresh-generator');
        expect(latest.current?.isGenerating).toBe(true);
        expect(boundary.saved).toBe(failed);
    });

    it('shows a generation failure retained in a successfully admitted saved result', async () => {
        const failed = ScmDiffSummaryResultSchema.parse({ ...savedResult(1, 'complete'), application: undefined,
            output: { ...savedResult(1, 'complete').output, outputs: { commitPlan: { state: 'failed', reason: 'Native model provisioning failed' } } } });
        boundary.listSaved = false;
        boundary.generate = async () => failed.output;
        const { latest, screen } = await mountWorkspaceProposal(failed, true, true);
        await vi.waitFor(() => expect(latest.current?.binding.modelAvailable, proposalDiagnostic(latest.current)).toBe(true));
        await vi.waitFor(() => expect(latest.current?.binding.launch.canLaunchExecutionRuns).toBe(true));
        await act(async () => { await latest.current!.binding.onStart(['commitPlan']); });
        await vi.waitFor(() => expect(latest.current?.binding.viewModel?.status).toBe('failed'));
        expect(latest.current?.binding.generationFailure, proposalDiagnostic(latest.current)).toMatchObject({ reason: 'generationFailed' });
        expect(latest.current?.isGenerating).toBe(false);
        expect(screen.findByTestId('commit-proposal-writing')).toBeNull();
        expect(screen.findByTestId('commit-proposal-start-options-refusal')).toBeTruthy();
        expect(screen.findByTestId('commit-proposal-start')?.props.disabled).toBe(false);
        expect(screen.getTextContent()).toContain('Writing stopped');
        expect(screen.getTextContent()).not.toContain('Native model provisioning failed');
    });

    it('shows admission progress for exact captured evidence and retains its failure through the real Action transport', async () => {
        boundary.listSaved = false;
        const admission = createDeferred<unknown>();
        boundary.generate = () => admission.promise;
        const { latest, screen, machine } = await mountWorkspaceProposal(savedResult(1, 'complete'), true, true);
        await vi.waitFor(() => expect(latest.current?.binding.modelAvailable, proposalDiagnostic(latest.current)).toBe(true));
        await vi.waitFor(() => expect(latest.current?.binding.launch.canLaunchExecutionRuns).toBe(true));
        expect(latest.current?.phase).toBe('none');
        let start!: ReturnType<ReturnType<typeof useSessionCommitPlan>['binding']['onStart']>;
        await act(async () => { start = latest.current!.binding.onStart(['commitPlan']); });
        await vi.waitFor(() => expect(boundary.requests.some(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE)).toBe(true));
        expect(latest.current?.binding.viewModel?.status, proposalDiagnostic(latest.current)).toBe('starting');
        expect(screen.findByTestId('commit-proposal-writing')).toBeTruthy();
        expect(boundary.requests.find(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE)).toMatchObject({
            machineId: machine.id, payload: { comparisonId: 'c'.repeat(64), cwd: '/repo/exact', outputs: ['commitPlan'] },
        });
        await act(async () => {
            admission.resolve(ScmDiffSummaryGenerateOutputSchema.parse({ success: false, errorCode: 'SUMMARY_FAILED', error: 'Generation failed.' }));
            await start;
        });
        expect(latest.current?.binding.viewModel?.status).toBe('failed');
        expect(latest.current?.binding.generationFailure).toMatchObject({ reason: 'generationFailed' });
        expect(latest.current?.phase).toBe('none');
        expect(screen.findByTestId('commit-proposal-writing')).toBeNull();
        expect(screen.getTextContent()).toContain('Writing stopped');
        expect(screen.getTextContent()).not.toContain('SUMMARY_FAILED');
    });

    it('keeps the exact Run notification and its cancellation available as partial groups arrive, until output completion', async () => {
        const initial = savedResult(1, 'complete');
        const occurrence = SPECIMEN_COMPARISON.inventory.files[0]!.occurrences[0]!;
        const allRefs = SPECIMEN_COMPARISON.inventory.files.flatMap(file => file.occurrences.map(change => change.id));
        const plan = { groups: [{ id: 'g1', message: 'One commit', rationale: '', changeRefs: [occurrence.id] }],
            leftOutChangeRefs: allRefs.filter(id => id !== occurrence.id) };
        const outputAt = (revision: number, state: 'pending' | 'writing' | 'complete') => ScmDiffSummaryResultSchema.parse({
            ...initial, application: undefined, revision, output: { ...initial.output, revision, runId: 'commit-plan-generator',
                comparison: { ...initial.output.comparison, inventory: SPECIMEN_COMPARISON.inventory },
                analysis: state === 'complete' ? { suppliedChangeRefs: allRefs, analysedChangeRefs: allRefs, remainingChangeRefs: [] }
                    : { suppliedChangeRefs: state === 'pending' ? [] : [occurrence.id],
                        analysedChangeRefs: state === 'pending' ? [] : [occurrence.id],
                        remainingChangeRefs: state === 'pending' ? allRefs : plan.leftOutChangeRefs },
                outputs: { commitPlan: { state, ...(state === 'pending' ? {} : { value: plan }) } } },
        });
        const pending = outputAt(1, 'pending');
        const { latest, screen, machine, home } = await mountWorkspaceProposal(pending, true, true);
        await vi.waitFor(() => expect(screen.findByTestId('commit-proposal-notify'), proposalDiagnostic(latest.current)).toBeTruthy());
        const notification = screen.root.findByType(RunWorkNotifications);
        const sourceIdentity = notification.props.source;
        const outputIdentity = notification.props.selectedOutput;
        expect(notification.props.source).toEqual({ kind: 'execution_run', machineId: machine.id, runId: 'commit-plan-generator' });
        expect(notification.props.selectedOutput).toMatchObject({ output: 'commitPlan',
            comparisonId: pending.output.comparison!.id, resultId: pending.resultId });
        expect(screen.findByTestId('commit-group:g1')).toBeNull();
        const requestKey = latest.current!.binding.viewModel!.requestKey;
        const armed = OtherAccountFollowV1Schema.parse({ source: sourceIdentity, following: true, persistent: false,
            policy: { preset: 'quiet' }, once: [{ kind: 'output_ready', outputRef: { kind: 'scm_diff_summary', output: 'commitPlan',
                comparisonId: pending.output.comparison!.id, resultId: pending.resultId }, afterRevision: 1 }] });
        homes.answer(home.id, '/v2/account/follows/sources', { body: { follow: armed } });
        await act(async () => publishHomeAccountChange(home.id, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
        await vi.waitFor(() => expect(screen.findByTestId('notify-run-terminal-cancel:commit-plan-generator')).toBeTruthy());
        const writing = outputAt(2, 'writing');
        boundary.saved = writing;
        await act(async () => applySavedScmDiffSummaryResult(requestKey, writing));
        expect(latest.current?.phase).toBe('ready');
        expect(screen.findByTestId('commit-group:g1')).toBeTruthy();
        expect(latest.current?.proposal?.groups[0]?.changes[0]?.changeRefs).toEqual([occurrence.id]);
        expect(screen.findByTestId('commit-proposal-writing')).toBeNull();
        expect(screen.findByTestId('commit-proposal-notify')).toBeTruthy();
        expect(screen.findByTestId('notify-run-terminal-cancel:commit-plan-generator')).toBeTruthy();
        expect(screen.root.findByType(RunWorkNotifications)).toBe(notification);
        expect(screen.root.findByType(RunWorkNotifications).props.source).toEqual(sourceIdentity);
        expect(screen.root.findByType(RunWorkNotifications).props.selectedOutput).toEqual(outputIdentity);
        const complete = outputAt(3, 'complete');
        boundary.saved = complete;
        await act(async () => applySavedScmDiffSummaryResult(requestKey, complete));
        expect(screen.findByTestId('commit-group:g1')).toBeTruthy();
        expect(screen.findByTestId('commit-proposal-notify')).toBeNull();
    });

    it('regenerates a restored proposal with its actually offered model without visiting the empty-state picker', async () => {
        const saved = ScmDiffSummaryResultSchema.parse({ ...savedResult(1, 'complete'), application: undefined });
        const { latest, machine } = await mountWorkspaceProposal(saved, true);
        await vi.waitFor(() => expect(latest.current?.phase, proposalDiagnostic(latest.current)).toBe('ready'));
        await vi.waitFor(() => expect(latest.current?.binding.launch.canLaunchExecutionRuns).toBe(true));
        await vi.waitFor(() => expect(latest.current?.binding.selected.success, proposalDiagnostic(latest.current)).toBe(true));
        expect(latest.current?.actions.onRegenerate).toBeDefined();
        await act(async () => latest.current?.actions.onRegenerate?.());
        await vi.waitFor(() => expect(latest.current?.binding.generationFailure).toMatchObject({ reason: 'generationFailed' }));
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
    it.each(['session', 'workspace'] as const)('observes approved apply progress and Stop revisions in a mounted %s proposal without an active Action request', async host => {
        const proposal = savedResult(1, 'unknown');
        const { application: _application, ...editable } = proposal;
        const { latest, home, screen } = host === 'session' ? await mountProposal('approved-commit-progress', editable)
            : await mountWorkspaceProposal(editable);
        // An absent application is also the pre-hydration value. Observe the saved proposal
        // before measuring revision pushes, so its initial read is outside that measurement.
        await vi.waitFor(() => expect(latest.current?.binding.viewModel?.savedResult)
            .toMatchObject({ resultId: proposal.resultId, revision: 1 }));
        let reads = 0;
        boundary.read = async () => { reads++; return { success: true, result: boundary.saved }; };
        const push = (revision: number, resultId = proposal.resultId, machineId = host === 'session' ? 'machine:commit-progress' : 'machine:workspace-commit-plan', serverId = home.id) =>
            pushResultUpdate(serverId, revision, resultId, machineId);
        const applying = savedResult(2, 'applying');
        boundary.saved = applying;
        await act(async () => { await push(2, 'another-result'); await push(2, proposal.resultId, 'another-machine');
            await push(2, proposal.resultId, undefined, 'another-home'); });
        expect(reads).toBe(0);
        await act(async () => { await push(2); });
        await vi.waitFor(() => expect(latest.current?.proposal?.application?.status).toBe('applying'));
        expect(latest.current?.actions.onStopAfterCurrent).toBeTypeOf('function');
        expect(reads).toBe(1);
        await act(async () => { await push(2); await push(1); });
        expect(reads).toBe(1);
        boundary.saved = ScmDiffSummaryResultSchema.parse({ ...applying, revision: 3,
            output: { ...applying.output, revision: 3 }, application: { ...applying.application, stopAfterCurrent: true } });
        await act(async () => { await push(3); });
        await vi.waitFor(() => expect(latest.current?.proposal?.application?.stopAfterCurrent).toBe(true));
        expect(reads).toBe(2);
        boundary.saved = savedResult(4, 'complete');
        await act(async () => { publishHomeAccountChange(home.id, undefined, { source: 'connected' }); });
        await vi.waitFor(() => expect(latest.current?.proposal?.groups[0]?.state).toBe('landed'));
        expect(reads).toBe(3);
        await act(async () => screen.unmount());
        await act(async () => { await push(5); });
        expect(reads).toBe(3);
    }, 120_000);

    it('keeps at most one slow progress read in flight and preserves progress and final publication', async () => {
        const { latest, home } = await mountProposal('slow-commit-progress');
        const slowRead = createDeferred<unknown>();
        const recovery = createDeferred<unknown>();
        let outstanding = 0;
        let maxOutstanding = 0;
        let reads = 0;
        boundary.read = async () => {
            reads += 1; outstanding += 1; maxOutstanding = Math.max(maxOutstanding, outstanding);
            try { return reads === 1 ? await slowRead.promise : { success: true, result: boundary.saved }; } finally { outstanding -= 1; }
        };
        boundary.recover = () => recovery.promise;
        vi.useFakeTimers();
        await act(async () => latest.current?.actions.onRecover?.());
        await act(async () => { await pushResultUpdate(home.id, 2); });
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
        expect(maxOutstanding).toBe(1);
        boundary.saved = savedResult(3, 'applying');
        await act(async () => { await pushResultUpdate(home.id, 3); });
        await act(async () => slowRead.resolve({ success: true, result: savedResult(2, 'applying') }));
        // Resolving the first transport read starts the queued authenticated reread.
        await vi.waitFor(() => expect(latest.current?.binding.viewModel?.revision).toBe(3));
        expect(latest.current?.proposal?.groups[0]?.state).toBe('writing');
        expect(reads).toBe(2);
        expect(maxOutstanding).toBe(1);
        await act(async () => recovery.resolve({ success: true, result: savedResult(4, 'complete') }));
        expect(latest.current?.proposal?.groups[0]?.state).toBe('landed');
        expect(latest.current?.busy).toBe(false);
        const completedReads = reads;
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
        expect(reads).toBe(completedReads);
    }, 120_000);

    it('stops reading progress after the proposal view unmounts without cancelling its application', async () => {
        const { latest, screen, home } = await mountProposal('unmounted-commit-progress');
        const recovery = createDeferred<unknown>();
        boundary.recover = () => recovery.promise;
        let reads = 0;
        boundary.read = async () => { reads += 1; return { success: true, result: boundary.saved }; };
        vi.useFakeTimers();
        const idleTimers = vi.getTimerCount();
        await act(async () => latest.current?.actions.onRecover?.());
        expect(vi.getTimerCount()).toBe(idleTimers);
        await act(async () => { await pushResultUpdate(home.id, 2); });
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect(reads).toBe(1);
        await act(async () => screen.unmount());
        await act(async () => { await pushResultUpdate(home.id, 3); });
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

    it('retires pushed progress reads when a retained Git view is hidden and preserves the final current-Account result', async () => {
        const { latest, visibility, home } = await mountProposal('hidden-commit-progress');
        const recovery = createDeferred<unknown>();
        boundary.recover = () => recovery.promise;
        let reads = 0;
        boundary.read = async () => { reads += 1; return { success: true, result: boundary.saved }; };
        vi.useFakeTimers();
        const idleTimers = vi.getTimerCount();
        await act(async () => latest.current?.actions.onRecover?.());
        await act(async () => { await pushResultUpdate(home.id, 2); });
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect(reads).toBe(1);
        await act(async () => visibility.setEnabled?.(false));
        await act(async () => { await pushResultUpdate(home.id, 3); });
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
        expect(reads).toBe(1);
        expect(vi.getTimerCount()).toBe(idleTimers);
        boundary.saved = savedResult(3, 'complete');
        await act(async () => recovery.resolve({ success: true, result: boundary.saved }));
        await act(async () => visibility.setEnabled?.(true));
        await vi.waitFor(() => expect(latest.current?.proposal?.groups[0]?.state).toBe('landed'));
    }, 120_000);
});
