type TimerRecord = Readonly<{ kind: 'timeout' | 'interval'; delayMs: number; consumer: string | null }>;

/** Install after fake timers and before mounting the surface. Unknown callers remain visible. */
export function installTimerCensus(identify: (stack: string) => string | null = () => null) {
    const timers = new Map<unknown, TimerRecord>();
    const originalTimeout = globalThis.setTimeout;
    const originalInterval = globalThis.setInterval;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalClearInterval = globalThis.clearInterval;
    let timeoutFires = 0;
    let intervalFires = 0;
    const timeout = Object.assign((...input: Parameters<typeof originalTimeout>) => {
        const [callback, delay, ...args] = input;
        const handle = originalTimeout(function (this: unknown) {
            timers.delete(handle);
            timeoutFires += 1;
            callback.apply(this, args);
        }, delay);
        timers.set(handle, { kind: 'timeout', delayMs: delay ?? 0, consumer: identify(new Error().stack ?? '') });
        return handle;
    }, originalTimeout);
    const interval = Object.assign((...input: Parameters<typeof originalInterval>) => {
        const [callback, delay, ...args] = input;
        const handle = originalInterval(function (this: unknown) {
            intervalFires += 1;
            callback.apply(this, args);
        }, delay);
        timers.set(handle, { kind: 'interval', delayMs: delay ?? 0, consumer: identify(new Error().stack ?? '') });
        return handle;
    }, originalInterval);
    const clearTimeout = Object.assign((...args: Parameters<typeof originalClearTimeout>) => {
        const [handle] = args;
        timers.delete(handle);
        originalClearTimeout(...args);
    }, originalClearTimeout);
    const clearInterval = Object.assign((...args: Parameters<typeof originalClearInterval>) => {
        const [handle] = args;
        timers.delete(handle);
        originalClearInterval(...args);
    }, originalClearInterval);
    // Do not register fake-clock functions in Vitest's lifetime-wide spy registry:
    // a later restoreAllMocks can otherwise reinstall them after fake mode ends.
    globalThis.setTimeout = timeout;
    globalThis.setInterval = interval;
    globalThis.clearTimeout = clearTimeout;
    globalThis.clearInterval = clearInterval;
    return {
        read: (): readonly TimerRecord[] => [...timers.values()].map(timer => ({ ...timer })),
        readFires: () => ({ timeout: timeoutFires, interval: intervalFires }),
        stop: () => {
            globalThis.setTimeout = originalTimeout;
            globalThis.setInterval = originalInterval;
            globalThis.clearTimeout = originalClearTimeout;
            globalThis.clearInterval = originalClearInterval;
            timers.clear();
        },
    };
}
