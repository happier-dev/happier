import { describe, expect, it } from 'vitest';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { resolveRpcForwardTimeoutMs } from './rpcForwardTimeout';

describe('resolveRpcForwardTimeoutMs', () => {
    it('keeps managed-service response-body reads under caller and lifecycle cancellation', () => {
        for (const method of [
            SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_NEXT_V1,
            SESSION_RPC_METHODS.EXECUTION_RUN_START,
            SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
            SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
            SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1,
            SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
            SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
            SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
            SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2,
            SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
            SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
            SESSION_RPC_METHODS.EXECUTION_RUN_WAIT,
        ]) {
            for (const requestedTimeoutMs of [1, 300_000]) {
                expect(resolveRpcForwardTimeoutMs(
                    `session-one:${method}`,
                    requestedTimeoutMs,
                )).toBe(2_147_483_647);
            }
        }
    });

    it('holds waiting stream reads under caller lifetime while preserving finite-read request budgets', () => {
        const method = `session-one:${SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ}`;
        expect(resolveRpcForwardTimeoutMs(method)).toBe(2_147_483_647);
        expect(resolveRpcForwardTimeoutMs(method, 20_000)).toBe(30_000);
        expect(resolveRpcForwardTimeoutMs(method, 30_001)).toBe(30_001);
    });

    it('keeps server-origin external Actions under caller and lifecycle cancellation', () => {
        for (const requestedTimeoutMs of [1, 30_001, 300_000]) {
            expect(resolveRpcForwardTimeoutMs(
                `machine-one:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
                requestedTimeoutMs,
            )).toBe(2_147_483_647);
        }
    });

    it('keeps unrelated RPC calls on the generic forward timeout', () => {
        expect(resolveRpcForwardTimeoutMs('machine-one:unrelated.method')).toBe(30_000);
        expect(resolveRpcForwardTimeoutMs('machine-one:unrelated.method', 30_001)).toBe(30_001);
    });

    it('keeps answering UI Action approvals under caller and lifecycle cancellation', () => {
        const method = `machine-one:${RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE}`;
        for (const requestedTimeoutMs of [undefined, 1, 30_001, 300_000]) {
            expect(resolveRpcForwardTimeoutMs(method, requestedTimeoutMs)).toBe(2_147_483_647);
        }
    });
});
