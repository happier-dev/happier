export type PluginInvocationLifetime = Readonly<{
    /** Host clock captured once when this invocation is admitted. */
    invokedAtMs: number;
    signal: AbortSignal;
    redactionLifetimeSignal: AbortSignal;
    settleContext(): void;
    retainCleanup(cleanup: Readonly<{ dispose(): Promise<void> }>): void;
    complete(): Promise<void>;
}>;

export function createPluginInvocationLifetime(
    parentSignal?: AbortSignal,
): PluginInvocationLifetime {
    const invokedAtMs = Date.now();
    const contextController = new AbortController();
    const redactionController = new AbortController();
    const abortFromParent = () => {
        if (!contextController.signal.aborted) contextController.abort(parentSignal?.reason);
        if (!redactionController.signal.aborted) redactionController.abort(parentSignal?.reason);
    };
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    if (parentSignal?.aborted) abortFromParent();
    let completed = false;
    const cleanups: Array<Readonly<{ dispose(): Promise<void> }>> = [];
    let completion: Promise<void> | null = null;
    return Object.freeze({
        invokedAtMs,
        signal: contextController.signal,
        redactionLifetimeSignal: redactionController.signal,
        settleContext(): void {
            if (!contextController.signal.aborted) contextController.abort();
        },
        retainCleanup(cleanup): void {
            if (completed) throw new Error('Plugin invocation has already completed');
            cleanups.push(cleanup);
        },
        complete(): Promise<void> {
            if (completion) return completion;
            completed = true;
            completion = Promise.allSettled(cleanups.map(cleanup => Promise.resolve().then(() => cleanup.dispose())))
                .then(results => {
                    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
                    if (failures.length > 0) throw new AggregateError(failures, 'Plugin invocation private cleanup failed');
                });
            parentSignal?.removeEventListener('abort', abortFromParent);
            if (!contextController.signal.aborted) contextController.abort();
            if (!redactionController.signal.aborted) redactionController.abort();
            return completion;
        },
    });
}
