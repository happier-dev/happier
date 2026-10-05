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
                if (options.logError === false) {
                    console.error(`[fireAndForget] ${options.tag}`);
                } else {
                    console.error(`[fireAndForget] ${options.tag}`, error);
                }
            }
            options?.onError?.(error);
        } catch {
            // ignore
        }
    });
}
