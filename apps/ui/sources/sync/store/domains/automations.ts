import type {
    AutomationDefinition,
    AutomationDefinitionRun,
} from '@/sync/domains/automations/automationTypes';
import {
    attachAutomationDefinitionDetail,
    hasMatchingAutomationDefinitionTriggerBindings,
    markAutomationDefinitionContentUnavailable,
} from '@/sync/domains/automations/automationDefinitionProjection';
import { getAutomationDefinitionRunCauseAt } from '@/sync/domains/automations/automationRunCause';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import type { StoreGet, StoreSet } from './_shared';
import {
    mergeWorkflowRunBodies,
    releaseWorkflowRunBodies,
    workflowRunRowFromAutomationRun,
    type WorkflowRunsById,
    type WorkflowRunsDomain,
} from './workflowRuns';

const AUTOMATION_RUNS_MAX_ENTRIES_PER_AUTOMATION = loadSyncTuning().automationRunsMaxEntriesPerAutomation;

type AutomationDefinitionTraversal = Readonly<{
    nextCursor: string;
    automations: Record<string, AutomationDefinition>;
}>;

type AutomationRunTraversal = Readonly<{
    nextCursor: string;
    runIds: string[];
}>;

/**
 * The Run state this domain owns is membership, not content: which Runs belong
 * to an Automation's query, in what order, and where its continuation is. The
 * bodies live once in `workflowRunsById`, so an exact read and an Automation
 * list cannot render two versions of the same Run.
 */
type AutomationRunsSlice = WorkflowRunsDomain;

function mergeTriggerSets(previous: AutomationsDomain['workflowTriggerSetsById'], incoming: readonly WorkflowTriggerSetV1[]) {
    let next: Record<string, WorkflowTriggerSetV1> | null = null;
    for (const value of incoming) {
        const known = (next ?? previous)[value.automationId];
        if (known && (known.revision > value.revision || sameStrictJsonValue(known, value))) continue;
        next ??= { ...previous };
        next[value.automationId] = value;
    }
    return next ?? previous;
}

const EMPTY_TRIGGER_SETS: readonly WorkflowTriggerSetV1[] = [];
/** One reader instance per mounted query; unrelated queries keep the same selected value. */
export function createWorkflowTriggerSetSelector(queryKey: string, includeEmpty = false) {
    let previous: readonly WorkflowTriggerSetV1[] = EMPTY_TRIGGER_SETS;
    let previousFacts: AutomationsDomain['workflowTriggerSetsById'] | null = null;
    let previousIds: readonly string[] | undefined;
    return (state: Pick<AutomationsDomain, 'workflowTriggerSetsById' | 'workflowTriggerSetIdsByQuery'>) => {
        const ids = state.workflowTriggerSetIdsByQuery[queryKey];
        if (previousFacts === state.workflowTriggerSetsById && previousIds === ids) return previous;
        previousFacts = state.workflowTriggerSetsById;
        previousIds = ids;
        const next = (ids ?? []).flatMap((id) => {
            const value = state.workflowTriggerSetsById[id];
            // Manual Account Automations keep their owned steps after reviewed conversion too.
            return value && (includeEmpty || value.triggers.length > 0
                || (queryKey === 'account_inline' && (value.legacy || value.target))) ? [value] : [];
        });
        if (next.length === previous.length && next.every((value, index) => previous[index] === value)) return previous;
        previous = next;
        return previous;
    };
}

/** Automation sync is the invalidation signal, not a second opened-content owner. */
export function createWorkflowTriggerChangeSelector(sessionId: string | null, workflow: string | null = null) {
    let previous: AutomationsDomain['automations'] | null = null;
    let signal = '';
    return (state: Pick<AutomationsDomain, 'automations'>) => {
        if (previous === state.automations) return signal;
        previous = state.automations;
        signal = Object.values(state.automations)
            .filter((automation) => sessionId === null
                ? !automation.scopeSessionId && (workflow === null ? !automation.workflowDefinitionId : automation.workflowDefinitionId === workflow)
                : automation.scopeSessionId === sessionId)
            .map((automation) => `${automation.id}:${automation.updatedAt}:${automation.lastRunAt}`).join('|');
        return signal;
    };
}

function retainCurrentDefinitionDetail(params: Readonly<{
    previous: AutomationDefinition | undefined;
    incoming: AutomationDefinition;
}>): AutomationDefinition {
    const { previous, incoming } = params;
    if (!previous) return incoming;

    // A delayed list response must not regress a direct current revision.
    if (previous.templateVersion > incoming.templateVersion) {
        return previous;
    }
    if (previous.templateVersion < incoming.templateVersion || incoming.detail.kind !== 'unloaded') {
        return incoming;
    }

    // Summary refreshes never carry private content. The projection owner
    // decides whether the current summary can retain that private state.
    if (previous.detail.kind === 'unloaded') return incoming;
    if (previous.detail.kind === 'unavailable') {
        return hasMatchingAutomationDefinitionTriggerBindings(previous, incoming)
            ? markAutomationDefinitionContentUnavailable(incoming)
            : incoming;
    }

    const retained = attachAutomationDefinitionDetail(incoming, previous.detail.value);
    return retained
        ? { ...retained, linkedExistingSessionId: previous.linkedExistingSessionId }
        : incoming;
}

export type AutomationsDomain = {
    /** Opened trigger content lives once; surfaces retain only query membership and drafts. */
    workflowTriggerSetsById: Readonly<Record<string, WorkflowTriggerSetV1>>;
    workflowTriggerSetIdsByQuery: Readonly<Record<string, readonly string[]>>;
    applyWorkflowTriggerSetPage: (input: Readonly<{ queryKey: string; sets: readonly WorkflowTriggerSetV1[] }>) => void;
    upsertWorkflowTriggerSet: (input: Readonly<{ queryKey?: string; set: WorkflowTriggerSetV1 }>) => void;
    automations: Record<string, AutomationDefinition>;
    automationDefinitionNextCursor: string | null;
    automationDefinitionWindowExtended: boolean;
    automationDefinitionTraversal: AutomationDefinitionTraversal | null;
    /** Ordered newest-first Run membership. Bodies live in `workflowRunsById`. */
    automationRunIdsByAutomationId: Record<string, string[]>;
    automationRunNextCursorByAutomationId: Record<string, string | null>;
    automationRunTraversalsByAutomationId: Record<string, AutomationRunTraversal>;
    applyAutomations: (automations: AutomationDefinition[], nextCursor?: string | null) => number | null;
    appendAutomations: (
        expectedCursor: string,
        expectedTraversalToken: number,
        automations: AutomationDefinition[],
        nextCursor: string | null,
    ) => boolean;
    upsertAutomation: (automation: AutomationDefinition) => void;
    removeAutomation: (automationId: string) => void;
    setAutomationRuns: (
        automationId: string,
        runs: AutomationDefinitionRun[],
        nextCursor: string | null,
    ) => number | null;
    refreshAutomationRunsWindow: (
        automationId: string,
        runs: AutomationDefinitionRun[],
        nextCursor: string | null,
    ) => void;
    appendAutomationRuns: (
        automationId: string,
        expectedCursor: string,
        expectedTraversalToken: number,
        runs: AutomationDefinitionRun[],
        nextCursor: string | null,
    ) => boolean;
    upsertAutomationRun: (run: AutomationDefinitionRun) => void;
};

/**
 * The Automation query's own ordering: newest cause first, then newest commit.
 * It reads the shared bodies but stays here, because "newest" for an Automation
 * history means the trigger occurrence, which is an Automation fact.
 */
function orderRunIdsNewestFirst(
    runsById: WorkflowRunsById,
    runIds: Iterable<string>,
): string[] {
    const unique = Array.from(new Set(runIds)).filter((runId) => runsById[runId]?.automation !== undefined
        && runsById[runId]?.automation !== null);
    return unique.sort((leftId, rightId) => {
        const left = runsById[leftId]!.automation!;
        const right = runsById[rightId]!.automation!;
        const rightCauseAt = getAutomationDefinitionRunCauseAt(right);
        const leftCauseAt = getAutomationDefinitionRunCauseAt(left);
        if (rightCauseAt !== leftCauseAt) {
            return rightCauseAt - leftCauseAt;
        }
        return right.updatedAt - left.updatedAt;
    });
}

function toRunIds(runs: readonly AutomationDefinitionRun[]): string[] {
    return runs.map((run) => run.id);
}

function indexAutomations(automations: AutomationDefinition[]): Record<string, AutomationDefinition> {
    return Object.fromEntries(automations.map((automation) => [automation.id, automation]));
}

function mergeAutomationDefinitions(
    previous: Record<string, AutomationDefinition>,
    incoming: AutomationDefinition[],
): Record<string, AutomationDefinition> {
    const next = { ...previous };
    for (const automation of incoming) {
        next[automation.id] = retainCurrentDefinitionDetail({
            previous: previous[automation.id],
            incoming: automation,
        });
    }
    return next;
}

function replaceAutomationDefinitions(
    previous: Record<string, AutomationDefinition>,
    incoming: AutomationDefinition[],
): Record<string, AutomationDefinition> {
    const next: Record<string, AutomationDefinition> = {};
    for (const automation of incoming) {
        next[automation.id] = retainCurrentDefinitionDetail({
            previous: previous[automation.id],
            incoming: automation,
        });
    }
    return next;
}

/**
 * Drop the Run membership of Automations a terminal traversal proved are gone.
 * The bodies they were holding are retired by `commitAutomationRunWindows`.
 */
function retainAutomationRunMembership(
    automationIds: ReadonlySet<string>,
    runIdsByAutomationId: Record<string, string[]>,
    cursorsByAutomationId: Record<string, string | null>,
    traversalsByAutomationId: Record<string, AutomationRunTraversal>,
) {
    return {
        automationRunIdsByAutomationId: Object.fromEntries(
            Object.entries(runIdsByAutomationId).filter(([automationId]) => automationIds.has(automationId)),
        ),
        automationRunNextCursorByAutomationId: Object.fromEntries(
            Object.entries(cursorsByAutomationId).filter(([automationId]) => automationIds.has(automationId)),
        ),
        automationRunTraversalsByAutomationId: Object.fromEntries(
            Object.entries(traversalsByAutomationId).filter(([automationId]) => automationIds.has(automationId)),
        ),
    };
}

function collectReferencedRunIds(
    runIdsByAutomationId: Record<string, string[]>,
    traversalsByAutomationId: Record<string, AutomationRunTraversal>,
): Set<string> {
    const referenced = new Set<string>();
    for (const runIds of Object.values(runIdsByAutomationId)) {
        for (const runId of runIds) referenced.add(runId);
    }
    for (const traversal of Object.values(traversalsByAutomationId)) {
        for (const runId of traversal.runIds) referenced.add(runId);
    }
    return referenced;
}

/**
 * Commit a window change and retire the bodies this domain stopped holding.
 *
 * The release candidates are exactly the ids this domain's windows referenced
 * before the change. A body reached by identity instead — an exact read, a
 * deep link, a Run whose Automation list was never opened — is in neither set
 * and is therefore untouched.
 */
function commitAutomationRunWindows<S extends AutomationsDomain & AutomationRunsSlice>(
    previous: S,
    next: S,
): S {
    const retainedRunIds = collectReferencedRunIds(
        next.automationRunIdsByAutomationId,
        next.automationRunTraversalsByAutomationId,
    );
    // History owns its membership, not the lifetime of another visible Run window.
    for (const window of Object.values(next.workflowRunListWindows)) {
        for (const runId of window?.runIds ?? []) retainedRunIds.add(runId);
    }
    const workflowRunsById = releaseWorkflowRunBodies({
        runsById: next.workflowRunsById,
        releasedRunIds: collectReferencedRunIds(
            previous.automationRunIdsByAutomationId,
            previous.automationRunTraversalsByAutomationId,
        ),
        retainedRunIds,
    });
    return workflowRunsById === next.workflowRunsById ? next : { ...next, workflowRunsById };
}

/**
 * The passive retention ceiling. It bounds what this store keeps for an
 * Automation nobody asked to page through — a seeded first page, or a run row
 * pushed in by a socket update — so a large Account cannot accumulate run
 * history the reader never requested.
 *
 * It is NOT a traversal ceiling. Rows the reader explicitly paged in through
 * `appendAutomationRuns` stay retained, and an incoming update may never
 * shrink that window below what the reader is already looking at; the next
 * full re-seed collapses it back to this bound.
 */
function retainPassiveRunWindow(
    runIds: readonly string[],
    retainedFloor = 0,
): string[] {
    return runIds.slice(0, Math.max(AUTOMATION_RUNS_MAX_ENTRIES_PER_AUTOMATION, retainedFloor));
}

/**
 * The one writer that replaces an Automation's whole run projection: the
 * bounded newest-first window together with the server continuation that
 * belongs to it. Both facts come from the same response, so nothing here may
 * be updated without the other.
 *
 */
function seedAutomationRunWindow<S extends AutomationsDomain & AutomationRunsSlice>(
    state: S,
    automationId: string,
    runsById: WorkflowRunsById,
    runIds: readonly string[],
    nextCursor: string | null,
    traversals: Record<string, AutomationRunTraversal>,
): S {
    return {
        ...state,
        workflowRunsById: runsById,
        automationRunIdsByAutomationId: {
            ...state.automationRunIdsByAutomationId,
            [automationId]: retainPassiveRunWindow(orderRunIdsNewestFirst(runsById, runIds)),
        },
        automationRunNextCursorByAutomationId: {
            ...state.automationRunNextCursorByAutomationId,
            [automationId]: nextCursor,
        },
        automationRunTraversalsByAutomationId: traversals,
    };
}

export function createAutomationsDomain<S extends AutomationsDomain & AutomationRunsSlice>({
    set,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): AutomationsDomain {
    let nextTraversalToken = 0;
    let definitionTraversalToken: number | null = null;
    const runTraversalTokensByAutomationId = new Map<string, number>();

    return {
        workflowTriggerSetsById: {},
        workflowTriggerSetIdsByQuery: {},
        applyWorkflowTriggerSetPage: ({ queryKey, sets }) => {
            set((state) => {
                const facts = mergeTriggerSets(state.workflowTriggerSetsById, sets);
                const ids = sets.map((value) => value.automationId);
                const previous = state.workflowTriggerSetIdsByQuery[queryKey];
                const unchanged = previous !== undefined && ids.length === previous.length && ids.every((id, index) => previous[index] === id);
                if (facts === state.workflowTriggerSetsById && unchanged) return state;
                return {
                    ...state,
                    workflowTriggerSetsById: facts,
                    workflowTriggerSetIdsByQuery: unchanged ? state.workflowTriggerSetIdsByQuery
                        : { ...state.workflowTriggerSetIdsByQuery, [queryKey]: ids },
                };
            });
        },
        upsertWorkflowTriggerSet: ({ queryKey, set: written }) => {
            set((state) => {
                const facts = mergeTriggerSets(state.workflowTriggerSetsById, [written]);
                if ((state.workflowTriggerSetsById[written.automationId]?.revision ?? -1) > written.revision) return state;
                let windows = state.workflowTriggerSetIdsByQuery;
                // Retargeting an Account inline set to a saved workflow moves
                // its membership; it is not still an inline trigger row.
                if (queryKey?.startsWith('workflow:') && windows.account_inline?.includes(written.automationId)) {
                    windows = { ...windows, account_inline: windows.account_inline.filter((id) => id !== written.automationId) };
                }
                if (queryKey && !(windows[queryKey] ?? []).includes(written.automationId)) {
                    windows = { ...windows, [queryKey]: [...(windows[queryKey] ?? []), written.automationId] };
                }
                if (facts === state.workflowTriggerSetsById && windows === state.workflowTriggerSetIdsByQuery) return state;
                return { ...state, workflowTriggerSetsById: facts, workflowTriggerSetIdsByQuery: windows };
            });
        },
        automations: {},
        automationDefinitionNextCursor: null,
        automationDefinitionWindowExtended: false,
        automationDefinitionTraversal: null,
        automationRunIdsByAutomationId: {},
        automationRunNextCursorByAutomationId: {},
        automationRunTraversalsByAutomationId: {},
        applyAutomations: (automations, nextCursor) => {
            const traversalToken = nextCursor === null || nextCursor === undefined
                ? null
                : ++nextTraversalToken;
            definitionTraversalToken = traversalToken;
            set((state) => {
                const freshPage = indexAutomations(automations);
                if (nextCursor !== null && nextCursor !== undefined) {
                    // Keep the last-known-good window while a fresh traversal
                    // is incomplete. Only the full terminal traversal can
                    // authoritatively retire a remotely deleted definition.
                    return {
                        ...state,
                        automations: mergeAutomationDefinitions(state.automations, automations),
                        automationDefinitionNextCursor: nextCursor,
                        automationDefinitionWindowExtended: true,
                        automationDefinitionTraversal: { nextCursor, automations: freshPage },
                    };
                }
                const replacement = replaceAutomationDefinitions(state.automations, automations);
                return commitAutomationRunWindows(state, {
                    ...state,
                    automations: replacement,
                    automationDefinitionNextCursor: null,
                    automationDefinitionWindowExtended: false,
                    automationDefinitionTraversal: null,
                    ...retainAutomationRunMembership(
                        new Set(Object.keys(replacement)),
                        state.automationRunIdsByAutomationId,
                        state.automationRunNextCursorByAutomationId,
                        state.automationRunTraversalsByAutomationId,
                    ),
                });
            });
            return traversalToken;
        },
        appendAutomations: (expectedCursor, expectedTraversalToken, automations, nextCursor) => {
            let accepted = false;
            set((state) => {
                if (
                    state.automationDefinitionNextCursor !== expectedCursor
                    || definitionTraversalToken !== expectedTraversalToken
                ) return state;
                const traversal = state.automationDefinitionTraversal;
                if (!traversal || traversal.nextCursor !== expectedCursor) return state;
                const traversedAutomations = { ...traversal.automations, ...indexAutomations(automations) };
                accepted = true;
                if (nextCursor === null) {
                    definitionTraversalToken = null;
                    const replacement = replaceAutomationDefinitions(
                        state.automations,
                        Object.values(traversedAutomations),
                    );
                    return commitAutomationRunWindows(state, {
                        ...state,
                        automations: replacement,
                        automationDefinitionNextCursor: null,
                        automationDefinitionWindowExtended: false,
                        automationDefinitionTraversal: null,
                        ...retainAutomationRunMembership(
                            new Set(Object.keys(replacement)),
                            state.automationRunIdsByAutomationId,
                            state.automationRunNextCursorByAutomationId,
                            state.automationRunTraversalsByAutomationId,
                        ),
                    });
                }
                return {
                    ...state,
                    automations: mergeAutomationDefinitions(state.automations, automations),
                    automationDefinitionNextCursor: nextCursor,
                    automationDefinitionWindowExtended: true,
                    automationDefinitionTraversal: {
                        nextCursor,
                        automations: traversedAutomations,
                    },
                };
            });
            return accepted;
        },
        upsertAutomation: (automation) =>
            set((state) => ({
                ...state,
                automations: {
                    ...state.automations,
                    [automation.id]: automation,
                },
                automationDefinitionTraversal: state.automationDefinitionTraversal
                    ? {
                        ...state.automationDefinitionTraversal,
                        automations: {
                            ...state.automationDefinitionTraversal.automations,
                            [automation.id]: automation,
                        },
                    }
                    : null,
            })),
        removeAutomation: (automationId) => {
            runTraversalTokensByAutomationId.delete(automationId);
            set((state) => {
                const nextAutomations = { ...state.automations };
                const nextRunIdsByAutomationId = { ...state.automationRunIdsByAutomationId };
                const nextRunCursorsByAutomationId = { ...state.automationRunNextCursorByAutomationId };
                const nextRunTraversalsByAutomationId = { ...state.automationRunTraversalsByAutomationId };
                delete nextAutomations[automationId];
                delete nextRunIdsByAutomationId[automationId];
                delete nextRunCursorsByAutomationId[automationId];
                delete nextRunTraversalsByAutomationId[automationId];
                const nextDefinitionTraversal = state.automationDefinitionTraversal
                    ? {
                        ...state.automationDefinitionTraversal,
                        automations: { ...state.automationDefinitionTraversal.automations },
                    }
                    : null;
                if (nextDefinitionTraversal) delete nextDefinitionTraversal.automations[automationId];
                return commitAutomationRunWindows(state, {
                    ...state,
                    automations: nextAutomations,
                    automationRunIdsByAutomationId: nextRunIdsByAutomationId,
                    automationRunNextCursorByAutomationId: nextRunCursorsByAutomationId,
                    automationRunTraversalsByAutomationId: nextRunTraversalsByAutomationId,
                    automationDefinitionTraversal: nextDefinitionTraversal,
                });
            });
        },
        setAutomationRuns: (automationId, runs, nextCursor) => {
            const traversalToken = nextCursor === null ? null : ++nextTraversalToken;
            if (traversalToken === null) runTraversalTokensByAutomationId.delete(automationId);
            else runTraversalTokensByAutomationId.set(automationId, traversalToken);
            set((state) => {
                const workflowRunsById = mergeWorkflowRunBodies(state.workflowRunsById, runs.map(workflowRunRowFromAutomationRun));
                const nextTraversals = { ...state.automationRunTraversalsByAutomationId };
                if (nextCursor === null) {
                    delete nextTraversals[automationId];
                    return commitAutomationRunWindows(state, seedAutomationRunWindow(
                        state,
                        automationId,
                        workflowRunsById,
                        toRunIds(runs),
                        nextCursor,
                        nextTraversals,
                    ));
                }
                const existing = state.automationRunIdsByAutomationId[automationId] ?? [];
                const runIds = toRunIds(runs);
                return commitAutomationRunWindows(state, {
                    ...state,
                    workflowRunsById,
                    automationRunIdsByAutomationId: {
                        ...state.automationRunIdsByAutomationId,
                        [automationId]: existing.length === 0
                            ? retainPassiveRunWindow(orderRunIdsNewestFirst(workflowRunsById, runIds))
                            : orderRunIdsNewestFirst(workflowRunsById, [...existing, ...runIds]),
                    },
                    automationRunNextCursorByAutomationId: {
                        ...state.automationRunNextCursorByAutomationId,
                        [automationId]: nextCursor,
                    },
                    automationRunTraversalsByAutomationId: {
                        ...nextTraversals,
                        [automationId]: { nextCursor, runIds },
                    },
                });
            });
            return traversalToken;
        },
        refreshAutomationRunsWindow: (automationId, runs, nextCursor) =>
            set((state) => {
                const workflowRunsById = mergeWorkflowRunBodies(state.workflowRunsById, runs.map(workflowRunRowFromAutomationRun));
                const runIds = toRunIds(runs);
                const existing = state.automationRunIdsByAutomationId[automationId] ?? [];
                const traversal = state.automationRunTraversalsByAutomationId[automationId];
                const nextTraversals = traversal
                    ? {
                        ...state.automationRunTraversalsByAutomationId,
                        [automationId]: {
                            ...traversal,
                            runIds: orderRunIdsNewestFirst(
                                workflowRunsById,
                                [...traversal.runIds, ...runIds],
                            ),
                        },
                    }
                    : state.automationRunTraversalsByAutomationId;
                // A window no larger than the page the server just returned is
                // the passive projection: re-seeding it is exactly what the
                // reader would see by reopening the Automation, and everything
                // it drops is still reachable through the fresh continuation.
                if (existing.length <= runIds.length) {
                    return commitAutomationRunWindows(state, seedAutomationRunWindow(
                        state,
                        automationId,
                        workflowRunsById,
                        runIds,
                        nextCursor,
                        nextTraversals,
                    ));
                }
                // A larger window is a traversal the reader paid for page by
                // page, and the cursor it holds is the authoritative server
                // continuation for the END of that traversal. A refresh only
                // restates the newest page into it: replacing the window would
                // discard Runs the reader is looking at, and replacing the
                // continuation would rewind the traversal to the first page.
                return commitAutomationRunWindows(state, {
                    ...state,
                    workflowRunsById,
                    automationRunIdsByAutomationId: {
                        ...state.automationRunIdsByAutomationId,
                        [automationId]: orderRunIdsNewestFirst(
                            workflowRunsById,
                            [...existing, ...runIds],
                        ),
                    },
                    automationRunTraversalsByAutomationId: nextTraversals,
                });
            }),
        appendAutomationRuns: (automationId, expectedCursor, expectedTraversalToken, runs, nextCursor) => {
            let accepted = false;
            set((state) => {
                if (
                    state.automationRunNextCursorByAutomationId[automationId] !== expectedCursor
                    || runTraversalTokensByAutomationId.get(automationId) !== expectedTraversalToken
                ) {
                    return state;
                }
                const traversal = state.automationRunTraversalsByAutomationId[automationId];
                if (!traversal || traversal.nextCursor !== expectedCursor) return state;
                const workflowRunsById = mergeWorkflowRunBodies(state.workflowRunsById, runs.map(workflowRunRowFromAutomationRun));
                const runIds = toRunIds(runs);
                const existing = state.automationRunIdsByAutomationId[automationId] ?? [];
                const traversedRunIds = orderRunIdsNewestFirst(
                    workflowRunsById,
                    [...traversal.runIds, ...runIds],
                );
                const nextTraversals = { ...state.automationRunTraversalsByAutomationId };
                accepted = true;
                if (nextCursor === null) {
                    runTraversalTokensByAutomationId.delete(automationId);
                    delete nextTraversals[automationId];
                    return commitAutomationRunWindows(state, {
                        ...state,
                        workflowRunsById,
                        automationRunIdsByAutomationId: {
                            ...state.automationRunIdsByAutomationId,
                            [automationId]: traversedRunIds,
                        },
                        automationRunNextCursorByAutomationId: {
                            ...state.automationRunNextCursorByAutomationId,
                            [automationId]: null,
                        },
                        automationRunTraversalsByAutomationId: nextTraversals,
                    });
                }
                // An explicit page is what the reader asked to see, so it is
                // retained in full and the server's continuation is recorded
                // verbatim. Deriving the continuation from the passive window
                // instead made the newest-first ceiling look like the end of
                // the Automation's history, with no way back to older Runs and
                // nothing said about it. The window this grows is bounded by
                // the pages the reader actually requested and collapses back
                // to the passive ceiling on the next full re-seed.
                return commitAutomationRunWindows(state, {
                    ...state,
                    workflowRunsById,
                    automationRunIdsByAutomationId: {
                        ...state.automationRunIdsByAutomationId,
                        [automationId]: orderRunIdsNewestFirst(
                            workflowRunsById,
                            [...existing, ...runIds],
                        ),
                    },
                    automationRunNextCursorByAutomationId: {
                        ...state.automationRunNextCursorByAutomationId,
                        [automationId]: nextCursor,
                    },
                    automationRunTraversalsByAutomationId: {
                        ...nextTraversals,
                        [automationId]: { nextCursor, runIds: traversedRunIds },
                    },
                });
            });
            return accepted;
        },
        upsertAutomationRun: (run) =>
            set((state) => {
                const workflowRunsById = mergeWorkflowRunBodies(state.workflowRunsById, [workflowRunRowFromAutomationRun(run)]);
                const existing = state.automationRunIdsByAutomationId[run.automationId] ?? [];
                const filtered = existing.filter((runId) => runId !== run.id);
                const next = retainPassiveRunWindow(
                    orderRunIdsNewestFirst(workflowRunsById, [run.id, ...filtered]),
                    existing.length,
                );
                const traversal = state.automationRunTraversalsByAutomationId[run.automationId];
                return commitAutomationRunWindows(state, {
                    ...state,
                    workflowRunsById,
                    automationRunIdsByAutomationId: {
                        ...state.automationRunIdsByAutomationId,
                        [run.automationId]: next,
                    },
                    automationRunTraversalsByAutomationId: traversal
                        ? {
                            ...state.automationRunTraversalsByAutomationId,
                            [run.automationId]: {
                                ...traversal,
                                runIds: orderRunIdsNewestFirst(
                                    workflowRunsById,
                                    [...traversal.runIds, run.id],
                                ),
                            },
                        }
                        : state.automationRunTraversalsByAutomationId,
                });
            }),
    };
}
