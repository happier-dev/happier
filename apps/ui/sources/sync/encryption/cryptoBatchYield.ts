/**
 * Canonical owner for releasing the JS thread inside a JS-reference crypto batch.
 *
 * The JS reference paths run one synchronous primitive per item. A cold start on a large account
 * opens thousands of per-session wrapped data-key envelopes (a curve25519 box-open each), so a
 * single unyielding pass holds the UI thread for seconds. Chunking preserves per-item results and
 * ordering exactly; it only bounds how long the thread is held before other work (input, layout,
 * timers) can run.
 */

/**
 * Items processed before the thread is released. Small enough that one chunk stays inside a couple
 * of frames for the slowest primitive in this corridor (asymmetric envelope opens); large enough
 * that a multi-thousand-item batch does not pay thousands of macrotask hops.
 */
export const DEFAULT_CRYPTO_BATCH_YIELD_CHUNK_SIZE = 32;

export function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

export type MapCryptoBatchWithYieldOptions = Readonly<{
    chunkSize?: number;
    yieldBetweenChunks?: () => Promise<void>;
}>;

function normalizeChunkSize(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 1
        ? Math.trunc(value)
        : DEFAULT_CRYPTO_BATCH_YIELD_CHUNK_SIZE;
}

/**
 * Applies `mapItem` to every item, releasing the JS thread between chunks. A batch that fits in a
 * single chunk runs in one synchronous pass, so small batches keep their current cost and timing
 * exactly.
 */
export async function mapCryptoBatchWithYield<T, R>(
    items: readonly T[],
    mapItem: (item: T, index: number) => R,
    options: MapCryptoBatchWithYieldOptions = {},
): Promise<R[]> {
    const chunkSize = normalizeChunkSize(options.chunkSize);
    if (items.length <= chunkSize) {
        return items.map(mapItem);
    }

    const yieldBetweenChunks = options.yieldBetweenChunks ?? yieldToEventLoop;
    const results = new Array<R>(items.length);
    for (let start = 0; start < items.length; start += chunkSize) {
        if (start > 0) {
            await yieldBetweenChunks();
        }
        const end = Math.min(start + chunkSize, items.length);
        for (let index = start; index < end; index += 1) {
            results[index] = mapItem(items[index]!, index);
        }
    }
    return results;
}
