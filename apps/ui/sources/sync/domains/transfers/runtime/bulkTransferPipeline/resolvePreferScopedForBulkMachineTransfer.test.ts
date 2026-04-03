import { beforeEach, describe, expect, it, vi } from 'vitest';

const getReadyServerFeaturesMock = vi.fn();

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (params: unknown) => getReadyServerFeaturesMock(params),
}));

describe('resolvePreferScopedForBulkMachineTransfer', () => {
    beforeEach(() => {
        vi.resetModules();
        getReadyServerFeaturesMock.mockReset();
    });

    it('fails closed (preferScoped=true) when server feature evaluation throws', async () => {
        getReadyServerFeaturesMock.mockRejectedValueOnce(new Error('boom'));

        const { resolvePreferScopedForBulkMachineTransfer } = await import('./resolvePreferScopedForBulkMachineTransfer');

        await expect(resolvePreferScopedForBulkMachineTransfer({ machineId: 'm1', serverId: 'server-1' })).resolves.toBe(true);
    });
});
