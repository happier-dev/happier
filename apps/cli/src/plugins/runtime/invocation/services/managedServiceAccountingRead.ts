/** Shares only a pending native sample. Each visible/finite demand owns its
 * wait; releasing the final demand cancels the underlying native query. */
export function createManagedServiceAccountingRead<T>(
    sample: (signal: AbortSignal) => Promise<T>,
): Readonly<{
    read(options?: Readonly<{ signal?: AbortSignal }>): Promise<T>;
    cancel(): void;
}> {
    type Pending = { controller: AbortController; result: Promise<T>; consumers: number };
    let pending: Pending | undefined;
    return Object.freeze({
        async read(options?: Readonly<{ signal?: AbortSignal }>): Promise<T> {
            options?.signal?.throwIfAborted();
            if (!pending) {
                const controller = new AbortController();
                const current: Pending = { controller, result: Promise.resolve().then(() => {
                    controller.signal.throwIfAborted();
                    return sample(controller.signal);
                }), consumers: 0 };
                pending = current;
                const clear = () => { if (pending === current) pending = undefined; };
                void current.result.then(clear, clear);
            }
            const current = pending;
            current.consumers++;
            return await new Promise<T>((resolve, reject) => {
                let released = false;
                const release = () => {
                    if (released) return;
                    released = true;
                    options?.signal?.removeEventListener('abort', abort);
                    current.consumers--;
                    if (pending === current && current.consumers === 0) current.controller.abort();
                };
                const abort = () => {
                    release();
                    if (current.consumers === 0) {
                        // The final caller still owns native query cleanup. Do
                        // not disguise incomplete termination as cancellation.
                        void current.result.then(() => reject(options?.signal?.reason), (error: unknown) => reject(error));
                    } else reject(options?.signal?.reason);
                };
                options?.signal?.addEventListener('abort', abort, { once: true });
                void current.result.then(value => {
                    if (!released) { release(); resolve(value); }
                }, (error: unknown) => {
                    if (!released) { release(); reject(error); }
                });
            });
        },
        cancel() { pending?.controller.abort(); },
    });
}
