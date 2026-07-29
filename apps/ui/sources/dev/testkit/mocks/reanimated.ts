import * as React from 'react';

export type ReanimatedSharedValue<T> = {
    value: T;
    get(): T;
    set(value: T): void;
};

type ReanimatedEasingFunction = ((t: number) => number) & { __workletHash?: number };
type ReanimatedEasingFactory = Readonly<{ factory: () => ReanimatedEasingFunction }>;
type ReanimatedTimingConfig = Readonly<{
    easing?: ReanimatedEasingFunction | ReanimatedEasingFactory;
}>;

function createWorkletEasing(fn: (t: number) => number): ReanimatedEasingFunction {
    const easing = fn as ReanimatedEasingFunction;
    easing.__workletHash = 1;
    return easing;
}

function assertEasingIsWorkletLike(easing: ReanimatedTimingConfig['easing']): void {
    if (!easing) return;
    if ('factory' in easing) return;
    if (typeof easing === 'function' && easing.__workletHash) return;
    throw new Error(
        'The easing function is not a worklet. Please make sure you import `Easing` from react-native-reanimated.',
    );
}

export function createReanimatedModuleMock() {
    const Animated = {
        View: 'Animated.View',
        ScrollView: 'Animated.ScrollView',
        Text: 'Animated.Text',
        createAnimatedComponent: (component: unknown) => component,
    } as const;

    const createSharedValue = <T,>(initial: T): ReanimatedSharedValue<T> => {
        const shared = {
            value: initial,
            get: () => shared.value,
            set: (value: T) => {
                shared.value = value;
            },
        };
        return shared;
    };
    const makeMutable = <T,>(initial: T): ReanimatedSharedValue<T> => createSharedValue(initial);
    const useSharedValue = <T,>(initial: T): ReanimatedSharedValue<T> => {
        const ref = React.useRef<ReanimatedSharedValue<T> | null>(null);
        if (!ref.current) {
            ref.current = createSharedValue(initial);
        }
        return ref.current;
    };
    const useDerivedValue = <T,>(factory: () => T): ReanimatedSharedValue<T> => {
        const ref = React.useRef<ReanimatedSharedValue<T> | null>(null);
        const value = factory();
        if (!ref.current) {
            ref.current = createSharedValue(value);
        } else {
            ref.current.value = value;
        }
        return ref.current;
    };
    const runOnJS = <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) => fn;
    const runOnUI = <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) => fn;
    const useAnimatedRef = <T,>() => React.useRef<T | null>(null);

    // Minimal interpolation helpers. Production code uses these to map a
    // 0→1 hover progress shared value to pixel and color output ranges; in
    // unit tests we never tick the timeline so returning the input-range
    // start (output[0]) is a safe identity.
    const interpolate = (
        _value: number,
        _input: readonly number[],
        output: readonly number[],
    ): number => output[0] ?? 0;
    const interpolateColor = (
        _value: number,
        _input: readonly number[],
        output: readonly string[],
    ): string => output[0] ?? 'transparent';

    // Minimal Easing stub. Reanimated's real Easing module exposes preset
    // curves and a `bezier(...)` factory; under tests we just need callable
    // identity functions so production code that imports `Easing.bezier(...)`
    // doesn't crash at module-evaluation time.
    const identityEasing = createWorkletEasing((t: number) => t);
    const Easing = {
        linear: identityEasing,
        ease: identityEasing,
        quad: identityEasing,
        cubic: identityEasing,
        bezier: (_x1: number, _y1: number, _x2: number, _y2: number): ReanimatedEasingFactory => ({
            factory: () => identityEasing,
        }),
        bezierFn: (_x1: number, _y1: number, _x2: number, _y2: number) => identityEasing,
        in: (fn?: (t: number) => number) => fn ?? identityEasing,
        out: (fn?: (t: number) => number) => fn ?? identityEasing,
        inOut: (fn?: (t: number) => number) => fn ?? identityEasing,
    } as const;

    return {
        __esModule: true,
        default: Animated,
        ...Animated,
        Easing,
        interpolate,
        interpolateColor,
        cancelAnimation: () => {},
        makeMutable,
        runOnJS,
        runOnUI,
        scrollTo: () => {},
        useAnimatedRef,
        useAnimatedProps: <T,>(factory: () => T): T => factory(),
        useAnimatedReaction: (prepare: () => unknown, react: (value: unknown, previous: unknown) => void) => {
            try {
                react(prepare(), undefined);
            } catch {
                // Native Reanimated swallows worklet-environment details that are unavailable in node tests.
            }
        },
        useAnimatedStyle: <T,>(factory: () => T): T => factory(),
        // Reanimated drives this off the UI-thread render loop; tests never tick
        // the timeline, so we just register the worklet without running it. This
        // keeps the level conduit off React: pushing to the SharedValue never
        // schedules a frame callback in unit tests.
        useFrameCallback: (_callback: (frameInfo: unknown) => void, _autostart?: boolean) => ({
            setActive: (_active: boolean) => {},
            isActive: false,
            callbackId: 0,
        }),
        useDerivedValue,
        useSharedValue,
        withRepeat: <T,>(value: T): T => value,
        withSequence: <T,>(...values: T[]): T => values[values.length - 1] as T,
        withDelay: <T,>(_delayMs: number, value: T): T => value,
        withSpring: <T,>(value: T): T => value,
        withTiming: <T,>(value: T, config?: ReanimatedTimingConfig): T => {
            assertEasingIsWorkletLike(config?.easing);
            return value;
        },
    };
}
