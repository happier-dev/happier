function createTurnAbortError() {
    return Object.assign(new Error('turn_aborted'), { name: 'AbortError' });
}

export function mergeAbortSignals(signals: ReadonlyArray<AbortSignal | undefined>) {
    const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
    if (activeSignals.length === 0) {
        return { signal: undefined, dispose: () => {} } as const;
    }
    if (activeSignals.length === 1) {
        return { signal: activeSignals[0], dispose: () => {} } as const;
    }

    const controller = new AbortController();
    const listeners: Array<Readonly<{ signal: AbortSignal; listener: () => void }>> = [];
    const abortMerged = () => {
        if (!controller.signal.aborted) {
            controller.abort();
        }
    };

    for (const signal of activeSignals) {
        if (signal.aborted) {
            abortMerged();
            break;
        }
        const listener = () => abortMerged();
        listeners.push({ signal, listener });
        signal.addEventListener('abort', listener, { once: true });
    }

    return {
        signal: controller.signal,
        dispose: () => {
            for (const { signal, listener } of listeners) {
                try {
                    signal.removeEventListener('abort', listener);
                } catch {
                    // ignore
                }
            }
        },
    } as const;
}

export function createAbortRacer(signal: AbortSignal | undefined) {
    if (!signal) {
        return {
            race: async <T>(promise: Promise<T>) => await promise,
            throwIfAborted: () => {},
            dispose: () => {},
        } as const;
    }

    const abortError = createTurnAbortError();

    const race = async <T>(promise: Promise<T>) => {
        if (signal.aborted) throw abortError;
        return await new Promise<T>((resolve, reject) => {
            const onAbort = () => {
                cleanup();
                reject(abortError);
            };

            const cleanup = () => {
                try {
                    signal.removeEventListener('abort', onAbort);
                } catch {
                    // ignore
                }
            };

            try {
                signal.addEventListener('abort', onAbort, { once: true });
            } catch {
                reject(abortError);
                return;
            }

            promise.then(
                (value) => {
                    cleanup();
                    resolve(value);
                },
                (error) => {
                    cleanup();
                    reject(error);
                },
            );
        });
    };

    const throwIfAborted = () => {
        if (signal.aborted) throw abortError;
    };

    const dispose = () => {
        // No-op; abort listeners are bound per race() call and cleaned up on settle.
    };

    return { race, throwIfAborted, dispose } as const;
}
