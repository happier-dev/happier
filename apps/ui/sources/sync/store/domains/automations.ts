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
import type { WorkflowTriggerListRequestV1, WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { isWorkflowTriggerSetAttachedToSession } from '@/sync/domains/workflows/workflowTriggerSession';
import { matchesWorkflowTriggerQuery, workflowTriggerQueryKey } from '@/sync/domains/workflows/workflowTriggerQuery';

import type { StoreGet, StoreSet } from './_shared';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createRowInventoryReceiptOrdering } from '@/sync/store/settings/rowInventoryReceiptOrdering';
import {
    mergeWorkflowRunBodies,
    releaseWorkflowRunBodies,
    workflowRunRowFromAutomationRun,
    workflowRunStoreKey,
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

function mergeTriggerSets(previous: AutomationsDomain['workflowTriggerSetsById'], incoming: readonly WorkflowTriggerSetV1[],
    scope: ServerAccountScope, ordering: ReturnType<typeof createRowInventoryReceiptOrdering>) {
    let next: Record<string, WorkflowTriggerSetV1> | null = null;
    for (const value of incoming) {
        const known = (next ?? previous)[value.automationId];
        if (!ordering.admitRead(scope, value.automationId, value.revision, known?.revision)
            || sameStrictJsonValue(known, value)) continue;
        next ??= { ...previous };
        next[value.automationId] = value;
    }
    return next ?? previous;
}

function matchesTriggerTargetQuery(queryKey: string, set: WorkflowTriggerSetV1 | undefined) {
    return matchesWorkflowTriggerQuery(queryKey, set) !== false;
}

function isNewerTriggerReceipt(known: WorkflowTriggerSetV1 | undefined, written: WorkflowTriggerSetV1) {
    return known === undefined || written.revision > known.revision;
}

/** An addressed read retains canonical receipts without publishing into another focused Account. */
export function applyWorkflowTriggerSnapshotReceipt(
    previous: readonly WorkflowTriggerSetV1[], queryKey: string, written: WorkflowTriggerSetV1,
) {
    const index = previous.findIndex(set => set.automationId === written.automationId);
    const known = index < 0 ? undefined : previous[index];
    if (known && written.revision < known.revision) return null;
    if (queryKey.startsWith('managed:') && index < 0 && matchesWorkflowTriggerQuery(queryKey, written) === undefined) return null;
    if (!matchesTriggerTargetQuery(queryKey, written)) return index < 0 ? null
        : previous.filter(set => set.automationId !== written.automationId);
    if (!isNewerTriggerReceipt(known, written)) return previous;
    return index < 0 ? [...previous, written] : previous.map((set, position) => position === index ? written : set);
}

function reconcileTriggerTargetMemberships(
    windows: AutomationsDomain['workflowTriggerSetIdsByQuery'],
    facts: AutomationsDomain['workflowTriggerSetsById'],
    observedIds: ReadonlySet<string>,
) {
    let next = windows;
    for (const [queryKey, ids] of Object.entries(windows)) {
        if (queryKey !== 'account_inline' && queryKey !== 'account_source_unavailable'
            && !queryKey.startsWith('workflow:') && !queryKey.startsWith('managed:')) continue;
        const retained = ids.filter(id => !observedIds.has(id) || matchesTriggerTargetQuery(queryKey, facts[id]));
        if (retained.length !== ids.length) next = { ...next, [queryKey]: retained };
    }
    return next;
}

const EMPTY_TRIGGER_SETS: readonly WorkflowTriggerSetV1[] = [];
/** One reader instance per mounted query; unrelated queries keep the same selected value. */
export function createWorkflowTriggerSetSelector(queryKey: string, includeEmpty = false) {
    const sessionId = queryKey.startsWith('session:') ? queryKey.slice('session:'.length) : null;
    let previous: readonly WorkflowTriggerSetV1[] = EMPTY_TRIGGER_SETS;
    let previousFacts: AutomationsDomain['workflowTriggerSetsById'] | null = null;
    let previousIds: readonly string[] | undefined;
    let previousAccountIds: readonly string[] | undefined;
    return (state: Pick<AutomationsDomain, 'workflowTriggerSetsById' | 'workflowTriggerSetIdsByQuery'>) => {
        const ids = state.workflowTriggerSetIdsByQuery[queryKey];
        const accountIds = sessionId === null ? undefined : state.workflowTriggerSetIdsByQuery.account_all;
        if (previousFacts === state.workflowTriggerSetsById && previousIds === ids && previousAccountIds === accountIds) return previous;
        previousFacts = state.workflowTriggerSetsById;
        previousIds = ids;
        previousAccountIds = accountIds;
        const selectedIds = sessionId === null ? ids ?? [] : [...new Set([...(ids ?? []), ...(accountIds ?? [])])];
        const scopedIds = sessionId === null ? undefined : new Set(ids);
        const next = selectedIds.flatMap((id) => {
            const value = state.workflowTriggerSetsById[id];
            if (value && sessionId !== null && !scopedIds?.has(id) && !isWorkflowTriggerSetAttachedToSession(value, sessionId)) return [];
            // Manual Account Automations keep their owned steps after reviewed conversion too.
            return value && (includeEmpty || value.triggers.length > 0
                || (queryKey === 'account_inline' && (value.legacy || value.target))) ? [value] : [];
        });
        if (next.length === previous.length && next.every((value, index) => previous[index] === value)) return previous;
        previous = next;
        return previous;
    };
}

export const EMPTY_WORKFLOW_TRIGGER_CHANGE_SIGNAL: readonly AutomationDefinition[] = [];

/** Automation sync is the invalidation signal, not a second opened-content owner. */
export function createWorkflowTriggerChangeSelector(sessionId: string | null, workflow: string | null = null,
    scope: Extract<WorkflowTriggerListRequestV1, { scope: string }>['scope'] = 'account_inline',
    managedTarget?: Readonly<{ homeId: string; managedId: string }>) {
    let previous: AutomationsDomain['automations'] | null = null;
    let observed = new Map<string, AutomationDefinition>();
    let signal = EMPTY_WORKFLOW_TRIGGER_CHANGE_SIGNAL;
    const queryKey = workflowTriggerQueryKey(managedTarget ? { managedTarget }
        : sessionId !== null ? { lifetimeSession: { sessionId } } : workflow !== null ? { workflow } : { scope });
    return (state: Pick<AutomationsDomain, 'automations' | 'workflowTriggerSetsById' | 'workflowTriggerSetIdsByQuery'>) => {
        if (previous === state.automations) return signal;
        const relevant = Object.values(state.automations)
            .filter((automation) => managedTarget ? automation.managedTarget === undefined
                || (automation.managedTarget?.homeId === managedTarget.homeId && automation.managedTarget.managedId === managedTarget.managedId)
                : scope === 'account_all' || (sessionId === null
                ? !automation.scopeSessionId && (workflow === null ? scope === 'account_source_unavailable'
                    ? Boolean(automation.workflowDefinitionId) : !automation.workflowDefinitionId : automation.workflowDefinitionId === workflow)
                : automation.scopeSessionId === sessionId));
        const next = new Map(relevant.map(automation => [automation.id, automation]));
        const listedIds = new Set(state.workflowTriggerSetIdsByQuery[queryKey]);
        const changed = [...observed.keys()].some(id => !next.has(id)) || relevant.some(automation => {
            const known = observed.get(automation.id);
            if (known === automation) return false;
            if (known) return known.updatedAt !== automation.updatedAt || known.lastRunAt !== automation.lastRunAt
                || known.templateVersion !== automation.templateVersion || known.enabled !== automation.enabled
                // Schedule/lifecycle progress does not rewrite the authored Automation.
                || !sameStrictJsonValue(known.triggers, automation.triggers);
            // Initial Sync may arrive after this exact query's opened read.
            // It adds no information when that read already has every revision.
            const opened = state.workflowTriggerSetsById[automation.id];
            if (!listedIds.has(automation.id) || !opened || opened.health !== 'available'
                || opened.revision !== automation.templateVersion || opened.enabled !== automation.enabled
                || (opened.scopeSessionId ?? null) !== (automation.scopeSessionId ?? null)
                || opened.triggers.length !== automation.triggers.length) return true;
            const triggers = new Map(opened.triggers.map(trigger => [trigger.id, trigger]));
            return automation.triggers.some(trigger => {
                const current = triggers.get(trigger.id);
                if (!current) return true;
                // Public status fields can change without a private trigger revision.
                const fields = new Map<string, unknown>(Object.entries(current));
                return Object.entries(trigger).some(([key, value]) => !sameStrictJsonValue(fields.get(key), value));
            });
        });
        if (previous === null || changed) signal = relevant;
        previous = state.automations;
        observed = next;
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
    resetWorkflowTriggerSets: () => void;
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
    removeAutomation: (automationId: string, removedRevision?: number) => void;
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
    const unique = Array.from(new Set(runIds)).filter((runId) => runsById[workflowRunStoreKey(runId)]?.automation !== undefined
        && runsById[workflowRunStoreKey(runId)]?.automation !== null);
    return unique.sort((leftId, rightId) => {
        const left = runsById[workflowRunStoreKey(leftId)]!.automation!;
        const right = runsById[workflowRunStoreKey(rightId)]!.automation!;
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

/** Retain the unchanged records in an Automation-owned membership or definition map. */
function reconcileAutomationRecords<T>(previous: Record<string, T>, incoming: Record<string, T>): Record<string, T> {
    if (previous === incoming) return previous;
    const entries = Object.entries(incoming);
    let changed = Object.keys(previous).length !== entries.length;
    const reconciled: Record<string, T> = {};
    for (const [id, value] of entries) {
        if (Object.prototype.hasOwnProperty.call(previous, id) && sameStrictJsonValue(previous[id], value)) {
            reconciled[id] = previous[id]!;
        } else {
            reconciled[id] = value;
            changed = true;
        }
    }
    return changed ? reconciled : previous;
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
    const automations = reconcileAutomationRecords(previous.automations, next.automations);
    const automationRunIdsByAutomationId = reconcileAutomationRecords(previous.automationRunIdsByAutomationId, next.automationRunIdsByAutomationId);
    const automationRunNextCursorByAutomationId = reconcileAutomationRecords(previous.automationRunNextCursorByAutomationId, next.automationRunNextCursorByAutomationId);
    const automationRunTraversalsByAutomationId = reconcileAutomationRecords(previous.automationRunTraversalsByAutomationId, next.automationRunTraversalsByAutomationId);
    const automationDefinitionTraversal = sameStrictJsonValue(previous.automationDefinitionTraversal, next.automationDefinitionTraversal)
        ? previous.automationDefinitionTraversal : next.automationDefinitionTraversal;
    let workflowRunsById = next.workflowRunsById;
    if (automationRunIdsByAutomationId !== previous.automationRunIdsByAutomationId
        || automationRunTraversalsByAutomationId !== previous.automationRunTraversalsByAutomationId) {
        const retainedRunIds = collectReferencedRunIds(automationRunIdsByAutomationId, automationRunTraversalsByAutomationId);
        // History owns its membership, not the lifetime of another visible Run window.
        for (const window of Object.values(next.workflowRunListWindows)) {
            for (const runId of window?.runIds ?? []) retainedRunIds.add(runId);
        }
        workflowRunsById = releaseWorkflowRunBodies({
            runsById: workflowRunsById,
            releasedRunIds: collectReferencedRunIds(
                previous.automationRunIdsByAutomationId,
                previous.automationRunTraversalsByAutomationId,
            ),
            retainedRunIds,
        });
    }
    if (automations === previous.automations && workflowRunsById === previous.workflowRunsById
        && automationRunIdsByAutomationId === previous.automationRunIdsByAutomationId
        && automationRunNextCursorByAutomationId === previous.automationRunNextCursorByAutomationId
        && automationRunTraversalsByAutomationId === previous.automationRunTraversalsByAutomationId
        && automationDefinitionTraversal === previous.automationDefinitionTraversal
        && next.automationDefinitionNextCursor === previous.automationDefinitionNextCursor
        && next.automationDefinitionWindowExtended === previous.automationDefinitionWindowExtended
        && next.workflowTriggerSetsById === previous.workflowTriggerSetsById
        && next.workflowTriggerSetIdsByQuery === previous.workflowTriggerSetIdsByQuery) return previous;
    return { ...next, automations, workflowRunsById, automationRunIdsByAutomationId,
        automationRunNextCursorByAutomationId, automationRunTraversalsByAutomationId, automationDefinitionTraversal };
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

export function createAutomationsDomain<S extends AutomationsDomain & AutomationRunsSlice & { profileScope?: ServerAccountScope | null }>({
    set,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): AutomationsDomain {
    let nextTraversalToken = 0;
    let definitionTraversalToken: number | null = null;
    const runTraversalTokensByAutomationId = new Map<string, number>();
    const triggerReceiptOrdering = createRowInventoryReceiptOrdering();

    return {
        workflowTriggerSetsById: {},
        workflowTriggerSetIdsByQuery: {},
        resetWorkflowTriggerSets: () => {
            triggerReceiptOrdering.reset();
            set((state) => Object.keys(state.workflowTriggerSetsById).length === 0
                && Object.keys(state.workflowTriggerSetIdsByQuery).length === 0 ? state
                : { ...state, workflowTriggerSetsById: {}, workflowTriggerSetIdsByQuery: {} });
        },
        applyWorkflowTriggerSetPage: ({ queryKey, sets }) => {
            set((state) => {
                if (!state.profileScope) return state;
                const facts = mergeTriggerSets(state.workflowTriggerSetsById, sets, state.profileScope, triggerReceiptOrdering);
                const observedIds = sets.map((value) => value.automationId);
                const ids = observedIds.filter(id => matchesTriggerTargetQuery(queryKey, facts[id]));
                const previous = state.workflowTriggerSetIdsByQuery[queryKey];
                const unchanged = previous !== undefined && ids.length === previous.length && ids.every((id, index) => previous[index] === id);
                const windows = reconcileTriggerTargetMemberships(unchanged ? state.workflowTriggerSetIdsByQuery
                    : { ...state.workflowTriggerSetIdsByQuery, [queryKey]: ids }, facts, new Set(observedIds));
                if (facts === state.workflowTriggerSetsById && windows === state.workflowTriggerSetIdsByQuery) return state;
                return {
                    ...state,
                    workflowTriggerSetsById: facts,
                    workflowTriggerSetIdsByQuery: windows,
                };
            });
        },
        upsertWorkflowTriggerSet: ({ queryKey, set: written }) => {
            set((state) => {
                if (!state.profileScope || !isNewerTriggerReceipt(state.workflowTriggerSetsById[written.automationId], written)
                    || !triggerReceiptOrdering.admit(state.profileScope, written.automationId, written.revision)) return state;
                const facts = mergeTriggerSets(state.workflowTriggerSetsById, [written], state.profileScope, triggerReceiptOrdering);
                let windows = state.workflowTriggerSetIdsByQuery;
                if (queryKey && matchesTriggerTargetQuery(queryKey, written) && !(windows[queryKey] ?? []).includes(written.automationId)) {
                    windows = { ...windows, [queryKey]: [...(windows[queryKey] ?? []), written.automationId] };
                }
                // A committed new set is also part of an already-open Account census. Its body
                // remains shared, so Session Habits and Scheduled work see the same ACK.
                if (windows.account_all && !windows.account_all.includes(written.automationId)) {
                    windows = { ...windows, account_all: [...windows.account_all, written.automationId] };
                }
                for (const [managedQuery, ids] of Object.entries(windows)) {
                    if (managedQuery.startsWith('managed:') && !ids.includes(written.automationId)
                        && matchesWorkflowTriggerQuery(managedQuery, written) === true) {
                        windows = { ...windows, [managedQuery]: [...ids, written.automationId] };
                    }
                }
                windows = reconcileTriggerTargetMemberships(windows, facts, new Set([written.automationId]));
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
                    return commitAutomationRunWindows(state, {
                        ...state,
                        automations: mergeAutomationDefinitions(state.automations, automations),
                        automationDefinitionNextCursor: nextCursor,
                        automationDefinitionWindowExtended: true,
                        automationDefinitionTraversal: { nextCursor, automations: freshPage },
                    });
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
                return commitAutomationRunWindows(state, {
                    ...state,
                    automations: mergeAutomationDefinitions(state.automations, automations),
                    automationDefinitionNextCursor: nextCursor,
                    automationDefinitionWindowExtended: true,
                    automationDefinitionTraversal: {
                        nextCursor,
                        automations: traversedAutomations,
                    },
                });
            });
            return accepted;
        },
        upsertAutomation: (automation) =>
            set((state) => commitAutomationRunWindows(state, {
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
        removeAutomation: (automationId, removedRevision) => {
            set((state) => {
                if (state.profileScope && !triggerReceiptOrdering.admitRemoval(state.profileScope, automationId, removedRevision)) return state;
                runTraversalTokensByAutomationId.delete(automationId);
                let nextTriggerSets = state.workflowTriggerSetsById;
                if (nextTriggerSets[automationId] !== undefined) {
                    const remaining = { ...nextTriggerSets };
                    delete remaining[automationId];
                    nextTriggerSets = remaining;
                }
                let nextTriggerQueries = state.workflowTriggerSetIdsByQuery;
                for (const [key, ids] of Object.entries(state.workflowTriggerSetIdsByQuery)) {
                    if (!ids.includes(automationId)) continue;
                    nextTriggerQueries = { ...nextTriggerQueries, [key]: ids.filter(id => id !== automationId) };
                }
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
                    workflowTriggerSetsById: nextTriggerSets,
                    workflowTriggerSetIdsByQuery: nextTriggerQueries,
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
