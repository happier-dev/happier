import * as React from 'react';
import { vi } from 'vitest';

import {
    createReactNativeAppStateEmitter,
    createReactNativeNativeRuntime,
    createReactNativeWebRuntime,
    installReactNativeWebRuntime,
    type TestReactNativeAppStateStatus,
    type TestReactNativeNativePlatformOS,
    type TestReactNativeRuntimeOverrides,
    type TestReactNativeStubLoader,
} from '../runtime/reactNativeRuntime';

export type TestReactNativeOverrides = TestReactNativeRuntimeOverrides;
export type { TestReactNativeAppStateStatus };
export type TestReactNativeNativeMockPlatformOS = TestReactNativeNativePlatformOS;

type TestReactNativeHostProps = Record<string, unknown> & Readonly<{
    children?: React.ReactNode;
}>;

export { createReactNativeAppStateEmitter };
// `react-native` aliases this stub in Vitest. A normal import while its async
// mock is resolving can await that same mock; only the framework adapter owns
// bypassing it, while reusable runtime factories stay framework-independent.
const loadReactNativeStub: TestReactNativeStubLoader = () => vi.importActual<typeof import('../../reactNativeStub')>('@/dev/reactNativeStub');

export function createReactNativeWebMock(overrides?: TestReactNativeOverrides) {
    return createReactNativeWebRuntime(overrides, loadReactNativeStub);
}

export function installReactNativeWebMock(overrides?: TestReactNativeOverrides) {
    return installReactNativeWebRuntime(overrides, loadReactNativeStub);
}

export function createReactNativeNativeMock(
    options: Readonly<{ platformOS: TestReactNativeNativeMockPlatformOS }>,
    overrides?: TestReactNativeOverrides,
) {
    return createReactNativeNativeRuntime(options, overrides, loadReactNativeStub);
}

/**
 * A focused host Pressable for the small set of renderer tests that exercise
 * programmatic focus return through a React Native ref.
 */
export function createFocusablePressableMock(
    onFocus: () => void,
    onFocusTarget?: (props: TestReactNativeHostProps) => void,
) {
    return React.forwardRef<{ focus: () => void }, TestReactNativeHostProps>(
        function FocusablePressable(props, ref) {
            React.useImperativeHandle(ref, () => ({
                focus: onFocusTarget
                    ? () => { onFocusTarget(props); onFocus(); }
                    : onFocus,
            }), [onFocus, onFocusTarget, props]);
            return React.createElement('Pressable', props);
        },
    );
}

/** A focused host TextInput for renderer tests that verify field-error focus. */
export function createFocusableTextInputMock(
    onFocus: () => void,
    onFocusTarget?: (props: TestReactNativeHostProps) => void,
    options: Readonly<{
        onBlur?: () => void;
        onSetNativeProps?: (props: Record<string, unknown>) => void;
    }> = {},
) {
    return React.forwardRef<{
        focus: () => void;
        blur: () => void;
        isFocused: () => boolean;
        setNativeProps: (props: Record<string, unknown>) => void;
    }, TestReactNativeHostProps>(
        function FocusableTextInput(props, ref) {
            const focused = React.useRef(false);
            React.useImperativeHandle(ref, () => ({
                focus: () => {
                    focused.current = true;
                    onFocusTarget?.(props);
                    onFocus();
                },
                blur: () => {
                    focused.current = false;
                    options.onBlur?.();
                },
                isFocused: () => focused.current,
                setNativeProps: (nativeProps) => options.onSetNativeProps?.(nativeProps),
            }), [onFocus, onFocusTarget, options.onBlur, options.onSetNativeProps, props]);
            return React.createElement('TextInput', props);
        },
    );
}
