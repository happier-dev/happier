import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks } from '../../prompts/registries/promptRegistriesScreenTestHelpers';

installPromptRegistriesCommonModuleMocks({ storage: original => original() });
const { createPlainPromptLibraryCatalogHomeFixture } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { usePluginRegistrySourceAdministration } = await import('./usePluginRegistrySourceAdministration');

async function setup(outcome: 'updated' | 'conflict' = 'updated') {
    const fixture = await createPlainPromptLibraryCatalogHomeFixture(`https://plugin-sources-${outcome}.test`, {
        key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{ id: 'user-source', title: 'Private catalog',
            format: 'happier-catalog', kinds: ['plugin'], url: 'https://catalog.test/index.json', enabled: true, addedAt: 1,
            token: { secretRef: 'catalog-token' } }] },
    }, outcome);
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    const hook = await renderHook(() => usePluginRegistrySourceAdministration({ enabled: true, focused: true }));
    await vi.waitFor(() => expect(hook.getCurrent().registry?.sources).toContainEqual(expect.objectContaining({ id: 'user-source' })));
    return { fixture, hook };
}

describe('marketplace source presentation through the Account registry owner', () => {
    it.each(['updated', 'conflict'] as const)('reads without a Machine and reports only the acknowledged Account mutation: %s', async outcome => {
        const { fixture, hook } = await setup(outcome);
        expect(hook.getCurrent().available).toBe(true);
        let result: Awaited<ReturnType<ReturnType<typeof hook.getCurrent>['setSourceEnabled']>> | undefined;
        await act(async () => { result = await hook.getCurrent().setSourceEnabled('user-source', false); });
        if (outcome === 'updated') {
            expect(result).toEqual({ status: 'success' });
            expect(fixture.read().record.value).toMatchObject({ sources: [{ id: 'user-source', enabled: false, token: { secretRef: 'catalog-token' } }] });
        } else {
            expect(result).toMatchObject({ status: 'unavailable' });
            expect(fixture.read().record.value).toMatchObject({ sources: [{ id: 'user-source', enabled: true }] });
        }
        expect(fixture.mutations).toEqual([{ key: 'registry-sources', expectedRevision: 4 }]);
        expect(fixture.settingsWrites()).toBe(0);
        expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    });
    it('binds the npm profile through the credential Action and refuses source-URL edits', async () => {
        const { fixture, hook } = await setup();
        await act(async()=>expect(await hook.getCurrent().setSourceRegistryProfile('user-source', 'npm-profile')).toEqual({ status: 'success' }));
        expect(fixture.read().record.value).toMatchObject({sources:[{id:'user-source',npmRegistryProfileId:'npm-profile',token:{secretRef:'catalog-token'}}]});
        expect(await hook.getCurrent().upsertSource({ sourceId: 'user-source', sourceUrl: 'https://replacement.test/index.json' }))
            .toMatchObject({ status: 'unavailable', reason: 'not_supported' });
        expect(fixture.mutations).toEqual([{key:'registry-sources',expectedRevision:4}]);
        expect(fixture.settingsWrites()).toBe(0);
        expect(fixture.read().record.value).toMatchObject({ sources: [{ id: 'user-source', url: 'https://catalog.test/index.json' }] });
    });
    it('withdraws the previous Account sources when credentials change before the displayed settings scope catches up', async () => {
        const { fixture, hook } = await setup();
        const { storage } = await import('@/sync/domains/state/storage');
        const displayedScope = storage.getState().settingsScope;
        expect(hook.getCurrent().registry?.sources).toContainEqual(expect.objectContaining({ id: 'user-source' }));
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const replacement = await TokenStorage.setCredentialsForServerUrlWithRollback(fixture.home.serverUrl, { serverId: fixture.home.id }, {
            token: `e30.${Buffer.from(JSON.stringify({ sub: 'replacement-account' })).toString('base64url')}.signature`,
        });
        if (!replacement) throw new Error('Replacement credential admission failed');
        try {
            await vi.waitFor(() => expect(hook.getCurrent().available).toBe(false));
            expect(storage.getState().settingsScope).toEqual(displayedScope);
            expect(hook.getCurrent().registry).toBeNull();
        } finally { await replacement.rollback(); }
    });
});
