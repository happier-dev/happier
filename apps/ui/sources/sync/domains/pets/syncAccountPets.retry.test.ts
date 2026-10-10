import { afterEach, expect, it, vi } from 'vitest';

import { createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { fetchAndApplyAccountPets } from './syncAccountPets';

const initialState = storage.getState();
afterEach(() => {
    storage.setState(initialState, true);
    resetServerFeaturesClientForTests();
});

it('rejects a transient currentness transport failure and applies the next authoritative pet list', async () => {
    upsertAndActivateServer({ serverUrl: 'https://pets.example.test', scope: 'tab' });
    storage.getState().applySettingsLocal({ featureToggles: { pets: true, 'pets.sync': true } });
    primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
        features: { pets: { enabled: true, sync: { enabled: true } } },
    }) } });
    const failure = new TypeError('Failed to fetch');
    const request = vi.fn(async (path: string) => new Response(JSON.stringify(
        path === '/v1/account/encryption/currentness'
            ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
            : { ok: true, pets: [] },
    ), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    request.mockRejectedValueOnce(failure);
    const applyAccountPets = vi.fn();
    const params = { credentials: { token: 'token', secret: 'secret' }, request, applyAccountPets };

    await expect(fetchAndApplyAccountPets(params)).rejects.toBe(failure);
    expect(applyAccountPets).not.toHaveBeenCalled();
    await expect(fetchAndApplyAccountPets(params)).resolves.toEqual({ status: 'applied', count: 0 });
    expect(applyAccountPets).toHaveBeenCalledWith([]);
});
