export {
    isPlainObject,
    mergeObjects,
    mergeObjectsPreservingDescriptors,
    type PlainObject,
} from '../runtime/_shared';
import type { MergeModuleRuntimeOptions } from '../runtime/_shared';

export type MergeModuleMockOptions<TModule> = MergeModuleRuntimeOptions<TModule>;

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
