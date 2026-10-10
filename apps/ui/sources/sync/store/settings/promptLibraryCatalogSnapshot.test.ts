import { afterEach, describe, expect, it } from 'vitest';
import { applyPromptLibraryCatalogSnapshot, beginPromptLibraryCatalogLoad, getPromptLibraryCatalogValue,
    resetPromptLibraryCatalogSnapshotsForTests } from './promptLibraryCatalogSnapshot';
afterEach(resetPromptLibraryCatalogSnapshotsForTests);
const scope = { serverId: 'home', accountId: 'account' };
const catalog = { status: 'ready' as const, rows: [{ record: { key: 'folders' as const,
    value: { v: 1 as const, folders: [{ id: 'folder', name: 'Folder' }] } }, revision: 3 }], tombstones: [], diagnostics: [] };
describe('Prompt library scoped publications', () => {
    it('keeps unchanged active domains stable across preference revisions and sibling catalog edits', () => {
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, true);
        const first = getPromptLibraryCatalogValue(scope, 'folders');
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 2 }, true);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toBe(first);
        applyPromptLibraryCatalogSnapshot({ serverId: 'other', accountId: 'account' }, { catalog, rawSettings: {}, sourceSettingsVersion: 3 }, true);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toBe(first);
    });
    it('retains display content while refreshing, rejects retired results, and withdraws private data on lost admission', () => {
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, true);
        const value = getPromptLibraryCatalogValue(scope, 'folders').value;
        beginPromptLibraryCatalogLoad(scope);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ status: 'loading', stale: true, value });
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, false);
        expect(getPromptLibraryCatalogValue(scope, 'folders').status).toBe('loading');
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'unavailable', reason: 'encryption-material-unavailable' },
            rawSettings: {}, sourceSettingsVersion: 1 }, true);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ status: 'unavailable', value: null });
    });
});
