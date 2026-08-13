export class LockAdmissionDeadlineExceededError extends Error {
    constructor() {
        super("Lock admission deadline expired before the operation could start");
        this.name = "LockAdmissionDeadlineExceededError";
    }
}

export function isLockAdmissionDeadlineExceededError(
    error: unknown,
): error is LockAdmissionDeadlineExceededError {
    return error instanceof LockAdmissionDeadlineExceededError;
}

type LockWaiter = Readonly<{
    resolve: () => void;
    reject: (error: unknown) => void;
    timeout: ReturnType<typeof setTimeout> | null;
    deadlineAtMs: number | undefined;
}>;

export class AsyncLock {
    private permits: number = 1;
    private promiseResolverQueue: LockWaiter[] = [];

    async inLock<T>(
        func: () => Promise<T> | T,
        options: Readonly<{ deadlineAtMs?: number }> = {},
    ): Promise<T> {
        await this.lock(options);
        try {
            return await func();
        } finally {
            this.unlock();
        }
    }

    private async lock(options: Readonly<{ deadlineAtMs?: number }>) {
        const deadlineAtMs = options.deadlineAtMs;
        if (deadlineAtMs !== undefined && deadlineAtMs <= Date.now()) {
            throw new LockAdmissionDeadlineExceededError();
        }
        if (this.permits > 0) {
            this.permits = this.permits - 1;
            return;
        }
        await new Promise<void>((resolve, reject) => {
            let waiter: LockWaiter;
            const timeout = deadlineAtMs === undefined
                ? null
                : setTimeout(() => {
                    const index = this.promiseResolverQueue.indexOf(waiter);
                    if (index < 0) return;
                    this.promiseResolverQueue.splice(index, 1);
                    reject(new LockAdmissionDeadlineExceededError());
                }, Math.max(0, deadlineAtMs - Date.now()));
            waiter = { resolve, reject, timeout, deadlineAtMs };
            this.promiseResolverQueue.push(waiter);
        });
    }

    private unlock() {
        this.permits += 1;
        if (this.permits > 1 && this.promiseResolverQueue.length > 0) {
            throw new Error('this.permits should never be > 0 when there is someone waiting.');
        } else if (this.permits === 1) {
            // Expiry and unlock timers can become runnable in the same event-loop turn. Recheck the
            // absolute deadline while handing off so an expired waiter cannot start merely because
            // unlock happened to run before its timer callback.
            while (this.promiseResolverQueue.length > 0) {
                const nextWaiter = this.promiseResolverQueue.shift();
                if (nextWaiter) {
                    if (nextWaiter.timeout !== null) clearTimeout(nextWaiter.timeout);
                    if (nextWaiter.deadlineAtMs !== undefined && nextWaiter.deadlineAtMs <= Date.now()) {
                        nextWaiter.reject(new LockAdmissionDeadlineExceededError());
                        continue;
                    }
                    this.permits -= 1;
                    nextWaiter.resolve();
                    return;
                }
            }
        }
    }
}
