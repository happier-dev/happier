import { AGENTS } from '@/agent/catalog/registry';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/agent/catalog/ids';
import {
    BUILT_IN_INSTALLABLES_REGISTRY,
    type InstallablesRegistry,
} from '@happier-dev/protocol/installables';

import { CHECKLIST_IDS, resumeChecklistId, type ChecklistId } from './checklistIds';
import type { CapabilityDetectRequest } from './types';
import { createInstallableCapabilityRequests } from './registry/installables';

function createCliAgentRequests(): CapabilityDetectRequest[] {
    return (Object.values(AGENTS) as AgentCatalogEntry[]).map((entry) => ({
        id: `cli.${entry.id}`,
    }));
}

function mergeChecklistContributions(
    base: Record<ChecklistId, CapabilityDetectRequest[]>,
): Record<ChecklistId, CapabilityDetectRequest[]> {
    const next: Record<ChecklistId, CapabilityDetectRequest[]> = { ...base };

    for (const [agentId, contribution] of readAgentCatalogSnapshot().agentDefinitionsById) {
        if (contribution.richDefinition?.definition.catalog?.resumeChecklist?.includeLoginStatus !== true) {
            continue;
        }

        const checklistId = resumeChecklistId(agentId);
        next[checklistId] = [
            ...(next[checklistId] ?? []),
            { id: `cli.${agentId}`, params: { includeLoginStatus: true } },
        ];
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

export function createCapabilityChecklists(
    installablesRegistry: Pick<InstallablesRegistry, 'descriptors'> = BUILT_IN_INSTALLABLES_REGISTRY,
): Record<ChecklistId, CapabilityDetectRequest[]> {
    const cliAgentRequests = createCliAgentRequests();
    const installableDependencyRequests = createInstallableCapabilityRequests(installablesRegistry);
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

/**
 * Built fresh on every access. `AGENTS` is a live projection of the current Agent
 * catalog (`readAgentCatalogSnapshot`), so an Agent contributed by a plugin that
 * activated after the first read must still appear here; memoizing this table
 * froze the checklist set to whichever catalog happened to exist first.
 */
function resolveChecklists(): Record<ChecklistId, CapabilityDetectRequest[]> {
    return createCapabilityChecklists();
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
