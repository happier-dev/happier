import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createWorkflowAutomationLastRunSummaryFixture as lastRunSummary } from '@/dev/testkit/fixtures/workflowRunFixtures';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { resetWorkflowLibraryReadsForTests } = await import('./workflowLibraryReads');
const { useWorkflowLibrarySummaries, useWorkflowAutomationSummaries } = await import('./useWorkflowLibrarySummaries');
const { useSessionTriggerLastRuns } = await import('../triggers/useSessionTriggerLastRuns');

// These declarations script HTTP storage responses, never the Action executor.
const executeMock = vi.fn();
let serverId: string;
let previousState = storage.getState();
let previousApplied = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();
beforeEach(async () => {
    previousState = storage.getState();
    previousApplied = getAppliedActiveServerSnapshot();
    previousAvailable = isAppliedActiveServerRuntimeAvailable();
    await home.reset();
    serverId = await home.addHome({ name: 'Summaries Home', serverUrl: 'https://workflow-summaries-http.test', accountId: 'account-a' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' },
        isDataReady: true, machineListByServerId: {}, workflowRunsById: {}, workflowRunListWindows: {} });
    home.answer(serverId, '/v3/automations/runs/workflow-storage', { select: async input => {
        if (input && typeof input === 'object' && 'operation' in input && input.operation === 'list') {
            return { body: { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} } };
        }
        if (!input || typeof input !== 'object' || !('operation' in input) || input.operation !== 'summaries'
            || !('request' in input)) throw new Error('Expected a Workflow summaries storage request');
        const response = await executeMock('workflow.run.summaries', input.request);
        return { body: response.result };
    } });
});
afterEach(async () => {
    await standardCleanup();
    resetWorkflowLibraryReadsForTests();
    retireActiveServerAccountScopeLifetime();
    await home.reset();
    executeMock.mockReset();
    storage.setState(previousState);
    publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
});

describe('workflow library run summaries', () => {
    const sourceArtifactId = '00000000-0000-4000-8000-000000000001';
    const item = { sourceArtifactId, lastRun: null, recent: [], needsYouCount: 1, needsYouRunId: 'private-run-a' };
    const reply = { ok: true, result: { summaries: [item], remainingSourceArtifactIds: [] } };

    it('preserves opaque Automation ids containing the former demand delimiter', async () => {
        const automationId = 'habit\u0000x';
        executeMock.mockImplementation(async (_actionId, input) => ({ ok: true, result: {
            automationSummaries: input.automationIds.map((id: string) => ({ automationId: id, lastRun: null })),
            remainingAutomationIds: [],
        } }));
        const hook = await renderHook((props: { ids: readonly string[] }) => useWorkflowAutomationSummaries(props.ids), {
            initialProps: { ids: [automationId] },
        });
        await waitForHomeGovernance(() => expect(executeMock.mock.calls).toHaveLength(1));
        expect(executeMock.mock.calls[0]?.[1]).toEqual({ automationIds: [automationId] });
        await waitForHomeGovernance(() => expect(hook.getCurrent().summaries?.has(automationId)).toBe(true));
        expect(hook.getCurrent().summaries?.size).toBe(1);
        await hook.rerender({ ids: ['habit', 'x'] });
        await waitForHomeGovernance(() => expect(executeMock.mock.calls).toHaveLength(2));
        expect(executeMock.mock.calls[1]?.[1]).toEqual({ automationIds: ['habit', 'x'] });
        await waitForHomeGovernance(() => expect([...hook.getCurrent().summaries?.keys() ?? []]).toEqual(['habit', 'x']));
        await hook.rerender({ ids: [] });
        expect(hook.getCurrent().summaries?.size).toBe(0);
        expect(executeMock.mock.calls).toHaveLength(2);
    });

    it('batches trigger-only latest statuses without acquiring full Runs or private content', async () => {
        const automationIds = ['habit-b', 'habit-a', 'habit-empty'];
        const succeeded = lastRunSummary({ id: 'run-a', state: 'succeeded', createdAt: '2026-10-21T03:00:00.000Z' });
        const blocked = lastRunSummary({ id: 'run-b', state: 'running', attentionRequired: true, invocationAttentionRequired: true, createdAt: '2026-10-21T02:00:00.000Z' });
        executeMock.mockResolvedValue({ ok: true, result: { automationSummaries: [
            { automationId: 'habit-a', lastRun: succeeded }, { automationId: 'habit-b', lastRun: blocked },
            { automationId: 'habit-empty', lastRun: null },
        ], remainingAutomationIds: [] } });
        const hook = await renderHook(() => useSessionTriggerLastRuns(automationIds));
        await waitForHomeGovernance(() => expect(home.requestsFor('/v3/automations/runs/workflow-storage').length).toBeGreaterThan(0));
        expect(home.requestsFor('/v3/automations/runs/workflow-storage').map(({ input }) => input)).toMatchObject([
            { operation: 'summaries', request: { automationIds } },
        ]);
        expect(executeMock.mock.calls.map(([, input]) => input)).toEqual([{ automationIds }]);
        await waitForHomeGovernance(() => expect(hook.getCurrent().lastRunsByAutomationId).toEqual({ 'habit-a': succeeded, 'habit-b': blocked }));
        expect(hook.getCurrent().failed).toBe(false);
        expect(home.requestsFor('/v3/automations/runs/workflow-storage').map(({ input }) => input)).toMatchObject([
            { operation: 'summaries', request: { automationIds } },
        ]);
        expect(storage.getState().workflowRunsById).toEqual({});
        expect(storage.getState().workflowRunListWindows).toEqual({});
    });

    it('keeps source and Automation identities separate and equal trigger refreshes stable', async () => {
        const lastRun = lastRunSummary({ id: 'run-trigger', state: 'failed', attentionRequired: true, failureUnseen: true, createdAt: '2026-10-21T03:00:00.000Z' });
        executeMock.mockImplementation(async (_actionId, input) => ({ ok: true, result: 'automationIds' in input
            ? { automationSummaries: input.automationIds.map((automationId: string) => ({ automationId, lastRun })), remainingAutomationIds: [] }
            : { summaries: input.sourceArtifactIds.map((id: string) => ({ ...item, sourceArtifactId: id })), remainingSourceArtifactIds: [] } }));
        const hook = await renderHook(() => ({
            source: useWorkflowLibrarySummaries([sourceArtifactId]),
            first: useSessionTriggerLastRuns([sourceArtifactId, 'habit-b']),
            second: useSessionTriggerLastRuns(['habit-b']),
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().first.lastRunsByAutomationId['habit-b']).toEqual(lastRun));
        expect(hook.getCurrent().source.summaries?.get(sourceArtifactId)).toEqual(item);
        expect(executeMock.mock.calls.map(([, input]) => input)).toHaveLength(2);
        expect(hook.getCurrent().first.lastRunsByAutomationId['habit-b']).toBe(hook.getCurrent().second.lastRunsByAutomationId['habit-b']);
        const before = hook.getCurrent();
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:equal-refresh']); });
        await waitForHomeGovernance(() => expect(executeMock.mock.calls).toHaveLength(4));
        expect(hook.getCurrent().source).toBe(before.source);
        expect(hook.getCurrent().first.lastRunsByAutomationId).toBe(before.first.lastRunsByAutomationId);
    });

    it('shares Automation continuations with overlapping mounts and preserves a known empty answer', async () => {
        const continuation = createDeferred<unknown>();
        executeMock.mockResolvedValueOnce({ ok: true, result: { automationSummaries: [{ automationId: 'habit-a', lastRun: null }], remainingAutomationIds: ['habit-b'] } });
        executeMock.mockReturnValueOnce(continuation.promise);
        const first = await renderHook(() => useSessionTriggerLastRuns(['habit-a', 'habit-b']));
        const overlapping = await renderHook(() => useSessionTriggerLastRuns(['habit-b']));
        await waitForHomeGovernance(() => expect(executeMock.mock.calls.map(([, input]) => input)).toEqual([
            { automationIds: ['habit-a', 'habit-b'] }, { automationIds: ['habit-b'] },
        ]));
        const lastRun = lastRunSummary({ id: 'run-b', state: 'running', createdAt: '2026-10-21T03:00:00.000Z' });
        await act(async () => { continuation.resolve({ ok: true, result: { automationSummaries: [{ automationId: 'habit-b', lastRun }], remainingAutomationIds: [] } }); await continuation.promise; });
        await waitForHomeGovernance(() => expect(first.getCurrent().lastRunsByAutomationId['habit-b']).toEqual(lastRun));
        expect(first.getCurrent().lastRunsByAutomationId['habit-b']).toBe(overlapping.getCurrent().lastRunsByAutomationId['habit-b']);
        await renderHook(() => useSessionTriggerLastRuns(['habit-a']));
        expect(executeMock.mock.calls).toHaveLength(2);
    });

    it('retains trigger statuses on failure, retries at the summary owner and drops retired replies', async () => {
        const lastRun = lastRunSummary({ id: 'run-a', state: 'succeeded', createdAt: '2026-10-21T03:00:00.000Z' });
        const result = { automationSummaries: [{ automationId: 'habit-a', lastRun }], remainingAutomationIds: [] };
        executeMock.mockResolvedValueOnce({ ok: true, result });
        const hook = await renderHook(() => useSessionTriggerLastRuns(['habit-a']));
        await waitForHomeGovernance(() => expect(hook.getCurrent().lastRunsByAutomationId['habit-a']).toEqual(lastRun));
        const before = hook.getCurrent().lastRunsByAutomationId;
        executeMock.mockRejectedValueOnce(new Error('offline'));
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:failed-refresh']); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().failed).toBe(true));
        expect(hook.getCurrent().lastRunsByAutomationId).toBe(before);
        executeMock.mockResolvedValueOnce({ ok: true, result });
        await act(async () => { hook.getCurrent().retry(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().failed).toBe(false));
        expect(hook.getCurrent().lastRunsByAutomationId).toBe(before);
        const retired = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(retired.promise);
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:late']); });
        await waitForHomeGovernance(() => expect(executeMock.mock.calls).toHaveLength(4));
        executeMock.mockResolvedValue({ ok: true, result: { automationSummaries: [{ automationId: 'habit-a', lastRun: null }], remainingAutomationIds: [] } });
        await act(async () => {
            await home.switchAccount(serverId, 'account-b');
            storage.setState({ profileScope: { serverId, accountId: 'account-b' }, settingsScope: { serverId, accountId: 'account-b' } });
        });
        await act(async () => { retired.resolve({ ok: true, result }); await retired.promise; });
        expect(hook.getCurrent().lastRunsByAutomationId).toEqual({});
    });

    it('reports initial refusal and a failed continuation without answering missing Automations as empty', async () => {
        executeMock.mockRejectedValueOnce(new Error('denied'));
        const hook = await renderHook(() => useSessionTriggerLastRuns(['habit-a', 'habit-b']));
        await waitForHomeGovernance(() => expect(hook.getCurrent().failed).toBe(true));
        expect(hook.getCurrent().lastRunsByAutomationId).toEqual({});
        executeMock.mockResolvedValueOnce({ ok: true, result: { automationSummaries: [{ automationId: 'habit-a', lastRun: null }], remainingAutomationIds: ['habit-b'] } });
        executeMock.mockRejectedValueOnce(new Error('continuation offline'));
        await act(async () => { hook.getCurrent().retry(); });
        await waitForHomeGovernance(() => expect(executeMock.mock.calls).toHaveLength(3));
        await waitForHomeGovernance(() => expect(hook.getCurrent().failed).toBe(true));
        const lastRun = lastRunSummary({ id: 'run-b', state: 'running', createdAt: '2026-10-21T03:00:00.000Z' });
        executeMock.mockResolvedValueOnce({ ok: true, result: { automationSummaries: [
            { automationId: 'habit-a', lastRun: null }, { automationId: 'habit-b', lastRun },
        ], remainingAutomationIds: [] } });
        await act(async () => { hook.getCurrent().retry(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().failed).toBe(false));
        expect(hook.getCurrent().lastRunsByAutomationId).toEqual({ 'habit-b': lastRun });
    });

    it('reports a non-progressing empty page as unavailable and distinguishes an answered null', async () => {
        executeMock.mockResolvedValueOnce({ ok: true, result: { automationSummaries: [], remainingAutomationIds: ['habit-a'] } });
        const hook = await renderHook(() => useWorkflowAutomationSummaries(['habit-a']));
        await waitForHomeGovernance(() => expect(hook.getCurrent().failed).toBe(true));
        expect(hook.getCurrent().summaries).toBeNull();
        executeMock.mockResolvedValueOnce({ ok: true, result: { automationSummaries: [{ automationId: 'habit-a', lastRun: null }], remainingAutomationIds: [] } });
        await act(async () => { hook.getCurrent().retry(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().summaries?.has('habit-a')).toBe(true));
        expect(hook.getCurrent().failed).toBe(false);
        expect(hook.getCurrent().summaries?.get('habit-a')?.lastRun).toBeNull();
        await renderHook(() => useWorkflowAutomationSummaries(['habit-a']));
        expect(executeMock.mock.calls).toHaveLength(2);
    });

    it('renews mounted demand and wakes after the same Account becomes available again', async () => {
        executeMock.mockResolvedValue(reply);
        const hook = await renderHook(() => useWorkflowLibrarySummaries([sourceArtifactId]));
        await waitForHomeGovernance(() => expect(hook.getCurrent().summaries?.get(sourceArtifactId)?.needsYouCount).toBe(1));
        await act(async () => { publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), false); });
        expect(hook.getCurrent().summaries).toBeNull();
        executeMock.mockResolvedValue({ ok: true, result: { summaries: [{ ...item, needsYouCount: 0, needsYouRunId: null }], remainingSourceArtifactIds: [] } });
        await act(async () => { publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().summaries?.get(sourceArtifactId)?.needsYouCount).toBe(0));
        executeMock.mockResolvedValue(reply);
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:restored']); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().summaries?.get(sourceArtifactId)?.needsYouCount).toBe(1));
    });

    it('batches overlapping chrome/library demands and one Account wake through one shared read', async () => {
        const second = '00000000-0000-4000-8000-000000000002';
        const third = '00000000-0000-4000-8000-000000000003';
        const summaries: Record<string, ReturnType<typeof useWorkflowLibrarySummaries>> = {};
        function SummaryProbe(props: { name: string; ids: readonly string[] }) {
            summaries[props.name] = useWorkflowLibrarySummaries(props.ids);
            return null;
        }
        executeMock.mockImplementation(async (actionId, input) => actionId === 'workflow.run.summaries'
            ? { ok: true, result: { summaries: input.sourceArtifactIds.map((id: string) => ({ ...item, sourceArtifactId: id })), remainingSourceArtifactIds: [] } }
            : { ok: false, errorCode: 'unexpected_action' });
        await renderScreen(<><SummaryProbe name="chrome" ids={[sourceArtifactId, second]} />
            <SummaryProbe name="library" ids={[second, third]} /></>);
        await act(async () => { await Promise.resolve(); });
        const requests = () => executeMock.mock.calls.filter(([id]) => id === 'workflow.run.summaries');
        await waitForHomeGovernance(() => expect(requests()).toHaveLength(1));
        expect(new Set(requests()[0]![1].sourceArtifactIds)).toEqual(new Set([sourceArtifactId, second, third]));
        await waitForHomeGovernance(() => expect(summaries.chrome?.summaries?.get(second)?.needsYouCount).toBe(1));
        expect(summaries.chrome?.summaries?.get(second)).toBe(summaries.library?.summaries?.get(second));
        const chrome = summaries.chrome;
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:updated']); });
        await waitForHomeGovernance(() => expect(requests()).toHaveLength(2));
        expect(summaries.chrome).toBe(chrome);
    });

    it('joins an overlapping in-flight id while reading only a new consumer’s missing id', async () => {
        const second = '00000000-0000-4000-8000-000000000002';
        const pending = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(pending.promise);
        const first = await renderHook(() => useWorkflowLibrarySummaries([sourceArtifactId]));
        executeMock.mockResolvedValueOnce({ ok: true, result: { summaries: [{ ...item, sourceArtifactId: second }], remainingSourceArtifactIds: [] } });
        const next = await renderHook(() => useWorkflowLibrarySummaries([sourceArtifactId, second]));
        await waitForHomeGovernance(() => expect(executeMock.mock.calls.filter(([id]) => id === 'workflow.run.summaries').map(([, input]) => input.sourceArtifactIds))
            .toEqual([[sourceArtifactId], [second]]));
        await act(async () => { pending.resolve(reply); await pending.promise; });
        await waitForHomeGovernance(() => expect(next.getCurrent().summaries?.get(sourceArtifactId)?.needsYouCount).toBe(1));
        expect(next.getCurrent().summaries?.get(sourceArtifactId)).toBe(first.getCurrent().summaries?.get(sourceArtifactId));
        await waitForHomeGovernance(() => expect(next.getCurrent().summaries?.get(second)?.sourceArtifactId).toBe(second));
    });

    it('keeps continuation ids in flight for overlapping consumers until the byte-budget read answers', async () => {
        const second = '00000000-0000-4000-8000-000000000002';
        const continuation = createDeferred<unknown>();
        executeMock.mockResolvedValueOnce({ ok: true, result: { summaries: [item], remainingSourceArtifactIds: [second] } });
        executeMock.mockReturnValueOnce(continuation.promise);
        const first = await renderHook(() => useWorkflowLibrarySummaries([sourceArtifactId, second]));
        const overlapping = await renderHook(() => useWorkflowLibrarySummaries([second]));
        await waitForHomeGovernance(() => expect(executeMock.mock.calls.filter(([id]) => id === 'workflow.run.summaries').map(([, input]) => input.sourceArtifactIds))
            .toEqual([[sourceArtifactId, second], [second]]));
        await act(async () => { continuation.resolve({ ok: true, result: { summaries: [{ ...item, sourceArtifactId: second }], remainingSourceArtifactIds: [] } }); await continuation.promise; });
        await waitForHomeGovernance(() => expect(first.getCurrent().summaries?.get(second)?.needsYouCount).toBe(1));
        expect(first.getCurrent().summaries?.get(second)).toBe(overlapping.getCurrent().summaries?.get(second));
        await waitForHomeGovernance(() => expect(first.getCurrent().summaries?.get(sourceArtifactId)?.needsYouCount).toBe(1));
    });

    it('keeps the last answer after a failed refresh and retries on the next shared wake', async () => {
        executeMock.mockResolvedValueOnce(reply);
        const hook = await renderHook(() => useWorkflowLibrarySummaries([sourceArtifactId]));
        await waitForHomeGovernance(() => expect(hook.getCurrent().summaries?.get(sourceArtifactId)?.needsYouCount).toBe(1));
        const before = hook.getCurrent();
        executeMock.mockRejectedValueOnce(new Error('offline'));
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:failed-refresh']); });
        expect(hook.getCurrent().summaries).toBe(before.summaries);
        executeMock.mockResolvedValueOnce({ ok: true, result: { summaries: [{ ...item, needsYouCount: 0, needsYouRunId: null }], remainingSourceArtifactIds: [] } });
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:recovered']); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().summaries?.get(sourceArtifactId)?.needsYouCount).toBe(0));
    });

    it('does not turn an unanswered continuation into known empty facts', async () => {
        const second = '00000000-0000-4000-8000-000000000002';
        executeMock.mockResolvedValueOnce(reply);
        const hook = await renderHook((props: { ids: readonly string[] }) => useWorkflowLibrarySummaries(props.ids), {
            initialProps: { ids: [sourceArtifactId] },
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().summaries?.get(sourceArtifactId)?.needsYouCount).toBe(1));
        const retained = hook.getCurrent().summaries?.get(sourceArtifactId);
        executeMock.mockResolvedValueOnce({ ok: true, result: { summaries: [], remainingSourceArtifactIds: [second] } });
        await hook.rerender({ ids: [sourceArtifactId, second] });
        expect(hook.getCurrent().summaries?.get(sourceArtifactId)).toBe(retained);
        expect(hook.getCurrent().summaries?.has(second)).toBe(false);
        executeMock.mockResolvedValueOnce({ ok: true, result: { summaries: [item, { ...item, sourceArtifactId: second }], remainingSourceArtifactIds: [] } });
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:retry']); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().summaries?.get(second)?.needsYouCount).toBe(1));
    });

    it('refreshes an idle summary owner when visible demand returns', async () => {
        executeMock.mockResolvedValueOnce(reply);
        const first = await renderHook(() => useWorkflowLibrarySummaries([sourceArtifactId]));
        await waitForHomeGovernance(() => expect(first.getCurrent().summaries?.get(sourceArtifactId)?.needsYouRunId).toBe('private-run-a'));
        await first.unmount();
        executeMock.mockResolvedValueOnce({ ok: true, result: { summaries: [{ ...item,
            needsYouCount: 0, needsYouRunId: null }], remainingSourceArtifactIds: [] } });
        const returned = await renderHook(() => useWorkflowLibrarySummaries([sourceArtifactId]));
        await waitForHomeGovernance(() => expect(returned.getCurrent().summaries?.get(sourceArtifactId)?.needsYouRunId).toBeNull());
    });

    it.each(['source', 'automation'] as const)('refreshes re-entering %s demand while another id stays visible', async kind => {
        const second = '00000000-0000-4000-8000-000000000002';
        const refreshed = createDeferred<unknown>();
        let completed = false;
        let holdReturningRead = false;
        const response = (ids: readonly string[]) => ({ ok: true, result: kind === 'source'
            ? { summaries: ids.map(id => ({ ...item, sourceArtifactId: id,
                needsYouCount: completed ? 0 : 1, needsYouRunId: completed ? null : 'private-run-a' })), remainingSourceArtifactIds: [] }
            : { automationSummaries: ids.map(automationId => ({ automationId, lastRun: lastRunSummary({
                id: `run-${automationId}`, state: completed ? 'succeeded' : 'running', workflowCustodyState: null,
                attentionRequired: !completed, invocationAttentionRequired: !completed, createdAt: '2026-10-21T03:00:00.000Z',
            }) })), remainingAutomationIds: [] },
        });
        executeMock.mockImplementation(async (_actionId, input) => {
            const ids: readonly string[] = kind === 'source' ? input.sourceArtifactIds : input.automationIds;
            return holdReturningRead && ids.includes(second) ? refreshed.promise : response(ids);
        });
        function useSummary(id: string) {
            return kind === 'source' ? useWorkflowLibrarySummaries([id]).summaries?.get(id)
                : useWorkflowAutomationSummaries([id]).summaries?.get(id);
        }
        const attention = (row: ReturnType<typeof useSummary>) => row && ('needsYouCount' in row
            ? row.needsYouCount : Number(row.lastRun?.attentionRequired ?? false));
        const first = await renderHook(() => useSummary(sourceArtifactId));
        const secondMount = await renderHook(() => useSummary(second));
        await waitForHomeGovernance(() => expect(attention(first.getCurrent())).toBe(1));
        await waitForHomeGovernance(() => expect(attention(secondMount.getCurrent())).toBe(1));
        const lastKnown = secondMount.getCurrent();
        expect(executeMock.mock.calls).toHaveLength(2);
        await secondMount.unmount();
        completed = true;
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:completed-while-hidden']); });
        await waitForHomeGovernance(() => expect(attention(first.getCurrent())).toBe(0));
        expect(executeMock.mock.calls).toHaveLength(3);
        holdReturningRead = true;
        const returned = await renderHook(() => useSummary(second));
        await flushHookEffects({ cycles: 10 });
        expect(executeMock.mock.calls).toHaveLength(4);
        expect(returned.getCurrent()).toBe(lastKnown);
        await act(async () => { refreshed.resolve(response([second])); await refreshed.promise; });
        await waitForHomeGovernance(() => expect(attention(returned.getCurrent())).toBe(0));
        expect(executeMock.mock.calls).toHaveLength(4);
    });

    it('retires summaries on Account changes and subscribes to the new Account wake', async () => {
        executeMock.mockResolvedValueOnce(reply);
        const hook = await renderHook(() => useWorkflowLibrarySummaries([sourceArtifactId]));
        await waitForHomeGovernance(() => expect(hook.getCurrent().summaries?.get(sourceArtifactId)?.needsYouRunId).toBe('private-run-a'));
        const next = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(next.promise);
        await act(async () => {
            await home.switchAccount(serverId, 'account-b');
            storage.setState({ profileScope: { serverId, accountId: 'account-b' }, settingsScope: { serverId, accountId: 'account-b' } });
        });
        expect(hook.getCurrent().summaries).toBeNull();
        await act(async () => { next.resolve({ ok: true, result: { summaries: [{ ...item, needsYouCount: 0, needsYouRunId: null }], remainingSourceArtifactIds: [] } }); await next.promise; });
        await waitForHomeGovernance(() => expect(hook.getCurrent().summaries?.get(sourceArtifactId)?.needsYouRunId).toBeNull());
        executeMock.mockResolvedValueOnce({ ok: true, result: { summaries: [{ ...item, needsYouRunId: 'run-b' }], remainingSourceArtifactIds: [] } });
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:run-b']); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().summaries?.get(sourceArtifactId)?.needsYouRunId).toBe('run-b'));
    });

    it('retains summaries across unchanged wakes and does not rerender for unrelated store updates', async () => {
        executeMock.mockImplementation(async () => structuredClone(reply));
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useWorkflowLibrarySummaries([sourceArtifactId]); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().summaries?.get(sourceArtifactId)?.needsYouCount).toBe(1));
        const before = hook.getCurrent();
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:private-run-a']); });
        // Equal refreshes retain the selected map; unrelated store writes must not wake it.
        const afterWake = renders;
        expect(hook.getCurrent()).toBe(before);
        await act(async () => { storage.setState({ workflowRunsById: { ...storage.getState().workflowRunsById } }); });
        expect(renders).toBe(afterWake);
    });
});
