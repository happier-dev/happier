export type KeyedTimeoutScheduler = Readonly<{
    /** Schedule (or replace) the pending timeout for a key. */
    schedule: (key: string, delayMs: number, onFire: () => void) => void;
    /** Drop the pending timeout for a key, if any. */
    cancel: (key: string) => void;
}>;

/**
 * One pending timeout per key, with replace-on-reschedule semantics. Owns the
 * clear/replace/forget mechanics that keyed `setTimeout` maps otherwise
 * hand-roll (and drift apart) at each call site — e.g. the per-session
 * ephemeral thinking markers in the sessions store domain. The key is
 * released before the callback runs so callbacks may reschedule themselves.
 */
export function createKeyedTimeoutScheduler(): KeyedTimeoutScheduler {
    const timeoutsByKey = new Map<string, ReturnType<typeof setTimeout>>();

    return {
        schedule: (key: string, delayMs: number, onFire: () => void) => {
            const existing = timeoutsByKey.get(key);
            if (existing) {
                clearTimeout(existing);
            }
            const timeout = setTimeout(() => {
                timeoutsByKey.delete(key);
                onFire();
            }, delayMs);
            timeoutsByKey.set(key, timeout);
        },
        cancel: (key: string) => {
            const existing = timeoutsByKey.get(key);
            if (existing === undefined) return;
            clearTimeout(existing);
            timeoutsByKey.delete(key);
        },
    };
}
