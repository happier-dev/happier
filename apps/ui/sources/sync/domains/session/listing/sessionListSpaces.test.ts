import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { useCollectionSpaceSelection, writeCollectionSpaceSelectionV1 } from './sessionListSpaces';
import { clearPersistenceStorage, getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { accountSettingsScopeKeySuffix } from '@/sync/domains/settings/scope/accountSettingsScope';
import { getStorage } from '@/sync/domains/state/storageStore';

afterEach(() => { standardCleanup(); vi.restoreAllMocks(); clearPersistenceStorage(); });
describe('device collection selection', () => {
    it('publishes only the mounted Account and entity while preserving genuine selection changes', async () => {
        const scope = { serverId: 'collection-observation', accountId: 'alice' };
        const scopeKey = accountSettingsScopeKeySuffix(scope);
        let renders = 0;
        const hook = await renderHook(() => { renders++; return useCollectionSpaceSelection(scopeKey, 'sessionWork'); });
        const before = renders;
        await act(async () => {
            await writeCollectionSpaceSelectionV1({ scope: { ...scope, accountId: 'bob' }, entityKind: 'sessionWork', spaceId: 'my-work',
                isCurrent: () => true, readSettings: () => ({ collectionSpacesV1: { v: 1, spaces: [] } }) });
            await writeCollectionSpaceSelectionV1({ scope, entityKind: 'workflow', spaceId: 'all-workflows',
                isCurrent: () => true, readSettings: () => ({ collectionSpacesV1: { v: 1, spaces: [] } }) });
        });
        expect(renders).toBe(before);
        const select = () => writeCollectionSpaceSelectionV1({ scope, entityKind: 'sessionWork', spaceId: 'my-work',
            isCurrent: () => true, readSettings: () => ({ collectionSpacesV1: { v: 1, spaces: [] } }) });
        await act(async () => { await select(); });
        expect(hook.getCurrent().byAccountScope[scopeKey]?.sessionWork?.spaceId).toBe('my-work');
        const changed = renders;
        await act(async () => { await select(); });
        expect(renders).toBe(changed);
    });
    it('persists genuine collection navigation without publishing the LocalSettings document', async () => {
        const scope = { serverId: 'collection-navigation', accountId: 'alice' };
        const store = getStorage();
        const original = store.getState().localSettings;
        const write = vi.spyOn(getPersistenceStorage(), 'set');
        try {
            for (let index = 0; index < 4; index++) {
                expect(await writeCollectionSpaceSelectionV1({ scope, entityKind: 'sessionWork', spaceId: 'my-work',
                    isCurrent: () => true, readSettings: () => ({ collectionSpacesV1: { v: 1, spaces: [] } }) })).toEqual({ ok: true });
            }
            expect(store.getState().localSettings).toBe(original);
            expect(write.mock.calls.filter(([key]) => key === 'local-settings')).toHaveLength(0);
            const qualified = JSON.stringify([accountSettingsScopeKeySuffix(scope), 'sessionWork']);
            expect(getPersistenceStorage().getString(`ui-state:collection-space-v1:${qualified}`)).toBe('"my-work"');
        } finally {
            store.setState({ localSettings: original });
        }
    });
});
