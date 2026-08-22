import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

const { fetchServerFeaturesSnapshot } = vi.hoisted(() => ({
    fetchServerFeaturesSnapshot: vi.fn(),
}));

vi.mock('@/features/serverFeaturesClient', () => ({
    fetchServerFeaturesSnapshot,
}));

import { createCurrentMachineExecutionOriginContextResolver } from './resolveCurrentMachineExecutionOriginContext';

function readySnapshot(serverIdentityId = 'srv_current_machine_fixture'): CliServerFeaturesSnapshot {
    return {
        status: 'ready',
        features: FeaturesResponseSchema.parse({
            features: {},
            capabilities: { serverIdentity: { serverIdentityId } },
        }),
    };
}

describe('createCurrentMachineExecutionOriginContextResolver', () => {
    beforeEach(() => {
        fetchServerFeaturesSnapshot.mockReset();
    });

    it('stamps only a fresh ready server identity paired with the current machine id', async () => {
        fetchServerFeaturesSnapshot.mockResolvedValue(readySnapshot());
        const resolveCurrentMachineId = vi.fn(() => 'machine-current');
        const resolveCurrentMachineExecutionOriginContext = createCurrentMachineExecutionOriginContextResolver({
            serverUrl: 'https://server.example.test',
            resolveCurrentMachineId,
            timeoutMs: 1_500,
        });

        await expect(resolveCurrentMachineExecutionOriginContext()).resolves.toEqual({
            serverIdentityId: 'srv_current_machine_fixture',
            machineId: 'machine-current',
        });
        expect(fetchServerFeaturesSnapshot).toHaveBeenCalledWith({
            serverUrl: 'https://server.example.test',
            timeoutMs: 1_500,
        });
        expect(resolveCurrentMachineId).toHaveBeenCalledOnce();
    });

    it('fails closed when the fresh server result or current machine identity is unavailable', async () => {
        const resolveCurrentMachineExecutionOriginContext = createCurrentMachineExecutionOriginContextResolver({
            serverUrl: 'https://server.example.test',
            resolveCurrentMachineId: () => null,
        });

        fetchServerFeaturesSnapshot.mockResolvedValue({
            status: 'unsupported',
            reason: 'endpoint_missing',
        });
        await expect(resolveCurrentMachineExecutionOriginContext()).resolves.toBeNull();

        fetchServerFeaturesSnapshot.mockResolvedValue(readySnapshot());
        await expect(resolveCurrentMachineExecutionOriginContext()).resolves.toBeNull();
    });

    it('honors cancellation after the fresh server read before admitting an origin', async () => {
        const controller = new AbortController();
        fetchServerFeaturesSnapshot.mockResolvedValue(readySnapshot());
        const resolveCurrentMachineExecutionOriginContext = createCurrentMachineExecutionOriginContextResolver({
            serverUrl: 'https://server.example.test',
            resolveCurrentMachineId: () => {
                controller.abort(new Error('cancelled after server read'));
                return 'machine-current';
            },
        });

        await expect(resolveCurrentMachineExecutionOriginContext(controller.signal))
            .rejects.toThrow('cancelled after server read');
    });
});
