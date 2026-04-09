import { beforeEach, describe, expect, it, vi } from 'vitest';

const getReadyServerFeaturesMock = vi.fn();

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (params: unknown) => getReadyServerFeaturesMock(params),
}));

describe('resolvePreferScopedMachineRpc', () => {
    beforeEach(() => {
        vi.resetModules();
        getReadyServerFeaturesMock.mockReset();
    });

    it('fails closed (preferScoped=true) when server feature evaluation throws', async () => {
        getReadyServerFeaturesMock.mockRejectedValueOnce(new Error('boom'));

        const { resolvePreferScopedMachineRpc } = await import('./resolvePreferScopedMachineRpc');

        await expect(resolvePreferScopedMachineRpc({ machineId: 'm1', serverId: 'server-1' })).resolves.toBe(true);
    });
});
