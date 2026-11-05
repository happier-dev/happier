import { logger } from '@/ui/logger';

/** Cancellation stops waiting; the preparation owner still releases a late result. */
export function awaitExecLaunchPreparation<T>(input: Readonly<{
    preparation: Promise<T>;
    signal: AbortSignal;
    release(value: T): void | Promise<void>;
}>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let cancelled = false;
        const abort = () => {
            cancelled = true;
            input.signal.removeEventListener('abort', abort);
            reject(input.signal.reason);
        };
        input.signal.addEventListener('abort', abort, { once: true });
        if (input.signal.aborted) abort();
        input.preparation.then(value => {
            input.signal.removeEventListener('abort', abort);
            if (cancelled) {
                void Promise.resolve().then(() => input.release(value)).catch(() => {
                    logger.infoFile('[PluginExec] Cancelled launch preparation cleanup failed');
                });
            } else resolve(value);
        }, error => {
            input.signal.removeEventListener('abort', abort);
            reject(error);
        });
    });
}
