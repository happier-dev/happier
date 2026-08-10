import * as React from 'react';

export type ReanimatedSharedValue<T> = { value: T };

export type ReanimatedAnimatedRef<T> = ((component?: T | null) => void) & { current: T | null };

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

/**
 * What a layout/entering animation builder was configured to do.
 *
 * The real builders are opaque objects consumed on the UI thread, so a node test can never observe
 * the motion itself. What it CAN observe is the configuration a component chose — which spring,
 * and whether one was attached at all — and that is exactly the decision a component owns. The
 * mock records the chain instead of running it.
 */
export type ReanimatedLayoutAnimationMock = Readonly<{
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
        duration: (value: number): Builder => make({ ...record, durationV: value }),
        delay: (value: number): Builder => make({ ...record, delayV: value }),
        reduceMotion: (value: string): Builder => make({ ...record, reduceMotionV: value }),
        build: () => () => ({ initialValues: {}, animations: {} }),
    }) as Builder;

    return make({ presetName });
}

export function createReanimatedModuleMock() {
    const Animated = {
        View: 'Animated.View',
        ScrollView: 'Animated.ScrollView',
        Text: 'Animated.Text',
        createAnimatedComponent: (component: unknown) => component,
    } as const;

    const useSharedValue = <T,>(initial: T): ReanimatedSharedValue<T> => {
        const ref = React.useRef<ReanimatedSharedValue<T> | null>(null);
        if (!ref.current) {
            ref.current = { value: initial };
        }
        return ref.current;
    };
    const useDerivedValue = <T,>(factory: () => T): ReanimatedSharedValue<T> => {
        const ref = React.useRef<ReanimatedSharedValue<T> | null>(null);
        const value = factory();
        if (!ref.current) {
            ref.current = { value };
        } else {
            ref.current.value = value;
        }
        return ref.current;
    };
    const runOnJS = <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) => fn;
    const runOnUI = <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) => fn;

    // Reanimated's animated ref is a callback ref that also exposes `.current`, so production
    // code can hand it to both a component's `ref` prop and `measure(...)`.
    const useAnimatedRef = <T,>(): ReanimatedAnimatedRef<T> => {
        const ref = React.useRef<ReanimatedAnimatedRef<T> | null>(null);
        if (!ref.current) {
            const animatedRef: ReanimatedAnimatedRef<T> = Object.assign(
                (component?: T | null) => {
                    animatedRef.current = component ?? null;
                },
                { current: null as T | null },
            );
            ref.current = animatedRef;
        }
        return ref.current;
    };

    // The real `measure` reads the native shadow tree from the UI thread and returns `null`
    // whenever the view has not been laid out. Node tests never lay anything out, so `null` is
    // the honest answer here — call sites already branch on it.
    const measure = (): null => null;

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

    // Mirrors the real `ReduceMotion` string enum. Production code stamps this value on every
    // spring config (see `components/ui/motion/motionSprings.ts`), so a mock without it turns a
    // policy assertion into a `TypeError` at module scope.
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
        // Layout-animation builders. `AgentActivityList` reads these at module scope, so a module
        // without them is not a missing assertion but an import-time crash.
        FadeIn: createLayoutAnimationBuilderMock('FadeIn'),
        LinearTransition: createLayoutAnimationBuilderMock('LinearTransition'),
        ReduceMotion,
        interpolate,
        interpolateColor,
        cancelAnimation: () => {},
        measure,
        runOnJS,
        runOnUI,
        useAnimatedProps: <T,>(factory: () => T): T => factory(),
        useAnimatedRef,
        useAnimatedReaction: (prepare: () => unknown, react: (value: unknown, previous: unknown) => void) => {
            try {
                react(prepare(), undefined);
            } catch {
                // Native Reanimated swallows worklet-environment details that are unavailable in node tests.
            }
        },
        useAnimatedStyle: <T,>(factory: () => T): T => factory(),
        useDerivedValue,
        useSharedValue,
        withDelay: <T,>(_delayMs: number, animation: T): T => animation,
        withRepeat: <T,>(value: T): T => value,
        withSpring: <T,>(value: T): T => value,
        withTiming: <T,>(value: T, config?: ReanimatedTimingConfig): T => {
            assertEasingIsWorkletLike(config?.easing);
            return value;
        },
    };
}
