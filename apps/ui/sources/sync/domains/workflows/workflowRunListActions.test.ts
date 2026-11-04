import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture, createWorkflowRunListStorageFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { WorkflowRunListRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { HAPPIER_COLLECTION_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { buildWorkflowRunListFilter, listWorkflowRuns } = await import('./workflowRunListActions');
const { WorkflowActionError } = await import('./workflowActionError');
const { workflowRunStoreKey, workflowRunListWindowStoreKey } = await import('@/sync/store/domains/workflowRuns');
const route = '/v3/automations/runs/workflow-storage';
const accountId = 'run-list-owner';
const run = createWorkflowRunSummaryFixture({ id: 'run-1', ownerAccountId: accountId });
let serverId: string;
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();

beforeEach(async () => {
    previous = storage.getState();
    applied = getAppliedActiveServerSnapshot();
    available = isAppliedActiveServerRuntimeAvailable();
    await home.reset();
    serverId = await home.addHome({ name: 'Run Home', serverUrl: 'https://workflow-run-list.test', accountId });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId, accountId } });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    home.answer(serverId, route, { body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } });
});
afterEach(async () => {
    (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    await home.reset(); storage.setState(previous); publishAppliedActiveServerSnapshot(applied, available);
});

async function runPage(metadata?: { title: string }) {
    const materialized = await materializeWorkflowAcceptedSnapshotV1({
        definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Continue', references: [], attachments: [] } }] }),
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
        context: { source: { kind: 'automation', automationId: 'automation-1' }, inputs: {}, machineId: run.machineId, executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
            actionCaller: { kind: 'automationRun', runId: run.id, automationId: 'automation-1', cause: { kind: 'manual', invokedAt: 1 } },
            authorization: { principal: { kind: 'host' } }, ...(metadata ? { metadata } : {}) },
    });
    if (!materialized.ok) throw new Error(`fixture_materialization_failed:${materialized.error.code}`);
    const envelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: run.id }, acceptedSnapshot: materialized.snapshot }));
    const census = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: accountId,
        access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
        ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    return { runs: [run], acceptedEnvelopesByRunId: { [run.id]: envelope }, keyCensusByRunId: { [run.id]: census } };
}

function requests() {
    return home.requestsFor(route).map(({ input }) => input && typeof input === 'object' && 'request' in input ? input.request : null);
}

describe('workflow Run list Action client through the Account storage transport', () => {
    it.each(['exhausted burst', 'non-exhausted burst', 'active removal'] as const)(
        'authoritatively refreshes the loaded full-window frontier: %s', async (scenario) => {
            const { Dimensions } = await import('react-native');
            const { vi } = await import('vitest');
            const { refreshRunWindow, loadMoreRunWindow } = await import('@/components/workflows/library/workflowLibraryReads');
            const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1200, height: 2 * HAPPIER_COLLECTION_ROW_METRICS.height.compact, scale: 1, fontScale: 1 });
            storage.setState({ workflowRunsById: {}, workflowRunListWindows: {} });
            const windowId = scenario === 'active removal' ? 'active' : 'all';
            const storeId = workflowRunListWindowStoreKey(windowId, { serverId, accountId });
            try {
                const original = Array.from({ length: scenario === 'non-exhausted burst' ? 9 : 5 }, (_, index) => createWorkflowRunSummaryFixture({
                    id: `frontier-${index}`, ownerAccountId: accountId, origin: { kind: 'direct' }, state: 'running',
                    createdAt: new Date(Date.UTC(2026, 8, 8) - index * 1000).toISOString(),
                }));
                const additions = Array.from({ length: 3 }, (_, index) => createWorkflowRunSummaryFixture({
                    id: `burst-${index}`, ownerAccountId: accountId, origin: { kind: 'direct' }, state: 'running',
                    createdAt: new Date(Date.UTC(2026, 8, 8) + (3 - index) * 1000).toISOString(),
                }));
                const corpus = await createWorkflowRunListStorageFixture({ runs: [...additions, ...original],
                    definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait',
                        document: { text: 'Private frontier context', references: [], attachments: [] } }] }),
                    metadata: { title: 'Private frontier title' },
                });
                let current = original;
                home.answer(serverId, route, { select: input => {
                    if (!input || typeof input !== 'object' || !('request' in input)) throw new Error('Unexpected storage request');
                    const request = WorkflowRunListRequestV1Schema.parse(input.request);
                    const start = request.cursor ? current.findIndex(row => row.id === request.cursor) + 1 : 0;
                    const selected = current.slice(start, start + (request.limit ?? current.length));
                    return { body: { runs: selected,
                        acceptedEnvelopesByRunId: Object.fromEntries(selected.map(row => [row.id, corpus.acceptedEnvelopesByRunId[row.id]])),
                        keyCensusByRunId: Object.fromEntries(selected.map(row => [row.id, corpus.keyCensusByRunId[row.id]])),
                        ...(start + selected.length < current.length ? { nextCursor: selected.at(-1)!.id } : {}),
                    } };
                } });
                await refreshRunWindow(windowId);
                await loadMoreRunWindow(windowId);
                if (scenario !== 'non-exhausted burst') {
                    while (storage.getState().workflowRunListWindows[storeId]?.nextCursor) await loadMoreRunWindow(windowId);
                }
                expect(storage.getState().workflowRunListWindows[storeId]?.runIds).toEqual(
                    (scenario === 'non-exhausted burst' ? original.slice(0, 4) : original).map(row => row.id));
                current = scenario === 'active removal' ? original.filter(row => row.id !== 'frontier-3') : [...additions, ...original];
                await refreshRunWindow(windowId, true);
                const refreshed = storage.getState().workflowRunListWindows[storeId]!;
                expect(refreshed.runIds).toEqual((scenario === 'non-exhausted burst' ? current.slice(0, 8) : current).map(row => row.id));
                expect(refreshed.nextCursor !== null).toBe(scenario === 'non-exhausted burst');
                while (storage.getState().workflowRunListWindows[storeId]?.nextCursor) await loadMoreRunWindow(windowId);
                expect(storage.getState().workflowRunListWindows[storeId]?.runIds).toEqual(current.map(row => row.id));
                for (const row of current) {
                    expect(storage.getState().workflowRunsById[workflowRunStoreKey(row.id)]).toMatchObject({
                        metadata: { kind: 'available', value: { title: 'Private frontier title' } },
                        summary: { startedBy: 'user', where: { directory: '/repo' } }, callerAccess: { canEdit: true },
                    });
                }
            } finally { viewport.mockRestore(); }
        });

    it.each([
        // The page is one window height of the shared compact collection row (ad1375872f).
        { rows: 10, expectedPages: [10, 10, 10, 7] },
        { rows: 20, expectedPages: [20, 17] },
    ])('requests one visible full-row page and reaches the complete large corpus on demand ($rows rows)', async ({ rows, expectedPages }) => {
        const height = rows * HAPPIER_COLLECTION_ROW_METRICS.height.compact;
        const { Dimensions } = await import('react-native');
        const { vi } = await import('vitest');
        const { readRunWindowPage } = await import('@/components/workflows/library/workflowLibraryReads');
        const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1200, height, scale: 1, fontScale: 1 });
        try {
            const runs = Array.from({ length: 37 }, (_, index) => createWorkflowRunSummaryFixture({
                id: `viewport-run-${index}`, ownerAccountId: accountId, origin: { kind: 'direct' },
                createdAt: new Date(Date.UTC(2026, 8, 8) - index * 1000).toISOString(),
            }));
            const corpus = await createWorkflowRunListStorageFixture({ runs,
                definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait',
                    document: { text: 'Accepted private context. '.repeat(8000), references: [], attachments: [] } }] }),
                metadata: { title: 'Private accepted title' },
            });
            const transfers: { rows: number; bytes: number }[] = [];
            home.answer(serverId, route, { select: input => {
                if (!input || typeof input !== 'object' || !('operation' in input) || input.operation !== 'list' || !('request' in input)) {
                    throw new Error('Unexpected Workflow storage operation');
                }
                const request = WorkflowRunListRequestV1Schema.parse(input.request);
                const start = request.cursor ? runs.findIndex(run => run.id === request.cursor) + 1 : 0;
                const selected = runs.slice(start, start + (request.limit ?? runs.length));
                const body = { runs: selected,
                    acceptedEnvelopesByRunId: Object.fromEntries(selected.map(run => [run.id, corpus.acceptedEnvelopesByRunId[run.id]])),
                    keyCensusByRunId: Object.fromEntries(selected.map(run => [run.id, corpus.keyCensusByRunId[run.id]])),
                    ...(start + selected.length < runs.length ? { nextCursor: selected.at(-1)!.id } : {}),
                };
                transfers.push({ rows: selected.length, bytes: Buffer.byteLength(JSON.stringify(body)) });
                return { body };
            } });
            let page = await readRunWindowPage('all');
            expect(page.runs).toHaveLength(expectedPages[0]!);
            const received = [...page.runs];
            const metadata = { ...page.metadataByRunId };
            const callerAccess = { ...page.callerAccessByRunId };
            while (page.nextCursor) {
                page = await readRunWindowPage('all', page.nextCursor);
                received.push(...page.runs);
                Object.assign(metadata, page.metadataByRunId);
                Object.assign(callerAccess, page.callerAccessByRunId);
            }
            expect(received.map(run => run.id)).toEqual(runs.map(run => run.id));
            expect(transfers.map(page => page.rows)).toEqual(expectedPages);
            for (const run of received) {
                expect(metadata[run.id]).toEqual({ kind: 'available', value: { title: 'Private accepted title' } });
                expect(run.where).toMatchObject({ machineId: run.machineId, directory: '/repo' });
                expect(run.startedBy).toBe('user');
                expect(callerAccess[run.id]).toEqual({ canEdit: true });
            }
        } finally { viewport.mockRestore(); }
    });

    it('uses Automation history and active Session destinations in the paged reader', async () => {
        await listWorkflowRuns({ filter: buildWorkflowRunListFilter('automation:habit') });
        await listWorkflowRuns({ filter: buildWorkflowRunListFilter('destination:session-one') });
        expect(requests()).toEqual([{ automationId: 'habit' }, { targetSessionId: 'session-one',
            states: ['queued', 'claimed', 'running', 'pause_requested', 'paused', 'interrupted'] }]);
    });

    it('reads a requested page and preserves the producer continuation', async () => {
        home.answer(serverId, route, { body: { ...await runPage(), nextCursor: 'cursor-2' } });
        const page = await listWorkflowRuns({ cursor: 'cursor-1', limit: 20 });
        expect(requests()).toEqual([{ cursor: 'cursor-1', limit: 20 }]);
        expect(page.runs[0]?.id).toBe(run.id);
        expect(page.nextCursor).toBe('cursor-2');
    });

    it('projects readable authored metadata and leaves unnamed opened content readable', async () => {
        home.answer(serverId, route, { body: await runPage({ title: 'Review 500 files' }) });
        expect((await listWorkflowRuns()).metadataByRunId).toEqual({ [run.id]: { kind: 'available', value: { title: 'Review 500 files' } } });
        home.answer(serverId, route, { body: await runPage() });
        expect((await listWorkflowRuns()).metadataByRunId).toEqual({ [run.id]: null });
    });

    it('keeps unopened accepted content unavailable with a typed reason', async () => {
        const page = await runPage();
        home.answer(serverId, route, { body: { ...page, acceptedEnvelopesByRunId: {} } });
        expect((await listWorkflowRuns()).metadataByRunId).toEqual({ [run.id]: { kind: 'unavailable', reason: 'content_unavailable' } });
    });

    it('rejects an incomplete storage response without its accepted-content map', async () => {
        home.answer(serverId, route, { body: { runs: [run] } });
        await expect(listWorkflowRuns()).rejects.toThrow();
    });

    it('asks the authoritative storage owner for attention rather than scanning a cached page', async () => {
        await listWorkflowRuns({ filter: buildWorkflowRunListFilter('attention') });
        expect(requests()).toEqual([{ attention: 'required' }]);
    });

    it('preserves the closed access-denied code as the canonical WorkflowActionError', async () => {
        home.answer(serverId, route, { status: 403, body: { error: 'run_access_denied' } });
        const failure = await listWorkflowRuns().then(() => null, (error: unknown) => error);
        expect(failure).toBeInstanceOf(WorkflowActionError);
        expect((failure as InstanceType<typeof WorkflowActionError>).code).toBe('run_access_denied');
        expect((failure as Error).message).toBe('run_access_denied');
    });

    it('keeps a front-door policy refusal outside the closed workflow error vocabulary', async () => {
        const actionsSettingsV1 = normalizeActionsSettingsV1({ v: 1, actions: { 'workflow.run.list': { enabled: false } } });
        home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1 } }, version: 1 } });
        const failure = await listWorkflowRuns().then(() => null, (error: unknown) => error);
        expect(failure).toBeInstanceOf(WorkflowActionError);
        expect((failure as InstanceType<typeof WorkflowActionError>).code).toBeNull();
        expect((failure as InstanceType<typeof WorkflowActionError>).rawCode).toBe('action_disabled');
        expect(home.requestsFor(route)).toEqual([]);
    });

    it('rejects malformed Run summaries before handing them to a screen', async () => {
        home.answer(serverId, route, { body: { runs: [{ id: run.id }], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } });
        await expect(listWorkflowRuns()).rejects.toThrow();
    });

    it('maps Active onto canonical nonterminal states only', () => {
        const active = buildWorkflowRunListFilter('active');
        expect(active.states).toBeDefined();
        expect(active.states).not.toContain('succeeded');
        expect(active.states).not.toContain('cancelled');
        expect(buildWorkflowRunListFilter('all')).toEqual({});
        expect(buildWorkflowRunListFilter('under:lead')).toEqual({ underSessionId: 'lead' });
    });
});
