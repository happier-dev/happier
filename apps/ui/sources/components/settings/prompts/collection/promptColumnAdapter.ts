import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from '../../shell/settingsCollectionAdapter';
import type { PromptCollectionRow, PromptCollectionGroup } from './promptCollectionModel';

export const promptColumnAdapter = defineSettingsCollectionAdapter(['folder']);
export function promptColumnFacts(row: PromptCollectionRow, folderId: string | null): SettingsCollectionRowFacts<'folder'> {
    return { key: row.id, title: row.title, context: row.subtitle ?? null, status: null,
        fields: { folder: folderId === null ? [] : [folderId] } };
}
/** Uses the existing artifact/folder grouping; never writes a second organization tree. */
export function promptGroupColumnFacts(group: PromptCollectionGroup, expanded: boolean): SettingsCollectionRowFacts<'folder'> {
    return { key: group.id ?? 'unfiled', title: group.title ?? '', context: null, status: null, count: group.rows.length,
        children: group.rows.map(row => row.id), expanded, fields: { folder: group.id ? [group.id] : [] } };
}
