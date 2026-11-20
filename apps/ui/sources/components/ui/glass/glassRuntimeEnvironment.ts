import * as React from 'react';
import type { GlassAtmosphereTone, GlassMaterialEnvironment } from './glassMaterial';
import { retainIfEqual } from '@/sync/domains/state/structuralSharing';

const DEFAULT_ENVIRONMENT: GlassMaterialEnvironment = Object.freeze({});
const GlassRuntimeEnvironment = React.createContext<GlassMaterialEnvironment>(DEFAULT_ENVIRONMENT);
/**
 * A retained destination's own environment (`GlassEnvironmentHold`). Its readers never subscribe to the
 * window's: React propagates a provider's change to every reader below it, past a nested provider of the
 * same context, so a held subtree re-rendered whenever the window's backing moved.
 */
const GlassScopedEnvironment = React.createContext<GlassMaterialEnvironment | null>(null);

const GlassReduceTransparency = React.createContext(false);

/** Project the effective host preference once, including the native window accessibility input. */
export function GlassRuntimeEnvironmentProvider(props: React.ProviderProps<GlassMaterialEnvironment>) {
    return React.createElement(GlassReduceTransparency.Provider, { value: props.value.reduceTransparency === true },
        React.createElement(GlassRuntimeEnvironment.Provider, { value: props.value },
            React.createElement(GlassScopedEnvironment.Provider, { value: null }, props.children)));
}
type AtmosphereBehind = NonNullable<GlassMaterialEnvironment['atmosphereBehind']>;
const GlassAtmosphereBehindSetter = React.createContext<(value: AtmosphereBehind) => void>(() => {});
export const GlassAtmosphereBehindSetterProvider = GlassAtmosphereBehindSetter.Provider;

/** The one shell atmosphere layer sets its covered layout and clears it on unmount. */
export function useSetGlassAtmosphereBehind() {
    return React.useContext(GlassAtmosphereBehindSetter);
}

/**
 * A retained destination's glass keeps the environment it was last presented in. The window's backing
 * follows whichever destination is on screen, so a hidden one has nothing to repaint; shown again over
 * its own atmosphere, it keeps its backing while the window has none yet (the tab it replaced had none,
 * or the layer is still painting it) instead of repainting for that gap. Everything else follows live,
 * and an equal environment keeps the one already published.
 */
export function GlassEnvironmentHold(props: Readonly<{ presented: boolean; carriesAtmosphere: boolean; children: React.ReactNode }>) {
    const live = React.useContext(GlassRuntimeEnvironment);
    const published = React.useRef<GlassMaterialEnvironment | null>(null);
    const held = published.current;
    const next = held === null ? live
        : !props.presented ? held
        : props.carriesAtmosphere && (live.atmosphereBehind ?? 'none') === 'none'
            ? { ...live, atmosphereBehind: held.atmosphereBehind, atmosphereTone: held.atmosphereTone }
        : live;
    published.current = retainIfEqual(held ?? undefined, next);
    return React.createElement(GlassScopedEnvironment.Provider, { value: published.current }, props.children);
}

/**
 * An atmosphere drawn inside one subtree rather than behind the window (the signed-out planet and field under the
 * welcome column): Elements in that subtree stand on it, so they take their glass there, while the window's page,
 * chrome and native backing stay exactly as the window decides. Reduce Transparency and every other input stay live.
 */
export function GlassAtmosphereScope(props: Readonly<{ behind: AtmosphereBehind; children: React.ReactNode }>) {
    const live = useGlassRuntimeEnvironment();
    const scoped = React.useMemo(() => ({ ...live, atmosphereBehind: props.behind }), [live, props.behind]);
    return React.createElement(GlassAtmosphereScoped.Provider, { value: true },
        React.createElement(GlassScopedEnvironment.Provider, { value: scoped }, props.children));
}

const GlassAtmosphereScoped = React.createContext(false);

/**
 * Inside a `GlassAtmosphereScope` the document's material variables describe the window, not this subtree: a surface
 * there publishes its own group's values on its root for its paint and its descendants.
 */
export function useGlassAtmosphereScoped(): boolean {
    return React.useContext(GlassAtmosphereScoped);
}

const GlassAtmosphereToneSetter = React.createContext<(value: GlassAtmosphereTone | undefined) => void>(() => {});
export const GlassAtmosphereToneSetterProvider = GlassAtmosphereToneSetter.Provider;

/** The same layer publishes the measured tone of the picture it draws, and clears it with its cover. */
export function useSetGlassAtmosphereTone() {
    return React.useContext(GlassAtmosphereToneSetter);
}

/** Lightweight presentation input; subscribing does not import the runtime driver. */
export function useGlassRuntimeEnvironment(): GlassMaterialEnvironment {
    // Conditional on purpose: inside a held destination the window's environment is never read.
    return React.use(GlassScopedEnvironment) ?? React.use(GlassRuntimeEnvironment);
}

/** Atmosphere readers consume only the effective host transparency preference. */
export function useGlassReduceTransparency(): boolean {
    return React.useContext(GlassReduceTransparency);
}
