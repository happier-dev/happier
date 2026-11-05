import * as React from 'react';
import type { GlassAtmosphereTone, GlassMaterialEnvironment } from './glassMaterial';

const DEFAULT_ENVIRONMENT: GlassMaterialEnvironment = Object.freeze({});
const GlassRuntimeEnvironment = React.createContext<GlassMaterialEnvironment>(DEFAULT_ENVIRONMENT);

const GlassReduceTransparency = React.createContext(false);

/** Project the effective host preference once, including the native window accessibility input. */
export function GlassRuntimeEnvironmentProvider(props: React.ProviderProps<GlassMaterialEnvironment>) {
    return React.createElement(GlassReduceTransparency.Provider, { value: props.value.reduceTransparency === true },
        React.createElement(GlassRuntimeEnvironment.Provider, { value: props.value }, props.children));
}
type AtmosphereBehind = NonNullable<GlassMaterialEnvironment['atmosphereBehind']>;
const GlassAtmosphereBehindSetter = React.createContext<(value: AtmosphereBehind) => void>(() => {});
export const GlassAtmosphereBehindSetterProvider = GlassAtmosphereBehindSetter.Provider;

/** The one shell atmosphere layer sets its covered layout and clears it on unmount. */
export function useSetGlassAtmosphereBehind() {
    return React.useContext(GlassAtmosphereBehindSetter);
}

const GlassAtmosphereToneSetter = React.createContext<(value: GlassAtmosphereTone | undefined) => void>(() => {});
export const GlassAtmosphereToneSetterProvider = GlassAtmosphereToneSetter.Provider;

/** The same layer publishes the measured tone of the picture it draws, and clears it with its cover. */
export function useSetGlassAtmosphereTone() {
    return React.useContext(GlassAtmosphereToneSetter);
}

/** Lightweight presentation input; subscribing does not import the runtime driver. */
export function useGlassRuntimeEnvironment(): GlassMaterialEnvironment {
    return React.useContext(GlassRuntimeEnvironment);
}

/** Atmosphere readers consume only the effective host transparency preference. */
export function useGlassReduceTransparency(): boolean {
    return React.useContext(GlassReduceTransparency);
}
