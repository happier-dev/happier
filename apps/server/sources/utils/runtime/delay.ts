import { AbortedExeption } from "./aborted";

/**
 * Wait for `ms` milliseconds.
 *
 * If `signal` is provided and is aborted before the delay completes, this rejects with
 * `AbortedExeption` (callers should either catch it or let higher-level shutdown orchestration
 * handle it, e.g. `forever()`).
 */
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    if (signal.aborted) {
        throw new AbortedExeption();
    }
    
    await new Promise<void>((resolve, reject) => {
        const abortHandler = () => {
            clearTimeout(timeout);
            reject(new AbortedExeption());
        };

        const timeout = setTimeout(() => {
            signal.removeEventListener('abort', abortHandler);
            resolve();
        }, ms);

        signal.addEventListener('abort', abortHandler, { once: true });
    });
}
