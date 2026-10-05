import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { WorkflowRunStartRequestV1Schema, WorkflowMaterializedLeafV1Schema, type WorkflowRunStartResultV1 } from '@happier-dev/protocol';
import { createWorkflowAccountRunActionOwner } from '@happier-dev/protocol/actions';
import { WorkflowRunGetResultV1Schema, WorkflowRunRecipientCensusResponseV1Schema, type RoleArtifactV1 } from '@happier-dev/protocol';
import { Modal, ModalProvider } from '@/modal';
import { getStorage } from '@/sync/domains/state/storageStore';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderScreen, invokeTestInstanceHandler } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import {
    createWorkflowDefinitionFixture,
    createWorkflowInvocationIndexFixture,
    createWorkflowRunSummaryFixture,
} from '@/dev/testkit/fixtures/workflowRunFixtures';
import { readWorkflowReviewedRunSeed } from '@/sync/domains/workflows/workflowReviewedRunSeed';
import { WorkflowRunScreen } from './WorkflowRunScreen';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';

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

let latestContentProps: WorkflowRunContentProps | null = null;
let restoreRunPopoverGlobals: (() => void) | undefined;

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
    const answer = latestContentProps?.onRespondToRequest?.(response);
    answer?.catch(() => {});
    return answer;
}

const actionTransport = vi.hoisted(() => vi.fn());
const startResponse = vi.hoisted(() => vi.fn());
const sourceAccessResponse = vi.hoisted(() => vi.fn());
const catalogResponse = vi.hoisted(() => vi.fn());
const routerSpy = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
const routeState = vi.hoisted((): { runId: string; invocationId?: string } => ({ runId: 'run-1' }));
// Per-Action transport replies. The real detail client still parses every reply.
const detailActions = vi.hoisted(() => ({
    getRun: vi.fn(),
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
        const machine = createMachineFixture({ metadata: { ...base.metadata!, homeDir: '/Users/me' } });
        getStorage().setState({
            profileScope: { serverId: 'server-a', accountId: 'account-a' },
            machines: { [machine.id]: machine }, machineListByServerId: {},
            workflowRunsById: {}, workflowRunInvocationsByRunId: {}, workflowRunListWindows: {},
            artifacts: {},
        });
    },
};
type MachineRpcCall = Readonly<{
    onIssued?: () => void;
    signal?: AbortSignal;
    [key: string]: unknown;
}>;
const machineRpcSpy = vi.hoisted(() => vi.fn<(params: MachineRpcCall) => Promise<unknown>>());
const appliedRuntime = vi.hoisted(() => ({ serverId: 'server-a' }));
const accountScopeHarness = {
    switchTo(scope: Readonly<{ serverId: string; accountId: string }>): void {
        retireActiveServerAccountScopeLifetime();
        appliedRuntime.serverId = scope.serverId;
        getStorage().setState({ profileScope: scope });
    },
    reset(): void {
        retireActiveServerAccountScopeLifetime();
        appliedRuntime.serverId = 'server-a';
    },
};

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    // Run again really does repeat effects, so it is confirmed. These cases are
    // about what the confirmed repeat carries, not about the gate itself.
    return createModalModuleMock({ confirmResult: true, renderCustomModals: true }).module;
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: routerSpy, params: () => ({ ...routeState }) }).module;
});
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => actionTransport,
}));
// Recipient-envelope HTTP services are outside this Run's Action transport.
// These tests never open Collaboration or prepare recipient keys.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => ({
    createSessionDataKeyEnvelopeClient: vi.fn(),
    readSessionDataKeyEnvelopeCollectionPage: vi.fn(),
    prepareSessionDataKeyEnvelopesForScope: vi.fn(),
    prepareSessionDataKeyEnvelopesDetached: vi.fn(),
}));
vi.mock('@/sync/api/teams/membershipSessionDataKeyEnvelopesApi', () => ({
    createMembershipSessionDataKeyEnvelopeClient: vi.fn(),
    prepareMembershipHistoryEnvelopesForScope: vi.fn(),
    membershipHistoryPreparationScopeKey: vi.fn(),
    prepareMembershipHistoryEnvelopesDetached: vi.fn(),
}));
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: () => appliedRuntime,
    isAppliedActiveServerRuntimeAvailable: () => true,
}));
vi.mock('@/utils/ui/clipboard', () => ({ setClipboardStringSafe: async () => true }));
// The machine transport is a real system boundary; everything below it — the
// screen's own in-flight bookkeeping and staleness guards — stays real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcSpy,
}));
vi.mock('../run/WorkflowRunContent', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../run/WorkflowRunContent')>();
    return { ...actual, WorkflowRunContent: (props: WorkflowRunContentProps) => {
        // Observe the host projection without replacing any child behavior.
        latestContentProps = props;
        return React.createElement(actual.WorkflowRunContent, props);
    } };
});

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

function invocationPage(invocations: readonly unknown[]) {
    return { invocations, parentRevision: 1 };
}

function runStartCalls() {
    return actionTransport.mock.calls.filter(([action]) => action === 'workflow.run.start');
}

function createRunScreenElement() {
    return <AppPaneProvider><ModalProvider><WorkflowRunScreen /></ModalProvider></AppPaneProvider>;
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
}>) {
    return {
        invocation: {
            index: params.index,
            parentRevision: params.parentRevision ?? 1,
            progress: {
                kind: 'happier.workflow-progress.v1',
                invocationPath: { blockId: 'analyze', scope: [] },
                blockKind: 'step',
                attempt: '0',
                logicalInvocationRecordId: 'analyze-row',
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
        createWorkflowInvocationIndexFixture({ id: 'root', parentRecordId: null, memberOrdinal: '0', sequence: '0' }),
        createWorkflowInvocationIndexFixture({
            id: 'analyze-row', parentRecordId: 'root', memberOrdinal: '0', sequence: '1', lifecycle: 'waiting_for_approval', contentRevision,
        }),
    ];
    detailActions.getInvocation.mockResolvedValue(permissionInvocationResponse({
        index: invocations[1],
        requestIds: ['permission-1', 'permission-2'],
    }));
    const screen = await renderRunScreen({
        run: createWorkflowRunSummaryFixture({
            id: 'run-1', state: 'running', machineId: 'machine-1', origin: { kind: 'direct' },
        }),
        invocations,
    });
    await act(async () => latestContentProps?.onSelectInvocation('analyze-row'));
    await act(async () => {});
    return screen;
}

async function renderRunScreen(overrides: Readonly<{
    run?: ReturnType<typeof createWorkflowRunSummaryFixture>;
    invocations?: readonly unknown[];
    failedInvocation?: unknown;
    definition?: unknown;
    result?: unknown;
    usage?: Readonly<{ inputTokens?: number; outputTokens?: number; costUsd?: number }>;
    finalOutputInvocationId?: string;
    historyNextCursor?: string;
    acceptedContext?: unknown;
    invocationListFailure?: Error;
    canEdit?: boolean;
    wrap?: (screen: React.ReactElement) => React.ReactElement;
}> = {}) {
    const run = overrides.run ?? createWorkflowRunSummaryFixture({
        id: 'run-1',
        state: 'succeeded',
        origin: { kind: 'direct' },
        availability: { cancel: false, pause: false },
    });
    const invocations = overrides.invocations ?? [];
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
    if (overrides.invocationListFailure === undefined) {
        detailActions.listInvocations.mockImplementation(async (input: Readonly<{ lifecycles?: readonly string[] }>) => (
            input.lifecycles?.length === 1 && input.lifecycles[0] === 'failed'
                ? invocationPage(overrides.failedInvocation === undefined ? [] : [overrides.failedInvocation])
                : {
                    ...invocationPage(invocations),
                    ...(input.lifecycles === undefined && overrides.historyNextCursor !== undefined
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

beforeEach(() => {
    installShippedNativeFrameScheduler();
    latestContentProps = null;
    routeState.runId = 'run-1';
    routeState.invocationId = undefined;
    accountScopeHarness.reset();
    storeState.reset();
    Modal.hideAll();
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
    actionTransport.mockImplementation(async (action: string, input: Record<string, unknown>, context: {
        signal?: AbortSignal; externalActionTarget?: { machineId: string };
        serverId?: string; expectedAccountId?: string;
        executionRunTargetMachineId?: string; onTransportIssued?: () => void;
    }) => {
        let result: unknown;
        switch (action) {
            case 'artifact.access.grants.list': return sourceAccessResponse(input, context);
            case 'workflow.definition.list': result = await catalogResponse(input, context); break;
            case 'execution.run.permission.respond': {
                const response = await machineRpcSpy({
                    machineId: context.executionRunTargetMachineId,
                    serverId: context.serverId,
                    accountId: context.expectedAccountId,
                    method: RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND,
                    payload: input,
                    signal: context.signal,
                    onIssued: context.onTransportIssued,
                });
                return response && typeof response === 'object' && 'ok' in response && response.ok === false
                    ? response : { ok: true, result: response };
            }
            case 'workflow.run.start': result = await startResponse(input); break;
            case 'workflow.run.get': result = await detailActions.getRun(input.runId, context.signal); break;
            case 'workflow.run.invocations.list': result = await detailActions.listInvocations(input, context.signal); break;
            case 'workflow.run.invocations.get': result = await detailActions.getInvocation(input, context.signal); break;
            case 'workflow.run.pause': result = await detailActions.pauseRun(input, context.signal); break;
            case 'workflow.run.cancel': result = await detailActions.cancelRun(input, context.signal); break;
            case 'workflow.run.invocations.retry': result = await detailActions.retryInvocation(input, context.signal); break;
            case 'workflow.run.delete': result = await detailActions.deleteRun(input, context.signal); break;
            case 'workflow.run.resume': result = context.externalActionTarget
                ? await detailActions.restoreWorkspace(input, context.externalActionTarget.machineId, context.signal)
                : await detailActions.resumeRun(input, context.signal); break;
            default: return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        }
        return { ok: true, result };
    });
    routerSpy.push.mockClear();
    routerSpy.back.mockClear();
    machineRpcSpy.mockReset();
    machineRpcSpy.mockResolvedValue({ ok: true });
    for (const action of Object.values(detailActions)) action.mockReset();
});

afterEach(async () => {
    await standardCleanup();
    restoreRunPopoverGlobals?.();
    restoreRunPopoverGlobals = undefined;
});

describe('WorkflowRunScreen', () => {

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
            expect(routerSpy.push).toHaveBeenCalledWith(expect.objectContaining({ params: { runId: request.runId } }));
            await screen.unmount();
        }
    });

    it('reviews a new Run with one explicit engine replacement after a step loses its agent', async () => {
        restoreRunPopoverGlobals = withPopoverWebGlobals({ frameScheduler: globalThis.requestAnimationFrame });
        routeState.invocationId = 'analyze-row';
        const root = createWorkflowInvocationIndexFixture({ id: 'root', lifecycle: 'failed' });
        const step = createWorkflowInvocationIndexFixture({ id: 'analyze-row', parentRecordId: 'root', lifecycle: 'failed' });
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
        await act(async () => latestContentProps?.onSelectInvocation('analyze-row'));
        await act(async () => {});
        expect(latestContentProps?.selectedInvocationProgress).toMatchObject({ blockKind: 'step', reason: { code: 'target_unavailable' } });
        expect(latestContentProps?.onRunWithAnotherAgent).toEqual(expect.any(Function));
        await screen.pressByTestIdAsync('workflow-run-run-another-agent');
        expect(runStartCalls()).toHaveLength(0);
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('workflow-run-another-agent-chip');
        act(() => invokeTestInstanceHandler(screen.findByProps({ testID: 'workflow-run-another-agent-field' }), 'onChange', {
            agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-6.1-sol',
        }));
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
        act(() => invokeTestInstanceHandler(screen.findByProps({ testID: 'workflow-run-another-agent-field' }), 'onChange', {
            agentTargetKey: 'backend:unresolved-acp:configured:unresolved-acp',
        }));
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
        act(() => invokeTestInstanceHandler(screen.findByProps({ testID: 'workflow-run-another-agent-field' }), 'onChange', {
            agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-6.1-sol',
        }));
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(runStartCalls()).toHaveLength(1);
        const request = WorkflowRunStartRequestV1Schema.parse(runStartCalls()[0]?.[1]);
        expect(request.source).toMatchObject({ kind: 'inline', replay: { runId: 'run-1', agentOverride: {
            sourceKey: '$root', blockId: 'analyze', engine: { agentTarget: {
                kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            }, modelSelection: { ref: { modelId: 'gpt-6.1-sol' } } },
        } } });
        expect(request.executionTarget).toEqual(ACCEPTED_CONTEXT.executionTarget);
        expect(detailActions.retryInvocation).not.toHaveBeenCalled();
        expect(acceptedLeaf.selection).toEqual({});
        expect(request.runId).not.toBe('run-1');
    });

    const sourceArtifactId = '1d7ade5a-0ab4-4fca-b38d-e20261c5beaf';
    function sourceGrantReply(access: 'owner' | 'edit' | 'admin' | 'view', artifactId = sourceArtifactId) {
        return { ok: true, result: { artifactId, ownerAccountId: 'account-owner', access, grants: [] } };
    }
    function sourceArtifact() {
        return { id: sourceArtifactId, title: 'Source', isDecrypted: true as const,
            headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    }

    it.each(['owner', 'edit', 'admin'] as const)('uses current source %s access for Edit independently of Run control access', async (access) => {
        sourceAccessResponse.mockResolvedValue(sourceGrantReply(access));
        await renderRunScreen({
            run: createWorkflowRunSummaryFixture({ sourceArtifactId }),
            canEdit: false,
        });
        expect(latestContentProps?.hasSource).toBe(true);
        expect(latestContentProps?.sourceAction?.kind).toBe('edit');
        act(() => latestContentProps?.sourceAction?.onPress());
        expect(routerSpy.push).toHaveBeenCalledWith(`/workflows/${sourceArtifactId}`);
        expect(sourceAccessResponse).toHaveBeenCalledWith({ artifactId: sourceArtifactId }, expect.objectContaining({
            surface: 'ui', serverId: 'server-a', expectedAccountId: 'account-a',
        }));
    });

    it('opens a view-only source even when the Run itself can be controlled', async () => {
        sourceAccessResponse.mockResolvedValue(sourceGrantReply('view'));
        await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        expect(latestContentProps?.sourceAction?.kind).toBe('open');
        act(() => latestContentProps?.sourceAction?.onPress());
        expect(routerSpy.push).toHaveBeenCalledWith(`/workflows/${sourceArtifactId}`);
    });

    it('keeps a deleted source distinct from a sourceless Run', async () => {
        await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        expect(latestContentProps?.hasSource).toBe(true);
        expect(latestContentProps?.sourceAction).toBeNull();
    });

    it.each(['saved', 'automation'] as const)('retains the frozen %s source identity when its summary no longer has an Artifact', async (kind) => {
        await renderRunScreen({ acceptedContext: { ...ACCEPTED_CONTEXT, source: {
            kind, definitionId: sourceArtifactId, revision: { headerVersion: 1, bodyVersion: 1 }, savedBy: null,
            ...(kind === 'automation' ? { automationId: 'automation-1' } : {}),
        } } });
        expect(latestContentProps?.hasSource).toBe(true);
        expect(latestContentProps?.sourceAction).toBeNull();
        expect(sourceAccessResponse).toHaveBeenCalledWith({ artifactId: sourceArtifactId }, expect.anything());
    });

    it('offers Save as workflow only as the sourceless Run action and seeds an unsaved draft', async () => {
        await renderRunScreen();
        expect(latestContentProps?.hasSource).toBe(false);
        expect(latestContentProps?.sourceAction).toBeNull();
        await act(async () => latestContentProps?.onSaveAsWorkflow?.());
        expect(routerSpy.push).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/workflows/new' }));
        expect(sourceAccessResponse).not.toHaveBeenCalled();
        expect(actionTransport.mock.calls.some(([action]) => action === 'workflow.definition.create')).toBe(false);
    });

    it.each(['builtin:review-and-converge', 'plugin:com.example/workflow'])('opens catalog source %s through the existing source route', async (ref) => {
        catalogResponse.mockResolvedValue({ definitions: [], pluginWorkflows: [{
            workflow: 'plugin:com.example/workflow', pluginId: 'com.example', version: '1.0.0',
            title: 'Example workflow', definition: DEFINITION,
        }] });
        await renderRunScreen({ acceptedContext: {
            ...ACCEPTED_CONTEXT, source: { kind: 'catalog', ref, version: 1 },
        } });
        expect(latestContentProps?.hasSource).toBe(true);
        expect(latestContentProps?.sourceAction?.kind).toBe('open');
        act(() => latestContentProps?.sourceAction?.onPress());
        expect(routerSpy.push).toHaveBeenCalledWith(`/workflows/${encodeURIComponent(ref)}`);
        expect(sourceAccessResponse).not.toHaveBeenCalled();
    });

    it.each(['builtin:removed', 'plugin:com.example/removed'])('hides the action for unavailable catalog source %s', async (ref) => {
        await renderRunScreen({ acceptedContext: {
            ...ACCEPTED_CONTEXT, source: { kind: 'catalog', ref, version: 1 },
        } });
        expect(latestContentProps?.hasSource).toBe(true);
        expect(latestContentProps?.sourceAction).toBeNull();
    });

    it('invalidates source actions on source updates/deletion and rejects retained callbacks', async () => {
        const artifact = sourceArtifact();
        getStorage().setState({ artifacts: { [sourceArtifactId]: artifact } });
        sourceAccessResponse.mockResolvedValue(sourceGrantReply('edit'));
        await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        const edit = latestContentProps?.sourceAction;
        expect(edit?.kind).toBe('edit');
        sourceAccessResponse.mockResolvedValue(sourceGrantReply('view'));
        await act(async () => getStorage().setState({ artifacts: {
            [sourceArtifactId]: { ...artifact, updatedAt: 2, seq: 2 },
        } }));
        act(() => edit?.onPress());
        expect(routerSpy.push).not.toHaveBeenCalled();
        expect(latestContentProps?.sourceAction?.kind).toBe('open');
        const open = latestContentProps?.sourceAction;
        sourceAccessResponse.mockResolvedValue({ ok: false, errorCode: 'artifact_not_found', error: 'artifact_not_found' });
        await act(async () => getStorage().setState({ artifacts: {} }));
        act(() => open?.onPress());
        expect(latestContentProps?.sourceAction).toBeNull();
        expect(latestContentProps?.hasSource).toBe(true);
        expect(routerSpy.push).not.toHaveBeenCalled();
    });

    it('fails source actions closed on a mismatched Artifact reply', async () => {
        sourceAccessResponse.mockResolvedValue(sourceGrantReply('owner', 'another-artifact'));
        await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        expect(latestContentProps?.sourceAction).toBeNull();
    });

    it('ignores older source access responses after a source update confirms view access', async () => {
        const older = createDeferred<ReturnType<typeof sourceGrantReply>>();
        const artifact = sourceArtifact();
        getStorage().setState({ artifacts: { [sourceArtifactId]: artifact } });
        sourceAccessResponse.mockReturnValueOnce(older.promise).mockResolvedValue(sourceGrantReply('view'));
        await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        expect(latestContentProps?.sourceAction).toBeNull();
        await act(async () => getStorage().setState({ artifacts: {
            [sourceArtifactId]: { ...artifact, updatedAt: 2, seq: 2 },
        } }));
        expect(latestContentProps?.sourceAction?.kind).toBe('open');
        await act(async () => older.resolve(sourceGrantReply('owner')));
        expect(latestContentProps?.sourceAction?.kind).toBe('open');
    });

    it('rejects late source access after account retirement', async () => {
        const access = createDeferred<ReturnType<typeof sourceGrantReply>>();
        sourceAccessResponse.mockReturnValue(access.promise);
        const screen = await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        expect(sourceAccessResponse).toHaveBeenCalled();
        expect(latestContentProps?.sourceAction).toBeNull();
        // Install the replacement Account's pending read before the scope
        // notification starts it, so it cannot acknowledge Account A's fixture.
        detailActions.getRun.mockReturnValue(new Promise(() => {}));
        act(() => accountScopeHarness.switchTo({ serverId: 'server-b', accountId: 'account-b' }));
        await screen.update(createRunScreenElement());
        await act(async () => access.resolve(sourceGrantReply('owner')));
        expect(latestContentProps?.sourceAction ?? null).toBeNull();
        expect(screen.findAllHostsByTestId('workflow-run-edit-workflow')).toHaveLength(0);
        expect(routerSpy.push).not.toHaveBeenCalled();
    });

    it('rejects a retained source callback immediately when its Account lifetime retires', async () => {
        sourceAccessResponse.mockResolvedValue(sourceGrantReply('owner'));
        await renderRunScreen({ run: createWorkflowRunSummaryFixture({ sourceArtifactId }) });
        const edit = latestContentProps?.sourceAction;
        expect(edit?.kind).toBe('edit');
        act(() => retireActiveServerAccountScopeLifetime());
        act(() => edit?.onPress());
        expect(routerSpy.push).not.toHaveBeenCalled();
        expect(latestContentProps?.sourceAction).toBeNull();
    });

    it('uses exact terminal queries beyond page one and keeps the bounded authoritative result visible', async () => {
        const failed = createWorkflowInvocationIndexFixture({
            id: 'failed-off-page', sequence: '90', lifecycle: 'failed',
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
            run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'succeeded' }),
            definition,
            invocations: [createWorkflowInvocationIndexFixture({ id: 'page-one', sequence: '1' })],
            failedInvocation: failed,
            historyNextCursor: 'more-history',
            result: longResult,
            finalOutputInvocationId: 'final-off-page',
        });

        expect(detailActions.listInvocations).toHaveBeenCalledWith(
            { runId: 'run-1', lifecycles: ['failed'], limit: 1 },
            expect.any(AbortSignal),
        );
        expect(latestContentProps?.invocationHistoryComplete).toBe(false);
        expect(latestContentProps?.finalOutputInvocationId).toBe('final-off-page');
        expect(latestContentProps?.firstFailedInvocationId).toBe('failed-off-page');
        expect(latestContentProps?.resultLabel).toBe(`${'x'.repeat(2_000)}…`);
    });

    it('keeps failure discovery unresolved through loading and error without discarding the result preview', async () => {
        const failedPage = createDeferred<ReturnType<typeof invocationPage>>();
        const run = createWorkflowRunSummaryFixture({ id: 'run-1', state: 'succeeded' });
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

        expect(latestContentProps?.firstFailedInvocationResolution).toBe('loading');
        expect(latestContentProps?.resultLabel).toBe('Authoritative result preview');

        failedPage.reject(new Error('offline'));
        await act(async () => {});

        expect(latestContentProps?.firstFailedInvocationResolution).toBe('error');
        expect(latestContentProps?.resultLabel).toBe('Authoritative result preview');
    });

    it('keeps an authoritative JSON null result distinct from no result', async () => {
        await renderRunScreen({
            run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'succeeded' }),
            result: null,
            finalOutputInvocationId: 'final-null',
        });

        expect(latestContentProps?.resultLabel).toBe('null');
        expect(latestContentProps?.finalOutputInvocationId).toBe('final-null');
    });

    /**
     * A direct Run admitted from an unnamed draft has an opened accepted
     * context with no metadata. That is an untitled Run, not private content
     * this device cannot open; only an unopened context is unavailable.
     */
    it('names an opened untitled Run as a workflow run rather than as unavailable private content', async () => {
        await renderRunScreen({ acceptedContext: ACCEPTED_CONTEXT });
        expect(latestContentProps?.title).toBe('workflows.run.untitled');

        await renderRunScreen({
            acceptedContext: { ...ACCEPTED_CONTEXT, metadata: { title: 'Review 500 files' } },
        });
        expect(latestContentProps?.title).toBe('Review 500 files');
    });

    it('presents aggregate usage through locale-aware token and currency owners', async () => {
        await renderRunScreen({
            usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.04 },
        });

        expect(latestContentProps?.usageLabel).toContain('150');
        expect(latestContentProps?.usageLabel).toContain(new Intl.NumberFormat(undefined, {
            style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4,
        }).format(0.04));
        expect(latestContentProps?.usageLabel).not.toContain(' in');
        expect(latestContentProps?.usageLabel).not.toContain(' out');
    });

    it('keeps a loaded summary visible and exposes the same loader retry when invocation discovery fails', async () => {
        await renderRunScreen({
            run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running' }),
            invocationListFailure: new Error('offline'),
        });

        expect(latestContentProps?.run.id).toBe('run-1');
        expect(latestContentProps?.errorLabel).toBe('workflows.loadFailedBody');
        const reload = latestContentProps?.onReload;
        expect(reload).toBeTypeOf('function');
        const callsBeforeRetry = detailActions.listInvocations.mock.calls.length;

        detailActions.listInvocations.mockResolvedValue(invocationPage([]));
        await act(async () => reload?.());
        await act(async () => {});

        expect(detailActions.listInvocations).toHaveBeenCalledTimes(callsBeforeRetry + 2);
        expect(latestContentProps?.onReload).toBeUndefined();
        expect(latestContentProps?.errorLabel).toBeNull();
        expect(latestContentProps?.invocationsLoaded).toBe(true);
    });

    it('submits the accepted Run identity for a confirmed repeat rather than only its flattened definition', async () => {
        const screen = await renderRunScreen();
        await reviewRunAgain(screen);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        const request = WorkflowRunStartRequestV1Schema.parse(runStartCalls()[0]?.[1]);
        expect(request.source).toMatchObject({ kind: 'inline', replay: { runId: 'run-1' } });
    });

    it('does not let a late Run-again completion navigate after this mounted screen changes Runs', async () => {
        const admission = createDeferred<WorkflowRunStartResultV1>();
        startResponse.mockImplementationOnce(async () => admission.promise);
        const screen = await renderRunScreen();
        await reviewRunAgain(screen);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(runStartCalls()).toHaveLength(1);

        routeState.runId = 'run-2';
        const runB = createWorkflowRunSummaryFixture({
            id: 'run-2', state: 'running', origin: { kind: 'direct' },
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
        expect(latestContentProps?.run.id).toBe('run-2');

        admission.resolve({ admission: 'created', run: createWorkflowRunSummaryFixture({ id: 'run-again-from-a' }) });
        await act(async () => {});

        expect(routerSpy.push).not.toHaveBeenCalled();
    });

    it('opens Save as workflow as a reviewed unsaved draft without creating an Artifact', async () => {
        await renderRunScreen({ acceptedContext: { ...ACCEPTED_CONTEXT, metadata: { title: 'Release review', description: 'Accepted description' } } });
        const saveAsWorkflow = latestContentProps?.onSaveAsWorkflow;

        act(() => { saveAsWorkflow?.(); });
        await act(async () => {});
        const route = routerSpy.push.mock.calls.at(-1)?.[0] as {
            pathname: string; params: { reviewedRunSeedId: string };
        } | undefined;
        expect(route).toEqual({ pathname: '/workflows/new', params: { reviewedRunSeedId: expect.any(String) } });
        if (route === undefined) throw new Error('Expected the unsaved review route');
        expect(readWorkflowReviewedRunSeed(route.params.reviewedRunSeedId)).toMatchObject({
            definition: DEFINITION,
            name: 'Release review', description: 'Accepted description',
            project: ACCEPTED_CONTEXT.workspaceTarget.project,
            inputs: ACCEPTED_CONTEXT.inputs,
        });
        expect(machineRpcSpy).not.toHaveBeenCalled();
        expect(latestContentProps?.saveAsWorkflowPending).toBe(false);
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
        expect(runStartCalls()).toHaveLength(1);

        await screen.unmount();

        admission.resolve({ admission: 'created', run: createWorkflowRunSummaryFixture({ id: 'run-again-after-close' }) });
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
                id: 'run-1',
                state: 'succeeded',
                origin: { kind: 'direct' },
                workflowCustodyState: 'settled',
                availability: { cancel: false, pause: false },
            }),
        });
        const onDelete = latestContentProps?.onDelete;
        expect(onDelete).toBeTypeOf('function');

        act(() => { onDelete?.(); });
        await act(async () => {});
        expect(detailActions.deleteRun).toHaveBeenCalledTimes(1);

        await screen.unmount();

        deletion.resolve({ deleted: true, runId: 'run-1' });
        await act(async () => {});

        expect(routerSpy.back).not.toHaveBeenCalled();
        expect(storeState.state.workflowRunsById['run-1']).toBeDefined();
    });

    it('repeats a Run under exactly the execution target its accepted context froze', async () => {
        const screen = await renderRunScreen();
        expect(latestContentProps?.onRunAgain).toBeTypeOf('function');
        await reviewRunAgain(screen);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(runStartCalls()).toHaveLength(1);
        expect(runStartCalls()[0]?.[1]).toMatchObject({
            executionTarget: { kind: 'detached_run' },
        });
        expect(runStartCalls()[0]?.[2]).toMatchObject({
            externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { directory: '/Users/me/project' } },
        });
        const admittedId = WorkflowRunStartRequestV1Schema.parse(runStartCalls()[0]?.[1]).runId;
        expect(storeState.state.workflowRunsById[admittedId]?.summary).toMatchObject({ id: admittedId, state: 'queued' });
        expect(routerSpy.push).toHaveBeenCalledWith({ pathname: '/workflows/runs/[runId]', params: { runId: admittedId } });
    });

    it('supplies the derived structural identity of unopened rows to the shared Run body', async () => {
        await renderRunScreen({
            run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running', origin: { kind: 'direct' } }),
            invocations: [
                createWorkflowInvocationIndexFixture({ id: 'root', parentRecordId: null, memberOrdinal: '0', sequence: '0' }),
                createWorkflowInvocationIndexFixture({ id: 'analyze-row', parentRecordId: 'root', memberOrdinal: '0', sequence: '1' }),
            ],
        });

        expect(latestContentProps?.invocationStructure?.get('analyze-row')).toMatchObject({
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
            createWorkflowInvocationIndexFixture({ id: 'root', parentRecordId: null, memberOrdinal: '0', sequence: '0' }),
            createWorkflowInvocationIndexFixture({
                id: 'analyze-row', parentRecordId: 'root', memberOrdinal: '0', sequence: '1', lifecycle: 'needs_attention',
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
                    logicalInvocationRecordId: 'analyze-row',
                    reason: { code },
                },
            },
        });
        await renderRunScreen({
            run: createWorkflowRunSummaryFixture({
                id: 'run-1', state: 'interrupted', origin: { kind: 'direct' },
                // Nothing is waiting for a stop to be confirmed, so the reviewed
                // new Run is genuinely reachable rather than blocked behind
                // `workflow_outcome_unresolved`.
                workflowCustodyState: 'settled',
                availability: { cancel: false, pause: false },
            }),
            invocations,
        });
        await act(async () => latestContentProps?.onSelectInvocation('analyze-row'));
        await act(async () => {});

        expect(latestContentProps?.onStartReviewedNewRun).toBeTypeOf('function');
        // Exactly one D4 arm: no restoration producer exists here, so the screen
        // hands down no restore handler either.
        expect(latestContentProps?.onRestoreWorkspace).toBeUndefined();
        await act(async () => requireDefined(
            latestContentProps?.onStartReviewedNewRun,
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
            definition: DEFINITION, supersededRunId: 'run-1',
        });
    });

    it('restores the selected invocation workspace on the Run Machine without silently starting a new Run', async () => {
        const invocations = [
            createWorkflowInvocationIndexFixture({ id: 'root', parentRecordId: null, memberOrdinal: '0', sequence: '0' }),
            createWorkflowInvocationIndexFixture({
                id: 'analyze-row', parentRecordId: 'root', memberOrdinal: '0', sequence: '1', lifecycle: 'failed',
            }),
        ];
        detailActions.getInvocation.mockResolvedValue({
            invocation: {
                index: invocations[1],
                parentRevision: 1,
                progress: {
                    kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'analyze', scope: [] },
                    blockKind: 'step', attempt: '0', logicalInvocationRecordId: 'analyze-row',
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
        const run = createWorkflowRunSummaryFixture({ sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
            id: 'run-1', state: 'interrupted', revision: 1, machineId: 'machine-1', origin: { kind: 'direct' },
            workflowCustodyState: 'settled',
            availability: { cancel: false, pause: false, restoreWorkspace: true },
        });
        detailActions.restoreWorkspace.mockResolvedValue({ run: { ...run, state: 'running', revision: 2 }, intent: 'resumed' });
        await renderRunScreen({ run, invocations });
        await act(async () => latestContentProps?.onSelectInvocation('analyze-row'));
        await act(async () => {});

        expect(latestContentProps?.onRestoreWorkspace).toBeTypeOf('function');
        // Restoration resumes this Run, so the arm that would repeat its
        // completed work is not offered beside it.
        expect(latestContentProps?.onStartReviewedNewRun).toBeUndefined();
        await act(async () => latestContentProps?.onRestoreWorkspace?.());
        await act(async () => {});

        expect(detailActions.restoreWorkspace).toHaveBeenCalledWith({
            mode: 'recover', runId: 'run-1', expectedRevision: 1,
            invocations: [{
                kind: 'restore_workspace', invocation: { recordId: 'analyze-row' },
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
            createWorkflowInvocationIndexFixture({ id: 'root', parentRecordId: null, memberOrdinal: '0', sequence: '0' }),
            createWorkflowInvocationIndexFixture({
                id: 'analyze-row', parentRecordId: 'root', memberOrdinal: '0', sequence: '1', lifecycle: 'needs_attention',
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
                    logicalInvocationRecordId: 'analyze-row',
                    uncertainPriorEffects: { activity: 'stopped' },
                },
                recoveryAvailability: {
                    reattach: { kind: 'unavailable', reason: 'invocation_not_recoverable' },
                    retry: { kind: 'available', causalInvocationIds: ['analyze-row'] },
                    continueSameConversation: { kind: 'available' },
                    continueFreshAgent: { kind: 'unavailable', reason: 'recovery_not_prepared' },
                    restoreWorkspace: { kind: 'unavailable', reason: 'recovery_not_prepared' },
                },
            },
        });
        detailActions.retryInvocation.mockResolvedValue({
            run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running' }),
            invocation: invocations[1], disposition: 'accepted',
        });
        await renderRunScreen({
            run: createWorkflowRunSummaryFixture({
                id: 'run-1', state: 'interrupted', origin: { kind: 'direct' },
                availability: { cancel: false, pause: false },
            }),
            invocations,
        });
        await act(async () => latestContentProps?.onSelectInvocation('analyze-row'));
        await act(async () => {});

        const replacement = {
            conversation: 'same_conversation' as const,
            document: { text: 'Retry the reviewed objective', references: [], attachments: [] },
            input: ['reviewed context'],
        };
        await act(async () => requireDefined(
            latestContentProps?.onRetryWithReplacement,
            'Expected a same-conversation replacement retry handler',
        )(replacement));
        await act(async () => {});
        expect(detailActions.retryInvocation).not.toHaveBeenCalled();

        await act(async () => requireDefined(
            latestContentProps?.onAcknowledgeUncertainPriorEffects,
            'Expected an uncertain-effects acknowledgement handler',
        )());
        await act(async () => requireDefined(
            latestContentProps?.onRetryWithReplacement,
            'Expected a same-conversation replacement retry handler',
        )(replacement));
        await act(async () => {});
        expect(detailActions.retryInvocation).toHaveBeenCalledTimes(1);
        expect(detailActions.retryInvocation.mock.calls[0]?.[0]).toMatchObject({
            acknowledgeUncertainPriorEffects: true,
            causalInvocationIds: ['analyze-row'],
            conversation: 'same_conversation',
            input: {
                kind: 'replacement',
                value: { document: replacement.document, input: replacement.input },
            },
        });
    });

    it('submits a prepared continuation with every reviewed causal row and replacement input', async () => {
        const invocations = [
            createWorkflowInvocationIndexFixture({ id: 'root', parentRecordId: null, memberOrdinal: '0', sequence: '0' }),
            createWorkflowInvocationIndexFixture({
                id: 'analyze-row', parentRecordId: 'root', memberOrdinal: '0', sequence: '1', lifecycle: 'needs_attention',
            }),
            createWorkflowInvocationIndexFixture({
                id: 'cancelled-row', parentRecordId: 'root', memberOrdinal: '1', sequence: '2', lifecycle: 'cancelled',
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
                    logicalInvocationRecordId: 'analyze-row',
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
                    retry: { kind: 'available', causalInvocationIds: ['root', 'analyze-row', 'cancelled-row'] },
                    continueSameConversation: { kind: 'available' },
                    continueFreshAgent: { kind: 'unavailable', reason: 'recovery_not_prepared' },
                    restoreWorkspace: { kind: 'unavailable', reason: 'recovery_not_prepared' },
                },
            },
        });
        detailActions.resumeRun.mockResolvedValue({
            run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running' }),
            intent: 'resumed',
        });
        detailActions.retryInvocation.mockResolvedValue({
            run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running' }),
            invocation: invocations[1], disposition: 'accepted',
        });
        await renderRunScreen({
            run: createWorkflowRunSummaryFixture({
                id: 'run-1', state: 'interrupted', origin: { kind: 'direct' },
                availability: { cancel: false, pause: false },
            }),
            invocations,
        });
        await act(async () => latestContentProps?.onSelectInvocation('analyze-row'));
        await act(async () => {});

        expect(latestContentProps?.preparedRecovery).toMatchObject({ conversation: 'same_conversation' });
        await act(async () => requireDefined(
            latestContentProps?.onContinuePrepared,
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
            runId: 'run-1',
            expectedRevision: 1,
            invocation: { recordId: 'analyze-row' },
            causalInvocationIds: ['root', 'analyze-row', 'cancelled-row'],
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
    it('issues exactly one durable Run operation at a time and refuses the rest until it settles', async () => {
        const invocations = [
            createWorkflowInvocationIndexFixture({ id: 'root', parentRecordId: null, memberOrdinal: '0', sequence: '0' }),
            createWorkflowInvocationIndexFixture({
                id: 'analyze-row', parentRecordId: 'root', memberOrdinal: '0', sequence: '1', lifecycle: 'failed',
            }),
        ];
        detailActions.getInvocation.mockResolvedValue({
            invocation: {
                index: invocations[1],
                parentRevision: 1,
                progress: {
                    kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'analyze', scope: [] },
                    blockKind: 'step', attempt: '0', logicalInvocationRecordId: 'analyze-row',
                },
            },
        });
        const run = createWorkflowRunSummaryFixture({
            id: 'run-1', state: 'running', revision: 1, origin: { kind: 'direct' },
            availability: { pause: true, cancel: true },
        });
        const pause = createDeferred<Readonly<{ run: typeof run; intent: 'pause_requested' }>>();
        detailActions.pauseRun.mockImplementationOnce(() => pause.promise);
        detailActions.cancelRun.mockResolvedValue({ run: { ...run, state: 'cancelled', revision: 3 }, intent: 'cancelled' });
        detailActions.retryInvocation.mockResolvedValue({ run: { ...run, revision: 3 }, invocation: invocations[1], disposition: 'accepted' });
        await renderRunScreen({ run, invocations });
        await act(async () => latestContentProps?.onSelectInvocation('analyze-row'));
        await act(async () => {});

        act(() => { latestContentProps?.onPause?.(); });
        expect(detailActions.pauseRun).toHaveBeenCalledTimes(1);
        expect(latestContentProps?.pendingControl).toBe('pause');

        // While Pause is unsettled, Cancel and Retry are conflicting durable
        // operations against the same revision: none may issue.
        act(() => {
            latestContentProps?.onCancel?.();
            latestContentProps?.onCancel?.();
            latestContentProps?.onRetrySameConversation?.();
            latestContentProps?.onRetrySameConversation?.();
        });
        await act(async () => {});
        expect(detailActions.cancelRun).not.toHaveBeenCalled();
        expect(detailActions.retryInvocation).not.toHaveBeenCalled();

        pause.resolve({ run: { ...run, state: 'pause_requested', revision: 2 }, intent: 'pause_requested' });
        await act(async () => {});
        expect(latestContentProps?.pendingControl).toBeNull();
        expect(latestContentProps?.run.revision).toBe(2);

        // Two presses in one frame: the ref, not the rendered state, is the gate.
        act(() => {
            latestContentProps?.onCancel?.();
            latestContentProps?.onCancel?.();
        });
        await act(async () => {});
        expect(detailActions.cancelRun).toHaveBeenCalledTimes(1);
        expect(detailActions.cancelRun.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 2 });
        expect(latestContentProps?.run.revision).toBe(3);
    });

    it('lets a durable operation that outlives a Run change neither settle this screen nor overwrite the new Run', async () => {
        const runA = createWorkflowRunSummaryFixture({
            id: 'run-1', state: 'running', revision: 1, origin: { kind: 'direct' }, availability: { cancel: true },
        });
        const cancel = createDeferred<Readonly<{ run: typeof runA; intent: 'cancelled' }>>();
        detailActions.cancelRun.mockImplementationOnce(() => cancel.promise);
        const screen = await renderRunScreen({ run: runA });
        act(() => { latestContentProps?.onCancel?.(); });
        expect(latestContentProps?.pendingControl).toBe('cancel');

        routeState.runId = 'run-2';
        const runB = createWorkflowRunSummaryFixture({
            id: 'run-2', state: 'running', revision: 5, origin: { kind: 'direct' }, availability: { cancel: true },
        });
        detailActions.getRun.mockResolvedValue({
            run: runB, definition: DEFINITION, authoredDefinition: DEFINITION, acceptedContext: ACCEPTED_CONTEXT, checkpoint: null,
            callerAccess: { canEdit: true },
        });
        detailActions.listInvocations.mockResolvedValue(invocationPage([]));
        await screen.update(createRunScreenElement());
        await act(async () => {});
        expect(latestContentProps?.run.id).toBe('run-2');
        // The new Run starts with no operation in flight; A's cancel is not its business.
        expect(latestContentProps?.pendingControl).toBeNull();

        detailActions.cancelRun.mockResolvedValueOnce({ run: { ...runB, state: 'cancelled', revision: 6 }, intent: 'cancelled' });
        act(() => { latestContentProps?.onCancel?.(); });
        await act(async () => {});
        expect(detailActions.cancelRun).toHaveBeenCalledTimes(2);
        expect(latestContentProps?.run.revision).toBe(6);

        cancel.resolve({ run: { ...runA, state: 'cancelled', revision: 2 }, intent: 'cancelled' });
        await act(async () => {});
        expect(latestContentProps?.run.id).toBe('run-2');
        expect(latestContentProps?.run.revision).toBe(6);
        expect(storeState.state.workflowRunsById['run-1']).toMatchObject({ revision: 1 });
    });

    it('keeps both permission controls withdrawn until the exact canonical reread removes the request', async () => {
        const decision = createDeferred<Readonly<{ ok: boolean }>>();
        const reconciliation = createDeferred<ReturnType<typeof permissionInvocationResponse>>();
        machineRpcSpy.mockImplementationOnce(async (params) => {
            params.onIssued?.();
            return decision.promise;
        });
        await renderSelectedPermissionRequests();

        expect(latestContentProps?.onRespondToRequest).toBeTypeOf('function');
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
        expect([...(latestContentProps?.pendingRequestIds ?? [])]).toEqual(['permission-1']);

        // The opposite press must not race a competing response for the same request.
        act(() => { void respondToRequest({ requestId: 'permission-1', approved: false }); });
        await act(async () => {});
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);

        decision.resolve({ ok: true });
        await act(async () => {});

        expect(detailActions.getInvocation).toHaveBeenCalledTimes(exactReadsBeforeDecision + 1);
        // An acknowledgement is not settlement. The request stays withdrawn
        // while the exact canonical content read is unresolved.
        expect([...(latestContentProps?.pendingRequestIds ?? [])]).toEqual(['permission-1']);
        act(() => { void respondToRequest({ requestId: 'permission-1', approved: false }); });
        await act(async () => {});
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);

        reconciliation.resolve(permissionInvocationResponse({
            index: createWorkflowInvocationIndexFixture({
                id: 'analyze-row', parentRecordId: 'root', memberOrdinal: '0', sequence: '1', lifecycle: 'running',
            }),
            requestIds: ['permission-2'],
        }));
        await act(async () => {});

        expect([...(latestContentProps?.pendingRequestIds ?? [])]).toEqual([]);
    });

    it('keeps an issued permission decision pending when reconciliation returns an older row token', async () => {
        await renderSelectedPermissionRequests('2');
        machineRpcSpy.mockImplementationOnce(async (params) => {
            params.onIssued?.();
            return { ok: true };
        });
        detailActions.getInvocation.mockResolvedValueOnce(permissionInvocationResponse({
            index: createWorkflowInvocationIndexFixture({
                id: 'analyze-row', parentRecordId: 'root', memberOrdinal: '0', sequence: '1',
                lifecycle: 'running', contentRevision: '1',
            }),
            requestIds: [],
        }));

        await act(async () => { await respondToRequest({ requestId: 'permission-1', approved: true }); });

        expect([...(latestContentProps?.pendingRequestIds ?? [])]).toEqual(['permission-1']);
        expect(storeState.state.workflowRunInvocationsByRunId['run-1']?.factsById['analyze-row']?.contentRevision).toBe('2');
    });

    it('sends structured question answers through the discoverable Action and exact detached-run request writer', async () => {
        await renderSelectedPermissionRequests();

        expect(latestContentProps?.onRespondToRequest).toBeTypeOf('function');
        await act(async () => { await respondToRequest({
            requestId: 'permission-1',
            answers: { branch: ['dev'] },
        })?.catch(() => {}); });

        expect(actionTransport).toHaveBeenCalledWith('execution.run.permission.respond', {
            runId: 'exec-1', requestId: 'permission-1', answers: { branch: ['dev'] },
        }, expect.objectContaining({
            surface: 'ui', serverId: 'server-a', expectedAccountId: 'account-a',
            executionRunTargetMachineId: 'machine-1', signal: expect.any(AbortSignal),
            onTransportIssued: expect.any(Function),
        }));

        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND,
            payload: {
                runId: 'exec-1',
                requestId: 'permission-1',
                answers: { branch: ['dev'] },
            },
        }));
    });

    it('leaves a queued Action approval request answerable when no detached response was issued', async () => {
        await renderSelectedPermissionRequests();
        const transport = actionTransport.getMockImplementation()!;
        actionTransport.mockImplementation(async (action, input, context) => action === 'execution.run.permission.respond'
            ? { ok: true, result: { kind: 'approval_request_created', artifactId: 'approval-1', actionId: action } }
            : transport(action, input, context));

        await act(async () => { await respondToRequest({ requestId: 'permission-1', approved: true })?.catch(() => {}); });

        expect(machineRpcSpy).not.toHaveBeenCalled();
        expect([...(latestContentProps?.pendingRequestIds ?? [])]).toEqual([]);
    });

    it('reconciles a not-found response and suppresses the opposite answer while canonical content still has the request', async () => {
        machineRpcSpy.mockImplementationOnce(async (params) => {
            params.onIssued?.();
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
        expect(latestContentProps?.errorLabel ?? null).toBeNull();
        expect([...(latestContentProps?.pendingRequestIds ?? [])]).toEqual(['permission-1']);
        act(() => { void respondToRequest({ requestId: 'permission-1', approved: false }); });
        await act(async () => {});
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
    });

    it('reconciles an issued timeout without making the request retryable from an unknown outcome', async () => {
        machineRpcSpy.mockImplementationOnce(async (params) => {
            params.onIssued?.();
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
        expect(latestContentProps?.errorLabel ?? null).toBeNull();
        expect([...(latestContentProps?.pendingRequestIds ?? [])]).toEqual(['permission-1']);
        act(() => { void respondToRequest({ requestId: 'permission-1', approved: false }); });
        await act(async () => {});
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
    });

    it('permits retry after an exact reread confirms a failure happened before transport issuance', async () => {
        const reconciliation = createDeferred<ReturnType<typeof permissionInvocationResponse>>();
        machineRpcSpy.mockRejectedValueOnce(new Error('scope unavailable before emission'));
        await renderSelectedPermissionRequests();
        detailActions.getInvocation.mockImplementationOnce(async () => reconciliation.promise);

        act(() => { void respondToRequest({ requestId: 'permission-1', approved: true }); });
        await act(async () => {});

        expect([...(latestContentProps?.pendingRequestIds ?? [])]).toEqual(['permission-1']);
        reconciliation.resolve(permissionInvocationResponse({
            index: createWorkflowInvocationIndexFixture({
                id: 'analyze-row', parentRecordId: 'root', memberOrdinal: '0', sequence: '1', lifecycle: 'waiting_for_approval',
            }),
            requestIds: ['permission-1', 'permission-2'],
        }));
        await act(async () => {});

        expect([...(latestContentProps?.pendingRequestIds ?? [])]).toEqual([]);
        await act(async () => { await respondToRequest({ requestId: 'permission-1', approved: false })?.catch(() => {}); });
        expect(machineRpcSpy).toHaveBeenCalledTimes(2);
    });

    it('keeps an unchanged invalid response withdrawn after canonical content confirms the request is still open', async () => {
        machineRpcSpy.mockImplementationOnce(async (params) => {
            params.onIssued?.();
            return { ok: false, errorCode: 'execution_run_invalid_action_input' };
        });
        await renderSelectedPermissionRequests();

        await act(async () => { await respondToRequest({ requestId: 'permission-1', approved: true })?.catch(() => {}); });
        await act(async () => {});

        expect([...(latestContentProps?.pendingRequestIds ?? [])]).toEqual(['permission-1']);
        act(() => { void respondToRequest({ requestId: 'permission-1', approved: false }); });
        await act(async () => {});
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
    });

    it('retires the exact Account operation so an A to B to A completion cannot touch the replacement request', async () => {
        const decision = createDeferred<Readonly<{ ok: boolean }>>();
        const replacementDecision = createDeferred<Readonly<{ ok: boolean }>>();
        machineRpcSpy
            .mockImplementationOnce(async (params) => {
                params.onIssued?.();
                return decision.promise;
            })
            .mockImplementationOnce(async (params) => {
                params.onIssued?.();
                return replacementDecision.promise;
            });
        const screen = await renderSelectedPermissionRequests();
        act(() => { void respondToRequest({ requestId: 'permission-1', approved: true }); });
        await act(async () => {});
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
        const firstSignal = machineRpcSpy.mock.calls[0]?.[0].signal;
        expect(firstSignal?.aborted).toBe(false);

        act(() => accountScopeHarness.switchTo({ serverId: 'server-b', accountId: 'account-b' }));
        const runB = createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running', machineId: 'machine-1' });
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
        expect(firstSignal?.aborted).toBe(true);

        act(() => accountScopeHarness.switchTo({ serverId: 'server-a', accountId: 'account-a' }));
        await screen.update(createRunScreenElement());
        await act(async () => {});
        await act(async () => latestContentProps?.onSelectInvocation('analyze-row'));
        await act(async () => {});
        act(() => { void respondToRequest({ requestId: 'permission-1', approved: false }); });
        await act(async () => {});
        expect(machineRpcSpy).toHaveBeenCalledTimes(2);
        expect([...(latestContentProps?.pendingRequestIds ?? [])]).toEqual(['permission-1']);

        decision.reject(new Error('machine unreachable'));
        await act(async () => {});

        expect(latestContentProps?.errorLabel ?? null).toBeNull();
        expect([...(latestContentProps?.pendingRequestIds ?? [])]).toEqual(['permission-1']);

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
            id: 'run-1', state: 'running', origin: { kind: 'direct' },
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
            input?.lifecycles === undefined
                ? { ...invocationPage(overrides.history ?? []), nextCursor: overrides.historyNextCursor }
                : { ...invocationPage(overrides.attention ?? []), nextCursor: overrides.attentionNextCursor }
        ));
        const screen = await renderScreen(createRunScreenElement());
        await act(async () => {});
        return screen;
    }

    it('keeps the loaded history and its cursor when a continuation fails, and clears that failure only once a retry succeeds', async () => {
        const first = createWorkflowInvocationIndexFixture({ id: 'inv-1', memberOrdinal: '0', sequence: '0' });
        const second = createWorkflowInvocationIndexFixture({ id: 'inv-2', memberOrdinal: '1', sequence: '1' });
        await renderPagedRunScreen({ history: [first], historyNextCursor: 'history-2' });
        expect(latestContentProps?.invocations.map((entry) => entry.id)).toEqual(['inv-1']);

        detailActions.listInvocations.mockRejectedValueOnce(new Error('offline'));
        await act(async () => { latestContentProps?.onLoadMoreInvocations?.(); });
        await act(async () => {});

        // A page that did not arrive is not a durable Run operation failure, so
        // it must not claim the outcome region's error voice.
        expect(latestContentProps?.errorLabel ?? null).toBeNull();
        expect(latestContentProps?.loadMoreInvocationsFailed).toBe(true);
        // The rows already read and the cursor Retry needs both survive.
        expect(latestContentProps?.invocations.map((entry) => entry.id)).toEqual(['inv-1']);
        expect(latestContentProps?.onLoadMoreInvocations).toBeTypeOf('function');

        detailActions.listInvocations.mockRejectedValueOnce(new Error('offline again'));
        await act(async () => { latestContentProps?.onLoadMoreInvocations?.(); });
        await act(async () => {});
        expect(latestContentProps?.loadMoreInvocationsFailed).toBe(true);

        detailActions.listInvocations.mockImplementationOnce(async () => invocationPage([second]));
        await act(async () => { latestContentProps?.onLoadMoreInvocations?.(); });
        await act(async () => {});

        expect(latestContentProps?.loadMoreInvocationsFailed).toBe(false);
        expect(latestContentProps?.invocations.map((entry) => entry.id)).toEqual(['inv-1', 'inv-2']);
        expect(latestContentProps?.onLoadMoreInvocations).toBeUndefined();
        expect(latestContentProps?.errorLabel ?? null).toBeNull();
    });

    it('issues one attention continuation for two presses in the same frame and releases the guard when it settles', async () => {
        const attentionRow = createWorkflowInvocationIndexFixture({
            id: 'inv-attention', memberOrdinal: '0', sequence: '0', lifecycle: 'waiting_for_approval',
        });
        await renderPagedRunScreen({ attention: [attentionRow], attentionNextCursor: 'attention-2' });
        expect(latestContentProps?.onLoadMoreAttention).toBeTypeOf('function');
        const callsBefore = detailActions.listInvocations.mock.calls.length;

        const page = createDeferred<unknown>();
        detailActions.listInvocations.mockImplementationOnce(async () => page.promise);
        act(() => {
            latestContentProps?.onLoadMoreAttention?.();
            latestContentProps?.onLoadMoreAttention?.();
        });
        await act(async () => {});

        expect(detailActions.listInvocations.mock.calls.length).toBe(callsBefore + 1);

        page.resolve({ ...invocationPage([]), nextCursor: 'attention-3' });
        await act(async () => {});
        await act(async () => { latestContentProps?.onLoadMoreAttention?.(); });
        await act(async () => {});

        // The guard withdraws only the duplicate, never the next honest ask.
        expect(detailActions.listInvocations.mock.calls.length).toBe(callsBefore + 2);
    });

    it('retires a continuation failure and its late response when this mounted screen changes Runs', async () => {
        const first = createWorkflowInvocationIndexFixture({ id: 'inv-1', memberOrdinal: '0', sequence: '0' });
        const screen = await renderPagedRunScreen({ history: [first], historyNextCursor: 'history-2' });

        detailActions.listInvocations.mockRejectedValueOnce(new Error('offline'));
        await act(async () => { latestContentProps?.onLoadMoreInvocations?.(); });
        await act(async () => {});
        expect(latestContentProps?.loadMoreInvocationsFailed).toBe(true);

        const stale = createDeferred<unknown>();
        detailActions.listInvocations.mockImplementationOnce(async () => stale.promise);
        act(() => { latestContentProps?.onLoadMoreInvocations?.(); });
        await act(async () => {});

        routeState.runId = 'run-2';
        const runB = createWorkflowRunSummaryFixture({ id: 'run-2', state: 'running', origin: { kind: 'direct' } });
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
        expect(latestContentProps?.run.id).toBe('run-2');
        expect(latestContentProps?.loadMoreInvocationsFailed).toBe(false);

        stale.reject(new Error('offline'));
        await act(async () => {});

        // Run A's lost page belongs to nobody on screen once Run B is mounted.
        expect(latestContentProps?.loadMoreInvocationsFailed).toBe(false);
        expect(latestContentProps?.errorLabel ?? null).toBeNull();
    });

    /**
     * Exact reread evidence for the selected invocation.
     *
     * The last-known private content stays visible while it is re-asked for,
     * but no permission or recovery callback may act on it until a response
     * for this exact Run, record, revision and attempt confirms it. A response
     * that lost its race is ignored rather than published.
     */
    describe('selected invocation evidence', () => {
        function selectedRows() {
            return [
                createWorkflowInvocationIndexFixture({ id: 'root', parentRecordId: null, memberOrdinal: '0', sequence: '0' }),
                createWorkflowInvocationIndexFixture({
                    id: 'analyze-row', parentRecordId: 'root', memberOrdinal: '0', sequence: '1', lifecycle: 'waiting_for_approval',
                }),
            ];
        }

        function openRequestResponse(index: ReturnType<typeof createWorkflowInvocationIndexFixture>, parentRevision: number) {
            return permissionInvocationResponse({ index, requestIds: ['permission-1'], parentRevision });
        }

        it('does not confirm a stale row blob when its parent revision is unchanged', async () => {
            const invocations = selectedRows();
            invocations[1] = { ...invocations[1]!, contentRevision: '2' };
            detailActions.getInvocation.mockResolvedValue(openRequestResponse({ ...invocations[1]!, contentRevision: '1' }, 1));
            await renderRunScreen({
                run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running', revision: 1 }),
                invocations,
            });
            await act(async () => latestContentProps?.onSelectInvocation('analyze-row'));
            await act(async () => {});
            expect(latestContentProps?.selectedContentUnavailable).toBe(true);
            expect(latestContentProps?.selectedInvocationProgress).toBeNull();
            expect(latestContentProps?.onRespondToRequest).toBeUndefined();
        });

        it('refreshes selected evidence on a row token change without a timestamp or parent change', async () => {
            const invocations = selectedRows();
            const newer = { ...invocations[1]!, contentRevision: '1' };
            const refreshedRead = createDeferred<unknown>();
            detailActions.getInvocation.mockResolvedValueOnce(openRequestResponse(invocations[1]!, 1));
            detailActions.getInvocation.mockReturnValueOnce(refreshedRead.promise);
            const { getStorage } = await import('@/sync/domains/state/storage');
            await renderRunScreen({
                run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running', revision: 1 }),
                invocations,
            });
            await act(async () => latestContentProps?.onSelectInvocation('analyze-row'));
            expect(latestContentProps?.selectedContentUnavailable).toBe(false);
            act(() => getStorage().getState().upsertWorkflowRunInvocation({
                runId: 'run-1', invocation: newer, parentRevision: 1,
            }));
            await act(async () => {});
            expect(detailActions.getInvocation).toHaveBeenCalledTimes(2);
            expect(latestContentProps?.selectedContentUnavailable).toBe(true);
            expect(latestContentProps?.onRespondToRequest).toBeUndefined();
            refreshedRead.resolve(openRequestResponse(newer, 1));
            await act(async () => {});
            expect(latestContentProps?.selectedContentUnavailable).toBe(false);
            expect(latestContentProps?.onRespondToRequest).toBeTypeOf('function');
        });

        it('refreshes row-only attention and the exact selection while visible, and reads current facts on reopening', async () => {
            const invocations = selectedRows();
            let destinationVisible = true;
            const wrap = (screen: React.ReactElement) => React.createElement(DestinationInstanceHost, {
                tabId: 'workflow-run-tab',
                ref: { kind: 'workflowRun', params: { runId: 'run-1' } },
                pathname: '/workflows/runs/run-1',
                focused: destinationVisible,
                visible: destinationVisible,
                navigation: { ...routerSpy, replace: vi.fn() },
                children: screen,
            });
            detailActions.getInvocation.mockResolvedValue(openRequestResponse(invocations[1]!, 1));
            const screen = await renderRunScreen({
                run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running' }),
                invocations,
                wrap,
            });
            await act(async () => latestContentProps?.onSelectInvocation('analyze-row'));
            expect(latestContentProps?.selectedContentUnavailable).toBe(false);

            const refreshedRead = createDeferred<unknown>();
            detailActions.getInvocation.mockReturnValueOnce(refreshedRead.promise);
            const offPageApproval = createWorkflowInvocationIndexFixture({
                id: 'off-page-approval', sequence: '99', parentRecordId: 'root', lifecycle: 'waiting_for_approval',
            });
            detailActions.listInvocations.mockImplementation(async (input: Readonly<{ lifecycles?: readonly string[] }>) => (
                invocationPage(input.lifecycles === undefined ? invocations : [offPageApproval])
            ));
            await act(async () => publishHomeAccountChange('server-a', ['workflow-run:run-1']));
            expect(latestContentProps?.invocations.some((row) => row.id === offPageApproval.id)).toBe(true);
            expect(latestContentProps?.selectedContentUnavailable).toBe(true);
            expect(latestContentProps?.selectedInvocationProgress).not.toBeNull();
            expect(latestContentProps?.run.revision).toBe(1);
            refreshedRead.resolve(openRequestResponse(invocations[1]!, 1));
            await act(async () => {});
            expect(latestContentProps?.selectedContentUnavailable).toBe(false);

            // A retained workspace tab is hidden even while the host remains visible.
            destinationVisible = false;
            await screen.update(wrap(createRunScreenElement()));
            detailActions.listInvocations.mockClear();
            detailActions.getInvocation.mockClear();
            await act(async () => publishHomeAccountChange('server-a', ['workflow-run:run-1']));
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
            await renderRunScreen({
                run: createWorkflowRunSummaryFixture({
                    id: 'run-1', state: 'running', machineId: 'machine-1', origin: { kind: 'direct' },
                }),
                invocations,
            });
            await act(async () => latestContentProps?.onSelectInvocation('analyze-row'));
            await act(async () => {});
            expect(detailActions.getInvocation).toHaveBeenCalledTimes(1);

            firstRead.resolve(openRequestResponse(invocations[1]!, 1));
            await act(async () => {});
            // The matching first read confirms the evidence its callbacks act on.
            expect(latestContentProps?.selectedContentUnavailable).toBe(false);
            expect(latestContentProps?.onRespondToRequest).toBeTypeOf('function');

            // A newer index row for the same selection re-asks for it. The
            // evidence is unconfirmed before that request answers, while
            // everything the last confirmed read established stays on screen.
            const newerIndex = { ...invocations[1]!, contentRevision: '1', updatedAt: '2026-09-08T11:00:00.000Z' };
            act(() => {
                getStorage().getState().applyWorkflowRunInvocationPage({
                    runId: 'run-1',
                    invocations: [newerIndex],
                    nextCursor: null,
                    parentRevision: 1,
                    mode: 'replace',
                });
            });
            await act(async () => {});
            expect(detailActions.getInvocation).toHaveBeenCalledTimes(2);
            expect(latestContentProps?.selectedContentUnavailable).toBe(true);
            expect(latestContentProps?.onRespondToRequest).toBeUndefined();
            expect(latestContentProps?.run.id).toBe('run-1');
            expect(latestContentProps?.selectedInvocationProgress).toMatchObject({
                execution: { kind: 'detached_run', runId: 'exec-1' },
            });

            secondRead.resolve(openRequestResponse(newerIndex, 1));
            await act(async () => {});
            expect(latestContentProps?.selectedContentUnavailable).toBe(false);
            expect(latestContentProps?.onRespondToRequest).toBeTypeOf('function');
        });

        it('ignores an exact response for another record instead of publishing it under the selection', async () => {
            const invocations = selectedRows();
            detailActions.getInvocation.mockResolvedValue({
                invocation: {
                    index: createWorkflowInvocationIndexFixture({ id: 'intruder-row', sequence: '9' }),
                    parentRevision: 1,
                    progress: {
                        kind: 'happier.workflow-progress.v1',
                        invocationPath: { blockId: 'analyze', scope: [] },
                        blockKind: 'step', attempt: '0',
                        logicalInvocationRecordId: 'intruder-row',
                    },
                },
            });
            await renderRunScreen({
                run: createWorkflowRunSummaryFixture({
                    id: 'run-1', state: 'running', machineId: 'machine-1', origin: { kind: 'direct' },
                }),
                invocations,
            });
            await act(async () => latestContentProps?.onSelectInvocation('analyze-row'));
            await act(async () => {});

            // Another record's answer is nobody's evidence here: nothing is
            // published under the selection and no callback is armed by it.
            expect(latestContentProps?.selectedContentUnavailable).toBe(true);
            expect(latestContentProps?.selectedInvocationProgress).toBeNull();
            expect(latestContentProps?.onRespondToRequest).toBeUndefined();
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
                    id: 'run-1', state: 'running', revision: 2, machineId: 'machine-1', origin: { kind: 'direct' },
                }),
                invocations,
            });
            await act(async () => latestContentProps?.onSelectInvocation('analyze-row'));
            await act(async () => {});

            staleRead.resolve(openRequestResponse(invocations[1]!, 1));
            await act(async () => {});
            // Issued at revision 2, answered from revision 1: superseded.
            expect(latestContentProps?.selectedContentUnavailable).toBe(true);
            expect(latestContentProps?.onRespondToRequest).toBeUndefined();

            // Re-asking re-arms the flight; the answer from revision 2 matches.
            await act(async () => requireDefined(
                latestContentProps?.onDeselectInvocation,
                'Expected an invocation deselection handler',
            )());
            await act(async () => latestContentProps?.onSelectInvocation('analyze-row'));
            await act(async () => {});
            expect(detailActions.getInvocation).toHaveBeenCalledTimes(2);
            expect(latestContentProps?.selectedContentUnavailable).toBe(true);
            expect(latestContentProps?.onRespondToRequest).toBeUndefined();

            freshRead.resolve(openRequestResponse(invocations[1]!, 2));
            await act(async () => {});
            expect(latestContentProps?.selectedContentUnavailable).toBe(false);
            expect(latestContentProps?.onRespondToRequest).toBeTypeOf('function');
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
                    id: 'run-1', state: 'running', machineId: 'machine-1', origin: { kind: 'direct' },
                }),
                invocations,
            });
            await act(async () => latestContentProps?.onSelectInvocation('analyze-row'));
            await act(async () => {});
            expect(latestContentProps?.selectedContentUnavailable).toBe(true);
            expect(latestContentProps?.onRespondToRequest).toBeUndefined();

            // Leaving and returning to the row re-asks for it. The evidence
            // stays unconfirmed through that flight — every effect run marks
            // it so before requesting — and only the matching answer re-arms
            // the callbacks the failure withdrew.
            await act(async () => requireDefined(
                latestContentProps?.onDeselectInvocation,
                'Expected an invocation deselection handler',
            )());
            await act(async () => latestContentProps?.onSelectInvocation('analyze-row'));
            await act(async () => {});
            expect(detailActions.getInvocation).toHaveBeenCalledTimes(2);
            expect(latestContentProps?.selectedContentUnavailable).toBe(true);
            expect(latestContentProps?.onRespondToRequest).toBeUndefined();

            retryRead.resolve(openRequestResponse(invocations[1]!, 1));
            await act(async () => {});
            expect(latestContentProps?.selectedContentUnavailable).toBe(false);
            expect(latestContentProps?.onRespondToRequest).toBeTypeOf('function');
        });
    });
});
