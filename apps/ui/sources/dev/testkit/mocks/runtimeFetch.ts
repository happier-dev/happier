/** A held external fetch response still obeys the Fetch AbortSignal contract. */
export function waitForNetworkResponseForTests<T>(response: PromiseLike<T>, signal?: AbortSignal | null): Promise<T> {
    if (!signal) return Promise.resolve(response);
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
        const aborted = () => {
            signal.removeEventListener('abort', aborted);
            reject(signal.reason);
        };
        signal.addEventListener('abort', aborted, { once: true });
        Promise.resolve(response).then(
            value => {
                signal.removeEventListener('abort', aborted);
                resolve(value);
            },
            error => {
                signal.removeEventListener('abort', aborted);
                reject(error);
            },
        );
    });
}
