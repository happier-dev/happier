import { describe, expect, it, vi } from 'vitest';

import {
    createPluginProtocolCallbackQueue,
    INTERNAL_MAX_PLUGIN_PROTOCOL_PENDING_CALLBACK_BYTES,
    INTERNAL_MAX_PLUGIN_PROTOCOL_PENDING_CALLBACKS,
} from './callbackQueue';

describe('createPluginProtocolCallbackQueue', () => {
    it('accepts the exact callback count bound and fails once at bound plus one', async () => {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const onFailure = vi.fn();
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

        expect(queue.enqueue(1, () => blocked)).toBe(true);
        for (let index = 1; index < INTERNAL_MAX_PLUGIN_PROTOCOL_PENDING_CALLBACKS; index += 1) {
            expect(queue.enqueue(1, async () => undefined)).toBe(true);
        }
        expect(queue.enqueue(1, async () => undefined)).toBe(false);
        expect(onFailure).toHaveBeenCalledTimes(1);
        expect(queueSamples.at(-2)).toEqual({
            family: 'plugin-protocol-callbacks',
            queuedItems: INTERNAL_MAX_PLUGIN_PROTOCOL_PENDING_CALLBACKS,
            queuedBytes: INTERNAL_MAX_PLUGIN_PROTOCOL_PENDING_CALLBACKS,
            backpressured: false,
        });
        expect(queueSamples.at(-1)).toEqual({
            family: 'plugin-protocol-callbacks',
            queuedItems: INTERNAL_MAX_PLUGIN_PROTOCOL_PENDING_CALLBACKS + 1,
            queuedBytes: INTERNAL_MAX_PLUGIN_PROTOCOL_PENDING_CALLBACKS + 1,
            backpressured: true,
        });
        release();
        await queue.drained();
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
