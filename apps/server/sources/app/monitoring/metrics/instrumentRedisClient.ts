import { observeRedisCommand } from "./redisMetrics";

type Thenable<T = unknown> = {
    then: (onfulfilled?: (value: T) => unknown, onrejected?: (reason: unknown) => unknown) => unknown;
};

function isThenable(value: unknown): value is Thenable {
    return typeof value === "object" && value !== null && typeof (value as Thenable).then === "function";
}

export function instrumentRedisClient<TClient extends object>(client: TClient): TClient {
    const wrappedMethods = new Map<PropertyKey, unknown>();

    return new Proxy(client, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== "function") {
                return value;
            }
            if (wrappedMethods.has(property)) {
                return wrappedMethods.get(property);
            }

            const wrapped = (...args: unknown[]) => {
                const command = String(property);
                const startedAt = Date.now();

                try {
                    const result = Reflect.apply(value, target, args);
                    if (!isThenable(result)) {
                        observeRedisCommand({
                            command,
                            durationMs: Date.now() - startedAt,
                            result: "ok",
                        });
                        return result;
                    }

                    return Promise.resolve(result).then(
                        (resolved) => {
                            observeRedisCommand({
                                command,
                                durationMs: Date.now() - startedAt,
                                result: "ok",
                            });
                            return resolved;
                        },
                        (error) => {
                            observeRedisCommand({
                                command,
                                durationMs: Date.now() - startedAt,
                                result: "error",
                                error,
                            });
                            throw error;
                        },
                    );
                } catch (error) {
                    observeRedisCommand({
                        command,
                        durationMs: Date.now() - startedAt,
                        result: "error",
                        error,
                    });
                    throw error;
                }
            };

            wrappedMethods.set(property, wrapped);
            return wrapped;
        },
    });
}
