import { createContext, createElement, useContext, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { THEME_SURFACE_REGISTRY, type SurfaceAddress, type SurfaceId, type ThemeSurfaceState } from '@happier-dev/plugin-sdk/ui';

import { useOptionalHappierUiPlatform, useOptionalHappierUiTheme } from '../environment/context.js';
import { resolveHappierThemeSurfaceStyle } from './themeSurface.js';

export type ThemeSurfaceStateFacts = Readonly<{
  disabled?: boolean;
  selected?: boolean;
  checked?: boolean;
  expanded?: boolean;
}>;

// Precedence is shared; applicable states remain owned by each registry entry.
const STATE_PRIORITY = ['disabled', 'selected', 'checked', 'expanded'] as const satisfies readonly (keyof ThemeSurfaceStateFacts)[];

export function resolveThemeSurfaceState<S extends SurfaceId>(surface: S, facts: ThemeSurfaceStateFacts): ThemeSurfaceState<S> {
  const supported: readonly string[] = THEME_SURFACE_REGISTRY[surface].states;
  const state = STATE_PRIORITY.find(candidate => facts[candidate] === true && supported.includes(candidate));
  return (state ?? 'default') as ThemeSurfaceState<S>;
}

export function resolveThemeSurfaceAddress<A extends SurfaceAddress>(
  address: A,
  facts: ThemeSurfaceStateFacts,
): Extract<SurfaceAddress, { surface: A['surface'] }> {
  const semantic = address.state === undefined ? facts : { ...facts, [address.state]: true };
  return { ...address, state: resolveThemeSurfaceState(address.surface, semantic) } as Extract<SurfaceAddress, { surface: A['surface'] }>;
}

const ThemeSurfaceOverridesContext = createContext(true);

/** Recovery surfaces retain ordinary theme tokens while ignoring native surface overrides. */
export function HappierThemeSurfaceScope(props: Readonly<{ enabled: boolean; children?: ReactNode }>) {
  const parentEnabled = useContext(ThemeSurfaceOverridesContext);
  return createElement(ThemeSurfaceOverridesContext.Provider, { value: parentEnabled && props.enabled }, props.children);
}

export function useHappierThemeSurfaceOverridesEnabled(): boolean {
  const enabled = useContext(ThemeSurfaceOverridesContext);
  return Platform.OS === 'web' || enabled;
}

/** Shared controls consume the host's compiled table; this binding never parses or owns theme state. */
export function useThemeSurfaceBinder() {
  const theme = useOptionalHappierUiTheme();
  const platform = useOptionalHappierUiPlatform();
  const enabled = useHappierThemeSurfaceOverridesEnabled();
  return (address?: SurfaceAddress) => ({
    dataSet: address === undefined ? undefined : { surface: address.surface, part: address.part, state: address.state ?? 'default' },
    style: address === undefined || !enabled ? undefined : resolveHappierThemeSurfaceStyle(theme, address, platform?.platform === 'desktop' ? 'web' : platform?.platform ?? Platform.OS),
  });
}

export function useThemeSurfaceBinding(address?: SurfaceAddress) {
  return useThemeSurfaceBinder()(address);
}
