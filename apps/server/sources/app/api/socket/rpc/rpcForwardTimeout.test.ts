import { describe, expect, it } from 'vitest';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { resolveRpcForwardTimeoutMs } from './rpcForwardTimeout';

describe('resolveRpcForwardTimeoutMs', () => {
    it('keeps managed-service response-body reads under caller and lifecycle cancellation', () => {
        for (const requestedTimeoutMs of [1, 300_000]) {
            expect(resolveRpcForwardTimeoutMs(
                `session-one:${SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_NEXT_V1}`,
                requestedTimeoutMs,
            )).toBe(2_147_483_647);
        }
    });

    it('keeps server-origin external Actions under caller and lifecycle cancellation', () => {
        for (const [requestedTimeoutMs, expected] of [[1, 30_000], [30_001, 30_001], [300_000, 300_000]] as const) {
            expect(resolveRpcForwardTimeoutMs(
                `machine-one:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
                requestedTimeoutMs,
            )).toBe(expected);
        }
    });

    it('keeps unrelated RPC calls on the generic forward timeout', () => {
        expect(resolveRpcForwardTimeoutMs('machine-one:unrelated.method')).toBe(30_000);
        expect(resolveRpcForwardTimeoutMs('machine-one:unrelated.method', 30_001)).toBe(30_001);
    });
});
