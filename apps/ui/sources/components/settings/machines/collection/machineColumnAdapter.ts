import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from '../../shell/settingsCollectionAdapter';
import type { MachineCollectionRow, MachinePresetCollectionRow } from './machineCollectionModel';

export const machineColumnAdapter = defineSettingsCollectionAdapter(['home', 'status']);
export function machineColumnFacts(row: MachineCollectionRow): SettingsCollectionRowFacts<'home' | 'status'> {
    const id = row.kind === 'managed' ? row.managedId : row.machineId;
    return { key: `${row.serverId}:${row.kind}:${id}`, title: row.title,
        context: row.reason ?? row.host ?? row.platformLabel, status: row.status === 'unknown' ? null : row.status,
        fields: { home: [row.serverId], status: row.status === 'unknown' ? null : [row.status] } };
}
export function machinePresetColumnFacts(row: MachinePresetCollectionRow): SettingsCollectionRowFacts<'home' | 'status'> {
    return { key: `${row.serverId}:preset:${row.presetId}`, title: row.title, context: row.audience, status: null,
        fields: { home: [row.serverId], status: [] } };
}
