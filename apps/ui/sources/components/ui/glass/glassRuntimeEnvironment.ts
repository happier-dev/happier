import * as React from 'react';
import type { GlassMaterialEnvironment } from './glassMaterial';

const DEFAULT_ENVIRONMENT: GlassMaterialEnvironment = Object.freeze({});
const GlassRuntimeEnvironment = React.createContext<GlassMaterialEnvironment>(DEFAULT_ENVIRONMENT);

export const GlassRuntimeEnvironmentProvider = GlassRuntimeEnvironment.Provider;

/** Lightweight presentation input; subscribing does not import the runtime driver. */
export function useGlassRuntimeEnvironment(): GlassMaterialEnvironment {
    return React.useContext(GlassRuntimeEnvironment);
}
