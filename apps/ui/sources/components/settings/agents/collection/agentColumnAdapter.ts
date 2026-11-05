import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from '../../shell/settingsCollectionAdapter';
import type { AgentCollectionRow } from './agentCollectionModel';
import type { HeldMachineAgentSummary } from '@/agents/machineAgents/machineAgentInventoryStore';
import { t } from '@/text';

export const agentColumnAdapter = defineSettingsCollectionAdapter(['status', 'machine']);

/** Held installs survive failed checks; incomplete coverage is a lower bound, never an exact total. */
export function resolveAgentColumnContext(summary: HeldMachineAgentSummary | undefined, fallback: string | null): string | null {
    if (!summary || summary.machineCount === 0) return fallback;
    const count = summary.complete
        ? t('projects.identity.machineCount', { count: summary.machineCount })
        : t('settingsAgents.collection.machineCountAtLeast', { count: summary.machineCount });
    const version = summary.complete && summary.unknownVersionCount === 0 ? summary.versions.join(', ') : '';
    return [count, version].filter(Boolean).join(' · ');
}

export function agentColumnFacts(row: AgentCollectionRow, input: Readonly<{
    context: string | null; machineId: string | null;
    heldSummary?: HeldMachineAgentSummary;
}>): SettingsCollectionRowFacts<'status' | 'machine'> {
    return { key: row.key, title: row.entry.title, context: resolveAgentColumnContext(input.heldSummary, input.context),
        // Use the inventory's last verified attention; freshness alone does not resolve trouble.
        status: row.status === 'needsSignIn' && !row.trouble ? null : row.status,
        fields: { status: row.status === 'unknown' ? null : [row.status], machine: input.machineId ? [input.machineId] : null } };
}
