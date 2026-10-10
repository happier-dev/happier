import * as React from 'react';
import '@/dev/testkit/harness/syncSingletonLoader';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScmDiffSummaryDiscussInputSchema, ScmDiffSummaryGenerateInputSchema, ScmDiffSummaryGenerateOutputSchema, ScmDiffSummaryResultSchema, ScmDiffSummaryResultEditInputSchema } from '@happier-dev/protocol/scm';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

const boundary = vi.hoisted(() => ({
    calls: [] as Array<{ machineId: string; method: string; payload: unknown; serverId?: string | null; accountId?: string | null;
        authorization?: import('@happier-dev/protocol/rpc').SocketRpcAuthorizationContext }>,
    capabilities: async (): Promise<unknown> => ({ protocolVersion: 1, results: {} }),
    savedResult: null as import('@happier-dev/protocol/scm').ScmDiffSummaryResult | null,
    savedSessionId: '',
    listBarrier: null as (() => Promise<void>) | null,
    runResponse: null as import('@happier-dev/protocol').ExecutionRunGetResponse | null,
    nativeRunBarrier: null as (() => Promise<void>) | null,
    sessionCalls: [] as Array<{ sessionId: string; method: string; payload: unknown; scope?: { serverId: string; accountId: string } }>,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
// Device credential custody is external. The profile registry, token parser,
// Account binding lifetime and every consumer of it remain real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({ importOriginal, tokenStorage: {
        getCredentialsForServerUrl: async () => ({ token: `header.${Buffer.from(JSON.stringify({ sub: 'walkthrough-account' })).toString('base64')}.signature`, secret: 'fixture-secret' }),
    } });
});
// The machine transport is the remote process boundary. Its real SCM and
// capability facades, admission, schemas, settings and result store are intact.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const rpc = async (request: { machineId: string; method: string; payload: unknown; serverId?: string | null; accountId?: string | null;
        authorization?: import('@happier-dev/protocol/rpc').SocketRpcAuthorizationContext }) => {
        boundary.calls.push(request);
        if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return boundary.capabilities();
        if (request.method === RPC_METHODS.DAEMON_EXECUTION_RUN_GET && boundary.runResponse) {
            await boundary.nativeRunBarrier?.();
            return boundary.runResponse;
        }
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST) {
            const saved = boundary.savedResult;
            await boundary.listBarrier?.();
            const results = saved ? [{ cwd: saved.output.comparison!.repository.rootPath, ...(boundary.savedSessionId ? { sessionId: boundary.savedSessionId } : {}),
                resultId: saved.resultId, revision: saved.revision, comparisonId: saved.output.comparison!.id,
                source: saved.output.comparison!.source, bytes: 100, updatedAtMs: 1 }] : [];
            return { success: true, results, count: results.length, bytes: saved ? 100 : 0,
                sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 } };
        }
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ && boundary.savedResult) {
            return { success: true, result: boundary.savedResult };
        }
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_UNDO && boundary.savedResult) {
            return { success: true, result: boundary.savedResult };
        }
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_DISCUSS && boundary.savedResult) {
            const input = ScmDiffSummaryDiscussInputSchema.parse(request.payload);
            if (input.expectedRevision !== boundary.savedResult.revision) return { success: false, errorCode: 'revision_conflict', error: 'Changed', latestRevision: boundary.savedResult.revision };
            return { success: true, result: boundary.savedResult, runId: 'native-run', inputId: 'discussion-input' };
        }
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_EDIT && boundary.savedResult) {
            const input = ScmDiffSummaryResultEditInputSchema.parse(request.payload);
            const saved = boundary.savedResult;
            if (input.expectedRevision !== saved.revision) return { success: false, errorCode: 'revision_conflict', error: 'Changed', latestRevision: saved.revision };
            const walkthrough = saved.output.outputs?.walkthrough;
            if (input.edit.kind !== 'renameWalkthrough' || !walkthrough?.value) throw new Error('Unexpected saved edit');
            boundary.savedResult = ScmDiffSummaryResultSchema.parse({ ...saved, revision: saved.revision + 1,
                output: { ...saved.output, revision: saved.revision + 1,
                    outputs: { ...saved.output.outputs, walkthrough: { ...walkthrough, value: { ...walkthrough.value, title: input.edit.title } } } } });
            return { success: true, result: boundary.savedResult };
        }
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE) {
            const input = ScmDiffSummaryGenerateInputSchema.parse(request.payload);
            // The host reads this retained identity before model admission; an
            // unavailable capture must not become fresh working-tree evidence.
            if (input.comparisonId) return ScmDiffSummaryGenerateOutputSchema.parse({ success: false,
                error: 'Captured comparison evidence is unavailable', errorCode: 'DIFF_UNAVAILABLE' });
            const sourceKey = `comparison:${input.sessionId ?? input.cwd}`;
            const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey,
                ...(!input.sessionId ? { runId: 'native-run', inputId: 'native-input', resultId: 'native-result', revision: 0 } : {}),
                metadata: { sourceKey, source: input.source }, requestedOutputs: input.outputs,
                comparison: { id: sourceKey, source: input.source, repository: { rootPath: input.cwd }, endpoints: {},
                    inventory: { state: 'complete', files: [], reasons: [] } },
                outputs: { walkthrough: { state: 'pending' } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
            });
            if (!input.sessionId) boundary.savedResult = ScmDiffSummaryResultSchema.parse({ resultId: 'native-result', revision: 0,
                canUndo: false, generator: { backendTarget: { kind: 'backend', backendId: 'claude' } }, output });
            return output;
        }
        throw new Error(`Unexpected machine boundary method: ${request.method}`);
    };
    // External RPC fixtures return method-specific wire shapes, not arbitrary R.
    return createServerScopedMachineRpcBoundaryMock(rpc as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope);
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async (importOriginal) => {
    const { createServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    // Method-specific wire fixtures at the external Session transport boundary.
    const rpc = async <R,>(request: { sessionId: string; method: string; payload: unknown; scope?: { serverId: string; accountId: string } }): Promise<R> => {
        boundary.sessionCalls.push(request);
        if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return { runs: [] } as R;
        if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET && boundary.runResponse) return boundary.runResponse as R;
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_UNDO && boundary.savedResult) return { success: true, result: boundary.savedResult } as R;
        throw new Error(`Unexpected Session boundary method: ${request.method}`);
    };
    return createServerScopedSessionRpcModuleMock({ importOriginal, overrides: {
        sessionRpcWithServerScope: rpc,
        sessionRpcWithServerAccountScope: rpc,
    } });
});

const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { standardCleanup } = await import('@/dev/testkit/cleanup/standardCleanup');
const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
const { getStorage } = await import('@/sync/domains/state/storage');
const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { encodeScmDiffSummaryModelOverride, decodeScmDiffSummaryModelOverride } = await import('@/settings/scmDiffSummary/settings');
const { getScmDiffSummaryState, getScmDiffSummaryOperationState } = await import('@/sync/ops/scmDiffSummary/generate');
const { getMachineCapabilitiesCacheState } = await import('@/hooks/server/useMachineCapabilitiesCache');
const { getAgentCore, getAgentStaticModels } = await import('@happier-dev/agents');
const { buildScmDiffSummaryModelProfiles } = await import('@/settings/scmDiffSummary/models');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { ScmDiffSummaryModelPicker } = await import('@/components/settings/sourceControl/ScmDiffSummaryModelPicker');
const { notifyExecutionRunActivity } = await import('@/sync/runtime/executionRuns/executionRunActivityBus');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
const { formatWithCachedDateTimeFormatter } = await import('@/utils/datetime/cachedIntlFormatters');
const { getPreferredLanguage } = await import('@/text');
await loadSyncSingletonForTests();
const { SessionWalkthroughView } = await import('./SessionWalkthroughView');
const { ScmWalkthroughView } = await import('./ScmWalkthroughView');
const { useWorkspaceScmDiffSummaryBinding } = await import('@/components/projects/scm/useWorkspaceScmDiffSummaryBinding');
const initialStorage = getStorage().getState();
const initialAppliedHome = getAppliedActiveServerSnapshot();
const initialRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
const accountCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'walkthrough-account' })).toString('base64')}.signature` };
let restoreObservationClock: (() => void) | null = null;

afterEach(() => {
    standardCleanup();
    restoreObservationClock?.();
    restoreObservationClock = null;
    resetRuntimeFetch();
    publishAppliedActiveServerRuntimeAvailability(false);
    getStorage().setState(initialStorage, true);
    publishAppliedActiveServerSnapshot(initialAppliedHome, initialRuntimeAvailable);
    boundary.calls = [];
    boundary.savedResult = null;
    boundary.savedSessionId = '';
    boundary.listBarrier = null;
    boundary.runResponse = null;
    boundary.nativeRunBarrier = null;
    boundary.sessionCalls = [];
});

async function mount(comparison: SessionScmReviewComparison, sessionId: string, storedModel = '', renderBar: (actions: React.ReactNode) => React.ReactNode = (actions) => actions, authenticated = false) {
    const home = await upsertServerProfile({ name: sessionId, serverUrl: `https://${sessionId}.example.test` });
    await setActiveServerId(home.id, { scope: 'device' });
    const machine = createMachineFixture({ id: `machine:${sessionId}`, activeAt: Date.now() });
    const session = createSessionFixture({ id: sessionId, serverId: home.id, active: true,
        metadata: { path: '/repo/exact', host: 'tester.local', machineId: machine.id, flavor: 'codex' } });
    getStorage().setState({ sessions: { [sessionId]: session }, machines: { [machine.id]: machine },
        machineListByServerId: { [home.id]: [machine] },
        ...(authenticated ? { profileScope: { serverId: home.id, accountId: 'walkthrough-account' } } : {}),
        settings: { ...initialStorage.settings, experiments: true, featureToggles: { 'execution.runs': true },
            'scm.diffSummary.modelProfileOverride': storedModel } });
    if (authenticated) publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const screen = await renderScreen(<SessionWalkthroughView sessionId={sessionId} serverId={home.id}
        comparison={comparison} scopeLabel="Shown comparison" layout="wide" renderBar={renderBar}
        onShowFiles={() => {}} onOpenFile={() => {}} onOpenComposer={() => {}} />, authenticated ? {
        wrapper: ({ children }) => <InjectedAuthProvider credentials={accountCredentials}>{children}</InjectedAuthProvider>,
    } : undefined);
    return { screen, home, machine };
}

function generationCalls() {
    return boundary.calls.filter((call) => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE);
}

async function mountWithAccountMarks(sessionId: string) {
    const comparison = { id: `captured:${sessionId}`, source: { kind: 'workingTree' }, repository: { rootPath: '/repo/exact' }, endpoints: {},
        inventory: { state: 'complete', reasons: [], files: [{ path: 'a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
            evidence: { state: 'available', unifiedDiff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+retained-code\n' },
            occurrences: [{ id: 'captured-change', alias: 'c1', path: 'a.ts', position: 0,
                before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
        }] } };
    boundary.savedSessionId = sessionId;
    boundary.savedResult = ScmDiffSummaryResultSchema.parse({ resultId: `result:${sessionId}`, revision: 1, canUndo: false,
        output: { success: true, resultId: `result:${sessionId}`, revision: 1, sourceKey: comparison.id,
            metadata: { sourceKey: comparison.id, source: comparison.source }, requestedOutputs: ['walkthrough'], comparison,
            outputs: { walkthrough: { state: 'complete', value: { title: 'Retained reading', intro: '',
                stops: [{ id: 'retained', title: 'Retained stop', importance: 'high', explanationMarkdown: 'The saved code remains readable.', changeRefs: ['captured-change'] }], otherChangeRefs: [] } } },
            analysis: { suppliedChangeRefs: ['captured-change'], analysedChangeRefs: ['captured-change'], remainingChangeRefs: [] },
        } });
    let stored = encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { v: 1, comparisonId: comparison.id, reviewedChangeRefs: [] } });
    let version = 1;
    let writes = 0;
    let reads = 0;
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    // Account HTTP is the external boundary; mode admission, JSON custody, CAS,
    // marks membership and the active Account lifetime all remain real.
    setRuntimeFetch(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === '/v1/account/encryption/currentness') return json({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
        if (url.pathname === '/v1/kv' && init?.method === 'POST') {
            const mutation = JSON.parse(String(init.body)).mutations[0];
            expect(mutation.version).toBe(version);
            stored = mutation.value;
            writes++;
            return json({ success: true, results: [{ key: mutation.key, version: ++version }] });
        }
        if (url.pathname.startsWith('/v1/kv/')) {
            reads++;
            return json({ key: decodeURIComponent(url.pathname.slice('/v1/kv/'.length)), value: stored, version });
        }
        throw new Error(`Unexpected Account HTTP boundary: ${url.pathname}`);
    });
    const mounted = await mount({ kind: 'workingTree' }, sessionId, '', undefined, true);
    await vi.waitFor(() => expect(mounted.screen.findByTestId('walkthrough-mark-retained')?.props.disabled).toBe(false));
    expect(reads).toBeGreaterThan(0);
    const entry = Object.values(getScmDiffSummaryState().entriesByKey).find(value => value.sessionId === sessionId)!;
    expect(entry.observedAtMs).toBeGreaterThan(0);
    const offline = async () => {
        const machine = { ...mounted.machine, active: false, activeAt: 0 };
        await act(async () => getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [mounted.home.id]: [machine] } }));
    };
    return { ...mounted, offline, writes: () => writes, observedAtMs: entry.observedAtMs };
}

describe('SessionWalkthroughView retained offline reading through real Account marks', () => {
    it.each([
        { name: 'retires workspace-native generation at silent heartbeat expiry and recovers on heartbeat', expiry: true },
        { name: 'starts workspace-native generation and observes its exact Run output without Session notifications', expiry: false },
    ])('$name', async ({ expiry }) => {
        boundary.capabilities = async () => ({ protocolVersion: 1, results: {
            'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { backends: { claude: { available: true } } } },
        } });
        const profiles = buildScmDiffSummaryModelProfiles({ backendTarget: { kind: 'backend', backendId: 'claude' },
            models: getAgentStaticModels('claude'), agentFormats: getAgentCore('claude')?.structuredOutput?.formats });
        const home = await upsertServerProfile({ serverUrl: 'https://native-generation.example.test' });
        await setActiveServerId(home.id, { scope: 'device' });
        const machine = createMachineFixture({ id: 'native-machine', activeAt: Date.now() });
        getStorage().setState({ sessions: {}, machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] },
            profileScope: { serverId: home.id, accountId: 'walkthrough-account' },
            settings: { ...initialStorage.settings, experiments: true, featureToggles: { 'execution.runs': true },
                'scm.diffSummary.modelProfileOverride': profiles.find(profile => profile.structuredOutput === 'supported')!.catalogId } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const observed = createDeferred<void>();
        boundary.nativeRunBarrier = () => observed.promise;
        boundary.runResponse = ExecutionRunGetResponseSchema.parse({ run: {
            runId: 'native-run', callId: 'native-call', sidechainId: 'native-sidechain', intent: 'scm_diff_summary',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only', retentionPolicy: 'resumable',
            runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 100,
        } });
        function Workspace() {
            const bound = useWorkspaceScmDiffSummaryBinding({ machineId: machine.id, rootPath: '/native/repo', serverId: home.id,
                comparison: { kind: 'workingTree' }, output: 'walkthrough' });
            return <ScmWalkthroughView bound={bound} displayMachineId={machine.id} serverId={home.id} comparison={{ kind: 'workingTree' }}
                scopeLabel="Workspace" layout="wide" renderBar={actions => actions} onShowFiles={() => {}} onOpenFile={() => {}} />;
        }
        if (expiry) {
            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
            restoreObservationClock = () => vi.useRealTimers();
        }
        const screen = await renderScreen(<Workspace />, { wrapper: ({ children }) =>
            <InjectedAuthProvider credentials={accountCredentials}>{children}</InjectedAuthProvider> });
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(false));
        if (expiry) {
            await act(async () => { vi.advanceTimersByTime(60_001); });
            expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(true);
            expect(generationCalls()).toEqual([]);
            const heartbeat = { ...machine, activeAt: Date.now() };
            await act(async () => { getStorage().setState({ machines: { [machine.id]: heartbeat }, machineListByServerId: { [home.id]: [heartbeat] } }); });
            expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(false);
            await screen.unmount();
            return;
        }
        await screen.pressByTestIdAsync('walkthrough-start');
        await vi.waitFor(() => expect(boundary.calls).toContainEqual(expect.objectContaining({
            method: RPC_METHODS.DAEMON_EXECUTION_RUN_GET, payload: { runId: 'native-run', includeStructured: true,
                waitForInputId: 'native-input',
                waitForOutput: { kind: 'review_walkthrough', comparisonId: 'comparison:/native/repo', resultId: 'native-result', afterRevision: 0 } },
        })));
        const pending = boundary.savedResult!;
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ ...pending, revision: 1,
            output: { ...pending.output, revision: 1, outputs: { walkthrough: { state: 'complete', value: {
                title: 'Native completion', intro: 'The exact producer finished.', stops: [], otherChangeRefs: [],
            } } } } });
        boundary.runResponse = ExecutionRunGetResponseSchema.parse({ ...boundary.runResponse,
            structuredMeta: { kind: 'scm_diff_summary.v1', payload: boundary.savedResult.output } });
        observed.resolve();
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Native completion'));
        const discussed = createDeferred<void>();
        boundary.nativeRunBarrier = () => discussed.promise;
        await screen.pressByTestIdAsync('walkthrough-saved-discuss');
        await act(async () => screen.changeTextByTestId('walkthrough-saved-message', 'Why this approach?'));
        await screen.pressByTestIdAsync('walkthrough-saved-discuss-send');
        await vi.waitFor(() => expect(boundary.calls).toContainEqual(expect.objectContaining({
            method: RPC_METHODS.DAEMON_EXECUTION_RUN_GET,
            payload: { runId: 'native-run', includeStructured: true, waitForInputId: 'discussion-input' },
        })));
        boundary.runResponse = ExecutionRunGetResponseSchema.parse({ ...boundary.runResponse,
            run: { ...boundary.runResponse!.run, inputTurns: { occurrenceId: 'native-occurrence', current: {
                turnId: 'discussion-turn', inputIds: ['discussion-input'], state: 'completed',
                result: { kind: 'text', value: 'The generator answered through its actual native turn.' },
            } } } });
        discussed.resolve();
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('The generator answered through its actual native turn.'));
        expect(screen.getTextContent()).toContain('Native completion');
        expect(generationCalls()).toEqual([expect.objectContaining({ machineId: machine.id, serverId: home.id,
            payload: expect.not.objectContaining({ sessionId: expect.anything() }) })]);
        expect(boundary.sessionCalls).toEqual([]);
    }, 120_000);
    it('restores and edits workspace-native saved reading without a Session and retires it on another checkout', async () => {
        const home = await upsertServerProfile({ name: 'workspace-only', serverUrl: 'https://workspace-only.example.test' });
        await setActiveServerId(home.id, { scope: 'device' });
        const machine = createMachineFixture({ id: 'workspace-only-machine', activeAt: Date.now() });
        getStorage().setState({ sessions: {}, machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] },
            profileScope: { serverId: home.id, accountId: 'walkthrough-account' } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const comparison = { id: 'workspace-captured', source: { kind: 'workingTree' }, repository: { rootPath: '/workspace/exact' },
            endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } };
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ resultId: 'workspace-saved', revision: 1, canUndo: true,
            output: { success: true, resultId: 'workspace-saved', revision: 1, sourceKey: comparison.id, comparison,
                metadata: { sourceKey: comparison.id, source: comparison.source }, requestedOutputs: ['walkthrough'],
                outputs: { walkthrough: { state: 'complete', value: { title: 'Workspace saved reading', intro: '', stops: [], otherChangeRefs: [] } } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } });
        function Workspace({ rootPath }: { rootPath: string }) {
            const bound = useWorkspaceScmDiffSummaryBinding({ machineId: machine.id, rootPath, serverId: home.id,
                comparison: { kind: 'workingTree' }, output: 'walkthrough' });
            return <ScmWalkthroughView bound={bound} displayMachineId={machine.id} serverId={home.id} comparison={{ kind: 'workingTree' }}
                scopeLabel="Workspace" layout="wide" renderBar={(actions) => actions} onShowFiles={() => {}} onOpenFile={() => {}} />;
        }
        const screen = await renderScreen(<Workspace rootPath="/workspace/exact" />, {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={accountCredentials}>{children}</InjectedAuthProvider>,
        });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Workspace saved reading'));
        await screen.pressByTestIdAsync('walkthrough-saved-edit');
        await act(async () => screen.findByTestId('walkthrough-saved-title')!.props.onChangeText('My workspace title'));
        await screen.pressByTestIdAsync('walkthrough-saved-title-save');
        await vi.waitFor(() => expect(boundary.savedResult?.revision).toBe(2));
        expect(screen.getTextContent()).toContain('My workspace title');
        expect(boundary.sessionCalls).toEqual([]);
        expect(generationCalls()).toEqual([]);
        expect(boundary.calls.filter(call => call.method.startsWith('scm.diffSummary.')).every(call => call.authorization === undefined)).toBe(true);
        const savedState = Object.values(getScmDiffSummaryState().entriesByKey).find((entry) => entry.savedResult?.resultId === 'workspace-saved');
        expect(savedState).toMatchObject({ sessionId: null, machineId: machine.id, input: { cwd: '/workspace/exact' } });
        await screen.update(<Workspace rootPath="/workspace/other" />);
        expect(screen.getTextContent()).not.toContain('My workspace title');
        expect(boundary.calls.filter((call) => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_EDIT)).toEqual([
            expect.objectContaining({ machineId: machine.id, serverId: home.id, accountId: 'walkthrough-account', payload: {
                cwd: '/workspace/exact', resultId: 'workspace-saved', expectedRevision: 1, edit: { kind: 'renameWalkthrough', title: 'My workspace title' },
            } }),
        ]);
    });
    it('labels retained code from its observation and disables personal marks when the owning machine goes offline', async () => {
        const { screen, offline, writes, observedAtMs } = await mountWithAccountMarks('offline-marks');
        await screen.pressByTestIdAsync('walkthrough-mark-retained');
        await vi.waitFor(() => expect(writes()).toBe(1));
        // The operations owner captures its observation clock at creation.
        // Move only the consumer's Date boundary after that real read; timers
        // stay real and neither Date.now nor new Date may invent a fresh label.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(observedAtMs! + 86_400_000);
        restoreObservationClock = () => vi.useRealTimers();
        await offline();
        expect(screen.findByTestId('walkthrough-mark-retained')?.props.disabled).toBe(true);
        expect(screen.getTextContent()).toContain('Retained reading');
        const readingView = screen.find(node => node.props.scopeLabel === 'Shown comparison'
            && node.props.reading !== undefined && node.props.start !== undefined);
        expect(readingView.props.reading.stops[0].files[0].unifiedDiff).toContain('+retained-code');
        await screen.pressByTestIdAsync('walkthrough-mark-retained');
        expect(writes()).toBe(1);
        expect(screen.findHostByTestId('walkthrough-notice-offline')).toBeTruthy();
        expect(readingView.props.offline).toEqual({ machine: 'tester.local',
            time: formatWithCachedDateTimeFormatter(observedAtMs!, getPreferredLanguage(), { dateStyle: 'medium', timeStyle: 'short' }),
        });
        // This is the observed retained read, not a manufactured fresh clock on loss of reachability.
        expect(Object.values(getScmDiffSummaryState().entriesByKey).find(value => value.sessionId === 'offline-marks')?.observedAtMs).toBe(observedAtMs);
    }, 120_000);

    it('does not admit fresh machine evidence on activity while offline, and rereads the current revision on reconnect', async () => {
        const { screen, home, machine, offline } = await mountWithAccountMarks('offline-evidence');
        await act(async () => {});
        await offline();
        const reads = () => boundary.calls.filter(call => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ).length;
        const before = reads();
        await act(async () => notifyExecutionRunActivity({ serverId: home.id, sessionId: 'offline-evidence' }, { runId: 'offline-notification' }));
        expect(reads()).toBe(before);
        expect(generationCalls()).toEqual([]);
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ ...boundary.savedResult!, revision: 2,
            output: { ...boundary.savedResult!.output, revision: 2, outputs: { walkthrough: { state: 'complete',
                value: { ...boundary.savedResult!.output.outputs!.walkthrough!.value, title: 'Current revision after reconnect' } } } } });
        await act(async () => getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] } }));
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Current revision after reconnect'));
        expect(reads()).toBeGreaterThan(before);
    }, 120_000);
});

describe('SessionWalkthroughView START through real generation and model owners', () => {
    it('keeps the reading render idle when an unrelated source-control preference changes', async () => {
        const renderBar = vi.fn((actions: React.ReactNode) => actions);
        const { home, machine } = await mount({ kind: 'workingTree' }, 'settings-locality', '', renderBar);
        await vi.waitFor(() => expect(getMachineCapabilitiesCacheState(machine.id, home.id)?.status).toBe('loaded'));
        await act(async () => {});
        const before = renderBar.mock.calls.length;
        await act(async () => getStorage().setState((state) => ({ settings: {
            ...state.settings, 'scm.diffSummary.prefetch': !state.settings['scm.diffSummary.prefetch'],
        } })));
        expect(renderBar.mock.calls.length - before).toBe(0);
    }, 120_000);

    it('shares an in-flight restore and rereads once when saved output arrives during the list request', async () => {
        const firstList = createDeferred<void>();
        boundary.listBarrier = () => firstList.promise;
        boundary.savedSessionId = 'restore-burst';
        const { screen, home } = await mount({ kind: 'workingTree' }, boundary.savedSessionId);
        const lists = () => boundary.calls.filter((call) => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST);
        await vi.waitFor(() => expect(lists()).toHaveLength(1));
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ resultId: 'burst-result', revision: 1, canUndo: false,
            output: { success: true, resultId: 'burst-result', revision: 1, sourceKey: 'burst-comparison',
                metadata: { sourceKey: 'burst-comparison', source: { kind: 'workingTree' } }, requestedOutputs: ['walkthrough'],
                comparison: { id: 'burst-comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/repo/exact' },
                    endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
                outputs: { walkthrough: { state: 'complete', value: { title: 'Arrived during restore', intro: '', stops: [], otherChangeRefs: [] } } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
            } });
        await act(async () => {
            for (const runId of ['run-a', 'run-b', 'run-c']) {
                notifyExecutionRunActivity({ serverId: home.id, sessionId: boundary.savedSessionId }, { runId });
            }
        });
        expect(lists()).toHaveLength(1);
        boundary.listBarrier = null;
        await act(async () => firstList.resolve());
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Arrived during restore'));
        expect(lists()).toHaveLength(2);
        expect(generationCalls()).toEqual([]);
    }, 120_000);

    it.each([
        { comparison: { kind: 'turnCheckpoint', turnId: 'shown-earlier-turn', evidence: 'agent_reported' }, source: { kind: 'turnCheckpoint', turnId: 'shown-earlier-turn', evidenceMode: 'agent_reported' }, sessionId: 'start-turn' },
        { comparison: { kind: 'session' }, source: { kind: 'session', sessionId: 'start-session' }, sessionId: 'start-session' },
    ] satisfies Array<{ comparison: SessionScmReviewComparison; source: unknown; sessionId: string }>)('does no model work on mount, fails closed until capabilities settle, then starts exactly $sessionId', async ({ comparison, source, sessionId }) => {
        const capabilities = createDeferred<unknown>();
        boundary.capabilities = () => capabilities.promise;
        const { screen, home, machine } = await mount(comparison, sessionId);
        expect(generationCalls()).toEqual([]);
        expect(boundary.calls.filter((call) => call.method === RPC_METHODS.CAPABILITIES_DETECT)
            .flatMap((call) => (call.payload as { requests?: Array<{ id: string }> }).requests ?? [])
            .some((request) => request.id.includes('models'))).toBe(false);
        const picker = screen.findByType(DropdownMenu);
        const eligible = picker.props.items.find((item: { id: string; disabled?: boolean }) => decodeScmDiffSummaryModelOverride(item.id) !== null && !item.disabled);
        expect(eligible).toBeDefined();
        // Exercise the actual shared picker selection; no catalog or availability callback is mocked.
        await act(async () => picker.props.onSelect(eligible.id));
        expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('walkthrough-start');
        expect(generationCalls()).toEqual([]);
        await act(async () => capabilities.resolve({ protocolVersion: 1, results: {
            'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { backends: { codex: { available: true, intents: ['scm_diff_summary'] } } } },
        } }));
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('walkthrough-start');
        const selector = decodeScmDiffSummaryModelOverride(eligible.id);
        expect(generationCalls()).toEqual([expect.objectContaining({ machineId: machine.id, serverId: home.id,
            accountId: 'walkthrough-account', payload: { sessionId, cwd: '/repo/exact', source, outputs: ['walkthrough'], modelSelector: selector } })]);
        const entry = Object.values(getScmDiffSummaryState().entriesByKey).find((value) => value.sessionId === sessionId);
        expect(entry).toMatchObject({ sessionId, input: { source, modelSelector: selector }, latestOutput: { success: true, metadata: { source } } });
    }, 120_000);

    it('does not admit a syntactically valid stored selector absent from the real eligible catalog', async () => {
        boundary.capabilities = async () => ({ protocolVersion: 1, results: {
            'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { backends: { codex: { available: true } } } },
        } });
        const stored = encodeScmDiffSummaryModelOverride({ backendTargetKey: 'agent:happier.agent.codex/codex', modelId: 'not-in-the-real-catalog' });
        const { screen, home, machine } = await mount({ kind: 'workingTree' }, 'unavailable-model', stored);
        await vi.waitFor(() => expect(getMachineCapabilitiesCacheState(machine.id, home.id)?.status).toBe('loaded'));
        expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('walkthrough-start');
        expect(generationCalls()).toEqual([]);
        // With the same settled machine and access grant, choosing an actual
        // eligible item recovers admission; the unavailable value was the blocker.
        const picker = screen.findByType(DropdownMenu);
        const eligible = picker.props.items.find((item: { id: string; disabled?: boolean }) => decodeScmDiffSummaryModelOverride(item.id) !== null && !item.disabled);
        expect(eligible).toBeDefined();
        await act(async () => picker.props.onSelect(eligible.id));
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('walkthrough-start');
        expect(generationCalls()).toEqual([expect.objectContaining({ payload: {
            sessionId: 'unavailable-model', cwd: '/repo/exact', source: { kind: 'workingTree' }, outputs: ['walkthrough'],
            modelSelector: decodeScmDiffSummaryModelOverride(eligible.id),
        } })]);
    }, 120_000);

    it('keeps the exact captured identity and reports unavailable evidence without replacing it with a fresh source', async () => {
        const comparisonId = 'c'.repeat(64);
        boundary.capabilities = async () => ({ protocolVersion: 1, results: {
            'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { backends: { codex: { available: true, intents: ['scm_diff_summary'] } } } },
        } });
        const { screen } = await mount({ kind: 'workingTree', comparisonId }, 'captured-route');
        const picker = screen.findByType(DropdownMenu);
        const eligible = picker.props.items.find((item: { id: string; disabled?: boolean }) => decodeScmDiffSummaryModelOverride(item.id) !== null && !item.disabled);
        await act(async () => picker.props.onSelect(eligible.id));
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('walkthrough-start');
        expect(generationCalls()).toEqual([expect.objectContaining({ payload: expect.objectContaining({
            comparisonId, source: { kind: 'workingTree' },
        }) })]);
        const entry = Object.values(getScmDiffSummaryState().entriesByKey).find((value) => value.sessionId === 'captured-route');
        expect(entry).toMatchObject({ status: 'failed', error: { code: 'DIFF_UNAVAILABLE' } });
        expect(entry?.latestOutput?.success).not.toBe(true);
        expect(screen.getTextContent()).toContain(entry!.error!.message);
    }, 120_000);

    it('keeps Refresh when a stale saved reading receives a new supported Summary preference with its picker unmounted', async () => {
        boundary.capabilities = async () => ({ protocolVersion: 1, results: {
            'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { backends: { claude: { available: true } } } },
        } });
        const profiles = buildScmDiffSummaryModelProfiles({ backendTarget: { kind: 'backend', backendId: 'claude' },
            models: getAgentStaticModels('claude'), agentFormats: getAgentCore('claude')?.structuredOutput?.formats });
        const supported = profiles.filter((profile) => profile.structuredOutput === 'supported');
        const stored = supported[0]!.catalogId;
        const changedPreference = supported[1]!.catalogId;
        boundary.savedSessionId = 'reopened-stale';
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ resultId: 'reopened-result', revision: 4, canUndo: false,
            generator: { backendTarget: { kind: 'backend', backendId: 'claude' } },
            output: { success: true, resultId: 'reopened-result', revision: 4, sourceKey: 'reopened-comparison',
                metadata: { sourceKey: 'reopened-comparison', source: { kind: 'workingTree' } }, requestedOutputs: ['walkthrough'],
                comparison: { id: 'reopened-comparison', source: { kind: 'workingTree' }, freshness: 'stale',
                    repository: { rootPath: '/repo/exact' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
                outputs: { walkthrough: { state: 'complete', value: { title: 'Saved reading', intro: '', stops: [], otherChangeRefs: [] } } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
            } });
        const { screen, home, machine } = await mount({ kind: 'workingTree' }, boundary.savedSessionId, stored);
        await vi.waitFor(() => expect(getMachineCapabilitiesCacheState(machine.id, home.id)?.status).toBe('loaded'));
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-notice-stale')).toBeTruthy());
        expect(screen.findAllByType(ScmDiffSummaryModelPicker)).toHaveLength(0);
        expect(generationCalls()).toEqual([]);
        // Remote Account settings also publish into this real store. Unlike
        // restoration's brief empty frame, an already-open reading has no picker
        // to settle availability for the newly selected supported model.
        await act(async () => getStorage().setState((state) => ({ settings: {
            ...state.settings, 'scm.diffSummary.modelProfileOverride': changedPreference,
        } })));
        expect(screen.findByTestId('walkthrough-refresh')).toBeTruthy();
        await screen.pressByTestIdAsync('walkthrough-refresh');
        expect(generationCalls()).toEqual([]);
        const picker = screen.findByType(DropdownMenu);
        const eligible = picker.props.items.find((item: { id: string; disabled?: boolean }) => decodeScmDiffSummaryModelOverride(item.id) !== null && item.id !== stored && !item.disabled);
        expect(eligible).toBeDefined();
        await act(async () => picker.props.onSelect(eligible.id));
        await screen.pressByTestIdAsync('walkthrough-refresh');
        expect(generationCalls()).toEqual([expect.objectContaining({ machineId: machine.id, serverId: home.id,
            accountId: 'walkthrough-account', payload: { sessionId: 'reopened-stale', cwd: '/repo/exact', source: { kind: 'workingTree' },
                outputs: ['walkthrough'], modelSelector: decodeScmDiffSummaryModelOverride(eligible.id), cachePolicy: { mode: 'bypass' } } })]);
    }, 120_000);

    it('adopts a persisted pending result’s later Run binding and prose on existing Session activity without model admission', async () => {
        boundary.capabilities = async () => ({ protocolVersion: 1, results: {
            'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { backends: { claude: { available: true } } } },
        } });
        boundary.savedSessionId = 'late-bound-run';
        const pending = ScmDiffSummaryResultSchema.parse({ resultId: 'pending-result', revision: 0, canUndo: false,
            generator: { backendTarget: { kind: 'backend', backendId: 'claude' } },
            output: { success: true, resultId: 'pending-result', revision: 0, sourceKey: 'pending-comparison',
                metadata: { sourceKey: 'pending-comparison', source: { kind: 'workingTree' } }, requestedOutputs: ['walkthrough'],
                comparison: { id: 'pending-comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/repo/exact' },
                    endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
                outputs: { walkthrough: { state: 'pending' } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
            } });
        boundary.savedResult = pending;
        const { screen, home } = await mount({ kind: 'workingTree' }, boundary.savedSessionId);
        await vi.waitFor(() => expect(boundary.calls.some(call => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST
            && call.authorization?.kind === 'session.write' && call.authorization.sessionId === 'late-bound-run')).toBe(true));
        const projection = () => {
            const state = getScmDiffSummaryState();
            const entry = Object.values(state.entriesByKey).find((value) => value.sessionId === 'late-bound-run');
            return entry ? getScmDiffSummaryOperationState(state, entry.key) : null;
        };
        await vi.waitFor(() => expect(projection()).toMatchObject({ resultId: 'pending-result', executionRunId: null,
            savedResult: { revision: 0 }, outputs: { walkthrough: { state: 'pending' } } }));
        expect(generationCalls()).toEqual([]);
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ ...pending, revision: 1, canUndo: true,
            updateNotice: { kind: 'generation', revision: 1, affectedStopIds: [] },
            output: { ...pending.output, revision: 1, runId: 'newly-bound-run', outputs: { walkthrough: { state: 'complete', value: {
                title: 'Published reading', intro: 'Prose published after the Run was bound.', stops: [], otherChangeRefs: [],
            } } } } });
        boundary.runResponse = ExecutionRunGetResponseSchema.parse({ run: {
            runId: 'newly-bound-run', callId: 'newly-bound-call', sidechainId: 'newly-bound-sidechain', intent: 'scm_diff_summary',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only', retentionPolicy: 'resumable',
            runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 100,
        }, structuredMeta: { kind: 'scm_diff_summary.v1', payload: boundary.savedResult.output } });
        await act(async () => notifyExecutionRunActivity({ serverId: home.id, sessionId: 'late-bound-run' }, { runId: 'newly-bound-run' }));
        await vi.waitFor(() => expect(projection()).toMatchObject({ executionRunId: 'newly-bound-run', savedResult: { revision: 1 },
            latestRun: { runId: 'newly-bound-run' }, outputs: { walkthrough: { state: 'complete', value: { title: 'Published reading' } } } }));
        const rendered = screen.getTextContent();
        expect(rendered).toContain('Published reading');
        expect(rendered).toContain('Prose published after the Run was bound.');
        expect(screen.findByTestId('walkthrough-undo')).not.toBeNull();
        const current = boundary.savedResult!;
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ ...current, revision: 2, canUndo: false,
            updateNotice: { kind: 'undo', revision: 2, affectedStopIds: [] },
            output: { ...current.output, revision: 2, outputs: { walkthrough: { state: 'complete', value: {
                title: 'Earlier reading', intro: '', stops: [], otherChangeRefs: [],
            } } } } });
        await screen.pressByTestIdAsync('walkthrough-undo');
        await vi.waitFor(() => expect(projection()?.savedResult?.revision).toBe(2));
        expect(screen.getTextContent()).toContain('Earlier reading');
        expect(screen.findByTestId('walkthrough-undo')).toBeNull();
        expect([...boundary.calls, ...boundary.sessionCalls]).toEqual(expect.arrayContaining([expect.objectContaining({
            method: RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_UNDO,
            payload: { cwd: '/repo/exact', resultId: 'pending-result', expectedRevision: 1 },
        })]));
        expect(boundary.sessionCalls).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: 'late-bound-run',
            method: SESSION_RPC_METHODS.EXECUTION_RUN_GET, payload: { runId: 'newly-bound-run', includeStructured: true },
            scope: { serverId: home.id, accountId: 'walkthrough-account' } })]));
        expect(generationCalls()).toEqual([]);
    }, 120_000);

    it('restores a review’s walkthrough the machine saved after the view opened, then places its findings beside the stop, with no model work', async () => {
        boundary.capabilities = async () => ({ protocolVersion: 1, results: {} });
        boundary.savedSessionId = 'reviewed-session';
        const { screen, home } = await mount({ kind: 'workingTree' }, boundary.savedSessionId);
        await vi.waitFor(() => expect(boundary.calls.some((call) => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST)).toBe(true));
        expect(screen.getTextContent()).not.toContain('Keys follow the route');

        const comparison = { id: 'review-comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/repo/exact' }, endpoints: {},
            inventory: { state: 'complete', reasons: [], files: [{ path: 'src/a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
                evidence: { state: 'available', unifiedDiff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n a\n b\n c\n+d' },
                occurrences: [{ id: 'src/a.ts#0', alias: 'c1', path: 'src/a.ts', before: { startLine: 1, lineCount: 3 }, after: { startLine: 1, lineCount: 4 }, position: 0 }] }] } };
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ resultId: 'review-result', revision: 1, canUndo: false,
            output: { success: true, resultId: 'review-result', revision: 1, sourceKey: 'review-comparison', runId: 'review-run',
                metadata: { sourceKey: 'review-comparison', source: { kind: 'workingTree' } }, requestedOutputs: ['walkthrough'], comparison,
                outputs: { walkthrough: { state: 'complete', value: { title: 'Keys follow the route', intro: 'Narrated from the review.',
                    stops: [{ id: 's1', title: 'The new line', explanationMarkdown: 'Adds d.', changeRefs: ['src/a.ts#0'], findingRefs: ['f1'],
                        reviewExplanations: [{ markdown: 'The finding questions validation, without changing the walkthrough.', findingRefs: [{ runId: 'review-run', findingId: 'f1' }],
                            provenance: { requestedBy: { kind: 'agent', id: 'review-agent' }, requestedAtMs: 151, generatedAtMs: 160, modelId: 'explanation-model', runId: 'explanation-run' } }] }], otherChangeRefs: [] } } },
                analysis: { suppliedChangeRefs: ['src/a.ts#0'], analysedChangeRefs: ['src/a.ts#0'], remainingChangeRefs: [] },
                producer: { kind: 'review', modelId: 'Opus 5.5', runId: 'review-run', narrationMode: 'continued_review', comparisonFreshness: 'unchanged',
                    reviewedRuns: [{ runId: 'review-run', callId: 'review-call', backendId: 'codex', status: 'succeeded', hasOutput: true, comparisonId: 'review-comparison', reviewOutcome: 'complete' }] },
            } });
        boundary.runResponse = ExecutionRunGetResponseSchema.parse({ run: {
            runId: 'review-run', callId: 'review-call', sidechainId: 'review-sidechain', intent: 'review',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only', retentionPolicy: 'resumable',
            runClass: 'long_lived', ioMode: 'streaming', status: 'succeeded', startedAtMs: 100, finishedAtMs: 200,
        }, structuredMeta: { kind: 'review_findings.v2', payload: { runRef: { runId: 'review-run', callId: 'review-call', backendId: 'codex' },
            comparisonId: 'review-comparison', summary: 'One finding.', overviewMarkdown: 'One finding.', generatedAtMs: 150,
            findings: [{ id: 'f1', title: 'The new line skips validation', severity: 'high', category: 'correctness', summary: 'd is unchecked.', filePath: 'src/a.ts', startLine: 4 }] } } });
        // The review's narration finished on the machine; Session Run activity is the canonical invalidation.
        await act(async () => notifyExecutionRunActivity({ serverId: home.id, sessionId: 'reviewed-session' }, { runId: 'review-run' }));
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Keys follow the route'));
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-finding-f1')).not.toBeNull());
        expect(screen.findByTestId('walkthrough-finding-ref-f1')).not.toBeNull();
        expect(screen.findByTestId('walkthrough-review-fact')).not.toBeNull();
        expect(screen.findByTestId('review-walkthrough-steps')).not.toBeNull();
        expect(screen.findByTestId('walkthrough-review-explanation:s1:0')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Adds d.');
        expect(screen.getTextContent()).toContain('The finding questions validation, without changing the walkthrough.');
        expect(screen.getTextContent()).toContain('explanation-model');
        expect(screen.getTextContent()).toContain('review-agent');
        expect(generationCalls()).toEqual([]);
    }, 120_000);
});
