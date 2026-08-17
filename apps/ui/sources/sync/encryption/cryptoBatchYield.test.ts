import { describe, expect, it } from 'vitest';

import {
    DEFAULT_CRYPTO_BATCH_YIELD_CHUNK_SIZE,
    mapCryptoBatchWithYield,
} from './cryptoBatchYield';

describe('mapCryptoBatchWithYield', () => {
    it('lets other work run while a large batch is still being processed', async () => {
        const items = Array.from({ length: DEFAULT_CRYPTO_BATCH_YIELD_CHUNK_SIZE * 3 }, (_, index) => index);
        let processedWhenInterleavedTaskRan: number | null = null;
        let processed = 0;

        setTimeout(() => {
            processedWhenInterleavedTaskRan = processed;
        }, 0);

        const results = await mapCryptoBatchWithYield(items, (item) => {
            processed += 1;
            return item * 2;
        });

        // The interleaved macrotask must have observed a partially processed batch: that is the
        // whole point of releasing the thread, and it is what a single synchronous pass cannot do.
        expect(processedWhenInterleavedTaskRan).not.toBeNull();
        expect(processedWhenInterleavedTaskRan!).toBeGreaterThan(0);
        expect(processedWhenInterleavedTaskRan!).toBeLessThan(items.length);
        expect(results).toEqual(items.map((item) => item * 2));
    });

    it('keeps a batch that fits one chunk as a single synchronous pass', async () => {
        const items = Array.from({ length: DEFAULT_CRYPTO_BATCH_YIELD_CHUNK_SIZE }, (_, index) => index);
        let processedWhenInterleavedTaskRan: number | null = null;
        let processed = 0;

        setTimeout(() => {
            processedWhenInterleavedTaskRan = processed;
        }, 0);

        const results = await mapCryptoBatchWithYield(items, (item) => {
            processed += 1;
            return `${item}`;
        });

        expect(processed).toBe(items.length);
        expect(processedWhenInterleavedTaskRan).toBeNull();
        expect(results).toEqual(items.map((item) => `${item}`));
    });

    it('preserves item order and index across chunk boundaries', async () => {
        const items = Array.from({ length: 70 }, (_, index) => `item-${index}`);

        const results = await mapCryptoBatchWithYield(
            items,
            (item, index) => `${index}:${item}`,
            { chunkSize: 8 },
        );

        expect(results).toEqual(items.map((item, index) => `${index}:${item}`));
    });

    it('falls back to the default chunk size for an invalid chunk size', async () => {
        const items = Array.from({ length: 5 }, (_, index) => index);

        await expect(mapCryptoBatchWithYield(items, (item) => item, { chunkSize: 0 })).resolves.toEqual(items);
        await expect(
            mapCryptoBatchWithYield(items, (item) => item, { chunkSize: Number.NaN }),
        ).resolves.toEqual(items);
    });
});
