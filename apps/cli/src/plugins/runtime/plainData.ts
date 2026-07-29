export type PluginPlainDataLimits = Readonly<{
    maxDepth?: number;
    maxNodes?: number;
    maxStringBytes?: number;
}>;

export type ClonePluginPlainDataOptions = Readonly<{
    path?: string;
    limits?: PluginPlainDataLimits;
    invalid(message: string): Error;
    limitExceeded?(message: string): Error;
}>;

export const PLUGIN_RUNTIME_JSON_VALUE_LIMITS = Object.freeze({
    maxDepth: 64,
    maxNodes: 65_536,
    maxStringBytes: 4 * 1024 * 1024,
});

type CloneState = {
    nodes: number;
    stringBytes: number;
};

const textEncoder = new TextEncoder();

export function clonePluginPlainData<T>(value: T, options: ClonePluginPlainDataOptions): T {
    const ancestors = new WeakSet<object>();
    const state: CloneState = { nodes: 0, stringBytes: 0 };

    function invalid(message: string): never {
        throw options.invalid(message);
    }

    function limitExceeded(message: string): never {
        throw (options.limitExceeded ?? options.invalid)(message);
    }

    function clone(input: unknown, path: string, depth: number): unknown {
        if (options.limits?.maxDepth !== undefined && depth > options.limits.maxDepth) {
            limitExceeded(`${path} exceeds the maximum plain-data depth`);
        }
        state.nodes += 1;
        if (options.limits?.maxNodes !== undefined && state.nodes > options.limits.maxNodes) {
            limitExceeded(`${path} exceeds the maximum plain-data node count`);
        }
        if (input === null || typeof input === 'boolean') return input;
        if (typeof input === 'string') {
            state.stringBytes += textEncoder.encode(input).byteLength;
            if (options.limits?.maxStringBytes !== undefined
                && state.stringBytes > options.limits.maxStringBytes) {
                limitExceeded(`${path} exceeds the maximum plain-data string size`);
            }
            return input;
        }
        if (typeof input === 'number') {
            if (!Number.isFinite(input)) invalid(`${path} must contain finite JSON numbers`);
            return input;
        }
        if (typeof input !== 'object') invalid(`${path} must contain strict JSON data`);
        if (ancestors.has(input)) invalid(`${path} must not contain cyclic data`);
        ancestors.add(input);

        try {
            if (Array.isArray(input)) {
                const descriptors = Object.getOwnPropertyDescriptors(input);
                const keys = Reflect.ownKeys(descriptors);
                for (let index = 0; index < input.length; index += 1) {
                    const descriptor = descriptors[String(index)];
                    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
                        invalid(`${path} must not contain holes or accessors`);
                    }
                }
                if (keys.some((key) => typeof key === 'symbol'
                    || (key !== 'length' && (
                        !/^\d+$/.test(key)
                        || String(Number(key)) !== key
                        || Number(key) >= input.length
                    )))) {
                    invalid(`${path} must not contain extra array properties`);
                }
                const output: unknown[] = [];
                for (let index = 0; index < input.length; index += 1) {
                    const descriptor = descriptors[String(index)]!;
                    output.push(clone(descriptor.value, `${path}[${index}]`, depth + 1));
                }
                return Object.freeze(output);
            }

            const prototype = Object.getPrototypeOf(input);
            if (prototype !== Object.prototype && prototype !== null) {
                invalid(`${path} must contain only plain objects`);
            }
            const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
            for (const key of Reflect.ownKeys(input)) {
                if (typeof key === 'symbol') invalid(`${path} must not contain symbol keys`);
                state.stringBytes += textEncoder.encode(key).byteLength;
                if (options.limits?.maxStringBytes !== undefined
                    && state.stringBytes > options.limits.maxStringBytes) {
                    limitExceeded(`${path} exceeds the maximum plain-data string size`);
                }
                const descriptor = Object.getOwnPropertyDescriptor(input, key);
                if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
                    invalid(`${path}.${key} must be enumerable data`);
                }
                Object.defineProperty(output, key, {
                    value: clone(descriptor.value, `${path}.${key}`, depth + 1),
                    enumerable: true,
                    writable: false,
                    configurable: false,
                });
            }
            return Object.freeze(output);
        } finally {
            ancestors.delete(input);
        }
    }

    return clone(value, options.path ?? 'value', 0) as T;
}
