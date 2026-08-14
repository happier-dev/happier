import { describe, expect, it } from 'vitest';
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
});
