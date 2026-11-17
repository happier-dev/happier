import { afterEach, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { createRootLayoutFeaturesResponse, renderHook, standardCleanup } from '@/dev/testkit';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { usePetReferencePackage } from './usePetReferencePackage';
import type { AccountPetLibraryEntryV1 } from '@happier-dev/protocol/pets/accountLibrary';

const initialState = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(initialState, true); resetServerFeaturesClientForTests(); });

it('ignores companion preferences and does no library-driven work for a built-in or hidden face', async () => {
    upsertAndActivateServer({ serverUrl: 'https://pet-faces.example.test', scope: 'tab' });
    storage.getState().applySettingsLocal({ petsEnabled: false, experiments: true, featureToggles: { 'pets.companion': true, 'pets.sync': true } });
    primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
        features: { pets: { companion: { enabled: true }, sync: { enabled: true } } },
    }) } });
    let renders = 0;
    const hook = await renderHook(() => { renders++; return usePetReferencePackage({ kind: 'builtIn', petId: 'milo' }); });
    expect(hook.getCurrent().status).toBe('ready');
    let hiddenRenders = 0;
    const hidden = await renderHook(() => {
        hiddenRenders++;
        return usePetReferencePackage({ kind: 'accountPet', accountPetId: 'hidden' }, { enabled: false });
    });
    expect(hidden.getCurrent()).toEqual({ status: 'unavailable' });
    const hiddenBefore = hiddenRenders;
    const before = renders;
    await act(async () => { for (let i = 0; i < 10; i++) storage.setState({ accountPetsById: {} }); });
    expect(renders).toBe(before);
    expect(hiddenRenders).toBe(hiddenBefore);
    await hook.unmount();
    await hidden.unmount();
});

it('settles cold account lookup when the real store publishes the first empty list', async () => {
    upsertAndActivateServer({ serverUrl: 'https://pet-faces.example.test', scope: 'tab' });
    storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'pets.companion': true, 'pets.sync': true } });
    primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
        features: { pets: { companion: { enabled: true }, sync: { enabled: true } } },
    }) } });
    const hook = await renderHook(() => usePetReferencePackage({ kind: 'accountPet', accountPetId: 'missing' }));
    expect(hook.getCurrent()).toEqual({ status: 'pending' });
    await act(async () => { storage.getState().applyAccountPets([]); });
    expect(hook.getCurrent()).toEqual({ status: 'unavailable' });
    await hook.unmount();
});

it('matches a shared registry pet by origin despite an unrelated local id collision, and stays local to that pet', async () => {
    upsertAndActivateServer({ serverUrl: 'https://pet-faces.example.test', scope: 'tab' });
    storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'pets.companion': true, 'pets.sync': true } });
    primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
        features: { pets: { companion: { enabled: true }, sync: { enabled: true } } },
    }) } });
    const origin = { kind: 'registry', sourceId: 'petdex', itemId: 'moss' } as const;
    const pet = (accountPetId: string, petOrigin: AccountPetLibraryEntryV1['origin']): AccountPetLibraryEntryV1 => ({
        accountPetId, packageFormat: 'codex-compatible-atlas-v1',
        manifest: { id: accountPetId, displayName: accountPetId, description: 'An Account pet', spritesheetPath: 'spritesheet.webp' },
        spritesheetAssetRef: { assetId: accountPetId, mediaType: 'image/webp', digest: accountPetId, sizeBytes: 3 },
        digest: accountPetId, sizeBytes: 3, createdAt: 1, updatedAt: 1, origin: petOrigin,
    });
    storage.getState().applyAccountPets([pet('foreign-id', { kind: 'manualImport' })]);
    let renders = 0;
    const hook = await renderHook(() => {
        renders++;
        return usePetReferencePackage({ kind: 'accountPet', accountPetId: 'foreign-id', origin });
    });
    expect(hook.getCurrent()).toEqual({ status: 'unavailable' });
    await act(async () => { storage.getState().upsertAccountPet(pet('my-moss', origin)); });
    expect(hook.getCurrent()).toMatchObject({ status: 'ready', source: { accountPetId: 'my-moss' }, displayName: 'my-moss' });
    const settled = hook.getCurrent();
    const before = renders;
    await act(async () => {
        for (let i = 0; i < 10; i++) storage.getState().upsertAccountPet(pet(`other-${i}`, { kind: 'manualImport' }));
    });
    expect(renders).toBe(before);
    expect(hook.getCurrent()).toBe(settled);
    await act(async () => { storage.getState().upsertAccountPet({ ...pet('my-moss', origin), manifest: {
        ...pet('my-moss', origin).manifest, displayName: 'Moss updated',
    } }); });
    expect(hook.getCurrent()).toMatchObject({ status: 'ready', displayName: 'Moss updated' });
    await hook.unmount();
});
