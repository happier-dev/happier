import { memo, type ReactElement, type ReactNode } from 'react';
import { View } from 'react-native';

import { useHappierUiTheme } from '../../environment/context.js';
import { HappierPressable } from '../interaction/Pressable.js';
import type {
  HappierPortableStyle,
  HappierStyleProp,
} from '../portableTypes.js';
import { HAPPIER_META_COLUMN_STYLE } from '../text/metaColumn.js';
import { HappierText } from '../text/Text.js';

/**
 * The media gallery's one presentation (lab pr974 SG1/SG2/SM1): square picture tiles in day sections, the folder's
 * folders first as compact one-line tiles, and one quiet line at the foot. The Files pane, a Details tab and Session
 * Media draw the same body; only the host's width changes how many columns stand (3 in the Files pane, 5 in Details,
 * 8 in Focus). The host virtualizes the lines this model returns; tiles draw the host's picture as their child.
 */
export const HAPPIER_MEDIA_GRID_METRICS = {
  /** The narrowest tile: three across the 340 px Files pane. */
  tileMinPx: 100,
  /** One rhythm between tiles, folders and rows (lab `s4`). */
  gapPx: 4,
  /** A folder tile's one line (lab `.sg-f`); a finger gets the touch height. */
  folderHeightPx: 36,
  folderTouchHeightPx: 44,
  /** A folder tile's narrowest width before its row holds one fewer (lab `.sg-big .sg-folders`). */
  folderMinPx: 160,
  /** A day heading's line (lab `.sm-sec`): its padding above and below the label line. */
  headingPadTopPx: 12,
  headingPadBottomPx: 6,
  /** The tile's corner (the product's small radius) and its badge inset. */
  tileRadiusPx: 6,
  badgeInsetPx: 4,
} as const;

const M = HAPPIER_MEDIA_GRID_METRICS;

/** Columns for a body of this inner width: as many tiles as fit at the minimum, never wider than the maximum. */
export function resolveHappierMediaGridGeometry(
  widthPx: number,
): Readonly<{ columns: number; tilePx: number; folderColumns: number }> {
  const width = Math.max(0, widthPx);
  // As many as fit at the minimum: from two columns up a tile stays under the maximum without a cap of its own.
  const columns = Math.max(1, Math.floor((width + M.gapPx) / (M.tileMinPx + M.gapPx)));
  const tilePx = Math.max(1, (width - M.gapPx * (columns - 1)) / columns);
  // Folders are a short index of names: two across the pane, more only where each keeps a readable width.
  const folderColumns = Math.max(
    2,
    Math.floor((width + M.gapPx) / (M.folderMinPx + M.gapPx)),
  );
  return { columns, tilePx, folderColumns };
}

export type HappierMediaGridSection<Item> = Readonly<{
  key: string;
  title: string;
  items: readonly Item[];
}>;

export type HappierMediaGridLine<Item, Folder> =
  | Readonly<{ kind: 'folders'; key: string; folders: readonly Folder[] }>
  | Readonly<{ kind: 'heading'; key: string; title: string; count: number }>
  | Readonly<{
      kind: 'tiles';
      key: string;
      items: readonly Item[];
      first: number;
    }>
  | Readonly<{ kind: 'foot'; key: string }>;

/**
 * The gallery's lines in reading order: folder rows, then each day's heading and its tile rows, then the foot when
 * the host has one (other files, the listing cap). `first` is the row's first item's index in visual order, the
 * index the stage opens at.
 */
export function buildHappierMediaGridLines<Item, Folder>(
  input: Readonly<{
    folders: readonly Folder[];
    sections: readonly HappierMediaGridSection<Item>[];
    columns: number;
    folderColumns: number;
    keyOf: (item: Item) => string;
    folderKeyOf: (folder: Folder) => string;
    foot: boolean;
  }>,
): readonly HappierMediaGridLine<Item, Folder>[] {
  const lines: HappierMediaGridLine<Item, Folder>[] = [];
  const folderColumns = Math.max(1, input.folderColumns);
  for (let index = 0; index < input.folders.length; index += folderColumns) {
    const folders = input.folders.slice(index, index + folderColumns);
    lines.push({
      kind: 'folders',
      key: `folders:${input.folderKeyOf(folders[0]!)}`,
      folders,
    });
  }
  const columns = Math.max(1, input.columns);
  let first = 0;
  for (const section of input.sections) {
    if (section.items.length === 0) continue;
    lines.push({
      kind: 'heading',
      key: `heading:${section.key}`,
      title: section.title,
      count: section.items.length,
    });
    for (let index = 0; index < section.items.length; index += columns) {
      const items = section.items.slice(index, index + columns);
      lines.push({
        kind: 'tiles',
        key: `tiles:${input.keyOf(items[0]!)}`,
        items,
        first,
      });
      first += items.length;
    }
  }
  if (input.foot) lines.push({ kind: 'foot', key: 'foot' });
  return lines;
}

const rowStyle: HappierPortableStyle = {
  flexDirection: 'row',
  gap: M.gapPx,
  paddingBottom: M.gapPx,
};

/** One drawn line of tiles or folders: the cells keep their width, so a short last row stays on the grid. */
export function HappierMediaGridRow(
  props: Readonly<{ children: ReactNode; testID?: string }>,
): ReactElement {
  return (
    <View
      style={rowStyle}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      {props.children}
    </View>
  );
}

const headingStyle: HappierPortableStyle = {
  flexDirection: 'row',
  alignItems: 'baseline',
  gap: 8,
  paddingTop: M.headingPadTopPx,
  paddingBottom: M.headingPadBottomPx,
  paddingHorizontal: 2,
};
const headingTitleStyle: HappierPortableStyle = { flex: 1, minWidth: 0 };

/** A day's heading: its name, and how many pictures it holds at the line's end in tabular figures. */
export const HappierMediaGridHeading = memo(function HappierMediaGridHeading(
  props: Readonly<{ title: string; count: string; testID?: string }>,
) {
  return (
    <View
      style={headingStyle}
      accessibilityRole="header"
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      <HappierText
        variant="label"
        emphasis="semiBold"
        tone="neutral"
        numberOfLines={1}
        style={headingTitleStyle}
      >
        {props.title}
      </HappierText>
      <HappierText variant="meta" tone="muted" style={HAPPIER_META_COLUMN_STYLE}>
        {props.count}
      </HappierText>
    </View>
  );
});


/**
 * A square picture tile. The host draws the picture (or the name standing in for one) as its child; the tile owns
 * the square, the corner, the ink outline over light screenshots, a badge corner and the selection ring.
 */
export const HappierMediaTile = memo(function HappierMediaTile(
  props: Readonly<{
    sizePx: number;
    accessibilityLabel: string;
    onPress: (event?: unknown) => void;
    onLongPress?: () => void;
    selected?: boolean;
    /** Lower-start corner: a video's length, a play mark. */
    badge?: ReactNode;
    children?: ReactNode;
    testID?: string;
  }>,
) {
  const theme = useHappierUiTheme();
  const size = { width: props.sizePx, height: props.sizePx };
  return (
    <HappierPressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      selected={props.selected === true}
      onPress={props.onPress}
      {...(props.onLongPress ? { onLongPress: props.onLongPress } : {})}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      style={[tileStyle, size, { backgroundColor: theme.colors.control }]}
    >
      {props.children}
      <View
        pointerEvents="none"
        style={[outlineStyle, { borderColor: theme.colors.divider }]}
      />
      {props.badge ? (
        <View pointerEvents="none" style={badgeStyle}>
          {props.badge}
        </View>
      ) : null}
      {props.selected ? (
        <View
          pointerEvents="none"
          style={[ringStyle, { borderColor: theme.colors.focus }]}
        />
      ) : null}
    </HappierPressable>
  );
});

const tileStyle: HappierPortableStyle = {
  borderRadius: M.tileRadiusPx,
  overflow: 'hidden',
  alignItems: 'center',
  justifyContent: 'center',
};
const outlineStyle: HappierPortableStyle = {
  position: 'absolute',
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  borderRadius: M.tileRadiusPx,
  borderWidth: 1,
};
const ringStyle: HappierPortableStyle = {
  position: 'absolute',
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  borderRadius: M.tileRadiusPx,
  borderWidth: 2,
};
const badgeStyle: HappierPortableStyle = {
  position: 'absolute',
  left: M.badgeInsetPx,
  bottom: M.badgeInsetPx,
};

/** A loading tile: the tile's own square, in the control fill, so nothing moves when the pictures arrive. */
export function HappierMediaTileSkeleton(
  props: Readonly<{ sizePx: number; testID?: string }>,
): ReactElement {
  const theme = useHappierUiTheme();
  return (
    <View
      style={[
        tileStyle,
        {
          width: props.sizePx,
          height: props.sizePx,
          backgroundColor: theme.colors.control,
        },
      ]}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    />
  );
}

/** A folder: one line, its mark and name, a flat ink edge (it leads somewhere; the tiles are the content). */
export const HappierMediaFolderTile = memo(function HappierMediaFolderTile(
  props: Readonly<{
    name: string;
    glyph: ReactNode;
    widthPx: number;
    touch: boolean;
    onPress: (event?: unknown) => void;
    testID?: string;
  }>,
) {
  const theme = useHappierUiTheme();
  return (
    <HappierPressable
      accessibilityRole="button"
      accessibilityLabel={props.name}
      onPress={props.onPress}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      style={[
        folderStyle,
        {
          width: props.widthPx,
          height: props.touch ? M.folderTouchHeightPx : M.folderHeightPx,
          borderColor: theme.colors.divider,
        },
      ]}
    >
      {props.glyph}
      <HappierText variant="body" tone="neutral" numberOfLines={1} style={folderNameStyle}>
        {props.name}
      </HappierText>
    </HappierPressable>
  );
});

const folderStyle: HappierPortableStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 8,
  paddingHorizontal: 10,
  borderRadius: M.tileRadiusPx,
  borderWidth: 1,
  minWidth: 0,
};
const folderNameStyle: HappierPortableStyle = { flex: 1, minWidth: 0 };

const footStyle: HappierPortableStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 6,
  paddingTop: M.headingPadTopPx,
  paddingBottom: M.gapPx,
  paddingHorizontal: 2,
};
const footTextStyle: HappierPortableStyle = { flex: 1, minWidth: 0 };

/**
 * One quiet line at the gallery's foot (lab `.sg-other`, `.sg-cap`): what is not drawn as a tile, said honestly,
 * with its one action at the line's end. Never an error colour: nothing failed.
 */
export function HappierMediaGridFootLine(
  props: Readonly<{
    glyph?: ReactNode;
    text: string;
    action?: ReactNode;
    testID?: string;
    style?: HappierStyleProp;
  }>,
): ReactElement {
  return (
    <View
      style={[footStyle, props.style]}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      {props.glyph ?? null}
      <HappierText
        variant="meta"
        tone="muted"
        numberOfLines={1}
        style={footTextStyle}
      >
        {props.text}
      </HappierText>
      {props.action ?? null}
    </View>
  );
}
