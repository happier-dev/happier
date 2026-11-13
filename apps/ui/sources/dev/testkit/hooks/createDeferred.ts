export type Deferred<T> = Readonly<{
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
}>;

export function createDeferred<T>(signal?: AbortSignal | null): Deferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;

    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });
    const abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const settle = <V>(callback: (value: V) => void, value: V) => {
        signal?.removeEventListener('abort', abort);
        callback(value);
    };

    return {
        promise,
        resolve: value => settle(resolve, value),
        reject: reason => settle(reject, reason),
    };
}
