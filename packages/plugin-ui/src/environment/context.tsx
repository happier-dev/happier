import { createContext, useContext, useMemo, type Context, type ReactNode } from 'react';
import type { PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';

import type {
  HappierUiAccessibility,
  HappierUiEnvironment,
  HappierUiInsets,
  HappierUiLocalization,
  HappierUiPalette,
  HappierUiPlatformFacts,
  HappierUiTypography,
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
const HappierUiTypographyContext = createContext<HappierUiTypography | null>(null);
const HappierUiPaletteContext = createContext<HappierUiPalette | null>(null);
const HappierUiAnimationActivityContext = createContext(true);

/** @internal The surface bridge re-provides this across the host's details pane (`components/surfaceBridge.tsx`). */
export const HAPPIER_UI_ENVIRONMENT_CONTEXTS_INTERNAL: readonly Context<unknown>[] = [
  HappierUiThemeContext,
  HappierUiLocalizationContext,
  HappierUiAccessibilityContext,
  HappierUiPlatformContext,
  HappierUiInsetsContext,
  HappierUiTypographyContext,
  HappierUiPaletteContext,
  HappierUiAnimationActivityContext,
] as readonly Context<unknown>[];

/**
 * Private presentation projection, independent of Resource and author work
 * lifetimes. A retained surface or panel may narrow its parent's activity but
 * cannot reactivate motion while its enclosing presentation is inactive.
 */
export function HappierUiAnimationActivityProviderInternal({
  active,
  children,
}: Readonly<{ active: boolean; children?: ReactNode }>) {
  const parentActive = useContext(HappierUiAnimationActivityContext);
  return (
    <HappierUiAnimationActivityContext.Provider value={parentActive && active}>
      {children}
    </HappierUiAnimationActivityContext.Provider>
  );
}

/** Environment-free core adapters inject their own activity explicitly. */
export function useHappierUiAnimationActivityInternal(): boolean {
  return useContext(HappierUiAnimationActivityContext);
}

export type HappierUiEnvironmentProviderProps = Readonly<{
  environment: HappierUiEnvironment;
  children?: ReactNode;
}>;

/** Host-private presentation projection; not part of the author environment ABI. */
type HappierUiEnvironmentProviderInternalProps = HappierUiEnvironmentProviderProps & Readonly<{
  presentationActive?: boolean;
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
export function HappierUiEnvironmentProvider(props: HappierUiEnvironmentProviderProps) {
  const { environment, children } = props;
  const { presentationActive = true } = props as HappierUiEnvironmentProviderInternalProps;
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
    <HappierUiAnimationActivityProviderInternal active={presentationActive}>
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
    </HappierUiAnimationActivityProviderInternal>
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

/**
 * Install a same-realm host's real type-role styles (see {@link HappierUiTypography}).
 *
 * Its own capability context, so text that reads typography never rerenders on
 * an unrelated environment change. The value is expected to be module-stable.
 */
export function HappierUiTypographyProvider({
  typography,
  children,
}: Readonly<{ typography: HappierUiTypography; children?: ReactNode }>) {
  return (
    <HappierUiTypographyContext.Provider value={typography}>
      {children}
    </HappierUiTypographyContext.Provider>
  );
}

export function useOptionalHappierUiTypography(): HappierUiTypography | null {
  return useContext(HappierUiTypographyContext);
}

/**
 * Install a same-realm host's configuration-page colour roles (see
 * {@link HappierUiPalette}). Its own capability context, like typography; the
 * host supplies a new value only when its theme changes.
 */
export function HappierUiPaletteProvider({
  palette,
  children,
}: Readonly<{ palette: HappierUiPalette; children?: ReactNode }>) {
  return (
    <HappierUiPaletteContext.Provider value={palette}>
      {children}
    </HappierUiPaletteContext.Provider>
  );
}

/**
 * Each page-anatomy colour role from the public theme snapshot: the nearest
 * snapshot role, so a realm without host facts (a hosted-web frame, the author
 * test fixture) draws the same anatomy in its own theme.
 */
export function resolveHappierUiPalette(theme: PluginUiThemeV1): HappierUiPalette {
  const colors = theme.colors;
  return {
    page: colors.surface,
    sheet: colors.surface,
    sheetBorder: colors.divider,
    rowDivider: colors.divider,
    // The snapshot has one hairline role; the group separator's lighter weight is a host fact.
    groupDivider: colors.divider,
    controlBorder: colors.divider,
    fieldBackground: colors.surface,
    placeholder: colors.mutedText,
    // Selection is ink (DESIGN.md: colour means state): a host that projects no palette of its own
    // still draws chosen tiles, rings and radio marks in the text colour, never the accent.
    selection: colors.text,
    switchTrackOn: colors.accent,
    switchTrackOff: colors.control,
    switchThumb: colors.onAccent,
    segmentTrack: colors.control,
    segmentThumb: colors.surface,
    navigationSelected: colors.elevatedSurface,
    navigationHover: colors.control,
  };
}

const snapshotPalettes = new WeakMap<PluginUiThemeV1, HappierUiPalette>();

function snapshotPalette(theme: PluginUiThemeV1): HappierUiPalette {
  const existing = snapshotPalettes.get(theme);
  if (existing) return existing;
  const palette = Object.freeze(resolveHappierUiPalette(theme));
  snapshotPalettes.set(theme, palette);
  return palette;
}

/**
 * The page-anatomy colours for a shared component: the host's installed roles,
 * else the ones resolved from `theme` (the caller's explicit theme, or the
 * environment's). `null` only when neither exists — a core adapter always passes
 * its own colours instead.
 */
export function useOptionalHappierUiPalette(theme?: PluginUiThemeV1 | null): HappierUiPalette | null {
  const installed = useContext(HappierUiPaletteContext);
  const environmentTheme = useContext(HappierUiThemeContext);
  if (installed) return installed;
  const resolvedTheme = theme ?? environmentTheme;
  return resolvedTheme ? snapshotPalette(resolvedTheme) : null;
}
