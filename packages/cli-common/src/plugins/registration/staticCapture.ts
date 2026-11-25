export type CapturedMethod = (...args: unknown[]) => unknown;

function readMember(receiver: object, key: PropertyKey): unknown {
    return Reflect.get(receiver, key);
}

/**
 * The registration boundary accepts executable runtime objects structurally;
 * only arrays and non-objects cannot supply a stable method receiver.
 */
export function requireStaticRegistrationObject(value: unknown, label: string): object {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

/**
 * Capture one public runtime method through ordinary property access. The
 * resulting façade keeps the author receiver without retaining a mutable
 * public runtime object as the registered value.
 */
export function captureStaticRegistrationMethod<TMethod>(
    receiver: object,
    key: PropertyKey,
    label: string,
    required: boolean,
): TMethod | undefined {
    const method = readMember(receiver, key);
    if (method === undefined && !required) return undefined;
    if (typeof method !== 'function') {
        throw new TypeError(`${label} must be a function`);
    }
    const captured = method;
    const facade: CapturedMethod = (...args) => Reflect.apply(captured, receiver, args);
    return Object.freeze(facade) as TMethod;
}

/** Publish the callable surface captured at commit, using the original receiver. */
export function captureRegistrationMethods(
    value: unknown,
    label: string,
    required: readonly string[],
    optional: readonly string[] = [],
): Readonly<Record<string, CapturedMethod>> {
    const receiver = requireStaticRegistrationObject(value, label);
    const methods: Record<string, CapturedMethod> = {};
    for (const key of required) {
        methods[key] = captureStaticRegistrationMethod<CapturedMethod>(receiver, key, `${label}.${key}`, true)!;
    }
    for (const key of optional) {
        const method = captureStaticRegistrationMethod<CapturedMethod>(receiver, key, `${label}.${key}`, false);
        if (method) methods[key] = method;
    }
    return methods;
}
