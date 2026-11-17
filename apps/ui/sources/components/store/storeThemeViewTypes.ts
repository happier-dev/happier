import type { HostCatalogMark } from '@/components/ui/media/HappierBrandMark';
import type {
  ThemeMiniatureData,
  ThemeProfileMode,
} from '@/theme/profiles/themeProfileTypes';

/**
 * Presentation seams of Store → Themes (plan-6 §7 U3, lab C1–C3 with findings 3, 7, 8, 13). The Store
 * logic (FLOW-STORE) projects the registry `theme` kind, the opened listing and the shared try-on owner into
 * these props; the views own composition, copy and motion only. No query store, source registry or try
 * state lives here.
 */

/** One browse card: catalog and plugin listings carry their faces' miniatures; Open VSX shows its icon until opened. */
export type StoreThemeCardView = Readonly<{
  key: string;
  name: string;
  /** Publisher, then source ("mira.sato · Happier catalog"); ellipsized on the card, whole in the listing. */
  byline: string;
  /** Which modes it covers and whether it reshapes, e.g. "Light and dark · Reshapes layout". */
  summary: string;
  /** The faces' miniatures when known without opening (catalog, plugin); empty for Open VSX until opened. */
  faces: readonly ThemeMiniatureData[];
  /** Exact browse version, reused by near-viewport and opened-listing acquisition. */
  listing?: Readonly<{ sourceId: string; itemId: string; version: string }>;
  /** The registry's own mark for a listing whose faces are not known until it is opened (Open VSX). */
  mark?: HostCatalogMark | null;
}>;

/** A fact of the opened listing, once each (finding 7): Includes · Changes · Works on · Licence. */
export type StoreThemeListingFact = Readonly<{
  key: 'includes' | 'changes' | 'worksOn' | 'licence';
  value: string;
  /** A quieter second line (Works on: "Phones: all but 3 rules"). */
  note?: string | null;
}>;

export type StoreThemeListingFace = Readonly<{
  id: string;
  name: string;
  mode: ThemeProfileMode;
  miniature: ThemeMiniatureData;
}>;

/**
 * The opened listing in the DetailsPaneHost overlay (desktop) or the pushed listing page (phone).
 * `faces` is null until the selected listing's package is acquired (opening reads it once).
 */
export type StoreThemeListingViewProps = Readonly<{
  name: string;
  /** "Theme · Light and dark". */
  kicker: string;
  /** Publisher, source, version and review, said once: "mira.sato · Happier catalog · 2.1.0 · Reviewed". */
  meta: string;
  description: string | null;
  faces: readonly StoreThemeListingFace[] | null;
  facesState: 'loading' | 'ready' | 'error';
  facesError?: string | null;
  /** The face this device is trying now, from the shared try-on owner; null when nothing from here is on. */
  tryingFaceId: string | null;
  /** The face Try puts on first: the one for the mode this device shows now. */
  preferredFaceId: string | null;
  /** How this device is named ("this Mac"). */
  here: string;
  installed: boolean;
  facts: readonly StoreThemeListingFact[];
  busy: 'try' | 'install' | 'revert' | 'uninstall' | null;
  /** Per-face install failures after a partial install (`theme_install_partial`), shown with Retry. */
  installFailures?: readonly Readonly<{ faceName: string; code: string }>[];
  onTryFace: (faceId: string) => void;
  onRevert: () => void;
  onInstall: () => void;
  onRetryFaces: () => void;
  onUninstall?: () => void;
  testID?: string;
}>;

/**
 * The floating try bar (C2b): the shared try-on's controls while the listing that started it is closed.
 * One host at a time: the open listing renders the controls itself, so the bar is absent then.
 */
export type ThemeTryPresentationProps = Readonly<{
  origin?: 'store' | 'agent' | 'editor';
  disabled?: boolean;
  visible: boolean;
  faceName: string;
  miniature: ThemeMiniatureData | null;
  /** How this device is named ("this Mac"). */
  here: string;
  busy: 'install' | 'revert' | null;
  onRevert: () => void;
  onInstall: () => void;
  testID?: string;
}>;
