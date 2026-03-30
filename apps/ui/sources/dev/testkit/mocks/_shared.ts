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

export type MergeModuleMockOptions<TModule> = Readonly<{
    importOriginal: <T>() => Promise<T>;
    overrides: Partial<TModule>;
}>;

export async function mergeModuleMock<TModule>({
    importOriginal,
    overrides,
}: MergeModuleMockOptions<TModule>): Promise<TModule> {
    const actual = await importOriginal<TModule>();
    // Vitest's `importOriginal()` returns an ESM namespace object whose exports are exposed as getter-only
    // properties. Spreading/assigning can drop non-enumerable exports, and using it as a prototype breaks
    // simple assignment (getter-only prototype props throw on set). Instead, clone descriptors onto a
    // plain object, then define overrides as normal writable values.
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
