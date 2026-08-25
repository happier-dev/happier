import type {
    AutomationDefinition,
    AutomationDefinitionRun,
} from '@/sync/domains/automations/automationTypes';
import {
    attachAutomationDefinitionDetail,
    hasMatchingAutomationDefinitionSummary,
    markAutomationDefinitionContentUnavailable,
} from '@/sync/domains/automations/automationDefinitionProjection';
import { getAutomationDefinitionRunOriginAt } from '@/sync/domains/automations/automationRunOrigin';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';

import type { StoreGet, StoreSet } from './_shared';

const AUTOMATION_RUNS_MAX_ENTRIES_PER_AUTOMATION = loadSyncTuning().automationRunsMaxEntriesPerAutomation;

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
        return hasMatchingAutomationDefinitionSummary(previous, incoming)
            ? markAutomationDefinitionContentUnavailable(incoming)
            : incoming;
    }

    const retained = attachAutomationDefinitionDetail(incoming, previous.detail.value);
    return retained
        ? { ...retained, linkedExistingSessionId: previous.linkedExistingSessionId }
        : incoming;
}

export type AutomationsDomain = {
    automations: Record<string, AutomationDefinition>;
    automationRunsByAutomationId: Record<string, AutomationDefinitionRun[]>;
    automationRunNextCursorByAutomationId: Record<string, string | null>;
    applyAutomations: (automations: AutomationDefinition[]) => void;
    upsertAutomation: (automation: AutomationDefinition) => void;
    removeAutomation: (automationId: string) => void;
    setAutomationRuns: (automationId: string, runs: AutomationDefinitionRun[], nextCursor: string | null) => void;
    refreshAutomationRunsWindow: (
        automationId: string,
        runs: AutomationDefinitionRun[],
        nextCursor: string | null,
    ) => void;
    appendAutomationRuns: (
        automationId: string,
        expectedCursor: string,
        runs: AutomationDefinitionRun[],
        nextCursor: string | null,
    ) => void;
    upsertAutomationRun: (run: AutomationDefinitionRun) => void;
};

function mergeRunsNewestFirst(runs: AutomationDefinitionRun[]): AutomationDefinitionRun[] {
    const uniqueRuns = new Map<string, AutomationDefinitionRun>();
    for (const run of runs) {
        const existing = uniqueRuns.get(run.id);
        if (!existing || run.updatedAt >= existing.updatedAt) {
            uniqueRuns.set(run.id, run);
        }
    }
    return Array.from(uniqueRuns.values())
        .sort((left, right) => {
            const rightOriginAt = getAutomationDefinitionRunOriginAt(right);
            const leftOriginAt = getAutomationDefinitionRunOriginAt(left);
            if (rightOriginAt !== leftOriginAt) {
                return rightOriginAt - leftOriginAt;
            }
            return right.updatedAt - left.updatedAt;
        });
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
    runs: AutomationDefinitionRun[],
    retainedFloor = 0,
): AutomationDefinitionRun[] {
    const merged = mergeRunsNewestFirst(runs);
    return merged.slice(0, Math.max(AUTOMATION_RUNS_MAX_ENTRIES_PER_AUTOMATION, retainedFloor));
}

/**
 * The one writer that replaces an Automation's whole run projection: the
 * bounded newest-first window together with the server continuation that
 * belongs to it. Both facts come from the same response, so nothing here may
 * be updated without the other.
 */
function seedAutomationRunWindow<S extends AutomationsDomain>(
    state: S,
    automationId: string,
    runs: AutomationDefinitionRun[],
    nextCursor: string | null,
): S {
    return {
        ...state,
        automationRunsByAutomationId: {
            ...state.automationRunsByAutomationId,
            [automationId]: retainPassiveRunWindow(runs),
        },
        automationRunNextCursorByAutomationId: {
            ...state.automationRunNextCursorByAutomationId,
            [automationId]: nextCursor,
        },
    };
}

export function createAutomationsDomain<S extends AutomationsDomain>({
    set,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): AutomationsDomain {
    return {
        automations: {},
        automationRunsByAutomationId: {},
        automationRunNextCursorByAutomationId: {},
        applyAutomations: (automations) =>
            set((state) => {
                const next: Record<string, AutomationDefinition> = {};
                for (const automation of automations) {
                    next[automation.id] = retainCurrentDefinitionDetail({
                        previous: state.automations[automation.id],
                        incoming: automation,
                    });
                }
                return {
                    ...state,
                    automations: next,
                };
            }),
        upsertAutomation: (automation) =>
            set((state) => ({
                ...state,
                automations: {
                    ...state.automations,
                    [automation.id]: automation,
                },
            })),
        removeAutomation: (automationId) =>
            set((state) => {
                const nextAutomations = { ...state.automations };
                const nextRunsByAutomationId = { ...state.automationRunsByAutomationId };
                const nextRunCursorsByAutomationId = { ...state.automationRunNextCursorByAutomationId };
                delete nextAutomations[automationId];
                delete nextRunsByAutomationId[automationId];
                delete nextRunCursorsByAutomationId[automationId];
                return {
                    ...state,
                    automations: nextAutomations,
                    automationRunsByAutomationId: nextRunsByAutomationId,
                    automationRunNextCursorByAutomationId: nextRunCursorsByAutomationId,
                };
            }),
        setAutomationRuns: (automationId, runs, nextCursor) =>
            set((state) => seedAutomationRunWindow(state, automationId, runs, nextCursor)),
        refreshAutomationRunsWindow: (automationId, runs, nextCursor) =>
            set((state) => {
                const existing = state.automationRunsByAutomationId[automationId] ?? [];
                // A window no larger than the page the server just returned is
                // the passive projection: re-seeding it is exactly what the
                // reader would see by reopening the Automation, and everything
                // it drops is still reachable through the fresh continuation.
                if (existing.length <= runs.length) {
                    return seedAutomationRunWindow(state, automationId, runs, nextCursor);
                }
                // A larger window is a traversal the reader paid for page by
                // page, and the cursor it holds is the authoritative server
                // continuation for the END of that traversal. A refresh only
                // restates the newest page into it: replacing the window would
                // discard Runs the reader is looking at, and replacing the
                // continuation would rewind the traversal to the first page.
                return {
                    ...state,
                    automationRunsByAutomationId: {
                        ...state.automationRunsByAutomationId,
                        [automationId]: mergeRunsNewestFirst([...existing, ...runs]),
                    },
                };
            }),
        appendAutomationRuns: (automationId, expectedCursor, runs, nextCursor) =>
            set((state) => {
                if (state.automationRunNextCursorByAutomationId[automationId] !== expectedCursor) {
                    return state;
                }
                const existing = state.automationRunsByAutomationId[automationId] ?? [];
                // An explicit page is what the reader asked to see, so it is
                // retained in full and the server's continuation is recorded
                // verbatim. Deriving the continuation from the passive window
                // instead made the newest-first ceiling look like the end of
                // the Automation's history, with no way back to older Runs and
                // nothing said about it. The window this grows is bounded by
                // the pages the reader actually requested and collapses back
                // to the passive ceiling on the next full re-seed.
                return {
                    ...state,
                    automationRunsByAutomationId: {
                        ...state.automationRunsByAutomationId,
                        [automationId]: mergeRunsNewestFirst([...existing, ...runs]),
                    },
                    automationRunNextCursorByAutomationId: {
                        ...state.automationRunNextCursorByAutomationId,
                        [automationId]: nextCursor,
                    },
                };
            }),
        upsertAutomationRun: (run) =>
            set((state) => {
                const existing = state.automationRunsByAutomationId[run.automationId] ?? [];
                const filtered = existing.filter((entry) => entry.id !== run.id);
                const next = retainPassiveRunWindow([run, ...filtered], existing.length);
                return {
                    ...state,
                    automationRunsByAutomationId: {
                        ...state.automationRunsByAutomationId,
                        [run.automationId]: next,
                    },
                };
            }),
    };
}
