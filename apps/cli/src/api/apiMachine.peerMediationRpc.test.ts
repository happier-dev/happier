import { describe, expect, it } from 'vitest';

import type { Machine } from '@/api/types';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';

import { ApiMachineClient } from './apiMachine';

function createMachine(): Machine {
    return {
        id: 'machine_1',
        encryptionKey: new Uint8Array(32).fill(7),
        encryptionVariant: 'legacy',
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

function createDeferred<T>(): Readonly<{
    promise: Promise<T>;
    resolve: (value: T) => void;
}> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
    return await new Promise<T | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), timeoutMs);
        void promise.then((value) => {
            clearTimeout(timeout);
            resolve(value);
        });
    });
}

describe('ApiMachineClient peer mediation RPC invoker', () => {
    it('forwards a direct peer request lifetime to its registered local handler', async () => {
        const client = new ApiMachineClient('token', createMachine());
        const handlerStarted = createDeferred<void>();
        const handlerAborted = createDeferred<boolean>();
        let releaseHandler = () => {};
        const handlerManager = (client as unknown as Readonly<{
            rpcHandlerManager: RpcHandlerRegistrar;
        }>).rpcHandlerManager;
        handlerManager.registerHandler('direct-peer-cancellation', async (_input, context) => {
            const signal = context?.signal;
            if (!signal) throw new Error('Expected direct peer RPC handler signal');
            handlerStarted.resolve(undefined);
            await new Promise<void>((resolve) => {
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    signal.removeEventListener('abort', onAbort);
                    resolve();
                };
                const onAbort = () => {
                    handlerAborted.resolve(signal.aborted);
                    finish();
                };
                releaseHandler = finish;
                if (signal.aborted) {
                    onAbort();
                } else {
                    signal.addEventListener('abort', onAbort, { once: true });
                }
            });
            return { cancelled: signal.aborted };
        });

        try {
            const controller = new AbortController();
            const invocation = client.getPeerMediationMachineRpcHandlerManager().invokeLocal(
                'direct-peer-cancellation',
                {},
                { signal: controller.signal },
            );

            expect(await settleWithin(handlerStarted.promise, 1_000)).toBeUndefined();
            controller.abort();

            expect(await settleWithin(handlerAborted.promise, 500)).toBe(true);
            await expect(invocation).resolves.toEqual({ cancelled: true });
            await expect(settleWithin(client.awaitPendingRpcRequests(), 500)).resolves.toBeUndefined();
        } finally {
            releaseHandler();
            await settleWithin(client.awaitPendingRpcRequests(), 500);
            await client.shutdown().catch(() => undefined);
        }
    });
});
