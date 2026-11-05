import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { refreshWorkflowRunById, refreshWorkflowRunsByIds } = await import('./refreshWorkflowRun');
const { workflowRunRowFromSummary, workflowRunStoreKey } = await import('@/sync/store/domains/workflowRuns');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { readDestinationInstanceTitle, resolveCompactAppDestinations, useDestinationInstanceTitles } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const run = createWorkflowRunSummaryFixture({ id: 'run-1', ownerAccountId: 'refresh-owner', origin: { kind: 'direct' } });
const route = '/v3/automations/runs/workflow-storage';
let serverId: string;
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();

beforeEach(async () => {
    previous = storage.getState();
    applied = getAppliedActiveServerSnapshot();
    available = isAppliedActiveServerRuntimeAvailable();
    await home.reset();
    serverId = await home.addHome({ name: 'Refresh Home', serverUrl: 'https://workflow-refresh.test', accountId: run.ownerAccountId });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    storage.setState({ profileScope: { serverId, accountId: run.ownerAccountId }, workflowRunsById: {}, workflowRunInvocationsByRunId: {} });
});
afterEach(async () => { standardCleanup(); await home.reset(); storage.setState(previous); publishAppliedActiveServerSnapshot(applied, available); });

async function serveRun(metadata?: { title: string }, unopened = false) {
    const materialized = await materializeWorkflowAcceptedSnapshotV1({
        definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait',
            document: { text: 'Continue', references: [], attachments: [] } }] }),
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: run.machineId,
            executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } }, ...(metadata ? { metadata } : {}) },
    });
    if (!materialized.ok) throw new Error(`fixture_materialization_failed:${materialized.error.code}`);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: run.ownerAccountId, runId: run.id }, acceptedSnapshot: materialized.snapshot }));
    const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: run.ownerAccountId,
        access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
        ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    home.answer(serverId, route, { body: { runs: [run], acceptedEnvelopesByRunId: { [run.id]: unopened ? '{}' : acceptedEnvelope },
        keyCensusByRunId: { [run.id]: keyCensus } } });
}

describe('refreshWorkflowRunById through the real Account summary and store owners', () => {
    it('hydrates an inactive restored Run title through the batched summary owner without opening its page', async () => {
        await serveRun({ title: 'Restored release check' });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: true, friends: false } });
        const entries = [{ key: 'inactive-run', ref: { kind: 'workflowRun', params: { runId: run.id } }, fallbackTitle: 'Previously known title' }];
        expect(readDestinationInstanceTitle(catalog, entries[0]!.ref, entries[0])).toBe('Previously known title');
        const hook = await renderHook(() => useDestinationInstanceTitles(catalog, entries));
        await vi.waitFor(() => expect(hook.getCurrent().get('inactive-run')).toBe('Restored release check'));
        expect(home.requestsFor(route).map(request => request.input)).toEqual([
            expect.objectContaining({ operation: 'list', request: { runIds: [run.id], invocationProvenance: [] } }),
        ]);
        await hook.unmount();
    });
    it('reads and publishes the exact lean summary without opening Run detail history', async () => {
        await serveRun({ title: 'Review 500 files' });
        await refreshWorkflowRunById(run.id);
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id)]).toMatchObject({ id: run.id,
            summary: { id: run.id, revision: run.revision }, metadata: { kind: 'available', value: { title: 'Review 500 files' } } });
        expect(home.requestsFor(route).map(request => request.input)).toEqual([
            expect.objectContaining({ operation: 'list', request: { runIds: [run.id], invocationProvenance: [] } }),
        ]);
    });

    it('refreshes every Run of an Account-change page in one batched read and removes the deleted one', async () => {
        const second = createWorkflowRunSummaryFixture({ id: 'run-2', ownerAccountId: run.ownerAccountId, origin: { kind: 'direct' } });
        const deleted = createWorkflowRunSummaryFixture({ id: 'run-3', ownerAccountId: run.ownerAccountId, origin: { kind: 'direct' } });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(deleted)]);
        const keyCensus = (runId: string) => WorkflowRunRecipientCensusResponseV1Schema.parse({ runId, ownerAccountId: run.ownerAccountId,
            access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
            ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
        home.answer(serverId, route, { body: { runs: [run, second],
            acceptedEnvelopesByRunId: { [run.id]: '{}', [second.id]: '{}' },
            keyCensusByRunId: { [run.id]: keyCensus(run.id), [second.id]: keyCensus(second.id) } } });

        await refreshWorkflowRunsByIds([run.id, second.id, deleted.id]);

        const rows = storage.getState().workflowRunsById;
        expect(rows[workflowRunStoreKey(run.id)]).toMatchObject({ id: run.id });
        expect(rows[workflowRunStoreKey(second.id)]).toMatchObject({ id: second.id });
        expect(rows[workflowRunStoreKey(deleted.id)]).toBeUndefined();
        // One Account read serves the page; a read per Run multiplies Account currentness and storage traffic.
        expect(home.requestsFor(route)).toHaveLength(1);
    });

    it('names readable accepted content from its frozen step when no title was authored (FIN M3)', async () => {
        await serveRun();
        await refreshWorkflowRunById(run.id);
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id)]?.metadata).toEqual({
            kind: 'available', value: { title: 'Continue' },
        });
    });

    it('reports genuinely unopened accepted content with its typed unavailable reason', async () => {
        await serveRun(undefined, true);
        await refreshWorkflowRunById(run.id);
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id)]?.metadata).toEqual({ kind: 'unavailable', reason: 'content_unavailable' });
    });

    it('removes an existing row when the authoritative exact read reports deletion', async () => {
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run)]);
        home.answer(serverId, route, { body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } });
        await refreshWorkflowRunById(run.id);
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id)]).toBeUndefined();
    });

    it('rejects non-authoritative storage failures and preserves the existing row for retry', async () => {
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run)]);
        const retained = storage.getState().workflowRunsById[workflowRunStoreKey(run.id)];
        expect(retained).toBeDefined();
        home.answer(serverId, route, { status: 503, body: { error: 'storage_unavailable' } });
        await expect(refreshWorkflowRunById(run.id)).rejects.toThrow();
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id)]).toBe(retained);
    });
});
