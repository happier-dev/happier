import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineTransferRouteCache } from './createMachineTransferRouteCache';

describe('createMachineTransferRouteCache', () => {
    const now = vi.fn<() => number>();

    beforeEach(() => {
        now.mockReset();
        now.mockReturnValue(1_000);
    });

    it('treats a different endpoint set as a different direct-peer cache key', () => {
        const cache = createMachineTransferRouteCache({
            serverId: 'server-1',
            now,
            positiveTtlMs: 30_000,
            negativeTtlMs: 5_000,
        });

        cache.recordDirectPeerRouteUnavailable({
            remoteMachineId: 'machine-source',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/a?token=1',
                    expiresAt: 10_000,
                },
            ],
        }, 'network_error');

        expect(cache.readDirectPeerRoute({
            remoteMachineId: 'machine-source',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46002/machine-transfers/direct/a?token=2',
                    expiresAt: 10_000,
                },
            ],
        })).toEqual({ status: 'unknown' });
    });

    it('keeps machine-rpc-direct cache entries distinct by target machine', () => {
        const cache = createMachineTransferRouteCache({
            serverId: 'server-1',
            now,
            positiveTtlMs: 30_000,
            negativeTtlMs: 5_000,
        });

        cache.recordMachineRpcDirectRouteUnavailable(
            {
                remoteMachineId: 'machine-target',
            },
            'machine_rpc_direct_unavailable',
        );

        expect(cache.readMachineRpcDirectRoute({
            remoteMachineId: 'machine-other',
        })).toEqual({ status: 'unknown' });

        expect(cache.readMachineRpcDirectRoute({
            remoteMachineId: 'machine-target',
        })).toEqual(expect.objectContaining({
            status: 'unavailable',
            failureReason: 'machine_rpc_direct_unavailable',
        }));
    });

    it('keeps machine-rpc-direct cache entries distinct from direct-peer endpoint cache entries', () => {
        const cache = createMachineTransferRouteCache({
            serverId: 'server-1',
            now,
            positiveTtlMs: 30_000,
            negativeTtlMs: 5_000,
        });

        cache.recordMachineRpcDirectRouteUnavailable(
            {
                remoteMachineId: 'machine-target',
            },
            'machine_rpc_direct_unavailable',
        );

        expect(cache.readDirectPeerRoute({
            remoteMachineId: 'machine-target',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/a?token=1',
                    expiresAt: 10_000,
                },
            ],
        })).toEqual({ status: 'unknown' });
    });
});
