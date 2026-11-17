import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { useSelectedPetPackage } from './useSelectedPetPackage';

afterEach(() => {
    standardCleanup();
    vi.unstubAllGlobals();
});

it('does no inventory traversal or render for unrelated pet library changes', async () => {
    const previous = storage.getState();
    // HTTP is the boundary; feature decisions, settings and the store remain real.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: {} }), {
        headers: { 'Content-Type': 'application/json' },
    })));
    try {
        storage.setState(state => ({
            settings: { ...state.settings, experiments: true,
                featureToggles: { ...state.settings.featureToggles, 'pets.companion': true },
                petsEnabled: true, petsSelectedPetRef: { kind: 'builtIn', petId: 'milo' } },
            localSettings: { ...state.localSettings, petsEnabledOverride: 'inherit',
                petsSelectedPetOverride: { kind: 'inherit' } },
            accountPetsById: {}, localPetSourcesBySourceKey: {},
        }));
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useSelectedPetPackage();
        });
        expect(hook.getCurrent()).toMatchObject({ enabled: true, source: { kind: 'builtIn', petId: 'milo' } });
        const before = renders;
        let traversals = 0;
        for (let update = 0; update < 10; update += 1) {
            // ownKeys measures whole-library traversal without replacing any domain logic.
            const library = new Proxy({}, { ownKeys: target => { traversals += 1; return Reflect.ownKeys(target); } });
            await act(async () => {
                storage.setState({ accountPetsById: library, localPetSourcesBySourceKey: library });
            });
        }
        console.info('PET-LOGIC-AUDIT selection', { updates: 10, renders: renders - before, traversals });
        expect(renders - before).toBe(0);
        expect(traversals).toBe(0);
        await act(async () => {
            storage.setState(state => ({ settings: { ...state.settings,
                petsSelectedPetRef: { kind: 'builtIn', petId: 'blink' } } }));
        });
        expect(hook.getCurrent().source).toEqual({ kind: 'builtIn', petId: 'blink' });
        await hook.unmount();
    } finally {
        await act(async () => { storage.setState(previous, true); });
    }
});
