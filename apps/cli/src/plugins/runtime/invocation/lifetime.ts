export type PluginInvocationLifetime = Readonly<{
    signal: AbortSignal;
    redactionLifetimeSignal: AbortSignal;
    settleContext(): void;
    complete(): void;
}>;

export function createPluginInvocationLifetime(
    parentSignal?: AbortSignal,
): PluginInvocationLifetime {
    const contextController = new AbortController();
    const redactionController = new AbortController();
    const abortFromParent = () => {
        if (!contextController.signal.aborted) contextController.abort(parentSignal?.reason);
        if (!redactionController.signal.aborted) redactionController.abort(parentSignal?.reason);
    };
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    if (parentSignal?.aborted) abortFromParent();
    let completed = false;
    return Object.freeze({
        signal: contextController.signal,
        redactionLifetimeSignal: redactionController.signal,
        settleContext(): void {
            if (!contextController.signal.aborted) contextController.abort();
        },
        complete(): void {
            if (completed) return;
            completed = true;
            parentSignal?.removeEventListener('abort', abortFromParent);
            if (!contextController.signal.aborted) contextController.abort();
            if (!redactionController.signal.aborted) redactionController.abort();
        },
    });
}
