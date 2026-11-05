import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    createWorkflowAccountRunActionOwner,
    ActionExecuteFailureSchema,
    WorkflowRunStartRequestV1Schema,
    WorkflowRunGetResultV1Schema,
    WorkflowRunRecipientCensusResponseV1Schema,
    prepareWorkflowRunStartV1,
    type WorkflowRunStartResultV1,
} from '@happier-dev/protocol';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';

import type { NewSessionSimplePanelProps } from '@/components/sessions/new/components/NewSessionSimplePanel';

installDisconnectedServerSocketBoundary();
const { useNewSessionWorkflowStart } = await import('@/components/sessions/new/hooks/useNewSessionWorkflowStart');
const { createNewSessionPromptStore } = await import('@/components/sessions/new/hooks/screenModel/newSessionPromptStore');
const { ModalProvider, useModal } = await import('@/modal/ModalProvider');
const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
const { useWorkflowInlineRunControls } = await import('./useWorkflowInlineRunControls');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { WorkflowRunComposer } = await import('./WorkflowRunComposer');
// Admission fixtures never stream Markdown; keep the genuine vendor SDK leaf outside this seam.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected vendor Markdown reveal in start-reconciliation test'); },
}));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Native DOM primitives stay at the SDK boundary; Modal custody stays real.
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
// Adapt Metro's synchronous loader to Vitest while retaining the real executor.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
await vi.hoisted(async () => { vi.stubGlobal('React', await import('react')); });

const runId = '11111111-1111-4111-8111-111111111111';
const accountId = 'start-reconciliation-account';
const definition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait',
    document: { text: 'Continue', references: [], attachments: [] }, result: { kind: 'text' } }] });
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const dispose of disposals.splice(0).reverse()) await dispose();
    vi.unstubAllGlobals();
});

async function harness(outcome: 'admitted' | 'not-sent' | 'unknown' | 'delayed' | 'refused', holdFirstMissingRead = false, anotherRound = false, inlineRound = false, newSession = false) {
    vi.stubGlobal('React', React);
    installShippedNativeFrameScheduler();
    await loadSyncSingletonForTests();
    const entries = new Map<string, { run: ReturnType<typeof createWorkflowRunSummaryFixture>; acceptedEnvelope: string }>();
    let admissions = 0;
    let reads = 0;
    let dispatches = 0;
    let currentOutcome = outcome;
    const firstMissingRead = createDeferred<void>();
    const releaseOriginal = createDeferred<void>();
    let original: Promise<unknown> | undefined;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    const storageBoundary = async (operation: Readonly<Record<string, unknown>>) => {
        const id = String(operation.runId);
        if (operation.operation === 'get') {
            const entry = entries.get(id);
            if (!entry) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
            return { ...entry, checkpointEnvelope: null, resultEnvelope: null,
                keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: id, ownerAccountId: accountId,
                    visibleTeamId: null, encryptionMode: 'plain', access: 'owner',
                    ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
                    dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] }) };
        }
        if (operation.operation === 'admit') {
            admissions++;
            const run = createWorkflowRunSummaryFixture({ id, ownerAccountId: accountId, machineId: 'machine-a', state: 'queued', origin: { kind: 'direct' } });
            entries.set(id, { run, acceptedEnvelope: String(operation.acceptedEnvelope) });
            return { kind: 'created', run };
        }
        if (operation.operation === 'invocations.list') return { invocations: [] };
        throw new Error(`unexpected_storage_operation:${operation.operation}`);
    };
    const serverUrl = `https://start-${crypto.randomUUID()}.test`;
    const serverIdentityId = 'srv_workflow_reconciliation';
    let dispatch: (input: unknown) => Promise<unknown> = async () => { throw new Error('start_fixture_not_ready'); };
    const external = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId,
        machineId: 'machine-a', actionId: 'workflow.run.start', tokenEpoch: 0,
        execute: input => dispatch(input), failure: value => {
            const parsed = ActionExecuteFailureSchema.safeParse(value);
            return parsed.success ? parsed.data : null;
        } });
    const account = await restoreServerAccountForTest({ serverUrl, serverIdentityId, accountId,
        credentials: { token: createAccountTokenForTests(accountId, { currentAccount: true }) },
        request: async (url, init) => {
            const handled = await external.handle(new URL(String(url)), init);
            if (handled) return handled;
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
            const operation = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
            if (operation.operation === 'get') reads++;
            try { return json(await storageBoundary(operation)); }
            catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'run_not_found') {
                    if (holdFirstMissingRead && reads === 1) await firstMissingRead.promise;
                    return json({ error: 'run_not_found' }, 404);
                }
                throw error;
            }
        } });
    disposals.push(account.dispose);
    const owner = createWorkflowAccountRunActionOwner({
        storage: { execute: storageBoundary }, resolveAccountId: async () => accountId,
        definitions: { get: async () => { throw new Error('inline_has_no_artifact'); } },
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        normalizeAbsolutePath: resolveAbsolutePath,
        randomBytes: () => { throw new Error('plain_has_no_keys'); },
        prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
        resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, callerPermissionMode: 'default',
        externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } };
    const priorId = '33333333-3333-4333-8333-333333333333';
    let priorDetail: ReturnType<typeof WorkflowRunGetResultV1Schema.parse> | null = null;
    let admittedRunId = runId;
    let source: Parameters<typeof WorkflowRunStartRequestV1Schema.parse>[0] = { runId, source: { kind: 'inline', definition } };
    if (anotherRound) {
        const priorDefinition = { ...definition, blocks: [...definition.blocks], inputs: [
            { name: 'participants', valueType: 'json' as const, required: true },
            { name: 'previousRoundContext', valueType: 'json' as const, required: false },
        ] };
        await owner.execute({ actionId: 'workflow.run.start', input: { runId: priorId,
            source: { kind: 'inline', definition: priorDefinition }, inputs: { participants: ['retained-participant'] } }, context });
        const prior = entries.get(priorId)!;
        entries.set(priorId, { ...prior, run: { ...prior.run, state: 'succeeded' } });
        const opened = WorkflowRunGetResultV1Schema.parse(await owner.execute({ actionId: 'workflow.run.get', input: { runId: priorId }, context }));
        priorDetail = opened;
        if (!opened.acceptedContext) throw new Error('prior_context_unavailable');
        const prepared = prepareWorkflowRunStartV1({ definition: priorDefinition, acceptedContext: opened.acceptedContext,
            replay: { runId: priorId, intent: 'another_round' } });
        source = { runId, source: prepared.source, inputs: prepared.inputs };
        admissions = 0;
    }
    const input = WorkflowRunStartRequestV1Schema.parse(source);
    let dispatchedInput: ReturnType<typeof WorkflowRunStartRequestV1Schema.parse> | null = null;
    dispatch = async (request) => {
        dispatches++;
        const actual = WorkflowRunStartRequestV1Schema.parse(request);
        dispatchedInput = actual;
        if (inlineRound) admittedRunId = actual.runId;
        if (currentOutcome === 'refused') return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable',
            details: { reason: 'account_role_overrides_unavailable' } };
        if (currentOutcome === 'not-sent') return { ok: false, errorCode: 'target_unavailable', error: 'offline before dispatch' };
        if (currentOutcome === 'delayed') {
            if (dispatches === 1) {
                original = releaseOriginal.promise.then(() => owner.execute({ actionId: 'workflow.run.start', input: actual, context }));
                throw new Error('Start response lost before delayed delivery');
            }
            return owner.execute({ actionId: 'workflow.run.start', input: actual, context });
        }
        if (currentOutcome === 'admitted') {
            await expect(owner.execute({ actionId: 'workflow.run.start', input: actual, context })).resolves.toMatchObject({ admission: 'created', run: { id: admittedRunId } });
        }
        throw new Error('Start response lost after dispatch');
    };
    const opened = vi.fn<(result: WorkflowRunStartResultV1) => void>();
    let pending: Promise<unknown> | undefined;
    let state = 'idle';
    let modals: ReturnType<typeof useModal>['state']['modals'] = [];
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('missing_workflow_account_scope');
    const Host = () => {
        modals = useModal().state.modals;
        const controller = useWorkflowRunNowController();
        const inline = useWorkflowInlineRunControls({ run: priorDetail?.run ?? createWorkflowRunSummaryFixture({ id: runId }),
            definition: null, acceptedContext: null, supportsAnotherRound: inlineRound, accountLifetime: lifetime, canEdit: true,
            onStarted: result => { opened(result); } });
        const start = inlineRound ? inline.start : controller;
        state = start.stateFor(start.pendingRunId ?? admittedRunId);
        return <WorkflowRunComposer inputs={[]} definition={definition} values={{}} onChangeValues={() => {}} onCancel={() => {}}
            pending={state === 'submitting' || state === 'reconciling'}
            reconciling={state === 'reconciling'}
            startProblem={start.refusal}
            onRun={() => { pending = inlineRound ? inline.anotherRound?.()
                : controller.runNow({ ...input, project: context.externalActionTarget.project, refusal: 'inline' }).then(result => { if (result) opened(result); }); }} />;
    };
    const panelProps = {
        popoverBoundaryRef: React.createRef() as NewSessionSimplePanelProps['popoverBoundaryRef'], headerHeight: 0, safeAreaTop: 0, safeAreaBottom: 0,
        newSessionTopPadding: 0, newSessionSidePadding: 0, newSessionBottomPadding: 0, containerStyle: {},
        promptStore: createNewSessionPromptStore('Keep this brief'), setSessionPrompt: () => {},
        handleCreateSession: () => {}, canCreate: true, isCreating: false,
        emptyAutocompleteKinds: [], emptyAutocompleteSuggestions: async () => [],
        agentType: 'codex', handleAgentClick: undefined, permissionMode: 'default',
        handlePermissionModeChange: undefined, modelMode: 'default', setModelMode: undefined,
        modelOptions: [], connectionStatus: undefined, machineName: undefined,
        selectedMachineId: 'machine-a', selectedPath: '/repo', targetServerId: account.serverId,
        useProfiles: false, selectedProfileId: null, showResumePicker: false, resumeSessionId: null,
        isResumeSupportChecking: false,
    } satisfies NewSessionSimplePanelProps;
    let workflowChip: ReturnType<typeof useNewSessionWorkflowStart>['chip'] | undefined;
    const NewSessionHost = () => {
        const workflow = useNewSessionWorkflowStart({ panelProps, prompt: 'Keep this brief' });
        workflowChip = workflow.chip;
        return workflow.composer;
    };
    let mount = 0;
    const renderHost = () => <ModalProvider>{newSession ? <NewSessionHost key={mount} /> : <Host key={mount} />}</ModalProvider>;
    const screen = await renderScreen(renderHost());
    disposals.push(screen.unmount);
    return { screen, opened, owner, input, context, account, readState: () => state, readModals: () => modals,
        counts: () => ({ admissions, reads, dispatches }), pending: () => pending, admittedRunId: () => admittedRunId,
        dispatchedInput: () => dispatchedInput,
        remount: async () => { mount++; await screen.update(renderHost()); },
        recoverTransport: () => { currentOutcome = 'admitted'; },
        finishOriginal: async () => { releaseOriginal.resolve(); return original; },
        releaseFirstMissingRead: () => firstMissingRead.resolve(),
        selectNewSessionWorkflow: async () => {
            const content = workflowChip?.collapsedContentPopover?.renderContent;
            if (typeof content !== 'function') throw new Error('Workflow picker content is missing');
            const node = content({ requestClose: () => {}, maxHeight: 420 });
            if (!React.isValidElement(node)) throw new Error('Workflow picker is missing');
            const picker = await renderScreen(node);
            disposals.push(picker.unmount);
            await picker.pressByTestIdAsync('workflow-choice:builtin:plan-with-a-panel');
        } };
}

describe('Run start response-loss through the real composer, authenticated HTTP and Account owner', () => {
    it('retains typed Start diagnostics through the New Session workflow entry', async () => {
        const h = await harness('refused', false, false, false, true);
        await h.selectNewSessionWorkflow();
        expect(h.screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(h.counts().dispatches).toBe(1));
        await vi.waitFor(() => expect(h.screen.findByTestId('workflow-run-inputs-start-problem-details.header')).not.toBeNull());
        await h.screen.pressByTestIdAsync('workflow-run-inputs-start-problem-details.header');
        expect(h.screen.getTextContent()).toContain('content_unavailable');
        expect(h.screen.getTextContent()).toContain('account_role_overrides_unavailable');
        expect(h.counts()).toMatchObject({ admissions: 0, reads: 0, dispatches: 1 });
    });


    it('keeps the typed refusal from authenticated Start through the controller to Technical details', async () => {
        const h = await harness('refused');
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await h.pending();
        await h.screen.pressByTestIdAsync('workflow-run-inputs-start-problem-details.header');
        expect(h.screen.getTextContent()).toContain('content_unavailable');
        expect(h.screen.getTextContent()).toContain('account_role_overrides_unavailable');
        expect(h.counts()).toMatchObject({ admissions: 0, reads: 0, dispatches: 1 });
        expect(h.screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
    });

    it('opens inline continuation detail only on press and reconciles one ordinary new Run', async () => {
        const h = await harness('admitted', false, true, true);
        expect(h.counts()).toMatchObject({ reads: 0, dispatches: 0 });
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await act(async () => { await h.pending(); });
        expect(h.opened).toHaveBeenCalledWith(expect.objectContaining({ admission: 'existing' }));
        expect(h.counts()).toMatchObject({ admissions: 1, dispatches: 1 });
        expect(h.dispatchedInput()).toMatchObject({ ...h.input, runId: h.admittedRunId() });
        const opened = await h.owner.execute({ actionId: 'workflow.run.get', input: { runId: h.admittedRunId() }, context: h.context });
        expect(opened).toMatchObject({ acceptedContext: { inputs: { participants: ['retained-participant'],
            previousRoundContext: { runId: '33333333-3333-4333-8333-333333333333', state: 'succeeded', outcomes: [] } } } });
    });
    it('rejoins Another round after commit-before-ACK with accepted participants and prior context', async () => {
        const h = await harness('admitted', false, true);
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await act(async () => { await h.pending(); });
        await vi.waitFor(() => expect(h.opened).toHaveBeenCalledWith(expect.objectContaining({ admission: 'existing' })));
        const opened = await h.owner.execute({ actionId: 'workflow.run.get', input: { runId }, context: h.context });
        expect(opened).toMatchObject({ acceptedContext: { inputs: {
            participants: ['retained-participant'],
            previousRoundContext: { runId: '33333333-3333-4333-8333-333333333333', state: 'succeeded', outcomes: [] },
        } } });
        expect(h.counts().admissions).toBe(1);
        expect(h.counts().dispatches).toBe(1);
        expect(h.readModals()).toEqual([]);
    });

    it('opens the admitted Run after the Start response is lost, without a failure or second start', async () => {
        const h = await harness('admitted');
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await act(async () => { await h.pending(); });
        expect(h.counts().admissions).toBe(1);
        await vi.waitFor(() => expect(h.opened).toHaveBeenCalledWith(expect.objectContaining({ admission: 'existing', run: expect.objectContaining({ id: runId }) })));
        expect(h.readModals()).toEqual([]);
        expect(h.counts()).toMatchObject({ admissions: 1 });
        expect(h.counts().dispatches).toBe(1);
        // A deliberate retry with the same admission identity rejoins at the real owner.
        await expect(h.owner.execute({ actionId: 'workflow.run.start', input: h.input, context: h.context })).resolves.toMatchObject({ admission: 'existing' });
        expect(h.counts().admissions).toBe(1);
    });
    it('keeps a confirmed not-sent refusal in the composer with its reason and retry available', async () => {
        const h = await harness('not-sent');
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await act(async () => { await h.pending(); });
        expect(h.opened).not.toHaveBeenCalled();
        // 04 §4.8: a known refusal stays in the review, never a system alert.
        expect(h.readModals()).toEqual([]);
        await vi.waitFor(() => expect(h.screen.findByTestId('workflow-run-inputs-reason-text')?.props.children)
            .toBe('workflows.problem.targetUnavailable'));
        expect(h.readState()).toBe('idle');
        expect(h.screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
        expect(h.counts()).toEqual({ admissions: 0, reads: 0, dispatches: 1 });
    });
    it('rejoins an absent Start and a delayed original consumes the same canonical admission', async () => {
        const h = await harness('delayed', true);
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(h.readState()).toBe('reconciling'));
        await vi.waitFor(() => expect(h.counts().reads).toBe(1));
        await act(async () => {});
        expect(h.readModals()).toEqual([]);
        expect(h.opened).not.toHaveBeenCalled();
        expect(h.screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
        expect(h.screen.findHostByTestId('workflow-run-inputs-reconciling')).not.toBeNull();
        await act(async () => { h.releaseFirstMissingRead(); await h.pending(); });
        await vi.waitFor(() => expect(h.opened).toHaveBeenCalled());
        await expect(h.finishOriginal()).resolves.toMatchObject({ admission: 'existing', run: { id: runId } });
        expect(h.counts()).toEqual({ admissions: 1, reads: 1, dispatches: 2 });
    });
    it('returns an unknown outcome to the composer with recovery enabled when the rejoin is also lost', async () => {
        const h = await harness('unknown');
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await act(async () => { await h.pending(); });
        expect(h.readState()).toBe('idle');
        expect(h.opened).not.toHaveBeenCalled();
        expect(h.screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
        expect(h.screen.findByTestId('workflow-run-inputs-reason-text')?.props.children).toBe('workflows.problem.unresolvedOutcome');
        expect(h.counts()).toEqual({ admissions: 0, reads: 1, dispatches: 2 });
    });
    it('reopens inline Another round with the same reviewed request after unmount and lost rejoin', async () => {
        const h = await harness('unknown', false, true, true);
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await act(async () => { await h.pending(); });
        const original = h.dispatchedInput();
        if (original === null) throw new Error('Expected the reviewed Another round request');
        expect(h.counts()).toMatchObject({ admissions: 0, dispatches: 2 });
        await h.remount();
        expect(h.screen.findByTestId('workflow-run-inputs-reason-text')?.props.children).toBe('workflows.problem.unresolvedOutcome');
        h.recoverTransport();
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await act(async () => { await h.pending(); });
        expect(h.dispatchedInput()).toEqual(original);
        expect(h.counts()).toMatchObject({ admissions: 1, dispatches: 3 });
        expect(h.opened).toHaveBeenCalledWith(expect.objectContaining({ admission: 'existing', run: expect.objectContaining({ id: original.runId }) }));
        const opened = await h.owner.execute({ actionId: 'workflow.run.get', input: { runId: original.runId }, context: h.context });
        expect(opened).toMatchObject({ acceptedContext: { inputs: { participants: ['retained-participant'],
            previousRoundContext: { runId: '33333333-3333-4333-8333-333333333333', state: 'succeeded', outcomes: [] } } } });
    });
});
