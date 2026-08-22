function createTurnAbortError() {
    return Object.assign(new Error('turn_aborted'), { name: 'AbortError' });
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
