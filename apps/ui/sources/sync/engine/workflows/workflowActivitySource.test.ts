import { afterEach, expect, it, vi } from 'vitest';
// The socket and HTTP adapters are the only substituted system boundaries.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import type { WorkflowActivityLiveFact } from '@/sync/domains/workflows/workflowActivityTypes';
import { WorkflowRunListResultV1Schema, type WorkflowRunListResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { AutomationRunCauseSchema } from '@happier-dev/protocol/automations/automationRunCause';
import { deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { createWorkflowActivityProjection } from './workflowActivityProjection';
import { createSocketApplyFrameScheduler } from '../sessions/socketApplyFrame';

await initializeRealAppRuntimeForTests();
let boundary: Awaited<ReturnType<typeof installWorkflowActionHttpBoundary>> | null = null;
const releases: (() => void)[] = [];
afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await boundary?.dispose();
    boundary = null;
    vi.restoreAllMocks();
});

it('opens cold Event Run names in one lean batch, including the exact Workflow cause outside the membership page', async () => {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://workflow-activity-names.test' });
    const sourceRun = createWorkflowRunSummaryFixture({ id: 'source-workflow', ownerAccountId: 'event-names-account' });
    const evidence = [
        { v: 1, kind: 'runLifecycle', occurredAt: Date.now(), source: { kind: 'workflow_run', runId: sourceRun.id },
            condition: 'terminal', sourceRevision: 2 },
        { v: 1, kind: 'runLifecycle', occurredAt: Date.now(), source: { kind: 'execution_run', machineId: 'source-machine', runId: 'run-native' },
            condition: 'needs_attention', sourceRevision: 3 },
    ] as const;
    const children = evidence.map((fact, index) => {
        const triggerId = `source-trigger-${index}`;
        const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'runLifecycle', triggerId,
            triggerRevision: 1, occurredAt: fact.occurredAt, occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence: fact }),
            evidence: { source: fact.source, condition: fact.condition, sourceRevision: fact.sourceRevision } });
        return createWorkflowRunSummaryFixture({ id: `child-${index}`, ownerAccountId: 'event-names-account',
            origin: { kind: 'automation', automationId: `automation-${index}`, cause } });
    });
    const namedRuns = [...children, sourceRun];
    const titleByRunId = new Map(namedRuns.map((run, index) => [run.id, `Accepted work ${index}`]));
    const leanReads: Record<string, unknown>[] = [];
    let membershipReads = 0;
    boundary = await installWorkflowActionHttpBoundary({ accountId: () => 'event-names-account',
        fixtureResponse: async (actionId, input) => {
            // The real activity Action delegates to the existing public membership list owner.
            if (actionId !== 'workflow.run.list') throw new Error(`Unexpected full-body Event read: ${actionId}`);
            if (input.projection === 'membership') {
                membershipReads += 1;
                return { ok: true, result: { runs: children, metadataByRunId: {}, projection: 'membership' } };
            }
            leanReads.push(input);
            return { ok: true, result: { runs: namedRuns,
                metadataByRunId: Object.fromEntries(namedRuns.map(run => [run.id,
                    { kind: 'available', value: { title: titleByRunId.get(run.id)! } }])) } };
        } });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer(boundary.credentials);
    boundary.prime();
    const { sync } = await import('@/sync/sync');
    expect(await sync.awaitBootstrapForegroundAcquisition()).toBe(true);
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { workflowRunStoreKey } = await import('@/sync/store/domains/workflowRuns');
    const scope = getActiveServerAccountScope()!;
    expect(storage.getState().workflowRunsById[workflowRunStoreKey(sourceRun.id, scope)]).toBeUndefined();
    const { getWorkflowActivitySource } = await import('./workflowActivitySource');
    const source = getWorkflowActivitySource()!;
    const pages: WorkflowRunListResultV1[] = [];
    const errors: unknown[] = [];
    const release = source.acquire({ onLive() {}, onRetained: page => pages.push(page), onError: error => errors.push(error) });
    const secondRelease = source.acquire({ onLive() {}, onRetained() {}, onError: error => errors.push(error) });
    releases.push(release, secondRelease);
    await vi.waitFor(() => expect(pages).toHaveLength(1), { timeout: 10_000 });
    expect(pages[0]?.runs.map(run => run.id).sort()).toEqual(children.map(run => run.id).sort());
    await vi.waitFor(() => {
        expect(errors).toEqual([]);
        expect(namedRuns.map(run => {
            const metadata = storage.getState().workflowRunsById[workflowRunStoreKey(run.id, scope)]?.metadata;
            return metadata?.kind === 'available' ? metadata.value.title : metadata;
        })).toEqual(namedRuns.map(run => titleByRunId.get(run.id)));
    }, { timeout: 10_000 });
    expect(membershipReads).toBe(1);
    expect(leanReads).toHaveLength(1);
    expect(leanReads[0]?.runIds).toEqual(expect.arrayContaining(namedRuns.map(run => run.id)));
    expect(leanReads[0]?.runIds).toHaveLength(namedRuns.length);
    expect(leanReads[0]?.runIds).not.toContain('run-native');
    release(); secondRelease();
    await source.retry(); await source.loadMore();
    expect(leanReads).toHaveLength(1);
});

it('shares acquisition across hosts, publishes only changed facts and releases the final demand', async () => {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://workflow-activity-cost.test' });
    let reads = 0;
    const baselineRun = createWorkflowRunSummaryFixture({ id: 'baseline-run', ownerAccountId: 'activity-account', createdAt: '2026-01-01T00:00:00.000Z' });
    const continuationRun = createWorkflowRunSummaryFixture({ id: 'continued-run', ownerAccountId: 'activity-account', createdAt: '2025-12-01T00:00:00.000Z' });
    const middleRun = createWorkflowRunSummaryFixture({ id: 'new-middle-run', ownerAccountId: 'activity-account', createdAt: '2025-12-15T00:00:00.000Z' });
    const baselinePage = { runs: [baselineRun], metadataByRunId: {}, projection: 'membership' as const, nextCursor: 'older-runs' };
    boundary = await installWorkflowActionHttpBoundary({ accountId: () => 'activity-account',
        fixtureResponse: async (id, input) => {
            if (id !== 'workflow.run.list') throw new Error(`Unexpected activity HTTP read: ${id}`);
            if (input.projection !== 'membership') {
                const requestedRunIds = input.runIds;
                if (!Array.isArray(requestedRunIds) || requestedRunIds.length === 0) throw new Error('Expected an exact lean name read');
                return { ok: true, result: { runs: [baselineRun, continuationRun, middleRun]
                    .filter(run => requestedRunIds.includes(run.id)), metadataByRunId: {} } };
            }
            reads += 1;
            return { ok: true, result: input.cursor === 'new-middle-runs'
                ? { runs: [middleRun], metadataByRunId: {}, projection: 'membership', nextCursor: 'older-runs' }
                : input.cursor
                ? { runs: [continuationRun], metadataByRunId: {}, projection: 'membership' }
                : baselinePage };
        } });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer(boundary.credentials);
    boundary.prime();
    const { sync } = await import('@/sync/sync');
    expect(await sync.awaitBootstrapForegroundAcquisition()).toBe(true);
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    const scope = getActiveServerAccountScope()!;
    const machine = createMachineFixture({ id: 'activity-machine', active: true, activeAt: Date.now() });
    await publishMachineInventoryForTest(scope, [machine]);
    storage.getState().applySessions([createSessionFixture({ id: 'baseline', createdAt: 1 })]);
    const { getWorkflowActivitySource } = await import('./workflowActivitySource');
    const source = getWorkflowActivitySource()!;
    expect(source.hasDemand()).toBe(false);
    expect(reads).toBe(0);
    expect(await source.readPage()).toEqual(baselinePage);
    reads = 0;
    let activeSubscriptions = 0;
    const track = <Args extends unknown[]>(subscribe: (...args: Args) => () => void) => (...args: Args) => {
        const dispose = subscribe(...args);
        activeSubscriptions += 1;
        let active = true;
        return () => { if (active) { active = false; activeSubscriptions -= 1; dispose(); } };
    };
    // Call-through measurement keeps the real subscription owners and their delivery logic.
    const subscribeStorage = storage.subscribe.bind(storage);
    vi.spyOn(storage, 'subscribe').mockImplementation(track(subscribeStorage));
    const machineUpdates = await import('@/sync/store/domains/machines');
    const subscribeMachines = machineUpdates.subscribeMachineUpdates;
    vi.spyOn(machineUpdates, 'subscribeMachineUpdates').mockImplementation(track(subscribeMachines));
    const accountChanges = await import('@/sync/runtime/orchestration/homeAccountChange');
    const subscribeRuns = accountChanges.subscribeHomeAccountChange;
    vi.spyOn(accountChanges, 'subscribeHomeAccountChange').mockImplementation(track(subscribeRuns));
    const column: WorkflowActivityLiveFact[] = [];
    const companion: WorkflowActivityLiveFact[] = [];
    const pages: WorkflowRunListResultV1[] = [];
    const errors: unknown[] = [];
    const columnRelease = source.acquire({ onLive: rows => column.push(...rows), onRetained: page => pages.push(page), onError: error => errors.push(error) });
    const firstHostSubscriptions = activeSubscriptions;
    const companionRelease = source.acquire({ onLive: rows => companion.push(...rows), onRetained: page => pages.push(page), onError: error => errors.push(error) });
    releases.push(columnRelease, companionRelease);
    expect(source.hasDemand()).toBe(true);
    expect(firstHostSubscriptions).toBeGreaterThan(0);
    expect(activeSubscriptions).toBe(firstHostSubscriptions);
    await vi.waitFor(() => { expect(errors).toEqual([]); expect(pages).toHaveLength(2); }, { timeout: 10_000 });
    expect(pages[0]).toBe(pages[1]);
    expect(reads).toBe(1);
    expect(column).toEqual([]);
    await source.retry();
    expect(reads).toBe(2);
    expect(pages).toHaveLength(2);
    const session = createSessionFixture({ id: 'arrived', seq: 2, createdAt: Date.now(), updatedAt: Date.now() });
    storage.getState().applySessions([session]);
    storage.getState().applySessions([session]);
    storage.getState().applySessions([{ ...session, latestTurnId: 'real-control-turn', latestTurnStatus: 'in_progress',
        latestTurnStatusObservedAt: Date.now() }]);
    expect(column.filter(row => row.kind === 'session').map(row => row.event)).toEqual(['started', 'turn_started']);
    const run = createWorkflowRunSummaryFixture({ id: 'arriving-attention', ownerAccountId: 'activity-account', updatedAt: new Date().toISOString(),
        // The shared row may carry opened detail; activity publishes public membership only.
        heldStep: null, where: null, startedBy: null, stepProgress: null, stepProgressCurrentness: null });
    const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run, null)], scope);
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const notify = () => publishHomeAccountChange(scope.serverId, [`workflow-run:${run.id}`], { workflowRunsMaterialized: true });
    notify(); notify();
    expect(pages).toHaveLength(4);
    expect(pages[2]).toBe(pages[3]);
    expect(pages[2]?.runs.map(row => row.id)).toEqual([run.id, baselineRun.id]);
    expect(pages[2]?.runs[1]).toBe(pages[0]?.runs[0]);
    expect(pages[2]?.nextCursor).toBe(baselinePage.nextCursor);
    expect(WorkflowRunListResultV1Schema.safeParse(pages[2]).success).toBe(true);
    expect(column.filter(row => row.kind === 'run')).toEqual([]);
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary({ ...run, revision: 2,
        attentionRequired: true, invocationAttentionRequired: true }, null)], scope);
    notify(); notify();
    expect(pages).toHaveLength(6);
    expect(pages[4]).toBe(pages[5]);
    expect(pages[4]?.runs[0]?.revision).toBe(2);
    expect(column.filter(row => row.kind === 'run' && row.event === 'needs_attention')).toHaveLength(1);
    const observed = column.filter(row => row.kind === 'run' && row.event === 'needs_attention');
    const evidence = { v: 1, kind: 'runLifecycle', source: { kind: 'workflow_run', runId: run.id },
        condition: 'needs_attention', sourceRevision: 2, occurredAt: Date.parse(run.updatedAt) } as const;
    const child = createWorkflowRunSummaryFixture({ id: 'attention-child', origin: { kind: 'automation', automationId: 'a1',
        cause: AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'runLifecycle', triggerId: 'attention-trigger',
            triggerRevision: 1, occurredAt: evidence.occurredAt,
            occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: 'attention-trigger', evidence }),
            evidence: { source: evidence.source, condition: evidence.condition, sourceRevision: evidence.sourceRevision } }) } });
    // RAF is the platform boundary; flush the real shared frame owner explicitly.
    const scheduler = createSocketApplyFrameScheduler({ requestFrame: () => () => {}, isPainting: () => true });
    const projection = createWorkflowActivityProjection(scheduler);
    projection.apply(observed);
    projection.applyRetained([child]);
    scheduler.flushNow();
    expect(projection.getKeys()).toHaveLength(1);
    expect(projection.getRow(projection.getKeys()[0]!)).toEqual(observed[0]);
    projection.dispose();
    const olderRun = createWorkflowRunSummaryFixture({ id: 'outside-loaded-page', ownerAccountId: 'activity-account', createdAt: '2025-01-01T00:00:00.000Z' });
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(olderRun)], scope);
    publishHomeAccountChange(scope.serverId, [`workflow-run:${olderRun.id}`], { workflowRunsMaterialized: true });
    expect(pages).toHaveLength(6);
    await source.loadMore();
    expect(pages).toHaveLength(8);
    expect(pages[6]?.runs.map(row => row.id)).toEqual([run.id, baselineRun.id, continuationRun.id]);
    expect(pages[6]?.nextCursor).toBeUndefined();
    // Fresh query continuation must expose new rows between already loaded pages.
    baselinePage.nextCursor = 'new-middle-runs';
    await source.retry();
    expect(pages).toHaveLength(10);
    expect(pages.at(-1)?.nextCursor).toBe('new-middle-runs');
    expect(reads).toBe(4);
    await source.loadMore();
    expect(pages).toHaveLength(12);
    expect(pages.at(-1)?.runs.map(row => row.id)).toEqual([run.id, baselineRun.id, middleRun.id, continuationRun.id]);
    await source.loadMore(); // The fresh cursor may revisit a loaded page without duplicating its rows.
    expect(pages).toHaveLength(14);
    expect(pages.at(-1)?.runs.map(row => row.id)).toEqual([run.id, baselineRun.id, middleRun.id, continuationRun.id]);
    await source.loadMore();
    expect(reads).toBe(6);
    storage.getState().removeWorkflowRun(continuationRun.id, scope);
    publishHomeAccountChange(scope.serverId, [`workflow-run:${continuationRun.id}`], { workflowRunsMaterialized: true });
    expect(pages).toHaveLength(16);
    expect(pages.at(-1)?.runs.map(row => row.id)).toEqual([run.id, baselineRun.id, middleRun.id]);
    storage.getState().removeWorkflowRun(run.id, scope);
    notify(); notify();
    expect(pages).toHaveLength(18);
    expect(pages[16]).toBe(pages[17]);
    expect(pages.at(-1)?.runs.map(row => row.id)).toEqual([baselineRun.id, middleRun.id]);
    await publishMachineInventoryForTest(scope, [{ ...machine, active: false, activeAt: Date.now() }]);
    expect(column.filter(row => row.kind === 'machine' && row.event === 'offline')).toHaveLength(1);
    expect(companion).toEqual(column);
    expect(companion.at(-1)).toBe(column.at(-1));
    expect(reads).toBe(6);
    columnRelease();
    expect(source.hasDemand()).toBe(true);
    companionRelease();
    expect(source.hasDemand()).toBe(false);
    expect(activeSubscriptions).toBe(0);
    const published = column.length;
    const retainedPublications = pages.length;
    storage.getState().applySessions([createSessionFixture({ id: 'closed', createdAt: Date.now() })]);
    await publishMachineInventoryForTest(scope, [machine]);
    notify();
    await source.retry();
    await source.loadMore();
    expect(column).toHaveLength(published);
    expect(companion).toHaveLength(published);
    expect(pages).toHaveLength(retainedPublications);
    expect(reads).toBe(6);
    const detailPages: WorkflowRunListResultV1[] = [];
    const detailFacts: WorkflowActivityLiveFact[] = [];
    const detailRelease = source.acquire({ onLive: rows => detailFacts.push(...rows), onRetained: page => detailPages.push(page) });
    releases.push(detailRelease);
    expect(detailPages).toEqual([pages.at(-1)]);
    expect(detailPages[0]).toBe(pages.at(-1));
    expect(detailPages[0]?.nextCursor).toBeUndefined();
    expect(activeSubscriptions).toBe(firstHostSubscriptions);
    await vi.waitFor(() => expect(reads).toBe(7));
    expect(detailFacts).toEqual([]);
    detailRelease();
    expect(activeSubscriptions).toBe(0);
});

it('hydrates durable Machine presence transitions on every admission and keeps listening start stable across remounts', async () => {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://workflow-activity-presence.test' });
    boundary = await installWorkflowActionHttpBoundary({ accountId: () => 'presence-account',
        fixtureResponse: async (actionId) => {
            if (actionId !== 'workflow.activity.list') throw new Error(`Unexpected activity HTTP read: ${actionId}`);
            return { ok: true, result: { retained: { runs: [], metadataByRunId: {}, projection: 'membership' },
                live: { kind: 'unavailable', reason: 'ui_local_only' } } };
        } });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer(boundary.credentials);
    boundary.prime();
    const { sync } = await import('@/sync/sync');
    expect(await sync.awaitBootstrapForegroundAcquisition()).toBe(true);
    const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    const scope = getActiveServerAccountScope()!;
    const machine = createMachineFixture({ id: 'presence-machine', active: true, activeAt: 20 });
    await publishMachineInventoryForTest(scope, [machine]);
    const access = await import('@/sync/api/machines/machineAccessApi');
    vi.spyOn(access, 'executeMachineAccessHttpAction').mockResolvedValue({ kind: 'present', machineId: machine.id,
        transitions: { v: 1, revision: 4, offline: { revision: 3, occurredAt: 10 }, online: { revision: 4, occurredAt: 20 } } });
    const { getWorkflowActivitySource } = await import('./workflowActivitySource');
    const source = getWorkflowActivitySource()!;
    const first: WorkflowActivityLiveFact[] = [];
    const release = source.acquire({ onLive: rows => first.push(...rows), onRetained() {} });
    releases.push(release);
    await vi.waitFor(() => expect(first.filter(row => row.kind === 'machine')).toHaveLength(2));
    const listeningSince = source.listeningSince();
    expect(listeningSince).not.toBeNull();
    release();
    expect(source.listeningSince()).toBe(listeningSince);
    const second: WorkflowActivityLiveFact[] = [];
    const remountRelease = source.acquire({ onLive: rows => second.push(...rows), onRetained() {} });
    releases.push(remountRelease);
    await vi.waitFor(() => expect(second.filter(row => row.kind === 'machine')).toHaveLength(2));
    expect(source.listeningSince()).toBe(listeningSince);
    expect(access.executeMachineAccessHttpAction).toHaveBeenCalledTimes(2);
});
