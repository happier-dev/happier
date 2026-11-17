import { afterEach, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { createRootLayoutFeaturesResponse, renderHook, standardCleanup } from '@/dev/testkit';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { usePetReferencePackage } from './usePetReferencePackage';

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
