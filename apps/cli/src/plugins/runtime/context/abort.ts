type PluginAbortSubscription = Readonly<{
    unsubscribe(): void;
}>;

type PluginAbortService = Readonly<{
    signal: AbortSignal;
    compose(signals: readonly AbortSignal[]): AbortSignal;
    race<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T>;
    onHeartbeat(listener: (reason: unknown) => void): PluginAbortSubscription;
}>;

function createAbortError(): Error {
    const error = new Error('Plugin operation was aborted');
    error.name = 'AbortError';
    return error;
}

export function createPluginAbortService(params?: Readonly<{
    controller?: AbortController;
}>): Readonly<{
    controller: AbortController;
    service: PluginAbortService;
}> {
    const controller = params?.controller ?? new AbortController();
    const heartbeatListeners = new Set<(reason: unknown) => void>();

    const service: PluginAbortService = Object.freeze({
        signal: controller.signal,
        compose(signals: readonly AbortSignal[]): AbortSignal {
            const composed = new AbortController();
            const abort = (reason: unknown) => {
                if (!composed.signal.aborted) {
                    composed.abort(reason);
                }
            };
            for (const signal of [controller.signal, ...signals]) {
                if (signal.aborted) {
                    abort(signal.reason);
                    break;
                }
                signal.addEventListener('abort', () => abort(signal.reason), { once: true });
            }
            return composed.signal;
        },
        async race<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
            const racedSignal = signal ? service.compose([signal]) : controller.signal;
            if (racedSignal.aborted) {
                throw createAbortError();
            }
            return await Promise.race([
                operation,
                new Promise<never>((_resolve, reject) => {
                    racedSignal.addEventListener('abort', () => reject(createAbortError()), { once: true });
                }),
            ]);
        },
        onHeartbeat(listener: (reason: unknown) => void) {
            heartbeatListeners.add(listener);
            return Object.freeze({
                unsubscribe: () => {
                    heartbeatListeners.delete(listener);
                },
            });
        },
    });

    controller.signal.addEventListener('abort', () => {
        for (const listener of [...heartbeatListeners]) {
            listener(controller.signal.reason);
        }
        heartbeatListeners.clear();
    }, { once: true });

    return Object.freeze({ controller, service });
}
