import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from '../../shell/settingsCollectionAdapter';
import { describeHomeRow, type HomeCollectionRow, type HomeCollectionGroupRow } from './homeCollectionModel';

export const homeColumnAdapter = defineSettingsCollectionAdapter(['status']);
export function homeColumnFacts(row: HomeCollectionRow): SettingsCollectionRowFacts<'status'> {
    return { key: `home:${row.id}`, title: row.title, context: describeHomeRow(row), status: row.statusKey,
        fields: { status: [row.statusKey] } };
}
export function homeGroupColumnFacts(row: HomeCollectionGroupRow, expanded: boolean): SettingsCollectionRowFacts<'status'> {
    return { key: `group:${row.id}`, title: row.title, context: null, status: null, count: row.count, expanded,
        children: row.group.serverIds.map(id => `home:${id}`), fields: { status: null } };
}
