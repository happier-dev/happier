import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';

import type {
  HappierUiAccessibility,
  HappierUiEnvironment,
  HappierUiInsets,
  HappierUiLocalization,
  HappierUiPlatformFacts,
} from './types.js';

/**
 * One context per capability (§3.10.1). Splitting them is the whole point: a
 * safe-area change must not rerender everything that reads typography.
 *
 * Every context defaults to `null` rather than to a fabricated value. A
 * component that genuinely needs a capability fails loudly through
 * {@link requireEnvironmentCapability}; a component that can render without one
 * reads the optional accessor and says so in its own contract. Neither silently
 * substitutes a reduced experience (UI-T26).
 */
const HappierUiThemeContext = createContext<PluginUiThemeV1 | null>(null);
const HappierUiLocalizationContext = createContext<HappierUiLocalization | null>(null);
const HappierUiAccessibilityContext = createContext<HappierUiAccessibility | null>(null);
const HappierUiPlatformContext = createContext<HappierUiPlatformFacts | null>(null);
const HappierUiInsetsContext = createContext<HappierUiInsets | null>(null);

export type HappierUiEnvironmentProviderProps = Readonly<{
  environment: HappierUiEnvironment;
  children?: ReactNode;
}>;

/**
 * Supply only the platform capability when a host already owns the other
 * environment facts. Happier core uses this at its application root; mounted
 * plugin surfaces install the complete environment below it, so their exact
 * artifact platform continues to shadow the host-wide fact.
 */
export type HappierUiPlatformProviderProps = Readonly<{
  platform: HappierUiPlatformFacts;
  children?: ReactNode;
}>;

function requireEnvironmentCapability<T>(value: T | null, capability: string): T {
  if (value === null) {
    throw new Error(
      `Happier UI ${capability} is unavailable: this subtree is not wrapped in a Happier UI environment. `
      + 'A mounted plugin surface receives one from PluginUiProvider; Happier core installs one at its root.',
    );
  }
  return value;
}

/**
 * High contrast is a resolved host preference, not a second palette. Shared
 * boundaries borrow the host's primary text token, whose contrast relationship
 * with the active surface is already owned by the app theme. Control fills use
 * the stronger existing border token so inactive controls remain distinct
 * before focus without introducing component-local contrast policy.
 */
export function resolveHappierUiPresentationTheme(
  theme: PluginUiThemeV1,
  contrast: HappierUiAccessibility['contrast'],
): PluginUiThemeV1 {
  if (contrast !== 'high') return theme;
  return Object.freeze({
    ...theme,
    colors: Object.freeze({
      ...theme.colors,
      border: theme.colors.text,
      focus: theme.colors.text,
      control: theme.colors.border,
    }),
  });
}

export function HappierUiPlatformProvider({
  platform,
  children,
}: HappierUiPlatformProviderProps) {
  const platformValue = useMemo(
    () => platform,
    [platform.platform, platform.colorScheme],
  );

  return (
    <HappierUiPlatformContext.Provider value={platformValue}>
      {children}
    </HappierUiPlatformContext.Provider>
  );
}

/**
 * Install the environment.
 *
 * Each nested value is memoized on its own fields, so replacing the environment
 * object — which the plugin host does on every context push — only changes the
 * identity of the capabilities that actually changed.
 */
export function HappierUiEnvironmentProvider({
  environment,
  children,
}: HappierUiEnvironmentProviderProps) {
  const { theme, localization, accessibility, platform, insets } = environment;

  const themeValue = useMemo(
    () => resolveHappierUiPresentationTheme(theme, accessibility.contrast),
    [theme, accessibility.contrast],
  );

  const localizationValue = useMemo(
    () => localization,
    [localization.locale, localization.direction, localization.translate],
  );
  const accessibilityValue = useMemo(
    () => accessibility,
    [
      accessibility.textScale,
      accessibility.reducedMotion,
      accessibility.screenReaderEnabled,
      accessibility.contrast,
    ],
  );
  const insetsValue = useMemo(
    () => insets,
    [insets.safeArea.top, insets.safeArea.right, insets.safeArea.bottom, insets.safeArea.left],
  );

  return (
    <HappierUiThemeContext.Provider value={themeValue}>
      <HappierUiLocalizationContext.Provider value={localizationValue}>
        <HappierUiAccessibilityContext.Provider value={accessibilityValue}>
          <HappierUiPlatformProvider platform={platform}>
            <HappierUiInsetsContext.Provider value={insetsValue}>
              {children}
            </HappierUiInsetsContext.Provider>
          </HappierUiPlatformProvider>
        </HappierUiAccessibilityContext.Provider>
      </HappierUiLocalizationContext.Provider>
    </HappierUiThemeContext.Provider>
  );
}

export function useHappierUiTheme(): PluginUiThemeV1 {
  return requireEnvironmentCapability(useContext(HappierUiThemeContext), 'theme');
}

export function useOptionalHappierUiTheme(): PluginUiThemeV1 | null {
  return useContext(HappierUiThemeContext);
}

export function useHappierUiLocalization(): HappierUiLocalization {
  return requireEnvironmentCapability(useContext(HappierUiLocalizationContext), 'localization');
}

export function useOptionalHappierUiLocalization(): HappierUiLocalization | null {
  return useContext(HappierUiLocalizationContext);
}

export function useHappierUiAccessibility(): HappierUiAccessibility {
  return requireEnvironmentCapability(useContext(HappierUiAccessibilityContext), 'accessibility');
}

/**
 * Read accessibility facts when the caller can proceed without them.
 *
 * Happier core injects its own resolved values directly at the adapter (the
 * `uiFontScale` local setting is app-domain state, §3.10.2), so a core mount is
 * legitimately environment-free for text scaling. This accessor exists for that
 * case and no other.
 */
export function useOptionalHappierUiAccessibility(): HappierUiAccessibility | null {
  return useContext(HappierUiAccessibilityContext);
}

export function useHappierUiPlatform(): HappierUiPlatformFacts {
  return requireEnvironmentCapability(useContext(HappierUiPlatformContext), 'platform');
}

/**
 * Read the mounted platform fact when a shared primitive can preserve its core
 * adapter behavior without one. The primitive must not fabricate a platform
 * when the environment is absent.
 */
export function useOptionalHappierUiPlatform(): HappierUiPlatformFacts | null {
  return useContext(HappierUiPlatformContext);
}

export function useHappierUiInsets(): HappierUiInsets {
  return requireEnvironmentCapability(useContext(HappierUiInsetsContext), 'insets');
}
