import * as React from 'react';
import type { LlmTaskRunnerChoiceV1, LlmTaskRunnerConfigV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import '@/dev/testkit/harness/syncSingletonLoader';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyScmReviewedMarkIntent, buildScmReviewedMarksKey, buildScmReviewScopeId, buildScmComparisonIdentity, ScmComparisonCaptureInputSchema, ScmComparisonCaptureOutputSchema, ScmDiffSummaryDiscussInputSchema, ScmDiffSummaryGenerateInputSchema, ScmDiffSummaryGenerateOutputSchema, ScmDiffSummaryResultSchema, ScmDiffSummaryResultReadInputSchema, ScmDiffSummaryResultEditInputSchema } from '@happier-dev/protocol/scm';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { CapabilitiesDescribeResponse } from '@happier-dev/protocol/capabilities';
import { ExecutionRunGetResponseSchema} from '@happier-dev/protocol/execution/runs/responseSchemas';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { SessionModelRefSchema } from '@happier-dev/protocol/providers/selection/v2';
import { serveActionHomes, type ServedHomeRequest } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

const boundary = vi.hoisted(() => ({
    calls: [] as Array<{ machineId: string; method: string; payload: unknown; serverId?: string | null; accountId?: string | null;
        authorization?: import('@happier-dev/protocol/rpc').SocketRpcAuthorizationContext }>,
    capabilities: async (): Promise<unknown> => ({ protocolVersion: 1, results: {} }),
    runRequest: null as ((request: { machineId: string; method: string; payload: unknown; serverId: string; accountId: string }) => Promise<unknown>) | null,
    /** The executing Machine's Summary model catalog, served as its exact-Machine Action over Home HTTP. */
    catalog: null as ((url: URL, init?: RequestInit) => Promise<Response | null>) | null,
    discoveredModels: [] as import('@happier-dev/protocol/models/descriptor').ProviderModelDescriptorV1[],
    nativeModelsByAgent: null as Record<string, import('@happier-dev/protocol/models/descriptor').ProviderModelDescriptorV1[]> | null,
    modelCatalogReads: 0,
    /** Extra stored Session metadata, such as the Session's own model list. */
    sessionMetadata: {} as Record<string, unknown>,
    savedResult: null as import('@happier-dev/protocol/scm').ScmDiffSummaryResult | null,
    savedSessionId: '',
    listBarrier: null as (() => Promise<void>) | null,
    runResponse: null as import('@happier-dev/protocol/execution/runs/responseSchemas').ExecutionRunGetResponse | null,
    nativeRunBarrier: null as (() => Promise<void>) | null,
    sessionCalls: [] as Array<{ sessionId: string; method: string; payload: unknown; scope?: { serverId: string; accountId: string } }>,
    accountRoute: null as ((request: ServedHomeRequest) => Promise<Response | undefined>) | null,
    /** The daemon's answer to a generation the canonical request schema admitted, when a case needs one. */
    generate: null as ((input: import('@happier-dev/protocol/scm').ScmDiffSummaryGenerateInput) => unknown) | null,
    router: null as ReturnType<typeof import('@/dev/testkit/mocks/router').createExpoRouterMock> | null,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// Home HTTP and Machine RPC are fixtures; their Account socket must share that
// network boundary rather than attempting real connections to example.test.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    boundary.router = createExpoRouterMock();
    return boundary.router.module;
});
// The machine transport is the remote process boundary. Its real SCM and
// capability facades, admission, schemas, settings and result store are intact.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const rpc = async (request: { machineId: string; method: string; payload: unknown; serverId?: string | null; accountId?: string | null;
        authorization?: import('@happier-dev/protocol/rpc').SocketRpcAuthorizationContext }) => {
        boundary.calls.push(request);
        // The serialized Socket boundary requires a method. An absent protocol
        // constant must not be acknowledged as a fictitious workspace Run read.
        if (typeof request.method !== 'string' || !request.method) throw new Error('Socket RPC method is required');
        if (request.method === RPC_METHODS.CAPABILITIES_DESCRIBE) return { protocolVersion: 1,
            capabilities: [{ id: 'tool.executionRuns', kind: 'tool', protocol: { version: 2, available: true,
                features: { detachedScope: true, startAndWait: true, exactInputResults: true,
                    runScopedAgentBindings: true, secretReferenceOverlay: true } } }], checklists: {} } satisfies CapabilitiesDescribeResponse;
        if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return boundary.capabilities();
        if (request.method === RPC_METHODS.CAPABILITIES_INVOKE && boundary.nativeModelsByAgent) {
            const payload = request.payload as { id: string; method: string };
            if (payload.method === 'probeModels') return { ok: true, result: {
                availableModels: boundary.nativeModelsByAgent[payload.id.slice('cli.'.length)] ?? [],
                supportsFreeform: false, source: 'dynamic', observedAt: Date.now(),
            } };
        }
        if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET && boundary.runResponse) {
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
            const input = ScmDiffSummaryResultReadInputSchema.parse(request.payload);
            if (input.cwd !== boundary.savedResult.output.comparison?.repository.rootPath || input.resultId !== boundary.savedResult.resultId) {
                return { success: false, errorCode: 'result_not_found', error: 'Saved result is unavailable in this repository/session.' };
            }
            return { success: true, result: boundary.savedResult };
        }
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE && boundary.savedResult) {
            const input = ScmComparisonCaptureInputSchema.parse(request.payload);
            const { comparison, metadata } = boundary.savedResult.output;
            return ScmComparisonCaptureOutputSchema.parse(comparison && input.comparisonId === comparison.id
                ? { success: true, comparison, metadata }
                : { success: false, errorCode: 'DIFF_UNAVAILABLE', error: 'The captured comparison is unavailable' });
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
            if (boundary.generate) return boundary.generate(input);
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
    boundary.runRequest = rpc;
    return createServerScopedMachineRpcBoundaryMock((async request => {
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE || request.method === RPC_METHODS.SCM_DIFF_SUMMARY_DISCUSS) {
            throw new Error('Run-producing SCM Actions require requester-carrying Home HTTP');
        }
        return rpc(request);
    }) as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope);
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async (importOriginal) => {
    const { createServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    // Method-specific wire fixtures at the external Session transport boundary.
    const rpc = async <R,>(request: { sessionId: string; method: string; payload: unknown; scope?: { serverId: string; accountId: string } }): Promise<R> => {
        boundary.sessionCalls.push(request);
        if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return { runs: [] } as R;
        if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET && boundary.runResponse) {
            await boundary.nativeRunBarrier?.();
            return boundary.runResponse as R;
        }
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_UNDO && boundary.savedResult) return { success: true, result: boundary.savedResult } as R;
        throw new Error(`Unexpected Session boundary method: ${request.method}`);
    };
    return createServerScopedSessionRpcModuleMock({ importOriginal, overrides: {
        sessionRpcWithServerScope: rpc,
        sessionRpcWithServerAccountScope: rpc,
    } });
});

const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { renderHook } = await import('@/dev/testkit');
const { standardCleanup } = await import('@/dev/testkit/cleanup/standardCleanup');
const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
async function pushSavedResult(serverId: string, machineId: string) {
    const saved = boundary.savedResult!;
    const { handleEphemeralSocketUpdate } = await import('@/sync/engine/socket/socket');
    await handleEphemeralSocketUpdate({ sourceServerId: serverId,
        update: { type: 'scm-diff-summary-result-updated', machineId, resultId: saved.resultId, revision: saved.revision },
        addActivityUpdate: () => {}, addMachineActivityUpdate: () => {},
        getSessionEncryption: () => null, getSession: () => undefined, applyMessages: () => {} });
}
const { ScmComparisonMoreMenu } = await import('@/components/sessions/files/comparison/ScmComparisonMoreMenu');
type MenuSections = Parameters<typeof ScmComparisonMoreMenu>[0]['sections'];
/** The bar as the review destination draws it: the view's own actions, then its menu rows behind `⋯`. */
const barWithMenu = (actions: React.ReactNode, sections?: MenuSections, review?: React.ReactNode) => <>{actions}{review}{sections ? <ScmComparisonMoreMenu sections={sections} /> : null}</>;
/** Chooses a saved-result operation from the bar's menu, the way a person does. */
async function chooseFromMenu(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    const { menu, row } = await vi.waitFor(() => {
        const menu = screen.root.find((node) => node.type === DropdownMenu && node.props.testID === 'scm-comparison-more-menu');
        const row = (menu.props.items as Array<{ id: string; testID?: string; disabled?: boolean }>).find((item) => item.testID === testID);
        if (!row) throw new Error(`${testID} is not offered`);
        expect(row.disabled, `${testID} is disabled`).not.toBe(true);
        return { menu, row };
    });
    await act(async () => { await menu.props.onSelect(row.id); });
}
const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
const { readMachineActivity } = await import('@/sync/domains/machines/machineActivity');
const { getStorage } = await import('@/sync/domains/state/storage');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { getScmDiffSummaryState, getScmDiffSummaryOperationState } = await import('@/sync/ops/scmDiffSummary/generate');
const { getMachineCapabilitiesCacheState } = await import('@/hooks/server/useMachineCapabilitiesCache');
const { getAgentCore, getAgentStaticModels } = await import('@happier-dev/agents');
const { buildScmDiffSummaryModelProfiles } = await import('@/settings/scmDiffSummary/models');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { LlmTaskRunnerPicker } = await import('@/components/settings/llmTasks/LlmTaskRunnerPicker');
const { notifyExecutionRunActivity } = await import('@/sync/runtime/executionRuns/executionRunActivityBus');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
const { createScmDiffSummaryModelCatalogHttpBoundary } = await import('@/dev/testkit/harness/scmDiffSummaryModelCatalogBoundary');
const { createScmRunActionHttpBoundary } = await import('@/dev/testkit/harness/scmActionTransport');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
const { createAccountKvHttpFixture } = await import('@/dev/testkit/fixtures/accountKvHttpFixture');
const { formatWithCachedDateTimeFormatter } = await import('@/utils/datetime/cachedIntlFormatters');
const { getPreferredLanguage, t } = await import('@/text');
await loadSyncSingletonForTests();
const { SessionWalkthroughView } = await import('./SessionWalkthroughView');
const { SessionCapturedScmReviewDetailsView } = await import('@/components/sessions/files/views/SessionCapturedScmReviewDetailsView');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { SESSION_DETAILS_SCM_REVIEW_TAB_KEY } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
const { ScmWalkthroughView } = await import('./ScmWalkthroughView');
const { WalkthroughStopSection } = await import('./WalkthroughStopSection');
const { getSessionComposerDraftSnapshot, getSessionDraftSnapshot, writeExistingSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { useWorkspaceScmDiffSummaryBinding } = await import('@/components/projects/scm/useWorkspaceScmDiffSummaryBinding');
const { useScmDiffSummaryBinding } = await import('../comparison/useScmDiffSummaryBinding');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
const { useReviewComposerHandoff } = await import('@/components/sessions/reviews/comments/useReviewComposerHandoff');
const { PhoneAskSheetProvider } = await import('@/components/sessions/composer/phoneAsk/phoneAskSheetState');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { useSessionRecipientState } = await import('@/components/sessions/agentInput/routing/useSessionRecipientState');
const { useSessionAgentInputRoutingControls } = await import('@/components/sessions/agentInput/routing/useSessionAgentInputRoutingControls');
const initialStorage = getStorage().getState();
const initialAppliedHome = getAppliedActiveServerSnapshot();
const initialRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
let accountCredentials: import('@/auth/storage/tokenStorage').AuthCredentials;
let restoreObservationClock: (() => void) | null = null;
let servedHome: Awaited<ReturnType<typeof serveActionHomes>> | null = null;
let catalogMachine: Awaited<ReturnType<typeof createScmDiffSummaryModelCatalogHttpBoundary>>['machine'] | null = null;

function publishMachines(home: Readonly<{ id: string }>, machines: Array<ReturnType<typeof createMachineFixture>>,
    accountId = 'walkthrough-account') {
    const remote = catalogMachine;
    const published = remote ? machines.find(machine => machine.id === remote.id) : undefined;
    if (remote && published) {
        // HTTP hydration and pushed inventory describe the same external Home presence fact.
        remote.active = published.active;
        remote.activeAt = published.activeAt;
        if (published.presenceProtocolVersion === 1) remote.presenceProtocolVersion = 1;
        else delete remote.presenceProtocolVersion;
    }
    // Raw inventory writes bypass the separate Machine presence/activity projections.
    const scope = { serverId: home.id, accountId };
    const store = getStorage().getState();
    store.applyMachines(machines, true, { sourceServerId: home.id, sourceAccountId: accountId });
    store.markMachineListSettled(home.id);
    observeMachinePresenceForTest(scope, machines.map(machine => machine.id));
}

afterEach(async () => {
    standardCleanup();
    restoreObservationClock?.();
    restoreObservationClock = null;
    // Retire the real Account/Sync lifetime before clearing its transport answers.
    await servedHome?.dispose();
    servedHome = null;
    resetRuntimeFetch();
    publishAppliedActiveServerRuntimeAvailability(false);
    getStorage().setState(initialStorage, true);
    publishAppliedActiveServerSnapshot(initialAppliedHome, initialRuntimeAvailable);
    boundary.calls = [];
    boundary.capabilities = async () => ({ protocolVersion: 1, results: {} });
    boundary.savedResult = null;
    boundary.savedSessionId = '';
    boundary.listBarrier = null;
    boundary.runResponse = null;
    boundary.nativeRunBarrier = null;
    boundary.sessionCalls = [];
    boundary.accountRoute = null;
    boundary.generate = null;
    boundary.catalog = null;
    catalogMachine = null;
    boundary.discoveredModels = [];
    boundary.nativeModelsByAgent = null;
    boundary.modelCatalogReads = 0;
    boundary.sessionMetadata = {};
    boundary.router?.spies.push.mockClear();
});

async function createHome(serverUrl: string, settings?: Readonly<Record<string, unknown>>, catalogMachineId?: string,
    automaticTarget?: Parameters<typeof createScmDiffSummaryModelCatalogHttpBoundary>[0]['automaticTarget']) {
    installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
    const serverIdentityId = `srv_${new URL(serverUrl).hostname.split('.')[0]!.replaceAll('-', '_')}`;
    if (catalogMachineId) {
        // Offered Summary models come only from the executing Machine's catalog; the first Agent is its automatic default.
        const { getAgentCore, getAgentStaticModels } = await import('@happier-dev/agents');
        const catalog = await createScmDiffSummaryModelCatalogHttpBoundary({ serverUrl, serverIdentityId,
            accountId: 'walkthrough-account', machineId: catalogMachineId, automaticTarget,
            targets: (['codex', 'claude'] as const).map(agentId => ({ backendTarget: { kind: 'backend' as const, backendId: agentId },
                // The Machine's catalog owns cost tiers; its first model is the low-cost automatic default.
                models: (boundary.nativeModelsByAgent?.[agentId] ?? getAgentStaticModels(agentId)).map((model, index) => index === 0 ? { ...model, costTier: 'low' as const } : model),
                ...(agentId === 'codex' ? { discoveredModels: boundary.discoveredModels } : {}),
                catalogModels: getAgentStaticModels(agentId, { catalogOnly: true }),
                agentFormats: getAgentCore(agentId)?.structuredOutput?.formats })) });
        boundary.catalog = catalog.handle;
        catalogMachine = catalog.machine;
    }
    const runActions = catalogMachineId ? await createScmRunActionHttpBoundary({ serverUrl, serverIdentityId,
        accountId: 'walkthrough-account', machineId: catalogMachineId,
        actionIds: ['scm.diffSummary.generate', 'scm.diffSummary.discuss'],
        execute(actionId, input) {
            const method = getActionSpec(actionId).bindings?.rpcMethod;
            if (!method || !boundary.runRequest) throw new Error('Missing SCM Run response fixture');
            return boundary.runRequest({ machineId: catalogMachineId, method, payload: input,
                serverId: serverIdentityId, accountId: 'walkthrough-account' });
        } }) : null;
    servedHome = await serveActionHomes({
        homes: [{ key: 'home', serverUrl, serverIdentityId, accountId: 'walkthrough-account', currentAccount: true, settings }],
        async route(request) {
            if (request.path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({
                features: { execution: { runs: { enabled: true } }, encryption: { plaintextStorage: { enabled: true }, accountOptOut: { enabled: true } } },
                capabilities: {},
            }));
            if (request.path === '/v1/actions/agents.models.list') boundary.modelCatalogReads++;
            const catalog = await boundary.catalog?.(request.url, { method: request.method,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
            return catalog ?? await runActions?.handle(request.url, { method: request.method,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) })
                ?? await boundary.accountRoute?.(request);
        },
    });
    const home = servedHome.homes.home!;
    const credentials = await TokenStorage.getCredentialsForServerUrl(home.serverUrl);
    if (!credentials) throw new Error('The fixture Home did not publish its credentials');
    accountCredentials = credentials;
    return home;
}

function runnerOfProfile(profile: { modelSelector?: { backendTargetKey?: string; modelId?: string } }): LlmTaskRunnerConfigV1 {
    return { v: 1, modelSelection: { agentTargetKey: profile.modelSelector!.backendTargetKey!, providerConnectionId: null, modelId: profile.modelSelector!.modelId! } };
}

async function mount(comparison: SessionScmReviewComparison, sessionId: string, storedRunner: LlmTaskRunnerChoiceV1 | null = null, renderBar: (actions: React.ReactNode, sections?: MenuSections) => React.ReactNode = barWithMenu, authenticated = true,
    automaticTarget?: Parameters<typeof createScmDiffSummaryModelCatalogHttpBoundary>[0]['automaticTarget'],
    renderDestination?: (props: React.ComponentProps<typeof SessionWalkthroughView>) => React.ReactElement) {
    const settings = { ...initialStorage.settings, experiments: true, featureToggles: { 'execution.runs': true },
        'scm.diffSummary.runnerV1': storedRunner };
    const home = await createHome(`https://${sessionId}.example.test`, settings, `machine:${sessionId}`, automaticTarget);
    // These current Home sessions publish authoritative presence; the legacy grace case below has its own fixture.
    const machine = createMachineFixture({ id: `machine:${sessionId}`, activeAt: Date.now(), storageMode: 'plain', presenceProtocolVersion: 1 });
    const session = createSessionFixture({ id: sessionId, serverId: home.id, active: true,
        metadata: { path: '/repo/exact', host: 'tester.local', machineId: machine.id, flavor: 'codex', ...boundary.sessionMetadata } });
    getStorage().setState({ sessions: { [sessionId]: session },
        ...(authenticated ? { profileScope: { serverId: home.id, accountId: 'walkthrough-account' } } : {}),
        settings });
    publishMachines(home, [machine]);
    getStorage().getState().applySessions([session]);
    if (authenticated) publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const viewProps = { sessionId, serverId: home.id, comparison, scopeLabel: 'Shown comparison', layout: 'wide' as const, renderBar,
        onShowFiles: () => {}, onOpenFile: () => {}, onOpenComposer: () => {} };
    const screen = await renderScreen(renderDestination
        ? <AppPaneProvider>{renderDestination(viewProps)}</AppPaneProvider> : <SessionWalkthroughView {...viewProps} />, authenticated ? {
        wrapper: ({ children }) => <InjectedAuthProvider credentials={accountCredentials}>{children}</InjectedAuthProvider>,
    } : undefined);
    return { screen, home, machine };
}

function generationCalls() {
    return boundary.calls.filter((call) => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE);
}

async function mountWithAccountMarks(sessionId: string, suggestedQuestions?: string[],
    renderDestination?: Parameters<typeof mount>[6]) {
    const before = 'a'.repeat(40);
    const after = 'b'.repeat(40);
    const comparison = { id: buildScmComparisonIdentity({ source: { kind: 'workingTree' }, repositoryRootPath: '/repo/exact',
        beforeOid: before, afterOid: after }), source: { kind: 'workingTree' }, repository: { rootPath: '/repo/exact' }, endpoints: { before, after },
        inventory: { state: 'complete', reasons: [], files: [{ path: 'a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
            evidence: { state: 'available', unifiedDiff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+retained-code\n' },
            occurrences: [{ id: 'captured-change', alias: 'c1', path: 'a.ts', position: 0,
                before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
        }] } };
    boundary.savedSessionId = sessionId;
    boundary.savedResult = ScmDiffSummaryResultSchema.parse({ resultId: `result:${sessionId}`, revision: 1, canUndo: false,
        output: { success: true, resultId: `result:${sessionId}`, revision: 1, sourceKey: comparison.id,
            ...(suggestedQuestions ? { runId: 'question-generator' } : {}),
            metadata: { sourceKey: comparison.id, source: comparison.source }, requestedOutputs: ['walkthrough'], comparison,
            outputs: { walkthrough: { state: 'complete', value: { title: 'Retained reading', intro: '',
                stops: [{ id: 'retained', title: 'Retained stop', importance: 'high', explanationMarkdown: 'The saved code remains readable.', changeRefs: ['captured-change'],
                    ...(suggestedQuestions ? { suggestedQuestions } : {}) }], otherChangeRefs: [] } } },
            analysis: { suppliedChangeRefs: ['captured-change'], analysedChangeRefs: ['captured-change'], remainingChangeRefs: [] },
        } });
    const comparisonRecord = boundary.savedResult.output.comparison!;
    const key = buildScmReviewedMarksKey(buildScmReviewScopeId({ repositoryRootPath: comparisonRecord.repository.rootPath,
        source: comparisonRecord.source }));
    const stored = encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: applyScmReviewedMarkIntent(comparisonRecord, null, [], true) });
    const kv = createAccountKvHttpFixture({ rows: new Map([[key, { key, value: stored, version: 1 }]]) });
    // Serve the canonical opaque Account KV wire routes; mode admission, record parsing and CAS stay real.
    boundary.accountRoute = async ({ url, method, body }) => await kv.handleFetch(url, { method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) ?? undefined;
    const reads = () => kv.readRequests().filter(request => request.path === '/v1/kv/bulk').length;
    const writes = () => kv.readRequests().filter(request => request.path === '/v1/kv' && request.method === 'POST').length;
    const mounted = await mount({ kind: 'workingTree' }, sessionId, null, undefined, true, undefined, renderDestination);
    await vi.waitFor(() => expect(mounted.screen.getTextContent()).toContain('Retained stop'));
    await vi.waitFor(() => {
        const button = mounted.screen.findByTestId('walkthrough-mark-retained');
        expect(button).toBeTruthy();
        expect(button?.props.disabled).not.toBe(true);
        expect(reads()).toBeGreaterThan(0);
    });
    const entry = Object.values(getScmDiffSummaryState().entriesByKey).find(value => value.sessionId === sessionId)!;
    expect(entry.observedAtMs).toBeGreaterThan(0);
    const offline = async () => {
        const current = getStorage().getState().machines[mounted.machine.id] ?? mounted.machine;
        const activeAt = readMachineActivity(current).activeAt ?? Date.now();
        const machine = { ...current, active: false, activeAt };
        await act(async () => publishMachines(mounted.home, [machine]));
    };
    return { ...mounted, offline, writes, observedAtMs: entry.observedAtMs };
}

describe('SessionWalkthroughView retained offline reading through real Account marks', () => {
    it('offers the chosen review Agent models, keeps Default first and follows engine changes without Account substitution', async () => {
        const { useReviewExecutionRunLaunchOptions } = await import('@/components/sessions/runs/launcher/useReviewExecutionRunLaunchOptions');
        const { useExecutionRunLaunchContext } = await import('@/components/sessions/runs/launcher/useExecutionRunLaunchContext');
        const { useExecutionRunLauncherOptionsModel } = await import('@/components/sessions/runs/launcher/useExecutionRunLauncherOptionsModel');
        const { useMachineCapabilitiesCache } = await import('@/hooks/server/useMachineCapabilitiesCache');
        const { extractExecutionRunsBackendsFromMachineCapabilitiesState } = await import('@/sync/domains/executionRuns/extractExecutionRunsBackendsFromMachineCapabilities');
        const { SessionModelPicker } = await import('@/components/sessions/modelPicker/SessionModelPicker');
        const { ACP_CATALOG_ROWS_ROUTE_V1 } = await import('@happier-dev/protocol/acp/catalog/catalogRowsV1');
        let options!: ReturnType<typeof useReviewExecutionRunLaunchOptions>;
        let launcher!: ReturnType<typeof useExecutionRunLaunchContext>;
        let input!: Record<string, unknown>;
        let chooseEngine!: (engine: string) => void;
        function ReviewOptions(props: React.ComponentProps<typeof SessionWalkthroughView>) {
            const [actionInput, setActionInput] = React.useState<Record<string, unknown>>({ reviewers: [{ kind: 'engine', engineId: 'codex' }] });
            input = actionInput;
            chooseEngine = engine => setActionInput(previous => ({ ...previous, reviewers: [{ kind: 'engine', engineId: engine }] }));
            launcher = useExecutionRunLaunchContext(props.sessionId, props.serverId ?? null);
            const { state } = useMachineCapabilitiesCache({ machineId: launcher.machineId, enabled: Boolean(launcher.machineId),
                ...(props.serverId ? { serverId: props.serverId } : {}), request: { requests: [{ id: 'tool.executionRuns' }] } });
            const choices = useExecutionRunLauncherOptionsModel({ sessionId: props.sessionId, intent: 'review', actionInput, setActionInput,
                enabledAgentIds: launcher.enabledAgentIds, executionRunsBackends: extractExecutionRunsBackendsFromMachineCapabilitiesState(state),
                acpCatalogSnapshot: launcher.acpCatalogSnapshot, initialBackendTarget: null, fallbackAgentId: null, machineCapabilitiesState: state });
            options = useReviewExecutionRunLaunchOptions({ launcher, sessionId: props.sessionId, serverId: props.serverId ?? null,
                backendChoices: choices.backendChoices, selectedBackendChoice: choices.selectedBackendChoice,
                actionInput, setActionInput, busy: false });
            return <>{options.modelChoice}</>;
        }
        boundary.capabilities = async () => ({ protocolVersion: 1, results: {
            'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { backends: {
                codex: { available: true, intents: ['review'] }, claude: { available: true, intents: ['review'] },
            } } },
        } });
        boundary.accountRoute = async ({ path }) => path === ACP_CATALOG_ROWS_ROUTE_V1
            ? Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } } }) : undefined;
        boundary.nativeModelsByAgent = { codex: [{ id: 'served-codex', name: 'Served Codex model' }],
            claude: [{ id: 'served-claude', name: 'Served Claude model' }] };
        const inheritedModelId = 'served-codex';
        boundary.sessionMetadata = { sessionAppliedModelV1: { v: 1, provider: 'codex', modelId: inheritedModelId, updatedAt: 1 } };
        const { screen } = await mount({ kind: 'workingTree' }, 'review-model-options', null, undefined, true, undefined,
            props => <ReviewOptions {...props} />);
        const settings = getStorage().getState().settings;
        const picker = () => screen.tree.findByType(SessionModelPicker);
        await vi.waitFor(() => expect(launcher.acpCatalogReady).toBe(true));
        for (const agentId of ['codex', 'claude'] as const) {
            await act(async () => chooseEngine(agentId));
            await vi.waitFor(() => expect(screen.findAllByType(SessionModelPicker)).toHaveLength(1));
            expect(picker().props.agentTargetKey).toBe(buildBackendTargetKeyV2({ kind: 'backend', backendId: agentId }));
            expect(picker().props.nativeModels[0].value).toBe('default');
            await vi.waitFor(() => {
                const observed = { models: picker().props.nativeModels.map((model: { value: string }) => model.value),
                    probe: picker().props.probe, catalogReads: boundary.modelCatalogReads, machineId: launcher.machineId };
                expect(observed.models, JSON.stringify(observed)).toContain(`served-${agentId}`);
            });
            expect(picker().props.nativeModels.map((model: { value: string }) => model.value)).not.toContain(`served-${agentId === 'codex' ? 'claude' : 'codex'}`);
            expect(input).not.toHaveProperty('modelSelection');
            expect(picker().props.selected).toEqual(agentId === 'codex'
                ? { agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: agentId }), providerConnectionId: null, modelId: inheritedModelId }
                : null);
            const modelId = `served-${agentId}`;
            await act(async () => picker().props.onSelect({ agentTargetKey: picker().props.agentTargetKey, providerConnectionId: null, modelId }));
            expect((input.reviewers as Array<{ modelSelection?: unknown }>)[0]?.modelSelection).toMatchObject({ modelId, agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: agentId }) });
            await act(async () => picker().props.onSelect(null));
            expect(input).not.toHaveProperty('modelSelection');
            expect(input).not.toHaveProperty('childSelection');
            // Leave an exact choice selected: the next engine must retire it rather than run it there.
            await act(async () => picker().props.onSelect({ agentTargetKey: picker().props.agentTargetKey, providerConnectionId: null, modelId }));
        }
        expect(getStorage().getState().settings).toBe(settings);
        expect(generationCalls()).toEqual([]);
    });

    it('keeps an unsaved title across a receipt result publication and reports a stale Save without losing the draft', async () => {
        let remount!: () => void;
        function ReceiptEditor(props: React.ComponentProps<typeof SessionWalkthroughView>) {
            const [mountId, setMountId] = React.useState(0);
            remount = () => setMountId(id => id + 1);
            const captured = boundary.savedResult!.output.comparison!;
            const selector = { kind: 'workingTree' as const, comparisonId: captured.id,
                savedResult: { cwd: captured.repository.rootPath, resultId: boundary.savedResult!.resultId } };
            return <SessionCapturedScmReviewDetailsView key={mountId} sessionId={props.sessionId} serverId={props.serverId}
                scopeId={`session:${props.sessionId}`} comparison={selector} target={{ comparison: selector, view: 'walkthrough' }} />;
        }
        const { screen, home, machine } = await mountWithAccountMarks('receipt-title-draft', undefined, props => <ReceiptEditor {...props} />);
        await chooseFromMenu(screen, 'walkthrough-saved-edit');
        await act(async () => screen.changeTextByTestId('walkthrough-saved-title', 'My unsaved title'));
        const original = boundary.savedResult!;
        const walkthrough = original.output.outputs!.walkthrough!;
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ ...original, revision: 2,
            output: { ...original.output, revision: 2, outputs: { ...original.output.outputs,
                walkthrough: { ...walkthrough, value: { ...walkthrough.value!, stops: walkthrough.value!.stops.map(stop => ({
                    ...stop, explanationMarkdown: 'Published concurrently by a targeted refinement.',
                })) } } } } });
        await act(async () => { await pushSavedResult(home.id, machine.id); });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Published concurrently by a targeted refinement.'));
        // The reported loading transition retired the reading while its retained Details pane survived.
        // Recreate that presentation lifetime without retiring the pane or the Account/result owner.
        await act(async () => remount());
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Published concurrently by a targeted refinement.'));
        expect(screen.findByTestId('walkthrough-saved-title')?.props.value).toBe('My unsaved title');
        await screen.pressByTestIdAsync('walkthrough-saved-title-save');
        expect(screen.findByTestId('walkthrough-saved-title')?.props.value).toBe('My unsaved title');
        expect(screen.findByTestId('walkthrough-saved-error')).toBeTruthy();
        expect(boundary.calls.filter(call => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_EDIT)).toEqual([
            expect.objectContaining({ payload: { cwd: '/repo/exact', resultId: original.resultId, expectedRevision: 1,
                edit: { kind: 'renameWalkthrough', title: 'My unsaved title' } } }),
        ]);
        expect(boundary.savedResult.revision).toBe(2);
        expect(boundary.savedResult.output.outputs?.walkthrough?.value?.title).toBe(original.output.outputs?.walkthrough?.value?.title);
    });

    it('keeps an explicit model through responsive remounts without writing Account settings', async () => {
        let resize!: (width: number) => void;
        function ResponsiveDestination(props: React.ComponentProps<typeof SessionWalkthroughView>) {
            const [width, setWidth] = React.useState(1440);
            resize = setWidth;
            return <SessionWalkthroughView {...props} scopeId={`session:${props.sessionId}`}
                key={width < 600 ? 'phone' : 'desktop'} layout={width < 600 ? 'phone' : 'wide'} />;
        }
        const { screen } = await mount({ kind: 'workingTree' }, 'responsive-model-draft', null, undefined, true, undefined,
            props => <ResponsiveDestination {...props} />);
        const { ScmWalkthroughView } = await import('./ScmWalkthroughView');
        const bound = () => screen.tree.findByType(ScmWalkthroughView).props.bound as React.ComponentProps<typeof ScmWalkthroughView>['bound'];
        await vi.waitFor(() => expect(bound().restoreState).toBe('ready'));
        const settings = getStorage().getState().settings;
        const explicit = { v: 1, modelSelection: { agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
            providerConnectionId: null, modelId: 'gpt-6-luna' } } satisfies LlmTaskRunnerConfigV1;
        await act(async () => bound().setModel(explicit));
        expect(bound().model).toEqual(explicit);
        for (const width of [390, 1440]) {
            await act(async () => resize(width));
            expect(bound().model).toEqual(explicit);
        }
        // Auto is also an explicit per-run choice, rather than absence of a draft.
        await act(async () => bound().setModel({ v: 1, mode: 'auto' }));
        await act(async () => resize(390));
        expect(bound().model).toEqual({ v: 1, mode: 'auto' });
        expect(getStorage().getState().settings).toBe(settings);
        expect(generationCalls()).toEqual([]);
    });

    it.each(['walkthrough', 'commitPlan', 'summary'] as const)('retries saved %s with its offered producer model through the shared selection owner', async output => {
        boundary.discoveredModels = [{ id: 'gpt-6-luna', name: 'GPT-6-Luna', capabilities: { structuredOutput: 'supported' } }];
        const comparison = { id: `retry-${output}`, source: { kind: 'workingTree' }, repository: { rootPath: '/repo/exact' },
            endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } };
        boundary.savedSessionId = `retry-producer-${output}`;
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ resultId: `retry-result-${output}`, revision: 1, canUndo: false,
            generator: { backendTarget: { kind: 'backend', backendId: 'codex' }, modelId: 'gpt-6-luna',
                connectedServices: { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: 'codex-pool' } } } },
            output: { success: true, resultId: `retry-result-${output}`, revision: 1, sourceKey: comparison.id, comparison,
                producer: { kind: 'generation', modelId: 'gpt-6-luna' },
                metadata: { sourceKey: comparison.id, source: comparison.source }, requestedOutputs: [output],
                outputs: { [output]: { state: 'failed' } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } });
        boundary.generate = () => ScmDiffSummaryGenerateOutputSchema.parse({ success: false, errorCode: 'SUMMARY_FAILED', error: 'Fixture ending' });
        const { home, machine } = await mount({ kind: 'workingTree' }, boundary.savedSessionId);
        const hook = await renderHook(() => useScmDiffSummaryBinding({ host: { sessionId: boundary.savedSessionId }, serverId: home.id,
            machine: { machineId: machine.id, basePath: '/repo/exact' }, machineReachable: true, canControl: true, canSend: true,
            launch: { canLaunchExecutionRuns: true }, comparison: { kind: 'workingTree' }, output }), {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={accountCredentials}>{children}</InjectedAuthProvider>,
        });
        await vi.waitFor(() => expect(hook.getCurrent().viewModel?.resultId).toBe(boundary.savedResult!.resultId));
        await act(async () => { await hook.getCurrent().onStart(); });
        expect(generationCalls()).toHaveLength(1);
        expect(ScmDiffSummaryGenerateInputSchema.parse(generationCalls()[0]!.payload)).toMatchObject({
            outputs: [output], modelSelector: { backendTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }), modelId: 'gpt-6-luna',
                connectedServices: boundary.savedResult!.generator!.connectedServices },
            cachePolicy: { mode: 'bypass' },
        });
        if (output === 'summary') {
            // Tapping Auto replaces the saved producer and sends no model: the executing machine resolves Auto.
            await act(async () => hook.getCurrent().setModel({ v: 1, mode: 'auto' }));
            await act(async () => { await hook.getCurrent().onStart(); });
            expect(generationCalls()).toHaveLength(2);
            expect(ScmDiffSummaryGenerateInputSchema.parse(generationCalls()[1]!.payload)).not.toHaveProperty('modelSelector');
        }
    }, 120_000);

    it('retries a saved reading with its exact Team model ref and Account default authentication', async () => {
        const fixtureId = 'retry-team-default';
        const modelSelection = SessionModelRefSchema.parse({ source: 'team_resource', teamId: 'summary-team',
            resourceId: 'summary-resource', expectedResourceRevision: 7, deliveryMode: 'brokered',
            agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }), modelId: 'gpt-6-luna' });
        const comparison = { id: fixtureId, source: { kind: 'workingTree' }, repository: { rootPath: '/repo/exact' },
            endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } };
        boundary.savedSessionId = `${fixtureId}-producer`;
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ resultId: `${fixtureId}-result`, revision: 1, canUndo: false,
            generator: { backendTarget: { kind: 'backend', backendId: 'codex' }, modelId: modelSelection.modelId,
                modelSelection },
            output: { success: true, resultId: `${fixtureId}-result`, revision: 1, sourceKey: comparison.id, comparison,
                producer: { kind: 'generation', modelId: modelSelection.modelId },
                metadata: { sourceKey: comparison.id, source: comparison.source }, requestedOutputs: ['walkthrough'],
                outputs: { walkthrough: { state: 'failed' } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } });
        boundary.generate = () => ScmDiffSummaryGenerateOutputSchema.parse({ success: false, errorCode: 'SUMMARY_FAILED', error: 'Fixture ending' });
        const { home, machine } = await mount({ kind: 'workingTree' }, boundary.savedSessionId);
        const hook = await renderHook(() => useScmDiffSummaryBinding({ host: { sessionId: boundary.savedSessionId }, serverId: home.id,
            machine: { machineId: machine.id, basePath: '/repo/exact' }, machineReachable: true, canControl: true, canSend: true,
            launch: { canLaunchExecutionRuns: true }, comparison: { kind: 'workingTree' }, output: 'walkthrough' }), {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={accountCredentials}>{children}</InjectedAuthProvider>,
        });
        await vi.waitFor(() => expect(hook.getCurrent().viewModel?.resultId).toBe(boundary.savedResult!.resultId));
        expect(hook.getCurrent().model).toEqual({ v: 1, modelSelection });
        await act(async () => { await hook.getCurrent().onStart(); });
        expect(generationCalls()).toHaveLength(1);
        expect(ScmDiffSummaryGenerateInputSchema.parse(generationCalls()[0]!.payload)).toMatchObject({
            modelSelector: { modelSelection },
            cachePolicy: { mode: 'bypass' },
        });
    }, 120_000);

    it('names a cold-loaded reading from the Session model list while the picker catalog cannot', async () => {
        boundary.sessionMetadata = { sessionModelsV1: { v: 1, agentId: 'codex', updatedAt: 1, currentModelId: 'gpt-6-luna',
            availableModels: [{ id: 'gpt-6-luna', name: 'GPT-6-Luna' }] } };
        const comparison = { id: 'cold-label-comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/repo/exact' },
            endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } };
        boundary.savedSessionId = 'producer-session-label';
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ resultId: 'cold-label-result', revision: 1, canUndo: false,
            generator: { backendTarget: { kind: 'backend', backendId: 'codex' } },
            output: { success: true, resultId: 'cold-label-result', revision: 1, sourceKey: comparison.id, comparison,
                producer: { kind: 'generation', modelId: 'gpt-6-luna' },
                metadata: { sourceKey: comparison.id, source: comparison.source }, requestedOutputs: ['walkthrough'],
                outputs: { walkthrough: { state: 'complete', value: { title: 'Cold reading', intro: '', stops: [], otherChangeRefs: [] } } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } });
        const { screen } = await mount({ kind: 'workingTree' }, boundary.savedSessionId);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Cold reading'));
        expect(screen.getTextContent()).toContain('GPT-6-Luna');
        expect(screen.getTextContent()).not.toContain('gpt-6-luna');
    });
    it.each([true, false])('opens a cold receipt destination with one exact saved read outside the carrier Session directory (explicit Home: %s)', async explicitHome => {
        const fixtureId = explicitHome ? 'explicit-home' : 'bare-session';
        const resultId = `receipt-result-${fixtureId}`;
        const comparison = { id: `receipt-captured-${fixtureId}`, source: { kind: 'workingTree' as const }, repository: { rootPath: '/repo/generated' },
            endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } };
        boundary.savedSessionId = `cold-receipt-${fixtureId}`;
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ resultId, revision: 4, canUndo: false,
            output: { success: true, resultId, revision: 4, sourceKey: comparison.id, comparison,
                metadata: { sourceKey: comparison.id, source: comparison.source }, requestedOutputs: ['walkthrough'],
                outputs: { walkthrough: { state: 'complete', value: { title: 'Finished receipt reading', intro: '', stops: [], otherChangeRefs: [] } } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } });
        const selector = { kind: 'workingTree' as const, comparisonId: comparison.id,
            savedResult: { cwd: comparison.repository.rootPath, resultId: boundary.savedResult.resultId } };
        const { screen, home, machine } = await mount(selector, boundary.savedSessionId, null, undefined, true, undefined, props =>
            <SessionCapturedScmReviewDetailsView sessionId={props.sessionId} serverId={explicitHome ? props.serverId : undefined}
                scopeId={`session:${props.sessionId}`} comparison={selector} target={{ comparison: selector, view: 'walkthrough' }} />);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Finished receipt reading'));
        expect(boundary.calls.filter(call => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST)).toEqual([]);
        expect(boundary.calls.filter(call => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ)).toEqual([
            expect.objectContaining({ payload: expect.objectContaining(selector.savedResult), machineId: machine.id,
                authorization: { kind: 'session.write', sessionId: boundary.savedSessionId } }),
        ]);
        expect(boundary.calls.filter(call => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE)).toEqual([]);
        expect(generationCalls()).toEqual([]);
        const original = boundary.savedResult;
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ ...original, revision: 5,
            output: { ...original.output, revision: 5, outputs: { walkthrough: { state: 'complete', value: {
                ...original.output.outputs!.walkthrough!.value!, title: 'Reading updated by exact push',
            } } } } });
        await act(async () => { await pushSavedResult(home.id, machine.id); });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Reading updated by exact push'));
        expect(boundary.calls.filter(call => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ)).toHaveLength(2);
        expect(boundary.calls.filter(call => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST)).toEqual([]);
    });
    it.each(['phone', 'wide'] as const)('opens a captured receipt reading file through Details placement on %s with its exact comparison', async (layout) => {
        const { PaneRegionProvider } = await import('@/components/appShell/panes/paneRegion');
        const { PanePresentationProvider } = await import('@/components/appShell/panes/panePresentation');
        const { buildSessionDetailsTabHref, parseSessionPaneUrlState } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
        const presented: import('@/components/appShell/panes/panePresentation').PanePresentationIntent[] = [];
        let pane: ReturnType<typeof useAppPaneScope> | undefined;
        const sessionId = `receipt-file-${layout}`;
        function ReceiptDestination(props: React.ComponentProps<typeof SessionWalkthroughView>) {
            pane = useAppPaneScope(`session:${sessionId}`);
            const captured = boundary.savedResult!.output.comparison!;
            const selector = { kind: 'workingTree' as const, comparisonId: captured.id,
                savedResult: { cwd: captured.repository.rootPath, resultId: boundary.savedResult!.resultId } };
            return <SessionCapturedScmReviewDetailsView sessionId={props.sessionId} serverId={props.serverId}
                scopeId={`session:${sessionId}`} comparison={selector} target={{ comparison: selector, view: 'walkthrough' }} />;
        }
        const { screen, home } = await mountWithAccountMarks(sessionId, undefined, props =>
            <PanePresentationProvider value={intent => {
                presented.push(intent);
                return layout === 'phone' && intent.pane === 'details' && intent.fromDetails ? 'ownTab' : undefined;
            }}>
                <PaneRegionProvider region="details"><ReceiptDestination {...props} /></PaneRegionProvider>
            </PanePresentationProvider>);
        const comparison = boundary.savedResult!.output.comparison!;
        const selector = { kind: 'workingTree' as const, comparisonId: comparison.id,
            savedResult: { cwd: comparison.repository.rootPath, resultId: boundary.savedResult!.resultId } };
        await screen.pressByTestIdAsync('walkthrough-open-a.ts');
        const openedFile = () => layout === 'phone' ? presented.flatMap(intent => intent.pane === 'details' && intent.fromDetails ? [intent.tab] : [])[0]
            : pane?.scopeState?.details.tabs.find(tab => tab.key === 'file:a.ts');
        await vi.waitFor(() => expect(openedFile()).toMatchObject({ key: 'file:a.ts', kind: 'file', resource: { path: 'a.ts', changes: selector, fileView: 'changes' } }));
        const file = openedFile();
        if (layout === 'phone') expect(pane?.scopeState?.details.tabs ?? []).toEqual([]);
        else expect(pane?.scopeState?.details.tabState['file:a.ts']).toMatchObject({ view: { changesScope: { kind: 'workingTree' } } });
        expect(screen.getTextContent()).toContain('Retained reading');
        const href = buildSessionDetailsTabHref({ sessionId, serverId: home.id, tab: file! });
        const params = Object.fromEntries(new URL(href!, 'https://happier.invalid').searchParams);
        expect(parseSessionPaneUrlState(params)?.details).toMatchObject({ kind: 'file', path: 'a.ts', changes: selector, view: 'changes' });
        expect(generationCalls()).toEqual([]);
    });
    it('names disabled execution runs when an online workspace cannot start a walkthrough', async () => {
        const settings = { ...initialStorage.settings, experiments: true, featureToggles: { 'execution.runs': false } };
        const home = await createHome('https://workspace-runs-disabled.example.test', settings);
        const machine = createMachineFixture({ id: 'workspace-runs-disabled-machine', activeAt: Date.now(), storageMode: 'plain' });
        getStorage().setState({ sessions: {}, settings,
            profileScope: { serverId: home.id, accountId: 'walkthrough-account' } });
        publishMachines(home, [machine]);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const hook = await renderHook(() => useWorkspaceScmDiffSummaryBinding({ machineId: machine.id, serverId: home.id,
            rootPath: '/workspace/exact', comparison: { kind: 'workingTree' }, output: 'walkthrough' }), {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={accountCredentials}>{children}</InjectedAuthProvider>,
        });
        await vi.waitFor(() => expect(hook.getCurrent().machineReachable).toBe(true));
        expect(hook.getCurrent().launch).toMatchObject({ canLaunchExecutionRuns: false, launchUnavailableReason: 'notEnabled' });
        await act(async () => { await hook.getCurrent().onStart(); });
        expect(generationCalls()).toEqual([]);
        expect(boundary.calls.filter(call => call.method === RPC_METHODS.CAPABILITIES_DETECT)).toEqual([]);
        await hook.unmount();
    });

    it.each([
        { name: 'an empty Ask', initialText: '', suggested: false },
        { name: 'Ask with an existing draft', initialText: 'My pending question', suggested: false },
        { name: 'a suggested question', initialText: 'My pending question', suggested: true },
        // On a phone the reading stays: the Session composer rises in the Ask sheet over it (lab WT3-D1p).
        { name: 'an Ask on a phone', initialText: '', suggested: false, phone: true },
    ])('hands $name from full-page reading to the remounted composer with its exact stop and recipient', async ({ initialText, suggested, phone }) => {
        const phoneAskOpen = vi.fn();
        const phoneAsk = phone ? { phase: 'closed' as const, open: phoneAskOpen, close: () => {}, sent: () => {}, finish: () => {} } : null;
        boundary.runResponse = ExecutionRunGetResponseSchema.parse({ run: {
            runId: 'question-generator', callId: 'question-call', sidechainId: 'question-sidechain', intent: 'scm_diff_summary',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only', retentionPolicy: 'resumable',
            runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 100,
            interaction: { kind: 'retained_agent_session.v1', capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
        } });
        const question = 'Why keep the saved code after refresh?';
        const sessionId = `question-composer-${phone ? 'phone' : suggested ? 'suggested' : initialText ? 'draft' : 'empty'}`;
        const composer: {
            recipient: ReturnType<typeof useSessionRecipientState> | null;
            controls: ReturnType<typeof useSessionAgentInputRoutingControls> | null;
        } = { recipient: null, controls: null };
        let destinationHref = '';
        function Composer(props: React.ComponentProps<typeof SessionWalkthroughView>) {
            const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
            const recipient = useSessionRecipientState({ targets: [], autoRecipient: null, accountLifetime: binding,
                draftPersistence: { sessionId: props.sessionId, surface: 'mainComposer' } });
            composer.recipient = recipient;
            composer.controls = useSessionAgentInputRoutingControls({ isReadOnly: false, participantTargets: [], recipientState: recipient });
            return null;
        }
        function Reading(props: React.ComponentProps<typeof SessionWalkthroughView>) {
            const handoff = useReviewComposerHandoff(createSessionPaneScopeId(props.sessionId, props.serverId, 'reading-destination'));
            return <SessionWalkthroughView {...props} onOpenComposer={handoff} />;
        }
        function Destination(props: React.ComponentProps<typeof SessionWalkthroughView>) {
            const [href, setHref] = React.useState(`/session/${props.sessionId}/details?serverId=${props.serverId}&details=scmReview&view=walkthrough`);
            destinationHref = href;
            const url = new URL(href, 'https://happier.test');
            const reading = url.pathname.endsWith('/details');
            const open = (next: unknown) => {
                if (typeof next !== 'string') throw new Error('Expected a qualified Session route');
                setHref(next);
            };
            return <DestinationInstanceHost tabId="reading-destination" ref={{ kind: reading ? 'sessionDetails' : 'session',
                params: { id: props.sessionId, ...Object.fromEntries(url.searchParams) } }} pathname={url.pathname}
                focused visible navigation={{ push: open, replace: open, back: () => {} }}>
                <PhoneAskSheetProvider value={phoneAsk}>
                    {phoneAsk ? <><Reading {...props} /><Composer {...props} /></> : reading ? <Reading {...props} /> : <Composer {...props} />}
                </PhoneAskSheetProvider>
            </DestinationInstanceHost>;
        }
        const { screen, home } = await mountWithAccountMarks(sessionId, [question], props => <Destination {...props} />);
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-ask-retained')).toBeTruthy());
        const scope = { serverId: home.id, accountId: 'walkthrough-account' };
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        if (initialText) writeExistingSessionDraft({ scope, sessionId, patch: { text: initialText } });
        if (suggested) {
            const section = screen.findByType(WalkthroughStopSection);
            await act(async () => section.props.onAsk(section.props.stop, question));
        } else await screen.pressByTestIdAsync('walkthrough-ask-retained');
        await vi.waitFor(() => {
            expect(new URL(destinationHref, 'https://happier.test').pathname).toBe(phone ? `/session/${sessionId}/details` : `/session/${sessionId}`);
            if (phone) expect(phoneAskOpen).toHaveBeenCalledTimes(1);
            expect(composer.recipient?.recipient).toEqual({ kind: 'execution_run', runId: 'question-generator' });
            expect(composer.recipient?.scmDiffSummaryDiscussion).toEqual({ cwd: '/repo/exact', resultId: `result:${sessionId}`,
                expectedRevision: 1, stopIds: ['retained'] });
            expect(composer.controls?.extraActionChips?.find(chip => chip.controlId === 'recipient')?.collapsedOptionsPopover?.label)
                .toBe('To: Walkthrough');
            // The walkthrough's discussion takes no delivery mode, and its Run, not the Session, names who answers.
            expect(composer.controls?.extraActionChips?.some(chip => chip.controlId === 'delivery')).toBe(false);
            expect(composer.controls?.walkthroughEngine, 'the reading records no model to name').toBeNull();
            // The stop is the question's context above the text, never a suffix on the recipient (lab WT3-D1).
            expect(composer.controls?.attachmentRowItems).toEqual([expect.objectContaining({ kind: 'badge', label: 'Stop 1', detail: 'a.ts L1' })]);
        });
        expect(new URL(destinationHref, 'https://happier.test').searchParams.get('serverId')).toBe(home.id);
        const draft = getSessionComposerDraftSnapshot(scope, { kind: 'session', sessionId });
        expect(draft?.composer.text.value).toBe(suggested ? `${initialText}\n\n${question}` : initialText);
        const target = getSessionDraftSnapshot(scope, { kind: 'session', sessionId })?.document.target;
        expect(target?.kind === 'session' && target.routing.recipient?.value).toMatchObject({ mode: 'scm_diff_summary',
            recipient: { kind: 'execution_run', runId: 'question-generator' },
            target: { cwd: '/repo/exact', resultId: `result:${sessionId}`, expectedRevision: 1, stopIds: ['retained'] },
        });
        expect(generationCalls()).toEqual([]);
        await act(async () => composer.controls?.attachmentRowItems[0]?.onRemove?.());
        await vi.waitFor(() => {
            expect(composer.recipient?.scmDiffSummaryDiscussion).toEqual({ cwd: '/repo/exact', resultId: `result:${sessionId}`, expectedRevision: 1 });
            expect(composer.recipient?.recipient).toEqual({ kind: 'execution_run', runId: 'question-generator' });
            expect(composer.controls?.attachmentRowItems).toEqual([]);
        });
    });
    it('shows admitted review progress from a captured comparison destination before any saved narration exists', async () => {
        boundary.runResponse = ExecutionRunGetResponseSchema.parse({ run: {
            runId: 'review-run', callId: 'review-call', sidechainId: 'review-sidechain', intent: 'review',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only', retentionPolicy: 'resumable',
            runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 100, turnInFlight: true,
        } });
        function CapturedDestination(props: React.ComponentProps<typeof SessionWalkthroughView>) {
            const scopeId = `session:${props.sessionId}`;
            const pane = useAppPaneScope(scopeId);
            const seedReview = pane.patchDetailsTabState;
            React.useEffect(() => { seedReview(SESSION_DETAILS_SCM_REVIEW_TAB_KEY, { reviewRunIds: ['review-run'] }); }, [seedReview]);
            const comparison = props.comparison;
            if (!comparison) throw new Error('Expected a captured comparison destination');
            return <SessionCapturedScmReviewDetailsView sessionId={props.sessionId} serverId={props.serverId}
                scopeId={scopeId} comparison={comparison} target={{ comparison, view: 'walkthrough' }} />;
        }
        const { screen } = await mount({ kind: 'commit', commit: 'a'.repeat(40), comparisonId: 'captured-review' },
            'captured-review-progress', null, undefined, true, undefined, props => <CapturedDestination {...props} />);
        await vi.waitFor(() => expect(screen.findAllByTestId('review-walkthrough-steps').length).toBeGreaterThan(0));
        expect(boundary.sessionCalls.some(call => call.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET
            && (call.payload as { runId?: string }).runId === 'review-run')).toBe(true);
        expect(generationCalls()).toEqual([]);
    });

    it.each([
        { name: 'retires workspace-native generation at legacy heartbeat expiry and recovers on heartbeat', expiry: true },
        { name: 'starts workspace-native generation and observes its exact Run output without Session notifications', expiry: false },
    ])('$name', async ({ expiry }) => {
        boundary.capabilities = async () => ({ protocolVersion: 1, results: {
            'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { protocolVersion: 2, features: { detachedScope: true },
                backends: { claude: { available: true } } } },
        } });
        const profiles = buildScmDiffSummaryModelProfiles({ backendTarget: { kind: 'backend', backendId: 'claude' },
            models: getAgentStaticModels('claude'), agentFormats: getAgentCore('claude')?.structuredOutput?.formats });
        const settings = { ...initialStorage.settings, experiments: true, featureToggles: { 'execution.runs': true },
            'scm.diffSummary.runnerV1': runnerOfProfile(profiles.find(profile => profile.structuredOutput === 'supported')!) };
        const home = await createHome('https://native-generation.example.test', settings, 'native-machine');
        const machine = createMachineFixture({ id: 'native-machine', activeAt: Date.now(), storageMode: 'plain' });
        getStorage().setState({ sessions: {},
            profileScope: { serverId: home.id, accountId: 'walkthrough-account' }, settings });
        publishMachines(home, [machine]);
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
                scopeLabel="Workspace" layout="wide" renderBar={barWithMenu} onShowFiles={() => {}} onOpenFile={() => {}} />;
        }
        if (expiry) {
            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
            restoreObservationClock = () => vi.useRealTimers();
        }
        const screen = await renderScreen(<Workspace />, { wrapper: ({ children }) =>
            <InjectedAuthProvider credentials={accountCredentials}>{children}</InjectedAuthProvider> });
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(false));
        if (expiry) {
            await act(async () => { vi.advanceTimersByTime(120_000); });
            expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(true);
            // Legacy Homes use activeAt freshness, so an offline observation retains the expired heartbeat.
            await act(async () => publishMachines(home, [{ ...machine, active: false }]));
            expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(true);
            expect(generationCalls()).toEqual([]);
            // A fresh heartbeat makes the legacy Machine reachable again.
            await act(async () => { vi.advanceTimersByTime(1); });
            const heartbeat = { ...machine, activeAt: Date.now() };
            await act(async () => publishMachines(home, [heartbeat]));
            await vi.waitFor(() => expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(false));
            await screen.unmount();
            return;
        }
        await screen.pressByTestIdAsync('walkthrough-start');
        await vi.waitFor(() => expect(boundary.calls).toContainEqual(expect.objectContaining({
            method: SESSION_RPC_METHODS.EXECUTION_RUN_GET, payload: { runId: 'native-run', includeStructured: true, includeLatestToolResult: false,
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
        await act(async () => { await pushSavedResult(home.id, machine.id); });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Native completion'));
        const discussed = createDeferred<void>();
        boundary.nativeRunBarrier = () => discussed.promise;
        await chooseFromMenu(screen, 'walkthrough-saved-discuss');
        await act(async () => screen.changeTextByTestId('walkthrough-saved-message', 'Why this approach?'));
        await screen.pressByTestIdAsync('walkthrough-saved-discuss-send');
        await vi.waitFor(() => expect(boundary.calls).toContainEqual(expect.objectContaining({
            method: SESSION_RPC_METHODS.EXECUTION_RUN_GET,
            payload: { runId: 'native-run', includeStructured: true, includeLatestToolResult: false, waitForInputId: 'discussion-input' },
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
    it('restores once for equivalent comparisons and invalidates on source, checkout and Account changes', async () => {
        const home = await createHome('https://workspace-restore-identity.example.test');
        const machine = createMachineFixture({ id: 'workspace-restore-identity-machine', activeAt: Date.now(), storageMode: 'plain' });
        getStorage().setState({ sessions: {},
            profileScope: { serverId: home.id, accountId: 'walkthrough-account' } });
        publishMachines(home, [machine]);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const firstList = createDeferred<void>();
        boundary.listBarrier = () => firstList.promise;
        const hook = await renderHook((props: { rootPath: string; comparison: SessionScmReviewComparison }) =>
            useWorkspaceScmDiffSummaryBinding({ machineId: machine.id, serverId: home.id, ...props, output: 'walkthrough' }), {
            initialProps: { rootPath: '/workspace/exact', comparison: { kind: 'workingTree' } },
            wrapper: ({ children }) => <InjectedAuthProvider credentials={accountCredentials}>{children}</InjectedAuthProvider>,
        });
        const lists = () => boundary.calls.filter(call => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST);
        await vi.waitFor(() => expect(lists()).toHaveLength(1));
        for (let render = 0; render < 3; render += 1) {
            await hook.rerender({ rootPath: '/workspace/exact', comparison: { kind: 'workingTree' } });
        }
        expect(lists()).toHaveLength(1);
        boundary.listBarrier = null;
        await act(async () => firstList.resolve());
        await hook.rerender({ rootPath: '/workspace/exact', comparison: { kind: 'workingTree' } });
        expect(lists()).toHaveLength(1);

        await hook.rerender({ rootPath: '/workspace/exact', comparison: { kind: 'commit', commit: 'a'.repeat(40) } });
        await vi.waitFor(() => expect(lists()).toHaveLength(2));
        await hook.rerender({ rootPath: '/workspace/other', comparison: { kind: 'commit', commit: 'a'.repeat(40) } });
        await vi.waitFor(() => expect(lists()).toHaveLength(3));
        const retiredBinding = hook.getCurrent().binding;
        await act(async () => servedHome!.switchAccount('home', 'another-walkthrough-account'));
        accountCredentials = (await TokenStorage.getCredentialsForServerUrl(home.serverUrl))!;
        // Account restoration clears the previous Account's machine projection;
        // publish the newly signed-in Account's own observation before restoring.
        await act(async () => {
            getStorage().setState({ profileScope: { serverId: home.id, accountId: 'another-walkthrough-account' } });
            publishMachines(home, [machine], 'another-walkthrough-account');
        });
        await hook.rerender();
        await vi.waitFor(() => expect(hook.getCurrent().scope?.accountId).toBe('another-walkthrough-account'));
        await vi.waitFor(() => expect(lists().filter(call => call.accountId === 'another-walkthrough-account')).toHaveLength(1));
        expect(retiredBinding?.isCurrent()).toBe(false);
        expect(lists()).toHaveLength(4);
        expect(generationCalls()).toEqual([]);
    }, 120_000);

    it('restores and edits workspace-native saved reading without a Session and retires it on another checkout', async () => {
        const home = await createHome('https://workspace-only.example.test');
        const machine = createMachineFixture({ id: 'workspace-only-machine', activeAt: Date.now(), storageMode: 'plain' });
        getStorage().setState({ sessions: {},
            profileScope: { serverId: home.id, accountId: 'walkthrough-account' } });
        publishMachines(home, [machine]);
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
                scopeLabel="Workspace" layout="wide" renderBar={barWithMenu} onShowFiles={() => {}} onOpenFile={() => {}} />;
        }
        const screen = await renderScreen(<Workspace rootPath="/workspace/exact" />, {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={accountCredentials}>{children}</InjectedAuthProvider>,
        });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Workspace saved reading'));
        await chooseFromMenu(screen, 'walkthrough-saved-edit');
        await act(async () => screen.findByTestId('walkthrough-saved-title')!.props.onChangeText('My workspace title'));
        await screen.pressByTestIdAsync('walkthrough-saved-title-save');
        await vi.waitFor(() => expect(boundary.savedResult?.revision).toBe(2));
        expect(screen.getTextContent()).toContain('My workspace title');
        expect(boundary.sessionCalls).toEqual([]);
        expect(generationCalls()).toEqual([]);
        expect(boundary.calls.filter(call => call.method.startsWith('scm.diffSummary.')).every(call => call.authorization === undefined)).toBe(true);
        const savedState = Object.values(getScmDiffSummaryState().entriesByKey).find((entry) => entry.savedResult?.resultId === 'workspace-saved');
        expect(savedState).toMatchObject({ sessionId: null, machineId: machine.id, input: { cwd: '/workspace/exact' } });
        expect(savedState?.observedAtMs).toBeGreaterThan(0);
        await act(async () => publishMachines(home, []));
        expect(screen.getTextContent()).toContain('My workspace title');
        expect(Boolean(screen.findHostByTestId('walkthrough-notice-offline'))).toBe(false);
        const workspaceReading = screen.find(node => node.props.scopeLabel === 'Workspace'
            && node.props.reading !== undefined && node.props.start !== undefined);
        expect(workspaceReading.props.offline).toBeNull();
        expect(Object.values(getScmDiffSummaryState().entriesByKey).find(entry => entry.savedResult?.resultId === 'workspace-saved')?.observedAtMs)
            .toBe(savedState?.observedAtMs);
        await screen.update(<Workspace rootPath="/workspace/other" />);
        expect(screen.getTextContent()).not.toContain('My workspace title');
        expect(boundary.calls.filter((call) => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_EDIT)).toEqual([
            expect.objectContaining({ machineId: machine.id, serverId: home.id, accountId: 'walkthrough-account', payload: {
                cwd: '/workspace/exact', resultId: 'workspace-saved', expectedRevision: 1, edit: { kind: 'renameWalkthrough', title: 'My workspace title' },
            } }),
        ]);
    });
    it('retains observed code and marks offline, refuses writes without host evidence, and resumes on reconnect', async () => {
        const { screen, home, machine, offline, writes, observedAtMs } = await mountWithAccountMarks('offline-marks');
        await screen.pressByTestIdAsync('walkthrough-mark-retained');
        await vi.waitFor(() => {
            expect(writes(), screen.getTextContent()).toBe(1);
            expect(screen.findHostByTestId('walkthrough-mark-retained')?.props.accessibilityLabel).toBe(t('walkthrough.unmarkReviewedA11y'));
        });
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
        expect(screen.findHostByTestId('walkthrough-mark-retained')?.props.accessibilityLabel).toBe(t('walkthrough.unmarkReviewedA11y'));
        await screen.pressByTestIdAsync('walkthrough-mark-retained');
        expect(writes()).toBe(1);
        expect(screen.findHostByTestId('walkthrough-notice-offline')).toBeTruthy();
        expect(readingView.props.offline).toEqual({ machine: 'tester.local',
            time: formatWithCachedDateTimeFormatter(observedAtMs!, getPreferredLanguage(), { dateStyle: 'medium', timeStyle: 'short' }),
        });
        // This is the observed retained read, not a manufactured fresh clock on loss of reachability.
        expect(Object.values(getScmDiffSummaryState().entriesByKey).find(value => value.sessionId === 'offline-marks')?.observedAtMs).toBe(observedAtMs);
        await act(async () => publishMachines(home, []));
        expect(screen.getTextContent()).toContain('Retained reading');
        // The external presence store settles from unreachable to unknown when the row disappears.
        // Unknown must not be presented as an offline witness or as a fresh code observation.
        await vi.waitFor(() => {
            const unlistedReading = screen.find(node => node.props.scopeLabel === 'Shown comparison'
                && node.props.reading !== undefined && node.props.start !== undefined);
            expect(unlistedReading.props.offline).toBeNull();
            expect(screen.findHostByTestId('walkthrough-notice-offline')).toBeNull();
        });
        expect(Object.values(getScmDiffSummaryState().entriesByKey).find(value => value.sessionId === 'offline-marks')?.observedAtMs).toBe(observedAtMs);
        // Unknown Machine presence is not an offline witness: the bound Session
        // remains the existing host authority, rather than a new Machine gate.
        await act(async () => publishMachines(home, [{ ...machine, activeAt: Date.now() }]));
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-mark-retained')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('walkthrough-mark-retained');
        await vi.waitFor(() => {
            expect(writes()).toBe(2);
            expect(screen.findHostByTestId('walkthrough-mark-retained')?.props.accessibilityLabel).toBe(t('walkthrough.markReviewedA11y'));
        });
    }, 120_000);

    it('does not admit fresh machine evidence on activity while offline, and rereads the current revision on reconnect', async () => {
        const { screen, home, machine, offline } = await mountWithAccountMarks('offline-evidence');
        await act(async () => {});
        await offline();
        await vi.waitFor(() => expect(screen.findHostByTestId('walkthrough-notice-offline')).toBeTruthy());
        const reads = () => boundary.calls.filter(call => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ).length;
        const before = reads();
        await act(async () => notifyExecutionRunActivity({ serverId: home.id, sessionId: 'offline-evidence' }, { runId: 'offline-notification' }));
        expect(reads()).toBe(before);
        expect(generationCalls()).toEqual([]);
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ ...boundary.savedResult!, revision: 2,
            output: { ...boundary.savedResult!.output, revision: 2, outputs: { walkthrough: { state: 'complete',
                value: { ...boundary.savedResult!.output.outputs!.walkthrough!.value, title: 'Current revision after reconnect' } } } } });
        await act(async () => publishMachines(home, [{ ...machine, activeAt: Date.now() }]));
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Current revision after reconnect'));
        expect(reads()).toBeGreaterThan(before);
    }, 120_000);
});

describe('SessionWalkthroughView START through real generation and model owners', () => {
    it('keeps the reading render idle when an unrelated source-control preference changes', async () => {
        const renderBar = vi.fn((actions: React.ReactNode) => actions);
        const { home, machine } = await mount({ kind: 'workingTree' }, 'settings-locality', null, renderBar);
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
        const { screen, home, machine } = await mount({ kind: 'workingTree' }, boundary.savedSessionId);
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
            await pushSavedResult(home.id, machine.id);
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
        expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('walkthrough-start');
        expect(generationCalls()).toEqual([]);
        await act(async () => capabilities.resolve({ protocolVersion: 1, results: {
            'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { backends: { codex: { available: true, intents: ['scm_diff_summary'] } } } },
        } }));
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('walkthrough-start');
        await vi.waitFor(() => {
            expect(generationCalls()).toEqual([expect.objectContaining({ machineId: machine.id, serverId: home.id,
                accountId: 'walkthrough-account', payload: expect.objectContaining({ sessionId, cwd: '/repo/exact', source, outputs: ['walkthrough'] }) })]);
            // Auto sends no model: the executing machine's task-runner owner decides on the Session's own Agent.
            expect(generationCalls()[0]!.payload).not.toHaveProperty('modelSelector');
            const entry = Object.values(getScmDiffSummaryState().entriesByKey).find((value) => value.sessionId === sessionId);
            expect(entry).toMatchObject({ sessionId, input: { source }, latestOutput: { success: true, metadata: { source } } });
        });
    }, 120_000);

    it.each([true, false])('leaves an unset model to the host default owner with an automatic Account model=%s', async (automatic) => {
        boundary.capabilities = async () => ({ protocolVersion: 1, results: {
            'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { backends: {
                codex: { available: true, intents: ['scm_diff_summary'] },
            } } },
        } });
        // A Session may have an applied connected model while its Account has no automatic route.
        // The UI cannot decide that inherited selection from the Account catalog.
        const { screen } = await mount({ kind: 'workingTree' }, `automatic-model-${automatic}`, null, undefined, true,
            automatic ? undefined : null);
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('walkthrough-start');
        await vi.waitFor(() => expect(generationCalls()).toHaveLength(1));
        expect(generationCalls()[0]!.payload).not.toHaveProperty('modelSelector');
    }, 120_000);

    /** Start needs a settled machine; the model is Auto unless chosen, resolved on the executing machine. */
    async function chooseEligibleModel(screen: Awaited<ReturnType<typeof mount>>['screen']) {
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(false));
    }
    const EXECUTION_CAPABILITIES = async () => ({ protocolVersion: 1, results: {
        'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { backends: { codex: { available: true, intents: ['scm_diff_summary'] } } } },
    } });

    it('presents an admitted failed output as the typed failure, never the native reason', async () => {
        boundary.capabilities = EXECUTION_CAPABILITIES;
        boundary.generate = (input) => {
            const sourceKey = `comparison:${input.sessionId ?? input.cwd}`;
            return ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey, metadata: { sourceKey, source: input.source },
                requestedOutputs: input.outputs,
                comparison: { id: sourceKey, source: input.source, repository: { rootPath: input.cwd }, endpoints: {},
                    inventory: { state: 'complete', files: [], reasons: [] } },
                outputs: { walkthrough: { state: 'failed', reason: 'Native model provisioning failed' } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } });
        };
        const { screen } = await mount({ kind: 'workingTree' }, 'admitted-failure');
        await chooseEligibleModel(screen);
        await screen.pressByTestIdAsync('walkthrough-start');
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-notice-failed')).toBeTruthy());
        expect(screen.findByTestId('walkthrough-none')).toBeNull();
        expect(screen.getTextContent()).toContain('Writing stopped');
        expect(screen.getTextContent()).not.toContain('Native model provisioning failed');
        expect(screen.findByTestId('walkthrough-retry')).toBeTruthy();
    }, 120_000);

    it('tells a refused regeneration of a kept reading what to do, and keeps the reading', async () => {
        boundary.capabilities = EXECUTION_CAPABILITIES;
        let generations = 0;
        boundary.generate = (input) => {
            // The first admission writes a reading of files that changed since; the second is refused by the daemon.
            if (++generations > 1) return ScmDiffSummaryGenerateOutputSchema.parse({ success: false, errorCode: 'MODEL_UNAVAILABLE', error: 'Provider xyz rejected the model' });
            const sourceKey = `comparison:${input.sessionId ?? input.cwd}`;
            return ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey, metadata: { sourceKey, source: input.source },
                requestedOutputs: input.outputs,
                comparison: { id: sourceKey, source: input.source, freshness: 'stale', repository: { rootPath: input.cwd }, endpoints: {},
                    inventory: { state: 'complete', files: [], reasons: [] } },
                outputs: { walkthrough: { state: 'complete', value: { title: 'Kept reading', intro: '', stops: [], otherChangeRefs: [] } } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } });
        };
        const { screen } = await mount({ kind: 'workingTree' }, 'kept-reading');
        await chooseEligibleModel(screen);
        await screen.pressByTestIdAsync('walkthrough-start');
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-notice-stale')).toBeTruthy());
        expect(screen.findByTestId('walkthrough-notice-failed')).toBeNull();
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-refresh')).toBeTruthy());
        await screen.pressByTestIdAsync('walkthrough-refresh');
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-notice-failed')).toBeTruthy());
        // The reading stays; the refusal is the typed sentence and its next step, not the daemon's words or code.
        expect(generations).toBe(2);
        expect(screen.getTextContent()).toContain('Kept reading');
        expect(screen.getTextContent()).toContain('The selected model isn’t available right now.');
        expect(screen.getTextContent()).not.toContain('Provider xyz');
        expect(screen.getTextContent()).not.toContain('MODEL_UNAVAILABLE');
        expect(screen.findAllByType(LlmTaskRunnerPicker)).toHaveLength(0);
        // The action puts the shared runner picker on screen for this run, asking about the Session's own Agent.
        await screen.pressByTestIdAsync('walkthrough-choose-model');
        expect(screen.findAllByType(LlmTaskRunnerPicker)).toHaveLength(1);
        expect(screen.findAllByType(LlmTaskRunnerPicker)[0]!.props).toMatchObject({ task: 'scm_diff_summary', value: { v: 1, mode: 'auto' } });
    }, 120_000);

    it('keeps Start unavailable while Explain changes is off, says so, and leads to the setting', async () => {
        boundary.capabilities = EXECUTION_CAPABILITIES;
        const { screen } = await mount({ kind: 'workingTree' }, 'explain-off');
        await chooseEligibleModel(screen);
        await act(async () => getStorage().setState((state) => ({ settings: { ...state.settings, 'scm.diffSummary.enabled': false } })));
        expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('walkthrough-start');
        expect(generationCalls()).toEqual([]);
        expect(screen.getTextContent()).toContain('“Explain changes” is off.');
        await screen.pressByTestIdAsync('walkthrough-start-options-enable-explain');
        expect(boundary.router!.spies.push).toHaveBeenCalledWith('/settings/source-control');
        // Turning it on clears the refusal and Start works again.
        await act(async () => getStorage().setState((state) => ({ settings: { ...state.settings, 'scm.diffSummary.enabled': true } })));
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(false));
        expect(screen.getTextContent()).not.toContain('is off');
    }, 120_000);

    it('keeps the exact captured identity and reports unavailable evidence without replacing it with a fresh source', async () => {
        const comparisonId = 'c'.repeat(64);
        boundary.capabilities = async () => ({ protocolVersion: 1, results: {
            'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { backends: { codex: { available: true, intents: ['scm_diff_summary'] } } } },
        } });
        const { screen } = await mount({ kind: 'workingTree', comparisonId }, 'captured-route');
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-start')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('walkthrough-start');
        await vi.waitFor(() => expect(generationCalls()).toEqual([expect.objectContaining({ payload: expect.objectContaining({
            comparisonId, source: { kind: 'workingTree' },
        }) })]));
        await vi.waitFor(() => expect(Object.values(getScmDiffSummaryState().entriesByKey).find((value) => value.sessionId === 'captured-route'))
            .toMatchObject({ status: 'failed', error: { code: 'DIFF_UNAVAILABLE' } }));
        const entry = Object.values(getScmDiffSummaryState().entriesByKey).find((value) => value.sessionId === 'captured-route');
        expect(entry?.latestOutput?.success).not.toBe(true);
        // The person reads the typed refusal and its way forward, never the diagnostic message or code.
        expect(screen.getTextContent()).toContain('Writing stopped');
        expect(screen.getTextContent()).not.toContain(entry!.error!.message);
        expect(screen.getTextContent()).not.toContain('DIFF_UNAVAILABLE');
    }, 120_000);

    it('keeps Refresh when a stale saved reading receives a new supported Summary preference with its picker unmounted', async () => {
        boundary.capabilities = async () => ({ protocolVersion: 1, results: {
            'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { backends: { claude: { available: true } } } },
        } });
        const profiles = buildScmDiffSummaryModelProfiles({ backendTarget: { kind: 'backend', backendId: 'claude' },
            models: getAgentStaticModels('claude'), agentFormats: getAgentCore('claude')?.structuredOutput?.formats });
        const supported = profiles.filter((profile) => profile.structuredOutput === 'supported');
        const stored = runnerOfProfile(supported[0]!);
        const changedPreference = runnerOfProfile(supported[1]!);
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
        expect(screen.findAllByType(LlmTaskRunnerPicker)).toHaveLength(0);
        expect(generationCalls()).toEqual([]);
        // Remote Account settings also publish into this real store. Unlike
        // restoration's brief empty frame, an already-open reading has no picker
        // to settle availability for the newly selected supported model.
        await act(async () => getStorage().setState((state) => ({ settings: {
            ...state.settings, 'scm.diffSummary.runnerV1': changedPreference,
        } })));
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-refresh')).toBeTruthy());
        await screen.pressByTestIdAsync('walkthrough-refresh');
        // The shared selected-model observer admits a supported Account preference
        // directly; reopening a picker is not a prerequisite for Refresh.
        expect(screen.findAllByType(LlmTaskRunnerPicker)).toHaveLength(0);
        await vi.waitFor(() => expect(generationCalls()).toEqual([expect.objectContaining({ machineId: machine.id, serverId: home.id,
            accountId: 'walkthrough-account', payload: expect.objectContaining({ sessionId: 'reopened-stale', cwd: '/repo/exact', source: { kind: 'workingTree' },
                outputs: ['walkthrough'], modelSelector: expect.objectContaining({ modelSelection: changedPreference.modelSelection }), cachePolicy: { mode: 'bypass' } }) })]));
        await vi.waitFor(() => expect(Object.values(getScmDiffSummaryState().entriesByKey)
            .filter(entry => entry.sessionId === 'reopened-stale').map(entry => entry.latestOutput))
            .toContainEqual(expect.objectContaining({ success: true, sourceKey: 'comparison:reopened-stale' })));
    }, 120_000);

    it('adopts a persisted pending result’s later Run binding and prose on exact Machine result hints without model admission', async () => {
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
        const { screen, home, machine } = await mount({ kind: 'workingTree' }, boundary.savedSessionId);
        await vi.waitFor(() => expect(boundary.calls.some(call => call.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST
            && call.authorization?.kind === 'session.write' && call.authorization.sessionId === 'late-bound-run')).toBe(true));
        const projection = () => {
            const state = getScmDiffSummaryState();
            const entry = Object.values(state.entriesByKey).find((value) => value.sessionId === 'late-bound-run');
            return entry ? getScmDiffSummaryOperationState(state, entry.key) : null;
        };
        await vi.waitFor(() => expect(projection()).toMatchObject({ resultId: 'pending-result', executionRunId: null,
            savedResult: { revision: 0 }, outputs: { walkthrough: { state: 'pending' } } }));
        expect(screen.findByTestId('walkthrough-notice-ended')).toBeNull();
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
        await act(async () => { await pushSavedResult(home.id, machine.id); });
        await vi.waitFor(() => expect(projection()).toMatchObject({ executionRunId: 'newly-bound-run', savedResult: { revision: 1 },
            latestRun: { runId: 'newly-bound-run' }, outputs: { walkthrough: { state: 'complete', value: { title: 'Published reading' } } } }));
        const rendered = screen.getTextContent();
        expect(rendered).toContain('Published reading');
        expect(rendered).toContain('Prose published after the Run was bound.');
        // The first reading arriving is not an update to one the person was reading: no "Saved result updated" band.
        expect(screen.findByTestId('walkthrough-notice-update')).toBeNull();
        expect(screen.findByTestId('walkthrough-undo')).toBeNull();
        const published = boundary.savedResult!;
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ ...published, revision: 2, canUndo: true,
            updateNotice: { kind: 'generation', revision: 2, affectedStopIds: [] },
            output: { ...published.output, revision: 2, outputs: { walkthrough: { state: 'complete', value: {
                title: 'Refined reading', intro: 'Prose published after the Run was bound.', stops: [], otherChangeRefs: [],
            } } } } });
        boundary.runResponse = ExecutionRunGetResponseSchema.parse({ ...boundary.runResponse,
            structuredMeta: { kind: 'scm_diff_summary.v1', payload: boundary.savedResult.output } });
        await act(async () => { await pushSavedResult(home.id, machine.id); });
        await vi.waitFor(() => expect(projection()?.savedResult?.revision).toBe(2));
        // An update to the reading on the page is confirmed with its Undo.
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-undo')).not.toBeNull());
        expect(screen.getTextContent()).toContain('Refined reading');
        const current = boundary.savedResult!;
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ ...current, revision: 3, canUndo: false,
            updateNotice: { kind: 'undo', revision: 3, affectedStopIds: [] },
            output: { ...current.output, revision: 3, outputs: { walkthrough: { state: 'complete', value: {
                title: 'Earlier reading', intro: '', stops: [], otherChangeRefs: [],
            } } } } });
        await screen.pressByTestIdAsync('walkthrough-undo');
        await vi.waitFor(() => expect(projection()?.savedResult?.revision).toBe(3));
        expect(screen.getTextContent()).toContain('Earlier reading');
        expect(screen.findByTestId('walkthrough-undo')).toBeNull();
        // With nothing left to undo the band has nothing to offer; the reading's own provenance marks carry the history.
        expect(screen.findByTestId('walkthrough-notice-update')).toBeNull();
        expect([...boundary.calls, ...boundary.sessionCalls]).toEqual(expect.arrayContaining([expect.objectContaining({
            method: RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_UNDO,
            payload: { cwd: '/repo/exact', resultId: 'pending-result', expectedRevision: 2 },
        })]));
        expect(boundary.sessionCalls).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: 'late-bound-run',
            method: SESSION_RPC_METHODS.EXECUTION_RUN_GET, payload: { runId: 'newly-bound-run', includeStructured: true, includeLatestToolResult: false },
            scope: { serverId: home.id, accountId: 'walkthrough-account' } })]));
        expect(generationCalls()).toEqual([]);
    }, 120_000);

    it('names the Agent that wrote a reading with no recorded model and keeps an update it did not see arrive off the page', async () => {
        boundary.savedSessionId = 'reopened-update';
        const source = { kind: 'workingTree' };
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ resultId: 'reopened-result', revision: 2, canUndo: true,
            generator: { backendTarget: { kind: 'backend', backendId: 'claude' } },
            updateNotice: { kind: 'edit', revision: 2, affectedStopIds: [] },
            output: { success: true, resultId: 'reopened-result', revision: 2, sourceKey: 'reopened-comparison',
                metadata: { sourceKey: 'reopened-comparison', source }, requestedOutputs: ['walkthrough'],
                comparison: { id: 'reopened-comparison', source, repository: { rootPath: '/repo/exact' }, endpoints: {},
                    inventory: { state: 'complete', files: [], reasons: [] } },
                outputs: { walkthrough: { state: 'complete', value: { title: 'Reopened reading', intro: '', stops: [], otherChangeRefs: [] } } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } });
        const { screen } = await mount({ kind: 'workingTree' }, boundary.savedSessionId);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Reopened reading'));
        expect(screen.getTextContent()).toContain('Generated · Claude');
        // The edit landed before this view opened: its band is history, so it isn't shown.
        expect(screen.findByTestId('walkthrough-notice-update')).toBeNull();
        expect(generationCalls()).toEqual([]);
    }, 120_000);

    it('waits for live conversation evidence before showing a restored walkthrough as unavailable', async () => {
        boundary.savedSessionId = 'restored-conversation';
        const source = { kind: 'workingTree' };
        boundary.savedResult = ScmDiffSummaryResultSchema.parse({ resultId: 'conversation-result', revision: 1, canUndo: false,
            output: { success: true, resultId: 'conversation-result', revision: 1, runId: 'conversation-run', sourceKey: 'conversation-comparison',
                metadata: { sourceKey: 'conversation-comparison', source }, requestedOutputs: ['walkthrough'],
                comparison: { id: 'conversation-comparison', source, repository: { rootPath: '/repo/exact' }, endpoints: {},
                    inventory: { state: 'complete', files: [], reasons: [] } },
                outputs: { walkthrough: { state: 'complete', value: { title: 'Saved reading', intro: '', stops: [], otherChangeRefs: [] } } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } });
        const live = ExecutionRunGetResponseSchema.parse({ run: {
            runId: 'conversation-run', callId: 'conversation-call', sidechainId: 'conversation-sidechain', intent: 'review',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only', retentionPolicy: 'resumable',
            runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
            lifecycle: { v: 1, state: 'current' },
            interaction: { kind: 'retained_agent_session.v1', capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
        } });
        // Admission precedes native interaction publication. The Run is current,
        // but this first observation cannot establish conversational readiness.
        boundary.runResponse = ExecutionRunGetResponseSchema.parse({ run: { ...live.run, interaction: undefined } });
        const observation = createDeferred<void>();
        boundary.nativeRunBarrier = () => observation.promise;
        const { screen, home } = await mount({ kind: 'workingTree' }, boundary.savedSessionId);
        await vi.waitFor(() => expect(boundary.sessionCalls.some(call => call.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toBe(true));
        expect(screen.getTextContent()).toContain('Saved reading');
        expect(screen.findByTestId('walkthrough-notice-ended')).toBeNull();
        expect(screen.findByTestId('walkthrough-open-conversation')).toBeNull();
        await act(async () => { observation.resolve(); });
        await vi.waitFor(() => {
            const state = getScmDiffSummaryState();
            const entry = Object.values(state.entriesByKey).find(value => value.sessionId === boundary.savedSessionId);
            const observed = entry ? getScmDiffSummaryOperationState(state, entry.key)?.latestRun : undefined;
            expect(observed).toMatchObject({ runId: live.run.runId, lifecycle: { state: 'current' } });
            expect(observed?.interaction).toBeUndefined();
        });
        expect(screen.findByTestId('walkthrough-notice-ended')).toBeNull();
        expect(screen.findByTestId('walkthrough-open-conversation')).toBeNull();
        boundary.runResponse = live;
        await act(async () => notifyExecutionRunActivity({ serverId: home.id, sessionId: boundary.savedSessionId }, { runId: live.run.runId }));
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-open-conversation')).not.toBeNull());
        expect(screen.findByTestId('walkthrough-notice-ended')).toBeNull();
        boundary.runResponse = ExecutionRunGetResponseSchema.parse({ run: { ...live.run, status: 'succeeded', interaction: undefined,
            lifecycle: { v: 1, state: 'unavailable' } } });
        await act(async () => notifyExecutionRunActivity({ serverId: home.id, sessionId: boundary.savedSessionId }, { runId: live.run.runId }));
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-notice-ended')).not.toBeNull());
        expect(screen.findByTestId('walkthrough-open-conversation')).toBeNull();
        expect(screen.getTextContent()).toContain('Saved reading');
        expect(generationCalls()).toEqual([]);
    }, 120_000);

    it('restores a review’s walkthrough the machine saved after the view opened, then places its findings beside the stop, with no model work', async () => {
        boundary.capabilities = async () => ({ protocolVersion: 1, results: {} });
        boundary.savedSessionId = 'reviewed-session';
        const { screen, home, machine } = await mount({ kind: 'workingTree' }, boundary.savedSessionId);
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
        // Saved content is invalidated by its exact Machine result revision, independently of Run activity.
        await act(async () => { await pushSavedResult(home.id, machine.id); });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Keys follow the route'));
        await vi.waitFor(() => expect(screen.findByTestId('walkthrough-finding-f1')).not.toBeNull());
        expect(screen.findByTestId('walkthrough-finding-ref-f1')).not.toBeNull();
        expect(screen.findByTestId('walkthrough-review-fact')).not.toBeNull();
        expect(screen.findByTestId('review-walkthrough-steps')).not.toBeNull();
        // The review wrote this walkthrough with its findings in view, so explaining them again is not offered.
        expect(screen.findByTestId('walkthrough-explain-findings')).toBeNull();
        expect(screen.findByTestId('walkthrough-review-explanation:s1:0')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Adds d.');
        expect(screen.getTextContent()).toContain('The finding questions validation, without changing the walkthrough.');
        expect(screen.getTextContent()).toContain('explanation-model');
        expect(screen.getTextContent()).toContain('review-agent');
        expect(generationCalls()).toEqual([]);
    }, 120_000);
});
