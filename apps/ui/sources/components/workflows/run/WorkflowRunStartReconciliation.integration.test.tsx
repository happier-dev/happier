import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    createWorkflowAccountRunActionOwner,
    TargetedActionRpcRequestV1Schema,
    WorkflowRunStartRequestV1Schema,
    WorkflowRunRecipientCensusResponseV1Schema,
    type WorkflowRunStartResultV1,
} from '@happier-dev/protocol';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { Modal } from '@/modal';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { useWorkflowRunNowController } from './useWorkflowRunNowController';
import { WorkflowRunComposer } from './WorkflowRunComposer';

installDisconnectedServerSocketBoundary();
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// Adapt Metro's synchronous loader to Vitest while retaining the real executor.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    return { ...original, createFrontDoorActionExecute: () => {
        let execute: ReturnType<typeof original.createFrontDoorActionExecute> | undefined;
        return async (...args: Parameters<ReturnType<typeof original.createFrontDoorActionExecute>>) => {
            execute ??= original.createFrontDoorActionExecute((await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor());
            return execute(...args);
        };
    } };
});
await vi.hoisted(async () => { vi.stubGlobal('React', await import('react')); });

const runId = '11111111-1111-4111-8111-111111111111';
const accountId = 'start-reconciliation-account';
const definition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait',
    document: { text: 'Continue', references: [], attachments: [] }, result: { kind: 'text' } }] });
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const dispose of disposals.splice(0).reverse()) await dispose();
    machineRpc.mockReset();
    vi.mocked(Modal.alert).mockClear();
    vi.unstubAllGlobals();
});

async function harness(outcome: 'admitted' | 'not-sent' | 'unknown', holdFirstMissingRead = false) {
    vi.stubGlobal('React', React);
    installShippedNativeFrameScheduler();
    await loadSyncSingletonForTests();
    const entries = new Map<string, { run: ReturnType<typeof createWorkflowRunSummaryFixture>; acceptedEnvelope: string }>();
    let admissions = 0;
    let reads = 0;
    const firstMissingRead = createDeferred<void>();
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
    const account = await restoreServerAccountForTest({ serverUrl: `https://start-${crypto.randomUUID()}.test`, accountId,
        request: async (url, init) => {
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
    const input = WorkflowRunStartRequestV1Schema.parse({ runId, source: { kind: 'inline', definition } });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, callerPermissionMode: 'default',
        externalActionTarget: { kind: 'machine' as const, machineId: 'machine-a', project: { machineId: 'machine-a', directory: '/repo' } } };
    machineRpc.mockImplementation(async (request) => {
        const targeted = TargetedActionRpcRequestV1Schema.parse(request.payload);
        expect(targeted.input).toEqual(input);
        if (outcome === 'not-sent') throw markRpcRequestDisposition(new Error('offline before dispatch'), 'notSent');
        if (outcome === 'admitted') {
            await expect(owner.execute({ actionId: 'workflow.run.start', input, context })).resolves.toMatchObject({ admission: 'created', run: { id: runId } });
        }
        throw Object.assign(new Error('Machine RPC timed out after 30000ms'), { code: 'MACHINE_RPC_TIMEOUT' });
    });
    const opened = vi.fn<(result: WorkflowRunStartResultV1) => void>();
    let pending: Promise<unknown> | undefined;
    let state = 'idle';
    function Host() {
        const controller = useWorkflowRunNowController();
        state = controller.stateFor(runId);
        return <WorkflowRunComposer inputs={[]} definition={definition} values={{}} onChangeValues={() => {}} onCancel={() => {}}
            pending={state === 'submitting' || state === 'reconciling'}
            reconciling={state === 'reconciling'}
            startProblem={controller.refusal?.message ?? null}
            onRun={() => { pending = controller.runNow({ ...input, project: context.externalActionTarget.project, refusal: 'inline' }).then(result => { if (result) opened(result); }); }} />;
    }
    const screen = await renderScreen(<Host />);
    disposals.push(screen.unmount);
    return { screen, opened, owner, input, context, account, readState: () => state,
        counts: () => ({ admissions, reads }), pending: () => pending, releaseFirstMissingRead: () => firstMissingRead.resolve() };
}

describe('Run start response-loss through the real composer, Machine transport and Account owner', () => {
    it('opens the admitted Run after the Machine transport times out, without a failure or second start', async () => {
        const h = await harness('admitted');
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await h.pending();
        expect(h.counts().admissions).toBe(1);
        await vi.waitFor(() => expect(h.opened).toHaveBeenCalledWith(expect.objectContaining({ admission: 'existing', run: expect.objectContaining({ id: runId }) })));
        expect(Modal.alert).not.toHaveBeenCalled();
        expect(h.counts()).toMatchObject({ admissions: 1 });
        expect(machineRpc).toHaveBeenCalledTimes(1);
        // A deliberate retry with the same admission identity rejoins at the real owner.
        await expect(h.owner.execute({ actionId: 'workflow.run.start', input: h.input, context: h.context })).resolves.toMatchObject({ admission: 'existing' });
        expect(h.counts().admissions).toBe(1);
    });
    it('keeps a confirmed not-sent refusal in the composer with its reason and retry available', async () => {
        const h = await harness('not-sent');
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await h.pending();
        expect(h.opened).not.toHaveBeenCalled();
        // 04 §4.8: a known refusal stays in the review, never a system alert.
        expect(Modal.alert).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(h.screen.findByTestId('workflow-run-inputs-reason-text')?.props.children)
            .toBe('workflows.problem.targetUnavailable'));
        expect(h.readState()).toBe('idle');
        expect(h.screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
        expect(h.counts()).toEqual({ admissions: 0, reads: 0 });
    });
    it('keeps an absent outcome pending and resolves on the Account feed without polling or resending', async () => {
        const h = await harness('unknown', true);
        await h.screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(h.readState()).toBe('reconciling'));
        await vi.waitFor(() => expect(h.counts().reads).toBe(1));
        expect(Modal.alert).not.toHaveBeenCalled();
        expect(h.opened).not.toHaveBeenCalled();
        expect(h.screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
        expect(h.screen.findHostByTestId('workflow-run-inputs-reconciling')).not.toBeNull();
        await act(async () => { await h.owner.execute({ actionId: 'workflow.run.start', input: h.input, context: h.context });
            publishHomeAccountChange(h.account.home.id, [`workflow-run:${runId}`]);
            h.releaseFirstMissingRead(); });
        await vi.waitFor(() => expect(h.opened).toHaveBeenCalled());
        expect(h.counts()).toEqual({ admissions: 1, reads: 2 });
        expect(machineRpc).toHaveBeenCalledTimes(1);
    });
});
