import type { PlainObject } from './_shared';
import { isPlainObject, mergeObjects } from './_shared';

export type TestReactNativeOverrides = Record<string, unknown>;
export type TestReactNativeAppStateStatus =
    | 'active'
    | 'background'
    | 'extension'
    | 'inactive'
    | 'unknown';
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

export type TestReactNativeNativePlatformOS = 'ios' | 'android';

/**
 * The native counterpart of {@link createReactNativeWebMock}.
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
export async function createReactNativeNativeMock(
    options: Readonly<{ platformOS: TestReactNativeNativePlatformOS }>,
    overrides?: TestReactNativeOverrides,
): Promise<DeepMutable<ReactNativeStubModule> & TestReactNativeOverrides> {
    const stub = await import('../../reactNativeStub');
    const { Platform: platformOverrides, Animated: animatedOverrides, ...restOverrides } = overrides ?? {};
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
        Animated: mergeObjectsPreservingDescriptors(
            baseAnimated as PlainObject,
            animatedOverrides as PlainObject | undefined,
        ),
        I18nManager: { isRTL: false, ...(restOverrides.I18nManager as PlainObject | undefined) },
        Platform: mergeObjectsPreservingDescriptors(
            basePlatform as PlainObject,
            (platformOverrides as PlainObject | undefined) ?? undefined,
        ),
        unstable_batchedUpdates: (callback: () => void) => callback(),
    } as unknown as DeepMutable<ReactNativeStubModule> & TestReactNativeOverrides;
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

/**
 * Android `BackHandler` boundary: listeners run newest-first and the first one returning `true`
 * consumes the press, matching React Native's dispatch order. `press()` reports whether any
 * listener consumed it (the platform would otherwise run its default back action).
 */
export function createReactNativeBackHandlerEmitter() {
    const listeners: Array<() => boolean | null | undefined> = [];
    const backHandler = {
        addEventListener(eventName: string, listener: () => boolean | null | undefined) {
            if (eventName !== 'hardwareBackPress') {
                return { remove: () => {} };
            }
            listeners.push(listener);
            return {
                remove: () => {
                    const index = listeners.lastIndexOf(listener);
                    if (index >= 0) listeners.splice(index, 1);
                },
            };
        },
        exitApp: () => {},
    };

    return {
        backHandler,
        press(): boolean {
            for (const listener of [...listeners].reverse()) {
                if (listener()) return true;
            }
            return false;
        },
        getListenerCount() {
            return listeners.length;
        },
    };
}
