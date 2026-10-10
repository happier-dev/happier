import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';

import { createCurrentMachineExecutionOriginContextResolver } from './resolveCurrentMachineExecutionOriginContext';

function readyResponse(serverIdentityId = 'srv_current_machine_fixture'): Response {
    return new Response(JSON.stringify(FeaturesResponseSchema.parse({
            features: {},
            capabilities: { serverIdentity: { serverIdentityId } },
        })), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('createCurrentMachineExecutionOriginContextResolver', () => {
    beforeEach(() => {
        resetServerFeaturesClientForTests();
    });
    afterEach(() => vi.restoreAllMocks());

    it('does not reuse a cached Home identity at the next execution admission', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(readyResponse('srv_first_home')).mockResolvedValueOnce(readyResponse('srv_next_home'));
        const resolve = createCurrentMachineExecutionOriginContextResolver({ serverUrl: 'https://server.example.test', resolveCurrentMachineId: () => 'machine' });
        expect(await resolve()).toMatchObject({ serverIdentityId: 'srv_first_home' });
        expect(await resolve()).toMatchObject({ serverIdentityId: 'srv_next_home' });
    });

    it('stamps only a fresh ready server identity paired with the current machine id', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(readyResponse());
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
        expect(fetch).toHaveBeenCalledWith('https://server.example.test/v1/features', expect.objectContaining({ method: 'GET' }));
        expect(resolveCurrentMachineId).toHaveBeenCalledOnce();
    });

    it('fails closed when the fresh server result or current machine identity is unavailable', async () => {
        const resolveCurrentMachineExecutionOriginContext = createCurrentMachineExecutionOriginContextResolver({
            serverUrl: 'https://server.example.test',
            resolveCurrentMachineId: () => null,
        });

        const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
        await expect(resolveCurrentMachineExecutionOriginContext()).resolves.toBeNull();

        fetch.mockResolvedValue(readyResponse());
        await expect(resolveCurrentMachineExecutionOriginContext()).resolves.toBeNull();
    });

    it('honors cancellation after the fresh server read before admitting an origin', async () => {
        const controller = new AbortController();
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            controller.abort(new Error('cancelled after server read'));
            return readyResponse();
        });
        const resolveCurrentMachineExecutionOriginContext = createCurrentMachineExecutionOriginContextResolver({
            serverUrl: 'https://server.example.test',
            resolveCurrentMachineId: () => {
                return 'machine-current';
            },
        });

        await expect(resolveCurrentMachineExecutionOriginContext(controller.signal))
            .rejects.toThrow('cancelled after server read');
    });
});
