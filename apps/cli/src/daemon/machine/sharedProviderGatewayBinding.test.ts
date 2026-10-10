import { describe, expect, it } from 'vitest';

import { createMachineSharedProviderGatewayResolver } from './bootstrapMachineSyncRuntime';

describe('machine shared Provider gateway authority', () => {
    it('uses fresh exact Home/Account/machine authority and refuses missing or displaced custody', async () => {
        let accountId: string | null = 'account-one';
        let origin: Readonly<{ serverIdentityId: string; machineId: string }> | null = { serverIdentityId: 'home-one', machineId: 'machine-one' };
        const resolve = createMachineSharedProviderGatewayResolver({
            machineId: 'machine-one', readAccountId: () => accountId, readOrigin: async () => origin,
        });
        const request = { connectionId: 'connection-one', consumerId: 'model-catalog' };
        expect(await resolve(request)).toEqual({ homeId: 'home-one', accountId: 'account-one', machineId: 'machine-one', ...request });
        origin = { serverIdentityId: 'home-two', machineId: 'machine-one' };
        expect(await resolve(request)).toMatchObject({ homeId: 'home-two' });
        origin = { serverIdentityId: 'home-two', machineId: 'other-machine' };
        await expect(resolve(request)).rejects.toMatchObject({ code: 'provider_authorization_changed' });
        origin = null;
        await expect(resolve(request)).rejects.toMatchObject({ code: 'provider_authorization_changed' });
        origin = { serverIdentityId: 'home-two', machineId: 'machine-one' };
        accountId = null;
        await expect(resolve(request)).rejects.toMatchObject({ code: 'provider_authorization_changed' });
    });

    it('refuses cancellation during authority lookup before returning consumer access', async () => {
        const lifetime = new AbortController();
        const resolve = createMachineSharedProviderGatewayResolver({
            machineId: 'machine-one', readAccountId: () => 'account-one',
            readOrigin: async () => { lifetime.abort(); return { serverIdentityId: 'home-one', machineId: 'machine-one' }; },
        });
        await expect(resolve({ connectionId: 'connection-one', consumerId: 'model-catalog', signal: lifetime.signal })).rejects.toMatchObject({ name: 'AbortError' });
    });
});
