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
    appendAutomationRuns: (
        automationId: string,
        expectedCursor: string,
        runs: AutomationDefinitionRun[],
        nextCursor: string | null,
    ) => void;
    upsertAutomationRun: (run: AutomationDefinitionRun) => void;
};

function sortRunsNewestFirst(runs: AutomationDefinitionRun[]): AutomationDefinitionRun[] {
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
        })
        .slice(0, AUTOMATION_RUNS_MAX_ENTRIES_PER_AUTOMATION);
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
            set((state) => ({
                ...state,
                automationRunsByAutomationId: {
                    ...state.automationRunsByAutomationId,
                    [automationId]: sortRunsNewestFirst(runs),
                },
                automationRunNextCursorByAutomationId: {
                    ...state.automationRunNextCursorByAutomationId,
                    [automationId]: nextCursor,
                },
            })),
        appendAutomationRuns: (automationId, expectedCursor, runs, nextCursor) =>
            set((state) => {
                if (state.automationRunNextCursorByAutomationId[automationId] !== expectedCursor) {
                    return state;
                }
                const existing = state.automationRunsByAutomationId[automationId] ?? [];
                return {
                    ...state,
                    automationRunsByAutomationId: {
                        ...state.automationRunsByAutomationId,
                        [automationId]: sortRunsNewestFirst([...existing, ...runs]),
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
                const next = sortRunsNewestFirst([run, ...filtered]);
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
