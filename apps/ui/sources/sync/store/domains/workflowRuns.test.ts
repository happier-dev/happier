import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';

import {
    createAutomationRunFixture,
    createWorkflowInvocationIndexFixture,
    createWorkflowRunSummaryFixture,
    createWorkflowDefinitionFixture,
} from '@/dev/testkit/fixtures/workflowRunFixtures';
import type { AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';

import {
    createWorkflowRunsDomain,
    mergeWorkflowRunBodies,
    releaseWorkflowRunBodies,
    resolveAutomationRunProjections,
    resolveVisibleWorkflowInvocations,
    resolveWorkflowRunRows,
    selectWorkflowRunFirstFailedInvocation,
    selectWorkflowRunWindowInvocations,
    workflowRunRowFromAutomationRun,
    workflowRunRowFromSummary,
} from './workflowRuns';

type State = ReturnType<typeof createWorkflowRunsDomain>;

function createHarness(): { state: State; get: () => State } {
    let state = {} as State;
    const get = () => state;
    const set = (updater: (draft: State) => State) => {
        state = updater(state);
    };
    state = createWorkflowRunsDomain({ get, set } as never);
    return { state, get };
}

function automationRun(input: Readonly<{
    id: string;
    automationId?: string;
    revision?: number;
    state?: AutomationDefinitionRun['state'];
    updatedAt?: number;
}>): AutomationDefinitionRun {
    return createAutomationRunFixture({
        id: input.id,
        ...(input.automationId === undefined ? {} : { automationId: input.automationId }),
        ...(input.revision === undefined ? {} : { revision: input.revision }),
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    });
}

function summary(input: Readonly<{
    id: string;
    revision?: number;
    state?: 'queued' | 'running' | 'succeeded' | 'failed' | 'paused' | 'interrupted';
    origin?: 'automation' | 'direct';
    updatedAt?: string;
}>) {
    return createWorkflowRunSummaryFixture({
        id: input.id,
        ...(input.revision === undefined ? {} : { revision: input.revision }),
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
        ...(input.origin === 'direct'
            ? { origin: { kind: 'direct' as const } }
            : {}),
    });
}

describe('workflow run body store', () => {
    it('retains result condition provenance through lean index updates and late suppressed observations', () => {
        const harness = createHarness();
        const index = createWorkflowInvocationIndexFixture({ id: 'report', runId: 'run-1', contentRevision: '3', lifecycle: 'completed' });
        const put = (invocation: Parameters<ReturnType<typeof harness.get>['upsertWorkflowRunInvocation']>[0]['invocation']) =>
            harness.get().upsertWorkflowRunInvocation({ runId: index.runId, invocation, parentRevision: 3 });
        put({ ...index, notificationCondition: 'suppressed', provenanceLoaded: true });
        put(index);
        expect(harness.get().workflowRunInvocationsByRunId[index.runId]?.factsById[index.id]).toMatchObject({ notificationCondition: 'suppressed' });
        put({ ...index, notificationCondition: 'matched', provenanceLoaded: true });
        put({ ...index, contentRevision: '1', notificationCondition: 'suppressed', provenanceLoaded: true });
        expect(harness.get().workflowRunInvocationsByRunId[index.runId]?.factsById[index.id]).toMatchObject({ contentRevision: '3', notificationCondition: 'matched' });
    });
    it('hydrates an immutable authored ordinal without rolling back a newer invocation fact', () => {
        const harness = createHarness();
        const latest = createWorkflowInvocationIndexFixture({ id: 'step', runId: 'run-1', contentRevision: '3', lifecycle: 'completed' });
        harness.get().upsertWorkflowRunInvocation({ runId: latest.runId, invocation: latest, parentRevision: 3 });
        harness.get().upsertWorkflowRunInvocation({ runId: latest.runId,
            invocation: { ...latest, contentRevision: '1', lifecycle: 'running', stepOrdinal: '3' }, parentRevision: 1 });
        expect(harness.get().workflowRunInvocationsByRunId[latest.runId]?.factsById[latest.id])
            .toMatchObject({ contentRevision: '3', lifecycle: 'completed', stepOrdinal: '3' });
        harness.get().upsertWorkflowRunInvocation({ runId: latest.runId,
            invocation: { ...latest, contentRevision: '4' }, parentRevision: 4 });
        expect(harness.get().workflowRunInvocationsByRunId[latest.runId]?.factsById[latest.id]?.stepOrdinal).toBe('3');
    });
    it('keeps an unrelated list window stable when another Run is removed', () => {
        const harness = createHarness();
        const removed = createWorkflowRunSummaryFixture({ id: 'removed' });
        const retained = createWorkflowRunSummaryFixture({ id: 'retained' });
        harness.get().applyWorkflowRunListPage({ windowId: 'all', runs: [removed, retained], nextCursor: null, mode: 'replace' });
        harness.get().applyWorkflowRunListPage({ windowId: 'active', runs: [retained], nextCursor: 'tail', mode: 'replace' });
        const active = harness.get().workflowRunListWindows.active;
        harness.get().removeWorkflowRun(removed.id);
        expect(harness.get().workflowRunListWindows.active).toBe(active);
        expect(harness.get().workflowRunListWindows.all?.runIds).toEqual([retained.id]);
        harness.get().removeWorkflowRun(retained.id);
        expect(harness.get().workflowRunListWindows.active?.runIds).toEqual([]);
    });
    it('does not notify real store subscribers for unchanged list, invocation-page or exact-read echoes', () => {
        const store = createStore<State>((set, get) => createWorkflowRunsDomain({ set, get }));
        const run = summary({ id: 'run-1', revision: 4 });
        const invocation = createWorkflowInvocationIndexFixture({ contentRevision: '4' });
        const list = { windowId: 'all' as const, runs: [run], nextCursor: null, mode: 'replace' as const };
        const page = { runId: run.id, invocations: [invocation], nextCursor: null, parentRevision: 4, mode: 'replace' as const };
        store.getState().applyWorkflowRunListPage(list);
        store.getState().applyWorkflowRunInvocationPage(page);
        const before = store.getState();
        let notifications = 0;
        const unsubscribe = store.subscribe(() => { notifications += 1; });
        store.getState().applyWorkflowRunListPage(structuredClone(list));
        store.getState().applyWorkflowRunInvocationPage(structuredClone(page));
        store.getState().upsertWorkflowRunInvocation({ runId: run.id, invocation: structuredClone(invocation), parentRevision: 4 });
        expect(notifications).toBe(0);
        expect(store.getState()).toBe(before);
        store.getState().upsertWorkflowRunInvocation({ runId: run.id, invocation: { ...invocation, contentRevision: '5', lifecycle: 'completed' }, parentRevision: 4 });
        expect(notifications).toBe(1);
        expect(store.getState().workflowRunInvocationsByRunId[run.id]?.factsById[invocation.id]?.lifecycle).toBe('completed');
        unsubscribe();
    });

    it('keeps a window projection stable when only a fact outside that window changes', () => {
        const harness = createHarness();
        const held = createWorkflowInvocationIndexFixture({ id: 'held', lifecycle: 'waiting_for_review' });
        const sibling = createWorkflowInvocationIndexFixture({ id: 'sibling', lifecycle: 'running' });
        harness.get().applyWorkflowRunInvocationPage({ runId: 'run-1', window: 'attention', invocations: [held], nextCursor: null, parentRevision: 4, mode: 'replace' });
        const before = selectWorkflowRunWindowInvocations(harness.get().workflowRunInvocationsByRunId['run-1'], 'attention');
        harness.get().upsertWorkflowRunInvocation({ runId: 'run-1', invocation: sibling, parentRevision: 4 });
        expect(selectWorkflowRunWindowInvocations(harness.get().workflowRunInvocationsByRunId['run-1'], 'attention')).toBe(before);
        harness.get().upsertWorkflowRunInvocation({ runId: 'run-1', invocation: { ...held, contentRevision: '2', lifecycle: 'completed' }, parentRevision: 4 });
        expect(selectWorkflowRunWindowInvocations(harness.get().workflowRunInvocationsByRunId['run-1'], 'attention')).toEqual([]);
    });

    it('publishes an invocation page and all opened details atomically and suppresses unchanged echoes', () => {
        const store = createStore<State>((set, get) => createWorkflowRunsDomain({ set, get }));
        const invocations = ['first', 'second', 'third'].map((id, ordinal) => createWorkflowInvocationIndexFixture({
            id, sequence: String(ordinal), contentRevision: '4', lifecycle: 'completed',
        }));
        const invocationDetails = invocations.map(index => ({ index, parentRevision: 4,
            progress: { kind: 'happier.workflow-progress.v1' as const, blockKind: 'step' as const,
                invocationPath: { blockId: 'analyze', scope: [] }, attempt: index.attempt,
                logicalInvocationRecordId: index.id, result: { output: index.id } },
        }));
        const page = { runId: 'run-1', invocations, invocationDetails,
            nextCursor: 'next-page', parentRevision: 4, mode: 'replace' as const };
        const publications: State[] = [];
        const unsubscribe = store.subscribe(state => { publications.push(state); });
        store.getState().applyWorkflowRunInvocationPage(page);
        expect(publications).toHaveLength(1);
        const published = publications[0]!.workflowRunInvocationsByRunId['run-1']!;
        expect(published.history.invocationIds).toEqual(invocations.map(index => index.id));
        expect(invocations.map(index => published.factsById[index.id]?.opened)).toEqual(invocationDetails);
        const current = store.getState();
        store.getState().applyWorkflowRunInvocationPage(structuredClone(page));
        expect(publications).toHaveLength(1);
        expect(store.getState()).toBe(current);
        unsubscribe();
    });

    it('keeps fresher invocation content when a page carries stale opened details', () => {
        const store = createStore<State>((set, get) => createWorkflowRunsDomain({ set, get }));
        const index = createWorkflowInvocationIndexFixture({ contentRevision: '9007199254740993', lifecycle: 'completed' });
        const opened = { index, parentRevision: 4, progress: { kind: 'happier.workflow-progress.v1' as const,
            blockKind: 'step' as const, invocationPath: { blockId: 'analyze', scope: [] }, attempt: index.attempt,
            logicalInvocationRecordId: index.id, result: { output: 'fresh' } } };
        store.getState().applyWorkflowRunInvocationPage({ runId: 'run-1', window: 'attention',
            invocations: [{ ...index, contentRevision: '9007199254740992', lifecycle: 'waiting_for_approval' }],
            nextCursor: null, parentRevision: 4, mode: 'replace' });
        store.getState().applyWorkflowRunInvocationPage({ runId: 'run-1', invocations: [index], invocationDetails: [opened],
            nextCursor: null, parentRevision: 4, mode: 'replace' });
        expect(store.getState().workflowRunInvocationsByRunId['run-1']!.attention.invocationIds).toEqual([]);
        const known = store.getState().workflowRunInvocationsByRunId['run-1']!.factsById[index.id];
        const stale = { index: { ...index, contentRevision: '9007199254740992', lifecycle: 'running' as const },
            parentRevision: 4, progress: { ...opened.progress, result: { output: 'stale' } } };
        // The public page may already carry a newer index while its private
        // observation is delayed; content follows the observation's own token.
        store.getState().applyWorkflowRunInvocationPage({ runId: 'run-1', invocations: [{ ...index, contentRevision: '9007199254740994' }],
            invocationDetails: [stale], nextCursor: null, parentRevision: 4, mode: 'refresh' });
        const fact = store.getState().workflowRunInvocationsByRunId['run-1']!.factsById[index.id];
        expect(known?.opened).toEqual(opened);
        expect(fact?.contentRevision).toBe('9007199254740994');
        expect(fact?.lifecycle).toBe('completed');
        expect(fact?.opened).toBe(known?.opened);
    });

    it('preserves exact recovery evidence on a same-token content page but not a changed parent revision', () => {
        const store = createStore<State>((set, get) => createWorkflowRunsDomain({ set, get }));
        const index = createWorkflowInvocationIndexFixture({ contentRevision: '4', lifecycle: 'failed' });
        const unavailable = { kind: 'unavailable' as const, reason: 'workspace_unavailable' as const };
        const recoveryAvailability = { reattach: unavailable, retry: unavailable,
            continueSameConversation: { kind: 'available' as const }, continueFreshAgent: unavailable, restoreWorkspace: unavailable };
        const contentOnly = { index, parentRevision: 4, progress: { kind: 'happier.workflow-progress.v1' as const,
            blockKind: 'step' as const, invocationPath: { blockId: 'analyze', scope: [] }, attempt: index.attempt,
            logicalInvocationRecordId: index.id, result: { output: 'failed output' } } };
        store.getState().upsertWorkflowRunInvocation({ runId: 'run-1',
            invocation: { ...index, opened: { ...contentOnly, recoveryAvailability } }, parentRevision: 4 });
        const page = { runId: 'run-1', invocations: [index], invocationDetails: [contentOnly],
            nextCursor: null, parentRevision: 4, mode: 'replace' as const };
        store.getState().applyWorkflowRunInvocationPage(page);
        expect(store.getState().workflowRunInvocationsByRunId['run-1']!.factsById[index.id]?.opened?.recoveryAvailability)
            .toEqual(recoveryAvailability);
        store.getState().applyWorkflowRunInvocationPage({ ...page, parentRevision: 5,
            invocationDetails: [{ ...contentOnly, parentRevision: 5 }] });
        expect(store.getState().workflowRunInvocationsByRunId['run-1']!.factsById[index.id]?.opened?.recoveryAvailability)
            .toBeUndefined();
        store.getState().upsertWorkflowRunInvocation({ runId: 'run-1',
            invocation: { ...index, opened: { ...contentOnly, parentRevision: 5, recoveryAvailability } }, parentRevision: 5 });
        const nextIndex = { ...index, contentRevision: '5' };
        store.getState().applyWorkflowRunInvocationPage({ ...page, invocations: [nextIndex], parentRevision: 5,
            invocationDetails: [{ ...contentOnly, index: nextIndex, parentRevision: 5 }] });
        expect(store.getState().workflowRunInvocationsByRunId['run-1']!.factsById[index.id]?.opened?.recoveryAvailability)
            .toBeUndefined();
    });

    it('holds Automation attention in the shared row owner and removes it on a complete refresh', () => {
        const harness = createHarness();
        const failed = createAutomationRunFixture({ state: 'failed', producedSessionId: null });
        harness.get().applyWorkflowRunListPage({ windowId: 'automationAttention', runs: [], automationRuns: [failed], nextCursor: null, mode: 'replace' });
        expect(harness.get().workflowRunListWindows.automationAttention?.runIds).toEqual([failed.id]);
        expect(harness.get().workflowRunsById[failed.id]?.automation).toEqual(failed);
        const settled = { ...failed, state: 'cancelled' as const, revision: failed.revision + 1 };
        harness.get().upsertWorkflowRuns([workflowRunRowFromAutomationRun(settled)]);
        harness.get().applyWorkflowRunListPage({ windowId: 'automationAttention', runs: [], automationRuns: [], nextCursor: null, mode: 'refresh' });
        expect(harness.get().workflowRunListWindows.automationAttention?.runIds).toEqual([]);
        expect(harness.get().workflowRunsById[failed.id]?.automation).toBe(settled);
    });
    it('retains opened Run content when a list refresh observes the same Run', () => {
        const harness = createHarness();
        const run = summary({ id: 'run-1', revision: 4 });
        const definition = createWorkflowDefinitionFixture();
        const detail = { run, callerAccess: { canEdit: true }, definition, authoredDefinition: definition, checkpoint: null, acceptedContext: {
            startedBy: 'user' as const,
            source: { kind: 'inline' as const }, inputs: {}, machineId: run.machineId,
            executionTarget: { kind: 'session' as const },
            materializedLeaves: [],
            frozenChildren: {},
            workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' as const },
        } };
        harness.get().upsertWorkflowRuns([{ ...workflowRunRowFromSummary(run), detail }]);
        harness.get().upsertWorkflowRuns([workflowRunRowFromSummary({ ...run, revision: 5 })]);
        expect(harness.get().workflowRunsById['run-1']).toHaveProperty('detail', detail);
    });

    it('keeps an opened invocation observation on an equal-token index refresh', () => {
        const harness = createHarness();
        const index = createWorkflowInvocationIndexFixture({ contentRevision: '4' });
        const opened = { index, parentRevision: 1, progress: { kind: 'happier.workflow-progress.v1' as const,
            blockKind: 'step' as const, invocationPath: { blockId: 'analyze', scope: [] }, attempt: '0', logicalInvocationRecordId: index.id } };
        harness.get().upsertWorkflowRunInvocation({ runId: 'run-1', invocation: { ...index, opened }, parentRevision: 1 });
        harness.get().applyWorkflowRunInvocationPage({ runId: 'run-1', invocations: [{ ...index }], nextCursor: null, parentRevision: 1, mode: 'replace' });
        expect(harness.get().workflowRunInvocationsByRunId['run-1']?.factsById[index.id]).toHaveProperty('opened', opened);
    });

    it('keeps the newest invocation fact when a delayed page or exact response has the same parent revision', () => {
        const harness = createHarness();
        const latest = createWorkflowInvocationIndexFixture({
            contentRevision: '9007199254740993', lifecycle: 'completed',
        });
        const stale = createWorkflowInvocationIndexFixture({
            contentRevision: '9007199254740992', lifecycle: 'waiting_for_review',
        });
        harness.get().applyWorkflowRunInvocationPage({
            runId: 'run-1', invocations: [latest], nextCursor: null, parentRevision: 4, mode: 'replace',
        });
        harness.get().applyWorkflowRunInvocationPage({
            runId: 'run-1', invocations: [stale], nextCursor: null, parentRevision: 4, mode: 'refresh',
        });
        const history = () => selectWorkflowRunWindowInvocations(harness.get().workflowRunInvocationsByRunId['run-1'], 'history');
        expect(history()[0]).toBe(latest);
        harness.get().upsertWorkflowRunInvocation({ runId: 'run-1', invocation: stale, parentRevision: 4 });
        expect(history()[0]).toBe(latest);
        harness.get().applyWorkflowRunInvocationPage({
            runId: 'run-1', invocations: [stale], nextCursor: null, parentRevision: 4, mode: 'replace',
        });
        expect(history()[0]).toBe(latest);
    });

    it('refreshes server attention independently of unchanged parent revision and timestamp', () => {
        const run = summary({ id: 'run-1', revision: 4 });
        const initial = mergeWorkflowRunBodies({}, [workflowRunRowFromSummary({ ...run, attentionRequired: false })]);
        const needsYou = mergeWorkflowRunBodies(initial, [workflowRunRowFromSummary({ ...run, attentionRequired: true })]);
        expect(needsYou['run-1']?.summary).toMatchObject({ attentionRequired: true, revision: 4 });
        const settled = mergeWorkflowRunBodies(needsYou, [workflowRunRowFromSummary({ ...run, attentionRequired: false })]);
        expect(settled['run-1']?.summary).toMatchObject({ attentionRequired: false, revision: 4 });
        expect(mergeWorkflowRunBodies(settled, [workflowRunRowFromSummary({ ...run, attentionRequired: false })])).toBe(settled);
        expect(mergeWorkflowRunBodies(settled, [workflowRunRowFromSummary({ ...run, revision: 3, attentionRequired: true })])).toBe(settled);
        expect(mergeWorkflowRunBodies(needsYou, [workflowRunRowFromSummary(run)])).toBe(needsYou);
    });

    it('retains an opened Where across control projections and clears it on an unreadable list projection', () => {
        const run = summary({ id: 'run-1', revision: 4 });
        const where = { machineId: run.machineId, directory: '/repo', workspaceRefId: 'workspace-1' };
        const initial = mergeWorkflowRunBodies({}, [workflowRunRowFromSummary({ ...run, where })]);
        const controlled = mergeWorkflowRunBodies(initial, [workflowRunRowFromSummary({ ...run, revision: 5 })]);
        expect(controlled['run-1']?.summary).toHaveProperty('where', where);
        const unreadable = mergeWorkflowRunBodies(controlled, [workflowRunRowFromSummary({ ...run, revision: 5, where: null })]);
        expect(unreadable['run-1']?.summary).toHaveProperty('where', null);
        expect(mergeWorkflowRunBodies(unreadable, [workflowRunRowFromSummary({ ...run, revision: 5, where: null })])).toBe(unreadable);
        expect(mergeWorkflowRunBodies(unreadable, [workflowRunRowFromSummary({ ...run, revision: 3, where })])).toBe(unreadable);
    });

    it('retains private starter and authored progress across control rows, but clears explicitly unreadable content', () => {
        const run = summary({ id: 'run-1', revision: 4 });
        const projected = { ...run, startedBy: 'user' as const, stepProgress: { completed: 1, total: 3 } };
        const initial = mergeWorkflowRunBodies({}, [workflowRunRowFromSummary(projected)]);
        const controlled = mergeWorkflowRunBodies(initial, [workflowRunRowFromSummary({ ...run, revision: 5 })]);
        expect(controlled['run-1']?.summary).toMatchObject({ startedBy: 'user', stepProgress: { completed: 1, total: 3 } });
        const unreadable = mergeWorkflowRunBodies(controlled, [workflowRunRowFromSummary({ ...run, revision: 5, startedBy: null, stepProgress: null })]);
        expect(unreadable['run-1']?.summary).toMatchObject({ startedBy: null, stepProgress: null });
        expect(mergeWorkflowRunBodies(unreadable, [workflowRunRowFromSummary(projected)])).toBe(unreadable);
    });

    it('orders authored progress by the existing root observation even when parent revision and time do not move', () => {
        const run = summary({ id: 'run-1', revision: 4 });
        const progress = (contentRevision: string, completed: number) => workflowRunRowFromSummary({
            ...run, stepProgress: { completed, total: 3 },
            stepProgressCurrentness: { recordId: 'root-1', attempt: '0', contentRevision },
        });
        const latest = mergeWorkflowRunBodies({}, [progress('9007199254740993', 1)]);
        expect(mergeWorkflowRunBodies(latest, [progress('9007199254740992', 0)])).toBe(latest);
        // A new current retry can legitimately reduce completion, not merely increase it.
        const retry = mergeWorkflowRunBodies(latest, [progress('9007199254740994', 0)]);
        expect(retry['run-1']?.summary?.stepProgress?.completed).toBe(0);
        const control = mergeWorkflowRunBodies(retry, [workflowRunRowFromSummary({ ...run, revision: 5 })]);
        expect(control['run-1']?.summary?.stepProgressCurrentness?.contentRevision).toBe('9007199254740994');
    });

    it('starts empty', () => {
        expect(createHarness().get().workflowRunsById).toEqual({});
        expect(createHarness().get().workflowRunListWindows).toEqual({});
    });

    it('keeps paged collection membership as ids beside the shared bodies', () => {
        const harness = createHarness();
        const first = summary({ id: 'run-1' });
        const second = summary({ id: 'run-2' });

        harness.get().applyWorkflowRunListPage({
            windowId: 'attention', runs: [first], nextCursor: 'next', mode: 'replace',
        });
        harness.get().applyWorkflowRunListPage({
            windowId: 'attention', runs: [second, first], nextCursor: null, mode: 'append',
        });

        expect(harness.get().workflowRunListWindows.attention).toEqual({
            runIds: ['run-1', 'run-2'], nextCursor: null, loaded: true,
        });
        expect(resolveWorkflowRunRows(
            harness.get().workflowRunsById,
            harness.get().workflowRunListWindows.attention!.runIds,
        ).map((row) => row.id)).toEqual(['run-1', 'run-2']);
    });

    it('upserts an exact off-page invocation without replacing loaded history', () => {
        const harness = createHarness();
        const first = createWorkflowInvocationIndexFixture({ id: 'invocation-1', sequence: '1' });
        const second = createWorkflowInvocationIndexFixture({ id: 'invocation-2', sequence: '2' });
        const exact = createWorkflowInvocationIndexFixture({
            id: 'invocation-off-page',
            sequence: '99',
            lifecycle: 'waiting_for_approval',
        });

        harness.get().applyWorkflowRunInvocationPage({
            runId: 'run-1',
            invocations: [first, second],
            nextCursor: 'page-2',
            parentRevision: 4,
            mode: 'replace',
        });
        harness.get().upsertWorkflowRunInvocation({
            runId: 'run-1',
            invocation: exact,
            parentRevision: 7,
        });

        expect(harness.get().workflowRunInvocationsByRunId['run-1']?.history).toEqual({
            invocationIds: ['invocation-1', 'invocation-2', 'invocation-off-page'],
            nextCursor: 'page-2',
            parentRevision: 7,
            loaded: true,
        });
        expect(selectWorkflowRunWindowInvocations(harness.get().workflowRunInvocationsByRunId['run-1'], 'history'))
            .toEqual([first, second, exact]);
    });

    it('retains a 500-row paged history without introducing a UI product limit', () => {
        const harness = createHarness();
        for (let page = 0; page < 5; page += 1) {
            harness.get().applyWorkflowRunListPage({
                windowId: 'all',
                runs: Array.from({ length: 100 }, (_unused, offset) => summary({ id: `run-${page * 100 + offset}` })),
                nextCursor: page === 4 ? null : `page-${page + 1}`,
                mode: page === 0 ? 'replace' : 'append',
            });
        }
        expect(harness.get().workflowRunListWindows.all?.runIds).toHaveLength(500);
        expect(Object.keys(harness.get().workflowRunsById)).toHaveLength(500);
    });

    it('resolves an exact Run by runId alone, with no origin window loaded', () => {
        const harness = createHarness();
        // A Run whose origin Automation this client has never listed. The row
        // owner is keyed by `runId`, so an exact read reaches it without the
        // caller supplying (or knowing) an `automationId`.
        const row = workflowRunRowFromSummary(summary({ id: 'run-exact', origin: 'direct' }));

        harness.get().upsertWorkflowRuns([row]);

        expect(harness.get().workflowRunsById['run-exact']).toBe(row);
        expect(resolveWorkflowRunRows(harness.get().workflowRunsById, ['run-exact'])).toEqual([row]);
    });

    it('keeps both transport projections on one row instead of overwriting one with the other', () => {
        const harness = createHarness();
        const rest = automationRun({ id: 'run-1', revision: 2, state: 'running' });
        const action = summary({ id: 'run-1', revision: 3, state: 'interrupted' });

        harness.get().upsertWorkflowRuns([workflowRunRowFromAutomationRun(rest)]);
        harness.get().upsertWorkflowRuns([workflowRunRowFromSummary(action)]);

        const row = harness.get().workflowRunsById['run-1']!;
        // The workflow Action carries `interrupted`, which the Automation state
        // vocabulary cannot express, and the Automation projection carries
        // trigger/dispatch facts the Action does not. Neither is discarded.
        expect(row.summary).toBe(action);
        expect(row.automation).toBe(rest);
        expect(row.revision).toBe(3);
    });

    it('advances each projection independently by its own revision', () => {
        const harness = createHarness();
        const staleRest = automationRun({ id: 'run-1', revision: 5, state: 'running' });
        harness.get().upsertWorkflowRuns([
            workflowRunRowFromAutomationRun(staleRest),
            workflowRunRowFromSummary(summary({ id: 'run-1', revision: 5 })),
        ]);

        // A delayed Automation page at an older revision must not regress the
        // stored projection, and must not touch the workflow projection at all.
        harness.get().upsertWorkflowRuns([
            workflowRunRowFromAutomationRun(automationRun({ id: 'run-1', revision: 4, state: 'queued' })),
        ]);
        expect(harness.get().workflowRunsById['run-1']?.automation).toBe(staleRest);

        const fresherRest = automationRun({ id: 'run-1', revision: 6, state: 'succeeded' });
        harness.get().upsertWorkflowRuns([workflowRunRowFromAutomationRun(fresherRest)]);
        const row = harness.get().workflowRunsById['run-1']!;
        expect(row.automation).toBe(fresherRest);
        expect(row.summary?.revision).toBe(5);
        expect(row.revision).toBe(6);
    });

    it('retains the stored row when a refresh restates the same revision', () => {
        const harness = createHarness();
        const row = workflowRunRowFromSummary(summary({ id: 'run-1', revision: 4 }));
        harness.get().upsertWorkflowRuns([row]);

        harness.get().upsertWorkflowRuns([workflowRunRowFromSummary(summary({ id: 'run-1', revision: 4 }))]);

        expect(harness.get().workflowRunsById['run-1']).toBe(row);
    });

    it('does not let an older delayed list replace newer exact private metadata', () => {
        const harness = createHarness();
        const exact = summary({ id: 'run-1', revision: 5, updatedAt: '2026-09-08T10:00:05.000Z' });
        const delayed = summary({ id: 'run-1', revision: 4, updatedAt: '2026-09-08T10:00:04.000Z' });
        const available = { kind: 'available' as const, value: { title: 'Frozen exact title' } };

        harness.get().upsertWorkflowRuns([workflowRunRowFromSummary(exact, available)]);
        harness.get().applyWorkflowRunListPage({
            windowId: 'all',
            runs: [delayed],
            metadataByRunId: { 'run-1': { kind: 'unavailable', reason: 'content_unavailable' } },
            nextCursor: null,
            mode: 'replace',
        });

        expect(harness.get().workflowRunsById['run-1']?.summary).toBe(exact);
        expect(harness.get().workflowRunsById['run-1']?.metadata).toBe(available);
    });

    it('upgrades unavailable private metadata when an equal-revision read can open it', () => {
        const harness = createHarness();
        const listed = summary({ id: 'run-1', revision: 5, updatedAt: '2026-09-08T10:00:05.000Z' });
        const exact = summary({ id: 'run-1', revision: 5, updatedAt: '2026-09-08T10:00:04.000Z' });
        const available = { kind: 'available' as const, value: { title: 'Frozen exact title' } };

        harness.get().upsertWorkflowRuns([
            workflowRunRowFromSummary(listed, { kind: 'unavailable', reason: 'content_unavailable' }),
        ]);
        harness.get().upsertWorkflowRuns([workflowRunRowFromSummary(exact, available)]);

        expect(harness.get().workflowRunsById['run-1']?.summary).toBe(listed);
        expect(harness.get().workflowRunsById['run-1']?.metadata).toBe(available);
    });

    it('keeps private metadata when a newer control summary does not carry that projection', () => {
        const harness = createHarness();
        const available = { kind: 'available' as const, value: { title: 'Frozen exact title' } };

        harness.get().upsertWorkflowRuns([
            workflowRunRowFromSummary(summary({ id: 'run-1', revision: 5 }), available),
        ]);
        harness.get().upsertWorkflowRuns([
            workflowRunRowFromSummary(summary({ id: 'run-1', revision: 6, state: 'paused' })),
        ]);

        expect(harness.get().workflowRunsById['run-1']?.summary?.revision).toBe(6);
        expect(harness.get().workflowRunsById['run-1']?.metadata).toBe(available);
    });

    it('preserves the map identity when nothing changed', () => {
        const previous = { 'run-1': workflowRunRowFromSummary(summary({ id: 'run-1', revision: 2 })) };

        const next = mergeWorkflowRunBodies(previous, [
            workflowRunRowFromSummary(summary({ id: 'run-1', revision: 2 })),
        ]);

        expect(next).toBe(previous);
    });

    it('orders by the projection carrying the newest revision', () => {
        const harness = createHarness();
        harness.get().upsertWorkflowRuns([
            workflowRunRowFromAutomationRun(automationRun({ id: 'run-1', revision: 1, updatedAt: 10 })),
        ]);
        harness.get().upsertWorkflowRuns([
            workflowRunRowFromSummary(summary({ id: 'run-1', revision: 2, updatedAt: '2026-09-08T10:00:05.000Z' })),
        ]);

        expect(harness.get().workflowRunsById['run-1']?.updatedAt).toBe(Date.parse('2026-09-08T10:00:05.000Z'));
    });

    it('releases only the released rows no other window still references', () => {
        const previous = {
            'run-a': workflowRunRowFromAutomationRun(automationRun({ id: 'run-a' })),
            'run-b': workflowRunRowFromAutomationRun(automationRun({ id: 'run-b' })),
            // Held by an exact read rather than the released window.
            'run-exact': workflowRunRowFromSummary(summary({ id: 'run-exact', origin: 'direct' })),
        };

        const next = releaseWorkflowRunBodies({
            runsById: previous,
            releasedRunIds: ['run-a', 'run-b'],
            retainedRunIds: new Set(['run-b']),
        });

        expect(Object.keys(next).sort()).toEqual(['run-b', 'run-exact']);
    });

    it('releases an Automation projection without deleting the same Run read through workflow Actions', () => {
        const metadata = { kind: 'available' as const, value: { title: 'Frozen shared title' } };
        const exact = workflowRunRowFromSummary(
            summary({ id: 'run-shared', origin: 'direct', revision: 3 }),
            metadata,
        );
        const automation = workflowRunRowFromAutomationRun(automationRun({ id: 'run-shared', revision: 2 }));
        const previous = mergeWorkflowRunBodies(
            mergeWorkflowRunBodies({}, [exact]),
            [automation],
        );

        const next = releaseWorkflowRunBodies({
            runsById: previous,
            releasedRunIds: ['run-shared'],
            retainedRunIds: new Set(),
        });

        expect(next['run-shared']?.summary).toBe(exact.summary);
        expect(next['run-shared']?.metadata).toBe(metadata);
        expect(next['run-shared']?.automation).toBeNull();
        expect(next['run-shared']?.revision).toBe(3);
    });

    describe('loaded-span refresh', () => {
        function seedTwoPages(harness: ReturnType<typeof createHarness>) {
            harness.get().applyWorkflowRunListPage({
                windowId: 'all',
                runs: [
                    createWorkflowRunSummaryFixture({ id: 'run-5', createdAt: '2026-09-08T10:00:05.000Z' }),
                    createWorkflowRunSummaryFixture({ id: 'run-4', createdAt: '2026-09-08T10:00:04.000Z' }),
                ],
                nextCursor: 'page-2',
                mode: 'replace',
            });
            harness.get().applyWorkflowRunListPage({
                windowId: 'all',
                runs: [
                    createWorkflowRunSummaryFixture({ id: 'run-3', createdAt: '2026-09-08T10:00:03.000Z' }),
                    createWorkflowRunSummaryFixture({ id: 'run-2', createdAt: '2026-09-08T10:00:02.000Z' }),
                ],
                nextCursor: 'page-3',
                mode: 'append',
            });
        }

        it('merges a refreshed first page into a longer traversal without dropping later pages', () => {
            const harness = createHarness();
            seedTwoPages(harness);

            // The background invalidation re-reads page one only. Everything the
            // reader paged to is strictly older than that page's oldest row, so
            // it survives — together with the continuation for the END of the
            // traversal, which is the only cursor that can extend it.
            harness.get().applyWorkflowRunListPage({
                windowId: 'all',
                runs: [
                    createWorkflowRunSummaryFixture({ id: 'run-5', createdAt: '2026-09-08T10:00:05.000Z', revision: 9, state: 'succeeded' }),
                    createWorkflowRunSummaryFixture({ id: 'run-4', createdAt: '2026-09-08T10:00:04.000Z' }),
                ],
                nextCursor: 'page-2',
                mode: 'refresh',
            });

            expect(harness.get().workflowRunListWindows.all).toEqual({
                runIds: ['run-5', 'run-4', 'run-3', 'run-2'],
                nextCursor: 'page-3',
                loaded: true,
            });
            expect(harness.get().workflowRunsById['run-5']?.summary?.state).toBe('succeeded');
        });

        it('admits a newly created Run at the head while keeping every loaded row', () => {
            const harness = createHarness();
            seedTwoPages(harness);

            harness.get().applyWorkflowRunListPage({
                windowId: 'all',
                runs: [
                    createWorkflowRunSummaryFixture({ id: 'run-6', createdAt: '2026-09-08T10:00:06.000Z' }),
                    createWorkflowRunSummaryFixture({ id: 'run-5', createdAt: '2026-09-08T10:00:05.000Z' }),
                ],
                nextCursor: 'page-2',
                mode: 'refresh',
            });

            // `run-4` was only pushed off page one by the new Run; it is still
            // in this filter and the reader can still see it.
            expect(harness.get().workflowRunListWindows.all?.runIds)
                .toEqual(['run-6', 'run-5', 'run-4', 'run-3', 'run-2']);
            expect(harness.get().workflowRunListWindows.all?.nextCursor).toBe('page-3');
        });

        it('drops a loaded row the refreshed span proves has left this filter', () => {
            const harness = createHarness();
            seedTwoPages(harness);

            // `Needs you` stops matching `run-5`. The refreshed page reaches
            // further back than `run-5` and does not contain it, so the window
            // must not keep offering a row that no longer needs anyone.
            harness.get().applyWorkflowRunListPage({
                windowId: 'all',
                runs: [
                    createWorkflowRunSummaryFixture({ id: 'run-6', createdAt: '2026-09-08T10:00:06.000Z' }),
                    createWorkflowRunSummaryFixture({ id: 'run-4', createdAt: '2026-09-08T10:00:04.000Z' }),
                ],
                nextCursor: 'page-2',
                mode: 'refresh',
            });

            expect(harness.get().workflowRunListWindows.all?.runIds)
                .toEqual(['run-6', 'run-4', 'run-3', 'run-2']);
        });

        it('reseeds when the refreshed page exhausts the filter', () => {
            const harness = createHarness();
            seedTwoPages(harness);

            harness.get().applyWorkflowRunListPage({
                windowId: 'all',
                runs: [createWorkflowRunSummaryFixture({ id: 'run-5', createdAt: '2026-09-08T10:00:05.000Z' })],
                nextCursor: null,
                mode: 'refresh',
            });

            expect(harness.get().workflowRunListWindows.all).toEqual({
                runIds: ['run-5'], nextCursor: null, loaded: true,
            });
        });

        it('merges a refreshed invocation page in canonical order without shrinking loaded history', () => {
            const harness = createHarness();
            harness.get().applyWorkflowRunInvocationPage({
                runId: 'run-1',
                invocations: [
                    createWorkflowInvocationIndexFixture({ id: 'invocation-1', sequence: '1' }),
                    createWorkflowInvocationIndexFixture({ id: 'invocation-2', sequence: '2' }),
                ],
                nextCursor: 'page-2',
                parentRevision: 4,
                mode: 'replace',
            });
            harness.get().applyWorkflowRunInvocationPage({
                runId: 'run-1',
                invocations: [
                    createWorkflowInvocationIndexFixture({ id: 'invocation-3', sequence: '3' }),
                    createWorkflowInvocationIndexFixture({ id: 'invocation-4', sequence: '4' }),
                ],
                nextCursor: 'page-3',
                parentRevision: 5,
                mode: 'append',
            });

            harness.get().applyWorkflowRunInvocationPage({
                runId: 'run-1',
                invocations: [
                    createWorkflowInvocationIndexFixture({ id: 'invocation-1', sequence: '1', lifecycle: 'completed' }),
                    createWorkflowInvocationIndexFixture({ id: 'invocation-1b', sequence: '1', lifecycle: 'running' }),
                ],
                nextCursor: 'page-2',
                parentRevision: 6,
                mode: 'refresh',
            });

            const window = harness.get().workflowRunInvocationsByRunId['run-1']?.history;
            const invocations = selectWorkflowRunWindowInvocations(harness.get().workflowRunInvocationsByRunId['run-1'], 'history');
            expect(invocations.map((entry) => entry.id))
                .toEqual(['invocation-1', 'invocation-1b', 'invocation-2', 'invocation-3', 'invocation-4']);
            expect(invocations[0]?.lifecycle).toBe('completed');
            expect(window?.nextCursor).toBe('page-3');
            expect(window?.parentRevision).toBe(6);
        });
    });

    describe('one invocation fact owner (03 §6.2)', () => {
        const held = (id: string, contentRevision: string, sequence = '1') => createWorkflowInvocationIndexFixture({
            id, sequence, contentRevision, lifecycle: 'waiting_for_approval',
        });

        it('merges attention, history, exact and first-failure reads into one fact per row', () => {
            const harness = createHarness();
            const attentionFact = held('inv-a', '12');
            harness.get().applyWorkflowRunInvocationPage({
                runId: 'run-1', window: 'attention', invocations: [attentionFact], nextCursor: null, parentRevision: 3, mode: 'replace',
            });
            // A delayed history page carries an older token for the same row.
            const olderHistoryFact = createWorkflowInvocationIndexFixture({ id: 'inv-a', sequence: '1', contentRevision: '11', lifecycle: 'running' });
            harness.get().applyWorkflowRunInvocationPage({
                runId: 'run-1', invocations: [olderHistoryFact], nextCursor: null, parentRevision: 3, mode: 'replace',
            });
            const state = () => harness.get().workflowRunInvocationsByRunId['run-1'];
            expect(state()?.factsById['inv-a']).toBe(attentionFact);
            expect(selectWorkflowRunWindowInvocations(state(), 'history')).toEqual([attentionFact]);
            expect(resolveVisibleWorkflowInvocations(state())).toEqual([attentionFact]);

            // An older exact completion neither replaces the fact nor withdraws attention.
            const olderExact = createWorkflowInvocationIndexFixture({ id: 'inv-a', sequence: '1', contentRevision: '10', lifecycle: 'completed' });
            harness.get().upsertWorkflowRunInvocation({ runId: 'run-1', invocation: olderExact, parentRevision: 3 });
            expect(selectWorkflowRunWindowInvocations(state(), 'attention')).toEqual([attentionFact]);

            // The current exact read settles the row once: attention membership
            // withdraws while history and the visible union keep the settled fact.
            const settled = createWorkflowInvocationIndexFixture({ id: 'inv-a', sequence: '1', contentRevision: '13', lifecycle: 'completed' });
            harness.get().upsertWorkflowRunInvocation({ runId: 'run-1', invocation: settled, parentRevision: 4 });
            expect(selectWorkflowRunWindowInvocations(state(), 'attention')).toEqual([]);
            expect(selectWorkflowRunWindowInvocations(state(), 'history')).toEqual([settled]);
            expect(resolveVisibleWorkflowInvocations(state())).toEqual([settled]);
        });

        it('keeps first-failure evidence beyond both windows visible through the same fact map', () => {
            const harness = createHarness();
            harness.get().applyWorkflowRunInvocationPage({
                runId: 'run-1', invocations: [held('inv-a', '1')], nextCursor: 'page-2', parentRevision: 2, mode: 'replace',
            });
            const failed = createWorkflowInvocationIndexFixture({ id: 'inv-failed', sequence: '9', contentRevision: '5', lifecycle: 'failed' });
            harness.get().setWorkflowRunFirstFailedInvocation({ runId: 'run-1', invocation: failed });
            const state = () => harness.get().workflowRunInvocationsByRunId['run-1'];
            expect(selectWorkflowRunFirstFailedInvocation(state())).toBe(failed);
            expect(resolveVisibleWorkflowInvocations(state()).map((entry) => entry.id)).toEqual(['inv-a', 'inv-failed']);

            // History paging to the failed row with a newer token updates the
            // first-failure evidence too: there is no second copy to diverge.
            const newer = { ...failed, contentRevision: '6' };
            harness.get().applyWorkflowRunInvocationPage({
                runId: 'run-1', invocations: [newer], nextCursor: null, parentRevision: 3, mode: 'append',
            });
            expect(selectWorkflowRunFirstFailedInvocation(state())).toBe(newer);
            harness.get().setWorkflowRunFirstFailedInvocation({ runId: 'run-1', invocation: null });
            expect(selectWorkflowRunFirstFailedInvocation(state())).toBeNull();
        });

        it('restates the complete loaded attention span with its own authoritative cursor', () => {
            const harness = createHarness();
            harness.get().applyWorkflowRunInvocationPage({
                runId: 'run-1', window: 'attention', invocations: [held('inv-a', '1', '0'), held('inv-b', '1', '1')],
                nextCursor: 'attention-2', parentRevision: 1, mode: 'replace',
            });
            harness.get().applyWorkflowRunInvocationPage({
                runId: 'run-1', window: 'attention', invocations: [held('inv-tail', '1', '2')],
                nextCursor: null, parentRevision: 1, mode: 'append',
            });
            harness.get().applyWorkflowRunInvocationPage({
                runId: 'run-1', window: 'attention', invocations: [held('inv-a', '1', '0'), held('inv-b', '1', '1')],
                nextCursor: null, parentRevision: 2, mode: 'refresh',
            });
            const attention = harness.get().workflowRunInvocationsByRunId['run-1']?.attention;
            expect(attention?.invocationIds).toEqual(['inv-a', 'inv-b']);
            expect(attention?.nextCursor).toBeNull();
        });

        it('projects a window to stable arrays until its ids or facts change', () => {
            const harness = createHarness();
            harness.get().applyWorkflowRunInvocationPage({
                runId: 'run-1', invocations: [held('inv-a', '1')], nextCursor: null, parentRevision: 1, mode: 'replace',
            });
            const state = harness.get().workflowRunInvocationsByRunId['run-1'];
            expect(selectWorkflowRunWindowInvocations(state, 'history')).toBe(selectWorkflowRunWindowInvocations(state, 'history'));
            expect(resolveVisibleWorkflowInvocations(state)).toBe(resolveVisibleWorkflowInvocations(state));
        });
    });

    it('projects only Automation-backed rows into an Automation window', () => {
        const runsById = {
            'run-a': workflowRunRowFromAutomationRun(automationRun({ id: 'run-a' })),
            // Seen only through a workflow Action: it has no Automation
            // projection, so it must not appear in an Automation history with
            // half its fields missing.
            'run-b': workflowRunRowFromSummary(summary({ id: 'run-b' })),
        };

        expect(resolveAutomationRunProjections(runsById, ['run-a', 'run-b', 'missing']))
            .toEqual([runsById['run-a']!.automation]);
    });
});
