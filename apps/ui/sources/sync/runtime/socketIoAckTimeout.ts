export function createSocketIoAckTimeoutError(): Error {
    return new Error('operation has timed out');
}

export function isSocketIoAckTimeoutError(error: unknown): boolean {
    return error instanceof Error && error.message === 'operation has timed out';
}

export async function raceSocketIoAckTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
    if (!(typeof timeoutMs === 'number' && timeoutMs > 0)) {
        return await promise;
    }

    return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const timeoutId = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(createSocketIoAckTimeoutError());
        }, timeoutMs);

        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                resolve(value);
            },
            (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                reject(error);
            },
        );
    });
}
