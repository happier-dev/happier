import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';

type FireAndForgetOptions = Readonly<{
    tag?: string;
    logError?: boolean;
    onError?: (error: unknown) => void;
}>;

export function fireAndForget(promise: Promise<unknown> | null | undefined, options?: FireAndForgetOptions): void {
    if (!promise || typeof promise.catch !== 'function') return;

    void promise.catch((error: unknown) => {
        try {
            if (options?.tag) {
                // Recoverable connectivity and retired work are diagnostics, not developer error overlays.
                const expected = isTransientConnectivityError(error)
                    || (error instanceof Error && (error.name === 'AbortError' || error.name === 'StaleServerGenerationError'));
                const report = expected ? console.info : console.error;
                if (options.logError === false) {
                    report(`[fireAndForget] ${options.tag}`);
                } else {
                    report(`[fireAndForget] ${options.tag}`, error);
                }
            }
            options?.onError?.(error);
        } catch {
            // ignore
        }
    });
}
