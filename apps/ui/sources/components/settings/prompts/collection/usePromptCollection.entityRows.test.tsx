import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { installPromptLibrarySettingsCommonModuleMocks } from '../promptLibrarySettingsTestHelpers';

installPromptLibrarySettingsCommonModuleMocks({ storage: importOriginal => importOriginal() });

const { storage } = await import('@/sync/domains/state/storage');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { usePromptCollection } = await import('./PromptCollectionList');
const { usePromptLibraryEntryMeta } = await import('./usePromptLibraryEntryMeta');

const scope = { serverId: 'catalog-home', accountId: 'catalog-account' };
const invocation = { id: 'row-template', token: '/catalog', title: 'Catalog template',
    target: { kind: 'doc' as const, artifactId: 'doc-1' }, behavior: 'insert' as const,
    allowArgs: false, availableIn: 'global' as const };

function publish(title: string, revision: number) {
    applyPromptLibraryCatalogSnapshot(scope, {
        catalog: { status: 'ready', rows: [{ record: { key: 'invocations', value: { v: 1,
            entries: [{ ...invocation, title }] } }, revision }], tombstones: [], diagnostics: [] },
        rawSettings: {}, sourceSettingsVersion: 7,
    }, true);
}

describe('prompt collection catalog source', () => {
    beforeEach(() => {
        resetPromptLibraryCatalogEngineForTests();
        resetPromptLibraryCatalogSnapshotsForTests();
        storage.setState({ profileScope: scope, settingsScope: scope, settingsVersion: 7, isDataReady: true,
            settings: settingsDefaults });
        publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://catalog.invalid', generation: 1 });
        publish('Catalog template', 2);
    });

    it('displays the authoritative row and follows catalog-only refresh without a Settings change', async () => {
        const settings = storage.getState().settings;
        const hook = await renderHook(() => usePromptCollection('template', ''));
        expect(hook.getCurrent().groups[0]?.rows).toEqual([{ id: 'row-template', title: 'Catalog template', subtitle: '/catalog' }]);
        await act(async () => { publish('Changed from another client', 3); });
        expect(hook.getCurrent().groups[0]?.rows[0]?.title).toBe('Changed from another client');
        expect(storage.getState().settings).toBe(settings);
        expect(storage.getState().settingsVersion).toBe(7);
    });

    it('groups authored documents under the row-backed folder', async () => {
        storage.getState().updateArtifact({ id: 'doc-1', title: 'Prompt', headerVersion: 1, bodyVersion: 1,
            ownerAccountId: scope.accountId, access: 'owner',
            header: { kind: 'prompt_doc.v2', title: 'Prompt', folderId: 'catalog-folder' }, body: null,
            createdAt: 1, updatedAt: 1, seq: 1, isDecrypted: true });
        applyPromptLibraryCatalogSnapshot(scope, {
            catalog: { status: 'ready', rows: [{ record: { key: 'folders', value: { v: 1,
                folders: [{ id: 'catalog-folder', name: 'From catalog', parentId: null }] } }, revision: 4 }],
                tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7,
        }, true);
        const hook = await renderHook(() => usePromptCollection('doc', ''));
        expect(hook.getCurrent().groups[0]).toEqual({ id: 'catalog-folder', title: 'From catalog',
            rows: [{ id: 'doc-1', title: 'Prompt' }] });
    });

    it('reflects external-link row changes in the saved entry metadata without a Settings write', async () => {
        const settings = storage.getState().settings;
        applyPromptLibraryCatalogSnapshot(scope, {
            catalog: { status: 'ready', rows: [{ record: { key: 'external-links', value: { v: 1, links: [{
                id: 'export-link', artifactId: 'doc-1', assetTypeId: 'claude.instructions',
                scope: 'user', machineId: 'machine-1', externalRef: { path: '/instructions.md' },
            }] } }, revision: 4 }], tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7,
        }, true);
        const hook = await renderHook(() => usePromptLibraryEntryMeta('doc-1'));
        expect(hook.getCurrent().map(fact => fact.key)).toEqual(['exports']);
        await act(async () => { applyPromptLibraryCatalogSnapshot(scope, {
            catalog: { status: 'ready', rows: [{ record: { key: 'external-links', value: { v: 1, links: [] } }, revision: 5 }],
                tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7,
        }, true); });
        expect(hook.getCurrent()).toEqual([]);
        expect(storage.getState().settings).toBe(settings);
        expect(storage.getState().settingsVersion).toBe(7);
    });
});
