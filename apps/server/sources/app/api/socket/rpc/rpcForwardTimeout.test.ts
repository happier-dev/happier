import { describe, expect, it } from 'vitest';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { isRpcForwardCallerLifecycleOwned, resolveRpcForwardTimeoutMs } from './rpcForwardTimeout';
import { loadStartupHomeEnv } from '@/app/home/settings/startupHomeEnv';

describe('resolveRpcForwardTimeoutMs', () => {
    it('uses saved restart settings loaded after the RPC module was imported', async () => {
        await loadStartupHomeEnv({
            env: {},
            readStored: async () => ({ values: {
                HAPPIER_RPC_FORWARD_TIMEOUT_MS: 45_000,
                HAPPIER_RPC_FORWARD_CAPABILITIES_TIMEOUT_MS: 150_000,
                HAPPIER_RPC_FORWARD_MAX_TIMEOUT_MS: 400_000,
            }, secrets: {} }),
            log: () => {},
        });
        try {
            expect(resolveRpcForwardTimeoutMs('machine-one:unrelated.method')).toBe(45_000);
            expect(resolveRpcForwardTimeoutMs('machine-one:capabilities.invoke', 1)).toBe(150_000);
            expect(resolveRpcForwardTimeoutMs('machine-one:unrelated.method', 500_000)).toBe(400_000);
        } finally {
            await loadStartupHomeEnv({ env: {}, readStored: async () => ({ values: {}, secrets: {} }), log: () => {} });
        }
    });
    it.each([{ prefix: '', floor: 30_000 }, { prefix: 'machine-one:', floor: 120_000 }])(
        'keeps omitted capability invocation deadlines under caller lifetime (%s), preserving finite budgets', ({ prefix, floor }) => {
            const method = `${prefix}${RPC_METHODS.CAPABILITIES_INVOKE}`;
            expect(isRpcForwardCallerLifecycleOwned(method)).toBe(true);
            expect(resolveRpcForwardTimeoutMs(method)).toBe(2_147_483_647);
            expect(resolveRpcForwardTimeoutMs(method, 1)).toBe(floor);
            expect(resolveRpcForwardTimeoutMs(method, 180_000)).toBe(180_000);
            expect(resolveRpcForwardTimeoutMs(method, 500_000)).toBe(300_000);
            for (const discovery of [RPC_METHODS.CAPABILITIES_DETECT, RPC_METHODS.CAPABILITIES_DESCRIBE]) {
                expect(isRpcForwardCallerLifecycleOwned(`${prefix}${discovery}`)).toBe(false);
                expect(resolveRpcForwardTimeoutMs(`${prefix}${discovery}`)).toBe(floor);
            }
        },
    );
    it('keeps Workflow admission results under caller lifecycle rather than losing a late refusal', () => {
        const method = 'machine-one:workflow.run.start';
        expect(isRpcForwardCallerLifecycleOwned(method)).toBe(true);
        expect(resolveRpcForwardTimeoutMs(method)).toBe(2_147_483_647);
    });
    it('keeps protected service admission retirement waits under caller lifecycle', () => {
        const method = 'machine-one:daemon.localServices.preview.admission';
        expect(isRpcForwardCallerLifecycleOwned(method)).toBe(true);
        expect(resolveRpcForwardTimeoutMs(method, 300_000)).toBe(2_147_483_647);
    });
    it('keeps an authored nonce observer deadline under caller lifecycle instead of the generic five-minute cutoff', () => {
        const method = `machine-one:${RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE}`;
        const observerTimeoutMs = 20 * 60_000;
        expect(resolveRpcForwardTimeoutMs(method, observerTimeoutMs)).toBeGreaterThanOrEqual(observerTimeoutMs);
        expect(isRpcForwardCallerLifecycleOwned(method)).toBe(true);
    });

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

    it('keeps projection reads under caller lifecycle rather than the generic relay deadline', () => {
        const method = `machine-one:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`;
        expect(isRpcForwardCallerLifecycleOwned(method)).toBe(true);
        expect(resolveRpcForwardTimeoutMs(method, null)).toBe(2_147_483_647);
    });

    it('keeps answering UI Action approvals under caller and lifecycle cancellation', () => {
        const method = `machine-one:${RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE}`;
        for (const requestedTimeoutMs of [undefined, 1, 30_001, 300_000]) {
            expect(resolveRpcForwardTimeoutMs(method, requestedTimeoutMs)).toBe(2_147_483_647);
        }
    });
});
