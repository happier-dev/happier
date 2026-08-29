import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
    BUILT_IN_INSTALLABLES_REGISTRY,
    type InstallablesRegistry,
} from '@happier-dev/protocol/installables';

import { CHECKLIST_IDS, resumeChecklistId, type ChecklistId } from './checklistIds';
import type { CapabilityDetectRequest } from './types';
import { createInstallableCapabilityRequests } from './registry/installables';

type AgentRegistryChecklistSnapshot = Pick<ResolvedContributionRegistry, 'agents' | 'agentDefinitionsById'>;

function createCliAgentRequests(
    agentRegistrySnapshot: AgentRegistryChecklistSnapshot,
): CapabilityDetectRequest[] {
    return agentRegistrySnapshot.agents.map((entry) => ({
        id: `cli.${entry.id}`,
    }));
}

function mergeChecklistContributions(
    base: Record<ChecklistId, CapabilityDetectRequest[]>,
    agentRegistrySnapshot: AgentRegistryChecklistSnapshot,
): Record<ChecklistId, CapabilityDetectRequest[]> {
    const next: Record<ChecklistId, CapabilityDetectRequest[]> = { ...base };

    for (const [agentId, contribution] of agentRegistrySnapshot.agentDefinitionsById) {
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

export function createCapabilityChecklists(
    installablesRegistry: Pick<InstallablesRegistry, 'descriptors'> = BUILT_IN_INSTALLABLES_REGISTRY,
    agentRegistrySnapshot: AgentRegistryChecklistSnapshot = getResolvedContributionRegistry(),
): Record<ChecklistId, CapabilityDetectRequest[]> {
    const cliAgentRequests = createCliAgentRequests(agentRegistrySnapshot);
    const installableDependencyRequests = createInstallableCapabilityRequests(installablesRegistry);
    const baseChecklists: Record<ChecklistId, CapabilityDetectRequest[]> = {
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
    };

    for (const entry of agentRegistrySnapshot.agents) {
        baseChecklists[resumeChecklistId(entry.id)] = [];
    }

    return mergeChecklistContributions(baseChecklists, agentRegistrySnapshot);
}

/**
 * Built fresh on every access from the current merged contribution registry, so
 * an Agent contributed by a plugin that activated after the first read must still
 * appear here; memoizing this table froze the checklist set to whichever catalog
 * happened to exist first.
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
