import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import type { WorkflowRunListPage } from '@/sync/domains/workflows/workflowRunListActions';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    mergeWorkflowRunBodies,
    workflowRunRowFromSummary,
    type WorkflowRunsById,
} from '@/sync/store/domains/workflowRuns';

import type { SessionManagedWorkflowRunsState } from './useSessionManagedWorkflowRuns';

/**
 * The Session-managed Run rows read the one Account-scoped Run row owner and
 * the one Account-change wake that the Workflows collection reads. A control
 * settled on the Run screen, or progress the server woke this Home about,
 * therefore reaches a mounted Session row without a second store, poller or
 * local bus.
 */

const listRuns = vi.hoisted(() => vi.fn<(params: { filter?: Record<string, unknown> }) => Promise<WorkflowRunListPage>>());

const storeState = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    const state = { workflowRunsById: {} as Record<string, unknown> };
    return {
        state,
        listeners,
        emit(): void { for (const listener of listeners) listener(); },
        reset(): void { state.workflowRunsById = {}; },
    };
});

const accountScope = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    const state = { current: { serverId: 'server-a', accountId: 'account-a' } as { serverId: string; accountId: string } | null };
    return {
        state,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        switchTo(next: { serverId: string; accountId: string } | null) {
            state.current = next;
            for (const listener of listeners) listener();
        },
    };
});

/** The canonical Workflows decision this contextual reader answers. */
const featureDecisions = vi.hoisted(() => ({
    workflows: { state: 'enabled' } as Record<string, unknown> | null,
}));
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string) => (
        featureId === 'workflows' ? featureDecisions.workflows : { state: 'enabled' }
    ),
}));
vi.mock('@/sync/domains/workflows/workflowRunListActions', () => ({
    listWorkflowRuns: listRuns,
}));
vi.mock('@/sync/domains/scope/activeServerAccountScope', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/scope/activeServerAccountScope')>(),
    captureActiveServerAccountScopeLifetime: () => {
        const captured = accountScope.state.current;
        if (captured === null) return null;
        const retirements = new Set<() => void>();
        const lifetime = {
            scope: captured,
            isCurrent: () => accountScope.state.current?.serverId === captured.serverId
                && accountScope.state.current?.accountId === captured.accountId,
            onRetire: (cancel: () => void) => {
                retirements.add(cancel);
                return { dispose: () => retirements.delete(cancel) };
            },
        };
        accountScope.subscribe(() => {
            if (lifetime.isCurrent()) return;
            for (const cancel of [...retirements]) cancel();
            retirements.clear();
        });
        return lifetime;
    },
}));
vi.mock('@/sync/domains/state/storage', async () => {
    // The real Account store narrows a window read with a shallow comparison.
    // The fake mirrors that contract with the same owners rather than a looser
    // one, so what these cases observe about render scope is what ships.
    const { useShallow } = await import('zustand/react/shallow');
    const { resolveWorkflowRunRows } = await import('@/sync/store/domains/workflowRuns');
    const useStore = (selector: (state: unknown) => unknown) => React.useSyncExternalStore(
        (listener: () => void) => {
            storeState.listeners.add(listener);
            return () => storeState.listeners.delete(listener);
        },
        () => selector(storeState.state),
        () => selector(storeState.state),
    );
    return {
        getStorage: () => Object.assign(useStore, {
            getState: () => ({
                upsertWorkflowRuns: (rows: ReadonlyArray<ReturnType<typeof workflowRunRowFromSummary>>) => {
                    const next = mergeWorkflowRunBodies(storeState.state.workflowRunsById as WorkflowRunsById, rows);
                    if (next === storeState.state.workflowRunsById) return;
                    storeState.state.workflowRunsById = next;
                    storeState.emit();
                },
            }),
        }),
        useActiveServerAccountScope: () => React.useSyncExternalStore(
            accountScope.subscribe,
            () => accountScope.state.current,
            () => accountScope.state.current,
        ),
        useWorkflowRunRows: (runIds: readonly string[]) => useStore(
            useShallow((state: unknown) => resolveWorkflowRunRows(
                (state as { workflowRunsById: WorkflowRunsById }).workflowRunsById,
                runIds,
            )),
        ),
    };
});

let latest: SessionManagedWorkflowRunsState | null = null;
let probeRenders = 0;

async function renderHook(sessionId: string | null = 'session-1', serverId: string | null = 'server-a') {
    const { useSessionManagedWorkflowRuns } = await import('./useSessionManagedWorkflowRuns');
    function Probe(): null {
        probeRenders += 1;
        latest = useSessionManagedWorkflowRuns({ sessionId, serverId });
        return null;
    }
    const screen = await renderScreen(React.createElement(Probe));
    await act(async () => {});
    return screen;
}

beforeEach(() => {
    featureDecisions.workflows = { state: 'enabled' };
    latest = null;
    probeRenders = 0;
    storeState.reset();
    accountScope.switchTo({ serverId: 'server-a', accountId: 'account-a' });
    listRuns.mockReset();
});

afterEach(async () => {
    await standardCleanup();
});

describe('useSessionManagedWorkflowRuns', () => {
    it('reflects a control settled through the shared Run row owner without asking the server again', async () => {
        const running = createWorkflowRunSummaryFixture({
            id: 'run-1', state: 'running', revision: 1, origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        listRuns.mockImplementation(async (params): Promise<WorkflowRunListPage> => (
            params.filter?.attention === 'required'
                ? { runs: [], metadataByRunId: {}, nextCursor: undefined }
                : { runs: [running], metadataByRunId: { 'run-1': { kind: 'available', value: { title: 'Nightly review' } } }, nextCursor: undefined }
        ));
        await renderHook();

        expect(latest?.phase).toBe('loaded');
        expect(latest?.runs.map((run) => [run.id, run.state])).toEqual([['run-1', 'running']]);
        expect(latest?.metadataByRunId?.['run-1']).toEqual({ kind: 'available', value: { title: 'Nightly review' } });
        expect(listRuns).toHaveBeenCalledTimes(2);

        // The Run screen settles Pause into the one shared row owner.
        const { getStorage } = await import('@/sync/domains/state/storage');
        await act(async () => {
            getStorage().getState().upsertWorkflowRuns([
                workflowRunRowFromSummary({ ...running, state: 'paused', revision: 2 }),
            ]);
        });

        expect(latest?.runs.map((run) => [run.id, run.state])).toEqual([['run-1', 'paused']]);
        expect(latest?.metadataByRunId?.['run-1']).toEqual({ kind: 'available', value: { title: 'Nightly review' } });
        expect(listRuns).toHaveBeenCalledTimes(2);
    });

    /**
     * A contextual Session surface is not a second place the feature can be
     * on. It answers the same canonical decision the dedicated Workflow routes
     * do and fails closed while that decision is unresolved, so a Home without
     * Workflows neither reads managed Runs nor links to them — while the
     * Session's ordinary one-shot Automations are untouched.
     */
    it.each([
        ['disabled', { state: 'disabled', blockedBy: 'server' }],
        ['unknown', { state: 'unknown' }],
        ['unresolved', null],
    ] as const)('reads no managed Run on a %s Workflows decision', async (_label, decision) => {
        featureDecisions.workflows = decision as Record<string, unknown> | null;
        listRuns.mockResolvedValue({ runs: [], metadataByRunId: {}, nextCursor: undefined });

        await renderHook();

        expect(listRuns).not.toHaveBeenCalled();
        expect(latest?.runs).toEqual([]);
    });

    /**
     * Every Run this Account has read shares one map. A Session section that
     * read the map rerendered for every other Run's exact refresh — including
     * the ones a Run screen settles controls on while this transcript is open.
     */
    it('keeps an unrelated Account Run refresh out of this mounted Session section', async () => {
        const running = createWorkflowRunSummaryFixture({
            id: 'run-1', state: 'running', revision: 1, origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        listRuns.mockImplementation(async (params): Promise<WorkflowRunListPage> => (
            params.filter?.attention === 'required'
                ? { runs: [], metadataByRunId: {}, nextCursor: undefined }
                : {
                    runs: [running],
                    metadataByRunId: { 'run-1': { kind: 'available', value: { title: 'Nightly review' } } },
                    nextCursor: undefined,
                }
        ));
        await renderHook();
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-1']);
        const rendersAfterLoad = probeRenders;

        const { getStorage } = await import('@/sync/domains/state/storage');
        // Another Session's Run refreshing in the one Account-scoped row owner.
        await act(async () => {
            getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(
                createWorkflowRunSummaryFixture({ id: 'run-elsewhere', state: 'succeeded', revision: 3 }),
            )]);
        });

        expect(probeRenders).toBe(rendersAfterLoad);
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-1']);

        await act(async () => {
            getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(
                { ...running, state: 'paused', revision: 2 },
                { kind: 'available', value: { title: 'Nightly review (renamed)' } },
            )]);
        });

        expect(probeRenders).toBe(rendersAfterLoad + 1);
        expect(latest?.runs.map((run) => [run.id, run.state])).toEqual([['run-1', 'paused']]);
        expect(latest?.metadataByRunId?.['run-1'])
            .toEqual({ kind: 'available', value: { title: 'Nightly review (renamed)' } });
    });

    it('re-reads membership and attention on the Account-change wake the collection also observes', async () => {
        const running = createWorkflowRunSummaryFixture({
            id: 'run-1', state: 'running', revision: 1, origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        listRuns.mockImplementation(async (params): Promise<WorkflowRunListPage> => (
            params.filter?.attention === 'required'
                ? { runs: [], metadataByRunId: {}, nextCursor: undefined }
                : { runs: [running], metadataByRunId: {}, nextCursor: undefined }
        ));
        await renderHook();
        expect(latest?.attentionRunIds.has('run-1')).toBe(false);
        expect(listRuns).toHaveBeenCalledTimes(2);

        // A later approval on an off-page invocation: the server's attention
        // predicate is the only owner of that fact, and the wake is how the
        // client learns to ask again.
        listRuns.mockImplementation(async (params): Promise<WorkflowRunListPage> => (
            params.filter?.attention === 'required'
                ? { runs: [running], metadataByRunId: {}, nextCursor: undefined }
                : { runs: [running], metadataByRunId: {}, nextCursor: undefined }
        ));
        await act(async () => {
            publishHomeAccountChange('server-a', ['workflow-run:run-1']);
        });
        await act(async () => {});

        expect(listRuns).toHaveBeenCalledTimes(4);
        expect(latest?.phase).toBe('loaded');
        expect(latest?.attentionRunIds.has('run-1')).toBe(true);

        // Wakes about other Homes or unrelated entities do not refetch.
        await act(async () => {
            publishHomeAccountChange('server-b', ['workflow-run:run-1']);
            publishHomeAccountChange('server-a', ['session:other']);
        });
        await act(async () => {});
        expect(listRuns).toHaveBeenCalledTimes(4);
    });

    /**
     * The attention page is the only owner of "this needs the person", and it
     * is a different keyset from the general page. Reading it for the Review
     * label while taking membership from the general page alone meant an
     * actionable Run that fell outside that page was fetched, acknowledged and
     * then dropped — the one case the server predicate exists for.
     */
    it('renders an actionable Run the general page did not contain', async () => {
        const onPage = createWorkflowRunSummaryFixture({
            id: 'run-on-page', state: 'running', revision: 1,
            origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        const offPage = createWorkflowRunSummaryFixture({
            id: 'run-off-page', state: 'interrupted', revision: 4,
            origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        listRuns.mockImplementation(async (params): Promise<WorkflowRunListPage> => (
            params.filter?.attention === 'required'
                ? {
                    runs: [offPage],
                    metadataByRunId: { 'run-off-page': { kind: 'available', value: { title: 'Release check' } } },
                    nextCursor: undefined,
                }
                : {
                    runs: [onPage],
                    metadataByRunId: { 'run-on-page': { kind: 'available', value: { title: 'Nightly review' } } },
                    nextCursor: undefined,
                }
        ));

        await renderHook();

        // Deterministic order: the general page keeps its server order, then the
        // attention-only ids follow in theirs. Nothing is re-sorted locally.
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-on-page', 'run-off-page']);
        expect(latest?.attentionRunIds.has('run-off-page')).toBe(true);
        expect(latest?.metadataByRunId?.['run-off-page'])
            .toEqual({ kind: 'available', value: { title: 'Release check' } });

        // The attention body landed in the one Account-scoped row owner, so the
        // exact Run route resolves the same body without another read.
        expect(Object.keys(storeState.state.workflowRunsById).sort())
            .toEqual(['run-off-page', 'run-on-page']);
    });

    it('does not duplicate a Run that both pages returned', async () => {
        const shared = createWorkflowRunSummaryFixture({
            id: 'run-1', state: 'interrupted', revision: 2,
            origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        listRuns.mockImplementation(async () => ({
            runs: [shared], metadataByRunId: {}, nextCursor: undefined,
        }));

        await renderHook();

        expect(latest?.runs.map((run) => run.id)).toEqual(['run-1']);
        expect(latest?.attentionRunIds.has('run-1')).toBe(true);
    });

    /**
     * A refresh that fails is not evidence the Session started nothing. The
     * window keeps the membership it already proved and reports the failure
     * separately, which is the package rule for hydrated content.
     */
    it('keeps last-known-good membership when a refresh fails and surfaces the failure separately', async () => {
        const running = createWorkflowRunSummaryFixture({
            id: 'run-1', state: 'running', revision: 1,
            origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        listRuns.mockImplementation(async (params) => (
            params.filter?.attention === 'required'
                ? { runs: [], metadataByRunId: {}, nextCursor: undefined }
                : { runs: [running], metadataByRunId: {}, nextCursor: undefined }
        ));
        await renderHook();
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-1']);
        expect(latest?.refreshFailed).toBe(false);

        listRuns.mockImplementation(async () => { throw new Error('offline'); });
        await act(async () => {
            publishHomeAccountChange('server-a', ['workflow-run:run-1']);
        });
        await act(async () => {});

        expect(latest?.phase).toBe('loaded');
        expect(latest?.refreshFailed).toBe(true);
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-1']);
    });

    it('reports a first read that failed as failed, because nothing is known yet', async () => {
        listRuns.mockImplementation(async () => { throw new Error('offline'); });

        await renderHook();

        expect(latest?.phase).toBe('failed');
        expect(latest?.refreshFailed).toBe(true);
        expect(latest?.runs).toEqual([]);
    });

    it("retires rows and refetches when the Account changes rather than showing another Account's Runs", async () => {
        const accountARun = createWorkflowRunSummaryFixture({
            id: 'run-a', state: 'running', revision: 1, origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        listRuns.mockImplementation(async () => ({ runs: [accountARun], metadataByRunId: {}, nextCursor: undefined }));
        await renderHook();
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-a']);

        const accountBRun = createWorkflowRunSummaryFixture({
            id: 'run-b', state: 'succeeded', revision: 1, origin: { kind: 'direct', originSessionId: 'session-1' },
        });
        const accountB = createDeferred<WorkflowRunListPage>();
        listRuns.mockImplementation(() => accountB.promise);
        await act(async () => {
            // The Account lifetime owner clears the shared rows on a switch.
            storeState.reset();
            accountScope.switchTo({ serverId: 'server-a', accountId: 'account-b' });
        });
        // Nothing of Account A survives the switch, before B has answered.
        expect(latest?.runs).toEqual([]);
        accountB.resolve({ runs: [accountBRun], metadataByRunId: {}, nextCursor: undefined });
        await act(async () => {});
        expect(latest?.runs.map((run) => run.id)).toEqual(['run-b']);
    });
});
