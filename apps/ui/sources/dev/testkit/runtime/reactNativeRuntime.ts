import type { PlainObject } from './_shared';
import { mergeObjects, mergeObjectsPreservingDescriptors } from './_shared';

export type TestReactNativeRuntimeOverrides = Record<string, unknown>;
type ReactNativeStubModule = typeof import('../../reactNativeStub');
type DeepMutable<T> = T extends (...args: infer TArgs) => infer TResult
    ? (...args: TArgs) => TResult
    : T extends readonly (infer TValue)[]
      ? DeepMutable<TValue>[]
      : T extends object
        ? { -readonly [TKey in keyof T]: DeepMutable<T[TKey]> }
        : T;

export async function createReactNativeWebRuntime(
    overrides?: TestReactNativeRuntimeOverrides,
): Promise<DeepMutable<ReactNativeStubModule> & TestReactNativeRuntimeOverrides> {
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
    } as DeepMutable<ReactNativeStubModule> & TestReactNativeRuntimeOverrides;
}

export function installReactNativeWebRuntime(overrides?: TestReactNativeRuntimeOverrides) {
    return async () => createReactNativeWebRuntime(overrides);
}
