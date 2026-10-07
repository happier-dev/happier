import type { PluginUiPlatform, PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';
import type { HappierRaisedEdge } from '../presentation/layout/raisedEdge.js';
import type { HappierPortableStyle } from '../presentation/portableTypes.js';

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

/**
 * The type roles a same-realm host renders plugin and shared text with.
 *
 * `PluginUiThemeV1.typography` is the versioned public snapshot (and the only
 * one a hosted-web frame in its own realm can receive); it carries size, line
 * height and weight for five roles. A same-realm host can say more: the real
 * role style objects its own screens use — family, tracking, tabular figures —
 * and a `heading` step above `title`. When a host installs these facts every
 * shared text owner reads them; without them the snapshot's metrics apply, so
 * the two never disagree on size (the host projects both from one role table).
 */
export type HappierTypeRole = 'heading' | 'title' | 'label' | 'body' | 'reading' | 'caption';

export type HappierTypeRoleStyle = Readonly<{
  fontSize: number;
  lineHeight: number;
  fontWeight?: string;
  fontFamily?: string;
  letterSpacing?: number;
  fontVariant?: readonly 'tabular-nums'[];
}>;

/** The font face a same-realm host draws one weight with (a family that encodes it, or a numeric weight). */
export type HappierFontFace = Readonly<{
  fontFamily?: string;
  fontWeight?: string;
}>;

export type HappierUiTypography = Readonly<Record<HappierTypeRole, HappierTypeRoleStyle>> & Readonly<{
  /**
   * The face for each weight the configuration-page anatomy uses
   * (`HAPPIER_PAGE_TEXT`), so a plugin page title, section title and row title
   * draw in the host's exact family. Absent, a numeric weight applies.
   */
  weights?: Readonly<Record<'regular' | 'medium' | 'semiBold' | 'bold', HappierFontFace>>;
}>;

/**
 * The colour roles of Happier's configuration-page anatomy (page header,
 * section sheets, rows, field boxes, switches, segmented choices and visual
 * tiles).
 *
 * Like {@link HappierUiTypography} this is a same-realm host fact, never wire:
 * `PluginUiThemeV1` is a versioned public snapshot and carries no sheet tint,
 * row seam, switch or field-box roles. A host that installs these renders a
 * plugin page in exactly its own colours; without them each role resolves from
 * the snapshot (`resolveHappierUiPalette`), so a hosted-web frame still draws
 * the same anatomy in its theme's nearest roles.
 */
export type HappierUiPalette = Readonly<{
  /** A configuration page's ground (the paper the sheets sit on). */
  page: string;
  /** A page section's sheet and its hairline edge. */
  sheet: string;
  sheetBorder: string;
  /** The full-width hairline between the rows of a sheet. */
  rowDivider: string;
  /**
   * The separator between groups of a sheet's rows (`HappierPageSheetGroup`): content width and
   * lighter than `rowDivider`, so a group edge reads as a pause inside the section, not an edge.
   */
  groupDivider: string;
  /** The outline of a field box, an unselected tile and other bordered controls. */
  controlBorder: string;
  /**
   * The raised edge (and its lift) a field box stands on, resolved by the host from `controlBorder`'s
   * raised colour and its colour scheme (`resolveHappierRaisedEdge`). Absent, field boxes draw flat.
   */
  controlEdge?: HappierRaisedEdge;
  /** The inside of a field box (a page select trigger or text field). */
  fieldBackground: string;
  /** The placeholder / "Choose…" text of an empty field box. */
  placeholder: string;
  /** The light top line of a primary (accent-filled) button, resolved by the host; absent, it draws flat. */
  accentGloss?: HappierRaisedEdge;
  /** The ring or fill that marks the chosen tile. */
  selection: string;
  switchTrackOn: string;
  switchTrackOff: string;
  switchThumb: string;
  /** A segmented control's track and its selected segment. */
  segmentTrack: string;
  segmentThumb: string;
  /** The low elevation the chosen segment stands on; absent, it sits flat. */
  segmentThumbLift?: HappierPortableStyle;
  /**
   * A navigation column's open row (the plane's selected chip) and a row under the pointer. The
   * column's plane itself is the host's (`appShellColumnSurface`); a column never paints its own.
   */
  navigationSelected: string;
  navigationHover: string;
  /**
   * The host's quiet inset surface, a hair off the page: a dense collection's group band and the
   * retained-content freshness line.
   */
  inset?: string;
  /** Same-realm compact search radius; unhosted search uses its public theme's control radius. */
  searchFieldRadiusPx?: number;
  /** The raised edge of the compact search field (drawn on `sheetBorder`); absent, it draws flat. */
  searchFieldEdge?: HappierRaisedEdge;
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
