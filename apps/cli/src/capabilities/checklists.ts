import { AGENTS } from '@/agent/catalog/registry';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/agent/catalog/ids';

import { CHECKLIST_IDS, resumeChecklistId, type ChecklistId } from './checklistIds';
import type { CapabilityDetectRequest } from './types';
import { createInstallableCapabilityRequests } from './registry/installables';

let cachedChecklists: Record<ChecklistId, CapabilityDetectRequest[]> | null = null;

function createCliAgentRequests(): CapabilityDetectRequest[] {
    return (Object.values(AGENTS) as AgentCatalogEntry[]).map((entry) => ({
        id: `cli.${entry.id}`,
    }));
}

function mergeChecklistContributions(
    base: Record<ChecklistId, CapabilityDetectRequest[]>,
): Record<ChecklistId, CapabilityDetectRequest[]> {
    const next: Record<ChecklistId, CapabilityDetectRequest[]> = { ...base };

    for (const entry of Object.values(AGENTS) as AgentCatalogEntry[]) {
        const contributions = entry.checklists;
        if (!contributions) continue;

        for (const [checklistId, requests] of Object.entries(contributions) as Array<
            [ChecklistId, ReadonlyArray<{ id: string; params?: Record<string, unknown> }>]
        >) {
            const normalized: CapabilityDetectRequest[] = requests.map((r) => ({
                id: r.id as CapabilityDetectRequest['id'],
                ...(r.params ? { params: r.params } : {}),
            }));
            next[checklistId] = [...(next[checklistId] ?? []), ...normalized];
        }
    }

    return next;
}

const resumeChecklistEntries = CATALOG_AGENT_IDS.reduce<Record<`resume.${CatalogAgentId}`, CapabilityDetectRequest[]>>(
    (entries, id) => {
        entries[resumeChecklistId(id)] = [];
        return entries;
    },
    {} as Record<`resume.${CatalogAgentId}`, CapabilityDetectRequest[]>,
);

function buildChecklists(): Record<ChecklistId, CapabilityDetectRequest[]> {
    const cliAgentRequests = createCliAgentRequests();
    const installableDependencyRequests = createInstallableCapabilityRequests();
    const baseChecklists = {
        [CHECKLIST_IDS.NEW_SESSION]: [
            ...cliAgentRequests,
            { id: 'tool.tmux' },
            { id: 'tool.windowsTerminal' },
            { id: 'tool.executionRuns' },
        ],
        [CHECKLIST_IDS.MACHINE_DETAILS]: [
            ...cliAgentRequests,
            { id: 'tool.tmux' },
            { id: 'tool.windowsTerminal' },
            { id: 'tool.executionRuns' },
            ...installableDependencyRequests,
        ],
        ...resumeChecklistEntries,
    } satisfies Record<ChecklistId, CapabilityDetectRequest[]>;

    return mergeChecklistContributions(baseChecklists);
}

function resolveChecklists(): Record<ChecklistId, CapabilityDetectRequest[]> {
    if (cachedChecklists) return cachedChecklists;
    cachedChecklists = buildChecklists();
    return cachedChecklists;
}

export const checklists: Record<ChecklistId, CapabilityDetectRequest[]> = new Proxy(
    {} as Record<ChecklistId, CapabilityDetectRequest[]>,
    {
        get(_target, property, receiver) {
            return Reflect.get(resolveChecklists(), property, receiver);
        },
        has(_target, property) {
            return Reflect.has(resolveChecklists(), property);
        },
        ownKeys() {
            return Reflect.ownKeys(resolveChecklists());
        },
        getOwnPropertyDescriptor(_target, property) {
            const descriptor = Reflect.getOwnPropertyDescriptor(resolveChecklists(), property);
            if (!descriptor) return undefined;
            return {
                ...descriptor,
                configurable: true,
            };
        },
    },
);
