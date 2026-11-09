/** Count native Error allocations during synchronous compiled-artifact work.
 * Evaluate classes inside the operation so their native superclass is observed.
 * Delegates to the engine constructor; domain parsers and validators stay real. */
export function countErrorAllocations<T>(message: string, operation: () => T): Readonly<{ result: T; count: number }> {
    const NativeError = globalThis.Error;
    let count = 0;
    globalThis.Error = new Proxy(NativeError, {
        construct(target, args, newTarget) {
            if (args[0] === message) count += 1;
            return Reflect.construct(target, args, newTarget);
        },
        apply(target, receiver, args) {
            if (args[0] === message) count += 1;
            return Reflect.apply(target, receiver, args);
        },
    });
    try {
        return { result: operation(), count };
    } finally {
        globalThis.Error = NativeError;
    }
}
