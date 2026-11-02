import type { PlainObject } from './_shared';
import { mergeObjects, mergeObjectsPreservingDescriptors } from './_shared';

export type TestReactNativeRuntimeOverrides = Record<string, unknown>;
export type TestReactNativeAppStateStatus =
    | 'active'
    | 'background'
    | 'extension'
    | 'inactive'
    | 'unknown';
type ReactNativeStubModule = typeof import('../../reactNativeStub');
export type TestReactNativeStubLoader = () => Promise<ReactNativeStubModule>;
const loadReactNativeStub: TestReactNativeStubLoader = () => import('../../reactNativeStub');
type DeepMutable<T> = T extends (...args: infer TArgs) => infer TResult
    ? (...args: TArgs) => TResult
    : T extends readonly (infer TValue)[]
      ? DeepMutable<TValue>[]
      : T extends object
        ? { -readonly [TKey in keyof T]: DeepMutable<T[TKey]> }
        : T;

/**
 * React Native's `useWindowDimensions` reads the `Dimensions` window authority, so a fixture sees
 * one viewport whichever side it overrides: a `useWindowDimensions` override is what
 * `Dimensions.get` reports, and an overridden `Dimensions` is what the hook reports.
 */
function windowDimensionsAuthority(
    stub: ReactNativeStubModule,
    mergedModule: PlainObject,
    overrides: TestReactNativeRuntimeOverrides,
): PlainObject {
    const readWindow = overrides.useWindowDimensions;
    if (typeof readWindow === 'function' && overrides.Dimensions === undefined) {
        return {
            Dimensions: {
                ...stub.Dimensions,
                get: () => ({ ...stub.Dimensions.get(), ...(readWindow as () => PlainObject)() }),
            },
        };
    }
    if (readWindow !== undefined) return {};
    const dimensions = mergedModule.Dimensions as {
        get: (name: 'window' | 'screen') => ReturnType<ReactNativeStubModule['useWindowDimensions']>;
    };
    return { useWindowDimensions: () => dimensions.get('window') };
}

export async function createReactNativeWebRuntime(
    overrides?: TestReactNativeRuntimeOverrides,
    loadStub: TestReactNativeStubLoader = loadReactNativeStub,
): Promise<DeepMutable<ReactNativeStubModule> & TestReactNativeRuntimeOverrides> {
    const stub = await loadStub();
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
        ...windowDimensionsAuthority(stub, mergedModule, restOverrides),
        Platform: mergeObjectsPreservingDescriptors(
            basePlatform as PlainObject,
            (platformOverrides as PlainObject | undefined) ?? undefined,
        ),
        AppState: appStateOverrides
            ? mergeObjectsPreservingDescriptors(reactNativeWebAppState.appState, appStateOverrides as PlainObject)
            : reactNativeWebAppState.appState,
    // Arbitrary SDK-port overrides are intentionally untyped at this fixture boundary.
    } as unknown as DeepMutable<ReactNativeStubModule> & TestReactNativeRuntimeOverrides;
}

export function installReactNativeWebRuntime(
    overrides?: TestReactNativeRuntimeOverrides,
    loadStub: TestReactNativeStubLoader = loadReactNativeStub,
) {
    return async () => createReactNativeWebRuntime(overrides, loadStub);
}

export type TestReactNativeNativePlatformOS = 'ios' | 'android';

/**
 * The native counterpart of {@link createReactNativeWebRuntime}.
 *
 * The shared stub reports `Platform.OS === 'node'` and omits a few real React Native exports that
 * only native-build consumers reach for. `@legendapp/list`'s native artifact needs all of them at
 * module evaluation - `ReactNative.unstable_batchedUpdates`, `Animated.ScrollView`,
 * `Animated.event` and `I18nManager` - and a missing one surfaces as a module-init crash rather
 * than a behavioural failure, which is how a native harness ends up quietly disabled.
 *
 * `Platform.select` is switched to native precedence to match the device: `web` is no longer a
 * candidate, and the requested OS key wins over the generic `native` key.
 */
export async function createReactNativeNativeRuntime(
    options: Readonly<{ platformOS: TestReactNativeNativePlatformOS }>,
    overrides?: TestReactNativeRuntimeOverrides,
    loadStub: TestReactNativeStubLoader = loadReactNativeStub,
): Promise<DeepMutable<ReactNativeStubModule> & TestReactNativeRuntimeOverrides> {
    const stub = await loadStub();
    const { Platform: platformOverrides, Animated: animatedOverrides, AppState: appStateOverrides, ...restOverrides } = overrides ?? {};
    const mergedModule = mergeObjects(stub as PlainObject, restOverrides as PlainObject | undefined);
    const { platformOS } = options;

    const basePlatform = {
        ...(stub.Platform ?? {}),
        OS: platformOS,
        select: <T,>(choices: { web?: T; default?: T; native?: T; ios?: T; android?: T }) => (
            choices?.[platformOS] ?? choices?.native ?? choices?.default
        ),
    };

    const baseAnimated = {
        ...(stub.Animated ?? {}),
        // The list drives its scroller through `Animated.ScrollView`; react-test-renderer needs a
        // host name it can find, and the rest of the suite already targets the string 'ScrollView'.
        ScrollView: 'ScrollView',
        event: (_argMapping: unknown, config?: { listener?: (...args: unknown[]) => void }) => (
            (...args: unknown[]) => config?.listener?.(...args)
        ),
    };

    return {
        ...mergedModule,
        ...windowDimensionsAuthority(stub, mergedModule, restOverrides),
        AppState: mergeObjectsPreservingDescriptors(
            stub.AppState as PlainObject,
            appStateOverrides as PlainObject | undefined,
        ),
        Animated: mergeObjectsPreservingDescriptors(
            baseAnimated as PlainObject,
            animatedOverrides as PlainObject | undefined,
        ),
        I18nManager: { ...stub.I18nManager, ...(restOverrides.I18nManager as PlainObject | undefined) },
        Platform: mergeObjectsPreservingDescriptors(
            basePlatform as PlainObject,
            (platformOverrides as PlainObject | undefined) ?? undefined,
        ),
        unstable_batchedUpdates: (callback: () => void) => callback(),
    } as unknown as DeepMutable<ReactNativeStubModule> & TestReactNativeRuntimeOverrides;
}

export function createReactNativeAppStateEmitter(
    initialState: TestReactNativeAppStateStatus = 'active',
) {
    let currentState = initialState;
    const changeListeners = new Set<(state: TestReactNativeAppStateStatus) => void>();
    const appState = {
        get currentState() {
            return currentState;
        },
        addEventListener(
            eventName: string,
            listener: (state: TestReactNativeAppStateStatus) => void,
        ) {
            if (eventName !== 'change') {
                return { remove: () => {} };
            }
            changeListeners.add(listener);
            return {
                remove: () => {
                    changeListeners.delete(listener);
                },
            };
        },
    };

    return {
        appState,
        emit(state: TestReactNativeAppStateStatus) {
            currentState = state;
            for (const listener of [...changeListeners]) {
                listener(state);
            }
        },
        getListenerCount() {
            return changeListeners.size;
        },
        install(target: object) {
            const keys = ['currentState', 'addEventListener'] as const;
            const originalDescriptors = new Map(
                keys.map((key) => [key, Object.getOwnPropertyDescriptor(target, key)]),
            );
            for (const key of keys) {
                const descriptor = Object.getOwnPropertyDescriptor(appState, key);
                if (descriptor) {
                    Object.defineProperty(target, key, {
                        ...descriptor,
                        configurable: true,
                    });
                }
            }
            return () => {
                for (const key of keys) {
                    const descriptor = originalDescriptors.get(key);
                    if (descriptor) {
                        Object.defineProperty(target, key, descriptor);
                    } else {
                        Reflect.deleteProperty(target, key);
                    }
                }
            };
        },
    };
}

// Web mocks and eagerly imported lifetime observers must share one OS boundary.
export const reactNativeWebAppState = createReactNativeAppStateEmitter();
