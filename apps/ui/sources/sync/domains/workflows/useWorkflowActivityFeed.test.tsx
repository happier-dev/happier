import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { AutomationRunCauseSchema } from '@happier-dev/protocol/automations/automationRunCause';
import { deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';

// Only the external socket and HTTP transports are substituted.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
await initializeRealAppRuntimeForTests();
afterEach(standardCleanup);

it('projects exact retained Run causes despite coalesced source revisions without inventing live history', async () => {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://workflow-activity-causes.test' });
    const children = [2, 3, 6, 7].map(sourceRevision => {
        const evidence = { v: 1, kind: 'runLifecycle', source: { kind: 'workflow_run', runId: sourceRevision < 6 ? 'terminal-source' : 'attention-source' },
            condition: sourceRevision < 6 ? 'terminal' : 'needs_attention', sourceRevision, occurredAt: sourceRevision * 100 } as const;
        const triggerId = `trigger-${sourceRevision}`;
        const createdAt = `2026-11-17T10:00:0${[7, 6, 2, 3].indexOf(sourceRevision)}.000Z`;
        return createWorkflowRunSummaryFixture({ id: `child-${sourceRevision}`, createdAt, origin: { kind: 'automation', automationId: 'a1',
            cause: AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'runLifecycle', triggerId, triggerRevision: 1,
                occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence }), occurredAt: evidence.occurredAt,
                evidence: { source: evidence.source, condition: evidence.condition, sourceRevision } }) } });
    });
    const latestSources = [createWorkflowRunSummaryFixture({ id: 'terminal-source', revision: 3, state: 'succeeded' }),
        createWorkflowRunSummaryFixture({ id: 'attention-source', revision: 7, attentionRequired: true })];
    const firstCause = children[0]!.origin.kind === 'automation' ? children[0]!.origin.cause : undefined;
    if (firstCause?.kind !== 'trigger' || firstCause.triggerKind !== 'runLifecycle') throw new Error('Missing lifecycle fixture');
    const secondTrigger = createWorkflowRunSummaryFixture({ id: 'child-2-second-trigger', createdAt: '2026-11-17T10:00:01.500Z',
        origin: { kind: 'automation', automationId: 'a2',
        cause: AutomationRunCauseSchema.parse({ ...firstCause, triggerId: 'another-trigger', occurrenceKey: deriveAutomationOccurrenceKeyV1({
            triggerId: 'another-trigger', evidence: { v: 1, kind: 'runLifecycle', occurredAt: firstCause.occurredAt, ...firstCause.evidence },
        }) }) } });
    let reads = 0;
    let refreshed = false;
    let removedChild = false;
    const fresh = createWorkflowRunSummaryFixture({ id: 'fresh-member', createdAt: '2026-11-17T10:00:06.000Z', origin: { kind: 'direct' } });
    const boundary = await installWorkflowActionHttpBoundary({ accountId: () => 'activity-cause-account', fixtureResponse: async (id, input) => {
        if (id !== 'workflow.run.list') throw new Error(`Unexpected activity read: ${id}`);
        if (input.projection !== 'membership') {
            const requestedRunIds = input.runIds;
            if (!Array.isArray(requestedRunIds) || requestedRunIds.length === 0) throw new Error('Expected an exact lean name read');
            return { ok: true, result: { runs: [...children, ...latestSources, secondTrigger, fresh]
                .filter(run => requestedRunIds.includes(run.id)), metadataByRunId: {} } };
        }
        reads++;
        return { ok: true, result: { runs: input.cursor ? children.slice(2).filter(run => !removedChild || run.id !== 'child-6')
            : [...(refreshed ? [fresh] : []), children[1], children[0], secondTrigger],
            metadataByRunId: {}, projection: 'membership', ...(input.cursor ? {} : { nextCursor: 'attention-causes' }) } };
    } });
    try {
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await restoreConnectionToActiveServer(boundary.credentials);
        boundary.prime();
        expect(await (await import('@/sync/sync')).sync.awaitBootstrapForegroundAcquisition()).toBe(true);
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
        storage.getState().upsertWorkflowRuns(latestSources.map(run => workflowRunRowFromSummary(run, null)), lifetime.scope);
        const { useWorkflowActivityFeed } = await import('./useWorkflowActivityFeed');
        const hosts = await renderHook((props: { presented: 'list' | 'detail' }) => ({
            column: useWorkflowActivityFeed({ lifetime, active: props.presented === 'list' }),
            companion: useWorkflowActivityFeed({ lifetime, active: props.presented === 'list' }),
            detail: useWorkflowActivityFeed({ lifetime, active: props.presented === 'detail' }),
        }), { initialProps: { presented: 'list' } });
        await vi.waitFor(() => expect(hosts.getCurrent().column.retained).not.toBeNull());
        await act(async () => { (await import('@/sync/engine/sessions/socketApplyFrame')).socketApplyFrame.flushNow(); });
        expect(hosts.getCurrent().column.keys).toHaveLength(2);
        await act(async () => { await hosts.getCurrent().column.loadMore();
            (await import('@/sync/engine/sessions/socketApplyFrame')).socketApplyFrame.flushNow(); });
        const feed = hosts.getCurrent().column;
        expect(feed.keys).toBe(hosts.getCurrent().companion.keys);
        expect(feed.keys.map(key => feed.getRow(key))).toEqual([7, 6, 3, 2].map(sourceRevision => expect.objectContaining({
            coverage: 'retained_cause', kind: 'run', sourceRevision, occurredAt: sourceRevision * 100,
            event: sourceRevision < 6 ? 'terminal' : 'needs_attention',
        })));
        const { readWorkflowEventStartedRuns } = await import('@/components/workflows/events/workflowEventFacts');
        for (const key of feed.keys) {
            const fact = feed.getRow(key)!;
            expect(fact).not.toHaveProperty('state');
            expect(readWorkflowEventStartedRuns(fact, feed.retained!.runs).map(run => run.id)).toEqual(fact.sourceRevision === 2
                ? ['child-2', 'child-2-second-trigger'] : [`child-${fact.sourceRevision}`]);
        }
        const { useWorkflowEventPresentation } = await import('@/components/workflows/events/useWorkflowEventPresentation');
        const selected = feed.getRow(feed.keys[0]!)!;
        const detail = await renderHook(() => useWorkflowEventPresentation(selected, lifetime.scope, feed.retained!.runs));
        expect(detail.getCurrent()?.lines.some(line => line.key === 'result')).toBe(false);
        expect(detail.getCurrent()?.runsStarted.map(run => run.id)).toEqual(['child-7']);
        expect(detail.getCurrent()?.fact).toMatchObject({ coverage: 'retained_cause', event: 'needs_attention', sourceRevision: 7 });
        await detail.unmount();
        const keys = feed.keys;
        refreshed = true;
        await act(async () => { await feed.retry();
            (await import('@/sync/engine/sessions/socketApplyFrame')).socketApplyFrame.flushNow(); });
        expect(hosts.getCurrent().column.keys).toBe(keys);
        expect(hosts.getCurrent().column.retained?.runs.map(run => run.id)).toEqual(expect.arrayContaining(['child-6', 'child-7']));
        expect(readWorkflowEventStartedRuns(selected, hosts.getCurrent().column.retained!.runs).map(run => run.id)).toEqual(['child-7']);
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        removedChild = true;
        await act(async () => {
            storage.getState().removeWorkflowRun('child-6', lifetime.scope);
            publishHomeAccountChange(lifetime.scope.serverId, ['workflow-run:child-6'], { workflowRunsMaterialized: true });
        });
        expect(hosts.getCurrent().column.retained?.runs.map(run => run.id)).not.toContain('child-6');
        expect(readWorkflowEventStartedRuns(selected, hosts.getCurrent().column.retained!.runs).map(run => run.id)).toEqual(['child-7']);
        expect(hosts.getCurrent().column.getRow(selected.key)).toBe(selected);
        expect(reads).toBe(3); // Initial page, continuation, explicit retry; pushed removal reads nothing.
        await act(async () => { await hosts.getCurrent().column.loadMore(); });
        expect(hosts.getCurrent().column.retained?.runs.map(run => run.id)).not.toContain('child-6');
        expect(reads).toBe(4); // A refreshed server cursor may traverse already known rows again.
        await act(async () => { await hosts.getCurrent().column.loadMore(); });
        expect(reads).toBe(4); // Exhausted paging reads nothing.
        await hosts.rerender({ presented: 'detail' });
        await vi.waitFor(() => expect(hosts.getCurrent().detail.retained).not.toBeNull());
        expect(hosts.getCurrent().detail.getRow(selected.key)).toBe(selected);
        expect(readWorkflowEventStartedRuns(selected, hosts.getCurrent().detail.retained!.runs).map(run => run.id)).toEqual(['child-7']);
        expect(hosts.getCurrent().detail.keys.map(key => hosts.getCurrent().detail.getRow(key)?.coverage)).not.toContain('live');
        await hosts.unmount();
    } finally { await boundary.dispose(); }
});

it('shares the source-bound frame across two presented hosts and withdraws the last demand', async () => {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://workflow-activity-hosts.test' });
    let reads = 0;
    let unavailable = false;
    const first = createWorkflowRunSummaryFixture({ id: 'first-run', createdAt: '2026-09-08T10:00:01.000Z',
        state: 'succeeded', finishedAt: '2026-09-08T10:00:02.000Z' });
    const second = createWorkflowRunSummaryFixture({ id: 'second-run' });
    const boundary = await installWorkflowActionHttpBoundary({ accountId: () => 'activity-host-account',
        fixtureResponse: async (id, input) => {
            if (id !== 'workflow.run.list') throw new Error(`Unexpected activity read: ${id}`);
            if (input.projection !== 'membership') {
                if (unavailable) throw new Error('fixture transport unavailable');
                const requestedRunIds = input.runIds;
                if (!Array.isArray(requestedRunIds) || requestedRunIds.length === 0) throw new Error('Expected an exact lean name read');
                return { ok: true, result: { runs: [first, second]
                    .filter(run => requestedRunIds.includes(run.id)), metadataByRunId: {} } };
            }
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
        await act(async () => { (await import('@/sync/engine/sessions/socketApplyFrame')).socketApplyFrame.flushNow(); });
        const [terminalKey] = column.getCurrent().keys;
        expect(column.getCurrent().getRow(terminalKey!)).toMatchObject({
            kind: 'run', event: 'terminal', runId: first.id, state: 'succeeded',
        });
        expect(companion.getCurrent().keys).toBe(column.getCurrent().keys);
        expect(column.getCurrent().projection).toBe(companion.getCurrent().projection);
        expect(column.getCurrent().retained).toBe(companion.getCurrent().retained);
        expect(column.getCurrent().listeningSince).not.toBeNull();
        const stableFeed = column.getCurrent();
        const listInputs = new Set([stableFeed]);
        for (let render = 0; render < 3; render += 1) {
            await column.rerender({ active: true });
            listInputs.add(column.getCurrent());
        }
        // The memoized Events list receives the feed as one prop.
        expect(listInputs.size).toBe(1);
        await act(async () => { await Promise.all([column.getCurrent().loadMore(), companion.getCurrent().loadMore()]); });
        expect(reads).toBe(2);
        expect(column.getCurrent().retained?.runs.map(run => run.id)).toEqual(['first-run', 'second-run']);
        expect(column.getCurrent().retained).toBe(companion.getCurrent().retained);
        expect(column.getCurrent()).not.toBe(stableFeed);
        await act(async () => { storage.getState().setSocketStatus('disconnected'); });
        expect(column.getCurrent().status).toBe('offline');
        expect(column.getCurrent().retained?.runs).toHaveLength(2);
        await act(async () => { storage.getState().setSocketStatus('connected'); });
        unavailable = true;
        await act(async () => { await column.getCurrent().retry().catch(() => {}); });
        await vi.waitFor(() => expect(companion.getCurrent().historyError).not.toBeNull());
        expect(companion.getCurrent().status).toBe('live');
        expect(companion.getCurrent().retained?.runs).toHaveLength(2);
        unavailable = false;
        await act(async () => { await companion.getCurrent().retry(); });
        await vi.waitFor(() => expect(companion.getCurrent().status).toBe('live'));
        expect(companion.getCurrent().historyError).toBeNull();
        await act(async () => {
            const now = Date.now();
            storage.getState().applySessions([createSessionFixture({ id: 'arrived', seq: 2, createdAt: now, updatedAt: now })]);
            const { socketApplyFrame } = await import('@/sync/engine/sessions/socketApplyFrame');
            socketApplyFrame.flushNow();
        });
        const keys = column.getCurrent().keys;
        expect(keys).toHaveLength(2);
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
        expect(companion.getCurrent().keys).toHaveLength(3);
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
