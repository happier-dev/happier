import type { Automation, AutomationRun } from '@/sync/domains/automations/automationTypes';

import type { StoreGet, StoreSet } from './_shared';

export type AutomationsDomain = {
    automations: Record<string, Automation>;
    automationRunsByAutomationId: Record<string, AutomationRun[]>;
    applyAutomations: (automations: Automation[]) => void;
    upsertAutomation: (automation: Automation) => void;
    removeAutomation: (automationId: string) => void;
    setAutomationRuns: (automationId: string, runs: AutomationRun[]) => void;
    upsertAutomationRun: (run: AutomationRun) => void;
};

function sortRunsNewestFirst(runs: AutomationRun[]): AutomationRun[] {
    return runs
        .slice()
        .sort((left, right) => {
            if (right.scheduledAt !== left.scheduledAt) {
                return right.scheduledAt - left.scheduledAt;
            }
            return right.updatedAt - left.updatedAt;
        });
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
        applyAutomations: (automations) =>
            set((state) => {
                const next: Record<string, Automation> = {};
                for (const automation of automations) {
                    next[automation.id] = automation;
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
                delete nextAutomations[automationId];
                delete nextRunsByAutomationId[automationId];
                return {
                    ...state,
                    automations: nextAutomations,
                    automationRunsByAutomationId: nextRunsByAutomationId,
                };
            }),
        setAutomationRuns: (automationId, runs) =>
            set((state) => ({
                ...state,
                automationRunsByAutomationId: {
                    ...state.automationRunsByAutomationId,
                    [automationId]: sortRunsNewestFirst(runs),
                },
            })),
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
