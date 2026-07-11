import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';

import {
    createDeferred,
    makeSessionWorkflowActivityMetadata,
    makeSessionWorkflowRunHeadline,
    makeSessionWorkflowRunSnapshot,
    renderHook,
} from '@/dev/testkit';

// Boundary mock: the records-backed fetch crosses sync/encryption/network. Everything else (the
// metadata headline read + the tool-use-id join logic under test) runs for real.
const fetchWorkflowRunSnapshot = vi.fn<
    (params: { sessionId: string; runId: string }) => Promise<SessionWorkflowRunSnapshotV1 | null>
>();
vi.mock('@/sync/domains/sessionActivity/sessionWorkflowActivityRecords', () => ({
    fetchWorkflowRunSnapshot: (params: { sessionId: string; runId: string }) => fetchWorkflowRunSnapshot(params),
}));

const headlineRun = makeSessionWorkflowRunHeadline;
const metadata = makeSessionWorkflowActivityMetadata;

function snapshot(runId: string, over: Partial<SessionWorkflowRunSnapshotV1> = {}): SessionWorkflowRunSnapshotV1 {
    return makeSessionWorkflowRunSnapshot({ runId, title: `Snapshot ${runId}`, ...over });
}

beforeEach(() => {
    fetchWorkflowRunSnapshot.mockReset();
    // Default: echo the requested runId so we can assert which run the join resolved to.
    fetchWorkflowRunSnapshot.mockImplementation(async ({ runId }) => snapshot(runId));
});

async function renderActivity(params: Readonly<{
    metadata: unknown;
    enabled?: boolean;
}>) {
    const { useSessionWorkflowActivity } = await import('./useSessionWorkflowActivity');
    return renderHook(
        (props: { metadata: unknown; enabled?: boolean }) =>
            useSessionWorkflowActivity({ sessionId: 'sess_1', metadata: props.metadata, enabled: props.enabled }),
        { initialProps: params },
    );
}

async function renderForToolUseId(params: Readonly<{
    metadata: unknown;
    toolUseId: string | null | undefined;
}>) {
    const { useWorkflowRunForToolUseId } = await import('./useSessionWorkflowActivity');
    return renderHook(
        (props: { metadata: unknown; toolUseId: string | null | undefined }) =>
            useWorkflowRunForToolUseId({ sessionId: 'sess_1', metadata: props.metadata, toolUseId: props.toolUseId }),
        { initialProps: params },
    );
}

describe('useSessionWorkflowActivity — active workflow refresh continuity', () => {
    it('keeps the previous loaded snapshot visible while a newer record revision is refetched', async () => {
        const nextFetch = createDeferred<SessionWorkflowRunSnapshotV1 | null>();
        fetchWorkflowRunSnapshot
            .mockResolvedValueOnce(snapshot('run_a', { title: 'Loaded revision 1', recordRevision: '1' }))
            .mockReturnValueOnce(nextFetch.promise);

        const hook = await renderActivity({
            metadata: metadata([headlineRun({ runId: 'run_a', recordRevision: '1', recordUpdatedAt: 1 })]),
        });
        expect(hook.getCurrent().runDetailById.get('run_a')).toMatchObject({
            state: 'loaded',
            snapshot: expect.objectContaining({ title: 'Loaded revision 1' }),
        });

        await hook.rerender({
            metadata: metadata([headlineRun({ runId: 'run_a', recordRevision: '2', recordUpdatedAt: 2 })]),
        });

        expect(hook.getCurrent().runDetailById.get('run_a')).toMatchObject({
            state: 'loaded',
            snapshot: expect.objectContaining({ title: 'Loaded revision 1' }),
        });
        expect(hook.getCurrent().loadedRunsById.get('run_a')?.title).toBe('Loaded revision 1');

        nextFetch.resolve(snapshot('run_a', { title: 'Loaded revision 2', recordRevision: '2' }));
        await hook.rerender({
            metadata: metadata([headlineRun({ runId: 'run_a', recordRevision: '2', recordUpdatedAt: 2 })]),
        });
        expect(hook.getCurrent().loadedRunsById.get('run_a')?.title).toBe('Loaded revision 2');
    });
});

describe('useWorkflowRunForToolUseId — UIW4 tool-use-id join', () => {
    it('(a) joins by workflowToolUseId even when it differs from runId', async () => {
        const md = metadata([
            headlineRun({ runId: 'run_internal', workflowToolUseId: 'toolu_card' }),
        ]);
        const hook = await renderForToolUseId({ metadata: md, toolUseId: 'toolu_card' });

        expect(hook.getCurrent().runHeadline?.runId).toBe('run_internal');
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_internal' });
        expect(hook.getCurrent().detail).toMatchObject({ state: 'loaded', runId: 'run_internal' });
    });

    it('(b) falls back to runId when no workflowToolUseId matches', async () => {
        const md = metadata([
            headlineRun({ runId: 'toolu_card', workflowToolUseId: 'toolu_other' }),
        ]);
        const hook = await renderForToolUseId({ metadata: md, toolUseId: 'toolu_card' });

        expect(hook.getCurrent().runHeadline?.runId).toBe('toolu_card');
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'toolu_card' });
    });

    it('(c) does NOT resolve the headline primaryRunId when the tool id maps to a non-primary run', async () => {
        const md = metadata(
            [
                headlineRun({ runId: 'run_primary', workflowToolUseId: 'toolu_primary' }),
                headlineRun({ runId: 'run_secondary', workflowToolUseId: 'toolu_secondary' }),
            ],
            { primaryRunId: 'run_primary' },
        );
        const hook = await renderForToolUseId({ metadata: md, toolUseId: 'toolu_secondary' });

        expect(hook.getCurrent().runHeadline?.runId).toBe('run_secondary');
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_secondary' });
        expect(fetchWorkflowRunSnapshot).not.toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_primary' });
    });

    it('(c2) resolves null (not primaryRunId) when no run matches the tool id', async () => {
        const md = metadata(
            [headlineRun({ runId: 'run_primary', workflowToolUseId: 'toolu_primary' })],
            { primaryRunId: 'run_primary' },
        );
        const hook = await renderForToolUseId({ metadata: md, toolUseId: 'toolu_unmatched' });

        expect(hook.getCurrent().runHeadline).toBeNull();
        expect(hook.getCurrent().detail).toBeNull();
        expect(fetchWorkflowRunSnapshot).not.toHaveBeenCalled();
    });

    it('(d) two different tool ids resolve two different runs independently (no cross-pollution)', async () => {
        const md = metadata([
            headlineRun({ runId: 'run_a', workflowToolUseId: 'toolu_a' }),
            headlineRun({ runId: 'run_b', workflowToolUseId: 'toolu_b' }),
        ]);

        const cardA = await renderForToolUseId({ metadata: md, toolUseId: 'toolu_a' });
        const cardB = await renderForToolUseId({ metadata: md, toolUseId: 'toolu_b' });

        expect(cardA.getCurrent().runHeadline?.runId).toBe('run_a');
        expect(cardB.getCurrent().runHeadline?.runId).toBe('run_b');
        expect(cardA.getCurrent().detail).toMatchObject({ state: 'loaded', runId: 'run_a' });
        expect(cardB.getCurrent().detail).toMatchObject({ state: 'loaded', runId: 'run_b' });
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_a' });
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_b' });
    });

    it('(e) matches against a recentRuns (terminal/completed) run, not only activeRuns', async () => {
        const md = metadata(
            [headlineRun({ runId: 'run_active', workflowToolUseId: 'toolu_active' })],
            {
                recentRuns: [
                    headlineRun({ runId: 'run_done', status: 'complete', workflowToolUseId: 'toolu_done' }),
                ],
            },
        );
        const hook = await renderForToolUseId({ metadata: md, toolUseId: 'toolu_done' });

        expect(hook.getCurrent().runHeadline?.runId).toBe('run_done');
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_done' });
        expect(hook.getCurrent().detail).toMatchObject({ state: 'loaded', runId: 'run_done' });
    });
});
