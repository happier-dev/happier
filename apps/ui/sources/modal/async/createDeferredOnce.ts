export type DeferredOnce<T> = Readonly<{
    promise: Promise<T>;
    resolve: (value: T) => void;
}>;

export function createDeferredOnce<T>(): DeferredOnce<T> {
    let isSettled = false;
    let resolvePromise: ((value: T) => void) | null = null;

    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });

    const resolveOnce = (value: T) => {
        if (isSettled) return;
        isSettled = true;
        resolvePromise?.(value);
    };

    return { promise, resolve: resolveOnce };
}

