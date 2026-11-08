import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import {
    WorkflowAcceptedSnapshotV1Schema} from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { WorkflowDefinitionV1Schema} from '@happier-dev/protocol/workflows/workflowV1';
import { createWorkflowLeafBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { WorkflowInvocationPublishDraftResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { WorkflowProgressEnvelopeV1Schema,
    WorkflowRunInvocationIndexV1Schema,
    type WorkflowRunInvocationIndexV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';
import { WorkflowRunRecipientCensusResponseV1Schema} from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import {
    WorkflowRunStartRequestV1Schema, WorkflowRunStartResultV1Schema} from '@happier-dev/protocol/workflows/actionsV1';
import {
    openWorkflowProgressStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1,
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1} from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import {
    validateWorkflowDefinition} from '@happier-dev/protocol/workflows/workflowValidationV1';
import {
    StrictJsonValueSchema} from '@happier-dev/protocol/json/strictJsonValue';
import { changeTextTestInstance, findAllHostTestInstances, invokeTestInstanceHandler, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { ModalProvider, useModal } from '@/modal';
import { BaseModal } from '@/modal/components/BaseModal';
import { ScopedAuthoringComposer } from '@/components/sessions/authoring/ScopedAuthoringComposer';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { workflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import { storage, useSession } from '@/sync/domains/state/storage';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { isSessionAccessOwner } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { deriveWorkflowPlanRunId } from '@/sync/domains/workflows/workflowPlanReview';
import type { WorkflowActionTransport } from '@/sync/ops/actions/workflowActionTransport';
import { WorkflowInvocationReview, type WorkflowInvocationReviewBuffers } from './WorkflowInvocationReview';
import { WorkflowEditorHostScreen } from '../screens/WorkflowEditorHostScreen';
import { WorkflowRunScreen } from '../screens/WorkflowRunScreen';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { describeWorkflowOperationProblem } from '../presentation/workflowProblemPresentation';
import { t } from '@/text';
import { storeWorkflowReviewedRunSeed } from '@/sync/domains/workflows/workflowReviewedRunSeed';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';

// Only HTTP, Machine transport, credentials and rendering/platform loaders are replaced.
// Account scope, stores, feature/policy decisions, Action owners and codecs remain real.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
const routerMock = await vi.hoisted(async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: { runId: '11111111-1111-4111-8111-111111111111' } });
});
vi.mock('expo-router', () => routerMock.module);
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));
const machineRpc = vi.hoisted(() => vi.fn<WorkflowActionTransport>(async () => { throw new Error('offline_machine'); }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
type PlanStartBoundary = Extract<Parameters<typeof createExternalActionAccountHttpBoundary>[0], { requesterInvocation?: 'required' }>;
const startPlan = vi.fn<PlanStartBoundary['execute']>(async () => { throw new Error('offline_machine'); });
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
    return createTextModuleMock();
});
// Phosphor's published TSX assumes Metro's automatic JSX transform; Vitest's
// classic transform needs the React binding. Keep the actual icon implementation.
await vi.hoisted(async () => {
    vi.stubGlobal('React', await import('react'));
});
beforeEach(() => { vi.stubGlobal('React', React); });
// Radix supplies the DOM portal primitives; confirmation and custom modal custody stay real.
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsModuleMock } = await import('@/dev/testkit/mocks/radixCjs');
    const boundary = createRadixCjsModuleMock();
    // Node's SDK loader returns stable exports. Cache the canonical fixture's
    // modules so an open Popover does not remount its contents on every render.
    const dialog = boundary.requireRadixDialog();
    const layers = boundary.requireRadixDismissableLayer();
    const focus = boundary.requireRadixFocusScope();
    return { requireRadixDialog: () => dialog, requireRadixDismissableLayer: () => layers, requireRadixFocusScope: () => focus };
});
const accountId = 'review-integration-account';
const runId = '11111111-1111-4111-8111-111111111111';
const rootId = '22222222-2222-4222-8222-222222222222';
const heldId = '33333333-3333-4333-8333-333333333333';
const betaHeldId = '55555555-5555-4555-8555-555555555555';
const parallelId = '66666666-6666-4666-8666-666666666666';
const alphaFrameId = '77777777-7777-4777-8777-777777777777';
const betaFrameId = '88888888-8888-4888-8888-888888888888';
const originSessionId = '44444444-4444-4444-8444-444444444444';
const timestamp = '2026-01-01T00:00:00.000Z';
const contract = { kind: 'json', schema: { type: 'object', properties: {
    summary: { type: 'string', minLength: 1 }, approved: { type: 'boolean' },
}, required: ['summary', 'approved'] } } as const;
const originalValue = { summary: 'Published', approved: false, retained: { exact: [1, 2] } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
type Row = { index: WorkflowRunInvocationIndexV1; contentEnvelope: string; parentRevision: number };
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const dispose of disposals.splice(0).reverse()) await dispose();
    // The validation refusal case withdraws this Home's feature response.
    // Retire that synthetic server observation with its HTTP boundary.
    resetServerFeaturesClientForTests();
    machineRpc.mockReset();
    machineRpc.mockImplementation(async () => { throw new Error('offline_machine'); });
    startPlan.mockReset();
    startPlan.mockImplementation(async () => { throw new Error('offline_machine'); });
    routerMock.spies.push.mockClear();
    routerMock.resetParams();
});
afterAll(() => { vi.unstubAllGlobals(); });

async function harness(options: Readonly<{ emptyResult?: boolean; concurrentHolds?: boolean; runScreen?: boolean; paused?: boolean; runReadError?: 'history_not_readable' | 'encryption_setup_required'; compact?: boolean; access?: 'owner' | 'edit' | 'view'; wait?: boolean; fieldlessWait?: boolean; exactRead?: 'pending' | 'failed'; confirmed?: boolean; plan?: boolean; admittedPlan?: boolean; planProposal?: boolean; planValidationUnavailable?: boolean; uncertainPriorEffects?: boolean; acknowledged?: boolean; ownedOrigin?: boolean }> = {}) {
    installShippedNativeFrameScheduler();
    // The real modal/composer schedules SDK frame work. Preserve the canonical
    // timer-backed scheduler rather than running a frame recursively in place.
    const restorePlatform = withPopoverWebGlobals({ frameScheduler: globalThis.requestAnimationFrame });
    disposals.push(async () => { restorePlatform(); });
    await loadSyncSingletonForTests();
    const actorAccountId = options.access && options.access !== 'owner' ? 'review-integration-teammate' : accountId;
    const resultContract = options.plan ? { kind: 'json', schema: { type: 'object', properties: { document: { type: 'string' } }, required: ['document'] } } : contract;
    const proposal = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
    }, blocks: [{ kind: 'step', id: 'implement',
        document: { text: 'Implement the proposal', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] });
    if (!validateWorkflowDefinition(proposal).valid) throw new Error('Plan fixture must be semantically valid, not merely schema-shaped');
    const value = options.plan ? { document: 'Implement this exact reviewed plan.\nKeep the second paragraph.', ...(options.planProposal ? { proposal } : {}) } : originalValue;
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: proposal.defaults, blocks: [
        options.wait ? { ...createWorkflowLeafBlock({ kind: 'wait' }, new Set()), id: 'review', document: { text: 'Answer', references: [], attachments: [] }, ...(options.fieldlessWait ? {} : { result: resultContract }) }
            : { kind: 'step', id: 'review', document: { text: 'Draft', references: [], attachments: [] }, input: [], result: resultContract, pauseForReview: true },
    ] });
    const reviewBlock = definition.blocks[0]!;
    const acceptedDefinition = options.concurrentHolds ? WorkflowDefinitionV1Schema.parse({ ...definition, blocks: [
        { kind: 'parallel', id: 'holds', failurePolicy: 'collect_outcomes', branches: [
            { id: 'alpha', blocks: [reviewBlock] },
            { id: 'beta', blocks: [{ ...reviewBlock, id: 'review-beta' }] },
        ] },
    ] }) : definition;
    const projectedResultContract = reviewBlock.kind === 'wait' ? reviewBlock.result : resultContract;
    const origin = { kind: 'direct' as const, ...(options.ownedOrigin ? { originSessionId } : {}) };
    const run = createWorkflowRunSummaryFixture({ id: runId, ownerAccountId: accountId, origin, state: options.paused ? 'paused' : 'waiting_for_review', revision: 7, machineId: 'machine-a',
        availability: { pause: true, cancel: true } });
    const acceptedContext = {
        source: { kind: 'inline' as const }, inputs: {}, machineId: 'machine-a', executionTarget: { kind: 'session' as const },
        workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
        origin, authorization: { principal: { kind: 'host' as const } },
    };
    const admitted = await materializeWorkflowAcceptedSnapshotV1({ definition: acceptedDefinition, admission: { kind: 'user' },
        effects: { resolveTargetAvailability: async () => true }, context: acceptedContext,
    });
    if (!admitted.ok) throw new Error(`Review fixture admission failed: ${admitted.error.code}`);
    const acceptedSnapshot = admitted.snapshot;
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot }));
    const admittedPlan = await materializeWorkflowAcceptedSnapshotV1({ definition: proposal, admission: { kind: 'user' },
        effects: { resolveTargetAvailability: async () => true }, context: { ...acceptedContext, metadata: { title: 'Implement the proposal' } } });
    if (!admittedPlan.ok) throw new Error(`Plan fixture admission failed: ${admittedPlan.error.code}`);
    const admittedPlanSnapshot = admittedPlan.snapshot;
    const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId, ownerAccountId: accountId, encryptionMode: 'plain', access: options.access ?? 'owner',
        dataEncryptionKey: null, callerDataEncryptionKey: null, visibleTeamId: null, recipients: [], ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    const rows = new Map<string, Row>();
    const binding = (index: WorkflowRunInvocationIndexV1) => ({ v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId, recordId: index.id,
        sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt: index.attempt });
    function insert(id: string, root: boolean) {
        const beta = id === betaHeldId;
        const index = WorkflowRunInvocationIndexV1Schema.parse({ id, runId, sequence: root ? '0' : options.concurrentHolds ? beta ? '6' : '5' : '1',
            parentRecordId: root ? null : options.concurrentHolds ? beta ? betaFrameId : alphaFrameId : rootId,
            memberOrdinal: '0', attempt: '0', contentRevision: root ? '0' : '7', lifecycle: root ? 'running' : 'waiting_for_review', createdAt: timestamp, updatedAt: timestamp });
        const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1', invocationPath: {
            blockId: root ? '$root' : beta ? 'review-beta' : 'review',
            scope: !root && options.concurrentHolds ? [{ kind: 'branch', blockId: 'holds', branchId: beta ? 'beta' : 'alpha' }] : [],
        },
            blockKind: root ? 'root' : options.wait ? 'wait' : 'step', attempt: '0', logicalInvocationRecordId: id,
            ...(root ? {} : { ...(projectedResultContract === undefined ? {} : { resultContract: projectedResultContract }), ...(options.wait ? {} : { ...(options.emptyResult ? {} : { result: value }),
                execution: { kind: 'session', sessionId: 'conversation', localInputId: 'initial-input' }, review: { resultSource: { kind: 'execution_input' } } }) }),
            ...(!root && options.uncertainPriorEffects ? { uncertainPriorEffects: { activity: 'stopped' } } : {}),
        });
        rows.set(id, { index, parentRevision: run.revision, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: binding(index), progress })) });
    }
    insert(rootId, true); insert(heldId, false);
    if (options.concurrentHolds) {
        for (const [id, parentRecordId, memberOrdinal, sequence] of [
            [parallelId, rootId, '0', '1'], [alphaFrameId, parallelId, '0', '2'], [betaFrameId, parallelId, '1', '3'],
        ] as const) {
            const index = WorkflowRunInvocationIndexV1Schema.parse({ id, runId, parentRecordId, memberOrdinal, sequence,
                attempt: '0', contentRevision: '0', lifecycle: 'running', createdAt: timestamp, updatedAt: timestamp });
            const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
                invocationPath: { blockId: 'holds', scope: id === parallelId ? []
                    : [{ kind: 'branch', blockId: 'holds', branchId: id === alphaFrameId ? 'alpha' : 'beta' }] },
                blockKind: 'parallel', attempt: '0', logicalInvocationRecordId: id });
            rows.set(id, { index, parentRevision: run.revision, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(
                sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: binding(index), progress })) });
        }
        insert(betaHeldId, false);
    }
    const operations: Readonly<Record<string, unknown>>[] = [];
    const events: string[] = [];
    const boundary = { refuse: false, failSubmit: false, loseResponse: false, workflowsEnabled: true, admittedPlan: options.admittedPlan === true, access: options.access ?? 'owner', exactRead: options.exactRead as 'pending' | 'failed' | undefined };
    let runReadError: typeof options.runReadError;
    const exactRead = createDeferred<void>();
    const planRunId = deriveWorkflowPlanRunId(runId, heldId);
    const admittedPlans = new Map<string, typeof admittedPlanSnapshot>();
    const serverUrl = `https://review-${crypto.randomUUID()}.test`;
    const serverIdentityId = 'srv_workflow-review-integration';
    const accountToken = createAccountTokenForTests(actorAccountId, { currentAccount: true });
    const external = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId: actorAccountId,
        machineId: 'machine-a', actionId: 'workflow.run.start', tokenEpoch: 0,
        execute: (input, context) => startPlan(input, context) });
    const account = await restoreServerAccountForTest({ serverUrl, serverIdentityId, accountId: actorAccountId,
        credentials: { token: accountToken }, request: async (url, init) => {
        if (new URL(String(url)).pathname === '/v1/actions/workflow.run.start') {
            expect(new Headers(init?.headers).get('authorization') === `Bearer ${accountToken}`,
                'Run start uses the actor Account credential').toBe(true);
        }
        const handled = await external.handle(new URL(String(url)), init);
        if (handled) return handled;
        const path = new URL(String(url)).pathname;
        if (path === '/health') return json({});
        if (path === '/v1/features') return json({ features: { automations: { enabled: true }, workflows: { enabled: boundary.workflowsEnabled } }, capabilities: {
            accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1' },
        } });
        if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/account/profile') return json(AccountProfileSchema.parse({ id: actorAccountId }));
        if (path === '/v2/account/settings') return json({ content: null, version: 0 });
        if (path === '/v1/account/encryption/currentness') return json({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
        if (path !== '/v3/automations/runs/workflow-storage') return json({}, 404);
        // External server stores opaque envelopes and applies its published row CAS;
        // it neither decodes progress nor decides the review result.
        const operation = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
        operations.push(operation);
        if (operation.operation === 'get') {
            if (runReadError && operation.runId === runId) return json({ error: runReadError }, 503);
            if (operation.runId !== runId) {
                const childId = String(operation.runId);
                const child = admittedPlans.get(childId) ?? (boundary.admittedPlan && childId === planRunId ? admittedPlanSnapshot : undefined);
                return child ? json({ run: { ...run, id: childId, state: 'queued' }, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                    binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: childId }, acceptedSnapshot: child })),
                    checkpointEnvelope: null, resultEnvelope: null, keyCensus: { ...keyCensus, runId: childId } })
                    : json({ error: 'run_not_found' }, 404);
            }
            return json({ run, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null, keyCensus: { ...keyCensus, access: boundary.access } });
        }
        if (operation.operation === 'run-key.census') return json(operation.runId === planRunId ? { ...keyCensus, runId: planRunId } : keyCensus);
        if (operation.operation === 'invocations.list') {
            const listed = operation.runId === runId ? [...rows.values()].filter(row => (operation.parentRecordId === undefined || row.index.parentRecordId === operation.parentRecordId)
                && (!Array.isArray(operation.lifecycles) || operation.lifecycles.includes(row.index.lifecycle))) : [];
            return json({ invocations: listed.map(row => row.index), parentRevision: run.revision,
                ...(operation.progressEnvelopes === true ? { keyCensus,
                    progressEnvelopesByInvocationId: Object.fromEntries(listed.map(row => [row.index.id, row.contentEnvelope])) } : {}) });
        }
        if (operation.operation === 'invocations.get') {
            if (boundary.exactRead === 'pending') await exactRead.promise;
            if (boundary.exactRead === 'failed') throw new Error('storage_transport_offline');
            return json({ invocation: rows.get(String(operation.invocationId)) });
        }
        if (operation.operation === 'invocations.current') return json({ invocation: rows.get(heldId), parentRevision: run.revision });
        if (operation.operation === 'invocations.publish_draft' || operation.operation === 'invocations.complete_review') {
            const row = rows.get(String(operation.invocationId));
            if (boundary.failSubmit) throw new Error('ERR_SOCKS_CONNECTION_FAILED');
            if (!row || boundary.refuse || row.index.contentRevision !== operation.expectedContentRevision) return json({ error: 'currentness_conflict' }, 409);
            events.push(String(operation.operation));
            row.contentEnvelope = String(operation.contentEnvelope);
            row.index = { ...row.index, contentRevision: String(BigInt(row.index.contentRevision) + 1n), ...(operation.mode === 'use_result' ? { lifecycle: 'completed' as const } : {}) };
            if (operation.operation === 'invocations.complete_review') { run.revision++; if (run.state !== 'paused') run.state = 'queued'; }
            row.parentRevision = run.revision;
            if (boundary.loseResponse) { boundary.loseResponse = false; throw new Error('response_lost_after_commit'); }
            return operation.operation === 'invocations.publish_draft' ? json({ invocation: row, parentRevision: run.revision })
                : json({ run, invocation: row, disposition: operation.mode === 'use_result' ? 'completed' : 'generation_requested' });
        }
        throw new Error(`Unexpected Review storage operation: ${String(operation.operation)}`);
    } });
    disposals.push(account.dispose);
    const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl);
    if (options.ownedOrigin) {
        storage.getState().applySessions([createSessionFixture({ id: originSessionId, access: createSessionAccessFixture('owner') })]);
    }
    const detail = await workflowRunDetailActions.getRun(runId);
    if (options.planValidationUnavailable) {
        // Withdraw the external Home capability after the initial successful read,
        // so the real validation Action (rather than harness setup) is refused.
        boundary.workflowsEnabled = false;
        resetServerFeaturesClientForTests();
    }
    runReadError = options.runReadError;
    let callerAccess = detail.callerAccess;
    const readProgress = () => {
        const row = rows.get(heldId)!;
        const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: binding(row.index), envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope)! });
        if (opened.kind !== 'available') throw new Error('Stored progress unavailable');
        return opened.content;
    };
    const buffers: WorkflowInvocationReviewBuffers = { drafts: new Map(), readings: new Map() };
    const onSettled = vi.fn(); const onOpenDraft = vi.fn(); const onOpenRun = vi.fn();
    const current = () => true;
    const acknowledgeUncertainPriorEffects = options.acknowledged ? { recordId: heldId, contentRevision: '7' } : undefined;
    let observedOrigin: ReturnType<typeof useSession> = null;
    let modals: ReturnType<typeof useModal>['state']['modals'] = [];
    function ObserveModals() {
        modals = useModal().state.modals;
        return null;
    }
    function Host() {
        // Observe the same public Session hook as Review, without replacing its
        // store, Account scope, access projection or subscription owner.
        observedOrigin = useSession(options.ownedOrigin ? originSessionId : '');
        const [editorSeedId, setEditorSeedId] = React.useState<string | null>(null);
        if (options.runScreen) return <InjectedAuthProvider credentials={credentials}><AppPaneProvider><WorkflowRunScreen /></AppPaneProvider></InjectedAuthProvider>;
        if (editorSeedId !== null) return <AppPaneProvider><WorkflowEditorHostScreen source={{ kind: 'new', reviewedRunSeedId: editorSeedId }} /></AppPaneProvider>;
        const row = rows.get(heldId)!;
        return <WorkflowInvocationReview run={run} callerAccess={callerAccess} acceptedContext={detail.acceptedContext!} definition={detail.definition} invocation={row.index}
            progress={readProgress()} contentRevision={row.index.contentRevision} buffers={buffers} active confirmed={options.confirmed !== false} compact={options.compact === true}
            viewerAccountId={actorAccountId} current={current} onSettled={onSettled}
            onOpenDraft={(seed) => {
                onOpenDraft(seed);
                if (seed.planReview) setEditorSeedId(storeWorkflowReviewedRunSeed(seed));
            }} onOpenRun={onOpenRun} onDiscuss={() => {}} machineReachable={false}
            {...{ acknowledgeUncertainPriorEffects }} />;
    }
    // The application shell registers its modal host before the review route mounts.
    const screen = await renderScreen(<ModalProvider><ObserveModals /></ModalProvider>, {
        // Anchor/content geometry comes from the renderer's platform-node boundary;
        // the real chip, Popover measurement and positioning owners still execute.
        createNodeMock: () => Object.assign(new EventTarget(), {
            // WebDropTargetView attaches/removes real DOM drag listeners on its
            // host ref; retain EventTarget behavior rather than mocking that owner.
            ownerDocument: new EventTarget(),
            getBoundingClientRect: () => ({ x: 40, y: 400, left: 40, top: 400, right: 360, bottom: 560, width: 320, height: 160 }),
            contains: () => false,
            focus: () => {},
            measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(40, 400, 320, 160),
        }),
    });
    await screen.update(<ModalProvider><ObserveModals /><Host /></ModalProvider>);
    disposals.push(async () => {
        await screen.update(<ModalProvider><ObserveModals /></ModalProvider>);
        await screen.unmount();
    });
    let mount = 0;
    return { screen, detail, rows, run, readProgress, operations, events, proposal, boundary, onSettled, onOpenDraft, onOpenRun, planRunId,
        arriveResult: async (id: string, result: typeof originalValue, revision: string) => {
            const row = rows.get(id)!;
            const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: binding(row.index),
                envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope)! });
            if (opened.kind !== 'available') throw new Error('Stored progress unavailable');
            row.index = { ...row.index, contentRevision: revision };
            row.contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
                binding: binding(row.index), progress: { ...opened.content, result } }));
            // Production exact reads publish the opened private observation into this same store.
            const response = await workflowRunDetailActions.getInvocation({ runId, invocationId: id });
            await act(async () => storage.getState().upsertWorkflowRunInvocation({ runId,
                invocation: { ...response.invocation.index, opened: response.invocation }, parentRevision: response.invocation.parentRevision }));
        },
        readDraft: () => buffers.drafts.get(heldId),
        settleExactRead: () => exactRead.resolve(),
        admitPlan: (input: ReturnType<typeof WorkflowRunStartRequestV1Schema.parse>) => {
            if (input.source.kind !== 'inline') throw new Error('Plan admission must be inline');
            const checked = validateWorkflowDefinition(input.source.definition);
            if (!checked.valid || !checked.normalizedDefinition) throw new Error('Invalid Plan admission');
            admittedPlans.set(input.runId, WorkflowAcceptedSnapshotV1Schema.parse({ ...admittedPlanSnapshot,
                definition: checked.normalizedDefinition, authoredDefinition: checked.normalizedDefinition }));
        },
        readOrigin: () => observedOrigin,
        readModals: () => modals,
        refreshAccess: async () => {
            callerAccess = (await workflowRunDetailActions.getRun(runId)).callerAccess;
            await screen.update(<ModalProvider><ObserveModals /><Host /></ModalProvider>);
        },
        refresh: () => screen.update(<ModalProvider><ObserveModals /><Host /></ModalProvider>),
        reopen: () => screen.update(<ModalProvider><ObserveModals /><Host key={++mount} /></ModalProvider>) };
}
async function change(screen: Awaited<ReturnType<typeof renderScreen>>, id: string, value: string) {
    await act(async () => { screen.changeTextByTestId(id, value); });
}
async function settleRunComposerExitMotion() {
    await act(async () => { await new Promise(resolve => setTimeout(resolve,
        Math.max(motionTokens.overlay.modal.exitMs, motionTokens.overlay.popover.exitMs))); });
}
async function openPlanRunComposer(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await screen.pressByTestIdAsync('workflow-review-plan-run');
    // The newly mounted editor first has no measured anchor, so its canonical
    // modal can retire as the anchored presenter takes over. Never press that
    // retained, invisible modal's deliberately inactive Start control.
    await settleRunComposerExitMotion();
}
function editorPromptInput(screen: Awaited<ReturnType<typeof renderScreen>>) {
    // Editable text lives in the host field's value, not in text-node children.
    return findAllHostTestInstances(screen.findByType(ScopedAuthoringComposer),
        (node) => node.props.testID === 'new-session-composer-input' || node.props['data-testid'] === 'new-session-composer-input').at(-1);
}
// Count actual HTTP Action executions; Machine capability reads are not admissions.
const admissions = () => startPlan.mock.calls;

describe('Review through the real Account Action owner and HTTP storage boundary', () => {
    it.each(['7', '8'])('hydrates the first result from incremental private content at revision %s across concurrent holds', async (revision) => {
        routerMock.module.router.setParams({ invocationId: heldId });
        const h = await harness({ runScreen: true, concurrentHolds: true, emptyResult: true });
        await vi.waitFor(() => expect(h.screen.getTextContent()).toContain(t('workflows.review.noValue')));
        const reads = () => h.operations.filter(operation => operation.operation === 'invocations.get').length;
        const readsBeforeArrival = reads();
        await h.arriveResult(heldId, originalValue, revision);
        expect(storage.getState().workflowRunInvocationsByRunId[workflowRunStoreKey(runId)]?.factsById[heldId]?.opened?.progress.result)
            .toEqual(originalValue);
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-use')?.props.disabled).toBe(false));
        expect(h.screen.getTextContent()).toContain(originalValue.summary);
        expect(h.screen.findHostByTestId('workflow-review-newer')).toBeNull();
        if (revision === '7') expect(reads() - readsBeforeArrival).toBe(1);
        await h.screen.pressByTestIdAsync('workflow-review-edit');
        await change(h.screen, 'workflow-review-field-summary', 'Alpha human buffer');

        routerMock.module.router.setParams({ invocationId: betaHeldId });
        await h.refresh();
        await vi.waitFor(() => expect(h.screen.getTextContent()).toContain(t('workflows.review.noValue')));
        await h.arriveResult(betaHeldId, { ...originalValue, summary: 'Beta first result' }, revision);
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-use')?.props.disabled).toBe(false));
        expect(h.screen.getTextContent()).toContain('Beta first result');
        await h.arriveResult(betaHeldId, { ...originalValue, summary: 'Beta newer publication' }, '9');
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-newer')).not.toBeNull());
        expect(h.screen.getTextContent()).toContain('Beta first result');
        expect(h.screen.getTextContent()).not.toContain('Beta newer publication');
        await h.screen.pressByTestIdAsync('workflow-review-show-newer');
        expect(h.screen.getTextContent()).toContain('Beta newer publication');

        routerMock.module.router.setParams({ invocationId: heldId });
        await h.refresh();
        await vi.waitFor(() => expect(h.screen.findByTestId('workflow-review-field-summary')?.props.value).toBe('Alpha human buffer'));
    });
    it('presents Plan validation failure with the card message and announcement semantics', async () => {
        const h = await harness({ plan: true, planProposal: true, planValidationUnavailable: true });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-action-error')).not.toBeNull());
        const problem = h.screen.findHostByTestId('workflow-review-action-error')!;
        expect(typeof problem.props.children).toBe('string');
        expect(problem.props.children.length).toBeGreaterThan(0);
        expect(problem.props.accessibilityRole).toBe('alert');
        expect(h.screen.findHostByTestId('workflow-review')!.findAll(node => node.props.testID === 'workflow-review-action-error').length).toBeGreaterThan(0);
        expect(h.onSettled).not.toHaveBeenCalled();
        expect(h.operations.filter(op => op.operation === 'invocations.complete_review')).toHaveLength(0);
    });
    it('mounted review draft Action changes the displayed human buffer without accepting and preserves newer-result choice', async () => {
        const h = await harness();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId };
        const executor = createDefaultActionExecutor();
        const input = { scope, draftId: heldId, runId, expectedContentRevision: '7',
            value: { ...originalValue, summary: 'Agent prepared my edit' } };
        await act(async () => {
            expect(await executor.execute('workflow.run.review.draft.set', input,
                { surface: 'agent', authority: 'account_automation', serverId: scope.serverId }))
                .toEqual({ ok: true, result: { status: 'applied' } });
        });
        expect(h.operations.every(operation => operation.operation === 'get' || operation.operation === 'invocations.list')).toBe(true);
        expect(h.screen.findByTestId('workflow-review-field-summary')!.props.value).toBe('Agent prepared my edit');
        const draft = h.readDraft();
        expect(draft?.editedAt).toEqual(expect.any(Number));
        expect(h.screen.findByTestId('workflow-review-draft-provenance')).not.toBeNull();
        await act(async () => {
            expect(await executor.execute('workflow.run.review.draft.set', input,
                { surface: 'agent', authority: 'account_automation', serverId: scope.serverId }))
                .toEqual({ ok: true, result: { status: 'unchanged' } });
        });
        expect(h.readDraft()).toBe(draft);
        expect(await executor.execute('workflow.run.review.draft.set', { ...input, expectedContentRevision: '6' },
            { surface: 'agent', authority: 'account_automation', serverId: scope.serverId }))
            .toMatchObject({ ok: true, result: { status: 'refused', reason: 'stale_content_revision' } });
        await h.reopen();
        expect(h.screen.findByTestId('workflow-review-field-summary')!.props.value).toBe('Agent prepared my edit');
        await workflowRunDetailActions.publishDraft({ runId, invocation: { recordId: heldId }, expectedContentRevision: '7',
            value: { ...originalValue, summary: 'Newer agent publication' } });
        await h.refresh();
        expect(h.screen.findByTestId('workflow-review-newer')).not.toBeNull();
        expect(h.screen.findByTestId('workflow-review-field-summary')!.props.value).toBe('Agent prepared my edit');
        await h.screen.pressByTestIdAsync('workflow-review-keep-edits');
        expect(h.screen.findByTestId('workflow-review-field-summary')!.props.value).toBe('Agent prepared my edit');
        await h.screen.pressByTestIdAsync('workflow-review-cancel');
        await h.screen.pressByTestIdAsync('workflow-review-show-newer');
        await h.screen.pressByTestIdAsync('workflow-review-edit');
        expect(h.screen.findByTestId('workflow-review-field-summary')!.props.value).toBe('Newer agent publication');
        expect(h.operations.filter(operation => operation.operation === 'invocations.complete_review')).toEqual([]);
    });
    it('completes a hold with exactly the mounted Action draft after refusing a stale edit', async () => {
        const h = await harness();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId };
        const executor = createDefaultActionExecutor();
        const value = { ...originalValue, summary: 'Prepared through the draft Action' };
        const input = { scope, draftId: heldId, runId, expectedContentRevision: '7', value };
        const context = { surface: 'agent' as const, authority: 'account_automation' as const, serverId: scope.serverId };
        await act(async () => {
            expect(await executor.execute('workflow.run.review.draft.set', input, context))
                .toEqual({ ok: true, result: { status: 'applied' } });
            expect(await executor.execute('workflow.run.review.draft.set', { ...input, expectedContentRevision: '6',
                value: { ...value, summary: 'Stale value must not win' } }, context))
                .toMatchObject({ ok: true, result: { status: 'refused', reason: 'stale_content_revision' } });
        });
        expect(h.rows.get(heldId)?.index).toMatchObject({ lifecycle: 'waiting_for_review', contentRevision: '7' });
        expect(h.screen.findByTestId('workflow-review-field-summary')!.props.value).toBe(value.summary);
        await h.screen.pressByTestIdAsync('workflow-review-use');
        await vi.waitFor(() => expect(h.rows.get(heldId)?.index.lifecycle).toBe('completed'));
        const progress = h.readProgress();
        expect(WorkflowProgressEnvelopeV1Schema.parse(progress)).toMatchObject({ result: value,
            review: { resultSource: { kind: 'human', accountId }, decision: { kind: 'use_result', requestedFromContentRevision: '7' } } });
        expect(WorkflowProgressEnvelopeV1Schema.safeParse({ ...progress, unknown: true }).success).toBe(false);
        expect(h.onSettled.mock.calls[0]?.[0]).toMatchObject({ state: 'queued' });
        expect(machineRpc).not.toHaveBeenCalled();
        expect(startPlan).not.toHaveBeenCalled();
    });
    it.each(['history_not_readable', 'encryption_setup_required'] as const)('retains %s from the initial Run read and offers only its real recovery', async (runReadError) => {
        const h = await harness({ runScreen: true, runReadError });
        await vi.waitFor(() => expect(h.screen.findByTestId('workflow-run-load-failed')).not.toBeNull());
        const problem = describeWorkflowOperationProblem(runReadError);
        expect(h.screen.getTextContent()).toContain(problem.title);
        expect(h.screen.getTextContent()).toContain(problem.message);
        if (runReadError === 'history_not_readable') {
            expect(h.screen.findHostByTestId('workflow-run-load-failed-action')).toBeNull();
        } else {
            expect(h.screen.getTextContent()).toContain(problem.repairLabel);
            await h.screen.pressByTestIdAsync('workflow-run-load-failed-action');
            expect(routerMock.spies.push).toHaveBeenCalledWith({ pathname: '/settings/account/security',
                params: { serverId: expect.any(String), accountId } });
        }
        expect(h.operations.filter(op => op.operation === 'invocations.complete_review')).toHaveLength(0);
    });
    it('continues a newly added Wait without requiring a result value', async () => {
        const h = await harness({ wait: true, fieldlessWait: true });
        expect(h.screen.findHostByTestId('workflow-review-editor')).toBeNull();
        expect(h.screen.findHostByTestId('workflow-review-use')?.props.disabled).toBe(false);
        await h.screen.pressByTestIdAsync('workflow-review-use');
        await vi.waitFor(() => expect(h.rows.get(heldId)?.index.lifecycle).toBe('completed'));
        expect(h.readProgress().result).toBeUndefined();
        expect(h.readProgress().review?.decision?.kind).toBe('use_result');
        expect(machineRpc).not.toHaveBeenCalled();
    });
    it('keeps fieldless Wait Continue visible but refuses mutation without confirmed evidence', async () => {
        const h = await harness({ wait: true, fieldlessWait: true, confirmed: false });
        expect(h.screen.findHostByTestId('workflow-review-use')?.props.disabled).toBe(true);
        await h.screen.pressByTestIdAsync('workflow-review-use');
        expect(h.operations.filter(op => op.operation === 'invocations.complete_review')).toHaveLength(0);
        expect(h.rows.get(heldId)?.index.lifecycle).toBe('waiting_for_review');
    });
    it('registers the visible Wait buffer while its exact read is pending without enabling acceptance', async () => {
        routerMock.module.router.setParams({ invocationId: heldId });
        const h = await harness({ runScreen: true, wait: true, exactRead: 'pending' });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-use')?.props.disabled).toBe(true));
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { getMountedWorkflowDraftAddresses } = await import('@/sync/ops/actions/workflowAuthoringAction');
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId };
        expect(getMountedWorkflowDraftAddresses()).toContainEqual({ scope, draftId: heldId });
        await act(async () => {
            expect(await createDefaultActionExecutor().execute('workflow.run.review.draft.set', {
                scope, draftId: heldId, runId, expectedContentRevision: '7', value: { summary: 'Prepared while reading', approved: true },
            }, { surface: 'agent', authority: 'account_automation', serverId: scope.serverId }))
                .toEqual({ ok: true, result: { status: 'applied' } });
        });
        expect(h.screen.findByTestId('workflow-review-field-summary')!.props.value).toBe('Prepared while reading');
        expect(h.screen.findHostByTestId('workflow-review-use')?.props.disabled).toBe(true);
        await h.screen.pressByTestIdAsync('workflow-review-use');
        expect(h.operations.filter(op => op.operation === 'invocations.complete_review' || op.operation === 'invocations.publish_draft')).toHaveLength(0);
        h.boundary.exactRead = undefined;
        await act(async () => h.settleExactRead());
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-use')?.props.disabled).toBe(false));
        expect(h.screen.findByTestId('workflow-review-field-summary')!.props.value).toBe('Prepared while reading');
    });
    it('keeps a first-open fieldless Wait visible through a pending and failed exact read, then retries before Continue', async () => {
        routerMock.module.router.setParams({ invocationId: heldId });
        const h = await harness({ runScreen: true, wait: true, fieldlessWait: true, exactRead: 'pending' });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-use')?.props.disabled).toBe(true));
        // The initial page now opens its exact progress in the same authorized
        // batch. Keep that last confirmed card quiet while its later exact read waits.
        expect(h.screen.findByTestId('workflow-review')).not.toBeNull();
        expect(h.screen.findByTestId('workflow-run-read-pending')).toBeNull();
        expect(h.screen.getTextContent()).not.toContain(t('workflows.contentUnavailable'));
        await h.screen.pressByTestIdAsync('workflow-review-use');
        expect(h.operations.filter(op => op.operation === 'invocations.complete_review')).toHaveLength(0);
        h.boundary.exactRead = 'failed';
        await act(async () => h.settleExactRead());
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-run-read-retry')).not.toBeNull());
        expect(h.screen.findHostByTestId('workflow-review-use')?.props.disabled).toBe(true);
        const text = h.screen.getTextContent();
        const problem = describeWorkflowOperationProblem('storage_unavailable');
        expect(text).toContain(problem.title);
        expect(text.split(problem.message).length - 1).toBe(1);
        expect(text).not.toContain(t('workflows.contentUnavailable'));
        h.boundary.exactRead = undefined;
        await h.screen.pressByTestIdAsync('workflow-run-read-retry');
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-use')?.props.disabled).toBe(false));
        await h.screen.pressByTestIdAsync('workflow-review-use');
        await vi.waitFor(() => expect(h.rows.get(heldId)?.index.lifecycle).toBe('completed'));
        expect(h.operations.filter(op => op.operation === 'invocations.complete_review')).toEqual([
            expect.objectContaining({ expectedContentRevision: '7', mode: 'use_result' }),
        ]);
        expect(h.readProgress().result).toBeUndefined();
        expect(machineRpc).not.toHaveBeenCalled();
        expect(startPlan).not.toHaveBeenCalled();
    });
    it.each(['view', 'owner', 'edit'] as const)('Run controls consume the effective %s access through the real detail read', async (access) => {
        const h = await harness({ runScreen: true, access });
        await vi.waitFor(() => expect(h.screen.findByTestId('workflow-run-outcome')).not.toBeNull());
        for (const id of ['workflow-run-pause', 'workflow-run-cancel']) {
            if (access === 'view') expect(h.screen.findAllHostsByTestId(id), id).toHaveLength(0);
            else expect(h.screen.findHostByTestId(id), id).not.toBeNull();
        }
        expect(h.operations.filter(op => ['pause', 'cancel', 'resume', 'invocations.complete_review'].includes(String(op.operation)))).toHaveLength(0);
    });
    it('refuses Plan admission after effective edit access is revoked while the seeded editor is open', async () => {
        const h = await harness({ plan: true, planProposal: true });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-plan-run')).not.toBeNull());
        await openPlanRunComposer(h.screen);
        await vi.waitFor(() => expect(h.screen.findByTestId('workflow-run-inputs-run')).not.toBeNull());
        h.boundary.access = 'view';
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(h.screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        expect(admissions()).toHaveLength(0);
        expect(h.rows.get(heldId)?.index.lifecycle).toBe('waiting_for_review');
        expect(h.readProgress().review?.decision).toBeUndefined();
    });
    it('projects server-effective view access and offers no mutating review or Plan actions', async () => {
        const h = await harness({ access: 'view', plan: true, planProposal: true });
        expect(h.detail.callerAccess).toEqual({ canEdit: false });
        for (const id of ['workflow-review-edit', 'workflow-review-use', 'workflow-review-generate', 'workflow-review-discuss',
            'workflow-review-plan-edit', 'workflow-review-plan-run']) {
            expect(h.screen.findAllHostsByTestId(id), id).toHaveLength(0);
        }
        expect(h.operations.filter(op => op.operation === 'invocations.complete_review')).toHaveLength(0);
        expect(machineRpc).not.toHaveBeenCalled();
        expect(startPlan).not.toHaveBeenCalled();
    });
    it.each(['owner', 'edit'] as const)('retains the published review controls for effective %s access', async (access) => {
        const h = await harness({ access });
        expect(h.detail.callerAccess).toEqual({ canEdit: true });
        expect(h.screen.findHostByTestId('workflow-review-edit')).not.toBeNull();
        await h.screen.pressByTestIdAsync('workflow-review-use');
        await vi.waitFor(() => expect(h.onSettled).toHaveBeenCalled());
    });
    it.each([false, true])('keeps newer-publication reading local after access revocation (compact: %s)', async (compact) => {
        const h = await harness({ compact });
        await h.screen.pressByTestIdAsync('workflow-review-edit');
        await change(h.screen, 'workflow-review-field-summary', 'Retained local edits');
        await workflowRunDetailActions.publishDraft({ runId, invocation: { recordId: heldId }, expectedContentRevision: '7',
            value: { ...originalValue, summary: 'Readable newer publication' } });
        h.boundary.access = 'view';
        await h.refreshAccess();
        expect(h.screen.findByTestId('workflow-review-field-summary')?.props.value).toBe('Retained local edits');
        expect(h.screen.findByTestId('workflow-review-use')).toBeNull();
        expect(h.screen.findByTestId('workflow-review-keep-edits')?.props.disabled).toBe(false);
        expect(h.screen.findByTestId('workflow-review-use-newer')?.props.disabled).toBe(false);
        await h.screen.pressByTestIdAsync('workflow-review-use-newer');
        expect(h.screen.getTextContent()).toContain('Readable newer publication');
        await h.screen.pressByTestIdAsync('workflow-review-show-full');
        expect(h.screen.findByTestId('workflow-review-full-value')).not.toBeNull();
        expect(h.screen.findByTestId('workflow-review-use')).toBeNull();
        expect(h.operations.filter(op => op.operation === 'invocations.complete_review')).toHaveLength(0);
        expect(admissions()).toHaveLength(0);
    });
    it('hands Run it to the same unsaved seeded editor without completing the source hold', async () => {
        const h = await harness({ plan: true, planProposal: true });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-plan-run')).not.toBeNull());
        await openPlanRunComposer(h.screen);
        expect(h.onOpenDraft).toHaveBeenCalledWith(expect.objectContaining({ sourceRunId: runId, definition: h.proposal,
            planReview: expect.objectContaining({ invocationId: heldId, expectedContentRevision: '7' }) }));
        expect(h.rows.get(heldId)?.index.lifecycle).toBe('waiting_for_review');
        expect(h.readProgress().review?.decision).toBeUndefined();
        expect(admissions()).toHaveLength(0);
        await vi.waitFor(() => expect(h.screen.findByTestId('workflow-run-inputs-run')).not.toBeNull());
        expect(h.screen.findByTestId('workflow-editor-name')).not.toBeNull();
        await dismissRunComposer(h.screen);
        expect(h.screen.findByTestId('workflow-editor-name')).not.toBeNull();
        expect(h.screen.findByTestId('workflow-run-inputs-run')).toBeNull();
        await h.screen.pressByTestIdAsync('workflow-editor-step-implement-summary-prompt');
        expect(editorPromptInput(h.screen)?.props.value).toBe('Implement the proposal');
        await h.screen.pressByTestIdAsync('workflow-editor-run-now');
        expect(h.screen.findByTestId('workflow-run-inputs-run')).not.toBeNull();
        expect(h.rows.get(heldId)?.index.lifecycle).toBe('waiting_for_review');
        expect(h.readProgress().review?.decision).toBeUndefined();
        expect(admissions()).toHaveLength(0);
    });
    it.each([
        { acceptEdit: false, refuseReview: false },
        { acceptEdit: true, refuseReview: false },
        { acceptEdit: true, refuseReview: true },
    ])('routes Cancel, edit, Run through explicit Edit first (accepted: $acceptEdit, refused: $refuseReview) before any admission', async ({ acceptEdit, refuseReview }) => {
        const h = await harness({ plan: true, planProposal: true });
        h.boundary.refuse = refuseReview;
        startPlan.mockImplementation(async raw => {
            const input = WorkflowRunStartRequestV1Schema.parse(raw);
            h.admitPlan(input);
            return WorkflowRunStartResultV1Schema.parse({ run: { ...h.run, id: input.runId, state: 'queued' }, admission: 'created' });
        });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-plan-run')).not.toBeNull());
        await openPlanRunComposer(h.screen);
        await vi.waitFor(() => expect(h.screen.findByTestId('workflow-run-inputs-run')).not.toBeNull());
        await dismissRunComposer(h.screen);
        await h.screen.pressByTestIdAsync('workflow-editor-step-implement-summary-prompt');
        await act(async () => changeTextTestInstance(editorPromptInput(h.screen), 'Implement my edited proposal', 'Workflow prompt input'));
        await h.screen.pressByTestIdAsync('workflow-editor-run-now');
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(admissions()).toHaveLength(0);
        await vi.waitFor(() => expect(h.readModals().filter(modal => modal.type === 'confirm')).toHaveLength(1));
        await h.screen.pressByTestIdAsync(acceptEdit ? 'web-modal-confirm' : 'web-modal-cancel');
        await vi.waitFor(() => expect(h.readModals().filter(modal => modal.type === 'confirm')).toEqual([]));
        if (!acceptEdit || refuseReview) {
            expect(h.rows.get(heldId)?.index.lifecycle).toBe('waiting_for_review');
            expect(h.readProgress().review?.decision).toBeUndefined();
            expect(h.operations.filter(op => op.operation === 'invocations.complete_review')).toHaveLength(acceptEdit ? 1 : 0);
            expect(editorPromptInput(h.screen)?.props.value).toBe('Implement my edited proposal');
        } else {
            await vi.waitFor(() => expect(h.rows.get(heldId)?.index.lifecycle).toBe('completed'));
            expect(h.readProgress().review?.decision).toEqual({ kind: 'use_result', requestedFromContentRevision: '7',
                followUp: { kind: 'editing' } });
            await vi.waitFor(() => expect(h.screen.findByTestId('workflow-run-inputs-run')).toBeNull());
            expect(editorPromptInput(h.screen)?.props.value).toBe('Implement my edited proposal');
            startPlan.mockImplementation(async raw => {
                const input = WorkflowRunStartRequestV1Schema.parse(raw);
                expect(input.runId).not.toBe(h.planRunId);
                expect(input.source).toMatchObject({ kind: 'inline', definition: { blocks: [{ document: { text: 'Implement my edited proposal' } }] } });
                return WorkflowRunStartResultV1Schema.parse({ run: { ...h.run, id: input.runId, state: 'queued' }, admission: 'created' });
            });
            await h.screen.pressByTestIdAsync('workflow-editor-run-now');
            await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
            await vi.waitFor(() => expect(admissions()).toHaveLength(1));
            expect(h.operations.filter(op => op.operation === 'invocations.complete_review')).toHaveLength(1);
        }
    });
    it('keeps paused acceptance feedback after the Run removes its completed review card', async () => {
        routerMock.module.router.setParams({ invocationId: heldId });
        const h = await harness({ runScreen: true, paused: true, wait: true, fieldlessWait: true });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-use')?.props.disabled).toBe(false));
        await h.screen.pressByTestIdAsync('workflow-review-use');
        await vi.waitFor(() => expect(h.rows.get(heldId)?.index.lifecycle).toBe('completed'));
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-use')).toBeNull());
        expect(h.run.state).toBe('paused');
        expect(h.screen.getTextContent()).toContain(t('workflows.review.acceptedPaused'));
    });
    it('shows settled generate feedback while the Run remains paused', async () => {
        const h = await harness();
        h.run.state = 'paused';
        await h.refresh();
        expect(h.screen.getTextContent()).not.toContain(t('workflows.review.acceptedPaused'));
        await h.screen.pressByTestIdAsync('workflow-review-generate');
        await vi.waitFor(() => expect(h.onSettled).toHaveBeenCalled());
        await h.refresh();
        expect(h.run.state).toBe('paused');
        const message = t('workflows.review.startsResume');
        expect(h.screen.getTextContent()).toContain(message);
        h.run.state = 'queued';
        await h.refresh();
        expect(h.screen.getTextContent()).not.toContain(message);
    });
    it('publishes a draft, explicitly shows newer bytes, and commits the exact displayed edit/token', async () => {
        const h = await harness();
        await workflowRunDetailActions.publishDraft({ runId, invocation: { recordId: heldId }, expectedContentRevision: '7', value: { ...originalValue, summary: 'New publication' } });
        await h.refresh();
        expect(h.screen.findHostByTestId('workflow-review-newer')).not.toBeNull();
        await h.screen.pressByTestIdAsync('workflow-review-show-newer');
        await h.screen.pressByTestIdAsync('workflow-review-edit');
        await change(h.screen, 'workflow-review-field-summary', 'Human exact edit');
        await h.screen.pressByTestIdAsync('workflow-review-use');
        await vi.waitFor(() => expect(h.onSettled).toHaveBeenCalled());
        expect(h.readProgress()).toMatchObject({ result: { ...originalValue, summary: 'Human exact edit' },
            review: { resultSource: { kind: 'human', accountId }, decision: { kind: 'use_result', requestedFromContentRevision: '8' } } });
        expect(h.rows.get(heldId)?.index).toMatchObject({ lifecycle: 'completed', contentRevision: '9' });
        expect(h.onSettled.mock.calls[0]?.[0]).toMatchObject({ state: 'queued' });
        expect(machineRpc).not.toHaveBeenCalled();
        expect(startPlan).not.toHaveBeenCalled();
    });
    it.each([false, true])('accepts the kept human draft against publication 9 and requires Keep again for a later publication (%s)', async (publishAfterKeep) => {
        const h = await harness();
        await workflowRunDetailActions.publishDraft({ runId, invocation: { recordId: heldId }, expectedContentRevision: '7', value: originalValue });
        await h.refresh();
        await h.screen.pressByTestIdAsync('workflow-review-edit');
        await change(h.screen, 'workflow-review-field-summary', 'My revision 8 draft');
        const publish = async (expectedContentRevision: string) => {
            await callWorkflowAction({ actionId: 'workflow.run.invocations.publish_draft', input: { runId, invocation: { recordId: heldId },
                expectedContentRevision, value: { ...originalValue, summary: `Agent publication after ${expectedContentRevision}` } },
                context: { surface: 'agent', authority: 'account_automation' },
                parseResult: value => WorkflowInvocationPublishDraftResultV1Schema.parse(value) });
            await h.refresh();
        };
        await publish('8');
        expect(h.rows.get(heldId)?.index.contentRevision).toBe('9');
        expect(h.readProgress().review?.resultSource).toEqual({ kind: 'published', by: 'agent' });
        expect(h.screen.findByTestId('workflow-review-newer')).not.toBeNull();
        await h.screen.pressByTestIdAsync('workflow-review-keep-edits');
        expect(h.screen.findByTestId('workflow-review-newer')).toBeNull();
        expect(h.screen.findByTestId('workflow-review-field-summary')!.props.value).toBe('My revision 8 draft');
        if (publishAfterKeep) {
            await publish('9');
            expect(h.screen.findByTestId('workflow-review-newer')).not.toBeNull();
            await h.screen.pressByTestIdAsync('workflow-review-use');
            expect(h.rows.get(heldId)?.index).toMatchObject({ lifecycle: 'waiting_for_review', contentRevision: '10' });
            expect(h.screen.findByTestId('workflow-review-action-error')).not.toBeNull();
            expect(h.screen.findByTestId('workflow-review-field-summary')!.props.value).toBe('My revision 8 draft');
            expect(h.onSettled).not.toHaveBeenCalled();
            await h.screen.pressByTestIdAsync('workflow-review-keep-edits');
        }
        await h.screen.pressByTestIdAsync('workflow-review-use');
        await vi.waitFor(() => expect(h.onSettled).toHaveBeenCalled());
        expect(h.readProgress()).toMatchObject({ result: { ...originalValue, summary: 'My revision 8 draft' },
            review: { resultSource: { kind: 'human', accountId }, decision: { kind: 'use_result', requestedFromContentRevision: publishAfterKeep ? '10' : '9' } } });
        expect(h.rows.get(heldId)?.index).toMatchObject({ lifecycle: 'completed', contentRevision: publishAfterKeep ? '11' : '10' });
    });
    it('records offline Generate intent without Machine preflight or replacing the shown value', async () => {
        const h = await harness();
        await h.screen.pressByTestIdAsync('workflow-review-generate');
        await vi.waitFor(() => expect(h.onSettled).toHaveBeenCalled());
        expect(h.readProgress()).toMatchObject({ result: originalValue, execution: { localInputId: 'initial-input' },
            review: { decision: { kind: 'generate', requestedFromContentRevision: '7' } } });
        expect(h.rows.get(heldId)?.index.lifecycle).toBe('waiting_for_review');
        expect(h.onSettled).toHaveBeenCalled();
        expect(machineRpc).not.toHaveBeenCalled();
        expect(startPlan).not.toHaveBeenCalled();
    });
    it('requires and forwards the parent exact-attempt acknowledgment for stopped uncertain prior effects', async () => {
        // This held shape is produced/accepted by the canonical protocol review-owner test.
        const h = await harness({ uncertainPriorEffects: true, acknowledged: true });
        await expect(workflowRunDetailActions.completeReview({ runId, invocation: { recordId: heldId },
            expectedContentRevision: '7', mode: 'generate' })).rejects.toMatchObject({ code: 'workflow_outcome_unresolved' });
        expect(h.readProgress().review?.decision).toBeUndefined();
        expect(h.rows.get(heldId)?.index.contentRevision).toBe('7');
        expect(h.onSettled).not.toHaveBeenCalled();
        await h.screen.pressByTestIdAsync('workflow-review-generate');
        await vi.waitFor(() => expect(h.onSettled).toHaveBeenCalled());
        expect(h.readProgress()).toMatchObject({ uncertainPriorEffects: { activity: 'stopped' },
            review: { decision: { kind: 'generate', requestedFromContentRevision: '7' } } });
        expect(machineRpc).not.toHaveBeenCalled();
        expect(startPlan).not.toHaveBeenCalled();
    });
    it('withholds Generate when a newer publication invalidates the parent acknowledgment token', async () => {
        const h = await harness({ uncertainPriorEffects: true, acknowledged: true });
        await workflowRunDetailActions.publishDraft({ runId, invocation: { recordId: heldId }, expectedContentRevision: '7',
            value: { ...originalValue, summary: 'Published after acknowledgment' } });
        await h.refresh();
        expect(h.rows.get(heldId)?.index.contentRevision).toBe('8');
        const generate = h.screen.findByTestId('workflow-review-generate');
        expect(generate === null || generate.props.disabled === true).toBe(true);
        if (generate) await h.screen.pressByTestIdAsync('workflow-review-generate');
        expect(h.readProgress().review?.decision).toBeUndefined();
        expect(h.onSettled).not.toHaveBeenCalled();
        expect(machineRpc).not.toHaveBeenCalled();
        expect(startPlan).not.toHaveBeenCalled();
    });
    it.each([false, true])('keeps failed Wait values and shows the problem within the card (compact: %s)', async (compact) => {
        const h = await harness({ wait: true, compact });
        await change(h.screen, 'workflow-review-field-summary', 'Human answer');
        await h.screen.pressByTestIdAsync('workflow-review-field-approved:true');
        h.boundary.failSubmit = true;
        await h.screen.pressByTestIdAsync('workflow-review-use');
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-action-error')).not.toBeNull());
        const card = h.screen.findHostByTestId('workflow-review')!;
        expect(card.findAll(node => node.props.testID === 'workflow-review-action-error').length).toBeGreaterThan(0);
        expect(h.screen.findByTestId('workflow-review-field-summary')?.props.value).toBe('Human answer');
        expect(h.onSettled).not.toHaveBeenCalled();
        h.boundary.failSubmit = false;
        await h.screen.pressByTestIdAsync('workflow-review-use');
        await vi.waitFor(() => expect(h.onSettled).toHaveBeenCalled());
        expect(h.readProgress().result).toMatchObject({ summary: 'Human answer', approved: true });
    });
    it('accepts typed Wait values with human attribution and offers neither Generate nor Discuss', async () => {
        const h = await harness({ wait: true });
        expect(h.screen.findAllHostsByTestId('workflow-review-generate')).toHaveLength(0);
        expect(h.screen.findAllHostsByTestId('workflow-review-discuss')).toHaveLength(0);
        await change(h.screen, 'workflow-review-field-summary', 'Human answer');
        await h.screen.pressByTestIdAsync('workflow-review-field-approved:true');
        await h.screen.pressByTestIdAsync('workflow-review-use');
        await vi.waitFor(() => expect(h.onSettled).toHaveBeenCalled());
        expect(h.readProgress()).toMatchObject({ result: { summary: 'Human answer', approved: true },
            review: { resultSource: { kind: 'human', accountId }, decision: { kind: 'use_result', requestedFromContentRevision: '7' } } });
        expect(h.onSettled).toHaveBeenCalled();
    });
    it('does not open Edit after CAS refusal, then records editing before emitting a fresh draft seed', async () => {
        const h = await harness({ plan: true });
        h.boundary.refuse = true;
        await h.screen.pressByTestIdAsync('workflow-review-plan-edit');
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-action-error')).not.toBeNull());
        expect(h.onOpenDraft).not.toHaveBeenCalled();
        expect(h.onSettled).not.toHaveBeenCalled();
        expect(h.rows.get(heldId)?.index.contentRevision).toBe('7');
        h.boundary.refuse = false;
        await h.screen.pressByTestIdAsync('workflow-review-plan-edit');
        await vi.waitFor(() => expect(h.onOpenDraft).toHaveBeenCalled());
        expect(h.readProgress().review?.decision).toEqual({ kind: 'use_result', requestedFromContentRevision: '7', followUp: { kind: 'editing' } });
        expect(h.onOpenDraft).toHaveBeenCalledWith(expect.objectContaining({ inputs: {}, sourceRunId: runId,
            project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' },
            definition: expect.objectContaining({ blocks: [expect.objectContaining({ document: { text: h.readProgress().result && (h.readProgress().result as { document: string }).document, references: [], attachments: [] } })] }) }));
        expect(h.onSettled.mock.invocationCallOrder[0]).toBeLessThan(h.onOpenDraft.mock.invocationCallOrder[0]!);
    });
    it('rejoins the exact previously admitted Plan Run and recovers a lost completion response', async () => {
        const h = await harness({ plan: true, planProposal: true, admittedPlan: true });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-open-plan-run')).not.toBeNull());
        await h.screen.pressByTestIdAsync('workflow-review-open-plan-run');
        expect(h.onOpenRun).toHaveBeenCalledWith(h.planRunId);
        h.boundary.loseResponse = true;
        await h.screen.pressByTestIdAsync('workflow-review-use');
        await vi.waitFor(() => expect(h.onSettled).toHaveBeenCalled());
        expect(h.readProgress().review?.decision).toEqual({ kind: 'use_result', requestedFromContentRevision: '7', followUp: { kind: 'run_started', runId: h.planRunId } });
        expect(h.onSettled.mock.calls[0]?.[0]).toMatchObject({ state: 'queued' });
        expect(h.operations.filter(op => op.operation === 'invocations.complete_review')).toHaveLength(1);
        expect(machineRpc).not.toHaveBeenCalled();
        expect(startPlan).not.toHaveBeenCalled();
    });
    it('starts the reviewed Plan through the real Run-now controller before completing the source hold', async () => {
        const h = await harness({ plan: true, planProposal: true });
        startPlan.mockImplementation(async (raw, context) => {
            const input = WorkflowRunStartRequestV1Schema.parse(raw);
            expect(context.target).toMatchObject({ kind: 'machine', machineId: 'machine-a', project: { directory: '/repo' } });
            expect(input).toMatchObject({ runId: h.planRunId, source: { kind: 'inline', definition: h.proposal } });
            expect(h.readProgress().review?.decision).toBeUndefined();
            h.events.push('plan.admitted');
            h.admitPlan(input);
            return WorkflowRunStartResultV1Schema.parse({ run: { ...h.run, id: h.planRunId, state: 'queued' }, admission: 'created' });
        });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-plan-run'), h.screen.getTextContent()).not.toBeNull());
        await openPlanRunComposer(h.screen);
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-run-inputs-run')).not.toBeNull());
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(h.rows.get(heldId)?.index.lifecycle, h.screen.getTextContent()).toBe('completed'));
        expect(h.events).toEqual(['plan.admitted', 'invocations.complete_review']);
        expect(h.readProgress().review?.decision).toEqual({ kind: 'use_result', requestedFromContentRevision: '7',
            followUp: { kind: 'run_started', runId: h.planRunId } });
        expect(routerMock.spies.push).toHaveBeenCalledWith(createWorkflowRunRoute(h.planRunId, 'srv_workflow-review-integration'));
        expect(admissions()).toHaveLength(1);
    });
    it('reconciles the exact admitted Plan after a lost Machine admission response without starting it again', async () => {
        const h = await harness({ plan: true, planProposal: true });
        startPlan.mockImplementation(async raw => {
            const input = WorkflowRunStartRequestV1Schema.parse(raw);
            expect(input.runId).toBe(h.planRunId);
            h.admitPlan(input);
            throw new Error('admission_response_lost_after_commit');
        });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-plan-run'), h.screen.getTextContent()).not.toBeNull());
        await openPlanRunComposer(h.screen);
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-run-inputs-run')).not.toBeNull());
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(admissions()).toHaveLength(1));
        await vi.waitFor(() => expect(h.rows.get(heldId)?.index.lifecycle).toBe('completed'));
        expect(routerMock.spies.push).toHaveBeenCalledWith(createWorkflowRunRoute(h.planRunId, 'srv_workflow-review-integration'));
        expect(h.readProgress().review?.decision).toEqual({ kind: 'use_result', requestedFromContentRevision: '7',
            followUp: { kind: 'run_started', runId: h.planRunId } });
        expect(admissions()).toHaveLength(1);
    });
    it.each(['open', 'run', 'run-loss', 'use'] as const)('discloses an earlier admitted proposal after response loss and publication, then %s', async choice => {
        const h = await harness({ plan: true, planProposal: true });
        const proposalB = WorkflowDefinitionV1Schema.parse({ ...h.proposal, blocks: [{ ...h.proposal.blocks[0],
            document: { text: 'Implement the new proposal B', references: [], attachments: [] } }] });
        const valueB = StrictJsonValueSchema.parse({ document: 'Updated plan B', proposal: proposalB });
        startPlan.mockImplementation(async raw => {
            const input = WorkflowRunStartRequestV1Schema.parse(raw);
            h.admitPlan(input);
            // Publication races the lost reply: reconciliation must not attach
            // proposal A's admitted Run to the now-current proposal B.
            await workflowRunDetailActions.publishDraft({ runId, invocation: { recordId: heldId }, expectedContentRevision: '7', value: valueB });
            throw new Error('admission_response_lost_after_commit');
        });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-plan-run')).not.toBeNull());
        await openPlanRunComposer(h.screen);
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-run-inputs-run')).not.toBeNull());
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(admissions()).toHaveLength(1));
        await vi.waitFor(() => expect(h.screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        await h.reopen();
        await h.screen.pressByTestIdAsync('workflow-review-show-newer');
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-earlier-plan-run'), h.screen.getTextContent()).not.toBeNull());
        expect(h.screen.findHostByTestId('workflow-review-plan-run')).not.toBeNull();
        if (choice === 'open') {
            await h.screen.pressByTestIdAsync('workflow-review-open-plan-run');
            expect(h.onOpenRun).toHaveBeenCalledWith(h.planRunId);
            expect(h.readProgress().review?.decision).toBeUndefined();
        } else if (choice === 'use') {
            await h.screen.pressByTestIdAsync('workflow-review-use');
            await vi.waitFor(() => expect(h.onSettled).toHaveBeenCalled());
            expect(h.readProgress().result).toEqual(valueB);
            expect(h.readProgress().review?.decision).toEqual({ kind: 'use_result', requestedFromContentRevision: '8' });
        } else {
            let newRunId = '';
            startPlan.mockImplementation(async raw => {
                const input = WorkflowRunStartRequestV1Schema.parse(raw);
                expect(input.source).toEqual({ kind: 'inline', definition: proposalB });
                expect(input.runId).not.toBe(h.planRunId);
                newRunId = input.runId;
                h.admitPlan(input);
                if (choice === 'run-loss') throw new Error('new_proposal_admission_response_lost_after_commit');
                return WorkflowRunStartResultV1Schema.parse({ run: { ...h.run, id: newRunId, state: 'queued' }, admission: 'created' });
            });
            await openPlanRunComposer(h.screen);
            await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-run-inputs-run')).not.toBeNull());
            await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
            await vi.waitFor(() => expect(h.rows.get(heldId)?.index.lifecycle).toBe('completed'));
            expect(h.readProgress().result).toEqual(valueB);
            expect(h.readProgress().review?.decision).toEqual({ kind: 'use_result', requestedFromContentRevision: '8',
                followUp: { kind: 'run_started', runId: newRunId } });
            expect(admissions()).toHaveLength(2);
        }
    });
    it.each([true, false])('Report back preserves the owned origin through the real start controller (delivery enabled=%s)', async (reportBack) => {
        // Each choice gets the canonical afterEach Account/Sync disposal, rather
        // than initializing a second Account while the first is still active.
        const h = await harness({ plan: true, planProposal: true, ownedOrigin: true });
        expect(h.readOrigin()?.id).toBe(originSessionId);
        expect(isSessionAccessOwner(h.readOrigin()?.access, h.readOrigin()?.accessLevel)).toBe(true);
        startPlan.mockImplementation(async raw => {
            h.admitPlan(WorkflowRunStartRequestV1Schema.parse(raw));
            return WorkflowRunStartResultV1Schema.parse({
                run: { ...h.run, id: h.planRunId, state: 'queued', origin: { kind: 'direct', originSessionId } }, admission: 'created',
            });
        });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-plan-run'), h.screen.getTextContent()).not.toBeNull());
        await openPlanRunComposer(h.screen);
        expect(h.readOrigin()?.id).toBe(originSessionId);
        expect(isSessionAccessOwner(h.readOrigin()?.access, h.readOrigin()?.accessLevel)).toBe(true);
        // The owned-origin question must be reachable in the actual composer.
        // Unclassified extras are dropped by both its collapsed bar and menu;
        // a missing chip here is therefore a product visibility failure, not
        // evidence about the Switch slot that is asserted after opening it.
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-plan-report-chip'), h.screen.getTextContent()).not.toBeNull());
        await h.screen.pressByTestIdAsync('workflow-plan-report-chip');
        await vi.waitFor(() => expect(h.screen.findHostByTestId('agent-input-content-popover')).not.toBeNull());
        const popover = h.screen.findHostByTestId('agent-input-content-popover')!;
        // Establish that the real report question opened before testing its missing slot.
        expect(popover.findAll(node => String(node.type) === 'Text').length).toBeGreaterThan(0);
        // Vite's extensionless import resolves Switch.tsx, unlike Metro's
        // web platform split. Its real Deferred mounts the native host
        // asynchronously; retain that owner and wait for its painted host.
        const readSwitches = () => h.screen.findHostByTestId('agent-input-content-popover')?.findAll(node =>
            typeof node.type === 'string' && (node.props.role ?? node.props.accessibilityRole) === 'switch') ?? [];
        await vi.waitFor(() => expect(readSwitches()).toHaveLength(1));
        const toggle = readSwitches()[0]!;
        const readSwitchValue = () => {
            const host = readSwitches()[0];
            return host?.props['aria-checked'] ?? host?.props.value;
        };
        expect(readSwitchValue()).toBe(true);
        if (!reportBack) {
            if (typeof toggle.props.onValueChange === 'function') {
                await act(async () => { invokeTestInstanceHandler(toggle, 'onValueChange', false, 'Report-back switch'); });
            } else {
                await pressTestInstanceAsync(toggle, 'Report-back switch');
            }
            await vi.waitFor(() => expect(readSwitchValue()).toBe(false));
        }
        await h.screen.pressByTestIdAsync('workflow-plan-report-chip');
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(h.rows.get(heldId)?.index.lifecycle).toBe('completed'));
        // Inspect the actual request after normal boundary success so a
        // contract failure cannot be swallowed by the start controller.
        const admitted = admissions().at(-1)!;
        const input = WorkflowRunStartRequestV1Schema.parse(admitted[0]);
        expect(input.runId).toBe(h.planRunId);
        // Approved 06 §3.5: origin remains the owned Session regardless
        // of whether completion delivery back to that Session is enabled.
        expect(admitted[1].invocation.defaultSessionId).toBe(originSessionId);
        if (reportBack) {
            expect(input.onComplete).toEqual({ kind: 'originating_session' });
        } else {
            expect(input).not.toHaveProperty('onComplete');
        }
        // The origin is host transport context, never caller-authored semantic input.
        expect(input).not.toHaveProperty('originSessionId');
        expect(h.readProgress().review?.decision).toEqual({ kind: 'use_result', requestedFromContentRevision: '7',
            followUp: { kind: 'run_started', runId: h.planRunId } });
    });
});

/** The fixture has no mounted DOM anchor, so the real card uses BaseModal's dismissal path. */
async function dismissRunComposer(screen: Readonly<{ findAll: (predicate: (node: import('react-test-renderer').ReactTestInstance) => boolean) => import('react-test-renderer').ReactTestInstance[] }>) {
    const presenter = screen.findAll((node) => node.type === BaseModal && node.props.visible
        && node.findAll((child) => (child.props.testID ?? child.props['data-testid']) === 'workflow-run-inputs').length > 0).at(-1);
    await act(async () => { invokeTestInstanceHandler(presenter, 'onClose', undefined, 'Run composer presenter'); });
    // The real presenter retains its content for its owned exit motion.
    await settleRunComposerExitMotion();
}
