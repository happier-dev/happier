import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useWorkflowLibrarySummaries } from './useWorkflowLibrarySummaries';

// These declarations script HTTP storage responses, never the Action executor.
const executeMock = vi.fn();
let boundary: Awaited<ReturnType<typeof installWorkflowActionHttpBoundary>>;
let serverId: string;
let previousState = storage.getState();
let previousApplied = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();
beforeEach(async () => {
    previousState = storage.getState();
    previousApplied = getAppliedActiveServerSnapshot();
    previousAvailable = isAppliedActiveServerRuntimeAvailable();
    boundary = await installWorkflowActionHttpBoundary({ fixtureResponse: executeMock });
    const home = await upsertAndActivateServer({ serverUrl: 'https://workflow-summaries-http.test' });
    serverId = home.id;
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' },
        isDataReady: true, machineListByServerId: {}, workflowRunsById: {}, workflowRunListWindows: {} });
    boundary.prime();
});
afterEach(async () => {
    await standardCleanup();
    (await import('./workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    boundary.dispose();
    executeMock.mockReset();
    storage.setState(previousState);
    publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
});

describe('workflow library run summaries', () => {
    const sourceArtifactId = '00000000-0000-4000-8000-000000000001';
    const item = { sourceArtifactId, lastRun: null, recent: [], needsYouCount: 1, needsYouRunId: 'private-run-a' };
    const reply = { ok: true, result: { summaries: [item], remainingSourceArtifactIds: [] } };

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
        expect(requests()).toHaveLength(1);
        expect(new Set(requests()[0]![1].sourceArtifactIds)).toEqual(new Set([sourceArtifactId, second, third]));
        expect(summaries.chrome?.get(second)).toBe(summaries.library?.get(second));
        const chrome = summaries.chrome;
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:updated']); });
        expect(requests()).toHaveLength(2);
        expect(summaries.chrome).toBe(chrome);
    });

    it('joins an overlapping in-flight id while reading only a new consumer’s missing id', async () => {
        const second = '00000000-0000-4000-8000-000000000002';
        const pending = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(pending.promise);
        const first = await renderHook(() => useWorkflowLibrarySummaries([sourceArtifactId]));
        executeMock.mockResolvedValueOnce({ ok: true, result: { summaries: [{ ...item, sourceArtifactId: second }], remainingSourceArtifactIds: [] } });
        const next = await renderHook(() => useWorkflowLibrarySummaries([sourceArtifactId, second]));
        expect(executeMock.mock.calls.filter(([id]) => id === 'workflow.run.summaries').map(([, input]) => input.sourceArtifactIds))
            .toEqual([[sourceArtifactId], [second]]);
        await act(async () => { pending.resolve(reply); await pending.promise; });
        expect(next.getCurrent()?.get(sourceArtifactId)).toBe(first.getCurrent()?.get(sourceArtifactId));
        expect(next.getCurrent()?.get(second)?.sourceArtifactId).toBe(second);
    });

    it('keeps continuation ids in flight for overlapping consumers until the byte-budget read answers', async () => {
        const second = '00000000-0000-4000-8000-000000000002';
        const continuation = createDeferred<unknown>();
        executeMock.mockResolvedValueOnce({ ok: true, result: { summaries: [item], remainingSourceArtifactIds: [second] } });
        executeMock.mockReturnValueOnce(continuation.promise);
        const first = await renderHook(() => useWorkflowLibrarySummaries([sourceArtifactId, second]));
        const overlapping = await renderHook(() => useWorkflowLibrarySummaries([second]));
        expect(executeMock.mock.calls.filter(([id]) => id === 'workflow.run.summaries').map(([, input]) => input.sourceArtifactIds))
            .toEqual([[sourceArtifactId, second], [second]]);
        await act(async () => { continuation.resolve({ ok: true, result: { summaries: [{ ...item, sourceArtifactId: second }], remainingSourceArtifactIds: [] } }); await continuation.promise; });
        expect(first.getCurrent()?.get(second)).toBe(overlapping.getCurrent()?.get(second));
        expect(first.getCurrent()?.get(sourceArtifactId)?.needsYouCount).toBe(1);
    });

    it('keeps the last answer after a failed refresh and retries on the next shared wake', async () => {
        executeMock.mockResolvedValueOnce(reply);
        const hook = await renderHook(() => useWorkflowLibrarySummaries([sourceArtifactId]));
        const before = hook.getCurrent();
        executeMock.mockRejectedValueOnce(new Error('offline'));
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:failed-refresh']); });
        expect(hook.getCurrent()).toBe(before);
        executeMock.mockResolvedValueOnce({ ok: true, result: { summaries: [{ ...item, needsYouCount: 0, needsYouRunId: null }], remainingSourceArtifactIds: [] } });
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:recovered']); });
        expect(hook.getCurrent()?.get(sourceArtifactId)?.needsYouCount).toBe(0);
    });

    it('does not turn an unanswered continuation into known empty facts', async () => {
        const second = '00000000-0000-4000-8000-000000000002';
        executeMock.mockResolvedValueOnce(reply);
        const hook = await renderHook((props: { ids: readonly string[] }) => useWorkflowLibrarySummaries(props.ids), {
            initialProps: { ids: [sourceArtifactId] },
        });
        const retained = hook.getCurrent()?.get(sourceArtifactId);
        executeMock.mockResolvedValueOnce({ ok: true, result: { summaries: [], remainingSourceArtifactIds: [second] } });
        await hook.rerender({ ids: [sourceArtifactId, second] });
        expect(hook.getCurrent()?.get(sourceArtifactId)).toBe(retained);
        expect(hook.getCurrent()?.has(second)).toBe(false);
        executeMock.mockResolvedValueOnce({ ok: true, result: { summaries: [item, { ...item, sourceArtifactId: second }], remainingSourceArtifactIds: [] } });
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:retry']); });
        expect(hook.getCurrent()?.get(second)?.needsYouCount).toBe(1);
    });

    it('refreshes an idle summary owner when visible demand returns', async () => {
        executeMock.mockResolvedValueOnce(reply);
        const first = await renderHook(() => useWorkflowLibrarySummaries([sourceArtifactId]));
        expect(first.getCurrent()?.get(sourceArtifactId)?.needsYouRunId).toBe('private-run-a');
        await first.unmount();
        executeMock.mockResolvedValueOnce({ ok: true, result: { summaries: [{ ...item,
            needsYouCount: 0, needsYouRunId: null }], remainingSourceArtifactIds: [] } });
        const returned = await renderHook(() => useWorkflowLibrarySummaries([sourceArtifactId]));
        expect(returned.getCurrent()?.get(sourceArtifactId)?.needsYouRunId).toBeNull();
    });

    it('retires summaries on Account changes and subscribes to the new Account wake', async () => {
        executeMock.mockResolvedValueOnce(reply);
        const hook = await renderHook(() => useWorkflowLibrarySummaries([sourceArtifactId]));
        expect(hook.getCurrent()?.get(sourceArtifactId)?.needsYouRunId).toBe('private-run-a');
        const next = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(next.promise);
        await act(async () => { storage.setState({ profileScope: { serverId, accountId: 'account-b' } }); });
        expect(hook.getCurrent()).toBeNull();
        await act(async () => { next.resolve({ ok: true, result: { summaries: [{ ...item, needsYouCount: 0, needsYouRunId: null }], remainingSourceArtifactIds: [] } }); await next.promise; });
        expect(hook.getCurrent()?.get(sourceArtifactId)?.needsYouRunId).toBeNull();
        executeMock.mockResolvedValueOnce({ ok: true, result: { summaries: [{ ...item, needsYouRunId: 'run-b' }], remainingSourceArtifactIds: [] } });
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:run-b']); });
        expect(hook.getCurrent()?.get(sourceArtifactId)?.needsYouRunId).toBe('run-b');
    });

    it('retains summaries across unchanged wakes and does not rerender for unrelated store updates', async () => {
        executeMock.mockImplementation(async () => structuredClone(reply));
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useWorkflowLibrarySummaries([sourceArtifactId]); });
        const before = hook.getCurrent();
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:private-run-a']); });
        // Equal refreshes retain the selected map; unrelated store writes must not wake it.
        const afterWake = renders;
        expect(hook.getCurrent()).toBe(before);
        await act(async () => { storage.setState({ workflowRunsById: { ...storage.getState().workflowRunsById } }); });
        expect(renders).toBe(afterWake);
    });
});
