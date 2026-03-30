import type { PlainObject } from './_shared';
import { isPlainObject, mergeObjects } from './_shared';

export type TestReactNativeOverrides = Record<string, unknown>;
type ReactNativeStubModule = typeof import('../../reactNativeStub');
type DeepMutable<T> = T extends (...args: infer TArgs) => infer TResult
    ? (...args: TArgs) => TResult
    : T extends readonly (infer TValue)[]
      ? DeepMutable<TValue>[]
      : T extends object
        ? { -readonly [TKey in keyof T]: DeepMutable<T[TKey]> }
        : T;

function mergeObjectsPreservingDescriptors<T extends PlainObject>(
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

export async function createReactNativeWebMock(
    overrides?: TestReactNativeOverrides,
): Promise<DeepMutable<ReactNativeStubModule> & TestReactNativeOverrides> {
    const stub = await import('../../reactNativeStub');
    const { Platform: platformOverrides, AppState: appStateOverrides, ...restOverrides } = overrides ?? {};
    const mergedModule = mergeObjects(stub as PlainObject, restOverrides as PlainObject | undefined);
    const basePlatform = {
        ...(stub.Platform ?? {}),
        OS: 'web',
        select: <T,>(options: { web?: T; default?: T; native?: T; ios?: T; android?: T }) =>
            options?.web ?? options?.default ?? options?.native ?? options?.ios ?? options?.android,
    };

    return {
        ...mergedModule,
        Platform: mergeObjectsPreservingDescriptors(
            basePlatform as PlainObject,
            (platformOverrides as PlainObject | undefined) ?? undefined,
        ),
        AppState: mergeObjectsPreservingDescriptors(
            {
                ...(stub.AppState ?? {}),
                currentState: 'active',
                addEventListener: () => ({ remove: () => {} }),
            },
            appStateOverrides as PlainObject | undefined,
        ),
    } as DeepMutable<ReactNativeStubModule> & TestReactNativeOverrides;
}

export function installReactNativeWebMock(overrides?: TestReactNativeOverrides) {
    return async () => createReactNativeWebMock(overrides);
}
