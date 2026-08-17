import type { PluginUiPlatform, PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';

/** Semantic theme facts presentation may consume without importing host transport. */
export type HappierUiTheme = PluginUiThemeV1;

/**
 * The `HappierUiEnvironment` seam (§3.10.1).
 *
 * Shared presentation components consume environment FACTS; they never import
 * the owners that produce them. Happier core supplies them from Unistyles, the
 * app stores and the app's platform owners; a mounted plugin surface supplies
 * the same real facts projected through `PluginUiHostApi.context()`.
 *
 * **Why this is several capability objects and not one context.** §3.10.1
 * forbids a single volatile context carrying theme + insets + keyboard + motion:
 * a safe-area or keyboard change would rerender every shared component in the
 * tree. Each capability below is its own React context with its own identity, so
 * a component that reads only typography does not rerender when the keyboard
 * opens.
 *
 * **Deliberately absent, not silently stubbed.** `overlays`, `focus`, `escape`
 * and `keyboard` are named by §3.10.1 and are NOT declared here yet. Their only
 * consumers are the overlay families (EU-7d), and their real owners
 * (`apps/ui/sources/modal/portal/**`, `sources/keyboard/escape.ts`,
 * `focusReturn.tsx`, `sources/components/ui/keyboardAvoidance/**`) each need the
 * portable-mechanism / platform-adapter / app-policy decomposition §3.10.1
 * requires. Declaring them now with no-op defaults would be exactly the silent
 * substitution UI-T26 forbids, so they land with the components that use them.
 */
export type HappierUiEnvironment = Readonly<{
  theme: PluginUiThemeV1;
  localization: HappierUiLocalization;
  accessibility: HappierUiAccessibility;
  platform: HappierUiPlatformFacts;
  insets: HappierUiInsets;
}>;

export type HappierUiTextDirection = 'ltr' | 'rtl';

export type HappierUiLocalization = Readonly<{
  locale: string;
  direction: HappierUiTextDirection;
  /**
   * Resolve a declared author translation key or a host-reserved framework key.
   *
   * A key that is neither declared nor host-reserved resolves to `fallback` —
   * never to the raw key — so a missing translation degrades to author-supplied
   * text instead of rendering `plugin.some.key` at the user.
   */
  translate: (key: string, fallback?: string) => string;
}>;

/**
 * Resolved accessibility facts.
 *
 * `reducedMotion` lives here rather than in a separate motion capability: two
 * owners for one boolean is a split-brain, and every consumer that animates also
 * reads contrast or text scale. Motion-specific behaviour that needs more than
 * this flag arrives with the component that needs it.
 */
export type HappierUiAccessibility = Readonly<{
  /** The user's resolved UI text scale. `1` means unscaled. */
  textScale: number;
  reducedMotion: boolean;
  screenReaderEnabled: boolean;
  contrast: 'normal' | 'high';
}>;

export type HappierUiPlatformFacts = Readonly<{
  platform: PluginUiPlatform;
  colorScheme: 'light' | 'dark';
}>;

export type HappierUiEdgeInsets = Readonly<{
  top: number;
  right: number;
  bottom: number;
  left: number;
}>;

export type HappierUiInsets = Readonly<{
  safeArea: HappierUiEdgeInsets;
}>;
