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

/** The frame payload real Reanimated hands a frame callback on the UI thread. */
export type ReanimatedFrameInfo = Readonly<{
    timestamp: number;
    timeSincePreviousFrame: number | null;
    timeSinceFirstFrame: number;
}>;

export type ReanimatedFrameCallbackHandle = {
    setActive(active: boolean): void;
    isActive: boolean;
    callbackId: number;
};

export type ReanimatedFrameCallbackRecord = Readonly<{
    handle: ReanimatedFrameCallbackHandle;
    /** Every `setActive` argument in order — activation is otherwise unobservable. */
    setActiveCalls: boolean[];
    /**
     * Drives one frame through the registered worklet, and only while the
     * callback is active — real Reanimated does not tick a stopped callback, and
     * a test that forgets to activate should see nothing move.
     */
    run(frameInfo: ReanimatedFrameInfo): void;
}>;

const frameCallbackRecords: ReanimatedFrameCallbackRecord[] = [];

/**
 * Frame callbacks registered since the last reset, oldest first.
 *
 * Tests never tick the timeline, so activation and per-frame worklet output are
 * invisible without this. It is deliberately a module-level registry: the
 * reanimated stub instantiates the mock once for the whole module graph, so a
 * test reads the same records the component under test registered.
 */
export function readReanimatedFrameCallbacks(): readonly ReanimatedFrameCallbackRecord[] {
    return frameCallbackRecords;
}

export function resetReanimatedFrameCallbacks(): void {
    frameCallbackRecords.length = 0;
}

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

type ReanimatedLayoutAnimationMock = Readonly<{
    presetName: string;
    /**
     * The real builders store the chosen animation FUNCTION here; the mock stores a marker, which
     * is the one field whose shape deliberately differs. Everything else uses Reanimated's own
     * `…V` field names so an assertion reads the same property the library would.
     */
    type?: 'spring';
    stiffnessV?: number;
    dampingV?: number;
    massV?: number;
    dampingRatioV?: number;
    easingV?: unknown;
    durationV?: number;
    delayV?: number;
    reduceMotionV?: string;
}>;

/**
 * A chainable stand-in for `LinearTransition` / `FadeIn` and friends.
 *
 * Each modifier returns a NEW recorder, mirroring the real builders closely enough that a shared
 * module-scope constant cannot be mutated by a later caller.
 */
function createLayoutAnimationBuilderMock(presetName: string) {
    type Builder = ReanimatedLayoutAnimationMock & {
        springify: (duration?: number) => Builder;
        stiffness: (value: number) => Builder;
        damping: (value: number) => Builder;
        mass: (value: number) => Builder;
        dampingRatio: (value: number) => Builder;
        easing: (value: unknown) => Builder;
        duration: (value: number) => Builder;
        delay: (value: number) => Builder;
        reduceMotion: (value: string) => Builder;
        build: () => () => Record<string, unknown>;
    };

    const make = (record: ReanimatedLayoutAnimationMock): Builder => Object.freeze({
        ...record,
        springify: (): Builder => make({ ...record, type: 'spring' }),
        stiffness: (value: number): Builder => make({ ...record, stiffnessV: value }),
        damping: (value: number): Builder => make({ ...record, dampingV: value }),
        mass: (value: number): Builder => make({ ...record, massV: value }),
        dampingRatio: (value: number): Builder => make({ ...record, dampingRatioV: value }),
        easing: (value: unknown): Builder => make({ ...record, easingV: value }),
        duration: (value: number): Builder => make({ ...record, durationV: value }),
        delay: (value: number): Builder => make({ ...record, delayV: value }),
        reduceMotion: (value: string): Builder => make({ ...record, reduceMotionV: value }),
        build: () => () => ({ initialValues: {}, animations: {} }),
    }) as Builder;

    return make({ presetName });
}

export type ReanimatedModuleMockOptions = Readonly<{
    /**
     * Invoke a `withTiming` completion callback synchronously with `finished: true`.
     *
     * Off by default: several suites assert the state a component holds WHILE an animation runs,
     * and settling it in the same tick would erase exactly what they measure. Opt in from a suite
     * whose behaviour under test is what happens once the animation lands — an exit transition that
     * navigates on completion, for instance.
     */
    settleTimingCallbacks?: boolean;
}>;

export function createReanimatedModuleMock(options: ReanimatedModuleMockOptions = {}) {
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

    // Mirrors the real `ReduceMotion` string enum: production code stamps this value on
    // motion configs, so a mock without it turns a policy decision into a `TypeError`.
    const ReduceMotion = {
        System: 'system',
        Always: 'always',
        Never: 'never',
    } as const;

    return {
        __esModule: true,
        default: Animated,
        ...Animated,
        Easing,
        // Layout-animation builders and the reduced-motion enum are read at module or
        // render scope by production code, so a mock without them is not a missing
        // assertion but an import-time crash.
        FadeIn: createLayoutAnimationBuilderMock('FadeIn'),
        LinearTransition: createLayoutAnimationBuilderMock('LinearTransition'),
        ReduceMotion,
        // Reanimated's real `Extrapolation` is a plain enum of string constants; production code
        // passes one to `interpolate`, which this mock ignores (it returns the range start).
        Extrapolation: {
            CLAMP: 'clamp',
            EXTEND: 'extend',
            IDENTITY: 'identity',
        },
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
        // Reanimated drives this off the UI-thread render loop; nothing ticks it
        // here, so the worklet is registered rather than run. This keeps the
        // level conduit off React: pushing to a SharedValue never schedules a
        // frame in unit tests.
        //
        // The handle is stable per hook instance, like the real one, because
        // production code puts `frame.setActive` in an effect dependency list —
        // a fresh object every render would re-run that effect forever and hide
        // the very activation bug the tests are written to catch.
        useFrameCallback: (callback: (frameInfo: ReanimatedFrameInfo) => void, autostart?: boolean) => {
            const latest = React.useRef(callback);
            latest.current = callback;
            const ref = React.useRef<ReanimatedFrameCallbackRecord | null>(null);
            if (!ref.current) {
                const setActiveCalls: boolean[] = [];
                const handle: ReanimatedFrameCallbackHandle = {
                    setActive: (active: boolean) => {
                        setActiveCalls.push(active);
                        handle.isActive = active;
                    },
                    isActive: autostart ?? false,
                    callbackId: frameCallbackRecords.length,
                };
                const record: ReanimatedFrameCallbackRecord = {
                    handle,
                    setActiveCalls,
                    run: (frameInfo) => {
                        if (!handle.isActive) return;
                        latest.current(frameInfo);
                    },
                };
                ref.current = record;
                frameCallbackRecords.push(record);
            }
            return ref.current.handle;
        },
        useDerivedValue,
        useSharedValue,
        withRepeat: <T,>(value: T): T => value,
        withSequence: <T,>(...values: T[]): T => values[values.length - 1] as T,
        withDelay: <T,>(_delayMs: number, value: T): T => value,
        withSpring: <T,>(value: T): T => value,
        withTiming: <T,>(
            value: T,
            config?: ReanimatedTimingConfig,
            callback?: (finished?: boolean) => void,
        ): T => {
            assertEasingIsWorkletLike(config?.easing);
            if (options.settleTimingCallbacks) callback?.(true);
            return value;
        },
    };
}
