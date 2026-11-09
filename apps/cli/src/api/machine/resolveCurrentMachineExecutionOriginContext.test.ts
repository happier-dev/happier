import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import { observeServerFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

import { createCurrentMachineExecutionOriginContextResolver } from './resolveCurrentMachineExecutionOriginContext';
import { ApiClient } from '@/api/api';
import type { MachineRpcAdmissionBoundary } from './machineRpcAuthorization';

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

    it('feeds the actual Machine receiver from the ApiClient held Home without fetching features per request', async () => {
        let snapshot: CliServerFeaturesSnapshot | undefined = {
            status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_first_home' } } }),
        };
        const api = await ApiClient.create({ token: 'owner-token', encryption: null });
        api.setServerFeaturesSnapshotProvider(() => snapshot);
        const client = await api.machineSyncClient({ id: 'machine', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
        // Read the real installed receiving owner; no admission/runtime logic is substituted.
        const boundary = Reflect.get(client, 'machineRpcAdmissionBoundary') as MachineRpcAdmissionBoundary;
        const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(readyResponse('srv_unexpected_network'));
        try {
            expect(await boundary.resolveHomeServerIdentityId?.()).toBe('srv_first_home');
            expect(await boundary.resolveHomeServerIdentityId?.()).toBe('srv_first_home');
            snapshot = { status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
                capabilities: { serverIdentity: { serverIdentityId: 'srv_next_home' } } }) };
            expect(await boundary.resolveHomeServerIdentityId?.()).toBe('srv_next_home');
            snapshot = undefined;
            expect(await boundary.resolveHomeServerIdentityId?.()).toBeNull();
            let boundHome: string | null = 'srv_exact_saved_home';
            const bound = await api.machineSyncClient({ id: 'bound-machine', encryptionMode: 'plain', metadata: null,
                metadataVersion: 0, daemonState: null, daemonStateVersion: 0 }, undefined,
                { resolveCurrentServerIdentityId: () => boundHome });
            try {
                const receiver = Reflect.get(bound, 'machineRpcAdmissionBoundary') as MachineRpcAdmissionBoundary;
                expect(await receiver.resolveHomeServerIdentityId?.()).toBe('srv_exact_saved_home');
                boundHome = null;
                snapshot = { status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
                    capabilities: { serverIdentity: { serverIdentityId: 'srv_unbound_rival' } } }) };
                expect(await receiver.resolveHomeServerIdentityId?.()).toBeNull();
            } finally { await bound.shutdown(); }
            expect(fetch).not.toHaveBeenCalled();
        } finally { await client.shutdown(); }
    });

    it('stamps the current Home observation without rediscovering features per use', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(readyResponse('srv_first_home')).mockResolvedValueOnce(readyResponse('srv_next_home'));
        const store = createServerFeaturesSnapshotStore({ fetchSnapshot: () => observeServerFeaturesSnapshot({ serverUrl: 'https://server.example.test' }) });
        await store.refresh();
        const resolve = createCurrentMachineExecutionOriginContextResolver({
            serverUrl: 'https://server.example.test',
            resolveCurrentMachineId: () => 'machine',
            resolveCurrentServerIdentityId: () => {
                const snapshot = store.getSnapshot();
                return snapshot?.status === 'ready' ? snapshot.features.capabilities.serverIdentity.serverIdentityId ?? null : null;
            },
        });
        expect(await resolve()).toMatchObject({ serverIdentityId: 'srv_first_home' });
        expect(await resolve()).toMatchObject({ serverIdentityId: 'srv_first_home' });
        expect(fetch).toHaveBeenCalledTimes(1);
        await store.refresh();
        expect(await resolve()).toMatchObject({ serverIdentityId: 'srv_next_home' });
        expect(fetch).toHaveBeenCalledTimes(2);
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

    it('does not replace a withdrawn connection binding with feature discovery', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(readyResponse());
        let identity: string | null = 'srv_bound_home';
        let machineId: string | null = 'machine-first';
        const resolve = createCurrentMachineExecutionOriginContextResolver({
            serverUrl: 'https://server.example.test',
            resolveCurrentServerIdentityId: () => identity,
            resolveCurrentMachineId: () => machineId,
        });
        expect(await resolve()).toEqual({ serverIdentityId: identity, machineId });
        machineId = 'machine-next';
        expect(await resolve()).toEqual({ serverIdentityId: identity, machineId });
        identity = null;
        expect(await resolve()).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
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
