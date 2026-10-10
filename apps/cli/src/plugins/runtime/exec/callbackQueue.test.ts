import { describe, expect, it, vi } from 'vitest';

import {
    createPluginProtocolCallbackQueue,
    INTERNAL_MAX_PLUGIN_PROTOCOL_PENDING_CALLBACK_BYTES,
} from './callbackQueue';

describe('createPluginProtocolCallbackQueue', () => {
    it('retains more than 256 callbacks in order until they drain and accepts later work', async () => {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const onFailure = vi.fn();
        const invoked: number[] = [];
        const queueSamples: Array<{
            family: 'plugin-protocol-callbacks';
            queuedItems: number;
            queuedBytes: number;
            backpressured: boolean;
        }> = [];
        const queue = createPluginProtocolCallbackQueue({
            onFailure,
            recordRuntimeLimitMeasurement: (sample) => {
                if (sample.family === 'plugin-protocol-callbacks') queueSamples.push(sample);
            },
        });

        try {
            for (let index = 0; index < 300; index += 1) {
                expect(queue.enqueue(1, async () => {
                    await blocked;
                    invoked.push(index);
                })).toBe(true);
            }
            expect(onFailure).not.toHaveBeenCalled();
            expect(queueSamples.at(-1)).toEqual({
                family: 'plugin-protocol-callbacks',
                queuedItems: 300,
                queuedBytes: 300,
                backpressured: false,
            });
            release();
            await queue.drained();
            expect(invoked).toEqual(Array.from({ length: 300 }, (_, index) => index));
            expect(queue.enqueue(1, () => { invoked.push(300); })).toBe(true);
            await queue.drained();
            expect(invoked.at(-1)).toBe(300);
            expect(queueSamples.at(-1)).toMatchObject({ queuedItems: 1, queuedBytes: 1 });
        } finally {
            release();
            await queue.drained();
        }
    });

    it('preserves an explicit caller callback count budget', async () => {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        const onFailure = vi.fn();
        const invoked: number[] = [];
        const queue = createPluginProtocolCallbackQueue({ maxPendingCallbacks: 2, onFailure });
        expect(queue.enqueue(1, async () => { await blocked; invoked.push(1); })).toBe(true);
        expect(queue.enqueue(1, () => { invoked.push(2); })).toBe(true);
        expect(queue.enqueue(1, () => { invoked.push(3); })).toBe(false);
        expect(onFailure).toHaveBeenCalledExactlyOnceWith({ code: 'PLUGIN_EXEC_CLIENT_BACKPRESSURE_EXCEEDED' });
        release();
        await queue.drained();
        expect(invoked).toEqual([1, 2]);
    });

    it('accepts the exact byte bound and rejects bound plus one without invoking it', async () => {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const invoked: string[] = [];
        const queueSamples: Array<{
            family: 'plugin-protocol-callbacks';
            queuedItems: number;
            queuedBytes: number;
            backpressured: boolean;
        }> = [];
        const queue = createPluginProtocolCallbackQueue({
            onFailure: () => undefined,
            recordRuntimeLimitMeasurement: (sample) => {
                if (sample.family === 'plugin-protocol-callbacks') queueSamples.push(sample);
            },
        });

        expect(queue.enqueue(INTERNAL_MAX_PLUGIN_PROTOCOL_PENDING_CALLBACK_BYTES, async () => {
            invoked.push('exact');
            await blocked;
        })).toBe(true);
        expect(queue.enqueue(1, async () => {
            invoked.push('overflow');
        })).toBe(false);
        release();
        await queue.drained();

        expect(invoked).toEqual(['exact']);
        expect(queueSamples).toEqual([
            {
                family: 'plugin-protocol-callbacks',
                queuedItems: 1,
                queuedBytes: INTERNAL_MAX_PLUGIN_PROTOCOL_PENDING_CALLBACK_BYTES,
                backpressured: false,
            },
            {
                family: 'plugin-protocol-callbacks',
                queuedItems: 2,
                queuedBytes: INTERNAL_MAX_PLUGIN_PROTOCOL_PENDING_CALLBACK_BYTES + 1,
                backpressured: true,
            },
        ]);
    });

    it('contains callback exceptions and stops later callbacks after the sticky failure', async () => {
        const invoked: string[] = [];
        const onFailure = vi.fn();
        const queue = createPluginProtocolCallbackQueue({
            maxPendingCallbacks: 10,
            maxPendingBytes: 100,
            onFailure,
        });
        queue.enqueue(1, async () => {
            invoked.push('throws');
            throw new Error('callback failed');
        });
        queue.enqueue(1, async () => {
            invoked.push('later');
        });

        await queue.drained();

        expect(invoked).toEqual(['throws']);
        expect(onFailure).toHaveBeenCalledTimes(1);
    });
});
