import { pickMostBlockingCapabilityStatus, type CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from '../../shell/settingsCollectionAdapter';
import type { McpServerCollectionRow } from './mcpServerCollectionModel';

export const mcpColumnAdapter = defineSettingsCollectionAdapter(['status', 'runsOn']);

/** Reach and sign-in admission remain at the MCP owners; unknown reach is not an empty set. */
export function mcpColumnFacts(row: McpServerCollectionRow, input: Readonly<{
    machineIds: readonly string[] | null;
    statuses: readonly CapabilityStatus[];
}>): SettingsCollectionRowFacts<'status' | 'runsOn'> {
    return { key: row.server.id, title: row.title, context: row.server.description ?? null,
        status: pickMostBlockingCapabilityStatus(input.statuses)?.kind ?? null,
        count: row.server.toolsSnapshot?.tools.length ?? null,
        fields: { status: [...(row.unbound ? ['off'] : []), ...input.statuses.map(status => status.kind)], runsOn: input.machineIds } };
}
