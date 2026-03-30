import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('transferRouteCache', () => {
    beforeEach(() => {
        vi.resetModules();
        delete process.env.EXPO_PUBLIC_HAPPIER_MACHINE_TRANSFER_ROUTE_CACHE_POSITIVE_TTL_MS;
        delete process.env.EXPO_PUBLIC_HAPPIER_MACHINE_TRANSFER_ROUTE_CACHE_NEGATIVE_TTL_MS;
    });

    it('uses server scope and endpoint set when caching direct-peer unavailability', async () => {
        const {
            readCachedDirectPeerRoute,
            recordCachedDirectPeerRouteUnavailable,
        } = await import('./transferRouteCache');

        recordCachedDirectPeerRouteUnavailable({
            serverId: 'server-a',
            remoteMachineId: 'machine-source',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/a?token=1',
                    expiresAt: 10_000,
                },
            ],
        }, 'direct_peer_transfer_unavailable');

        expect(readCachedDirectPeerRoute({
            serverId: 'server-b',
            remoteMachineId: 'machine-source',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/a?token=1',
                    expiresAt: 10_000,
                },
            ],
        })).toEqual({ status: 'unknown' });

        expect(readCachedDirectPeerRoute({
            serverId: 'server-a',
            remoteMachineId: 'machine-source',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46002/machine-transfers/direct/a?token=2',
                    expiresAt: 10_000,
                },
            ],
        })).toEqual({ status: 'unknown' });

        expect(readCachedDirectPeerRoute({
            serverId: 'server-a',
            remoteMachineId: 'machine-source',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/a?token=1',
                    expiresAt: 10_000,
                },
            ],
        })).toEqual(expect.objectContaining({
            status: 'unavailable',
            failureReason: 'direct_peer_transfer_unavailable',
        }));
    });

    it('uses server scope and machine id when caching machine-rpc-direct unavailability', async () => {
        const {
            readCachedMachineRpcDirectRoute,
            recordCachedMachineRpcDirectRouteUnavailable,
        } = await import('./transferRouteCache');

        recordCachedMachineRpcDirectRouteUnavailable(
            {
                serverId: 'server-a',
                remoteMachineId: 'machine-target',
            },
            'machine_rpc_direct_unavailable',
        );

        expect(readCachedMachineRpcDirectRoute({
            serverId: 'server-b',
            remoteMachineId: 'machine-target',
        })).toEqual({ status: 'unknown' });

        expect(readCachedMachineRpcDirectRoute({
            serverId: 'server-a',
            remoteMachineId: 'machine-other',
        })).toEqual({ status: 'unknown' });

        expect(readCachedMachineRpcDirectRoute({
            serverId: 'server-a',
            remoteMachineId: 'machine-target',
        })).toEqual(expect.objectContaining({
            status: 'unavailable',
            failureReason: 'machine_rpc_direct_unavailable',
        }));
    });

    it('notifies subscribers when machine-rpc direct route viability changes', async () => {
        const {
            recordCachedMachineRpcDirectRouteViable,
            subscribeCachedMachineRpcDirectRoute,
        } = await import('./transferRouteCache');

        const listener = vi.fn();
        const unsubscribe = subscribeCachedMachineRpcDirectRoute({
            serverId: 'server-a',
            remoteMachineId: 'machine-target',
        }, listener);

        recordCachedMachineRpcDirectRouteViable({
            serverId: 'server-a',
            remoteMachineId: 'machine-target',
        });

        expect(listener).toHaveBeenCalledTimes(1);

        unsubscribe();
    });
});
