import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    WorkflowAcceptedSnapshotV1Schema, WorkflowDefinitionV1Schema, WorkflowProgressEnvelopeV1Schema,
    WorkflowRunInvocationIndexV1Schema, WorkflowRunRecipientCensusResponseV1Schema,
    WorkflowRunStartRequestV1Schema, WorkflowRunStartResultV1Schema,
    openWorkflowProgressStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1,
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1,
    validateWorkflowDefinition,
    StrictJsonValueSchema,
    type WorkflowRunInvocationIndexV1,
} from '@happier-dev/protocol';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions';
import { invokeTestInstanceHandler, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { Modal, ModalProvider } from '@/modal';
import { ScopedAuthoringComposer } from '@/components/sessions/authoring/ScopedAuthoringComposer';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { workflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { storage, useSession } from '@/sync/domains/state/storage';
import { isSessionAccessOwner } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { deriveWorkflowPlanRunId } from '@/sync/domains/workflows/workflowPlanReview';
import type { WorkflowActionTransport } from '@/sync/ops/actions/workflowActionTransport';
import { WorkflowInvocationReview, type WorkflowInvocationReviewBuffers } from './WorkflowInvocationReview';
import { WorkflowEditorHostScreen } from '../screens/WorkflowEditorHostScreen';
import { WorkflowRunScreen } from '../screens/WorkflowRunScreen';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { storeWorkflowReviewedRunSeed } from '@/sync/domains/workflows/workflowReviewedRunSeed';

// Only HTTP, Machine transport, credentials and rendering/platform loaders are replaced.
// Account scope, stores, feature/policy decisions, Action owners and codecs remain real.
installDisconnectedServerSocketBoundary();
const routerMock = await vi.hoisted(async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: { runId: '11111111-1111-4111-8111-111111111111' } });
});
vi.mock('expo-router', () => routerMock.module);
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));
vi.mock('@/sync/runtime/getSyncSingleton', async () => {
    const { createSyncSingletonLoaderMock } = await import('@/dev/testkit/harness/syncSingletonLoader');
    return createSyncSingletonLoaderMock();
});
const machineRpc = vi.hoisted(() => vi.fn<WorkflowActionTransport>(async () => { throw new Error('offline_machine'); }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
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
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ renderCustomModals: true }).module;
});
// Metro's require is unavailable in Vitest: adapt module loading, never execution.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    return { ...original, createFrontDoorActionExecute: (executor?: Parameters<typeof original.createFrontDoorActionExecute>[0]) => {
        if (executor) return original.createFrontDoorActionExecute(executor);
        let resolved: ReturnType<typeof original.createFrontDoorActionExecute> | null = null;
        const execute: ReturnType<typeof original.createFrontDoorActionExecute> = async (id, input, context) => {
            resolved ??= original.createFrontDoorActionExecute((await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor());
            return resolved(id, input, context);
        };
        return execute;
    } };
});

const accountId = 'review-integration-account';
const runId = '11111111-1111-4111-8111-111111111111';
const rootId = '22222222-2222-4222-8222-222222222222';
const heldId = '33333333-3333-4333-8333-333333333333';
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
    vi.mocked(Modal.confirm).mockReset();
    vi.mocked(Modal.confirm).mockResolvedValue(false);
    for (const dispose of disposals.splice(0).reverse()) await dispose();
    machineRpc.mockReset();
    machineRpc.mockImplementation(async () => { throw new Error('offline_machine'); });
    routerMock.spies.push.mockClear();
});
afterAll(() => { vi.unstubAllGlobals(); });

async function harness(options: Readonly<{ runScreen?: boolean; access?: 'owner' | 'edit' | 'view'; wait?: boolean; plan?: boolean; admittedPlan?: boolean; planProposal?: boolean; uncertainPriorEffects?: boolean; acknowledged?: boolean; ownedOrigin?: boolean }> = {}) {
    installShippedNativeFrameScheduler();
    const restorePlatform = withPopoverWebGlobals();
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
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
        options.wait ? { kind: 'wait', id: 'review', document: { text: 'Answer', references: [], attachments: [] }, result: resultContract }
            : { kind: 'step', id: 'review', document: { text: 'Draft', references: [], attachments: [] }, input: [], result: resultContract, pauseForReview: true },
    ] });
    const origin = { kind: 'direct' as const, ...(options.ownedOrigin ? { originSessionId } : {}) };
    const run = createWorkflowRunSummaryFixture({ id: runId, ownerAccountId: accountId, origin, state: 'waiting_for_review', revision: 7, machineId: 'machine-a',
        availability: { pause: true, cancel: true } });
    const acceptedSnapshot = WorkflowAcceptedSnapshotV1Schema.parse({ definition, authoredDefinition: definition,
        workDepth: 0, startedBy: 'user', metadata: null, frozenChildren: {},
        materializedLeaves: [{ sourceKey: '$root', blockId: 'review', kind: options.wait ? 'wait' : 'step', selection: {}, authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' } }],
        source: { kind: 'inline' }, inputs: {}, machineId: 'machine-a', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
        origin, authorization: { admittedPermissionCeiling: 'read-only', principal: { kind: 'host' } },
    });
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot }));
    const admittedPlanSnapshot = WorkflowAcceptedSnapshotV1Schema.parse({ ...acceptedSnapshot, definition: proposal, authoredDefinition: proposal,
        metadata: { title: 'Implement the proposal' }, materializedLeaves: [{ sourceKey: '$root', blockId: 'implement', kind: 'step', selection: proposal.defaults,
            authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' } }] });
    const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId, ownerAccountId: accountId, encryptionMode: 'plain', access: options.access ?? 'owner',
        dataEncryptionKey: null, callerDataEncryptionKey: null, visibleTeamId: null, recipients: [], ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    const rows = new Map<string, Row>();
    const binding = (index: WorkflowRunInvocationIndexV1) => ({ v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId, recordId: index.id,
        sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt: index.attempt });
    function insert(id: string, root: boolean) {
        const index = WorkflowRunInvocationIndexV1Schema.parse({ id, runId, sequence: root ? '0' : '1', parentRecordId: root ? null : rootId,
            memberOrdinal: '0', attempt: '0', contentRevision: root ? '0' : '7', lifecycle: root ? 'running' : 'waiting_for_review', createdAt: timestamp, updatedAt: timestamp });
        const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1', invocationPath: { blockId: root ? '$root' : 'review', scope: [] },
            blockKind: root ? 'root' : options.wait ? 'wait' : 'step', attempt: '0', logicalInvocationRecordId: id,
            ...(root ? {} : { resultContract, ...(options.wait ? {} : { result: value,
                execution: { kind: 'session', sessionId: 'conversation', localInputId: 'initial-input' }, review: { resultSource: { kind: 'execution_input' } } }) }),
            ...(!root && options.uncertainPriorEffects ? { uncertainPriorEffects: { activity: 'stopped' } } : {}),
        });
        rows.set(id, { index, parentRevision: run.revision, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: binding(index), progress })) });
    }
    insert(rootId, true); insert(heldId, false);
    const operations: Readonly<Record<string, unknown>>[] = [];
    const events: string[] = [];
    const boundary = { refuse: false, loseResponse: false, admittedPlan: options.admittedPlan === true, access: options.access ?? 'owner' };
    const planRunId = deriveWorkflowPlanRunId(runId, heldId);
    const admittedPlans = new Map<string, typeof admittedPlanSnapshot>();
    const account = await restoreServerAccountForTest({ serverUrl: `https://review-${crypto.randomUUID()}.test`, accountId: actorAccountId, request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/health') return json({});
        if (path === '/v1/features') return json({ features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {
            accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1' },
        } });
        if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v2/account/settings') return json({ content: null, version: 0 });
        if (path === '/v1/account/encryption/currentness') return json({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
        if (path !== '/v3/automations/runs/workflow-storage') return json({}, 404);
        // External server stores opaque envelopes and applies its published row CAS;
        // it neither decodes progress nor decides the review result.
        const operation = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
        operations.push(operation);
        if (operation.operation === 'get') {
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
                ...(operation.progressEnvelopes === true ? { progressEnvelopesByInvocationId: Object.fromEntries(listed.map(row => [row.index.id, row.contentEnvelope])) } : {}) });
        }
        if (operation.operation === 'invocations.get') return json({ invocation: rows.get(String(operation.invocationId)) });
        if (operation.operation === 'invocations.current') return json({ invocation: rows.get(heldId), parentRevision: run.revision });
        if (operation.operation === 'invocations.publish_draft' || operation.operation === 'invocations.complete_review') {
            const row = rows.get(String(operation.invocationId));
            if (!row || boundary.refuse || row.index.contentRevision !== operation.expectedContentRevision) return json({ error: 'currentness_conflict' }, 409);
            events.push(String(operation.operation));
            row.contentEnvelope = String(operation.contentEnvelope);
            row.index = { ...row.index, contentRevision: String(BigInt(row.index.contentRevision) + 1n), ...(operation.mode === 'use_result' ? { lifecycle: 'completed' as const } : {}) };
            if (operation.operation === 'invocations.complete_review') { run.revision++; run.state = 'queued'; }
            row.parentRevision = run.revision;
            if (boundary.loseResponse) { boundary.loseResponse = false; throw new Error('response_lost_after_commit'); }
            return operation.operation === 'invocations.publish_draft' ? json({ invocation: row, parentRevision: run.revision })
                : json({ run, invocation: row, disposition: operation.mode === 'use_result' ? 'completed' : 'generation_requested' });
        }
        throw new Error(`Unexpected Review storage operation: ${String(operation.operation)}`);
    } });
    disposals.push(account.dispose);
    if (options.ownedOrigin) {
        storage.getState().applySessions([createSessionFixture({ id: originSessionId, access: createSessionAccessFixture('owner') })]);
    }
    const detail = await workflowRunDetailActions.getRun(runId);
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
    function Host() {
        // Observe the same public Session hook as Review, without replacing its
        // store, Account scope, access projection or subscription owner.
        observedOrigin = useSession(options.ownedOrigin ? originSessionId : '');
        const [editorSeedId, setEditorSeedId] = React.useState<string | null>(null);
        if (options.runScreen) return <AppPaneProvider><WorkflowRunScreen /></AppPaneProvider>;
        if (editorSeedId !== null) return <AppPaneProvider><WorkflowEditorHostScreen source={{ kind: 'new', reviewedRunSeedId: editorSeedId }} /></AppPaneProvider>;
        const row = rows.get(heldId)!;
        return <WorkflowInvocationReview run={run} callerAccess={detail.callerAccess} acceptedContext={detail.acceptedContext!} invocation={row.index}
            progress={readProgress()} contentRevision={row.index.contentRevision} buffers={buffers} active confirmed compact={false}
            viewerAccountId={actorAccountId} current={current} onSettled={onSettled}
            onOpenDraft={(seed) => {
                onOpenDraft(seed);
                if (seed.planReview) setEditorSeedId(storeWorkflowReviewedRunSeed(seed));
            }} onOpenRun={onOpenRun} onDiscuss={() => {}} machineReachable={false}
            {...{ acknowledgeUncertainPriorEffects }} />;
    }
    const screen = await renderScreen(<ModalProvider><Host /></ModalProvider>, {
        // Anchor/content geometry comes from the renderer's platform-node boundary;
        // the real chip, Popover measurement and positioning owners still execute.
        createNodeMock: () => Object.assign(new EventTarget(), {
            // WebDropTargetView attaches/removes real DOM drag listeners on its
            // host ref; retain EventTarget behavior rather than mocking that owner.
            getBoundingClientRect: () => ({ x: 40, y: 400, left: 40, top: 400, right: 360, bottom: 560, width: 320, height: 160 }),
            contains: () => false,
            focus: () => {},
            measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(40, 400, 320, 160),
        }),
    });
    disposals.push(screen.unmount);
    let mount = 0;
    return { screen, detail, rows, run, readProgress, operations, events, proposal, boundary, onSettled, onOpenDraft, onOpenRun, planRunId,
        admitPlan: (input: ReturnType<typeof WorkflowRunStartRequestV1Schema.parse>) => {
            if (input.source.kind !== 'inline') throw new Error('Plan admission must be inline');
            const checked = validateWorkflowDefinition(input.source.definition);
            if (!checked.valid || !checked.normalizedDefinition) throw new Error('Invalid Plan admission');
            admittedPlans.set(input.runId, WorkflowAcceptedSnapshotV1Schema.parse({ ...admittedPlanSnapshot,
                definition: checked.normalizedDefinition, authoredDefinition: checked.normalizedDefinition }));
        },
        readOrigin: () => observedOrigin,
        refresh: () => screen.update(<ModalProvider><Host /></ModalProvider>),
        reopen: () => screen.update(<ModalProvider><Host key={++mount} /></ModalProvider>) };
}
async function change(screen: Awaited<ReturnType<typeof renderScreen>>, id: string, value: string) {
    await act(async () => { screen.changeTextByTestId(id, value); });
}
// Opening the real editor legitimately probes Machine capabilities. Only the
// targeted start is an admission; these assertions must not count read probes.
const admissions = () => machineRpc.mock.calls.filter(([request]) =>
    TargetedActionRpcRequestV1Schema.safeParse(request.payload).success);

describe('Review through the real Account Action owner and HTTP storage boundary', () => {
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
        await h.screen.pressByTestIdAsync('workflow-review-plan-run');
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
    });
    it.each(['owner', 'edit'] as const)('retains the published review controls for effective %s access', async (access) => {
        const h = await harness({ access });
        expect(h.detail.callerAccess).toEqual({ canEdit: true });
        expect(h.screen.findHostByTestId('workflow-review-edit')).not.toBeNull();
        await h.screen.pressByTestIdAsync('workflow-review-use');
        await vi.waitFor(() => expect(h.onSettled).toHaveBeenCalled());
    });
    it('hands Run it to the same unsaved seeded editor without completing the source hold', async () => {
        const h = await harness({ plan: true, planProposal: true });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-plan-run')).not.toBeNull());
        await h.screen.pressByTestIdAsync('workflow-review-plan-run');
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
        expect(h.screen.getTextContent()).toContain('Implement the proposal');
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
        vi.mocked(Modal.confirm).mockResolvedValue(acceptEdit);
        machineRpc.mockImplementation(async request => {
            const input = WorkflowRunStartRequestV1Schema.parse(TargetedActionRpcRequestV1Schema.parse(request.payload).input);
            h.admitPlan(input);
            return WorkflowRunStartResultV1Schema.parse({ run: { ...h.run, id: input.runId, state: 'queued' }, admission: 'created' });
        });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-plan-run')).not.toBeNull());
        await h.screen.pressByTestIdAsync('workflow-review-plan-run');
        await vi.waitFor(() => expect(h.screen.findByTestId('workflow-run-inputs-run')).not.toBeNull());
        await dismissRunComposer(h.screen);
        const prompt = h.screen.findByType(ScopedAuthoringComposer);
        await act(async () => {
            await invokeTestInstanceHandler(prompt, 'onChangeDocument', {
                text: 'Implement my edited proposal', references: [], attachments: [],
            });
        });
        await h.screen.pressByTestIdAsync('workflow-editor-run-now');
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(admissions()).toHaveLength(0);
        await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalled());
        if (!acceptEdit || refuseReview) {
            expect(h.rows.get(heldId)?.index.lifecycle).toBe('waiting_for_review');
            expect(h.readProgress().review?.decision).toBeUndefined();
            expect(h.operations.filter(op => op.operation === 'invocations.complete_review')).toHaveLength(acceptEdit ? 1 : 0);
            expect(h.screen.getTextContent()).toContain('Implement my edited proposal');
        } else {
            await vi.waitFor(() => expect(h.rows.get(heldId)?.index.lifecycle).toBe('completed'));
            expect(h.readProgress().review?.decision).toEqual({ kind: 'use_result', requestedFromContentRevision: '7',
                followUp: { kind: 'editing' } });
            expect(h.screen.findByTestId('workflow-run-inputs-run')).toBeNull();
            expect(h.screen.getTextContent()).toContain('Implement my edited proposal');
            machineRpc.mockImplementation(async request => {
                const input = WorkflowRunStartRequestV1Schema.parse(TargetedActionRpcRequestV1Schema.parse(request.payload).input);
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
        expect(h.onSettled).toHaveBeenCalledWith(expect.objectContaining({ state: 'queued' }));
        expect(machineRpc).not.toHaveBeenCalled();
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
        expect(h.onSettled).toHaveBeenCalledWith(expect.objectContaining({ state: 'queued' }));
        expect(h.operations.filter(op => op.operation === 'invocations.complete_review')).toHaveLength(1);
        expect(machineRpc).not.toHaveBeenCalled();
    });
    it('starts the reviewed Plan through the real Run-now controller before completing the source hold', async () => {
        const h = await harness({ plan: true, planProposal: true });
        machineRpc.mockImplementation(async request => {
            const targeted = TargetedActionRpcRequestV1Schema.parse(request.payload);
            const input = WorkflowRunStartRequestV1Schema.parse(targeted.input);
            expect(request).toMatchObject({ accountId, machineId: 'machine-a' });
            expect(targeted.target).toMatchObject({ kind: 'machine', machineId: 'machine-a', project: { directory: '/repo' } });
            expect(input).toMatchObject({ runId: h.planRunId, source: { kind: 'inline', definition: h.proposal } });
            expect(h.readProgress().review?.decision).toBeUndefined();
            h.events.push('plan.admitted');
            h.admitPlan(input);
            return WorkflowRunStartResultV1Schema.parse({ run: { ...h.run, id: h.planRunId, state: 'queued' }, admission: 'created' });
        });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-plan-run'), h.screen.getTextContent()).not.toBeNull());
        await h.screen.pressByTestIdAsync('workflow-review-plan-run');
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-run-inputs-run')).not.toBeNull());
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(h.rows.get(heldId)?.index.lifecycle).toBe('completed'));
        expect(h.events).toEqual(['plan.admitted', 'invocations.complete_review']);
        expect(h.readProgress().review?.decision).toEqual({ kind: 'use_result', requestedFromContentRevision: '7',
            followUp: { kind: 'run_started', runId: h.planRunId } });
        expect(routerMock.spies.push).toHaveBeenCalledWith({ pathname: '/workflows/runs/[runId]', params: { runId: h.planRunId } });
        expect(admissions()).toHaveLength(1);
    });
    it('reopens the exact admitted Plan after a lost Machine admission response without starting it again', async () => {
        const h = await harness({ plan: true, planProposal: true });
        machineRpc.mockImplementation(async request => {
            const targeted = TargetedActionRpcRequestV1Schema.parse(request.payload);
            const input = WorkflowRunStartRequestV1Schema.parse(targeted.input);
            expect(input.runId).toBe(h.planRunId);
            h.boundary.admittedPlan = true;
            throw new Error('admission_response_lost_after_commit');
        });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-plan-run'), h.screen.getTextContent()).not.toBeNull());
        await h.screen.pressByTestIdAsync('workflow-review-plan-run');
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-run-inputs-run')).not.toBeNull());
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(admissions()).toHaveLength(1));
        await vi.waitFor(() => expect(h.screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        expect(h.readProgress().review?.decision).toBeUndefined();
        expect(h.onSettled).not.toHaveBeenCalled();
        await h.reopen();
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-open-plan-run')).not.toBeNull());
        await h.screen.pressByTestIdAsync('workflow-review-open-plan-run');
        expect(h.onOpenRun).toHaveBeenCalledWith(h.planRunId);
        await h.screen.pressByTestIdAsync('workflow-review-use');
        await vi.waitFor(() => expect(h.onSettled).toHaveBeenCalled());
        expect(h.readProgress().review?.decision).toEqual({ kind: 'use_result', requestedFromContentRevision: '7',
            followUp: { kind: 'run_started', runId: h.planRunId } });
        expect(admissions()).toHaveLength(1);
    });
    it.each(['open', 'run', 'run-loss', 'use'] as const)('discloses an earlier admitted proposal after response loss and publication, then %s', async choice => {
        const h = await harness({ plan: true, planProposal: true });
        machineRpc.mockImplementation(async request => {
            const input = WorkflowRunStartRequestV1Schema.parse(TargetedActionRpcRequestV1Schema.parse(request.payload).input);
            h.admitPlan(input);
            throw new Error('admission_response_lost_after_commit');
        });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-plan-run')).not.toBeNull());
        await h.screen.pressByTestIdAsync('workflow-review-plan-run');
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-run-inputs-run')).not.toBeNull());
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(admissions()).toHaveLength(1));
        await vi.waitFor(() => expect(h.screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        const proposalB = WorkflowDefinitionV1Schema.parse({ ...h.proposal, blocks: [{ ...h.proposal.blocks[0],
            document: { text: 'Implement the new proposal B', references: [], attachments: [] } }] });
        const valueB = StrictJsonValueSchema.parse({ document: 'Updated plan B', proposal: proposalB });
        await workflowRunDetailActions.publishDraft({ runId, invocation: { recordId: heldId }, expectedContentRevision: '7', value: valueB });
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
            machineRpc.mockImplementation(async request => {
                const input = WorkflowRunStartRequestV1Schema.parse(TargetedActionRpcRequestV1Schema.parse(request.payload).input);
                expect(input.source).toEqual({ kind: 'inline', definition: proposalB });
                expect(input.runId).not.toBe(h.planRunId);
                newRunId = input.runId;
                h.admitPlan(input);
                if (choice === 'run-loss') throw new Error('new_proposal_admission_response_lost_after_commit');
                return WorkflowRunStartResultV1Schema.parse({ run: { ...h.run, id: newRunId, state: 'queued' }, admission: 'created' });
            });
            await h.screen.pressByTestIdAsync('workflow-review-plan-run');
            await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-run-inputs-run')).not.toBeNull());
            await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
            if (choice === 'run-loss') {
                await vi.waitFor(() => expect(admissions()).toHaveLength(2));
                await vi.waitFor(() => expect(h.screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
                expect(h.readProgress().review?.decision).toBeUndefined();
                await h.reopen();
                await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-open-plan-run')).not.toBeNull());
                await h.screen.pressByTestIdAsync('workflow-review-open-plan-run');
                expect(h.onOpenRun).toHaveBeenLastCalledWith(newRunId);
                await h.screen.pressByTestIdAsync('workflow-review-use');
            }
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
        machineRpc.mockImplementation(async request => {
            h.admitPlan(WorkflowRunStartRequestV1Schema.parse(TargetedActionRpcRequestV1Schema.parse(request.payload).input));
            return WorkflowRunStartResultV1Schema.parse({
                run: { ...h.run, id: h.planRunId, state: 'queued', origin: { kind: 'direct', originSessionId } }, admission: 'created',
            });
        });
        await vi.waitFor(() => expect(h.screen.findHostByTestId('workflow-review-plan-run'), h.screen.getTextContent()).not.toBeNull());
        await h.screen.pressByTestIdAsync('workflow-review-plan-run');
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
        const targeted = TargetedActionRpcRequestV1Schema.parse(admissions().at(-1)?.[0].payload);
        const input = WorkflowRunStartRequestV1Schema.parse(targeted.input);
        expect(input.runId).toBe(h.planRunId);
        // Approved 06 §3.5: origin remains the owned Session regardless
        // of whether completion delivery back to that Session is enabled.
        expect(targeted.defaultSessionId).toBe(originSessionId);
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

/** Dismisses the Run now composer the way a person does: through its presenter (outside press, Escape). */
async function dismissRunComposer(screen: Readonly<{ findAll: (predicate: (node: import('react-test-renderer').ReactTestInstance) => boolean) => import('react-test-renderer').ReactTestInstance[] }>) {
    const presenter = screen.findAll((node) => typeof node.props.onRequestClose === 'function'
        && node.findAll((child) => child.props.testID === 'workflow-run-inputs').length > 0).at(-1);
    await act(async () => { invokeTestInstanceHandler(presenter, 'onRequestClose', undefined, 'Run composer presenter'); });
}
