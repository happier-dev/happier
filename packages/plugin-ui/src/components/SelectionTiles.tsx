import { useCallback, useMemo, type ReactElement, type ReactNode } from 'react';
import { Platform, View } from 'react-native';

import { resolveHappierUiPalette, useOptionalHappierUiPalette, useOptionalHappierUiTypography } from '../environment/context.js';
import type { IconName } from './Icon.js';
import {
  HappierSelectionTiles,
  resolveHappierSelectionTileText,
  type HappierSelectionTileOption,
  type HappierSelectionTilesColors,
  type HappierSelectionTilesGlyphRenderer,
  type HappierSelectionTilesTextRenderer,
} from '../presentation/form/SelectionTiles.js';
import { resolveHappierTextStepStyle } from '../presentation/layout/pageText.js';
import { HappierText } from '../presentation/text/Text.js';
import { resolveHappierTypeScale } from '../presentation/text/typeScale.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';

export type SelectionTilesOption<T extends string = string> = Readonly<{
  id: T;
  title: string;
  /** A key from this plugin's declared translation bundle; `title` is its fallback. */
  titleKey?: string;
  /** One quiet line under the title. */
  subtitle?: string;
  subtitleKey?: string;
  /** A glyph from the public icon set (card tiles). Without one a card tile shows its selection mark. */
  icon?: IconName;
  mark?: ReactNode;
  badge?: string;
  badgeKey?: string;
  testID?: string;
  /**
   * What this option looks like (visual tiles or compact card rows): render the real component at
   * static props — never a drawn replica — so the preview cannot drift from
   * what the option does.
   */
  preview?: ReactNode;
  previewEdge?: 'solid' | 'dashed';
  disabled?: boolean;
}>;

type SelectionTilesBaseProps<T extends string> = Readonly<{
  options: readonly SelectionTilesOption<T>[];
  /**
   * `card` (default): text tiles with an optional glyph, a title and a subtitle.
   * `visual`: for options that change what you see — each tile is the option's
   * `preview` with its label beneath.
   */
  variant?: 'card' | 'visual';
  tileSizing?: 'natural' | 'fill';
  previewAspectRatio?: number;
  labels?: 'shown' | 'hidden';
  labelLines?: number;
  surface?: 'tiles' | 'sheet';
  density?: 'regular' | 'compact';
  minimumColumns?: number;
  maximumColumns?: number;
  minimumTileWidth?: number;
  subtitleLines?: number;
  /** Only action tiles start operations; choice variants do not accept an action callback. */
  onPress?: undefined;
  renderOptionFooter?: (input: Readonly<{ option: SelectionTilesOption<T>; selected: boolean; disabled: boolean }>) => ReactNode;
  /** The group's accessible name: the setting it chooses. */
  accessibilityLabel: string;
  accessibilityLabelKey?: string;
  /** Test id of the group; each tile gets `testID:optionId`. */
  testID?: string;
}>;

export type SelectionTilesProps<T extends string = string> =
  | (SelectionTilesBaseProps<T> & Readonly<{
    /** One choice (a radio group). */
    selectionMode?: 'single';
    value: T | null;
    onChange: (next: T) => void;
  }>)
  | (SelectionTilesBaseProps<T> & Readonly<{
    /** Any number of choices (a set of checkboxes). */
    selectionMode: 'multiple';
    value: readonly T[];
    onChange: (next: T[]) => void;
  }>)
  | (Omit<SelectionTilesBaseProps<T>, 'variant' | 'onPress'> & Readonly<{
    /** Buttons that start an operation; narrow page sections recompose them into rows. */
    variant: 'action';
    onPress: (id: T) => void;
    selectionMode?: undefined;
    value?: undefined;
    onChange?: undefined;
  }>);

/**
 * A group of tiles that choose a setting or start an operation: text cards, or — for a setting that
 * changes what you see — visual tiles that each show the option's preview. Action tiles recompose
 * into rows on narrow page sections; tiles with footers retain their own card and controls.
 * The same tile owner Happier's own settings use: one radio group (or a set
 * of checkboxes) with a single tab stop and arrow-key selection.
 */
export function SelectionTiles<T extends string>(props: SelectionTilesProps<T>): ReactElement {
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme) ?? resolveHappierUiPalette(theme);
  const translate = usePluginTranslation();
  const host = useOptionalPluginUiPresentationHost();

  // Every role maps to the same host token the core adapter uses: the page
  // palette's sheet / field / selection roles, and the snapshot's text,
  // secondary text and canvas.
  const colors = useMemo((): HappierSelectionTilesColors => ({
    tileBackground: palette.fieldBackground,
    tileBorder: palette.sheetBorder,
    selection: palette.selection,
    glyph: theme.colors.secondaryText,
    ring: theme.colors.text,
    previewBackground: theme.colors.canvas,
    actionBackground: palette.sheet,
    actionBorderHovered: palette.controlBorder,
  }), [palette, theme]);

  const typography = useOptionalHappierUiTypography();
  // The tiles' type scale is the shared owner's; this adapter adds the host's face per weight
  // and the theme's colours, exactly as Happier core's tile adapter does.
  const renderText = useCallback<HappierSelectionTilesTextRenderer>(({ role, text, selected, compact, numberOfLines }) => {
    const tileText = resolveHappierSelectionTileText(role, { selected, compact });
    const color = role === 'visualSublabel'
      ? theme.colors.mutedText
      : role === 'cardTitle' || role === 'actionTitle' || (role === 'visualLabel' && selected)
        ? theme.colors.text
        : theme.colors.secondaryText;
    return (
      <HappierText
        numberOfLines={numberOfLines}
        style={[
          resolveHappierTextStepStyle(resolveHappierTypeScale(tileText.role, Platform.OS, tileText.emphasis), typography),
          role === 'visualLabel' || role === 'visualSublabel' ? { textAlign: 'center' as const } : null,
          role === 'visualSublabel' ? { marginTop: -4 } : null,
          { color },
        ]}
      >
        {text}
      </HappierText>
    );
  }, [theme, typography]);

  const renderGlyph = useCallback<HappierSelectionTilesGlyphRenderer<IconName>>(({ glyph, size, color }) => {
    const name = glyph.kind === 'icon' ? glyph.name : 'check';
    return host ? <>{host.renderIcon({ name, size, color })}</> : <View aria-hidden style={{ width: size, height: size }} />;
  }, [host]);

  const options = useMemo(() => props.options.map((option): HappierSelectionTileOption<T, IconName> => {
    const subtitle = resolveAuthorText(translate, option.subtitle, option.subtitleKey);
    return {
      ...option,
      id: option.id,
      title: resolveAuthorText(translate, option.title, option.titleKey) ?? option.title,
      ...(subtitle === undefined ? {} : { subtitle }),
      ...(option.icon === undefined ? {} : { icon: option.icon }),
      ...(option.preview === undefined ? {} : { preview: option.preview }),
      ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
      ...(option.mark === undefined ? {} : { mark: option.mark }),
      ...(option.testID === undefined ? {} : { testID: option.testID }),
      ...(option.badge === undefined && option.badgeKey === undefined ? {} : {
        badge: resolveAuthorText(translate, option.badge, option.badgeKey),
      }),
    };
  }), [props.options, translate]);

  const shared = {
    options,
    tileSizing: props.tileSizing,
    previewAspectRatio: props.previewAspectRatio,
    labels: props.labels,
    labelLines: props.labelLines,
    surface: props.surface,
    density: props.density,
    minimumColumns: props.minimumColumns,
    maximumColumns: props.maximumColumns,
    minimumTileWidth: props.minimumTileWidth,
    subtitleLines: props.subtitleLines,
    renderOptionFooter: props.renderOptionFooter,
    accessibilityLabel: resolveAuthorText(translate, props.accessibilityLabel, props.accessibilityLabelKey) ?? props.accessibilityLabel,
    ...(props.testID === undefined ? {} : { testIdPrefix: props.testID }),
    colors,
    renderText,
    renderGlyph,
  } as const;

  if (props.variant === 'action') {
    return <HappierSelectionTiles {...shared} variant="action" onPress={props.onPress} theme={theme} pageColors={palette} />;
  }
  if (props.selectionMode === 'multiple') {
    return <HappierSelectionTiles {...shared} variant={props.variant} selectionMode="multiple" value={props.value} onChange={props.onChange} />;
  }
  const onChange = props.onChange;
  return (
    <HappierSelectionTiles
      {...shared}
      variant={props.variant}
      selectionMode="single"
      value={props.value}
      onChange={(next) => { if (next !== null) onChange(next); }}
    />
  );
}
