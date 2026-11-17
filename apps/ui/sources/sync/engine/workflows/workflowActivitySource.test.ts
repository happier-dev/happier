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

await initializeRealAppRuntimeForTests();
let boundary: Awaited<ReturnType<typeof installWorkflowActionHttpBoundary>> | null = null;
const releases: (() => void)[] = [];
afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await boundary?.dispose();
    boundary = null;
    vi.restoreAllMocks();
});

it('shares acquisition across hosts, publishes only changed facts and releases the final demand', async () => {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://workflow-activity-cost.test' });
    let reads = 0;
    boundary = await installWorkflowActionHttpBoundary({ accountId: () => 'activity-account',
        fixtureResponse: async (id) => {
            if (id !== 'workflow.run.list') throw new Error(`Unexpected activity HTTP read: ${id}`);
            reads += 1;
            return { ok: true, result: { runs: [], metadataByRunId: {}, projection: 'membership' } };
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
    expect(await source.readPage()).toEqual({ runs: [], metadataByRunId: {}, projection: 'membership' });
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
    const pages: unknown[] = [];
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
    expect(column.filter(row => row.kind === 'session')).toHaveLength(1);
    const run = createWorkflowRunSummaryFixture({ id: 'arriving-attention', attentionRequired: true,
        invocationAttentionRequired: true, updatedAt: new Date().toISOString() });
    const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
    storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run, null)], scope);
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const notify = () => publishHomeAccountChange(scope.serverId, [`workflow-run:${run.id}`], { workflowRunsMaterialized: true });
    notify(); notify();
    expect(column.filter(row => row.kind === 'run' && row.event === 'needs_attention')).toHaveLength(1);
    await publishMachineInventoryForTest(scope, [{ ...machine, active: false, activeAt: Date.now() }]);
    expect(column.filter(row => row.kind === 'machine' && row.event === 'offline')).toHaveLength(1);
    expect(companion).toEqual(column);
    expect(companion.at(-1)).toBe(column.at(-1));
    expect(reads).toBe(2);
    columnRelease();
    expect(source.hasDemand()).toBe(true);
    companionRelease();
    expect(source.hasDemand()).toBe(false);
    expect(activeSubscriptions).toBe(0);
    const published = column.length;
    storage.getState().applySessions([createSessionFixture({ id: 'closed', createdAt: Date.now() })]);
    await publishMachineInventoryForTest(scope, [machine]);
    notify();
    await source.retry();
    expect(column).toHaveLength(published);
    expect(companion).toHaveLength(published);
    expect(reads).toBe(2);
});
