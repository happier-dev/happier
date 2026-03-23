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
    return {
        ...actual,
        ...overrides,
    };
}
