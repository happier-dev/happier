type FireAndForgetOptions = Readonly<{
    tag?: string;
    logError?: boolean;
    onError?: (error: unknown) => void;
}>;

export function fireAndForget<T>(promise: Promise<T> | null | undefined, options?: FireAndForgetOptions): void {
    const candidate: any = promise as any;
    if (!candidate || typeof candidate.catch !== 'function') return;

    void candidate.catch((error: unknown) => {
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
