import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import type { WorkflowRunAcceptedContextV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAutomationRunFixture, createWorkflowDefinitionFixture, createWorkflowInvocationIndexFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { applyPlannedChangeActions } from '@/sync/runtime/orchestration/changesApplier';
import { runSocketReconnectCatchUpViaChanges } from '@/sync/runtime/orchestration/socketReconnectViaChanges';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { refreshWorkflowRunById, refreshWorkflowRunsByIds, refreshWorkflowRunSummaries } = await import('./refreshWorkflowRun');
const { workflowRunRowFromAutomationRun, workflowRunRowFromSummary, workflowRunStoreKey } = await import('@/sync/store/domains/workflowRuns');
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

async function serveRun(metadata?: { title: string }, unopened = false,
    source: WorkflowRunAcceptedContextV1['source'] = { kind: 'inline' }, access: 'owner' | 'view' = 'owner',
    invocationRecordIds: readonly string[] = []) {
    const materialized = await materializeWorkflowAcceptedSnapshotV1({
        definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait',
            document: { text: 'Continue', references: [], attachments: [] } }] }),
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
        context: { source, inputs: {}, machineId: run.machineId,
            executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } }, ...(metadata ? { metadata } : {}) },
    });
    if (!materialized.ok) throw new Error(`fixture_materialization_failed:${materialized.error.code}`);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: run.ownerAccountId, runId: run.id }, acceptedSnapshot: materialized.snapshot }));
    const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: run.ownerAccountId,
        access, encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
        ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    const invocationProgress = invocationRecordIds.map((id, ordinal) => {
        const index = createWorkflowInvocationIndexFixture({ id, runId: run.id,
            sequence: String(ordinal + 1), memberOrdinal: String(ordinal), lifecycle: 'completed' });
        const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
            mode: 'plain',
            binding: { v: 1, purpose: 'invocation_progress', accountId: run.ownerAccountId, runId: run.id,
                recordId: id, sequence: index.sequence, parentRecordId: index.parentRecordId,
                memberOrdinal: index.memberOrdinal, attempt: index.attempt },
            progress: { kind: 'happier.workflow-progress.v1', blockKind: 'wait',
                invocationPath: { blockId: 'wait', scope: [] }, attempt: index.attempt, logicalInvocationRecordId: id },
        }));
        return { index, contentEnvelope };
    });
    home.answer(serverId, route, { body: { runs: [run], acceptedEnvelopesByRunId: { [run.id]: unopened ? '{}' : acceptedEnvelope },
        keyCensusByRunId: { [run.id]: keyCensus }, invocationProgressByRunId: { [run.id]: invocationProgress } } });
}

describe('refreshWorkflowRunById through the real Account summary and store owners', () => {
    it('publishes a Run’s transcript invocation batch once and ignores an unchanged Account refresh', async () => {
        const invocationRecordIds = Array.from({ length: 24 }, (_, i) => `transcript-invocation-${i + 1}`);
        await serveRun(undefined, false, undefined, 'owner', invocationRecordIds);
        const key = workflowRunStoreKey(run.id);
        const publications: string[][] = [];
        const unsubscribe = storage.subscribe((state, previousState) => {
            const current = state.workflowRunInvocationsByRunId[key];
            if (current && current !== previousState.workflowRunInvocationsByRunId[key]) {
                publications.push(Object.keys(current.factsById).sort());
            }
        });
        try {
            await refreshWorkflowRunSummaries([{ runId: run.id, invocationRecordIds }]);
            const published = storage.getState().workflowRunInvocationsByRunId[key];
            expect(Object.keys(published?.factsById ?? {}).sort()).toEqual([...invocationRecordIds].sort());
            expect(published?.history.loaded).toBe(false);
            expect(publications).toHaveLength(1);

            await refreshWorkflowRunById(run.id);
            expect(storage.getState().workflowRunInvocationsByRunId[key]).toBe(published);
            expect(publications).toHaveLength(1);
            expect(home.requestsFor(route)).toHaveLength(2);
        } finally { unsubscribe(); }
    });

    it.each(['available', 'unreadable', 'incomplete'] as const)('FIX257 checkpoints a Workflow invalidation only after %s materialization', async kind => {
        await serveRun(undefined, kind === 'unreadable');
        if (kind === 'incomplete') home.answer(serverId, route, { body: { runs: [{ id: run.id }] } });
        let cursor = '506279';
        let firstPageReads = 0;
        const outcomes: Awaited<ReturnType<typeof applyPlannedChangeActions>>[] = [];
        const resume = () => runSocketReconnectCatchUpViaChanges({
            credentials: { token: 'synthetic' }, accountId: run.ownerAccountId, afterCursor: cursor,
            changesPageLimit: 200,
            fetchChanges: async ({ afterCursor }) => {
                if (afterCursor === '506279') {
                    firstPageReads++;
                    return { status: 'ok', changes: [{ cursor: 521547, kind: 'account',
                        entityId: `workflow-run:${run.id}`, changedAt: 1, hint: null }], nextCursor: '521547' };
                }
                return { status: 'ok', changes: [], nextCursor: afterCursor ?? '0' };
            },
            checkpointCursor: next => { cursor = next; return true; },
            snapshotRefresh: async () => ({ status: 'complete' }),
            applyPlanned: async planned => {
                const outcome = await applyPlannedChangeActions({ planned, credentials: { token: 'synthetic' },
                    isSessionMessagesLoaded: () => false, invalidate: {}, refreshWorkflowRuns: refreshWorkflowRunsByIds,
                    invalidateMessagesForSession: async () => {}, invalidateScmStatusForSession: () => {},
                    applyTodoSocketUpdates: async () => {}, kvBulkGet: async () => ({ values: [] }) });
                outcomes.push(outcome);
                return outcome;
            },
        });
        await resume();
        if (kind === 'incomplete') {
            expect(outcomes).toEqual([expect.objectContaining({ status: 'partial', safeAdvanceCursor: null,
                blockedCursor: '521547', blockedReason: 'partial-materialization' })]);
            expect(cursor).toBe('506279');
            expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id)]).toBeUndefined();
            return;
        }
        expect(outcomes).toEqual([expect.objectContaining({ status: 'complete', safeAdvanceCursor: '521547' })]);
        expect(cursor).toBe('521547');
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id)]?.summary?.id).toBe(run.id);
        if (kind === 'unreadable') expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id)]?.metadata)
            .toEqual({ kind: 'unavailable', reason: 'content_unavailable' });
        const readsAfterMaterialization = firstPageReads;
        for (let wake = 0; wake < 96; wake++) await resume();
        expect(firstPageReads - readsAfterMaterialization).toBe(0);
        expect(home.requestsFor(route)).toHaveLength(1);
    });

    it('publishes access upgrades and downgrades independently of the parent revision', async () => {
        for (const access of ['view', 'owner', 'view'] as const) {
            await serveRun(undefined, false, { kind: 'inline' }, access);
            await refreshWorkflowRunById(run.id);
            expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id)])
                .toMatchObject({ revision: run.revision, callerAccess: { canEdit: access === 'owner' } });
        }
        expect(home.requestsFor(route).map(request => request.input)).toEqual(Array.from({ length: 3 }, () =>
            expect.objectContaining({ operation: 'list', request: { runIds: [run.id], invocationProvenance: [] } })));
    });
    it('names an accepted built-in from the lean list and suppresses unchanged title publications', async () => {
        await serveRun(undefined, false, { kind: 'catalog', ref: 'builtin:fresh-opinions', version: 1 });
        await refreshWorkflowRunById(run.id);
        const first = storage.getState().workflowRunsById[workflowRunStoreKey(run.id)];
        expect(first?.metadata).toEqual({ kind: 'available', value: { title: 'Fresh opinions' } });
        let notifications = 0;
        const unsubscribe = storage.subscribe(() => { notifications++; });
        try {
            await refreshWorkflowRunById(run.id);
            expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id)]).toBe(first);
            expect(storage.getState().workflowRunsById[workflowRunStoreKey(run.id)]?.metadata).toBe(first?.metadata);
            expect(notifications).toBe(0);
            // One batch per explicit refresh; neither definitions nor full Run bodies are requested.
            expect(home.requestsFor(route).map(request => request.input)).toEqual([
                expect.objectContaining({ operation: 'list', request: { runIds: [run.id], invocationProvenance: [] } }),
                expect.objectContaining({ operation: 'list', request: { runIds: [run.id], invocationProvenance: [] } }),
            ]);
        } finally { unsubscribe(); }
    });

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

    it('preserves an Automation-only Run and its window when the Workflow exact list omits it', async () => {
        const automation = createAutomationRunFixture({ id: 'contributed-action-run', state: 'failed' });
        const deleted = createWorkflowRunSummaryFixture({ id: 'deleted-managed-run', ownerAccountId: run.ownerAccountId,
            origin: { kind: 'automation', automationId: 'managed-automation' } });
        storage.getState().applyWorkflowRunListPage({ windowId: 'automationAttention', runs: [],
            automationRuns: [automation], mode: 'replace', nextCursor: 'automation-tail' });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(deleted),
            workflowRunRowFromAutomationRun(createAutomationRunFixture({ id: deleted.id, automationId: 'managed-automation' }))]);
        const retained = storage.getState().workflowRunsById[workflowRunStoreKey(automation.id)];
        const window = storage.getState().workflowRunListWindows.automationAttention;
        expect(retained).toMatchObject({ summary: null, automation });
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(deleted.id)]).toMatchObject({
            summary: { id: deleted.id }, automation: { id: deleted.id },
        });
        expect(window).toMatchObject({ runIds: [automation.id], nextCursor: 'automation-tail' });
        home.answer(serverId, route, { body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } });
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Expected the test Home Account lifetime');

        await refreshWorkflowRunsByIds([automation.id, deleted.id], { accountLifetime, fence: accountLifetime });

        expect(storage.getState().workflowRunsById[workflowRunStoreKey(automation.id)]).toBe(retained);
        expect(storage.getState().workflowRunListWindows.automationAttention).toBe(window);
        expect(storage.getState().workflowRunsById[workflowRunStoreKey(deleted.id)]).toBeUndefined();
        expect(home.requestsFor(route)).toHaveLength(1);
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
