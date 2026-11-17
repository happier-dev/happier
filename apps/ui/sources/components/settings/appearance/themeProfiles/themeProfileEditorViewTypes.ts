import type { BundledTypefaceChoice } from '@/constants/bundledFonts';
import type * as React from 'react';
import type { ThemeRadiusScaleName } from '@happier-dev/protocol/account/settings/themeProfiles';

import type { ThemePreviewPalette } from '@/components/settings/appearance/ThemeModePreview';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import type { PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import type {
  ThemeProfileMode,
  ThemeProfileV1,
} from '@/theme/profiles/themeProfileTypes';
import type { ThemeProfileTokenDefinition } from '@/theme/profiles/themeProfileTokenRegistry';
import type { ThemeLibraryPreview } from './themeLibraryViewTypes';

/**
 * The presentation seam of the theme editor (plan-6 U4, lab D1–D4). The controller
 * (`ThemeProfileEditorScreen` today) owns the draft, validation, preview publication and every write;
 * the view (`ThemeProfileEditorView`) draws these props and reports intent through the callbacks.
 */

/** The editor's three views. Colors: seeds and every colour; Style: corners and typeface; CSS. */
export type ThemeEditorView = 'colors' | 'style' | 'css';

export type ThemeEditorStartOption = Readonly<{
  key: string;
  name: string;
  sourceLabel: string;
  preview: ThemeLibraryPreview;
}>;

export type ThemeEditorColorGroup = Readonly<{
  id: string;
  title: string;
  tokens: readonly ThemeProfileTokenDefinition[];
}>;

/** A surface a theme's CSS can address, from the CSS surface registry. */
export type ThemeSurfaceReferenceEntry = Readonly<{
  id: string;
  label: string;
  parts: readonly string[];
}>;

export type ThemeProfileEditorViewProps = Readonly<{
  header: Readonly<{
    title: string;
    description: string;
    meta: readonly PageHeaderMetaFact[];
    mark: ThemeLibraryPreview;
    /** A blocking fact about saving (the theme limit), said under the header. */
    error?: string;
    /** Absent on a theme that cannot be edited here (built-in, Store, plugin). */
    save?: Readonly<{ disabled: boolean; onPress: () => void }>;
    menu: readonly PageHeaderMenuAction[];
    /** Share as plugin, drawn in the "…" after Export file (present when the theme can be shared). */
    onShare?: () => void;
  }>;
  readonly: boolean;
  view: ThemeEditorView;
  onViewChange: (view: ThemeEditorView) => void;
  /** The draft's identity: name, and whether it is a light or dark theme (absent when read-only). */
  details?: Readonly<{
    name: string;
    nameInvalid: boolean;
    autoFocus: boolean;
    onNameChange: (name: string) => void;
    appearance: ThemeProfileMode;
    onAppearanceChange: (mode: ThemeProfileMode) => void;
  }>;
  /** One way to start: a theme the draft takes its colours from. */
  startFrom?: Readonly<{
    options: readonly ThemeEditorStartOption[];
    selectedKey: string | null;
    onChoose: (key: string) => void;
  }>;
  /** The two seeds the palette follows (Page and Accent). */
  seeds: Readonly<{
    canvas: string;
    accent: string;
    canvasChanged: boolean;
    accentChanged: boolean;
    onChange: (seed: 'canvas' | 'accent', value: string) => void;
    onReset: (seed: 'canvas' | 'accent') => void;
  }>;
  colors: Readonly<{
    draft: ThemeProfileV1;
    mode: ThemeProfileMode;
    groups: readonly ThemeEditorColorGroup[];
    invalidByToken: Readonly<Record<string, boolean>>;
    recentColors: readonly string[];
    query: string;
    onQueryChange: (query: string) => void;
    /** The token the picker found in the app, highlighted and scrolled to. */
    highlightedTokenId?: string | null;
    onChange: (tokenId: string, value: string) => void;
    onInvalidChange: (tokenId: string, invalid: boolean) => void;
    onReset: (tokenId: string) => void;
  }>;
  preview: ThemeLibraryPreview;
  /** Pick a colour from the app (present where the app can be pointed at). */
  picker?: Readonly<{
    active: boolean;
    onToggle: () => void;
    /** What the last pick found: the surface and the colour role it paints with (its id shows only here). */
    target?: Readonly<{ surfaceLabel: string; roleLabel: string; roleId: string }> | null;
  }>;
  style: Readonly<{
    radius: ThemeRadiusScaleName;
    onRadiusChange: (radius: ThemeRadiusScaleName) => void;
    radiusPreview: (radius: ThemeRadiusScaleName) => ThemeLibraryPreview;
    /** Bundled typefaces, when the font catalog offers a choice. */
    typefaces?: readonly BundledTypefaceChoice[];
    typeface?: string | null;
    onTypefaceChange?: (id: string | null) => void;
  }>;
  css: Readonly<{
    value: string;
    resetKey: string;
    onChange: (value: string) => void;
    editorRef?: React.Ref<CodeEditorHandle>;
    /** The compiled coverage of the draft's CSS (present once the CSS owner reports it). */
    /** The CSS owner's counts for the draft (`ThemeCssCoverage`): rules in all, rules phones apply, web-only rules. */
    coverage?: Readonly<{ total: number; native: number; webOnly: number }>;
    /** The rules phones skip (web and desktop only), each with its line, for "Which N?". */
    webOnlyRules?: readonly Readonly<{ line: number; selector: string }>[];
    /** Moves the code field to a rule's line. */
    onRevealLine?: (line: number) => void;
    surfaces?: readonly ThemeSurfaceReferenceEntry[];
  }>;
}>;

export type { ThemePreviewPalette };
