import type { LayoutChangeEvent, LayoutRectangle, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

export type NativeGeometryEventFixtureOptions = Readonly<{
    target?: NativeSyntheticEvent<unknown>['target'];
    currentTarget?: NativeSyntheticEvent<unknown>['currentTarget'];
}>;

/** Geometry-only native OS boundary; a host must be supplied before its handle is read. */
function createNativeGeometryEvent<Payload>(
    type: string,
    nativeEvent: Payload,
    options: NativeGeometryEventFixtureOptions,
): NativeSyntheticEvent<Payload> {
    let defaultPrevented = false;
    let propagationStopped = false;
    return {
        nativeEvent,
        get target() {
            if (!options.target) {
                throw new Error('Native geometry event fixture is missing a native host: supply options.target before reading target');
            }
            return options.target;
        },
        get currentTarget() {
            const host = options.currentTarget ?? options.target;
            if (!host) {
                throw new Error('Native geometry event fixture is missing a native host: supply options.currentTarget or options.target before reading currentTarget');
            }
            return host;
        },
        bubbles: false,
        cancelable: true,
        get defaultPrevented() { return defaultPrevented; },
        eventPhase: 2,
        isTrusted: true,
        timeStamp: 0,
        type,
        preventDefault: () => { defaultPrevented = true; },
        isDefaultPrevented: () => defaultPrevented,
        stopPropagation: () => { propagationStopped = true; },
        isPropagationStopped: () => propagationStopped,
        persist: () => undefined,
    };
}

export function createLayoutChangeEvent(
    layout: LayoutRectangle,
    options: NativeGeometryEventFixtureOptions = {},
): LayoutChangeEvent {
    return createNativeGeometryEvent('layout', { layout }, options);
}

export function createNativeScrollEvent(
    nativeEvent: NativeScrollEvent,
    options: NativeGeometryEventFixtureOptions = {},
): NativeSyntheticEvent<NativeScrollEvent> {
    return createNativeGeometryEvent('scroll', nativeEvent, options);
}
