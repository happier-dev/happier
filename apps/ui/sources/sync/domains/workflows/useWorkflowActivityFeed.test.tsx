import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';

// Only the external socket and HTTP transports are substituted.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
await initializeRealAppRuntimeForTests();
afterEach(standardCleanup);

it('shares the source-bound frame across two presented hosts and withdraws the last demand', async () => {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://workflow-activity-hosts.test' });
    let reads = 0;
    let unavailable = false;
    const first = createWorkflowRunSummaryFixture({ id: 'first-run' });
    const second = createWorkflowRunSummaryFixture({ id: 'second-run' });
    const boundary = await installWorkflowActionHttpBoundary({ accountId: () => 'activity-host-account',
        fixtureResponse: async (id, input) => {
            if (id !== 'workflow.run.list') throw new Error(`Unexpected activity read: ${id}`);
            reads++;
            if (unavailable) throw new Error('fixture transport unavailable');
            return { ok: true, result: { runs: input.cursor ? [second] : [first],
                metadataByRunId: {}, projection: 'membership', ...(input.cursor ? {} : { nextCursor: 'second-page' }) } };
        } });
    try {
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await restoreConnectionToActiveServer(boundary.credentials);
        boundary.prime();
        const { sync } = await import('@/sync/sync');
        expect(await sync.awaitBootstrapForegroundAcquisition()).toBe(true);
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const { useWorkflowActivityFeed } = await import('./useWorkflowActivityFeed');
        const { getWorkflowActivitySource } = await import('@/sync/engine/workflows/workflowActivitySource');
        const source = getWorkflowActivitySource(lifetime)!;
        expect(getWorkflowActivitySource(null)).toBeNull();
        const column = await renderHook((props: { active: boolean }) => useWorkflowActivityFeed({ lifetime, active: props.active }),
            { initialProps: { active: false } });
        const companion = await renderHook((props: { active: boolean }) => useWorkflowActivityFeed({ lifetime, active: props.active }),
            { initialProps: { active: false } });
        expect(reads).toBe(0);
        expect(source.hasDemand()).toBe(false);
        await column.rerender({ active: true });
        await companion.rerender({ active: true });
        await vi.waitFor(() => expect(column.getCurrent().retained).not.toBeNull());
        expect(reads).toBe(1);
        expect(column.getCurrent().projection).toBe(companion.getCurrent().projection);
        expect(column.getCurrent().retained).toBe(companion.getCurrent().retained);
        expect(column.getCurrent().listeningSince).not.toBeNull();
        await act(async () => { await Promise.all([column.getCurrent().loadMore(), companion.getCurrent().loadMore()]); });
        expect(reads).toBe(2);
        expect(column.getCurrent().retained?.runs.map(run => run.id)).toEqual(['first-run', 'second-run']);
        expect(column.getCurrent().retained).toBe(companion.getCurrent().retained);
        await act(async () => { storage.getState().setSocketStatus('disconnected'); });
        expect(column.getCurrent().status).toBe('offline');
        expect(column.getCurrent().retained?.runs).toHaveLength(2);
        await act(async () => { storage.getState().setSocketStatus('connected'); });
        unavailable = true;
        await act(async () => { await column.getCurrent().retry().catch(() => {}); });
        await vi.waitFor(() => expect(companion.getCurrent().status).toBe('failed'));
        expect(companion.getCurrent().retained?.runs).toHaveLength(2);
        unavailable = false;
        await act(async () => { await companion.getCurrent().retry(); });
        await vi.waitFor(() => expect(companion.getCurrent().status).toBe('live'));
        await act(async () => {
            const now = Date.now();
            storage.getState().applySessions([createSessionFixture({ id: 'arrived', seq: 2, createdAt: now, updatedAt: now })]);
            const { socketApplyFrame } = await import('@/sync/engine/sessions/socketApplyFrame');
            socketApplyFrame.flushNow();
        });
        const keys = column.getCurrent().keys;
        expect(keys).toHaveLength(1);
        expect(companion.getCurrent().keys).toBe(keys);
        expect(column.getCurrent().projection.getRow(keys[0]!)).toMatchObject({ kind: 'session', sessionId: 'arrived' });
        await column.rerender({ active: false });
        expect(source.hasDemand()).toBe(true);
        const hiddenKeys = column.getCurrent().keys;
        await act(async () => {
            const now = Date.now();
            storage.getState().applySessions([createSessionFixture({ id: 'second', seq: 3, createdAt: now, updatedAt: now })]);
            (await import('@/sync/engine/sessions/socketApplyFrame')).socketApplyFrame.flushNow();
        });
        expect(column.getCurrent().keys).toBe(hiddenKeys);
        expect(companion.getCurrent().keys).toHaveLength(2);
        const observedProjection = companion.getCurrent().projection;
        const observedKeys = observedProjection.getKeys();
        await companion.rerender({ active: false });
        expect(source.hasDemand()).toBe(false);
        expect(column.getCurrent().keys).toEqual([]);
        expect(observedProjection.getKeys()).toBe(observedKeys);
        const count = reads;
        await act(async () => { await companion.getCurrent().retry(); });
        expect(reads).toBe(count);
        await column.rerender({ active: true });
        await vi.waitFor(() => expect(column.getCurrent().retained).not.toBeNull());
        expect(column.getCurrent().keys).toBe(observedKeys);
        expect(column.getCurrent().getRow(keys[0]!)).toMatchObject({ kind: 'session', sessionId: 'arrived' });
        expect(source.hasDemand()).toBe(true);
        await column.rerender({ active: false });
        expect(source.hasDemand()).toBe(false);
        expect(column.getCurrent().retained).toBeNull();
        const retiredReads = reads;
        await act(async () => {
            const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
            await disconnectActiveServerConnection();
        });
        expect(source.hasDemand()).toBe(false);
        expect(reads).toBe(retiredReads);
        expect(observedProjection.getKeys()).toEqual([]);
        expect(column.getCurrent().keys).toEqual([]);
        expect(column.getCurrent().retained).toBeNull();
        await column.unmount();
        await companion.unmount();
    } finally { await boundary.dispose(); }
});

it('keeps the selected live Event available when the sole list host hands off to its detail host', async () => {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://workflow-activity-handoff.test' });
    const boundary = await installWorkflowActionHttpBoundary({ accountId: () => 'activity-handoff-account',
        fixtureResponse: async id => {
            if (id !== 'workflow.run.list') throw new Error(`Unexpected activity read: ${id}`);
            return { ok: true, result: { runs: [], metadataByRunId: {}, projection: 'membership' } };
        } });
    try {
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await restoreConnectionToActiveServer(boundary.credentials);
        boundary.prime();
        const { sync } = await import('@/sync/sync');
        expect(await sync.awaitBootstrapForegroundAcquisition()).toBe(true);
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const { useWorkflowActivityFeed } = await import('./useWorkflowActivityFeed');
        const hosts = await renderHook((props: { detail: boolean }) => ({
            list: useWorkflowActivityFeed({ lifetime, active: !props.detail }),
            detail: useWorkflowActivityFeed({ lifetime, active: props.detail }),
        }), { initialProps: { detail: false } });
        await vi.waitFor(() => expect(hosts.getCurrent().list.retained).not.toBeNull());
        await act(async () => {
            const now = Date.now();
            storage.getState().applySessions([createSessionFixture({ id: 'selected-event-session', seq: 2, createdAt: now, updatedAt: now })]);
            (await import('@/sync/engine/sessions/socketApplyFrame')).socketApplyFrame.flushNow();
        });
        const [selectedKey] = hosts.getCurrent().list.keys;
        expect(selectedKey).toBeDefined();
        expect(hosts.getCurrent().list.getRow(selectedKey!)).toMatchObject({ kind: 'session', sessionId: 'selected-event-session' });

        await hosts.rerender({ detail: true });

        expect(hosts.getCurrent().detail.getRow(selectedKey!)).toMatchObject({ kind: 'session', sessionId: 'selected-event-session' });
        await hosts.unmount();
    } finally { await boundary.dispose(); }
});
