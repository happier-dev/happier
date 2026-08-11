import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY,
    buildSessionAgentActivityHeadline,
    type SessionAgentActivityEntryV1,
    type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

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

async function renderForToolUseId(params: Readonly<{
    metadata: unknown;
    toolUseId: string | null | undefined;
}>) {
    const { useWorkflowRunForToolUseId } = await import('./useWorkflowRunDetails');
    return renderHook(
        (props: { metadata: unknown; toolUseId: string | null | undefined }) =>
            useWorkflowRunForToolUseId({ sessionId: 'sess_1', metadata: props.metadata, toolUseId: props.toolUseId }),
        { initialProps: params },
    );
}

async function renderActivity(params: Readonly<{
    metadata: unknown;
    runIds: readonly string[];
}>) {
    const { useWorkflowRunDetails } = await import('./useWorkflowRunDetails');
    return renderHook(
        (props: { metadata: unknown; runIds: readonly string[] }) =>
            useWorkflowRunDetails({ sessionId: 'sess_1', metadata: props.metadata, runIds: props.runIds }),
        { initialProps: params },
    );
}

describe('useWorkflowRunDetails — active workflow refresh continuity', () => {
    it('keeps the previous loaded snapshot visible while a newer record revision is refetched', async () => {
        const nextFetch = createDeferred<SessionWorkflowRunSnapshotV1 | null>();
        fetchWorkflowRunSnapshot
            .mockResolvedValueOnce(snapshot('run_a', { title: 'Loaded revision 1', recordRevision: '1' }))
            .mockReturnValueOnce(nextFetch.promise);

        const hook = await renderActivity({
            metadata: metadata([headlineRun({ runId: 'run_a', recordRevision: '1', recordUpdatedAt: 1 })]),
            runIds: ['run_a'],
        });
        expect(hook.getCurrent().runDetailById.get('run_a')).toMatchObject({
            state: 'loaded',
            snapshot: expect.objectContaining({ title: 'Loaded revision 1' }),
        });

        await hook.rerender({
            metadata: metadata([headlineRun({ runId: 'run_a', recordRevision: '2', recordUpdatedAt: 2 })]),
            runIds: ['run_a'],
        });

        expect(hook.getCurrent().runDetailById.get('run_a')).toMatchObject({
            state: 'loaded',
            snapshot: expect.objectContaining({ title: 'Loaded revision 1' }),
        });
        expect(hook.getCurrent().loadedRunsById.get('run_a')?.title).toBe('Loaded revision 1');

        nextFetch.resolve(snapshot('run_a', { title: 'Loaded revision 2', recordRevision: '2' }));
        await hook.rerender({
            metadata: metadata([headlineRun({ runId: 'run_a', recordRevision: '2', recordUpdatedAt: 2 })]),
            runIds: ['run_a'],
        });
        expect(hook.getCurrent().loadedRunsById.get('run_a')?.title).toBe('Loaded revision 2');
    });

    /**
     * The demotion's deciding contract: the unified model owns which runs exist, this hook owns
     * how deep we know them. A run the caller does not list is not hydrated even though the
     * workflow headline still describes it, and a run the caller DOES list is hydrated even
     * though no headline names it — the degrade path for a CLI that publishes only the unified
     * headline, where the old hook would have shown nothing at all.
     */
    it('hydrates exactly the runs the unified model asked for, headline or no headline', async () => {
        const hook = await renderActivity({
            metadata: metadata([headlineRun({ runId: 'run_a', recordRevision: '1', recordUpdatedAt: 1 })]),
            runIds: ['run_b'],
        });

        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_b' });
        expect(fetchWorkflowRunSnapshot).not.toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_a' });
        expect(hook.getCurrent().runDetailById.has('run_a')).toBe(false);
        expect(hook.getCurrent().loadedRunsById.get('run_b')?.runId).toBe('run_b');
        // The headline is still read — as DETAIL, for the pre-load fraction and the fetch key.
        expect(hook.getCurrent().runHeadlineById.get('run_a')?.runId).toBe('run_a');
    });
});

/**
 * The unified-headline freshness chain (FIX-5).
 *
 * The old count-only workflow headline is published by ONE backend's CLI. Every other backend — and
 * every CLI predating this program — publishes only the unified agent-activity headline, and on that
 * path this hook had no record pointer at all: it degraded to a per-run constant, so a run hydrated
 * once and then never refreshed while the panel above it went on looking live. Nothing about that is
 * observable to a person reading the panel, which is why a LOW-frequency defect is worth a test.
 */
function agentActivityMetadata(entries: readonly SessionAgentActivityEntryV1[], updatedAt = 2000): unknown {
    return {
        [SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY]: buildSessionAgentActivityHeadline({
            backendId: 'codex',
            updatedAt,
            entries,
        }),
    };
}

function unifiedRunEntry(params: Readonly<{
    runId: string;
    updatedAt: number;
    recordRevision?: string;
}>): SessionAgentActivityEntryV1 {
    return {
        entryId: `workflow_run:${params.runId}`,
        kind: 'workflow_run',
        title: `Run ${params.runId}`,
        status: 'running',
        updatedAt: params.updatedAt,
        runId: params.runId,
        ...(params.recordRevision !== undefined ? { recordRevision: params.recordRevision } : {}),
    };
}

describe('useWorkflowRunDetails — freshness on the unified-headline-only path', () => {
    it('refreshes as the run progresses when its producer publishes no record revision', async () => {
        const hook = await renderActivity({
            metadata: agentActivityMetadata([unifiedRunEntry({ runId: 'run_a', updatedAt: 1000 })]),
            runIds: ['run_a'],
        });
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledTimes(1);

        // New evidence about the run arrived. Without a revision to key on, the entry's evidence
        // instant is the only freshness signal there is — and a surface that still looks live has
        // to act on it rather than freeze.
        await hook.rerender({
            metadata: agentActivityMetadata([unifiedRunEntry({ runId: 'run_a', updatedAt: 2000 })], 3000),
            runIds: ['run_a'],
        });
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledTimes(2);
    });

    it('keys on the published record revision, so display-only churn does not refetch', async () => {
        const hook = await renderActivity({
            metadata: agentActivityMetadata([
                unifiedRunEntry({ runId: 'run_a', updatedAt: 1000, recordRevision: '4' }),
            ]),
            runIds: ['run_a'],
        });
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledTimes(1);

        // Evidence advanced but the durable record did not: the cached snapshot is still current.
        await hook.rerender({
            metadata: agentActivityMetadata([
                unifiedRunEntry({ runId: 'run_a', updatedAt: 5000, recordRevision: '4' }),
            ], 5000),
            runIds: ['run_a'],
        });
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledTimes(1);

        await hook.rerender({
            metadata: agentActivityMetadata([
                unifiedRunEntry({ runId: 'run_a', updatedAt: 6000, recordRevision: '5' }),
            ], 6000),
            runIds: ['run_a'],
        });
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledTimes(2);
    });
});

describe('useWorkflowRunForToolUseId — UIW4 tool-use-id join', () => {
    it('(a) joins by workflowToolUseId even when it differs from runId', async () => {
        const md = metadata([
            headlineRun({ runId: 'run_internal', workflowToolUseId: 'toolu_card' }),
        ]);
        const hook = await renderForToolUseId({ metadata: md, toolUseId: 'toolu_card' });

        // Joined the run whose workflowToolUseId matches, not by the (differing) runId.
        expect(hook.getCurrent().runHeadline?.runId).toBe('run_internal');
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_internal' });
        expect(hook.getCurrent().detail).toMatchObject({ state: 'loaded', runId: 'run_internal' });
    });

    it('(b) falls back to runId when no workflowToolUseId matches', async () => {
        const md = metadata([
            // This run has a tool-use id that does NOT match the card; only its runId does.
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

        // The non-primary run is resolved; the hook never defaults to primaryRunId.
        expect(hook.getCurrent().runHeadline?.runId).toBe('run_secondary');
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_secondary' });
        expect(fetchWorkflowRunSnapshot).not.toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_primary' });
    });

    it('(c2) does not default to primaryRunId when no headline run matches the tool id', async () => {
        fetchWorkflowRunSnapshot.mockResolvedValueOnce(null);
        const md = metadata(
            [headlineRun({ runId: 'run_primary', workflowToolUseId: 'toolu_primary' })],
            { primaryRunId: 'run_primary' },
        );
        const hook = await renderForToolUseId({ metadata: md, toolUseId: 'toolu_unmatched' });

        expect(hook.getCurrent().runHeadline).toBeNull();
        expect(hook.getCurrent().detail).toMatchObject({ state: 'missing', runId: 'toolu_unmatched' });
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'toolu_unmatched' });
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

    /**
     * The same freeze, in the sibling seam. The transcript card cannot join through the unified
     * headline — that headline carries no `workflowToolUseId` — so on a unified-only backend it
     * falls through to the direct-by-id fetch. Keyed by the id alone, an ACTIVE run's card hydrated
     * once and then showed a stale phase/agent tree for the rest of the run.
     */
    it('(g) refreshes the direct-by-id fetch when the unified headline advances that run record', async () => {
        const hook = await renderForToolUseId({
            metadata: agentActivityMetadata([
                unifiedRunEntry({ runId: 'run_a', updatedAt: 1000, recordRevision: '4' }),
            ]),
            toolUseId: 'run_a',
        });
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().runHeadline).toBeNull();

        await hook.rerender({
            metadata: agentActivityMetadata([
                unifiedRunEntry({ runId: 'run_a', updatedAt: 2000, recordRevision: '5' }),
            ], 3000),
            toolUseId: 'run_a',
        });
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledTimes(2);
    });

    it('(f) fetches directly by tool-use id when an older completed run is no longer in bounded headline history', async () => {
        const md = metadata(
            [headlineRun({ runId: 'run_active', workflowToolUseId: 'toolu_active' })],
            {
                recentRuns: [
                    headlineRun({ runId: 'run_recent', status: 'complete', workflowToolUseId: 'toolu_recent' }),
                ],
            },
        );
        const hook = await renderForToolUseId({ metadata: md, toolUseId: 'toolu_old' });

        expect(hook.getCurrent().runHeadline).toBeNull();
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'toolu_old' });
        expect(hook.getCurrent().detail).toMatchObject({ state: 'loaded', runId: 'toolu_old' });
    });
});
