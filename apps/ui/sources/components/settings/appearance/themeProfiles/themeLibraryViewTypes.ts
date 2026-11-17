import type * as React from 'react';
import type {
  ThemeMiniatureData,
  ThemeProfileMode,
} from '@/theme/profiles/themeProfileTypes';
import type { ThemeRadiusScaleName } from '@happier-dev/protocol/account/settings/themeProfiles';
import type { ThemePreviewPalette } from '@/components/settings/appearance/ThemeModePreview';

/**
 * The presentation seam of Appearance → Themes (plan-6 U1). The view draws exactly these props; the
 * controller (`ThemeProfilesSettingsScreen` today, the library model hook later) owns reads, Actions and
 * copy that names facts. No domain schema is copied here: sources, modes and miniatures are the theme
 * model's own types, and every operation is a ready callback.
 */

/**
 * How a theme is drawn: from its compact library header, or (until every caller reads headers) from a
 * resolved palette. Both reach the one miniature owner, `ThemePalettePreview`.
 */
export type ThemeLibraryPreview =
  | Readonly<{ kind: 'miniature'; miniature: ThemeMiniatureData }>
  | Readonly<{
      kind: 'palette';
      palette: ThemePreviewPalette;
      radius?: ThemeRadiusScaleName;
      accent?: string;
    }>;

/** One of a theme's quiet operations (Edit, Duplicate, Export file, Share as plugin, Delete), built by the controller. */
export type ThemeLibraryMenuItem = Readonly<{
  id: string;
  title: string;
  subtitle?: string;
  disabled?: boolean;
  destructive?: boolean;
  onSelect: () => void;
}>;

export type ThemeLibraryTile = Readonly<{
  /** Stable selection key of the theme in this mode. */
  key: string;
  name: string;
  /** Made by you · Store · <plugin name> · Built-in. */
  sourceLabel: string;
  preview: ThemeLibraryPreview;
  menu: readonly ThemeLibraryMenuItem[];
  /** Share as plugin (the selected Machine's scaffold and pack), when this theme can be shared. */
  onShare?: () => void;
  /** Delete this theme through its Action (your own themes only). */
  onDelete?: () => void;
}>;

/**
 * Facts about the themes in use that need the person, each with its one repair. The view owns the words;
 * the controller passes the theme model's and the CSS owner's facts.
 */
export type ThemeLibraryFact =
  | Readonly<{
      /** E3: a theme from a newer Happier; its colors show, newer parts don't. */
      kind: 'partial';
      name: string;
      requiresAppVersion?: string;
      unsupportedPaths?: readonly string[];
      /** CSS-owner count of rules this native client cannot apply. */
      webOnlyRules?: number;
      onUpdate?: () => void;
    }>
  | Readonly<{
      /** E4: a theme's CSS hides part of the app on this device. */
      kind: 'hides';
      name: string;
      /** Readable names of the hidden areas (the surface reference's labels). */
      areas: readonly string[];
      onUseBuiltIn: () => void;
    }>;

/** A fact that needs the person, with its one repair (a partly shown or hiding theme). */
export type ThemeLibraryNotice = Readonly<{
  text: string;
  action?: Readonly<{ title: string; onPress: () => void }>;
}>;

export type ThemeLibrarySlot = Readonly<{
  mode: ThemeProfileMode;
  name: string;
  sourceLabel: string;
  preview: ThemeLibraryPreview;
  /** This device shows this mode right now. */
  showing: boolean;
  /** Present when the in-use theme can be sent to other connected devices (the shared device picker). */
  onUseOtherDevices?: () => void;
  devicesAnchorRef?: React.RefObject<unknown>;
}>;

export type ThemeLibraryViewProps = Readonly<{
  slots: Readonly<Record<ThemeProfileMode, ThemeLibrarySlot>>;
  /** The slot whose themes the grid shows. */
  mode: ThemeProfileMode;
  /** The key of the theme the chosen mode uses: the ring. */
  selectedKey: string;
  /** The chosen mode's themes, ordered yours → installed (Store, plugins) → built-in. */
  tiles: readonly ThemeLibraryTile[];
  /** False shows the in-place invitation to make one. */
  hasOwnThemes: boolean;
  /** One line under both slots for a failed read or apply, with Retry. */
  notice?: ThemeLibraryNotice;
  /** E3/E4 facts about the themes in use, each said once under both slots. */
  facts?: readonly ThemeLibraryFact[];
  /** The Add theme menu: New theme · Import theme. */
  addMenu: readonly ThemeLibraryMenuItem[];
  onChooseMode: (mode: ThemeProfileMode) => void;
  onChooseTheme: (key: string) => void;
  /** Present when the Store lists themes. */
  onOpenStore?: () => void;
}>;
