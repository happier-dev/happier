export type PlainObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is PlainObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeObjects<T extends PlainObject>(base: T, override: Partial<T> | undefined): T {
    if (!override) return { ...base };

    const out: PlainObject = { ...base };
    for (const [key, value] of Object.entries(override)) {
        const current = out[key];
        if (isPlainObject(current) && isPlainObject(value)) {
            out[key] = mergeObjects(current, value);
            continue;
        }
        out[key] = value;
    }
    return out as T;
}

export function mergeObjectsPreservingDescriptors<T extends PlainObject>(
    base: T,
    override: PlainObject | undefined,
): T {
    if (!override) {
        return { ...base };
    }

    const out: PlainObject = { ...base };
    for (const key of Reflect.ownKeys(override)) {
        const descriptor = Object.getOwnPropertyDescriptor(override, key);
        if (!descriptor) {
            continue;
        }

        if ('value' in descriptor && isPlainObject(out[key as keyof PlainObject]) && isPlainObject(descriptor.value)) {
            out[key as keyof PlainObject] = mergeObjects(out[key as keyof PlainObject] as PlainObject, descriptor.value);
            continue;
        }

        Object.defineProperty(out, key, descriptor);
    }

    return out as T;
}

export type MergeModuleRuntimeOptions<TModule> = Readonly<{
    importOriginal: <T>() => Promise<T>;
    overrides: Partial<TModule>;
}>;

export async function mergeModuleRuntime<TModule>({
    importOriginal,
    overrides,
}: MergeModuleRuntimeOptions<TModule>): Promise<TModule> {
    const actual = await importOriginal<TModule>();
    const out: Record<PropertyKey, unknown> = {};
    for (const key of Reflect.ownKeys(actual as object)) {
        const descriptor = Object.getOwnPropertyDescriptor(actual as object, key);
        if (!descriptor) continue;
        Object.defineProperty(out, key, { ...descriptor, configurable: true });
    }

    for (const [key, value] of Object.entries(overrides)) {
        Object.defineProperty(out, key, {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
        });
    }

    return out as TModule;
}
