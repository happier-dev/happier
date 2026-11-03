import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createWorkflowDefinitionFixture, createWorkflowInvocationIndexFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';

// Home HTTP and external Machine Actions are the replaced system boundaries.
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { workflowRunDetailActions: actions } = await import('./workflowRunDetailActions');
const { WorkflowActionError } = await import('./workflowActionError');
const route = '/v3/automations/runs/workflow-storage';
let serverId: string;
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();
beforeEach(async () => {
    previous = storage.getState(); applied = getAppliedActiveServerSnapshot(); available = isAppliedActiveServerRuntimeAvailable();
    await home.reset();
    serverId = await home.addHome({ name: 'Run detail Home', serverUrl: 'https://workflow-run-detail.test',
        serverIdentityId: 'srv_workflow_detail', accountId: 'detail-owner', currentAccount: true });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId, accountId: 'detail-owner' } });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
});
afterEach(async () => { await home.reset(); storage.setState(previous); publishAppliedActiveServerSnapshot(applied, available); });

describe('workflow Run detail Actions through Account HTTP and native RPC', () => {
    it('acknowledges the observed failure through the real front door and rejects stale observations', async () => {
        const input = { runId: 'run-1', revision: 2, failedAt: '2026-10-23T10:00:00.000Z' };
        home.answer(serverId, route, { body: { runId: input.runId, attentionSeenFailureAt: input.failedAt } });
        expect(await actions.markFailureSeen(input)).toEqual({ runId: input.runId, attentionSeenFailureAt: input.failedAt });
        expect(home.requestsFor(route).map(request => request.input)).toEqual([{ operation: 'read_state.set', ...input }]);
        home.answer(serverId, route, { status: 409, body: { error: 'currentness_conflict' } });
        await expect(actions.markFailureSeen(input)).rejects.toMatchObject({ code: 'currentness_conflict' });
    });
    it('opens one exact Run with its producer-frozen definition and context through Account storage', async () => {
        const run = createWorkflowRunSummaryFixture({ id: 'run-1', ownerAccountId: 'detail-owner', origin: { kind: 'direct' } });
        const definition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Continue', references: [], attachments: [] } }] });
        const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition, admission: { kind: 'user' },
            effects: { resolveTargetAvailability: async () => true }, context: { source: { kind: 'inline' }, inputs: {}, machineId: run.machineId,
                executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } } });
        if (!accepted.ok) throw new Error(`fixture_materialization_failed:${accepted.error.code}`);
        const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: run.ownerAccountId, runId: run.id }, acceptedSnapshot: accepted.snapshot }));
        const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: run.ownerAccountId,
            access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
            ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
        home.answer(serverId, route, { select: input => {
            if (!input || typeof input !== 'object' || !('operation' in input)) throw new Error('Expected the real storage request');
            if (input.operation === 'get') return { body: { run, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null, keyCensus } };
            if (input.operation === 'invocations.list') return { body: { invocations: [], parentRevision: run.revision, keyCensus, progressEnvelopesByInvocationId: {} } };
            if (input.operation === 'run-key.census') return { body: keyCensus };
            throw new Error(`Unexpected storage operation:${input.operation}`);
        } });
        const result = await actions.getRun(run.id);
        expect(result.run).toMatchObject(run);
        expect(result.definition).toEqual(accepted.snapshot.definition);
        expect(result.authoredDefinition).toEqual(definition);
        expect(result.acceptedContext).toMatchObject({ source: { kind: 'inline' }, machineId: run.machineId, executionTarget: { kind: 'session' }, startedBy: 'user' });
        expect(result.callerAccess).toEqual({ canEdit: true });
        expect(home.requestsFor(route)[0]?.input).toEqual({ operation: 'get', runId: run.id });
    });

    it('asks the server index for actionable invocations without paging full detail history', async () => {
        home.answer(serverId, route, { body: { invocations: [createWorkflowInvocationIndexFixture({ id: 'inv-1', lifecycle: 'waiting_for_approval' })],
            nextCursor: 'page-2', parentRevision: 7 } });
        const result = await actions.listInvocations({ runId: 'run-1', lifecycles: ['waiting_for_approval', 'needs_attention'], cursor: 'page-1' });
        expect(home.requestsFor(route).map(request => request.input)).toEqual([expect.objectContaining({ operation: 'invocations.list',
            runId: 'run-1', cursor: 'page-1', lifecycles: ['waiting_for_approval', 'needs_attention'] })]);
        expect(result.invocations[0]?.lifecycle).toBe('waiting_for_approval');
        expect(result.parentRevision).toBe(7);
    });

    it('rejects a response the canonical result schema cannot accept', async () => {
        home.answer(serverId, route, { body: { invocations: [{ id: 'inv-1' }], parentRevision: 1 } });
        await expect(actions.listInvocations({ runId: 'run-1' })).rejects.toThrow();
    });

    it('surfaces a closed currentness error a control caller can branch on', async () => {
        home.answer(serverId, route, { status: 409, body: { error: 'currentness_conflict' } });
        const failure = await actions.pauseRun({ runId: 'run-1', expectedRevision: 3 }).catch((value: unknown) => value);
        expect(failure).toBeInstanceOf(WorkflowActionError);
        expect((failure as InstanceType<typeof WorkflowActionError>).code).toBe('currentness_conflict');
    });

    it('does not invent a Workflow error code for a front-door policy refusal', async () => {
        const actionsSettingsV1 = normalizeActionsSettingsV1({ v: 1, actions: { 'workflow.run.get': { enabled: false } } });
        home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1 } }, version: 1 } });
        const failure = await actions.getRun('run-1').catch((value: unknown) => value);
        expect(failure).toBeInstanceOf(WorkflowActionError);
        expect((failure as InstanceType<typeof WorkflowActionError>).code).toBeNull();
        expect((failure as InstanceType<typeof WorkflowActionError>).rawCode).toBe('action_disabled');
    });

    it('sends the expected control revision and returns durable intent rather than a stop receipt', async () => {
        const run = createWorkflowRunSummaryFixture({ id: 'run-1' });
        home.answer(serverId, route, { body: { run, intent: 'cancel_requested' } });
        const result = await actions.cancelRun({ runId: 'run-1', expectedRevision: 4 });
        expect(home.requestsFor(route).map(request => request.input)).toEqual([{ operation: 'cancel', runId: 'run-1', expectedRevision: 4 }]);
        expect(result.intent).toBe('cancel_requested');
    });

    it('targets workspace restoration at the exact Run Machine over the native relay', async () => {
        const received: unknown[] = [];
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://workflow-run-detail.test',
            serverIdentityId: 'srv_workflow_detail', accountId: 'detail-owner', machineId: 'machine-1',
            actionId: 'workflow.run.resume', tokenEpoch: 0, execute: (input, context) => {
                received.push({ input, target: context.target });
                return { run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running', revision: 5 }), intent: 'resumed' };
            } });
        setRuntimeFetch(async (url, init) => await boundary.handle(new URL(String(url)), init) ?? home.request(url, init));
        const input = { mode: 'recover' as const, runId: 'run-1', expectedRevision: 4, invocations: [{ kind: 'restore_workspace' as const,
            invocation: { recordId: 'inv-1' }, conversation: 'fresh_agent' as const, input: { kind: 'original' as const } }] };
        await actions.restoreWorkspace(input, 'machine-1');
        expect(received).toEqual([{ input, target: { kind: 'machine', machineId: 'machine-1' } }]);
        expect(home.requestsFor(route)).toEqual([]);
    });
});
