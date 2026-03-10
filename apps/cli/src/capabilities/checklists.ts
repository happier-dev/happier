import type { AgentCatalogEntry } from '@/backends/catalog';
import { AGENTS } from '@/backends/catalog';
import { CATALOG_AGENT_IDS } from '@/backends/types';
import type { CatalogAgentId } from '@/backends/types';
import { CODEX_ACP_DEP_ID } from '@happier-dev/protocol/installables';

import { CHECKLIST_IDS, resumeChecklistId, type ChecklistId } from './checklistIds';
import type { CapabilityDetectRequest } from './types';

const cliAgentRequests: CapabilityDetectRequest[] = (Object.values(AGENTS) as AgentCatalogEntry[]).map((entry) => ({
    id: `cli.${entry.id}`,
}));

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

const resumeChecklistEntries = Object.fromEntries(
    CATALOG_AGENT_IDS.map((id) => {
        return [resumeChecklistId(id), [] satisfies CapabilityDetectRequest[]] as const;
    }),
) as unknown as Record<`resume.${CatalogAgentId}`, CapabilityDetectRequest[]>;

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
        { id: CODEX_ACP_DEP_ID },
    ],
    ...resumeChecklistEntries,
} satisfies Record<ChecklistId, CapabilityDetectRequest[]>;

export const checklists: Record<ChecklistId, CapabilityDetectRequest[]> = mergeChecklistContributions(baseChecklists);
