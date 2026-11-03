import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { WorkflowRunStartRequestV1Schema, WorkflowMaterializedLeafV1Schema, type WorkflowRunStartResultV1,
    WorkflowAcceptedSnapshotV1Schema, WorkflowProgressEnvelopeV1Schema, WorkflowInvocationDetailV1Schema, WorkflowFinalResultV1Schema, type WorkflowProgressEnvelopeV1,
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
    sealWorkflowFinalResultStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
    SOCKET_RPC_EVENTS, PluginProjectionV2Schema, ActionExecuteFailureSchema,
} from '@happier-dev/protocol';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { createWorkflowActionHttpTransport } from '@/dev/testkit/fixtures/workflowActionHttpTransport';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { parseToken } from '@/utils/auth/parseToken';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createWorkflowAccountRunActionOwner, type WorkflowAccountRunActionDeps } from '@happier-dev/protocol/actions';
import { WorkflowRunGetResultV1Schema, WorkflowRunRecipientCensusResponseV1Schema, type RoleArtifactV1, type WorkflowInvocationGetResultV1 } from '@happier-dev/protocol';
import { ModalProvider } from '@/modal';
import { getStorage } from '@/sync/domains/state/storageStore';
import { workflowRunRowFromSummary, workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { clearMachineRequestReachabilityForMachine, recordMachineRequestFailed, withdrawMachinePresenceForScope } from '@/sync/domains/machines/reachability/machineReachability';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderScreen as renderTestScreen, invokeTestInstanceHandler } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import {
    createWorkflowDefinitionFixture,
    createWorkflowInvocationIndexFixture as createInvocationFixture,
    createWorkflowRunSummaryFixture as createRunFixture,
} from '@/dev/testkit/fixtures/workflowRunFixtures';
import { buildWorkflowReviewedRunSeed, readWorkflowReviewedRunSeed, storeWorkflowReviewedRunSeed } from '@/sync/domains/workflows/workflowReviewedRunSeed';
import { readWorkflowDefinitionDraftSeed, storeWorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';
import { buildWorkflowEditorDraftFromDefinition } from '@/sync/domains/workflows/workflowAuthoring';
import { readNewSessionAutomationHandoffSeed, storeNewSessionAutomationHandoffSeed } from '@/sync/domains/workflows/newSessionAutomationHandoffSeed';
import { readTriggerWorkflowSeed, storeTriggerWorkflowSeed } from '../triggers/triggerWorkflowSeed';
import { WorkflowRunScreen } from './WorkflowRunScreen';
import { WorkflowEditorHostScreen, type WorkflowEditorSource } from './WorkflowEditorHostScreen';
import { WorkflowEditorBody } from './WorkflowEditorBody';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { WorkflowRunContent } from '../run/WorkflowRunContent';
import { WorkflowInvocationDetail } from '../run/WorkflowInvocationDetail';
import { WorkflowRunPeekDetailsView } from '@/components/sessions/work/WorkflowRunPeekDetailsView';
import { useSessionWorkOpeners } from '@/components/sessions/work/useSessionWorkOpeners';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { isWorkflowRunPeekDetailsResource } from '@/components/sessions/work/createWorkflowRunPeekDetailsTab';
import { Pressable } from 'react-native';
import type { WorkItem } from '@/components/sessions/work/workProjection';

// These Run fixtures do not stream Markdown; keep its external web adapter at the boundary.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected vendor Markdown reveal in Run screen test'); },
}));

type WorkflowRunContentProps = React.ComponentProps<
    typeof import('../run/WorkflowRunContent').WorkflowRunContent
>;

/**
 * Host-level Run detail contracts.
 *
 * These deliberately start from what the screen really builds — a paged public
 * invocation index plus the frozen definition — instead of a hand-injected
 * progress map. A component test that is handed complete private progress
 * cannot decide whether the host can ever produce it.
 */

let observedRunScreen: Awaited<ReturnType<typeof renderTestScreen>> | null = null;
function readContentProps(): WorkflowRunContentProps | null {
    const content = observedRunScreen?.findAllByType(WorkflowRunContent)[0];
    // React's external test renderer exposes untyped props; component identity
    // fixes this boundary to the actual production component's public contract.
    return content ? content.props as WorkflowRunContentProps : null;
}
async function renderScreen(...args: Parameters<typeof renderTestScreen>) {
    const screen = await renderTestScreen(...args);
    observedRunScreen = screen;
    return { ...screen, unmount: async () => {
        if (observedRunScreen === screen) observedRunScreen = null;
        await screen.unmount();
    } };
}
let restoreRunPopoverGlobals: (() => void) | undefined;

// The screen validates route identities through Protocol. Fixture defaults
// and opaque-storage replies must address those same valid identities.
function createWorkflowRunSummaryFixture(overrides: Parameters<typeof createRunFixture>[0] = {}) {
    return createRunFixture({ id: '11111111-1111-4111-8111-111111111111', ownerAccountId: 'account-a', ...overrides });
}

function createWorkflowInvocationIndexFixture(overrides: Parameters<typeof createInvocationFixture>[0] = {}) {
    return createInvocationFixture({ id: '77777777-7777-4777-8777-777777777777',
        runId: '11111111-1111-4111-8111-111111111111', ...overrides });
}

function requireDefined<T>(value: T | undefined, message: string): T {
    if (value === undefined) throw new Error(message);
    return value;
}
/**
 * Answers through the host's single responder. A failure belongs to the
 * canonical card that awaits it, so the returned promise is observed here
 * rather than left as an unhandled rejection.
 */
function respondToRequest(
    response: Parameters<NonNullable<WorkflowRunContentProps['onRespondToRequest']>>[0],
): Promise<void> | undefined {
    const answer = readContentProps()?.onRespondToRequest?.(response);
    answer?.catch(() => {});
    return answer;
}

const actionTransport = vi.hoisted(() => vi.fn());
const startResponse = vi.hoisted(() => vi.fn());
const sourceAccessResponse = vi.hoisted(() => vi.fn());
const catalogResponse = vi.hoisted(() => vi.fn());
const routerSpy = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
const routeState = vi.hoisted((): { runId: string; invocationId?: string; serverId?: string } => ({ runId: '11111111-1111-4111-8111-111111111111' }));
const platformViewport = vi.hoisted(() => ({ width: 800, height: 600, scale: 1, fontScale: 1 }));
// Per-Action transport replies. The real detail client still parses every reply.
const detailActions = vi.hoisted(() => ({
    markFailureSeen: vi.fn(),
    getRun: vi.fn(),
    listRuns: vi.fn(),
    listInvocations: vi.fn(),
    getInvocation: vi.fn(),
    resumeRun: vi.fn(),
    restoreWorkspace: vi.fn(),
    retryInvocation: vi.fn(),
    pauseRun: vi.fn(),
    cancelRun: vi.fn(),
    deleteRun: vi.fn(),
}));
const storeState = {
    get state() { return getStorage().getState(); },
    reset(): void {
        const base = createMachineFixture();
        const machine = createMachineFixture({ storageMode: 'plain', activeAt: Date.now(), metadata: { ...base.metadata!, homeDir: '/Users/me' } });
        getStorage().setState({
            // The real editor waits for the repository's first draft hydration.
            isSessionDraftsReady: true,
            machines: { [machine.id]: machine }, machineListByServerId: {},
            workflowRunsById: {}, workflowRunInvocationsByRunId: {}, workflowRunListWindows: {},
            artifacts: {},
        });
    },
};
type MachineRpcCall = Readonly<{ machineId: string; method: string; payload: unknown; requestId?: string;
    serverUrl?: string; accountId?: string }>;
const machineRpcSpy = vi.hoisted(() => vi.fn<(params: MachineRpcCall) => Promise<unknown>>());
const socketCancellations: string[] = [];
let machinePreparationFailure: Error | undefined;
// Native process observation is outside the UI process. Its facts enter the
// real shared recovery owner at the external Machine Action boundary below.
const nativeRecoveryEvidence = new Map<string, Awaited<ReturnType<NonNullable<WorkflowAccountRunActionDeps['observeRecovery']>>>>();
const nativeRecoveryReads: string[] = [];
let nativeRecoveryFailure: 'target_unavailable' | 'run_access_denied' | null = null;
let supplementalRecoveryLookupFailure: 503 | 403 | null = null;
let supplementalRecoveryLookupPending = false;
let supplementalRecoveryLookupEffect: (() => void | Promise<unknown>) | undefined;
const supplementalRecoveryLookupFailures: number[] = [];
let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const storedRunDetails = new Map<string, Record<string, unknown>>();
const approvalArtifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
let approvalRequired = false;
const appliedRuntime = vi.hoisted(() => ({ serverId: 'server-a', serverUrl: 'https://server-a', generation: 0 }));
let servedHomeId = 'server-a';
const runStorageHomes: string[] = [];
const accountScopeHarness = {
    switchTo(scope: Readonly<{ serverId: string; accountId: string }>): void {
        retireActiveServerAccountScopeLifetime();
        appliedRuntime.serverId = scope.serverId === 'server-a' ? servedHomeId : scope.serverId;
        getStorage().setState({ profileScope: { ...scope, serverId: appliedRuntime.serverId } });
        publishAppliedActiveServerSnapshot(appliedRuntime);
    },
    reset(): void {
        retireActiveServerAccountScopeLifetime();
        appliedRuntime.serverId = 'server-a';
    },
};

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => platformViewport,
        Dimensions: { get: () => platformViewport },
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
// DOM layer/focus SDK adapters stay outside the real Modal custody owner.
vi.mock('@/utils/web/radixCjs', async () =>
    (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: routerSpy, params: () => ({ ...routeState }) }).module;
});
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));
vi.mock('@/utils/ui/clipboard', () => ({ setClipboardStringSafe: async () => true }));
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

const DEFINITION = createWorkflowDefinitionFixture({
    blocks: [
        {
            kind: 'step',
            id: 'analyze',
            document: { text: 'Analyze the repository', references: [], attachments: [] },
            input: [],
            result: { kind: 'text' },
        },
    ],
});

const ACCEPTED_CONTEXT = {
    startedBy: 'user' as const,
    source: { kind: 'inline' as const },
    inputs: {},
    machineId: 'machine-1',
    executionTarget: { kind: 'detached_run' as const },
    materializedLeaves: [],
    frozenChildren: {},
    workspaceTarget: {
        project: { machineId: 'machine-1', directory: '/Users/me/project', checkoutRootPath: '/Users/me/project' },
    },
    origin: { kind: 'direct' as const },
};

type UnsavedSeedKind = 'new-session' | 'trigger' | 'definition-copy' | 'reviewed-run';

function createUnsavedEditorSource(kind: UnsavedSeedKind, name: string): Extract<WorkflowEditorSource, { kind: 'new' }> {
    const definition = { ...DEFINITION, blocks: DEFINITION.blocks.map((block) => ({ ...block, name })) };
    switch (kind) {
        case 'new-session': return { kind: 'new', newSessionDraftSeedId: storeNewSessionAutomationHandoffSeed({
            name, description: name, enabled: true,
            draft: buildWorkflowEditorDraftFromDefinition({ draftId: name, name, definition }),
            project: ACCEPTED_CONTEXT.workspaceTarget.project, triggers: [],
        }) };
        case 'trigger': return { kind: 'new', triggerWorkflowSeedId: storeTriggerWorkflowSeed({
            definition, retarget: { scope: 'account', automationId: '00000000-0000-4000-8000-000000000009', expectedRevision: 1 },
        }) };
        case 'definition-copy': return { kind: 'new', definitionDraftSeedId: storeWorkflowDefinitionDraftSeed({ name, definition }) };
        case 'reviewed-run': return { kind: 'new', reviewedRunSeedId: storeWorkflowReviewedRunSeed(buildWorkflowReviewedRunSeed({
            run: createWorkflowRunSummaryFixture(), definition,
            acceptedContext: { ...ACCEPTED_CONTEXT, metadata: { title: name } },
        })) };
    }
}

function invocationPage(invocations: readonly unknown[]) {
    return { invocations, parentRevision: 1 };
}

/** The storage boundary answers the exact row, including structural graph reads. */
function keyInvocationReads(invocations: readonly ReturnType<typeof createWorkflowInvocationIndexFixture>[],
    progressById: ReadonlyMap<string, WorkflowProgressEnvelopeV1> = new Map()) {
    const selectedReply = requireDefined(detailActions.getInvocation.getMockImplementation(), 'Expected the selected invocation reply');
    detailActions.getInvocation.mockImplementation(async (input: Readonly<{ invocationId: string }>, signal?: AbortSignal) => {
        const response = await selectedReply(input, signal);
        if (response.invocation.index.id === input.invocationId) return response;
        const index = requireDefined(invocations.find(row => row.id === input.invocationId), 'Unexpected exact invocation read');
        return { invocation: { index, parentRevision: 1, progress: progressById.get(index.id) ?? {
            kind: 'happier.workflow-progress.v1', blockKind: index.parentRecordId === null ? 'root' : 'step',
            invocationPath: { blockId: index.parentRecordId === null ? '$root' : 'analyze', scope: [] },
            attempt: index.attempt, logicalInvocationRecordId: index.id,
        } } };
    });
}

function runStartCalls() {
    return actionTransport.mock.calls.filter(([action]) => action === 'workflow.run.start');
}

function createRunScreenElement() {
    return <AppPaneProvider><ModalProvider><WorkflowRunScreen /></ModalProvider></AppPaneProvider>;
}

const NO_SUBAGENTS = Object.freeze([]);
function LeadRunPeekHost(props: Readonly<{ home: string; runId: string; visible: boolean }>) {
    const scopeId = `session:lead:${props.home}`;
    const { openItem } = useSessionWorkOpeners({ sessionId: 'lead', serverId: props.home, scopeId, subagents: NO_SUBAGENTS });
    const pane = useAppPaneScope(scopeId);
    const tab = pane.scopeState?.details?.tabs.find(candidate => isWorkflowRunPeekDetailsResource(candidate.resource));
    const resource = tab && isWorkflowRunPeekDetailsResource(tab.resource) ? tab.resource : null;
    const item = { key: `run:${props.runId}`, kind: 'workflow_run', title: 'Lead workflow', agentId: null,
        facts: [], parentKey: null, level: 0, progress: null,
        status: { state: 'running', bucket: 'working', tone: 'neutral', attentionType: null, word: 'Working' }, open: { kind: 'workflow_run', runId: props.runId },
    } satisfies WorkItem;
    return <>
        <Pressable testID="lead-open-workflow" onPress={() => openItem(item)} />
        {resource ? <WorkflowRunPeekDetailsView runId={resource.runId} serverId={resource.serverId}
            active={props.visible} onClose={() => {}} /> : null}
    </>;
}

async function openEditorAfterRouteHydration(screen: Awaited<ReturnType<typeof renderScreen>>, source: WorkflowEditorSource) {
    const hydration = createDeferred<void>();
    let hydrated = false;
    // React's route hydration can discard a rendered tree before commit;
    // no seed may be consumed by that speculative render.
    function RouteHydrationBoundary() {
        if (!hydrated) throw hydration.promise;
        return null;
    }
    await screen.update(<React.StrictMode><AppPaneProvider><React.Suspense fallback={null}>
        <WorkflowEditorHostScreen source={source} />
        <RouteHydrationBoundary />
    </React.Suspense></AppPaneProvider></React.StrictMode>);
    await act(async () => { hydrated = true; hydration.resolve(); });
}

async function reviewRunAgain(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await screen.pressByTestIdAsync('workflow-run-run-again');
    expect(runStartCalls()).toHaveLength(0);
    expect(screen.findByTestId('workflow-run-inputs-preview')).not.toBeNull();
    expect(screen.findByTestId('workflow-start-where-chip')).not.toBeNull();
}

function permissionInvocationResponse(params: Readonly<{
    index: ReturnType<typeof createWorkflowInvocationIndexFixture>;
    requestIds: readonly string[];
    executionRunId?: string;
    parentRevision?: number;
}>): WorkflowInvocationGetResultV1 {
    return {
        invocation: {
            index: params.index,
            parentRevision: params.parentRevision ?? 1,
            progress: {
                kind: 'happier.workflow-progress.v1',
                invocationPath: { blockId: 'analyze', scope: [] },
                blockKind: 'step',
                attempt: '0',
                logicalInvocationRecordId: '44444444-4444-4444-8444-444444444444',
                execution: {
                    kind: 'detached_run', runId: params.executionRunId ?? 'exec-1',
                    localInputId: 'input-1', runtimeSelection: {},
                },
                interaction: {
                    requests: Object.fromEntries(params.requestIds.map((requestId, index) => [
                        requestId,
                        {
                            tool: index === 0 ? 'Write' : 'Read', createdAt: index + 1,
                            arguments: { file_path: '/Users/me/project/README.md', ...(index === 0 ? { content: 'work' } : {}) },
                        },
                    ])),
                },
            },
        },
    };
}

/**
 * A selected detached-run attempt holding two open permission requests.
 *
 * Two are needed because the contract is per-request: a decision in flight for
 * one request may not disable — or settle — the other.
 */
async function renderSelectedPermissionRequests(contentRevision = '0') {
    const invocations = [
        createWorkflowInvocationIndexFixture({ id: '33333333-3333-4333-8333-333333333333', parentRecordId: null, memberOrdinal: '0', sequence: '0' }),
        createWorkflowInvocationIndexFixture({
            id: '44444444-4444-4444-8444-444444444444', parentRecordId: '33333333-3333-4333-8333-333333333333', memberOrdinal: '0', sequence: '1', lifecycle: 'waiting_for_approval', contentRevision,
        }),
    ];
    detailActions.getInvocation.mockResolvedValue(permissionInvocationResponse({
        index: invocations[1],
        requestIds: ['permission-1', 'permission-2'],
    }));
    const screen = await renderRunScreen({
        run: createWorkflowRunSummaryFixture({
            id: '11111111-1111-4111-8111-111111111111', state: 'running', machineId: 'machine-1', origin: { kind: 'direct' },
        }),
        invocations,
    });
    await act(async () => readContentProps()?.onSelectInvocation('44444444-4444-4444-8444-444444444444'));
    await act(async () => {});
    return screen;
}

async function renderRunScreen(overrides: Readonly<{
    run?: ReturnType<typeof createWorkflowRunSummaryFixture>;
    invocations?: readonly unknown[];
    invocationDetails?: readonly WorkflowInvocationGetResultV1['invocation'][];
    failedInvocationDetails?: readonly WorkflowInvocationGetResultV1['invocation'][];
    failedInvocation?: unknown;
    definition?: unknown;
    result?: unknown;
    usage?: Readonly<{ inputTokens?: number; outputTokens?: number; costUsd?: number }>;
    finalOutputInvocationId?: string;
    historyNextCursor?: string;
    acceptedContext?: unknown;
    invocationListFailure?: Error;
    getRunFailure?: Error;
    canEdit?: boolean;
    wrap?: (screen: React.ReactElement) => React.ReactElement;
}> = {}) {
    const run = overrides.run ?? createWorkflowRunSummaryFixture({
        id: '11111111-1111-4111-8111-111111111111',
        state: 'succeeded',
        workflowCustodyState: 'settled',
        origin: { kind: 'direct' },
        availability: { cancel: false, pause: false },
    });
    const invocations = overrides.invocations ?? [];
    if (overrides.failedInvocation !== undefined) {
        const index = createWorkflowInvocationIndexFixture(fixtureRecord(overrides.failedInvocation));
        const previousGet = detailActions.getInvocation.getMockImplementation();
        detailActions.getInvocation.mockImplementation(async (input: Readonly<{ invocationId: string }>, signal?: AbortSignal) => (
            overrides.invocationDetails?.some(detail => detail.index.id === input.invocationId)
                ? { invocation: overrides.invocationDetails.find(detail => detail.index.id === input.invocationId) }
                : input.invocationId === index.id ? { invocation: overrides.failedInvocationDetails?.[0] ?? {
                index, parentRevision: run.revision, progress: WorkflowProgressEnvelopeV1Schema.parse({
                    kind: 'happier.workflow-progress.v1', blockKind: 'root', attempt: index.attempt,
                    logicalInvocationRecordId: index.id, invocationPath: { blockId: '$root', scope: [] },
                }),
            } } : previousGet?.(input, signal)
        ));
    }
    detailActions.listRuns.mockResolvedValue({ runs: [run], metadataByRunId: {} });
    detailActions.getRun.mockResolvedValue({
        run,
        callerAccess: { canEdit: overrides.canEdit ?? true },
        definition: overrides.definition ?? DEFINITION,
        authoredDefinition: overrides.definition ?? DEFINITION,
        acceptedContext: overrides.acceptedContext ?? ACCEPTED_CONTEXT,
        checkpoint: null,
        ...(Object.prototype.hasOwnProperty.call(overrides, 'result') ? { result: overrides.result } : {}),
        ...(overrides.usage === undefined ? {} : { usage: overrides.usage }),
        ...(overrides.finalOutputInvocationId === undefined
            ? {}
            : { finalOutputInvocationId: overrides.finalOutputInvocationId }),
    });
    if (overrides.getRunFailure !== undefined) detailActions.getRun.mockRejectedValue(overrides.getRunFailure);
    if (overrides.invocationListFailure === undefined) {
        detailActions.listInvocations.mockImplementation(async (input: Readonly<{ lifecycles?: readonly string[]; includeContent?: boolean; cursor?: string }>) => (
            input.lifecycles?.length === 1 && input.lifecycles[0] === 'failed'
                ? invocationPage(overrides.failedInvocation === undefined ? [] : [overrides.failedInvocation])
                : {
                    ...invocationPage(input.cursor === undefined ? invocations : []),
                    ...(input.includeContent && overrides.invocationDetails ? { invocationDetails: overrides.invocationDetails } : {}),
                    ...(input.cursor === undefined && input.lifecycles === undefined && overrides.historyNextCursor !== undefined
                        ? { nextCursor: overrides.historyNextCursor }
                        : {}),
                }
        ));
    } else {
        detailActions.listInvocations.mockRejectedValue(overrides.invocationListFailure);
    }
    const element = createRunScreenElement();
    const screen = await renderScreen(overrides.wrap ? overrides.wrap(element) : element);
    await act(async () => {});
    return screen;
}

function fixtureRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a transport fixture object');
    return value as Record<string, unknown>;
}

function runKeyCensus(runId: string, canEdit = true, ownerAccountId = 'account-a') {
    return WorkflowRunRecipientCensusResponseV1Schema.parse({ runId, ownerAccountId,
        access: canEdit ? 'owner' : 'view', encryptionMode: 'plain', visibleTeamId: null,
        dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
        ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
}

async function acceptedStorage(value: unknown) {
    const detail = WorkflowRunGetResultV1Schema.parse(value);
    const run = detail.run;
    storedRunDetails.set(run.id, fixtureRecord(detail));
    const context = detail.acceptedContext;
    const frozen = context.materializedLeaves.length > 0 ? WorkflowAcceptedSnapshotV1Schema.parse({
        ...context, definition: detail.definition, authoredDefinition: detail.authoredDefinition,
        metadata: context.metadata ?? null,
        workDepth: 0, authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
    }) : undefined;
    const materialized = await materializeWorkflowAcceptedSnapshotV1({
        definition: detail.authoredDefinition ?? detail.definition, admission: { kind: 'user' },
        ...(frozen ? { replay: { snapshot: frozen } } : {}),
        ingressContext: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
        effects: { resolveTargetAvailability: async () => true },
        context: { ...context, authorization: { principal: { kind: 'host' } } },
    });
    if (!materialized.ok) throw new Error(`Run fixture materialization failed: ${JSON.stringify(materialized.error)}`);
    const snapshot = WorkflowAcceptedSnapshotV1Schema.parse(materialized.snapshot);
    return { run, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: run.ownerAccountId, runId: run.id }, acceptedSnapshot: snapshot })),
        checkpointEnvelope: null, resultEnvelope: detail.result === undefined ? null : serializeWorkflowStoredContentEnvelopeV1(
            sealWorkflowFinalResultStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, purpose: 'final_result', accountId: run.ownerAccountId, runId: run.id },
                finalResult: WorkflowFinalResultV1Schema.parse({ kind: 'happier.workflow-final-result.v1', result: { kind: typeof detail.result === 'string' ? 'text' : 'json', value: detail.result },
                    producerInvocation: { recordId: detail.finalOutputInvocationId } }) })),
        keyCensus: runKeyCensus(run.id, detail.callerAccess.canEdit, run.ownerAccountId),
    };
}

function storedInvocation(value: unknown) {
    const detail = WorkflowInvocationDetailV1Schema.parse(value);
    const index = detail.index;
    const ownerAccountId = String(storedRunDetails.get(index.runId)?.run
        ? fixtureRecord(storedRunDetails.get(index.runId)!.run).ownerAccountId : 'account-a');
    return { index, parentRevision: detail.parentRevision, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(
        sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: ownerAccountId,
            runId: index.runId, recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
            memberOrdinal: index.memberOrdinal, attempt: index.attempt }, progress: WorkflowProgressEnvelopeV1Schema.parse(detail.progress) })) };
}

async function workflowStorageResponse(operation: Record<string, unknown>, signal?: AbortSignal | null) {
    const { operation: kind, progressEnvelopes, pageByteLimit: _budget, ...fields } = operation;
    const input = { ...fields, ...(progressEnvelopes ? { includeContent: true } : {}) };
    switch (kind) {
        case 'read_state.set': return detailActions.markFailureSeen(fields, signal);
        case 'get': return acceptedStorage(await detailActions.getRun(fields.runId, signal));
        case 'list': {
            const page = fixtureRecord(await detailActions.listRuns(fixtureRecord(operation.request), signal));
            const rows = await Promise.all((page.runs as unknown[]).map(async run => {
                const detail = await detailActions.getRun.getMockImplementation()?.(fixtureRecord(run).id, signal);
                return detail ? acceptedStorage({ ...fixtureRecord(detail), run }) : null;
            }));
            return { runs: page.runs, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
                acceptedEnvelopesByRunId: Object.fromEntries(rows.filter(row => row !== null).map(row => [row.run.id, row.acceptedEnvelope])),
                keyCensusByRunId: Object.fromEntries((page.runs as unknown[]).map(run => [fixtureRecord(run).id,
                    runKeyCensus(String(fixtureRecord(run).id), true, String(fixtureRecord(run).ownerAccountId))])) };
        }
        case 'invocations.list': {
            // Usage projection and public history read the same stored facts;
            // omission of a row limit does not identify a different consumer.
            const page = fixtureRecord(await detailActions.listInvocations(input, signal));
            const details = [...(page.invocationDetails ?? []) as unknown[]];
            const invocations = [...page.invocations as unknown[]];
            const detail = storedRunDetails.get(String(fields.runId));
            if (detail?.usage && progressEnvelopes && fields.cursor === undefined
                && fields.lifecycles === undefined && invocations.length === 0) {
                const index = createWorkflowInvocationIndexFixture({ runId: String(fields.runId),
                    id: '88888888-8888-4888-8888-888888888888', lifecycle: 'completed' });
                invocations.push(index);
                details.push({ index, parentRevision: fixtureRecord(detail.run).revision,
                    progress: { kind: 'happier.workflow-progress.v1', blockKind: 'step', attempt: '0', logicalInvocationRecordId: index.id,
                        invocationPath: { blockId: 'analyze', scope: [] }, usage: detail.usage,
                        execution: { kind: 'detached_run', runId: 'usage-execution', localInputId: 'usage-input', runtimeSelection: {} } } });
            }
            return { ...page, invocations, invocationDetails: undefined, ...(progressEnvelopes ? {
                keyCensus: runKeyCensus(String(fields.runId), true, String(fixtureRecord(storedRunDetails.get(String(fields.runId))?.run ?? { ownerAccountId: 'account-a' }).ownerAccountId)),
                progressEnvelopesByInvocationId: Object.fromEntries(invocations.map(raw => {
                    const index = createWorkflowInvocationIndexFixture(fixtureRecord(raw));
                    const detail = details.find(value => fixtureRecord(fixtureRecord(value).index).id === index.id) ?? {
                        index, parentRevision: page.parentRevision ?? 1, progress: {
                            kind: 'happier.workflow-progress.v1', blockKind: index.parentRecordId === null ? 'root' : 'step',
                            invocationPath: { blockId: index.parentRecordId === null ? '$root' : 'analyze', scope: [] },
                            attempt: index.attempt, logicalInvocationRecordId: index.id,
                        },
                    };
                    const stored = storedInvocation(detail); return [stored.index.id, stored.contentEnvelope];
                })),
            } : {}) };
        }
        case 'invocations.get': {
            const result = fixtureRecord(await detailActions.getInvocation(fields, signal));
            return { invocation: result.invocation ? storedInvocation(result.invocation) : null };
        }
        case 'run-key.census': return runKeyCensus(String(fields.runId), true,
            String(fixtureRecord(storedRunDetails.get(String(fields.runId))?.run ?? { ownerAccountId: 'account-a' }).ownerAccountId));
        case 'pause': return detailActions.pauseRun(fields, signal);
        case 'cancel': return detailActions.cancelRun(fields, signal);
        case 'delete': return detailActions.deleteRun(fields, signal);
        case 'resume': return detailActions.resumeRun(fields, signal);
        default: throw new Error(`Unexpected Run storage operation: ${String(kind)}`);
    }
}

beforeEach(async () => {
    installShippedNativeFrameScheduler();
    observedRunScreen = null;
    routeState.runId = '11111111-1111-4111-8111-111111111111';
    routeState.invocationId = undefined;
    routeState.serverId = undefined;
    Object.assign(platformViewport, { width: 800, height: 600 });
    accountScopeHarness.reset();
    storeState.reset();
    publishAppliedActiveServerSnapshot(appliedRuntime);
    actionTransport.mockReset();
    startResponse.mockReset();
    sourceAccessResponse.mockReset();
    sourceAccessResponse.mockResolvedValue({ ok: false, errorCode: 'artifact_not_found', error: 'artifact_not_found' });
    catalogResponse.mockReset();
    catalogResponse.mockResolvedValue({ definitions: [], pluginWorkflows: [] });
    startResponse.mockImplementation(async (input: unknown) => {
        const request = WorkflowRunStartRequestV1Schema.parse(input);
        return { admission: 'created', run: createWorkflowRunSummaryFixture({
            id: request.runId, state: 'queued', origin: { kind: 'direct' },
        }) };
    });
    routerSpy.push.mockClear();
    routerSpy.back.mockClear();
    machineRpcSpy.mockReset();
    machineRpcSpy.mockResolvedValue({ ok: true });
    socketCancellations.splice(0);
    storedRunDetails.clear();
    runStorageHomes.length = 0;
    approvalArtifacts.clear();
    approvalRequired = false;
    machinePreparationFailure = undefined;
    nativeRecoveryEvidence.clear();
    nativeRecoveryReads.splice(0);
    nativeRecoveryFailure = null;
    supplementalRecoveryLookupFailure = null;
    supplementalRecoveryLookupPending = false;
    supplementalRecoveryLookupEffect = undefined;
    supplementalRecoveryLookupFailures.splice(0);
    for (const action of Object.values(detailActions)) action.mockReset();
    (await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool')).resetScopedMachineTransportCacheForTests();
    await loadSyncSingletonForTests();
    const baseline = createWorkflowActionHttpTransport({ accountId: () => 'account-a', fixtureResponse: async (actionId, input) => ({
        ok: true, result: actionId === 'workflow.definition.list' ? await catalogResponse(input)
            : actionId === 'workflow.definition.get' ? {
                definitionId: input.definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
                definition: DEFINITION, metadata: { title: 'Source' }, access: 'view',
            } : undefined,
    }) });
    const serverIdentityId = 'srv_workflow_run_screen';
    const nativeReader = createWorkflowAccountRunActionOwner({
        resolveAccountId: async () => 'account-a',
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
        randomBytes: () => { throw new Error('plain_account_needs_no_keys'); },
        definitions: { get: async () => { throw new Error('Run recovery reads its frozen definition'); } },
        storage: { execute: (operation, options) => workflowStorageResponse(operation, options?.signal) },
        observeRecovery: async ({ index }) => {
            nativeRecoveryReads.push(index.id);
            return nativeRecoveryEvidence.get(index.id) ?? { activity: 'unknown', canReattach: false, canContinueConversation: false };
        },
    });
    const externalActions = await Promise.all((['workflow.run.start', 'workflow.run.resume', 'workflow.run.invocations.retry', 'workflow.run.invocations.get'] as const).map(actionId =>
        createExternalActionAccountHttpBoundary({ serverUrl: 'https://server-a', serverIdentityId, accountId: 'account-a',
            machineId: 'machine-1', actionId, tokenEpoch: 0,
            failure: value => {
                const failure = ActionExecuteFailureSchema.safeParse(value);
                return failure.success ? failure.data : null;
            }, execute: async (input, context) => {
                if (actionId === 'workflow.run.start') {
                    actionTransport(actionId, input, { externalActionTarget: context.target });
                    return startResponse(input);
                }
                if (actionId === 'workflow.run.resume') return detailActions.restoreWorkspace(input, context.target.kind === 'machine' ? context.target.machineId : '', undefined);
                if (actionId === 'workflow.run.invocations.get' && nativeRecoveryFailure)
                    return { ok: false, errorCode: nativeRecoveryFailure, error: nativeRecoveryFailure };
                if (actionId === 'workflow.run.invocations.get') return nativeReader.execute({ actionId,
                    input: { runId: String(fixtureRecord(input).runId), invocationId: String(fixtureRecord(input).invocationId) },
                    context: { surface: 'ui', authority: 'present_user', externalActionTarget: context.target },
                });
                return detailActions.retryInvocation(input);
            } })));
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-a', tokenEpoch: 0,
        provenance: AuthTokenProvenanceSchema.parse({ v: 1, kind: 'account', authority: 'present_user' }),
    })).toString('base64url')}.signature` };
    accountConnection = await restoreServerAccountForTest({ serverUrl: 'https://server-a', serverIdentityId, accountId: 'account-a', credentials,
        configureSocket: (socket, serverUrl) => {
            configureConnectedServerSocketBoundary(socket);
            socket.timeout = () => socket;
            socket.emit = vi.fn<typeof socket.emit>((event, payload) => {
                if (event === SOCKET_RPC_EVENTS.CANCEL) socketCancellations.push(fixtureRecord(payload).requestId as string);
                return socket;
            });
            socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, raw) => {
                if (event !== SOCKET_RPC_EVENTS.CALL) return {};
                const request = fixtureRecord(raw);
                const [machineId, ...parts] = String(request.method).split(':');
                const method = parts.join(':');
                const payload = request.params;
                const auth = fixtureRecord(socket.auth);
                return { ok: true, result: await machineRpcSpy({ machineId, method, payload, serverUrl,
                    accountId: parseToken(String(auth.token)),
                    ...(typeof request.requestId === 'string' ? { requestId: request.requestId } : {}) }) };
            });
        }, request: async (url, init) => {
            const target = new URL(String(url));
            if ((target.pathname === '/v1/machines' || target.pathname.startsWith('/v1/machines/')) && machinePreparationFailure) {
                const failure = machinePreparationFailure; machinePreparationFailure = undefined; throw failure;
            }
            for (const boundary of externalActions) {
                const answer = await boundary.handle(target, init);
                if (answer) return answer;
            }
            if (init?.method === 'POST' && target.pathname === '/v1/artifacts') actionTransport('workflow.definition.create', JSON.parse(String(init.body)));
            if (init?.method && init.method !== 'GET' && target.pathname.startsWith('/v3/automations')
                && target.pathname !== '/v3/automations/runs/workflow-storage') actionTransport('workflow.trigger.update', JSON.parse(String(init.body)));
            if (approvalRequired && target.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { 'execution.run.permission.respond': { approvalRequiredSurfaces: ['ui'] } } },
            } }, version: 2 });
            if (approvalRequired && target.pathname.startsWith('/v1/artifacts')) {
                const answer = approvalArtifacts.handle(target.pathname + target.search, init);
                if (answer) return answer;
            }
            if (target.pathname === '/v3/automations/runs/workflow-storage') {
                runStorageHomes.push(target.origin);
                const operation = fixtureRecord(JSON.parse(String(init?.body)));
                if (operation.operation === 'get' && supplementalRecoveryLookupPending && supplementalRecoveryLookupFailure) {
                    supplementalRecoveryLookupPending = false;
                    supplementalRecoveryLookupFailures.push(supplementalRecoveryLookupFailure);
                    await supplementalRecoveryLookupEffect?.();
                    return Response.json({ error: supplementalRecoveryLookupFailure === 403 ? 'run_access_denied' : 'storage_unavailable' },
                        { status: supplementalRecoveryLookupFailure });
                }
                try {
                    const response = await workflowStorageResponse(operation, init?.signal);
                    if (operation.operation === 'invocations.get' && supplementalRecoveryLookupFailure) supplementalRecoveryLookupPending = true;
                    return Response.json(response);
                }
                catch (error) {
                    if (error instanceof WorkflowActionError) return Response.json({ error: error.rawCode }, { status: 409 });
                    throw error;
                }
            }
            const grants = /^\/v1\/artifacts\/([^/]+)\/access\/grants$/.exec(target.pathname);
            if (grants) {
                const bearer = new Headers(init?.headers).get('Authorization')?.slice('Bearer '.length);
                const response = fixtureRecord(await sourceAccessResponse({ artifactId: decodeURIComponent(grants[1]!) },
                    { serverId: servedHomeId, accountId: bearer ? parseToken(bearer) : null }));
                return response.ok === true ? Response.json(response.result) : Response.json({ error: response.errorCode }, { status: response.errorCode === 'artifact_not_found' ? 404 : 503 });
            }
            return baseline.fetch(url, init);
        } });
    servedHomeId = accountConnection.home.id;
    Object.assign(appliedRuntime, (await import('@/sync/domains/server/serverRuntime')).getActiveServerSnapshot());
    storeState.reset();
    publishAppliedActiveServerSnapshot(appliedRuntime);
});

afterEach(async () => {
    await standardCleanup();
    (await import('../library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs')).clearDaemonMergedProjectionCacheForTests();
    if (accountConnection) clearMachineRequestReachabilityForMachine({ serverId: accountConnection.serverId, accountId: 'account-a' }, 'machine-1');
    await accountConnection?.dispose();
    accountConnection = null;
    restoreRunPopoverGlobals?.();
    restoreRunPopoverGlobals = undefined;
});

describe('WorkflowRunScreen', () => {
    it.each(['owner', 'viewer', 'peek'] as const)('acknowledges only an actually opened owner detail (%s)', async audience => {
        const failedAt = '2026-10-23T10:00:00.000Z';
        const run = createWorkflowRunSummaryFixture({ state: 'failed', finishedAt: failedAt,
            failureUnseen: audience !== 'viewer', attentionRequired: audience !== 'viewer',
            ownerAccountId: audience === 'viewer' ? 'another-account' : 'account-a' });
        // Hold the response in flight: detail rendering must not await or fabricate a seen summary.
        detailActions.markFailureSeen.mockImplementation(() => new Promise(() => {}));
        if (audience === 'peek') Object.assign(platformViewport, { width: 1440, height: 900 });
        const screen = await renderRunScreen({ run,
            ...(audience === 'peek' ? { wrap: () => <AppPaneProvider><ModalProvider><LeadRunPeekHost
                home={servedHomeId} runId={run.id} visible /></ModalProvider></AppPaneProvider> } : {}) });
        try {
            if (audience === 'peek') await screen.pressByTestIdAsync('lead-open-workflow');
            await vi.waitFor(() => expect(readContentProps()?.run.state).toBe('failed'));
            if (audience === 'owner') {
                await vi.waitFor(() => expect(detailActions.markFailureSeen).toHaveBeenCalledWith(
                    { runId: run.id, revision: run.revision, failedAt }, expect.anything()));
            } else expect(detailActions.markFailureSeen).not.toHaveBeenCalled();
        } finally { await screen.unmount(); }
    });
    it('settles an addressed Run read silently when navigation retires its Home binding', async () => {
        routeState.serverId = servedHomeId;
        let readSignal: AbortSignal | undefined;
        const pending = createDeferred<void>();
        const screen = await renderRunScreen({ wrap: element => {
            detailActions.getRun.mockImplementation(async (_runId: string, signal?: AbortSignal) => {
                readSignal = signal;
                pending.resolve();
                return await new Promise((_, reject) => {
                    if (signal?.aborted) reject(signal.reason);
                    else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            });
            return element;
        } });
        await pending.promise;
        await screen.unmount();
        expect(readSignal?.aborted).toBe(true);
    });

    it('reads and pauses a retained lead Home Run while another Home is active, including pane reactivation', async () => {
        const home = servedHomeId;
        const runId = routeState.runId;
        const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
        const otherHome = await upsertServerProfileOnly({ serverUrl: 'https://other-run-home.test', name: 'Other Run Home' });
        const run = createWorkflowRunSummaryFixture({ state: 'running', availability: { pause: true, cancel: true } });
        detailActions.pauseRun.mockResolvedValue({ run: { ...run, state: 'pause_requested', revision: 2 }, intent: 'pause_requested' });
        // A colliding opaque id in the ambient Home must never arm this pane's controls.
        accountScopeHarness.switchTo({ serverId: otherHome.id, accountId: 'account-b' });
        storeState.state.upsertWorkflowRuns([workflowRunRowFromSummary({ ...run, ownerAccountId: 'account-b', revision: 99 })]);
        Object.assign(platformViewport, { width: 1440, height: 900 });
        let visible = true;
        const pane = () => <AppPaneProvider><ModalProvider><LeadRunPeekHost home={home} runId={runId} visible={visible} /></ModalProvider></AppPaneProvider>;
        const screen = await renderRunScreen({ run, wrap: pane });
        try {
            await screen.pressByTestIdAsync('lead-open-workflow');
            await vi.waitFor(async () => {
                await act(async () => {});
                expect(readContentProps()?.run).toMatchObject({ id: runId, ownerAccountId: 'account-a', revision: 1 });
            });
            await act(async () => { visible = false; });
            await screen.update(pane());
            await act(async () => { visible = true; });
            await screen.update(pane());
            await vi.waitFor(async () => {
                await act(async () => {});
                expect(readContentProps()?.run.ownerAccountId).toBe('account-a');
            });
            await screen.pressByTestIdAsync('workflow-run-pause');
            await vi.waitFor(async () => {
                await act(async () => {});
                expect(readContentProps()?.run).toMatchObject({ ownerAccountId: 'account-a', revision: 2, state: 'pause_requested' });
            });
            expect(detailActions.pauseRun.mock.calls.map(([input]) => input)).toContainEqual({ runId, expectedRevision: 1 });
            expect(new Set(runStorageHomes)).toEqual(new Set(['https://server-a']));
            expect(storeState.state.workflowRunsById[workflowRunStoreKey(runId)]?.summary).toMatchObject({ ownerAccountId: 'account-b', revision: 99 });
        } finally { await screen.unmount(); }
    });

    it('publishes paged occurrence timing for unselected rows through the shared fact owner', async () => {
        const root = createWorkflowInvocationIndexFixture({ id: '33333333-3333-4333-8333-333333333333' });
        const index = createWorkflowInvocationIndexFixture({ id: '44444444-4444-4444-8444-444444444444',
            parentRecordId: root.id, memberOrdinal: '0', sequence: '1', lifecycle: 'completed' });
        const progress: WorkflowInvocationGetResultV1['invocation']['progress'] = {
            kind: 'happier.workflow-progress.v1', blockKind: 'step', attempt: index.attempt,
            logicalInvocationRecordId: index.id, invocationPath: { blockId: 'analyze', scope: [] },
            timing: { startedAt: '2026-10-11T10:00:00.000Z', finishedAt: '2026-10-11T10:02:00.000Z' },
        };
        await renderRunScreen({ invocations: [root, index], invocationDetails: [{ index, progress, parentRevision: 1 }] });
        expect(readContentProps()?.invocationProgressById?.get(index.id)?.timing).toEqual(progress.timing);
        expect(storeState.state.workflowRunInvocationsByRunId[workflowRunStoreKey(index.runId)]?.factsById[index.id]?.opened?.progress.timing).toEqual(progress.timing);
        expect(detailActions.getInvocation).not.toHaveBeenCalled();
    });
    it.each([false, true])('publishes an off-page failed leaf cause before selection through the real Action codec and page (miswired: %s)', async (miswired) => {
        const run = createWorkflowRunSummaryFixture({ state: 'failed', workflowCustodyState: 'settled' });
        const failed = createWorkflowInvocationIndexFixture({ lifecycle: 'failed', sequence: '90' });
        const progress = WorkflowProgressEnvelopeV1Schema.parse({
            kind: 'happier.workflow-progress.v1', blockKind: 'step', attempt: failed.attempt,
            logicalInvocationRecordId: failed.id, invocationPath: { blockId: 'analyze', scope: [] },
            reason: { code: 'session_input_failed', message: 'Turn failed', runtimeIssueV1: {
                v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit', occurredAt: 100,
                sanitizedPreview: 'Usage limit reached',
                usageLimit: { v: 1, resetAtMs: 1_900_000_000_000, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' },
            } },
        });
        const screen = await renderRunScreen({ run, invocations: [], failedInvocation: failed,
            failedInvocationDetails: [{ index: miswired ? { ...failed, id: '88888888-8888-4888-8888-888888888888' } : failed,
                progress, parentRevision: run.revision }], historyNextCursor: 'more-history' });
        expect(readContentProps()?.selectedInvocationId).toBeNull();
        if (miswired) {
            expect(readContentProps()?.firstFailedInvocationResolution).toBe('error');
            expect(readContentProps()?.failurePresentation).toBeNull();
            expect(screen.getTextContent()).not.toContain('Usage limit reached');
            return;
        }
        expect(readContentProps()?.invocationProgressById?.get(failed.id)?.reason?.runtimeIssueV1).toEqual(progress.reason?.runtimeIssueV1);
        expect(readContentProps()?.failurePresentation).toMatchObject({ invocationId: failed.id,
            step: { name: expect.any(String), ordinal: '1' },
            recovery: { failureCause: { kind: 'reported_failure', message: 'Usage limit reached', runtimeIssue: progress.reason?.runtimeIssueV1 } } });
        expect(screen.getTextContent()).toContain('Usage limit reached');
        expect(detailActions.getInvocation).toHaveBeenCalledWith({ runId: run.id, invocationId: failed.id }, expect.any(AbortSignal));
        await screen.pressByTestIdAsync('workflow-run-see-failures');
        expect(screen.findAllByType(WorkflowInvocationDetail)[0]?.props.recovery).toBe(readContentProps()?.failurePresentation?.recovery);
    });
    it('opens the failed leaf when failure discovery first finds its structural root', async () => {
        const run = createWorkflowRunSummaryFixture({ state: 'failed', workflowCustodyState: 'settled' });
        const root = createWorkflowInvocationIndexFixture({ id: '33333333-3333-4333-8333-333333333333', lifecycle: 'failed' });
        const leaf = createWorkflowInvocationIndexFixture({ lifecycle: 'failed', parentRecordId: root.id, sequence: '1' });
        const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1', blockKind: 'step',
            attempt: leaf.attempt, logicalInvocationRecordId: leaf.id, invocationPath: { blockId: 'analyze', scope: [] },
            reason: { code: 'step_failed', message: 'The review could not finish.' } });
        const screen = await renderRunScreen({ run, invocations: [root, leaf], failedInvocation: root,
            invocationDetails: [{ index: leaf, progress, parentRevision: run.revision }] });
        expect(readContentProps()?.failurePresentation).toMatchObject({ invocationId: leaf.id, step: { ordinal: '1' },
            recovery: { failureCause: { kind: 'reported_failure', message: 'The review could not finish.' } } });
        await screen.pressByTestIdAsync('workflow-run-see-failures');
        expect(readContentProps()?.selectedInvocationId).toBe(leaf.id);
    });
    it.each(['recorded', 'absent', 'miswired'] as const)('keeps R5 failure facts through stored producer → page → See failures (%s)', async evidence => {
        const run = createWorkflowRunSummaryFixture({ state: 'failed', workflowCustodyState: 'settled',
            finishedAt: '2026-10-19T04:58:00.000Z' });
        const failed = createWorkflowInvocationIndexFixture({ lifecycle: 'failed', createdAt: '2026-10-19T03:42:00.000Z',
            updatedAt: run.finishedAt! });
        const machine = storeState.state.machines[run.machineId]!;
        getStorage().setState({ machines: { [machine.id]: { ...machine, active: false,
            activeAt: Date.parse('2026-10-19T10:28:00.000Z') } } });
        const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1', blockKind: 'root',
            attempt: failed.attempt, logicalInvocationRecordId: failed.id, invocationPath: { blockId: '$root', scope: [] },
            timing: { startedAt: failed.createdAt, finishedAt: run.finishedAt },
            ...(evidence === 'absent' ? {} : { reason: { code: 'plugin_failed', message: 'Review process exited with an error' } }),
        });
        const screen = await renderRunScreen({ run, invocations: [], failedInvocation: failed, failedInvocationDetails: [{
            index: evidence === 'miswired' ? { ...failed, id: '88888888-8888-4888-8888-888888888888' } : failed,
            progress, parentRevision: run.revision,
        }] });
        if (evidence === 'miswired') {
            expect(readContentProps()?.failurePresentation).toBeNull();
            expect(screen.getTextContent()).not.toContain('Review process exited with an error');
            return;
        }
        const cause = evidence === 'absent' ? { kind: 'cause_not_recorded' }
            : { kind: 'reported_failure', code: 'plugin_failed', message: 'Review process exited with an error' };
        expect(readContentProps()?.failurePresentation?.recovery.failureCause).toMatchObject(cause);
        expect(screen.getTextContent()).not.toContain('Lost contact');
        await screen.pressByTestIdAsync('workflow-run-see-failures');
        const inspector = screen.findAllByType(WorkflowInvocationDetail)[0];
        expect(inspector?.props.recovery).toBe(readContentProps()?.failurePresentation?.recovery);
        expect(inspector?.props.recovery.failureCause).toMatchObject(cause);
        expect(screen.getTextContent()).not.toContain('Lost contact');
    });
    it('opens the Run on Map and closes a query-selected step back to that exact Run', async () => {
        Object.assign(platformViewport, { width: 390, height: 844 });
        const replace = vi.fn();
        routeState.invocationId = '44444444-4444-4444-8444-444444444444';
        const root = createWorkflowInvocationIndexFixture({ id: '33333333-3333-4333-8333-333333333333' });
        const step = createWorkflowInvocationIndexFixture({ id: '44444444-4444-4444-8444-444444444444', parentRecordId: root.id });
        detailActions.getInvocation.mockResolvedValue({ invocation: { index: step, parentRevision: 1,
            progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'analyze', scope: [] },
                attempt: '0', logicalInvocationRecordId: step.id, blockKind: 'step' } } });
        const screen = await renderRunScreen({ invocations: [root, step], wrap: screen => <DestinationInstanceHost tabId="hold-tab"
            ref={{ kind: 'workflowRun', params: { runId: '11111111-1111-4111-8111-111111111111', invocationId: '44444444-4444-4444-8444-444444444444' } }}
            pathname="/workflows/runs/11111111-1111-4111-8111-111111111111" focused visible phone navigation={{ ...routerSpy, replace, canGoBack: () => false }}>
            {screen}
        </DestinationInstanceHost> });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.findByTestId('workflow-run-selected-header.close')).not.toBeNull();
        });
        await screen.pressByTestIdAsync('workflow-run-selected-header.close');
        expect(replace).toHaveBeenCalledWith('/workflows/runs/11111111-1111-4111-8111-111111111111');
        expect(readContentProps()?.view).toBe('flow');
    });

    it('uses the exact Run as the phone step header close fallback', async () => {
        Object.assign(platformViewport, { width: 390, height: 844 });
        const replace = vi.fn();
        routeState.invocationId = '44444444-4444-4444-8444-444444444444';
        const screen = await renderRunScreen({ wrap: body => <DestinationInstanceHost tabId="hold-tab"
            ref={{ kind: 'workflowRun', params: { runId: '11111111-1111-4111-8111-111111111111', invocationId: '44444444-4444-4444-8444-444444444444' } }}
            pathname="/workflows/runs/11111111-1111-4111-8111-111111111111" focused visible phone navigation={{ ...routerSpy, replace, canGoBack: () => false }}>
            {body}
        </DestinationInstanceHost> });
        await screen.pressByTestIdAsync('workflow-run-selected-header.close');
        expect(replace).toHaveBeenCalledWith('/workflows/runs/11111111-1111-4111-8111-111111111111');
    });

    it('keeps Back in the phone header when the Run no longer exists, even with no history to go back to', async () => {
        Object.assign(platformViewport, { width: 390, height: 844 });
        const screen = await renderRunScreen({
            getRunFailure: new WorkflowActionError({ message: 'Workflow Run not found', rawCode: 'run_not_found' }),
            wrap: body => <DestinationInstanceHost tabId="hold-tab"
                ref={{ kind: 'workflowRun', params: { runId: '11111111-1111-4111-8111-111111111111' } }}
                pathname="/workflows/runs/11111111-1111-4111-8111-111111111111" focused visible phone
                navigation={{ ...routerSpy, replace: vi.fn(), canGoBack: () => false }}>
                {body}
            </DestinationInstanceHost>,
        });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.findByTestId('workflow-run-load-failed')).not.toBeNull();
        });
        expect(screen.findByTestId('workflow-run-back')).not.toBeNull();
        // The bar already names the page "Run": the body does not say it a second time.
        expect(screen.findHostByTestId('workflow-run-state-header')).toBeNull();
    });

    it('admits an accepted repeat with frozen child and role after their live sources change or disappear', async () => {
        const originalId = '11111111-1111-4111-8111-111111111111';
        const childRef = '22222222-2222-4222-8222-222222222222';
        routeState.runId = originalId;
        const roleId = 'accepted_reviewer';
        const acceptedRole: RoleArtifactV1 = {
            name: 'Accepted reviewer', instructions: 'Review without modifying files',
            engine: { agentTargetKey: 'happier.agent.test/test' }, runsAs: { kind: 'session' },
            workspaceWrites: 'deny', secondOpinion: 'off', enabled: true,
        };
        let liveRoles: Readonly<Record<string, RoleArtifactV1>> = { [roleId]: acceptedRole };
        const child = createWorkflowDefinitionFixture({ defaults: { engine: { role: roleId } } });
        let liveChild: typeof child | null = child;
        const definition = createWorkflowDefinitionFixture({ blocks: [
            { kind: 'workflow', id: 'nested', workflowRef: childRef, input: {} },
        ] });
        const stored = new Map<string, { run: ReturnType<typeof createWorkflowRunSummaryFixture>; acceptedEnvelope: string }>();
        // Only persistent storage, workspace/Agent availability and mutable source reads
        // are host boundaries; opening, replay, role resolution and admission stay real.
        const owner = createWorkflowAccountRunActionOwner({
            resolveAccountId: async () => 'account-a',
            resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
            normalizeAbsolutePath: (directory) => directory.startsWith('/') ? directory : null,
            randomBytes: () => { throw new Error('plain_account_needs_no_keys'); },
            definitions: { get: async () => { throw new Error('inline_root_has_no_saved_source'); } },
            prepareWorkspace: async () => ({ ok: true, workspaceTarget: ACCEPTED_CONTEXT.workspaceTarget }),
            resolveMaterializationContext: async () => ({ roleSelection: { settingsRoles: liveRoles }, effects: {
                readWorkflowDefinition: async () => liveChild === null ? null : { definition: liveChild, sourceKey: childRef },
                resolveTargetAvailability: async () => true,
            } }),
            storage: { execute: async (operation) => {
                const id = String(operation.runId);
                if (operation.operation === 'get') {
                    const entry = stored.get(id);
                    if (!entry) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
                    return { ...entry, checkpointEnvelope: null, resultEnvelope: null,
                        keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse({
                            runId: id, ownerAccountId: 'account-a', visibleTeamId: null, encryptionMode: 'plain', access: 'owner',
                            ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
                            dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
                        }) };
                }
                if (operation.operation === 'admit') {
                    const run = createWorkflowRunSummaryFixture({ id, ownerAccountId: 'account-a', state: 'queued', origin: { kind: 'direct' } });
                    stored.set(id, { run, acceptedEnvelope: String(operation.acceptedEnvelope) });
                    return { kind: 'created', run };
                }
                if (operation.operation === 'invocations.list') return { invocations: [] };
                throw new Error(`unexpected_storage_operation:${operation.operation}`);
            } },
        });
        const context = { surface: 'ui' as const, authority: 'present_user' as const, callerPermissionMode: 'default',
            externalActionTarget: { kind: 'machine' as const, machineId: 'machine-1',
                project: { machineId: 'machine-1', directory: '/Users/me/project' } } };
        await owner.execute({ actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse({
            runId: originalId, source: { kind: 'inline', definition },
        }), context });
        const original = WorkflowRunGetResultV1Schema.parse(await owner.execute({ actionId: 'workflow.run.get', input: { runId: originalId }, context }));
        expect(original.acceptedContext.materializedLeaves).toEqual(expect.arrayContaining([
            expect.objectContaining({ sourceKey: childRef, role: expect.objectContaining({ instructions: acceptedRole.instructions, workspaceWrites: 'deny' }) }),
        ]));

        for (const sourceState of ['changed', 'deleted'] as const) {
            liveChild = sourceState === 'changed' ? createWorkflowDefinitionFixture({ blocks: [{ ...child.blocks[0], id: 'replacement' }] }) : null;
            liveRoles = sourceState === 'changed' ? { [roleId]: { ...acceptedRole, instructions: 'New instructions', workspaceWrites: 'allow' } } : {};
            startResponse.mockImplementation(async (input: unknown) => owner.execute({ actionId: 'workflow.run.start',
                input: WorkflowRunStartRequestV1Schema.parse(input), context }));
            const screen = await renderRunScreen({ definition: original.definition, acceptedContext: original.acceptedContext,
                run: { ...original.run, state: 'succeeded', workflowCustodyState: 'settled' } });
            const startsBeforeRepeat = runStartCalls().length;
            await screen.pressByTestIdAsync('workflow-run-run-again');
            expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
            await screen.pressByTestIdAsync('workflow-run-inputs-run');
            expect(runStartCalls()).toHaveLength(startsBeforeRepeat + 1);
            const request = WorkflowRunStartRequestV1Schema.parse(runStartCalls().at(-1)?.[1]);
            expect(request.source).toMatchObject({ kind: 'inline', replay: { runId: originalId } });
            const repeat = WorkflowRunGetResultV1Schema.parse(await owner.execute({ actionId: 'workflow.run.get', input: { runId: request.runId }, context }));
            expect(repeat.acceptedContext.frozenChildren).toEqual(original.acceptedContext.frozenChildren);
            expect(repeat.acceptedContext.materializedLeaves).toEqual(original.acceptedContext.materializedLeaves);
            expect(routerSpy.push).toHaveBeenCalledWith(`/workflows/runs/${request.runId}?serverId=${encodeURIComponent(storeState.state.profileScope!.serverId)}`);
            await screen.unmount();
        }
    });

    it('reviews a new Run with one explicit engine replacement after a step loses its agent', async () => {
        restoreRunPopoverGlobals = withPopoverWebGlobals({ frameScheduler: globalThis.requestAnimationFrame });
        routeState.invocationId = '44444444-4444-4444-8444-444444444444';
        const root = createWorkflowInvocationIndexFixture({ id: '33333333-3333-4333-8333-333333333333', lifecycle: 'failed' });
        const step = createWorkflowInvocationIndexFixture({ id: '44444444-4444-4444-8444-444444444444', parentRecordId: '33333333-3333-4333-8333-333333333333', lifecycle: 'failed' });
        detailActions.getInvocation.mockResolvedValue({ invocation: { index: step, parentRevision: 1,
            progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'analyze', scope: [] },
                attempt: '0', logicalInvocationRecordId: step.id,
                blockKind: 'step', reason: { code: 'target_unavailable' } } } });
        const acceptedLeaf = WorkflowMaterializedLeafV1Schema.parse({
                sourceKey: '$root', blockId: 'analyze', kind: 'step', selection: {},
                authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'detached_run' },
        });
        const screen = await renderRunScreen({ run: createWorkflowRunSummaryFixture({ state: 'failed', workflowCustodyState: 'settled' }),
            invocations: [root, step], acceptedContext: { ...ACCEPTED_CONTEXT, materializedLeaves: [acceptedLeaf] } });
        await act(async () => readContentProps()?.onSelectInvocation('44444444-4444-4444-8444-444444444444'));
        await act(async () => {});
        expect(readContentProps()?.selectedInvocationProgress).toMatchObject({ blockKind: 'step', reason: { code: 'target_unavailable' } });
        expect(readContentProps()?.onRunWithAnotherAgent).toEqual(expect.any(Function));
        await screen.pressByTestIdAsync('workflow-run-run-another-agent');
        expect(runStartCalls()).toHaveLength(0);
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('workflow-run-another-agent-chip');
        act(() => invokeTestInstanceHandler(screen.findByProps({ testID: 'workflow-run-another-agent-field' }), 'onChange', {
            agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-6.1-sol',
        }));
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
        act(() => invokeTestInstanceHandler(screen.findByProps({ testID: 'workflow-run-another-agent-field' }), 'onChange', {
            // An unresolved routing id, not a configured ACP definition: the
            // latter now normalizes to a valid canonical custom ACP Agent.
            agentTargetKey: 'backend:unresolved-acp',
        }));
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
        act(() => invokeTestInstanceHandler(screen.findByProps({ testID: 'workflow-run-another-agent-field' }), 'onChange', {
            agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-6.1-sol',
        }));
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(runStartCalls()).toHaveLength(1);
        const request = WorkflowRunStartRequestV1Schema.parse(runStartCalls()[0]?.[1]);
        expect(request.source).toMatchObject({ kind: 'inline', replay: { runId: '11111111-1111-4111-8111-111111111111', agentOverride: {
            sourceKey: '$root', blockId: 'analyze', engine: { agentTarget: {
                kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            }, modelSelection: { ref: { modelId: 'gpt-6.1-sol' } } },
        } } });
        expect(request.executionTarget).toEqual(ACCEPTED_CONTEXT.executionTarget);
        expect(detailActions.retryInvocation).not.toHaveBeenCalled();
        expect(acceptedLeaf.selection).toEqual({});
        expect(request.runId).not.toBe('11111111-1111-4111-8111-111111111111');
    });

    const sourceArtifactId = '1d7ade5a-0ab4-4fca-b38d-e20261c5beaf';
    function sourceGrantReply(access: 'owner' | 'edit' | 'admin' | 'view', artifactId = sourceArtifactId) {
        return { ok: true, result: { artifactId, ownerAccountId: 'account-owner', access, grants: [] } };
    }
    async function sourceArtifact() {
        const { sync } = await import('@/sync/sync');
        const artifact = requireDefined(await sync.fetchArtifactWithBody(sourceArtifactId) ?? undefined, 'Expected the served source Artifact');
        if (!artifact.isDecrypted) throw new Error('Expected the served source Artifact to be readable');
        return artifact;
    }

    it.each(['owner', 'edit', 'admin'] as const)('uses current source %s access for Edit independently of Run control access', async (access) => {
        sourceAccessResponse.mockResolvedValue(sourceGrantReply(access));
        await renderRunScreen({
            run: createWorkflowRunSummaryFixture({ sourceArtifactId }),
            canEdit: false,
        });
        expect(readContentProps()?.hasSource).toBe(true);
        expect(readContentProps()?.sourceAction?.kind).toBe('edit');
        act(() => readContentProps()?.sourceAction?.onPress());
        expect(routerSpy.push).toHaveBeenCalledWith(`/workflows/${sourceArtifactId}`);
        expect(sourceAccessResponse).toHaveBeenCalledWith({ artifactId: sourceArtifactId }, expect.objectContaining({
            serverId: servedHomeId, accountId: 'account-a',
        }));
    });

    it('opens a view-only source even when the Run itself can be controlled', async () => {
        sourceAccessResponse.mockResolvedValue(sourceGrantReply('view'));
        await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        expect(readContentProps()?.sourceAction?.kind).toBe('open');
        act(() => readContentProps()?.sourceAction?.onPress());
        expect(routerSpy.push).toHaveBeenCalledWith(`/workflows/${sourceArtifactId}`);
    });

    it('keeps a deleted source distinct from a sourceless Run', async () => {
        await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        expect(readContentProps()?.hasSource).toBe(true);
        expect(readContentProps()?.sourceAction).toBeNull();
    });

    it.each(['saved', 'automation'] as const)('retains the frozen %s source identity when its summary no longer has an Artifact', async (kind) => {
        await renderRunScreen({ acceptedContext: { ...ACCEPTED_CONTEXT, source: {
            kind, definitionId: sourceArtifactId, revision: { headerVersion: 1, bodyVersion: 1 }, savedBy: null,
            ...(kind === 'automation' ? { automationId: 'automation-1' } : {}),
        } } });
        expect(readContentProps()?.hasSource).toBe(true);
        expect(readContentProps()?.sourceAction).toBeNull();
        expect(sourceAccessResponse).toHaveBeenCalledWith({ artifactId: sourceArtifactId }, expect.anything());
    });

    it.each([false, true])('offers Save as workflow as an unsaved draft retaining the Run Home (qualified=%s)', async (qualified) => {
        if (qualified) routeState.serverId = servedHomeId;
        await renderRunScreen();
        await vi.waitFor(() => expect(readContentProps()?.onSaveAsWorkflow).toBeTypeOf('function'));
        expect(readContentProps()?.hasSource).toBe(false);
        expect(readContentProps()?.sourceAction).toBeNull();
        await act(async () => readContentProps()?.onSaveAsWorkflow?.());
        expect(routerSpy.push).toHaveBeenCalledWith({ pathname: '/workflows/new', params: {
            reviewedRunSeedId: expect.any(String), ...(qualified ? { serverId: servedHomeId } : {}),
        } });
        const route = routerSpy.push.mock.calls.at(-1)?.[0] as { params: { reviewedRunSeedId: string } };
        // The route may use the saved Home alias; the destination rebinds its canonical Account scope.
        expect(readWorkflowReviewedRunSeed(route.params.reviewedRunSeedId,
            qualified ? getStorage().getState().profileScope : undefined)).not.toBeNull();
        if (qualified) expect(readWorkflowReviewedRunSeed(route.params.reviewedRunSeedId,
            { serverId: 'wrong-home', accountId: 'account-a' })).toBeNull();
        expect(sourceAccessResponse).not.toHaveBeenCalled();
        expect(actionTransport.mock.calls.some(([action]) => action === 'workflow.definition.create')).toBe(false);
    });

    function serveCatalogSourceMachine() {
        const machine = createMachineFixture({ id: 'machine-1', storageMode: 'plain', activeAt: Date.now(),
            daemonState: { status: 'running', pid: 17, contributionRegistryProjectionRevision: 0 } });
        getStorage().getState().applyMachines([machine], true, { sourceServerId: servedHomeId });
        // Withdraw after publication so its real ingress observers cannot
        // supply presence to the deliberately misbound case below.
        withdrawMachinePresenceForScope({ serverId: servedHomeId, accountId: 'account-a' });
        // Plugin catalogs are daemon facts, not Artifact HTTP list fields.
        machineRpcSpy.mockImplementation(async ({ method }) => method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ? { protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
                installedPackagesById: { 'com.example': { id: 'com.example', displayName: 'Example', version: '1.0.0',
                    enabled: true, source: { kind: 'path', locator: '/plugins/com.example' } } },
                familiesById: { workflows: { family: 'workflows', entriesById: {
                    'com.example/workflow': { id: 'com.example/workflow', pluginId: 'com.example', pluginVersion: '1.0.0',
                        definition: { id: 'workflow', title: 'Example workflow', definition: DEFINITION } },
                } } },
            }) } : { ok: true });
    }

    it.each(['builtin:review-and-converge', 'plugin:com.example/workflow'])('opens catalog source %s through the existing source route', async (ref) => {
        serveCatalogSourceMachine();
        // A fresh ingress observes this Home's presence after connection setup.
        // A retained row alone no longer admits a catalog carrier (079bd4e056).
        observeMachinePresenceForTest({ serverId: servedHomeId, accountId: 'account-a' }, ['machine-1']);
        await renderRunScreen({ acceptedContext: {
            ...ACCEPTED_CONTEXT, source: { kind: 'catalog', ref, version: 1 },
        } });
        expect(readContentProps()?.hasSource).toBe(true);
        await vi.waitFor(() => expect(readContentProps()?.sourceAction?.kind).toBe('open'));
        act(() => readContentProps()?.sourceAction?.onPress());
        expect(routerSpy.push).toHaveBeenCalledWith(`/workflows/${encodeURIComponent(ref)}`);
        expect(sourceAccessResponse).not.toHaveBeenCalled();
    });

    it('keeps a plugin catalog source unavailable when only another Home has fresh Machine presence', async () => {
        serveCatalogSourceMachine();
        observeMachinePresenceForTest({ serverId: 'other-home', accountId: 'account-a' }, ['machine-1']);
        await renderRunScreen({ acceptedContext: {
            ...ACCEPTED_CONTEXT, source: { kind: 'catalog', ref: 'plugin:com.example/workflow', version: 1 },
        } });
        // Drain the public Action's real saved/plugin phases so an unfinished
        // first page cannot make an incorrectly bound source look unavailable.
        const { listWorkflowDefinitions } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        await act(async () => {
            let page = await listWorkflowDefinitions();
            expect(page.pluginWorkflows ?? []).toEqual([]);
            while (page.nextCursor) {
                page = await listWorkflowDefinitions({ cursor: page.nextCursor });
                expect(page.pluginWorkflows ?? []).toEqual([]);
            }
        });
        expect(readContentProps()?.hasSource).toBe(true);
        expect(readContentProps()?.sourceAction).toBeNull();
        expect(machineRpcSpy.mock.calls.filter(([request]) =>
            request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)).toHaveLength(0);
    });

    it.each(['builtin:removed', 'plugin:com.example/removed'])('hides the action for unavailable catalog source %s', async (ref) => {
        await renderRunScreen({ acceptedContext: {
            ...ACCEPTED_CONTEXT, source: { kind: 'catalog', ref, version: 1 },
        } });
        expect(readContentProps()?.hasSource).toBe(true);
        expect(readContentProps()?.sourceAction).toBeNull();
    });

    it('keeps the saved source action through an ordinary refresh with a pending access read', async () => {
        sourceAccessResponse.mockResolvedValue(sourceGrantReply('owner'));
        await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        expect(readContentProps()?.sourceAction?.kind).toBe('edit');
        detailActions.listInvocations.mockRejectedValue(new Error('offline'));
        await act(async () => publishHomeAccountChange(servedHomeId, ['workflow-run:11111111-1111-4111-8111-111111111111']));
        expect(readContentProps()?.onReload).toBeTypeOf('function');
        const refresh = createDeferred<ReturnType<typeof sourceGrantReply>>();
        sourceAccessResponse.mockReturnValue(refresh.promise);
        await act(async () => readContentProps()?.onReload?.());
        expect(readContentProps()?.sourceAction?.kind).toBe('edit');
        act(() => readContentProps()?.sourceAction?.onPress());
        expect(routerSpy.push).toHaveBeenCalledWith(`/workflows/${sourceArtifactId}`);
        await act(async () => refresh.resolve(sourceGrantReply('view')));
        expect(readContentProps()?.sourceAction?.kind).toBe('open');
    });
    it('keeps confirmed source access while the same source revision gains its opened body', async () => {
        const artifact = await sourceArtifact();
        getStorage().getState().updateArtifact(artifact);
        sourceAccessResponse.mockResolvedValue(sourceGrantReply('owner'));
        await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        const edit = readContentProps()?.sourceAction;
        expect(edit?.kind).toBe('edit');
        const refresh = createDeferred<ReturnType<typeof sourceGrantReply>>();
        sourceAccessResponse.mockReturnValue(refresh.promise);
        // Opening/hydrating already-current content does not change the source or its grant.
        await act(async () => getStorage().getState().updateArtifact({ ...artifact, body: 'Opened source body' }));
        expect(readContentProps()?.sourceAction?.kind).toBe('edit');
        act(() => edit?.onPress());
        expect(routerSpy.push).toHaveBeenCalledWith(`/workflows/${sourceArtifactId}`);
        await act(async () => refresh.resolve(sourceGrantReply('view')));
        expect(readContentProps()?.sourceAction?.kind).toBe('open');
    });
    it('retains confirmed source access through Artifact revisions until a definitive grant answer', async () => {
        const artifact = await sourceArtifact();
        getStorage().getState().updateArtifact(artifact);
        sourceAccessResponse.mockResolvedValue(sourceGrantReply('owner'));
        await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        const edit = readContentProps()?.sourceAction;
        const refresh = createDeferred<ReturnType<typeof sourceGrantReply>>();
        sourceAccessResponse.mockReturnValue(refresh.promise);
        await act(async () => getStorage().getState().updateArtifact({ ...artifact, updatedAt: 2, seq: 2 }));
        expect(readContentProps()?.sourceAction).toBe(edit);
        act(() => edit?.onPress());
        expect(routerSpy.push).toHaveBeenCalledWith(`/workflows/${sourceArtifactId}`);
        routerSpy.push.mockClear();
        await act(async () => refresh.resolve(sourceGrantReply('view')));
        expect(readContentProps()?.sourceAction?.kind).toBe('open');
        act(() => edit?.onPress());
        expect(routerSpy.push).not.toHaveBeenCalled();
    });
    it('retains confirmed source access after transport failure but withdraws it after source removal', async () => {
        const artifact = await sourceArtifact();
        getStorage().getState().updateArtifact(artifact);
        sourceAccessResponse.mockResolvedValue(sourceGrantReply('owner'));
        await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        const edit = readContentProps()?.sourceAction;
        sourceAccessResponse.mockResolvedValue({ ok: false, errorCode: 'network_error', error: 'Offline' });
        await act(async () => getStorage().getState().updateArtifact({ ...artifact, updatedAt: 2, seq: 2 }));
        expect(readContentProps()?.sourceAction).toBe(edit);
        sourceAccessResponse.mockResolvedValue({ ok: false, errorCode: 'artifact_not_found', error: 'Missing' });
        await act(async () => getStorage().getState().deleteArtifact(sourceArtifactId));
        await vi.waitFor(() => expect(readContentProps()?.sourceAction).toBeNull());
        act(() => edit?.onPress());
        expect(routerSpy.push).not.toHaveBeenCalled();
    });
    it('invalidates source actions on source updates/deletion and rejects retained callbacks', async () => {
        const artifact = await sourceArtifact();
        getStorage().setState({ artifacts: { [sourceArtifactId]: artifact } });
        sourceAccessResponse.mockResolvedValue(sourceGrantReply('edit'));
        await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        const edit = readContentProps()?.sourceAction;
        expect(edit?.kind).toBe('edit');
        sourceAccessResponse.mockResolvedValue(sourceGrantReply('view'));
        await act(async () => getStorage().setState({ artifacts: {
            [sourceArtifactId]: { ...artifact, updatedAt: 2, seq: 2 },
        } }));
        act(() => edit?.onPress());
        expect(routerSpy.push).not.toHaveBeenCalled();
        expect(readContentProps()?.sourceAction?.kind).toBe('open');
        const open = readContentProps()?.sourceAction;
        sourceAccessResponse.mockResolvedValue({ ok: false, errorCode: 'artifact_not_found', error: 'artifact_not_found' });
        await act(async () => getStorage().setState({ artifacts: {} }));
        act(() => open?.onPress());
        await vi.waitFor(() => expect(readContentProps()?.sourceAction).toBeNull());
        expect(readContentProps()?.hasSource).toBe(true);
        expect(routerSpy.push).not.toHaveBeenCalled();
    });

    it('fails source actions closed on a mismatched Artifact reply', async () => {
        sourceAccessResponse.mockResolvedValue(sourceGrantReply('owner', 'another-artifact'));
        await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        expect(readContentProps()?.sourceAction).toBeNull();
    });

    it('ignores older source access responses after a source update confirms view access', async () => {
        const older = createDeferred<ReturnType<typeof sourceGrantReply>>();
        const artifact = await sourceArtifact();
        getStorage().setState({ artifacts: { [sourceArtifactId]: artifact } });
        sourceAccessResponse.mockReturnValueOnce(older.promise).mockResolvedValue(sourceGrantReply('view'));
        await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        expect(readContentProps()?.sourceAction).toBeNull();
        await act(async () => getStorage().setState({ artifacts: {
            [sourceArtifactId]: { ...artifact, updatedAt: 2, seq: 2 },
        } }));
        expect(readContentProps()?.sourceAction?.kind).toBe('open');
        await act(async () => older.resolve(sourceGrantReply('owner')));
        expect(readContentProps()?.sourceAction?.kind).toBe('open');
    });

    it('rejects late source access after account retirement', async () => {
        const access = createDeferred<ReturnType<typeof sourceGrantReply>>();
        sourceAccessResponse.mockReturnValue(access.promise);
        const screen = await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        expect(sourceAccessResponse).toHaveBeenCalled();
        expect(readContentProps()?.sourceAction).toBeNull();
        // Install the replacement Account's pending read before the scope
        // notification starts it, so it cannot acknowledge Account A's fixture.
        detailActions.getRun.mockReturnValue(new Promise(() => {}));
        act(() => accountScopeHarness.switchTo({ serverId: 'server-b', accountId: 'account-b' }));
        await screen.update(createRunScreenElement());
        await act(async () => access.resolve(sourceGrantReply('owner')));
        expect(readContentProps()?.sourceAction ?? null).toBeNull();
        expect(screen.findAllHostsByTestId('workflow-run-edit-workflow')).toHaveLength(0);
        expect(routerSpy.push).not.toHaveBeenCalled();
    });

    it('rejects a retained source callback immediately when its Account lifetime retires', async () => {
        sourceAccessResponse.mockResolvedValue(sourceGrantReply('owner'));
        await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        const edit = readContentProps()?.sourceAction;
        expect(edit?.kind).toBe('edit');
        await act(async () => retireActiveServerAccountScopeLifetime());
        act(() => edit?.onPress());
        expect(routerSpy.push).not.toHaveBeenCalled();
        expect(readContentProps()?.sourceAction?.kind).toBe('edit');
        act(() => readContentProps()?.sourceAction?.onPress());
        expect(routerSpy.push).toHaveBeenCalledOnce();
    });

    it('uses exact terminal queries beyond page one and keeps the bounded authoritative result visible', async () => {
        const failed = createWorkflowInvocationIndexFixture({
            id: '99999999-9999-4999-8999-999999999999', sequence: '90', lifecycle: 'failed',
        });
        const definition = createWorkflowDefinitionFixture({
            blocks: [{
                kind: 'step', id: 'publish',
                document: { text: 'Publish', references: [], attachments: [] },
                input: [], result: { kind: 'text' },
            }],
            finalOutput: {
                kind: 'result', producer: { blockId: 'publish', scope: { kind: 'current' } }, path: [],
            },
        });
        const longResult = 'x'.repeat(2_100);
        await renderRunScreen({
            run: createWorkflowRunSummaryFixture({ id: '11111111-1111-4111-8111-111111111111', state: 'succeeded' }),
            definition,
            invocations: [createWorkflowInvocationIndexFixture({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sequence: '1' })],
            failedInvocation: failed,
            historyNextCursor: 'more-history',
            result: longResult,
            finalOutputInvocationId: 'final-off-page',
        });

        expect(detailActions.listInvocations).toHaveBeenCalledWith(
            { runId: '11111111-1111-4111-8111-111111111111', lifecycles: ['failed'], limit: 1 },
            expect.any(AbortSignal),
        );
        expect(readContentProps()?.invocationHistoryComplete).toBe(false);
        expect(readContentProps()?.finalOutputInvocationId).toBe('final-off-page');
        expect(readContentProps()?.firstFailedInvocationId).toBe('99999999-9999-4999-8999-999999999999');
        expect(readContentProps()?.resultLabel).toBe('x'.repeat(2_100));
    });

    it('keeps failure discovery unresolved through loading and error without discarding the result preview', async () => {
        const failedPage = createDeferred<ReturnType<typeof invocationPage>>();
        const run = createWorkflowRunSummaryFixture({ id: '11111111-1111-4111-8111-111111111111', state: 'succeeded' });
        detailActions.getRun.mockResolvedValue({
            run,
            callerAccess: { canEdit: true },
            definition: DEFINITION,
            authoredDefinition: DEFINITION,
            acceptedContext: ACCEPTED_CONTEXT,
            checkpoint: null,
            result: 'Authoritative result preview',
            finalOutputInvocationId: 'inv-final-off-page',
        });
        detailActions.listInvocations.mockImplementation(async (input: Readonly<{ lifecycles?: readonly string[] }>) => (
            input.lifecycles?.length === 1 && input.lifecycles[0] === 'failed'
                ? failedPage.promise
                : invocationPage([])
        ));

        const { WorkflowRunScreen } = await import('./WorkflowRunScreen');
        await renderScreen(createRunScreenElement());
        await act(async () => {});

        expect(readContentProps()?.firstFailedInvocationResolution).toBe('loading');
        expect(readContentProps()?.resultLabel).toBe('Authoritative result preview');

        failedPage.reject(new Error('offline'));
        await act(async () => {});

        expect(readContentProps()?.firstFailedInvocationResolution).toBe('error');
        expect(readContentProps()?.resultLabel).toBe('Authoritative result preview');
    });

    it('keeps an authoritative JSON null result distinct from no result', async () => {
        await renderRunScreen({
            run: createWorkflowRunSummaryFixture({ id: '11111111-1111-4111-8111-111111111111', state: 'succeeded' }),
            result: null,
            finalOutputInvocationId: 'final-null',
        });

        expect(readContentProps()?.resultLabel).toBe('null');
        expect(readContentProps()?.finalOutputInvocationId).toBe('final-null');
    });

    /**
     * A direct Run admitted from an unnamed draft has an opened accepted
     * context with no metadata. That is an untitled Run, not private content
     * this device cannot open; only an unopened context is unavailable.
     */
    it('names an opened untitled Run as a workflow run rather than as unavailable private content', async () => {
        await renderRunScreen({ acceptedContext: ACCEPTED_CONTEXT });
        expect(readContentProps()?.title).toBe('workflows.run.untitled');

        await renderRunScreen({
            acceptedContext: { ...ACCEPTED_CONTEXT, metadata: { title: 'Review 500 files' } },
        });
        expect(readContentProps()?.title).toBe('Review 500 files');
    });

    it('presents aggregate usage through locale-aware token and currency owners', async () => {
        await renderRunScreen({
            usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.04 },
        });

        expect(readContentProps()?.usageLabel).toContain('150');
        expect(readContentProps()?.usageLabel).toContain(new Intl.NumberFormat(undefined, {
            style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4,
        }).format(0.04));
        expect(readContentProps()?.usageLabel).not.toContain(' in');
        expect(readContentProps()?.usageLabel).not.toContain(' out');
    });

    it('keeps a loaded summary visible and exposes the same loader retry when invocation discovery fails', async () => {
        await renderRunScreen({
            run: createWorkflowRunSummaryFixture({ id: '11111111-1111-4111-8111-111111111111', state: 'running' }),
        });

        expect(readContentProps()?.run.id).toBe('11111111-1111-4111-8111-111111111111');
        expect(readContentProps()?.errorLabel).toBeNull();
        detailActions.listInvocations.mockRejectedValue(new Error('offline'));
        await act(async () => publishHomeAccountChange(servedHomeId, ['workflow-run:11111111-1111-4111-8111-111111111111']));
        expect(readContentProps()?.run.id).toBe('11111111-1111-4111-8111-111111111111');
        expect(readContentProps()?.errorLabel).toBeTruthy();
        expect(readContentProps()?.errorSemantics).toBe('alert');
        const reload = readContentProps()?.onReload;
        expect(reload).toBeTypeOf('function');
        detailActions.listInvocations.mockResolvedValue(invocationPage([]));
        await act(async () => reload?.());
        await act(async () => {});

        expect(readContentProps()?.onReload).toBeUndefined();
        expect(readContentProps()?.errorLabel).toBeNull();
        expect(readContentProps()?.invocationsLoaded).toBe(true);
    });

    it('submits the accepted Run identity for a confirmed repeat rather than only its flattened definition', async () => {
        const screen = await renderRunScreen();
        await reviewRunAgain(screen);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(runStartCalls()).toHaveLength(1));
        const request = WorkflowRunStartRequestV1Schema.parse(runStartCalls()[0]?.[1]);
        expect(request.source).toMatchObject({ kind: 'inline', replay: { runId: '11111111-1111-4111-8111-111111111111' } });
    });

    it('starts Another round directly with the accepted inputs only when the definition takes the previous round', async () => {
        const plain = await renderRunScreen();
        expect(plain.findByTestId('workflow-run-another-round')).toBeNull();
        await plain.unmount();
        const rounds = { ...DEFINITION, inputs: [{ name: 'previousRoundContext', valueType: 'json' as const, required: false, default: null }] };
        const screen = await renderRunScreen({ definition: rounds, acceptedContext: { ...ACCEPTED_CONTEXT, inputs: { previousRoundContext: null } } });
        await screen.pressByTestIdAsync('workflow-run-another-round');
        await vi.waitFor(() => expect(runStartCalls()).toHaveLength(1));
        // No review form: the same participants and inputs, with the owner supplying the prior round.
        expect(screen.findByTestId('workflow-run-inputs-run')).toBeNull();
        const request = WorkflowRunStartRequestV1Schema.parse(runStartCalls()[0]?.[1]);
        expect(request.runId).not.toBe('11111111-1111-4111-8111-111111111111');
        expect(request.source).toMatchObject({ kind: 'inline',
            replay: { runId: '11111111-1111-4111-8111-111111111111', intent: 'another_round' } });
    });

    it('shows a typed Another round target refusal on the Run page without replacing the accepted target', async () => {
        startResponse.mockResolvedValue({ ok: false, errorCode: 'target_unavailable', error: 'Target is unavailable' });
        const rounds = { ...DEFINITION, inputs: [{ name: 'previousRoundContext', valueType: 'json' as const, required: false, default: null }] };
        const screen = await renderRunScreen({ definition: rounds, acceptedContext: { ...ACCEPTED_CONTEXT, inputs: { previousRoundContext: null } } });
        await screen.pressByTestIdAsync('workflow-run-another-round');
        await vi.waitFor(() => expect(screen.findHostByTestId('workflow-run-again-refused')).not.toBeNull());
        expect(screen.getTextContent()).toContain('workflows.problem.targetUnavailable');
        expect(routerSpy.push).not.toHaveBeenCalled();
        expect(screen.findByTestId('workflow-run-inputs-run')).toBeNull();
        expect(runStartCalls()).toHaveLength(1);
        const request = WorkflowRunStartRequestV1Schema.parse(runStartCalls()[0]?.[1]);
        expect(request.source).toMatchObject({ kind: 'inline',
            replay: { runId: '11111111-1111-4111-8111-111111111111', intent: 'another_round' } });
        expect(runStartCalls()[0]?.[2]).toMatchObject({ externalActionTarget: {
            kind: 'machine', machineId: ACCEPTED_CONTEXT.machineId,
            project: { machineId: ACCEPTED_CONTEXT.machineId, directory: '/Users/me/project' },
        } });
        expect(request.executionTarget).toEqual(ACCEPTED_CONTEXT.executionTarget);
    });

    it('reuses an unresolved Another round identity after progress has stopped', async () => {
        startResponse.mockRejectedValue(new Error('Start response lost'));
        const rounds = { ...DEFINITION, inputs: [{ name: 'previousRoundContext', valueType: 'json' as const, required: false, default: null }] };
        const screen = await renderRunScreen({ definition: rounds, acceptedContext: { ...ACCEPTED_CONTEXT, inputs: { previousRoundContext: null } } });
        const readRun = detailActions.getRun.getMockImplementation()!;
        detailActions.getRun.mockImplementation(async (id, signal) => {
            if (id !== routeState.runId) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
            return readRun(id, signal);
        });
        await screen.pressByTestIdAsync('workflow-run-another-round');
        await vi.waitFor(() => expect(screen.findHostByTestId('workflow-run-again-refused')).not.toBeNull());
        expect(screen.findHostByTestId('workflow-run-again-pending')).toBeNull();
        const original = WorkflowRunStartRequestV1Schema.parse(runStartCalls()[0]?.[1]);
        await screen.pressByTestIdAsync('workflow-run-another-round');
        await vi.waitFor(() => expect(runStartCalls()).toHaveLength(4));
        expect(runStartCalls().map(([, input]) => WorkflowRunStartRequestV1Schema.parse(input))).toEqual([
            original, original, original, original,
        ]);
        expect(routerSpy.push).not.toHaveBeenCalled();
    });

    it.each([false, true])('retains Another round across Run A to B to A and a remount without merging B intent (addressed: %s)', async (addressed) => {
        routeState.serverId = addressed ? servedHomeId : undefined;
        startResponse.mockRejectedValue(new Error('Start response lost'));
        const rounds = { ...DEFINITION, inputs: [{ name: 'previousRoundContext', valueType: 'json' as const, required: false, default: null }] };
        const acceptedContext = { ...ACCEPTED_CONTEXT, inputs: { previousRoundContext: null } };
        const screen = await renderRunScreen({ definition: rounds, acceptedContext });
        await vi.waitFor(() => expect(screen.findByTestId('workflow-run-another-round')).not.toBeNull());
        const runA = createWorkflowRunSummaryFixture({ id: routeState.runId, state: 'succeeded', origin: { kind: 'direct' } });
        const runB = createWorkflowRunSummaryFixture({ id: '22222222-2222-4222-8222-222222222222', state: 'succeeded', origin: { kind: 'direct' } });
        detailActions.getRun.mockImplementation(async (id) => {
            const run = id === runA.id ? runA : id === runB.id ? runB : null;
            if (!run) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
            return { run, definition: rounds, authoredDefinition: rounds, acceptedContext, checkpoint: null, callerAccess: { canEdit: true } };
        });
        await screen.pressByTestIdAsync('workflow-run-another-round');
        await vi.waitFor(() => expect(screen.findHostByTestId('workflow-run-again-refused')).not.toBeNull());
        const original = WorkflowRunStartRequestV1Schema.parse(runStartCalls()[0]?.[1]);
        routeState.runId = runB.id;
        await screen.update(createRunScreenElement());
        await act(async () => {});
        await screen.pressByTestIdAsync('workflow-run-another-round');
        await vi.waitFor(() => expect(runStartCalls()).toHaveLength(4));
        const fromB = WorkflowRunStartRequestV1Schema.parse(runStartCalls()[2]?.[1]);
        expect(fromB.runId).not.toBe(original.runId);
        expect(fromB.source).toMatchObject({ replay: { runId: runB.id } });
        routeState.runId = runA.id;
        await screen.update(createRunScreenElement());
        await act(async () => {});
        await screen.pressByTestIdAsync('workflow-run-another-round');
        await vi.waitFor(() => expect(runStartCalls()).toHaveLength(6));
        expect(WorkflowRunStartRequestV1Schema.parse(runStartCalls()[4]?.[1])).toEqual(original);
        await screen.unmount();
        const remounted = await renderRunScreen({ run: runA, definition: rounds, acceptedContext });
        await vi.waitFor(() => expect(remounted.findByTestId('workflow-run-another-round')).not.toBeNull());
        detailActions.getRun.mockImplementation(async (id) => {
            if (id !== runA.id) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
            return { run: runA, definition: rounds, authoredDefinition: rounds, acceptedContext, checkpoint: null, callerAccess: { canEdit: true } };
        });
        await remounted.pressByTestIdAsync('workflow-run-another-round');
        await vi.waitFor(() => expect(runStartCalls()).toHaveLength(8));
        expect(WorkflowRunStartRequestV1Schema.parse(runStartCalls()[6]?.[1])).toEqual(original);
        expect(routerSpy.push).not.toHaveBeenCalled();
    });

    it('retains addressed Another round when its binding unmounts before rejoin settles', async () => {
        routeState.serverId = servedHomeId;
        const rejoin = createDeferred<unknown>();
        startResponse.mockRejectedValue(new Error('Start response lost'))
            .mockRejectedValueOnce(new Error('Start response lost')).mockReturnValueOnce(rejoin.promise);
        const rounds = { ...DEFINITION, inputs: [{ name: 'previousRoundContext', valueType: 'json' as const, required: false, default: null }] };
        const acceptedContext = { ...ACCEPTED_CONTEXT, inputs: { previousRoundContext: null } };
        const run = createWorkflowRunSummaryFixture({ id: routeState.runId, state: 'succeeded', origin: { kind: 'direct' } });
        const readRun = async (id: string) => {
            if (id !== run.id) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
            return { run, definition: rounds, authoredDefinition: rounds, acceptedContext, checkpoint: null, callerAccess: { canEdit: true } };
        };
        const screen = await renderRunScreen({ run, definition: rounds, acceptedContext });
        detailActions.getRun.mockImplementation(readRun);
        await vi.waitFor(() => expect(screen.findByTestId('workflow-run-another-round')).not.toBeNull());
        await screen.pressByTestIdAsync('workflow-run-another-round');
        await vi.waitFor(() => expect(runStartCalls()).toHaveLength(2));
        const original = WorkflowRunStartRequestV1Schema.parse(runStartCalls()[0]?.[1]);
        await screen.unmount();
        const remounted = await renderRunScreen({ run, definition: rounds, acceptedContext });
        detailActions.getRun.mockImplementation(readRun);
        await act(async () => { rejoin.reject(new Error('Rejoin response lost')); });
        await vi.waitFor(() => expect(remounted.findHostByTestId('workflow-run-again-refused')).not.toBeNull());
        expect(remounted.findHostByTestId('workflow-run-again-pending')).toBeNull();
        expect(routerSpy.push).not.toHaveBeenCalled();
        await remounted.pressByTestIdAsync('workflow-run-another-round');
        await vi.waitFor(() => expect(runStartCalls()).toHaveLength(4));
        expect(runStartCalls().map(([, input]) => WorkflowRunStartRequestV1Schema.parse(input))).toEqual([
            original, original, original, original,
        ]);
    });

    it('reviews an unresolved Run again as the request it re-sends, read-only, across leaving and returning to the Run', async () => {
        startResponse.mockRejectedValue(new Error('Start response lost'));
        const briefed = { ...DEFINITION, inputs: [{ name: 'brief', valueType: 'string' as const, required: true }] };
        const acceptedContext = { ...ACCEPTED_CONTEXT, inputs: { brief: 'Accepted brief' } };
        const runA = createWorkflowRunSummaryFixture({ id: routeState.runId, state: 'succeeded', origin: { kind: 'direct' } });
        const runB = createWorkflowRunSummaryFixture({ id: '22222222-2222-4222-8222-222222222222', state: 'succeeded', origin: { kind: 'direct' } });
        const readRun = async (id: string) => {
            const run = id === runA.id ? runA : id === runB.id ? runB : null;
            if (!run) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
            return { run, definition: briefed, authoredDefinition: briefed, acceptedContext, checkpoint: null, callerAccess: { canEdit: true } };
        };
        const screen = await renderRunScreen({ run: runA, definition: briefed, acceptedContext });
        detailActions.getRun.mockImplementation(readRun);
        await screen.pressByTestIdAsync('workflow-run-run-again');
        act(() => screen.changeTextByTestId('new-session-composer-input', 'Reviewed brief'));
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.accessibilityLabel).toBe('workflows.start.retry.action'));
        const original = WorkflowRunStartRequestV1Schema.parse(runStartCalls()[0]?.[1]);
        expect(original.inputs).toEqual({ brief: 'Reviewed brief' });
        // What the review shows is what Try again sends: an edit cannot silently diverge from it.
        act(() => screen.changeTextByTestId('new-session-composer-input', 'Edited after the lost reply'));
        expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Reviewed brief');
        expect(screen.findByTestId('workflow-run-inputs-reason-text')?.props.children).toBe('workflows.start.retry.runAgain');
        await screen.unmount();
        // Another Run is its own intent, reviewed with its own editable values.
        routeState.runId = runB.id;
        const other = await renderRunScreen({ run: runB, definition: briefed, acceptedContext });
        detailActions.getRun.mockImplementation(readRun);
        await other.pressByTestIdAsync('workflow-run-run-again');
        expect(other.findByTestId('new-session-composer-input')?.props.value).toBe('Accepted brief');
        expect(other.findByTestId('workflow-run-inputs-run')?.props.accessibilityLabel).toBe('workflows.start.start');
        await other.unmount();
        routeState.runId = runA.id;
        const returned = await renderRunScreen({ run: runA, definition: briefed, acceptedContext });
        detailActions.getRun.mockImplementation(readRun);
        await returned.pressByTestIdAsync('workflow-run-run-again');
        expect(returned.findByTestId('new-session-composer-input')?.props.value).toBe('Reviewed brief');
        const sent = runStartCalls().length;
        await returned.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(runStartCalls().length).toBeGreaterThan(sent));
        expect(WorkflowRunStartRequestV1Schema.parse(runStartCalls()[sent]?.[1])).toEqual(original);
        expect(routerSpy.push).not.toHaveBeenCalled();
    });

    it('keeps Another round its own request while an ordinary Run again is unresolved', async () => {
        startResponse.mockRejectedValue(new Error('Start response lost'));
        const rounds = { ...DEFINITION, inputs: [{ name: 'previousRoundContext', valueType: 'json' as const, required: false, default: null }] };
        const acceptedContext = { ...ACCEPTED_CONTEXT, inputs: { previousRoundContext: null } };
        const screen = await renderRunScreen({ definition: rounds, acceptedContext });
        const readRun = detailActions.getRun.getMockImplementation()!;
        detailActions.getRun.mockImplementation(async (id, signal) => {
            if (id !== routeState.runId) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
            return readRun(id, signal);
        });
        await reviewRunAgain(screen);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.accessibilityLabel).toBe('workflows.start.retry.action'));
        const ordinary = WorkflowRunStartRequestV1Schema.parse(runStartCalls()[0]?.[1]);
        expect(ordinary.source).not.toMatchObject({ replay: { intent: 'another_round' } });
        const sent = runStartCalls().length;
        await screen.pressByTestIdAsync('workflow-run-another-round');
        await vi.waitFor(() => expect(runStartCalls().length).toBeGreaterThan(sent));
        // The pressed control names Another round, so Another round is what is sent, under its own id.
        const round = WorkflowRunStartRequestV1Schema.parse(runStartCalls()[sent]?.[1]);
        expect(round.source).toMatchObject({ replay: { intent: 'another_round' } });
        expect(round.runId).not.toBe(ordinary.runId);
    });

    it('does not let a late Run-again completion navigate after this mounted screen changes Runs', async () => {
        const admission = createDeferred<WorkflowRunStartResultV1>();
        startResponse.mockImplementationOnce(async () => admission.promise);
        const screen = await renderRunScreen();
        await reviewRunAgain(screen);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(runStartCalls()).toHaveLength(1));

        routeState.runId = '22222222-2222-4222-8222-222222222222';
        const runB = createWorkflowRunSummaryFixture({
            id: '22222222-2222-4222-8222-222222222222', state: 'running', origin: { kind: 'direct' },
        });
        detailActions.getRun.mockResolvedValue({
            run: runB,
            callerAccess: { canEdit: true },
            definition: DEFINITION,
            authoredDefinition: DEFINITION,
            acceptedContext: ACCEPTED_CONTEXT,
            checkpoint: null,
        });
        detailActions.listInvocations.mockResolvedValue(invocationPage([]));
        await screen.update(createRunScreenElement());
        await act(async () => {});
        expect(readContentProps()?.run.id).toBe('22222222-2222-4222-8222-222222222222');

        admission.resolve({ admission: 'created', run: createWorkflowRunSummaryFixture({ id: '55555555-5555-4555-8555-555555555555' }) });
        await act(async () => {});

        expect(routerSpy.push).not.toHaveBeenCalled();
    });

    it.each([1440, 390])('opens Save as workflow in the real editor under StrictMode at %i without writing', async (width) => {
        platformViewport.width = width;
        const screen = await renderRunScreen({ acceptedContext: { ...ACCEPTED_CONTEXT, metadata: { title: 'Release review', description: 'Accepted description' } } });
        const saveAsWorkflow = readContentProps()?.onSaveAsWorkflow;

        act(() => { saveAsWorkflow?.(); });
        await act(async () => {});
        const route = routerSpy.push.mock.calls.at(-1)?.[0] as {
            pathname: string; params: { reviewedRunSeedId: string };
        } | undefined;
        expect(route).toEqual({ pathname: '/workflows/new', params: { reviewedRunSeedId: expect.any(String) } });
        if (route === undefined) throw new Error('Expected the unsaved review route');
        expect(machineRpcSpy).not.toHaveBeenCalled();
        expect(readContentProps()?.saveAsWorkflowPending).toBe(false);
        await openEditorAfterRouteHydration(screen, { kind: 'new', reviewedRunSeedId: route.params.reviewedRunSeedId });
        expect(screen.findByTestId('workflow-editor-reviewed-run-missing') === null).toBe(true);
        expect(screen.findByType(WorkflowEditorBody).props).toMatchObject({
            draft: { name: 'Release review', blocks: DEFINITION.blocks },
            description: 'Accepted description',
            projectTarget: ACCEPTED_CONTEXT.workspaceTarget.project,
        });
        expect(readWorkflowReviewedRunSeed(route.params.reviewedRunSeedId)).toBeNull();
        expect(actionTransport.mock.calls.some(([id]) => id === 'workflow.definition.create')).toBe(false);
    });

    it.each(['new-session', 'trigger', 'definition-copy', 'reviewed-run'] as const)('adopts the next %s seed on the same mounted editor', async (kind) => {
        const screen = await renderRunScreen();
        const first = createUnsavedEditorSource(kind, 'First draft');
        const second = createUnsavedEditorSource(kind, 'Second draft');
        const draw = (source: WorkflowEditorSource) => <AppPaneProvider><WorkflowEditorHostScreen source={source} /></AppPaneProvider>;
        await screen.update(draw(first));
        expect(screen.findByType(WorkflowEditorBody).props.draft.blocks[0].name).toBe('First draft');
        await screen.update(draw(second));
        expect(screen.findByType(WorkflowEditorBody).props.draft.blocks[0].name).toBe('Second draft');
        // A committed intake consumes B's original handle, not the already-consumed A handle.
        if (second.kind !== 'new') throw new Error('Expected the unsaved replacement source');
        const secondId = second.reviewedRunSeedId ?? second.newSessionDraftSeedId ?? second.triggerWorkflowSeedId ?? second.definitionDraftSeedId;
        if (secondId === undefined) throw new Error('Expected the replacement seed handle');
        const read = kind === 'new-session' ? readNewSessionAutomationHandoffSeed : kind === 'trigger' ? readTriggerWorkflowSeed
            : kind === 'definition-copy' ? readWorkflowDefinitionDraftSeed : readWorkflowReviewedRunSeed;
        expect(read(secondId)).toBeNull();
    });

    it.each(['new-session', 'trigger', 'definition-copy', 'reviewed-run'] as const)('withdraws the mounted %s seed on same-Account lifetime retirement', async (kind) => {
        const screen = await renderRunScreen();
        const source = createUnsavedEditorSource(kind, 'Private draft');
        await screen.update(<AppPaneProvider><WorkflowEditorHostScreen source={source} /></AppPaneProvider>);
        expect(screen.findByType(WorkflowEditorBody).props.draft.blocks[0].name).toBe('Private draft');
        await act(async () => retireActiveServerAccountScopeLifetime());
        expect(screen.findByTestId('workflow-editor-account-changed')).not.toBeNull();
        expect(actionTransport.mock.calls.some(([id]) => id === 'workflow.definition.create' || id === 'workflow.trigger.update')).toBe(false);
    });

    it('retains a definition copy through speculative editor rendering and refuses reuse after commit', async () => {
        const screen = await renderRunScreen();
        const seedId = storeWorkflowDefinitionDraftSeed({
            name: 'Copied workflow', description: 'Copied description', definition: DEFINITION,
        });
        await openEditorAfterRouteHydration(screen, { kind: 'new', definitionDraftSeedId: seedId });
        expect(screen.findByTestId('workflow-editor-draft-unavailable') === null).toBe(true);
        expect(screen.findByType(WorkflowEditorBody).props).toMatchObject({
            draft: { name: 'Copied workflow', blocks: DEFINITION.blocks }, description: 'Copied description',
        });
        expect(readWorkflowDefinitionDraftSeed(seedId)).toBeNull();
        await screen.unmount();
        const reopened = await renderScreen(<AppPaneProvider>
            <WorkflowEditorHostScreen source={{ kind: 'new', definitionDraftSeedId: seedId }} />
        </AppPaneProvider>);
        expect(reopened.findByTestId('workflow-editor-draft-unavailable')).not.toBeNull();
        expect(actionTransport.mock.calls.some(([id]) => id === 'workflow.definition.create')).toBe(false);
    });

    it.each(['new-session', 'trigger'] as const)('retains the %s unsaved seed through speculative editor rendering', async (kind) => {
        const screen = await renderRunScreen();
        const seedId = kind === 'new-session'
            ? storeNewSessionAutomationHandoffSeed({
                name: 'Captured session', description: 'Session description', enabled: true,
                draft: buildWorkflowEditorDraftFromDefinition({ draftId: 'captured-session', name: 'Captured session', definition: DEFINITION }),
                project: ACCEPTED_CONTEXT.workspaceTarget.project, triggers: [],
            })
            : storeTriggerWorkflowSeed({
                definition: DEFINITION,
                retarget: { scope: 'account', automationId: 'automation-1', expectedRevision: 1 },
            });
        const source: WorkflowEditorSource = kind === 'new-session'
            ? { kind: 'new', newSessionDraftSeedId: seedId }
            : { kind: 'new', triggerWorkflowSeedId: seedId };
        await openEditorAfterRouteHydration(screen, source);
        expect(screen.findByType(WorkflowEditorBody).props.draft.blocks).toEqual(DEFINITION.blocks);
        if (kind === 'new-session') {
            expect(screen.findByType(WorkflowEditorBody).props).toMatchObject({
                draft: { name: 'Captured session' }, description: 'Session description',
                projectTarget: ACCEPTED_CONTEXT.workspaceTarget.project,
            });
            expect(readNewSessionAutomationHandoffSeed(seedId)).toBeNull();
        } else {
            expect(readTriggerWorkflowSeed(seedId)).toBeNull();
        }
        expect(actionTransport.mock.calls.some(([id]) => id === 'workflow.definition.create' || id === 'workflow.trigger.update')).toBe(false);
    });

    it.each(['new-session', 'trigger'] as const)('refuses the %s handoff after its Account lifetime retires', async (kind) => {
        await renderRunScreen();
        const seedId = kind === 'new-session'
            ? storeNewSessionAutomationHandoffSeed({
                name: 'Captured session', description: null, enabled: true,
                draft: buildWorkflowEditorDraftFromDefinition({ draftId: 'captured-session', name: 'Captured session', definition: DEFINITION }),
                project: null, triggers: [],
            })
            : storeTriggerWorkflowSeed({
                definition: DEFINITION, retarget: { scope: 'account', automationId: 'automation-1', expectedRevision: 1 },
            });
        const read = kind === 'new-session' ? readNewSessionAutomationHandoffSeed : readTriggerWorkflowSeed;
        expect(readWorkflowReviewedRunSeed(seedId)).toBeNull();
        await act(async () => retireActiveServerAccountScopeLifetime());
        expect(read(seedId) === null).toBe(true);
    });

    /**
     * Leaving the Run detail is the same question as changing Runs on it.
     *
     * The repeat was admitted, so it is never discarded; but this screen is gone
     * and pushing its route would take over whatever the person opened instead.
     */
    it('does not let a late Run-again completion navigate after this screen closes', async () => {
        const admission = createDeferred<WorkflowRunStartResultV1>();
        startResponse.mockImplementationOnce(async () => admission.promise);
        const screen = await renderRunScreen();
        await reviewRunAgain(screen);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(runStartCalls()).toHaveLength(1));

        await screen.unmount();

        admission.resolve({ admission: 'created', run: createWorkflowRunSummaryFixture({ id: '66666666-6666-4666-8666-666666666666' }) });
        await act(async () => {});

        expect(routerSpy.push).not.toHaveBeenCalled();
    });

    /**
     * A destructive control is held to the same fence as navigation: once the
     * screen is gone, the deletion it was collecting consent for neither retires
     * the shared row nor pops a route this screen no longer owns.
     */
    it('does not let a late delete completion retire the shared row or navigate back after this screen closes', async () => {
        const deletion = createDeferred<Readonly<{ deleted: true; runId: string }>>();
        detailActions.deleteRun.mockImplementationOnce(async () => deletion.promise);
        const screen = await renderRunScreen({
            run: createWorkflowRunSummaryFixture({
                id: '11111111-1111-4111-8111-111111111111',
                state: 'succeeded',
                origin: { kind: 'direct' },
                workflowCustodyState: 'settled',
                availability: { cancel: false, pause: false },
            }),
        });
        const onDelete = readContentProps()?.onDelete;
        expect(onDelete).toBeTypeOf('function');

        act(() => { onDelete?.(); });
        await act(async () => {});
        await screen.pressByTestIdAsync('web-modal-confirm');
        await vi.waitFor(() => expect(detailActions.deleteRun).toHaveBeenCalledTimes(1));

        await screen.unmount();

        deletion.resolve({ deleted: true, runId: '11111111-1111-4111-8111-111111111111' });
        await act(async () => {});

        expect(routerSpy.back).not.toHaveBeenCalled();
        expect(storeState.state.workflowRunsById[workflowRunStoreKey('11111111-1111-4111-8111-111111111111')]).toBeDefined();
    });

    it('repeats a Run under exactly the execution target its accepted context froze', async () => {
        const screen = await renderRunScreen();
        expect(readContentProps()?.onRunAgain).toBeTypeOf('function');
        await reviewRunAgain(screen);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(runStartCalls()).toHaveLength(1));
        expect(runStartCalls()[0]?.[1]).toMatchObject({
            executionTarget: { kind: 'detached_run' },
        });
        expect(runStartCalls()[0]?.[2]).toMatchObject({
            externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { directory: '/Users/me/project' } },
        });
        const admittedId = WorkflowRunStartRequestV1Schema.parse(runStartCalls()[0]?.[1]).runId;
        expect(storeState.state.workflowRunsById[workflowRunStoreKey(admittedId)]?.summary).toMatchObject({ id: admittedId, state: 'queued' });
        expect(routerSpy.push).toHaveBeenCalledWith(`/workflows/runs/${admittedId}?serverId=${encodeURIComponent(storeState.state.profileScope!.serverId)}`);
    });

    it('supplies the derived structural identity of unopened rows to the shared Run body', async () => {
        await renderRunScreen({
            run: createWorkflowRunSummaryFixture({ id: '11111111-1111-4111-8111-111111111111', state: 'running', origin: { kind: 'direct' } }),
            invocations: [
                createWorkflowInvocationIndexFixture({ id: '33333333-3333-4333-8333-333333333333', parentRecordId: null, memberOrdinal: '0', sequence: '0' }),
                createWorkflowInvocationIndexFixture({ id: '44444444-4444-4444-8444-444444444444', parentRecordId: '33333333-3333-4333-8333-333333333333', memberOrdinal: '0', sequence: '1' }),
            ],
        });

        expect(readContentProps()?.invocationStructure?.get('44444444-4444-4444-8444-444444444444')).toMatchObject({
            nodeId: 'analyze',
            blockId: 'analyze',
        });
    });

    it.each([
        'workspace_unavailable',
        'conversation_workspace_mismatch',
        'source_workspace_unavailable',
        'committed_revision_unavailable',
        'workspace_conflict',
        'scm_unavailable',
    ] as const)('offers a reviewed new Run — never a silent repeat — for %s', async (code) => {
        const invocations = [
            createWorkflowInvocationIndexFixture({ id: '33333333-3333-4333-8333-333333333333', parentRecordId: null, memberOrdinal: '0', sequence: '0' }),
            createWorkflowInvocationIndexFixture({
                id: '44444444-4444-4444-8444-444444444444', parentRecordId: '33333333-3333-4333-8333-333333333333', memberOrdinal: '0', sequence: '1', lifecycle: 'needs_attention',
            }),
        ];
        detailActions.getInvocation.mockResolvedValue({
            invocation: {
                index: invocations[1],
                parentRevision: 1,
                progress: {
                    kind: 'happier.workflow-progress.v1',
                    invocationPath: { blockId: 'analyze', scope: [] },
                    blockKind: 'step',
                    attempt: '0',
                    logicalInvocationRecordId: '44444444-4444-4444-8444-444444444444',
                    reason: { code },
                },
            },
        });
        await renderRunScreen({
            run: createWorkflowRunSummaryFixture({
                id: '11111111-1111-4111-8111-111111111111', state: 'interrupted', origin: { kind: 'direct' },
                // Nothing is waiting for a stop to be confirmed, so the reviewed
                // new Run is genuinely reachable rather than blocked behind
                // `workflow_outcome_unresolved`.
                workflowCustodyState: 'settled',
                availability: { cancel: false, pause: false },
            }),
            invocations,
        });
        await act(async () => readContentProps()?.onSelectInvocation('44444444-4444-4444-8444-444444444444'));
        await act(async () => {});

        expect(readContentProps()?.onStartReviewedNewRun).toBeTypeOf('function');
        // Exactly one D4 arm: no restoration producer exists here, so the screen
        // hands down no restore handler either.
        expect(readContentProps()?.onRestoreWorkspace).toBeUndefined();
        await act(async () => requireDefined(
            readContentProps()?.onStartReviewedNewRun,
            'Expected a reviewed-new-Run handler',
        )());
        await act(async () => {});

        // When exact restoration is unavailable, D4 opens a reviewed new Run.
        // Nothing may be admitted before the person presses Run there.
        expect(runStartCalls()).toHaveLength(0);
        const route = routerSpy.push.mock.calls.at(-1)?.[0] as {
            pathname: string; params: { reviewedRunSeedId: string };
        } | undefined;
        expect(route).toMatchObject({ pathname: '/workflows/new', params: { reviewedRunSeedId: expect.any(String) } });
        if (route === undefined) throw new Error('Expected the reviewed Run route');
        expect(readWorkflowReviewedRunSeed(route.params.reviewedRunSeedId)).toMatchObject({
            definition: DEFINITION, supersededRunId: '11111111-1111-4111-8111-111111111111',
        });
    });

    it('restores the selected invocation workspace on the Run Machine without silently starting a new Run', async () => {
        const invocations = [
            createWorkflowInvocationIndexFixture({ id: '33333333-3333-4333-8333-333333333333', parentRecordId: null, memberOrdinal: '0', sequence: '0' }),
            createWorkflowInvocationIndexFixture({
                id: '44444444-4444-4444-8444-444444444444', parentRecordId: '33333333-3333-4333-8333-333333333333', memberOrdinal: '0', sequence: '1', lifecycle: 'failed',
            }),
        ];
        detailActions.getInvocation.mockResolvedValue({
            invocation: {
                index: invocations[1],
                parentRevision: 1,
                progress: {
                    kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'analyze', scope: [] },
                    blockKind: 'step', attempt: '0', logicalInvocationRecordId: '44444444-4444-4444-8444-444444444444',
                    reason: { code: 'workspace_unavailable' },
                    recovery: {
                        conversation: 'fresh_agent',
                        input: {
                            kind: 'replacement',
                            value: {
                                document: { text: 'work', references: [], attachments: [] },
                                input: ['recorded context'],
                            },
                        },
                    },
                    workspace: {
                        creationIntent: {
                            kind: 'git_worktree', sourceDirectory: '/Users/me/project', baseRef: 'a'.repeat(40),
                            displayName: 'workflow-analyze', branchMode: 'new',
                        },
                        descriptor: {
                            machineId: 'machine-1', directory: '/Users/me/project/.worktrees/workflow-analyze',
                            checkoutRootPath: '/Users/me/project/.worktrees/workflow-analyze',
                            checkout: { kind: 'git_worktree', branchName: 'workflow-analyze' },
                        },
                    },
                },
                recoveryAvailability: {
                    reattach: { kind: 'unavailable', reason: 'execution_not_admitted' },
                    retry: { kind: 'unavailable', reason: 'workspace_unavailable' },
                    continueSameConversation: { kind: 'unavailable', reason: 'workspace_unavailable' },
                    continueFreshAgent: { kind: 'unavailable', reason: 'workspace_unavailable' },
                    restoreWorkspace: { kind: 'available' },
                },
            },
        });
        keyInvocationReads(invocations);
        const run = createWorkflowRunSummaryFixture({ sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
            id: '11111111-1111-4111-8111-111111111111', state: 'interrupted', revision: 1, machineId: 'machine-1', origin: { kind: 'direct' },
            workflowCustodyState: 'settled',
            availability: { cancel: false, pause: false, restoreWorkspace: true },
        });
        detailActions.restoreWorkspace.mockResolvedValue({ run: { ...run, state: 'running', revision: 2 }, intent: 'resumed' });
        await renderRunScreen({ run, invocations });
        await act(async () => readContentProps()?.onSelectInvocation('44444444-4444-4444-8444-444444444444'));
        await act(async () => {});

        expect(readContentProps()?.onRestoreWorkspace).toBeTypeOf('function');
        // Restoration resumes this Run, so the arm that would repeat its
        // completed work is not offered beside it.
        expect(readContentProps()?.onStartReviewedNewRun).toBeUndefined();
        await act(async () => readContentProps()?.onRestoreWorkspace?.());
        await act(async () => {});

        expect(detailActions.restoreWorkspace).toHaveBeenCalledWith({
            mode: 'recover', runId: '11111111-1111-4111-8111-111111111111', expectedRevision: 1,
            invocations: [{
                kind: 'restore_workspace', invocation: { recordId: '44444444-4444-4444-8444-444444444444' },
                conversation: 'fresh_agent',
                input: {
                    kind: 'replacement',
                    value: {
                        document: { text: 'work', references: [], attachments: [] },
                        input: ['recorded context'],
                    },
                },
            }],
        }, 'machine-1', undefined);
        expect(runStartCalls()).toHaveLength(0);
        expect(routerSpy.push).not.toHaveBeenCalledWith(expect.objectContaining({ pathname: '/workflows/new' }));
    });

    it('requires acknowledgement of an uncertain prior attempt before it will submit a retry', async () => {
        const invocations = [
            createWorkflowInvocationIndexFixture({ id: '33333333-3333-4333-8333-333333333333', parentRecordId: null, memberOrdinal: '0', sequence: '0', lifecycle: 'failed' }),
            createWorkflowInvocationIndexFixture({
                id: '44444444-4444-4444-8444-444444444444', parentRecordId: '33333333-3333-4333-8333-333333333333', memberOrdinal: '0', sequence: '1', lifecycle: 'needs_attention',
            }),
        ];
        detailActions.getInvocation.mockResolvedValue({
            invocation: {
                index: invocations[1],
                parentRevision: 1,
                progress: {
                    kind: 'happier.workflow-progress.v1',
                    invocationPath: { blockId: 'analyze', scope: [] },
                    blockKind: 'step',
                    attempt: '0',
                    logicalInvocationRecordId: '44444444-4444-4444-8444-444444444444',
                    uncertainPriorEffects: { activity: 'stopped' },
                    execution: { kind: 'detached_run', runId: 'retained-retry-execution', localInputId: 'retained-retry-input', runtimeSelection: {} },
                },
                recoveryAvailability: {
                    reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
                    retry: { kind: 'available', causalInvocationIds: ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'] },
                    continueSameConversation: { kind: 'available' },
                    continueFreshAgent: { kind: 'unavailable', reason: 'recovery_not_prepared' },
                    restoreWorkspace: { kind: 'unavailable', reason: 'recovery_not_prepared' },
                },
            },
        });
        detailActions.retryInvocation.mockResolvedValue({
            run: createWorkflowRunSummaryFixture({ id: '11111111-1111-4111-8111-111111111111', state: 'running' }),
            invocation: invocations[1], disposition: 'accepted',
        });
        nativeRecoveryEvidence.set(invocations[1]!.id, { activity: 'not_active', canReattach: true, canContinueConversation: true });
        keyInvocationReads(invocations);
        await renderRunScreen({
            run: createWorkflowRunSummaryFixture({
                id: '11111111-1111-4111-8111-111111111111', state: 'interrupted', origin: { kind: 'direct' },
                availability: { cancel: false, pause: false },
            }),
            invocations,
        });
        await act(async () => readContentProps()?.onSelectInvocation('44444444-4444-4444-8444-444444444444'));
        await act(async () => {});

        const replacement = {
            conversation: 'same_conversation' as const,
            document: { text: 'Retry the reviewed objective', references: [], attachments: [] },
            input: ['reviewed context'],
        };
        expect(nativeRecoveryReads).toContain(invocations[1]!.id);
        await act(async () => requireDefined(
            readContentProps()?.onRetryWithReplacement,
            'Expected a same-conversation replacement retry handler',
        )(replacement));
        await act(async () => {});
        expect(detailActions.retryInvocation).not.toHaveBeenCalled();

        await act(async () => requireDefined(
            readContentProps()?.onAcknowledgeUncertainPriorEffects,
            'Expected an uncertain-effects acknowledgement handler',
        )());
        await act(async () => requireDefined(
            readContentProps()?.onRetryWithReplacement,
            'Expected a same-conversation replacement retry handler',
        )(replacement));
        await act(async () => {});
        expect(detailActions.retryInvocation).toHaveBeenCalledTimes(1);
        expect(detailActions.retryInvocation.mock.calls[0]?.[0]).toMatchObject({
            acknowledgeUncertainPriorEffects: true,
            causalInvocationIds: ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'],
            conversation: 'same_conversation',
            input: {
                kind: 'replacement',
                value: { document: replacement.document, input: replacement.input },
            },
        });
    });

    it.each(['action', 'if', 'loop'] as const)('retries a recoverable %s with the owner\'s causal set, its original input and no replacement', async (blockKind) => {
        const rootId = '66666666-6666-4666-8666-666666666666';
        const selectedId = '44444444-4444-4444-8444-444444444444';
        const invocations = [
            createWorkflowInvocationIndexFixture({ id: rootId, sequence: '0', lifecycle: 'failed' }),
            createWorkflowInvocationIndexFixture({ id: selectedId, parentRecordId: rootId, sequence: '1', lifecycle: 'failed' }),
        ];
        const causalInvocationIds = [rootId, selectedId];
        const notPrepared = { kind: 'unavailable' as const, reason: 'recovery_not_prepared' as const };
        detailActions.getInvocation.mockResolvedValue({
            invocation: {
                index: invocations[1],
                parentRevision: 1,
                progress: {
                    kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'projector', scope: [] },
                    blockKind, attempt: '0', logicalInvocationRecordId: selectedId,
                },
                recoveryAvailability: {
                    reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
                    retry: { kind: 'available', causalInvocationIds },
                    continueSameConversation: notPrepared, continueFreshAgent: notPrepared, restoreWorkspace: notPrepared,
                },
            },
        });
        detailActions.retryInvocation.mockResolvedValue({
            run: createWorkflowRunSummaryFixture({ id: '11111111-1111-4111-8111-111111111111', state: 'running' }),
            invocation: invocations[1], disposition: 'accepted',
        });
        keyInvocationReads(invocations);
        await renderRunScreen({
            run: createWorkflowRunSummaryFixture({
                id: '11111111-1111-4111-8111-111111111111', state: 'interrupted', origin: { kind: 'direct' },
                availability: { cancel: false, pause: false },
            }),
            invocations,
        });
        await act(async () => readContentProps()?.onSelectInvocation(selectedId));
        await act(async () => {});

        // No Agent conversation belongs to this invocation, so none of its handlers is wired.
        expect(readContentProps()?.onRetrySameConversation).toBeUndefined();
        expect(readContentProps()?.onRetryFreshAgent).toBeUndefined();
        expect(readContentProps()?.onRetryWithReplacement).toBeUndefined();
        await act(async () => requireDefined(readContentProps()?.onRetry, 'Expected a plain Retry handler')());
        await act(async () => {});
        expect(detailActions.retryInvocation).toHaveBeenCalledTimes(1);
        expect(detailActions.retryInvocation.mock.calls[0]?.[0]).toMatchObject({
            runId: '11111111-1111-4111-8111-111111111111',
            expectedRevision: 1,
            invocation: { recordId: selectedId },
            causalInvocationIds,
            input: { kind: 'original' },
        });
    });

    it('wires no plain Retry for an Agent step', async () => {
        const rootId = '66666666-6666-4666-8666-666666666666';
        const selectedId = '44444444-4444-4444-8444-444444444444';
        const invocations = [
            createWorkflowInvocationIndexFixture({ id: rootId, sequence: '0', lifecycle: 'failed' }),
            createWorkflowInvocationIndexFixture({ id: selectedId, parentRecordId: rootId, sequence: '1', lifecycle: 'failed' }),
        ];
        detailActions.getInvocation.mockResolvedValue({
            invocation: {
                index: invocations[1],
                parentRevision: 1,
                progress: {
                    kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'analyze', scope: [] },
                    blockKind: 'step', attempt: '0', logicalInvocationRecordId: selectedId,
                },
                recoveryAvailability: {
                    reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
                    retry: { kind: 'available', causalInvocationIds: [rootId, selectedId] },
                    continueSameConversation: { kind: 'unavailable', reason: 'recovery_not_prepared' },
                    continueFreshAgent: { kind: 'available' },
                    restoreWorkspace: { kind: 'unavailable', reason: 'recovery_not_prepared' },
                },
            },
        });
        keyInvocationReads(invocations);
        await renderRunScreen({
            run: createWorkflowRunSummaryFixture({
                id: '11111111-1111-4111-8111-111111111111', state: 'interrupted', origin: { kind: 'direct' },
                availability: { cancel: false, pause: false },
            }),
            invocations,
        });
        await act(async () => readContentProps()?.onSelectInvocation(selectedId));
        await act(async () => {});
        expect(readContentProps()?.onRetry).toBeUndefined();
        expect(readContentProps()?.onRetryFreshAgent).toBeDefined();
    });

    it.each(['unknown', 'offline', 'unavailable', 'denied', 'supplemental503', 'supplemental403', 'supplementalCancelled', 'supplementalRetired', 'supplementalFocusRetired'] as const)('keeps recovery content readable without inventing native continuation evidence (%s)', async (state) => {
        const root = createWorkflowInvocationIndexFixture({ id: '33333333-3333-4333-8333-333333333333', lifecycle: 'failed' });
        const step = createWorkflowInvocationIndexFixture({ id: '44444444-4444-4444-8444-444444444444',
            parentRecordId: root.id, sequence: '1', lifecycle: 'needs_attention' });
        detailActions.getInvocation.mockResolvedValue({ invocation: { index: step, parentRevision: 1,
            progress: { kind: 'happier.workflow-progress.v1', blockKind: 'step', attempt: '0', logicalInvocationRecordId: step.id,
                invocationPath: { blockId: 'analyze', scope: [] }, uncertainPriorEffects: { activity: 'stopped' },
                execution: { kind: 'detached_run', runId: 'unobserved-execution', localInputId: 'unobserved-input', runtimeSelection: {} },
                recovery: { conversation: 'same_conversation', input: { kind: 'replacement', value: {
                    document: { text: 'Retained objective', references: [], attachments: [] }, input: [],
                } } },
            },
            // Stored availability is deliberately optimistic: it is never native evidence.
            recoveryAvailability: { retry: { kind: 'available', causalInvocationIds: [root.id, step.id] },
                reattach: { kind: 'available' }, continueSameConversation: { kind: 'available' },
                continueFreshAgent: { kind: 'available' }, restoreWorkspace: { kind: 'unavailable', reason: 'workspace_unavailable' } },
        } });
        keyInvocationReads([root, step]);
        nativeRecoveryFailure = state === 'unavailable' ? 'target_unavailable' : state === 'denied' ? 'run_access_denied' : null;
        supplementalRecoveryLookupFailure = state === 'supplemental403' ? 403 : state.startsWith('supplemental') ? 503 : null;
        await renderRunScreen({ run: createWorkflowRunSummaryFixture({ state: 'interrupted', origin: { kind: 'direct' },
            availability: { cancel: false, pause: false } }), invocations: [root, step] });
        if (state === 'offline') await act(async () => {
            recordMachineRequestFailed({ serverId: requireDefined(accountConnection ?? undefined, 'Expected the restored Account').serverId,
                accountId: 'account-a', machineId: 'machine-1' });
        });
        if (state === 'supplementalCancelled' || state === 'supplementalRetired' || state === 'supplementalFocusRetired') {
            const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
            const { createUiWorkflowAction } = await import('@/sync/ops/actions/workflowActionDeps');
            const account = await captureLazyActionAccountContext(servedHomeId);
            const controller = new AbortController();
            supplementalRecoveryLookupEffect = state === 'supplementalCancelled'
                ? () => controller.abort()
                : state === 'supplementalFocusRetired' ? () => retireActiveServerAccountScopeLifetime()
                : () => TokenStorage.removeCredentialsForServerUrl('https://server-a', { serverId: servedHomeId });
            try {
                await act(async () => {
                    const response = createUiWorkflowAction({ account })({ actionId: 'workflow.run.invocations.get',
                        input: { runId: step.runId, invocationId: step.id }, signal: controller.signal,
                        context: { surface: 'ui', authority: 'present_user', serverId: servedHomeId, runtimeAccountId: 'account-a' } });
                    if (state === 'supplementalCancelled') await expect(response).rejects.toBeInstanceOf(Error);
                    // Explicit Home Actions survive focused Sync retirement, but never credential withdrawal.
                    else if (state === 'supplementalFocusRetired') await expect(response).resolves.toMatchObject({ invocation: { index: { id: step.id } } });
                    else await expect(response).resolves.toEqual({ ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' });
                });
                expect(supplementalRecoveryLookupFailures).toEqual([503]);
                expect(nativeRecoveryReads).toEqual([]);
            } finally { account.dispose(); }
            return;
        }
        await act(async () => readContentProps()?.onSelectInvocation(step.id));
        await act(async () => {});
        if (state === 'supplemental403') {
            expect(supplementalRecoveryLookupFailures).toEqual([403]);
            expect(readContentProps()?.selectedInvocationProgress?.recovery).toBeUndefined();
            expect(readContentProps()?.selectedInvocationProgress?.execution).toBeUndefined();
            expect(nativeRecoveryReads).toEqual([]);
            return;
        }
        expect(readContentProps()?.selectedInvocationProgress?.recovery).toMatchObject({ input: { value: {
            document: { text: 'Retained objective' },
        } } });
        expect(readContentProps()?.selectedInvocationRecoveryAvailability?.continueSameConversation.kind).toBe('unavailable');
        if (state === 'supplemental503') expect(supplementalRecoveryLookupFailures).toEqual([503]);
        if (state === 'unknown') expect(nativeRecoveryReads).toContain(step.id);
        else expect(nativeRecoveryReads).toEqual([]);
        expect(detailActions.retryInvocation).not.toHaveBeenCalled();
    });

    it('submits a prepared continuation with every reviewed causal row and replacement input', async () => {
        const rootId = '66666666-6666-4666-8666-666666666666';
        const groupId = '33333333-3333-4333-8333-333333333333';
        const branchA = '55555555-5555-4555-8555-555555555555';
        const branchB = '99999999-9999-4999-8999-999999999999';
        const invocations = [
            createWorkflowInvocationIndexFixture({ id: rootId, sequence: '0', lifecycle: 'failed' }),
            createWorkflowInvocationIndexFixture({ id: groupId, parentRecordId: rootId, sequence: '1', lifecycle: 'failed' }),
            createWorkflowInvocationIndexFixture({ id: branchA, parentRecordId: groupId, sequence: '2', lifecycle: 'failed' }),
            createWorkflowInvocationIndexFixture({ id: branchB, parentRecordId: groupId, memberOrdinal: '1', sequence: '3', lifecycle: 'cancelled' }),
            createWorkflowInvocationIndexFixture({
                id: '44444444-4444-4444-8444-444444444444', parentRecordId: branchA, memberOrdinal: '0', sequence: '4', lifecycle: 'failed',
            }),
            createWorkflowInvocationIndexFixture({
                id: '88888888-8888-4888-8888-888888888888', parentRecordId: branchB, memberOrdinal: '0', sequence: '5', lifecycle: 'cancelled',
            }),
        ];
        const causalInvocationIds = [groupId, branchA, branchB, invocations[4]!.id, invocations[5]!.id];
        const branchScope = (branchId: string) => [{ kind: 'branch' as const, blockId: 'panel', branchId }];
        const progressById = new Map(invocations.map(index => [index.id, WorkflowProgressEnvelopeV1Schema.parse({
            kind: 'happier.workflow-progress.v1', attempt: index.attempt, logicalInvocationRecordId: index.id,
            ...(index.id === rootId ? { blockKind: 'root', invocationPath: { blockId: '$root', scope: [] } }
                : index.id === groupId ? { blockKind: 'parallel', invocationPath: { blockId: 'panel', scope: [] },
                    container: { kind: 'parallel', nextBranchOrdinal: '2' } }
                : index.id === branchA || index.id === branchB ? { blockKind: 'parallel',
                    invocationPath: { blockId: 'panel', scope: branchScope(index.id === branchA ? 'analysis' : 'migration-lane') },
                    frame: { ownerBlockId: 'panel', source: { kind: 'branch', branchId: index.id === branchA ? 'analysis' : 'migration-lane' } },
                    container: { kind: 'body', nextBlockOrdinal: '0' },
                    ...(index.id === branchB ? { reason: { code: `container_fail_stop:${groupId}` } } : {}) }
                : { blockKind: 'step', invocationPath: { blockId: 'migration', scope: branchScope('migration-lane') },
                    reason: { code: `container_fail_stop:${groupId}` },
                    execution: { kind: 'detached_run', runId: 'retained-migration-execution', localInputId: 'retained-migration-input', runtimeSelection: {} } }),
        })]));
        const definition = createWorkflowDefinitionFixture({ blocks: [{
            kind: 'parallel', id: 'panel', failurePolicy: 'fail_stop', branches: [
                { id: 'analysis', blocks: DEFINITION.blocks },
                { id: 'migration-lane', blocks: [{ ...DEFINITION.blocks[0]!, id: 'migration' }] },
            ],
        }] });
        detailActions.getInvocation.mockResolvedValue({
            invocation: {
                index: invocations[4],
                parentRevision: 1,
                progress: {
                    kind: 'happier.workflow-progress.v1',
                    invocationPath: { blockId: 'analyze', scope: branchScope('analysis') },
                    blockKind: 'step',
                    attempt: '0',
                    logicalInvocationRecordId: '44444444-4444-4444-8444-444444444444',
                    execution: { kind: 'detached_run', runId: 'retained-prepared-execution', localInputId: 'retained-prepared-input', runtimeSelection: {} },
                    recovery: {
                        conversation: 'same_conversation',
                        input: {
                            kind: 'replacement',
                            value: {
                                document: { text: 'Continue the prepared objective', references: [], attachments: [] },
                                input: ['recorded context'],
                            },
                        },
                    },
                },
                recoveryAvailability: {
                    reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
                    retry: { kind: 'available', causalInvocationIds },
                    continueSameConversation: { kind: 'available' },
                    continueFreshAgent: { kind: 'unavailable', reason: 'recovery_not_prepared' },
                    restoreWorkspace: { kind: 'unavailable', reason: 'recovery_not_prepared' },
                },
            },
        });
        detailActions.resumeRun.mockResolvedValue({
            run: createWorkflowRunSummaryFixture({ id: '11111111-1111-4111-8111-111111111111', state: 'running' }),
            intent: 'resumed',
        });
        detailActions.retryInvocation.mockResolvedValue({
            run: createWorkflowRunSummaryFixture({ id: '11111111-1111-4111-8111-111111111111', state: 'running' }),
            invocation: invocations[4], disposition: 'accepted',
        });
        for (const index of invocations.slice(4)) nativeRecoveryEvidence.set(index.id,
            { activity: 'not_active', canReattach: true, canContinueConversation: true });
        keyInvocationReads(invocations, progressById);
        const screen = await renderRunScreen({
            definition,
            run: createWorkflowRunSummaryFixture({
                id: '11111111-1111-4111-8111-111111111111', state: 'interrupted', origin: { kind: 'direct' },
                availability: { cancel: false, pause: false },
            }),
            invocations,
        });
        await act(async () => readContentProps()?.onSelectInvocation('44444444-4444-4444-8444-444444444444'));
        await act(async () => {});

        expect(readContentProps(), screen.getTextContent()).not.toBeNull();
        expect(readContentProps()?.selectedInvocationRecoveryAvailability).toMatchObject({ continueSameConversation: { kind: 'available' } });
        expect(readContentProps()?.preparedRecovery).toMatchObject({ conversation: 'same_conversation' });
        await act(async () => requireDefined(
            readContentProps()?.onContinuePrepared,
            'Expected a prepared-continuation handler',
        )({
            conversation: 'same_conversation',
            document: { text: 'Continue, but skip the migration step', references: [], attachments: [] },
            input: ['recorded context'],
        }));
        await act(async () => {});

        expect(detailActions.resumeRun).not.toHaveBeenCalled();
        expect(detailActions.retryInvocation).toHaveBeenCalledTimes(1);
        expect(detailActions.retryInvocation.mock.calls[0]?.[0]).toMatchObject({
            runId: '11111111-1111-4111-8111-111111111111',
            expectedRevision: 1,
            invocation: { recordId: '44444444-4444-4444-8444-444444444444' },
            causalInvocationIds,
            conversation: 'same_conversation',
            input: {
                kind: 'replacement',
                value: {
                    document: { text: 'Continue, but skip the migration step' },
                    input: ['recorded context'],
                },
            },
        });
    });

    /**
     * Every durable Run operation carries `expectedRevision`, so two in flight
     * at once are a currentness race the person did not ask for. One Run-scoped
     * mutex at this command owner admits exactly one at a time; the others are
     * refused at issuance, not merely greyed out after a render.
     */
    it.each([false, true])('rereads and retries Stop once on a revision conflict (second conflict: %s)', async (again) => {
        const run = createWorkflowRunSummaryFixture({ id: routeState.runId, state: 'running', revision: 3 });
        await renderRunScreen({ run });
        const reply = await detailActions.getRun.mock.results[0]!.value;
        detailActions.getRun.mockResolvedValue({ ...reply, run: { ...run, revision: 4 } });
        detailActions.cancelRun.mockResolvedValue({ run: { ...run, revision: 5 }, intent: 'cancel_requested' });
        detailActions.cancelRun.mockRejectedValueOnce(new WorkflowActionError({ message: 'Moved', rawCode: 'currentness_conflict' }));
        if (again) detailActions.cancelRun.mockRejectedValueOnce(new WorkflowActionError({ message: 'Moved again', rawCode: 'currentness_conflict' }));
        await act(async () => readContentProps()?.onCancel?.());
        await vi.waitFor(() => expect(detailActions.cancelRun.mock.calls.map(([input]) => input.expectedRevision)).toEqual([3, 4]));
        await act(async () => {});
        expect(readContentProps()?.pendingControl).toBeNull();
        expect(again ? readContentProps()?.errorLabel : readContentProps()?.cancelRequested).toBeTruthy();
    });
    it('withholds settled Run actions while accepted Stop custody is pending', async () => {
        const run = createWorkflowRunSummaryFixture({ state: 'cancelled', workflowCustodyState: 'pending',
            availability: { cancel: false, pause: false } });
        await renderRunScreen({ run });
        expect(readContentProps()?.onRunAgain).toBeUndefined();
        expect(readContentProps()?.onDelete).toBeUndefined();
        await act(async () => getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary({ ...run,
            revision: run.revision + 1, workflowCustodyState: 'settled' })]));
        expect(readContentProps()?.onRunAgain).toBeDefined();
        expect(readContentProps()?.onDelete).toBeDefined();
    });
    it('does not retry Stop when the Account retires during its conflict reread', async () => {
        const run = createWorkflowRunSummaryFixture({ id: routeState.runId, state: 'running', revision: 3 });
        await renderRunScreen({ run });
        const reply = await detailActions.getRun.mock.results[0]!.value;
        const reread = createDeferred<typeof reply>();
        detailActions.getRun.mockImplementationOnce(() => reread.promise);
        detailActions.cancelRun.mockRejectedValueOnce(new WorkflowActionError({ message: 'Moved', rawCode: 'currentness_conflict' }));
        let stopping: void | undefined;
        await act(async () => { stopping = readContentProps()?.onCancel?.(); });
        await vi.waitFor(() => expect(detailActions.getRun).toHaveBeenCalledTimes(2));
        await act(async () => retireActiveServerAccountScopeLifetime());
        await act(async () => { reread.resolve({ ...reply, run: { ...run, revision: 4 } }); await stopping; });
        expect(detailActions.cancelRun.mock.calls.map(([input]) => input.expectedRevision)).toEqual([3]);
    });
    it('issues exactly one durable Run operation at a time and refuses the rest until it settles', async () => {
        const invocations = [
            createWorkflowInvocationIndexFixture({ id: '33333333-3333-4333-8333-333333333333', parentRecordId: null, memberOrdinal: '0', sequence: '0' }),
            createWorkflowInvocationIndexFixture({
                id: '44444444-4444-4444-8444-444444444444', parentRecordId: '33333333-3333-4333-8333-333333333333', memberOrdinal: '0', sequence: '1', lifecycle: 'failed',
            }),
        ];
        detailActions.getInvocation.mockResolvedValue({
            invocation: {
                index: invocations[1],
                parentRevision: 1,
                progress: {
                    kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'analyze', scope: [] },
                    blockKind: 'step', attempt: '0', logicalInvocationRecordId: '44444444-4444-4444-8444-444444444444',
                },
            },
        });
        const run = createWorkflowRunSummaryFixture({
            id: '11111111-1111-4111-8111-111111111111', state: 'running', revision: 1, origin: { kind: 'direct' },
            availability: { pause: true, cancel: true },
        });
        const pause = createDeferred<Readonly<{ run: typeof run; intent: 'pause_requested' }>>();
        detailActions.pauseRun.mockImplementationOnce(() => pause.promise);
        detailActions.cancelRun.mockResolvedValue({ run: { ...run, state: 'cancelled', revision: 3 }, intent: 'cancelled' });
        detailActions.retryInvocation.mockResolvedValue({ run: { ...run, revision: 3 }, invocation: invocations[1], disposition: 'accepted' });
        await renderRunScreen({ run, invocations });
        await act(async () => readContentProps()?.onSelectInvocation('44444444-4444-4444-8444-444444444444'));
        await act(async () => {});

        act(() => { readContentProps()?.onPause?.(); });
        await vi.waitFor(() => expect(detailActions.pauseRun).toHaveBeenCalledTimes(1));
        expect(readContentProps()?.pendingControl).toBe('pause');

        // While Pause is unsettled, Cancel and Retry are conflicting durable
        // operations against the same revision: none may issue.
        act(() => {
            readContentProps()?.onCancel?.();
            readContentProps()?.onCancel?.();
            readContentProps()?.onRetrySameConversation?.();
            readContentProps()?.onRetrySameConversation?.();
        });
        await act(async () => {});
        expect(detailActions.cancelRun).not.toHaveBeenCalled();
        expect(detailActions.retryInvocation).not.toHaveBeenCalled();

        pause.resolve({ run: { ...run, state: 'pause_requested', revision: 2 }, intent: 'pause_requested' });
        await act(async () => {});
        expect(readContentProps()?.pendingControl).toBeNull();
        expect(readContentProps()?.run.revision).toBe(2);

        // Two presses in one frame: the ref, not the rendered state, is the gate.
        act(() => {
            readContentProps()?.onCancel?.();
            readContentProps()?.onCancel?.();
        });
        await act(async () => {});
        expect(detailActions.cancelRun).toHaveBeenCalledTimes(1);
        expect(detailActions.cancelRun.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 2 });
        expect(readContentProps()?.run.revision).toBe(3);
    });

    it('lets a durable operation that outlives a Run change neither settle this screen nor overwrite the new Run', async () => {
        const runA = createWorkflowRunSummaryFixture({
            id: '11111111-1111-4111-8111-111111111111', state: 'running', revision: 1, origin: { kind: 'direct' }, availability: { cancel: true },
        });
        const cancel = createDeferred<Readonly<{ run: typeof runA; intent: 'cancelled' }>>();
        detailActions.cancelRun.mockImplementationOnce(() => cancel.promise);
        const screen = await renderRunScreen({ run: runA });
        act(() => { readContentProps()?.onCancel?.(); });
        expect(readContentProps()?.pendingControl).toBe('cancel');

        routeState.runId = '22222222-2222-4222-8222-222222222222';
        const runB = createWorkflowRunSummaryFixture({
            id: '22222222-2222-4222-8222-222222222222', state: 'running', revision: 5, origin: { kind: 'direct' }, availability: { cancel: true },
        });
        detailActions.listRuns.mockResolvedValue({ runs: [runB], metadataByRunId: {} });
        detailActions.getRun.mockResolvedValue({
            run: runB, definition: DEFINITION, authoredDefinition: DEFINITION, acceptedContext: ACCEPTED_CONTEXT, checkpoint: null,
            callerAccess: { canEdit: true },
        });
        detailActions.listInvocations.mockResolvedValue(invocationPage([]));
        await screen.update(createRunScreenElement());
        await act(async () => {});
        expect(readContentProps()?.run.id).toBe('22222222-2222-4222-8222-222222222222');
        // The new Run starts with no operation in flight; A's cancel is not its business.
        expect(readContentProps()?.pendingControl).toBeNull();

        const cancelledB = { ...runB, state: 'cancelled' as const, revision: 6 };
        detailActions.listRuns.mockResolvedValue({ runs: [cancelledB], metadataByRunId: {} });
        detailActions.getRun.mockResolvedValue({
            run: cancelledB, definition: DEFINITION, authoredDefinition: DEFINITION, acceptedContext: ACCEPTED_CONTEXT,
            checkpoint: null, callerAccess: { canEdit: true },
        });
        detailActions.cancelRun.mockResolvedValueOnce({ run: cancelledB, intent: 'cancelled' });
        act(() => { readContentProps()?.onCancel?.(); });
        await act(async () => {});
        expect(detailActions.cancelRun).toHaveBeenCalledTimes(2);
        expect(readContentProps()?.run.revision).toBe(6);

        cancel.resolve({ run: { ...runA, state: 'cancelled', revision: 2 }, intent: 'cancelled' });
        await act(async () => {});
        expect(readContentProps()?.run.id).toBe('22222222-2222-4222-8222-222222222222');
        expect(readContentProps()?.run.revision).toBe(6);
        expect(storeState.state.workflowRunsById[workflowRunStoreKey('11111111-1111-4111-8111-111111111111')]).toMatchObject({ revision: 1 });
    });

    it('keeps both permission controls withdrawn until the exact canonical reread removes the request', async () => {
        const decision = createDeferred<Readonly<{ ok: boolean }>>();
        const reconciliation = createDeferred<ReturnType<typeof permissionInvocationResponse>>();
        machineRpcSpy.mockImplementationOnce(async () => {
            return decision.promise;
        });
        await renderSelectedPermissionRequests();

        expect(readContentProps()?.onRespondToRequest).toBeTypeOf('function');
        const exactReadsBeforeDecision = detailActions.getInvocation.mock.calls.length;
        detailActions.getInvocation.mockImplementationOnce(async () => reconciliation.promise);
        act(() => { void respondToRequest({ requestId: 'permission-1', approved: true }); });
        await act(async () => {});

        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
        expect(machineRpcSpy.mock.calls[0]?.[0]).toMatchObject({
            machineId: 'machine-1',
            payload: { runId: 'exec-1', requestId: 'permission-1', approved: true },
        });
        // Only the answered request is withdrawn; the other stays decidable.
        expect([...(readContentProps()?.pendingRequestIds ?? [])]).toEqual(['permission-1']);

        // The opposite press must not race a competing response for the same request.
        act(() => { void respondToRequest({ requestId: 'permission-1', approved: false }); });
        await act(async () => {});
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);

        decision.resolve({ ok: true });
        await act(async () => {});

        expect(detailActions.getInvocation).toHaveBeenCalledTimes(exactReadsBeforeDecision + 1);
        // An acknowledgement is not settlement. The request stays withdrawn
        // while the exact canonical content read is unresolved.
        expect([...(readContentProps()?.pendingRequestIds ?? [])]).toEqual(['permission-1']);
        act(() => { void respondToRequest({ requestId: 'permission-1', approved: false }); });
        await act(async () => {});
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);

        reconciliation.resolve(permissionInvocationResponse({
            index: createWorkflowInvocationIndexFixture({
                id: '44444444-4444-4444-8444-444444444444', parentRecordId: '33333333-3333-4333-8333-333333333333', memberOrdinal: '0', sequence: '1', lifecycle: 'running',
            }),
            requestIds: ['permission-2'],
        }));
        await act(async () => {});

        expect([...(readContentProps()?.pendingRequestIds ?? [])]).toEqual([]);
    });

    it('keeps an issued permission decision pending when reconciliation returns an older row token', async () => {
        await renderSelectedPermissionRequests('2');
        machineRpcSpy.mockImplementationOnce(async () => {
            return { ok: true };
        });
        detailActions.getInvocation.mockResolvedValueOnce(permissionInvocationResponse({
            index: createWorkflowInvocationIndexFixture({
                id: '44444444-4444-4444-8444-444444444444', parentRecordId: '33333333-3333-4333-8333-333333333333', memberOrdinal: '0', sequence: '1',
                lifecycle: 'running', contentRevision: '1',
            }),
            requestIds: [],
        }));

        await act(async () => { await respondToRequest({ requestId: 'permission-1', approved: true }); });

        expect([...(readContentProps()?.pendingRequestIds ?? [])]).toEqual(['permission-1']);
        expect(storeState.state.workflowRunInvocationsByRunId[workflowRunStoreKey('11111111-1111-4111-8111-111111111111')]?.factsById['44444444-4444-4444-8444-444444444444']?.contentRevision).toBe('2');
    });

    it('sends structured question answers through the discoverable Action and exact detached-run request writer', async () => {
        await renderSelectedPermissionRequests();

        expect(readContentProps()?.onRespondToRequest).toBeTypeOf('function');
        await act(async () => { await respondToRequest({
            requestId: 'permission-1',
            answers: { branch: ['dev'] },
        })?.catch(() => {}); });

        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND,
            serverUrl: 'https://server-a', accountId: 'account-a', requestId: expect.any(String),
            payload: {
                runId: 'exec-1',
                requestId: 'permission-1',
                answers: { branch: ['dev'] },
            },
        }));
    });

    it('leaves a queued Action approval request answerable when no detached response was issued', async () => {
        await renderSelectedPermissionRequests();
        approvalRequired = true;
        const state = getStorage().getState();
        if (!state.profileScope) throw new Error('Expected the restored Account scope');
        state.applySettingsForScope(state.profileScope, { ...state.settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'execution.run.permission.respond': { approvalRequiredSurfaces: ['ui'] } } }),
        }, 2);

        await act(async () => { await respondToRequest({ requestId: 'permission-1', approved: true })?.catch(() => {}); });

        expect(machineRpcSpy).not.toHaveBeenCalled();
        expect(approvalArtifacts.list()).toHaveLength(1);
        expect([...(readContentProps()?.pendingRequestIds ?? [])]).toEqual([]);
    });

    it('reconciles a not-found response and suppresses the opposite answer while canonical content still has the request', async () => {
        machineRpcSpy.mockImplementationOnce(async () => {
            return { ok: false, errorCode: 'permission_request_not_found' };
        });
        await renderSelectedPermissionRequests();
        const exactReadsBeforeDecision = detailActions.getInvocation.mock.calls.length;

        let answer: Promise<void> | undefined;
        await act(async () => { answer = respondToRequest({ requestId: 'permission-1', approved: true }); });
        await act(async () => {});

        expect(detailActions.getInvocation).toHaveBeenCalledTimes(exactReadsBeforeDecision + 1);
        // The failure is the answering card's to show, once — not a second screen error.
        await expect(answer).rejects.toThrow();
        expect(readContentProps()?.errorLabel ?? null).toBeNull();
        expect([...(readContentProps()?.pendingRequestIds ?? [])]).toEqual(['permission-1']);
        act(() => { void respondToRequest({ requestId: 'permission-1', approved: false }); });
        await act(async () => {});
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
    });

    it('reconciles an issued timeout without making the request retryable from an unknown outcome', async () => {
        machineRpcSpy.mockImplementationOnce(async () => {
            throw new Error('machine timed out');
        });
        await renderSelectedPermissionRequests();
        const exactReadsBeforeDecision = detailActions.getInvocation.mock.calls.length;

        let answer: Promise<void> | undefined;
        await act(async () => { answer = respondToRequest({ requestId: 'permission-1', approved: true }); });
        await act(async () => {});

        expect(detailActions.getInvocation).toHaveBeenCalledTimes(exactReadsBeforeDecision + 1);
        // The failure is the answering card's to show, once — not a second screen error.
        await expect(answer).rejects.toThrow();
        expect(readContentProps()?.errorLabel ?? null).toBeNull();
        expect([...(readContentProps()?.pendingRequestIds ?? [])]).toEqual(['permission-1']);
        act(() => { void respondToRequest({ requestId: 'permission-1', approved: false }); });
        await act(async () => {});
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
    });

    it('permits retry after an exact reread confirms a failure happened before transport issuance', async () => {
        const reconciliation = createDeferred<ReturnType<typeof permissionInvocationResponse>>();
        await renderSelectedPermissionRequests();
        machinePreparationFailure = new Error('scope unavailable before emission');
        detailActions.getInvocation.mockImplementationOnce(async () => reconciliation.promise);

        act(() => { void respondToRequest({ requestId: 'permission-1', approved: true }); });
        await act(async () => {});

        expect([...(readContentProps()?.pendingRequestIds ?? [])]).toEqual(['permission-1']);
        reconciliation.resolve(permissionInvocationResponse({
            index: createWorkflowInvocationIndexFixture({
                id: '44444444-4444-4444-8444-444444444444', parentRecordId: '33333333-3333-4333-8333-333333333333', memberOrdinal: '0', sequence: '1', lifecycle: 'waiting_for_approval',
            }),
            requestIds: ['permission-1', 'permission-2'],
        }));
        await act(async () => {});

        expect([...(readContentProps()?.pendingRequestIds ?? [])]).toEqual([]);
        await act(async () => { await respondToRequest({ requestId: 'permission-1', approved: false })?.catch(() => {}); });
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps an unchanged invalid response withdrawn after canonical content confirms the request is still open', async () => {
        machineRpcSpy.mockImplementationOnce(async () => {
            return { ok: false, errorCode: 'execution_run_invalid_action_input' };
        });
        await renderSelectedPermissionRequests();

        await act(async () => { await respondToRequest({ requestId: 'permission-1', approved: true })?.catch(() => {}); });
        await act(async () => {});

        expect([...(readContentProps()?.pendingRequestIds ?? [])]).toEqual(['permission-1']);
        act(() => { void respondToRequest({ requestId: 'permission-1', approved: false }); });
        await act(async () => {});
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
    });

    it('retires the exact Account operation so an A to B to A completion cannot touch the replacement request', async () => {
        const decision = createDeferred<Readonly<{ ok: boolean }>>();
        const replacementDecision = createDeferred<Readonly<{ ok: boolean }>>();
        machineRpcSpy
            .mockImplementationOnce(async () => {
                return decision.promise;
            })
            .mockImplementationOnce(async () => {
                return replacementDecision.promise;
            });
        const screen = await renderSelectedPermissionRequests();
        act(() => { void respondToRequest({ requestId: 'permission-1', approved: true }); });
        await act(async () => {});
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
        const firstRequestId = machineRpcSpy.mock.calls[0]?.[0].requestId;
        expect(firstRequestId).toBeTypeOf('string');
        expect(socketCancellations).not.toContain(firstRequestId);

        act(() => accountScopeHarness.switchTo({ serverId: 'server-b', accountId: 'account-b' }));
        const runB = createWorkflowRunSummaryFixture({ id: '11111111-1111-4111-8111-111111111111', state: 'running', machineId: 'machine-1' });
        detailActions.getRun.mockResolvedValue({
            run: runB,
            callerAccess: { canEdit: true },
            definition: DEFINITION,
            authoredDefinition: DEFINITION,
            acceptedContext: ACCEPTED_CONTEXT,
            checkpoint: null,
        });
        detailActions.listInvocations.mockResolvedValue(invocationPage([]));
        await screen.update(createRunScreenElement());
        await act(async () => {});
        expect(socketCancellations).toContain(firstRequestId);

        act(() => accountScopeHarness.switchTo({ serverId: 'server-a', accountId: 'account-a' }));
        await screen.update(createRunScreenElement());
        await act(async () => {});
        await act(async () => readContentProps()?.onSelectInvocation('44444444-4444-4444-8444-444444444444'));
        await act(async () => {});
        act(() => { void respondToRequest({ requestId: 'permission-1', approved: false }); });
        await act(async () => {});
        expect(machineRpcSpy).toHaveBeenCalledTimes(2);
        expect([...(readContentProps()?.pendingRequestIds ?? [])]).toEqual(['permission-1']);

        decision.reject(new Error('machine unreachable'));
        await act(async () => {});

        expect(readContentProps()?.errorLabel ?? null).toBeNull();
        expect([...(readContentProps()?.pendingRequestIds ?? [])]).toEqual(['permission-1']);

        replacementDecision.reject(new Error('replacement machine unreachable'));
        await act(async () => {});
    });

    /**
     * A Run whose public history and attention windows each report another page.
     *
     * Both are answered by the same canonical reader the screen really calls,
     * distinguished only by the lifecycle filter the attention query carries, so
     * these cases exercise the real two-window paging the screen owns.
     */
    async function renderPagedRunScreen(overrides: Readonly<{
        history?: readonly unknown[];
        historyNextCursor?: string;
        attention?: readonly unknown[];
        attentionNextCursor?: string;
    }> = {}) {
        const run = createWorkflowRunSummaryFixture({
            id: '11111111-1111-4111-8111-111111111111', state: 'running', origin: { kind: 'direct' },
        });
        detailActions.getRun.mockResolvedValue({
            run,
            callerAccess: { canEdit: true },
            definition: DEFINITION,
            authoredDefinition: DEFINITION,
            acceptedContext: ACCEPTED_CONTEXT,
            checkpoint: null,
        });
        detailActions.listInvocations.mockImplementation(async (input: Record<string, unknown>) => (
            input.cursor !== undefined ? invocationPage([]) : input.lifecycles === undefined
                ? { ...invocationPage(overrides.history ?? []), nextCursor: overrides.historyNextCursor }
                : { ...invocationPage(overrides.attention ?? []), nextCursor: overrides.attentionNextCursor }
        ));
        const screen = await renderScreen(createRunScreenElement());
        await act(async () => {});
        return screen;
    }

    it('keeps the loaded history and its cursor when a continuation fails, and clears that failure only once a retry succeeds', async () => {
        const first = createWorkflowInvocationIndexFixture({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', memberOrdinal: '0', sequence: '0' });
        const second = createWorkflowInvocationIndexFixture({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', memberOrdinal: '1', sequence: '1' });
        await renderPagedRunScreen({ history: [first], historyNextCursor: 'history-2' });
        expect(readContentProps()?.invocations.map((entry) => entry.id)).toEqual(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);

        detailActions.listInvocations.mockRejectedValueOnce(new Error('offline'));
        await act(async () => { readContentProps()?.onLoadMoreInvocations?.(); });
        await act(async () => {});

        // A page that did not arrive is not a durable Run operation failure, so
        // it must not claim the outcome region's error voice.
        expect(readContentProps()?.errorLabel ?? null).toBeNull();
        expect(readContentProps()?.loadMoreInvocationsFailed).toBe(true);
        // The rows already read and the cursor Retry needs both survive.
        expect(readContentProps()?.invocations.map((entry) => entry.id)).toEqual(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
        expect(readContentProps()?.onLoadMoreInvocations).toBeTypeOf('function');

        detailActions.listInvocations.mockRejectedValueOnce(new Error('offline again'));
        await act(async () => { readContentProps()?.onLoadMoreInvocations?.(); });
        await act(async () => {});
        expect(readContentProps()?.loadMoreInvocationsFailed).toBe(true);

        detailActions.listInvocations.mockImplementationOnce(async () => invocationPage([second]));
        await act(async () => { readContentProps()?.onLoadMoreInvocations?.(); });
        await act(async () => {});

        expect(readContentProps()?.loadMoreInvocationsFailed).toBe(false);
        expect(readContentProps()?.invocations.map((entry) => entry.id)).toEqual(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc']);
        expect(readContentProps()?.onLoadMoreInvocations).toBeUndefined();
        expect(readContentProps()?.errorLabel ?? null).toBeNull();
    });

    it('issues one attention continuation for two presses in the same frame and releases the guard when it settles', async () => {
        const attentionRow = createWorkflowInvocationIndexFixture({
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', memberOrdinal: '0', sequence: '0', lifecycle: 'waiting_for_approval',
        });
        await renderPagedRunScreen({ attention: [attentionRow], attentionNextCursor: 'attention-2' });
        expect(readContentProps()?.onLoadMoreAttention).toBeTypeOf('function');
        const callsBefore = detailActions.listInvocations.mock.calls.length;

        const page = createDeferred<unknown>();
        detailActions.listInvocations.mockImplementationOnce(async () => page.promise);
        act(() => {
            readContentProps()?.onLoadMoreAttention?.();
            readContentProps()?.onLoadMoreAttention?.();
        });
        await act(async () => {});

        expect(detailActions.listInvocations.mock.calls.length).toBe(callsBefore + 1);

        page.resolve({ ...invocationPage([]), nextCursor: 'attention-3' });
        await act(async () => {});
        await act(async () => { readContentProps()?.onLoadMoreAttention?.(); });
        await act(async () => {});

        // The guard withdraws only the duplicate, never the next honest ask.
        expect(detailActions.listInvocations.mock.calls.length).toBe(callsBefore + 2);
    });

    it('retires a continuation failure and its late response when this mounted screen changes Runs', async () => {
        const first = createWorkflowInvocationIndexFixture({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', memberOrdinal: '0', sequence: '0' });
        const screen = await renderPagedRunScreen({ history: [first], historyNextCursor: 'history-2' });

        detailActions.listInvocations.mockRejectedValueOnce(new Error('offline'));
        await act(async () => { readContentProps()?.onLoadMoreInvocations?.(); });
        await act(async () => {});
        expect(readContentProps()?.loadMoreInvocationsFailed).toBe(true);

        const stale = createDeferred<unknown>();
        detailActions.listInvocations.mockImplementationOnce(async () => stale.promise);
        act(() => { readContentProps()?.onLoadMoreInvocations?.(); });
        await act(async () => {});

        routeState.runId = '22222222-2222-4222-8222-222222222222';
        const runB = createWorkflowRunSummaryFixture({ id: '22222222-2222-4222-8222-222222222222', state: 'running', origin: { kind: 'direct' } });
        detailActions.getRun.mockResolvedValue({
            run: runB,
            callerAccess: { canEdit: true },
            definition: DEFINITION,
            authoredDefinition: DEFINITION,
            acceptedContext: ACCEPTED_CONTEXT,
            checkpoint: null,
        });
        detailActions.listInvocations.mockImplementation(async () => invocationPage([]));
        await screen.update(createRunScreenElement());
        await act(async () => {});
        expect(readContentProps()?.run.id).toBe('22222222-2222-4222-8222-222222222222');
        expect(readContentProps()?.loadMoreInvocationsFailed).toBe(false);

        stale.reject(new Error('offline'));
        await act(async () => {});

        // Run A's lost page belongs to nobody on screen once Run B is mounted.
        expect(readContentProps()?.loadMoreInvocationsFailed).toBe(false);
        expect(readContentProps()?.errorLabel ?? null).toBeNull();
    });

    /**
     * Exact reread evidence for the selected invocation.
     *
     * The last-known private content stays visible while it is re-asked for,
     * but no permission or recovery callback may act on it until a response
     * for this exact Run, record, revision and attempt confirms it. A response
     * that lost its race is ignored rather than published.
     */
    describe('Run summary freshness on an invocation wake', () => {
        it.each(['terminal', 'invocation-only', 'unbound-invalidation'] as const)('consumes a held Account catch-up Run refresh once for detail and rail (%s)', async change => {
            const run = createWorkflowRunSummaryFixture({ state: 'running', revision: 1, origin: { kind: 'direct' } });
            const invocation = createWorkflowInvocationIndexFixture({ runId: run.id });
            await renderRunScreen({ run, invocations: [invocation] });
            const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
            const { useWorkflowRunRows } = await import('@/sync/store/hooks');
            const { planSyncActionsFromChanges } = await import('@/sync/runtime/orchestration/changesPlanner');
            const { applyPlannedChangeActions } = await import('@/sync/runtime/orchestration/changesApplier');
            const { refreshWorkflowRunsByIds } = await import('@/sync/engine/workflows/refreshWorkflowRun');
            const rail = await renderHook(() => useWorkflowRunRows([run.id]));
            const priorDetail = await detailActions.getRun.mock.results[0]!.value;
            const changed = change === 'terminal'
                ? { ...run, state: 'failed' as const, revision: 11, workflowCustodyState: 'settled' as const } : run;
            detailActions.getRun.mockResolvedValue({ ...priorDetail, run: changed });
            const completed = { ...invocation, lifecycle: 'completed' as const, contentRevision: '1' };
            detailActions.listInvocations.mockImplementation(async (input: Readonly<{ lifecycles?: readonly string[] }>) => ({
                invocations: input.lifecycles === undefined ? [completed] : [], parentRevision: changed.revision,
            }));
            const readGate = createDeferred<void>();
            let requested = false;
            detailActions.listRuns.mockClear();
            detailActions.listRuns.mockImplementation(async () => {
                requested = true;
                await readGate.promise;
                return { runs: [changed], metadataByRunId: {} };
            });
            const changes = [{ cursor: 1, changedAt: 1, kind: 'account' as const, entityId: `workflow-run:${run.id}`, hint: { revision: changed.revision } }];
            const catchUp = applyPlannedChangeActions({ planned: planSyncActionsFromChanges(changes), credentials: { token: 'fixture' },
                isSessionMessagesLoaded: () => false, invalidate: {}, refreshWorkflowRuns: refreshWorkflowRunsByIds,
                // Negative wiring control: the same parent revision cannot wake
                // invocation readers if the materialized notification is unbound.
                publishAccountChanges: change === 'unbound-invalidation' ? undefined : (page, materialization) => publishHomeAccountChange('server-a', page.map(change => change.entityId), {
                    changeKinds: page.map(change => change.kind), entityRevisions: { [`workflow-run:${run.id}`]: changed.revision },
                    ...materialization,
                }), invalidateMessagesForSession: async () => {}, invalidateScmStatusForSession: () => {},
                applyTodoSocketUpdates: async () => {}, kvBulkGet: async () => ({ values: [] }),
            });
            try {
                await vi.waitFor(() => expect(requested).toBe(true));
                await act(async () => {
                    for (let index = 0; index < 100; index++) publishHomeAccountChange('server-a', undefined, { source: 'catch-up-pending' });
                });
                expect(readContentProps()?.run).toMatchObject({ state: 'running', revision: 1 });
                await act(async () => { readGate.resolve(); expect(await catchUp).toMatchObject({ status: 'complete' }); });
                await vi.waitFor(() => expect(readContentProps()?.run).toMatchObject({ state: changed.state, revision: changed.revision }));
                if (change === 'unbound-invalidation') {
                    expect(readContentProps()?.invocations.find(row => row.id === invocation.id))
                        .toMatchObject({ lifecycle: 'running', contentRevision: '0' });
                } else {
                    await vi.waitFor(() => expect(readContentProps()?.invocations.find(row => row.id === invocation.id))
                        .toMatchObject({ lifecycle: 'completed', contentRevision: '1' }));
                }
                expect(rail.getCurrent()[0]?.summary).toMatchObject({ state: changed.state, revision: changed.revision });
                expect(detailActions.listRuns.mock.calls.map(([request]) => request)).toEqual([
                    expect.objectContaining({ runIds: [run.id] }),
                ]);
            } finally { readGate.resolve(); await catchUp; await rail.unmount(); }
        });

        it('shows current held work when the opened admission detail still records queued revision zero', async () => {
            const queued = createWorkflowRunSummaryFixture({ state: 'queued', revision: 0, origin: { kind: 'direct' } });
            const definition = createWorkflowDefinitionFixture({ defaults: {}, blocks: [{ kind: 'wait', id: 'confirm',
                document: { text: 'Enter READY, then continue.', references: [], attachments: [] }, result: { kind: 'text' } }] });
            await renderRunScreen({ run: queued, definition });
            expect(readContentProps()?.run.state).toBe('queued');
            const waiting = { ...queued, state: 'waiting_for_review' as const, revision: 12 };
            const root = createWorkflowInvocationIndexFixture({ id: '33333333-3333-4333-8333-333333333333', parentRecordId: null });
            const held = createWorkflowInvocationIndexFixture({ id: '44444444-4444-4444-8444-444444444444',
                parentRecordId: root.id, sequence: '1', lifecycle: 'waiting_for_review', contentRevision: '1' });
            detailActions.listRuns.mockResolvedValue({ runs: [waiting], metadataByRunId: {} });
            detailActions.listInvocations.mockResolvedValue({ invocations: [root, held], parentRevision: 12,
                invocationDetails: [{ index: held, parentRevision: 12, progress: {
                    kind: 'happier.workflow-progress.v1', blockKind: 'wait', invocationPath: { blockId: 'confirm', scope: [] },
                    attempt: '0', logicalInvocationRecordId: held.id, resultContract: { kind: 'text' },
                } }] });

            await act(async () => publishHomeAccountChange('server-a', [`workflow-run:${queued.id}`]));
            await act(async () => {});

            expect(storeState.state.workflowRunsById[workflowRunStoreKey(queued.id)]?.detail?.run.revision).toBe(0);
            expect(readContentProps()?.run.state).toBe('waiting_for_review');
            expect(readContentProps()?.run.revision).toBe(12);
            expect(readContentProps()?.invocationProgressById?.get(held.id)?.resultContract).toEqual({ kind: 'text' });
        });
        it('opens current detail when an interrupted Run is later stopped', async () => {
            const interrupted = createWorkflowRunSummaryFixture({ state: 'interrupted', revision: 17, workflowCustodyState: 'pending', origin: { kind: 'direct' } });
            await renderRunScreen({ run: interrupted });
            await vi.waitFor(() => expect(readContentProps()?.run.state).toBe('interrupted'));
            const earlierDetail = await detailActions.getRun.mock.results[0]!.value;
            const stopped = { ...interrupted, state: 'cancelled' as const, revision: 19,
                workflowCustodyState: 'settled' as const };
            detailActions.listRuns.mockResolvedValue({ runs: [stopped], metadataByRunId: {} });
            detailActions.getRun.mockResolvedValue({ ...earlierDetail, run: stopped });

            await act(async () => publishHomeAccountChange('server-a', [`workflow-run:${interrupted.id}`]));
            await act(async () => {});

            expect(readContentProps()?.run.state).toBe('cancelled');
            expect(storeState.state.workflowRunsById[workflowRunStoreKey(interrupted.id)]?.detail?.run.revision).toBe(19);
            expect(storeState.state.workflowRunsById[workflowRunStoreKey(interrupted.id)]?.detail?.run.workflowCustodyState).toBe('settled');
        });
        it('renews exact detail and its wake subscription on same-Account restore', async () => {
            const run = createWorkflowRunSummaryFixture({ state: 'claimed', revision: 1 });
            await renderRunScreen({ run });
            expect(readContentProps()?.run.state).toBe('claimed');
            const reply = await detailActions.getRun.mock.results[0]!.value;
            const restored = { ...run, state: 'succeeded' as const, revision: 2 };
            detailActions.getRun.mockResolvedValue({ ...reply, run: restored });
            detailActions.listRuns.mockResolvedValue({ runs: [restored], metadataByRunId: {} });
            await act(async () => { retireActiveServerAccountScopeLifetime(); });
            expect(readContentProps()?.run.state).toBe('succeeded');
            const changed = { ...restored, state: 'interrupted' as const, revision: 3 };
            detailActions.getRun.mockResolvedValue({ ...reply, run: changed });
            detailActions.listRuns.mockResolvedValue({ runs: [changed], metadataByRunId: {} });
            await act(async () => { publishHomeAccountChange('server-a', [`workflow-run:${run.id}`]); });
            expect(readContentProps()?.run.state).toBe('interrupted');
        });
        it.each(['waiting_for_review', 'succeeded', 'claimed'] as const)('refreshes a claimed Run to authoritative %s without waiting for Account catch-up', async (state) => {
            const runId = '11111111-1111-4111-8111-111111111111';
            const invocationId = '22222222-2222-4222-8222-222222222222';
            routeState.runId = runId;
            const claimed = createWorkflowRunSummaryFixture({ id: runId, state: 'claimed', revision: 1, origin: { kind: 'direct' } });
            await renderRunScreen({ run: claimed });
            expect(readContentProps()?.run.state).toBe('claimed');

            const current = { ...claimed, state, revision: 2 };
            detailActions.listRuns.mockResolvedValue({ runs: [current], metadataByRunId: {} });
            detailActions.getRun.mockResolvedValue({
                run: current, callerAccess: { canEdit: true }, definition: DEFINITION,
                authoredDefinition: DEFINITION, acceptedContext: ACCEPTED_CONTEXT, checkpoint: null,
                ...(state === 'succeeded' ? { result: 'Release notes are ready', finalOutputInvocationId: invocationId } : {}),
            });
            const invocation = createWorkflowInvocationIndexFixture({
                id: invocationId, runId, lifecycle: state === 'waiting_for_review' ? 'waiting_for_review' : 'completed',
            });
            detailActions.listInvocations.mockImplementation(async (input: Readonly<{ lifecycles?: readonly string[] }>) => ({
                invocations: input.lifecycles === undefined || input.lifecycles.includes(invocation.lifecycle) ? [invocation] : [],
                parentRevision: 2,
            }));

            await act(async () => publishHomeAccountChange('server-a', [`workflow-run:${runId}`]));
            await act(async () => {});

            expect(readContentProps()?.run.state).toBe(state);
            expect(storeState.state.workflowRunsById[workflowRunStoreKey(runId)]?.summary?.revision).toBe(2);
            expect(readContentProps()?.invocations.some(row => row.id === invocation.id)).toBe(true);
            if (state === 'succeeded') {
                expect(readContentProps()?.resultLabel).toBe('Release notes are ready');
                expect(readContentProps()?.finalOutputInvocationId).toBe(invocationId);
            }
        });
    });

    it('reconciles a failed Run list observation with an already mounted Wait peek', async () => {
        const runId = routeState.runId;
        const root = createWorkflowInvocationIndexFixture({ id: '33333333-3333-4333-8333-333333333333', sequence: '0', contentRevision: '3', lifecycle: 'waiting_for_review' });
        const wait = createWorkflowInvocationIndexFixture({ id: '44444444-4444-4444-8444-444444444444', sequence: '1', parentRecordId: root.id,
            contentRevision: '1', lifecycle: 'waiting_for_review' });
        const definition = createWorkflowDefinitionFixture({ blocks: [{ id: 'review-ready', kind: 'wait',
            document: { text: 'Confirm readiness', references: [], attachments: [] } }] });
        const held = createWorkflowRunSummaryFixture({ id: runId, state: 'waiting_for_review', revision: 12 });
        const screen = await renderRunScreen({ run: held, definition, invocations: [root, wait] });
        expect(screen.findByTestId(`workflow-run-needs-you-${wait.id}`)).not.toBeNull();
        // Only the Run's canonical list observation advances; delayed page and
        // exact responses still carry the pre-Continue hold throughout this test.
        const failed = createWorkflowRunSummaryFixture({ ...held, state: 'failed', revision: 19, attentionRequired: false,
            stepProgressCurrentness: { recordId: root.id, attempt: '0', contentRevision: '5' },
            stepProgress: { completed: 1, total: 1, destinations: [{ sourceKey: '$root', blockId: 'review-ready', ordinal: 1,
                sessionIds: [], observation: { recordId: wait.id, sequence: wait.sequence, attempt: wait.attempt,
                    contentRevision: '2', lifecycle: 'completed', blockKind: 'wait' } }] },
        });
        await act(async () => getStorage().getState().applyWorkflowRunListPage({ windowId: 'all', runs: [failed], nextCursor: null, mode: 'replace' }));
        expect(readContentProps()?.run.state).toBe('failed');
        expect(readContentProps()?.invocations.find((row) => row.id === wait.id)).toMatchObject({ contentRevision: '2', lifecycle: 'completed' });
        expect(screen.findByTestId(`workflow-run-needs-you-${wait.id}`)).toBeNull();
    });

    describe('selected invocation evidence', () => {
        function selectedRows() {
            return [
                createWorkflowInvocationIndexFixture({ id: '33333333-3333-4333-8333-333333333333', parentRecordId: null, memberOrdinal: '0', sequence: '0' }),
                createWorkflowInvocationIndexFixture({
                    id: '44444444-4444-4444-8444-444444444444', parentRecordId: '33333333-3333-4333-8333-333333333333', memberOrdinal: '0', sequence: '1', lifecycle: 'waiting_for_approval',
                }),
            ];
        }

        function openRequestResponse(index: ReturnType<typeof createWorkflowInvocationIndexFixture>, parentRevision: number) {
            return permissionInvocationResponse({ index, requestIds: ['permission-1'], parentRevision });
        }

        it('keeps page-opened content while the first exact read is pending', async () => {
            const invocations = selectedRows();
            const response = openRequestResponse(invocations[1]!, 1);
            const exactRead = createDeferred<unknown>();
            detailActions.getInvocation.mockReturnValue(exactRead.promise);
            const screen = await renderRunScreen({
                run: createWorkflowRunSummaryFixture({ state: 'running', revision: 1 }),
                invocations,
                invocationDetails: [response.invocation],
            });
            await act(async () => readContentProps()?.onSelectInvocation(invocations[1]!.id));
            expect(readContentProps()?.selectedInvocationProgress).toEqual(response.invocation.progress);
            expect(screen.findByTestId('workflow-run-read-pending')).toBeNull();
            // A read in flight is not stale evidence: no warning beside a hold that just opened (DESIGN-15 R7).
            expect(screen.findByTestId('workflow-run-read-freshness')).toBeNull();
            expect(readContentProps()?.onRespondToRequest).toBeUndefined();
            exactRead.resolve(response);
            await act(async () => {});
            expect(readContentProps()?.selectedContentUnavailable).toBe(false);
            expect(screen.findByTestId('workflow-run-read-freshness')).toBeNull();
        });

        it('does not confirm a stale row blob when its parent revision is unchanged', async () => {
            const invocations = selectedRows();
            invocations[1] = { ...invocations[1]!, contentRevision: '2' };
            detailActions.getInvocation.mockResolvedValue(openRequestResponse({ ...invocations[1]!, contentRevision: '1' }, 1));
            await renderRunScreen({
                run: createWorkflowRunSummaryFixture({ id: '11111111-1111-4111-8111-111111111111', state: 'running', revision: 1 }),
                invocations,
            });
            const pageProgress = readContentProps()?.invocationProgressById?.get(invocations[1]!.id);
            expect(pageProgress).toBeDefined();
            await act(async () => readContentProps()?.onSelectInvocation('44444444-4444-4444-8444-444444444444'));
            await act(async () => {});
            expect(readContentProps()?.selectedContentUnavailable).toBe(true);
            expect(readContentProps()?.selectedInvocationProgress).toEqual(pageProgress);
            expect(readContentProps()?.onRespondToRequest).toBeUndefined();
        });

        it('refreshes selected evidence on a row token change without a timestamp or parent change', async () => {
            const invocations = selectedRows();
            const newer = { ...invocations[1]!, contentRevision: '1' };
            const refreshedRead = createDeferred<unknown>();
            detailActions.getInvocation.mockResolvedValueOnce(openRequestResponse(invocations[1]!, 1));
            detailActions.getInvocation.mockReturnValueOnce(refreshedRead.promise);
            const { getStorage } = await import('@/sync/domains/state/storage');
            await renderRunScreen({
                run: createWorkflowRunSummaryFixture({ id: '11111111-1111-4111-8111-111111111111', state: 'running', revision: 1 }),
                invocations,
            });
            await act(async () => readContentProps()?.onSelectInvocation('44444444-4444-4444-8444-444444444444'));
            expect(readContentProps()?.selectedContentUnavailable).toBe(false);
            act(() => getStorage().getState().upsertWorkflowRunInvocation({
                runId: '11111111-1111-4111-8111-111111111111', invocation: newer, parentRevision: 1,
            }));
            await act(async () => {});
            expect(detailActions.getInvocation).toHaveBeenCalledTimes(2);
            expect(readContentProps()?.selectedContentUnavailable).toBe(true);
            expect(readContentProps()?.onRespondToRequest).toBeUndefined();
            refreshedRead.resolve(openRequestResponse(newer, 1));
            await act(async () => {});
            expect(readContentProps()?.selectedContentUnavailable).toBe(false);
            expect(readContentProps()?.onRespondToRequest).toBeTypeOf('function');
        });

        it('refreshes row-only attention and the exact selection while visible, and reads current facts on reopening', async () => {
            const invocations = selectedRows();
            let destinationVisible = true;
            const wrap = (screen: React.ReactElement) => React.createElement(DestinationInstanceHost, {
                tabId: 'workflow-run-tab',
                ref: { kind: 'workflowRun', params: { runId: '11111111-1111-4111-8111-111111111111' } },
                pathname: '/workflows/runs/11111111-1111-4111-8111-111111111111',
                focused: destinationVisible,
                visible: destinationVisible,
                navigation: { ...routerSpy, replace: vi.fn() },
                children: screen,
            });
            detailActions.getInvocation.mockResolvedValue(openRequestResponse(invocations[1]!, 1));
            const screen = await renderRunScreen({
                run: createWorkflowRunSummaryFixture({ id: '11111111-1111-4111-8111-111111111111', state: 'running' }),
                invocations,
                wrap,
            });
            await act(async () => readContentProps()?.onSelectInvocation('44444444-4444-4444-8444-444444444444'));
            expect(readContentProps()?.selectedContentUnavailable).toBe(false);

            const refreshedRead = createDeferred<unknown>();
            detailActions.getInvocation.mockReturnValueOnce(refreshedRead.promise);
            const offPageApproval = createWorkflowInvocationIndexFixture({
                id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', sequence: '99', parentRecordId: '33333333-3333-4333-8333-333333333333', lifecycle: 'waiting_for_approval',
            });
            detailActions.listInvocations.mockImplementation(async (input: Readonly<{ lifecycles?: readonly string[] }>) => (
                invocationPage(input.lifecycles === undefined ? invocations : [offPageApproval])
            ));
            await act(async () => publishHomeAccountChange('server-a', ['workflow-run:11111111-1111-4111-8111-111111111111']));
            expect(readContentProps()?.invocations.some((row) => row.id === offPageApproval.id)).toBe(true);
            expect(readContentProps()?.selectedContentUnavailable).toBe(true);
            expect(readContentProps()?.selectedInvocationProgress).not.toBeNull();
            expect(readContentProps()?.run.revision).toBe(1);
            refreshedRead.resolve(openRequestResponse(invocations[1]!, 1));
            await act(async () => {});
            expect(readContentProps()?.selectedContentUnavailable).toBe(false);

            // A retained workspace tab is hidden even while the host remains visible.
            destinationVisible = false;
            await screen.update(wrap(createRunScreenElement()));
            detailActions.listInvocations.mockClear();
            detailActions.getInvocation.mockClear();
            await act(async () => publishHomeAccountChange('server-a', ['workflow-run:11111111-1111-4111-8111-111111111111']));
            expect(detailActions.listInvocations).not.toHaveBeenCalled();
            expect(detailActions.getInvocation).not.toHaveBeenCalled();

            destinationVisible = true;
            await screen.update(wrap(createRunScreenElement()));
            expect(detailActions.listInvocations).toHaveBeenCalled();
            expect(detailActions.getInvocation).toHaveBeenCalled();
        });

        it('withholds selected callbacks while the exact re-read is in flight but keeps last-known content visible', async () => {
            const invocations = selectedRows();
            const firstRead = createDeferred<unknown>();
            const secondRead = createDeferred<unknown>();
            let reads = 0;
            detailActions.getInvocation.mockImplementation(async () => {
                reads += 1;
                return reads === 1 ? firstRead.promise : secondRead.promise;
            });
            const { getStorage } = await import('@/sync/domains/state/storage');
            const screen = await renderRunScreen({
                run: createWorkflowRunSummaryFixture({
                    id: '11111111-1111-4111-8111-111111111111', state: 'running', machineId: 'machine-1', origin: { kind: 'direct' },
                }),
                invocations,
            });
            await act(async () => readContentProps()?.onSelectInvocation('44444444-4444-4444-8444-444444444444'));
            await act(async () => {});
            expect(detailActions.getInvocation).toHaveBeenCalledTimes(1);

            firstRead.resolve(openRequestResponse(invocations[1]!, 1));
            await act(async () => {});
            // The matching first read confirms the evidence its callbacks act on.
            expect(readContentProps()?.selectedContentUnavailable).toBe(false);
            expect(readContentProps()?.onRespondToRequest).toBeTypeOf('function');

            // A newer index row for the same selection re-asks for it. The
            // evidence is unconfirmed before that request answers, while
            // everything the last confirmed read established stays on screen.
            const newerIndex = { ...invocations[1]!, contentRevision: '1', updatedAt: '2026-09-08T11:00:00.000Z' };
            act(() => {
                getStorage().getState().applyWorkflowRunInvocationPage({
                    runId: '11111111-1111-4111-8111-111111111111',
                    invocations: [newerIndex],
                    nextCursor: null,
                    parentRevision: 1,
                    mode: 'replace',
                });
            });
            await act(async () => {});
            expect(detailActions.getInvocation).toHaveBeenCalledTimes(2);
            expect(readContentProps()?.selectedContentUnavailable).toBe(true);
            expect(readContentProps()?.onRespondToRequest).toBeUndefined();
            expect(readContentProps()?.run.id).toBe('11111111-1111-4111-8111-111111111111');
            expect(readContentProps()?.selectedInvocationProgress).toMatchObject({
                execution: { kind: 'detached_run', runId: 'exec-1' },
            });
            expect(screen.findByTestId('workflow-run-read-pending')).toBeNull();
            expect(screen.findByTestId('workflow-run-read-freshness')).toBeNull();

            secondRead.resolve(openRequestResponse(newerIndex, 1));
            await act(async () => {});
            expect(readContentProps()?.selectedContentUnavailable).toBe(false);
            expect(readContentProps()?.onRespondToRequest).toBeTypeOf('function');
        });

        it('ignores an exact response for another record instead of publishing it under the selection', async () => {
            const invocations = selectedRows();
            detailActions.getInvocation.mockResolvedValue({
                invocation: {
                    index: createWorkflowInvocationIndexFixture({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', sequence: '9' }),
                    parentRevision: 1,
                    progress: {
                        kind: 'happier.workflow-progress.v1',
                        invocationPath: { blockId: 'analyze', scope: [] },
                        blockKind: 'step', attempt: '0',
                        logicalInvocationRecordId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                    },
                },
            });
            await renderRunScreen({
                run: createWorkflowRunSummaryFixture({
                    id: '11111111-1111-4111-8111-111111111111', state: 'running', machineId: 'machine-1', origin: { kind: 'direct' },
                }),
                invocations,
            });
            const pageProgress = readContentProps()?.invocationProgressById?.get(invocations[1]!.id);
            expect(pageProgress).toBeDefined();
            await act(async () => readContentProps()?.onSelectInvocation('44444444-4444-4444-8444-444444444444'));
            await act(async () => {});

            // Keep only the matching page evidence; another record's exact
            // answer cannot replace it or arm the selected callbacks.
            expect(readContentProps()?.selectedContentUnavailable).toBe(true);
            expect(readContentProps()?.selectedInvocationProgress).toEqual(pageProgress);
            expect(readContentProps()?.onRespondToRequest).toBeUndefined();
        });

        it('confirms only on a response at least as fresh as the issued revision', async () => {
            const invocations = selectedRows();
            const staleRead = createDeferred<unknown>();
            const freshRead = createDeferred<unknown>();
            let reads = 0;
            detailActions.getInvocation.mockImplementation(async () => {
                reads += 1;
                return reads === 1 ? staleRead.promise : freshRead.promise;
            });
            await renderRunScreen({
                run: createWorkflowRunSummaryFixture({
                    id: '11111111-1111-4111-8111-111111111111', state: 'running', revision: 2, machineId: 'machine-1', origin: { kind: 'direct' },
                }),
                invocations,
            });
            await act(async () => readContentProps()?.onSelectInvocation('44444444-4444-4444-8444-444444444444'));
            await act(async () => {});

            staleRead.resolve(openRequestResponse(invocations[1]!, 1));
            await act(async () => {});
            // Issued at revision 2, answered from revision 1: superseded.
            expect(readContentProps()?.selectedContentUnavailable).toBe(true);
            expect(readContentProps()?.onRespondToRequest).toBeUndefined();

            // Re-asking re-arms the flight; the answer from revision 2 matches.
            await act(async () => requireDefined(
                readContentProps()?.onDeselectInvocation,
                'Expected an invocation deselection handler',
            )());
            await act(async () => readContentProps()?.onSelectInvocation('44444444-4444-4444-8444-444444444444'));
            await act(async () => {});
            expect(detailActions.getInvocation).toHaveBeenCalledTimes(2);
            expect(readContentProps()?.selectedContentUnavailable).toBe(true);
            expect(readContentProps()?.onRespondToRequest).toBeUndefined();

            freshRead.resolve(openRequestResponse(invocations[1]!, 2));
            await act(async () => {});
            expect(readContentProps()?.selectedContentUnavailable).toBe(false);
            expect(readContentProps()?.onRespondToRequest).toBeTypeOf('function');
        });

        it('re-arms selected callbacks once a matching read succeeds after a failure', async () => {
            const invocations = selectedRows();
            const retryRead = createDeferred<unknown>();
            let reads = 0;
            detailActions.getInvocation.mockImplementation(async () => {
                reads += 1;
                return reads === 1 ? Promise.reject(new Error('offline')) : retryRead.promise;
            });
            await renderRunScreen({
                run: createWorkflowRunSummaryFixture({
                    id: '11111111-1111-4111-8111-111111111111', state: 'running', machineId: 'machine-1', origin: { kind: 'direct' },
                }),
                invocations,
            });
            await act(async () => readContentProps()?.onSelectInvocation('44444444-4444-4444-8444-444444444444'));
            await act(async () => {});
            expect(readContentProps()?.selectedContentUnavailable).toBe(true);
            expect(readContentProps()?.onRespondToRequest).toBeUndefined();

            // Leaving and returning to the row re-asks for it. The evidence
            // stays unconfirmed through that flight — every effect run marks
            // it so before requesting — and only the matching answer re-arms
            // the callbacks the failure withdrew.
            await act(async () => requireDefined(
                readContentProps()?.onDeselectInvocation,
                'Expected an invocation deselection handler',
            )());
            await act(async () => readContentProps()?.onSelectInvocation('44444444-4444-4444-8444-444444444444'));
            await act(async () => {});
            expect(detailActions.getInvocation).toHaveBeenCalledTimes(2);
            expect(readContentProps()?.selectedContentUnavailable).toBe(true);
            expect(readContentProps()?.onRespondToRequest).toBeUndefined();

            retryRead.resolve(openRequestResponse(invocations[1]!, 1));
            await act(async () => {});
            expect(readContentProps()?.selectedContentUnavailable).toBe(false);
            expect(readContentProps()?.onRespondToRequest).toBeTypeOf('function');
        });
    });
});
