import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_MEDIA_GRID_METRICS,
  HappierMediaFolderTile,
  HappierMediaGridFootLine,
  HappierMediaGridHeading,
  HappierMediaGridRow,
  HappierMediaTile,
  HappierMediaTileSkeleton,
  buildHappierMediaGridLines,
  resolveHappierMediaGridGeometry,
  type HappierMediaGridLine,
} from '@happier-dev/plugin-ui/presentation';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import {
  VirtualizedList,
  type VirtualizedListRenderItem,
} from '@/components/ui/lists/virtualized';
import { MediaPicture } from '@/components/ui/media/MediaPicture';
import { useFilePreviewSource } from '@/components/ui/media/useFilePreviewSource';
import { Text } from '@/components/ui/text/Text';
import { createGalleryPreviewInput } from '@/hooks/workspaces/files/gallery/galleryStage';
import type {
  GalleryDaySection,
  GalleryMediaItem,
} from '@/hooks/workspaces/files/gallery/galleryModel';
import { formatCalendarDate } from '@/utils/datetime/cachedIntlFormatters';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { t } from '@/text';

export type GalleryFolder = Readonly<{ name: string; path: string }>;

/** A day key ("2026-11-27", local) as its heading: Today, Yesterday, else the calendar date. */
export function formatGalleryDay(day: string | null, nowMs: number): string {
  if (day === null) return t('files.pane.gallery.unknownDay');
  const [year, month, date] = day.split('-').map(Number);
  const start = new Date(year!, month! - 1, date!).getTime();
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  if (start === today.getTime()) return t('sessionHistory.today');
  if (start === today.getTime() - 86_400_000)
    return t('sessionHistory.yesterday');
  return formatCalendarDate(start, undefined, nowMs);
}

const GalleryTile = React.memo(function GalleryTile(
  props: Readonly<{
    item: GalleryMediaItem;
    index: number;
    sizePx: number;
    cacheOnly: boolean;
    onOpen: (index: number) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { item } = props;
  const picture = item.kind !== 'video';
  // A tile is mounted only while its row is near the list's window (the virtualized list owns that), so mounting is
  // the demand; a stale (Machine away) gallery shows what this device holds.
  const preview = useFilePreviewSource(
    createGalleryPreviewInput(
      item,
      picture,
      props.cacheOnly ? { cacheOnly: true } : undefined,
    ),
  );
  const loaded = picture && preview.status === 'loaded';
  return (
    <HappierMediaTile
      sizePx={props.sizePx}
      accessibilityLabel={item.name}
      onPress={() => props.onOpen(props.index)}
      testID={`gallery-tile-${item.name}`}
      badge={
        item.kind === 'video' ? (
          <View style={styles.badge}>
            <Icon
              name="play"
              weight="fill"
              size={10}
              color={theme.colors.overlay.foreground}
            />
          </View>
        ) : null
      }
    >
      {loaded ? (
        <MediaPicture
          kind={item.kind === 'svg' ? 'svg' : 'image'}
          uri={preview.uri}
          fit="cover"
          size={{ width: props.sizePx, height: props.sizePx }}
          style={StyleSheet.absoluteFill}
        />
      ) : preview.status === 'loading' ? null : (
        // Not readable here (a video, past the preview limit, not cached while the Machine is away): its name stands in.
        <View style={styles.standIn}>
          <Icon
            name={item.kind === 'video' ? 'video-camera' : 'image'}
            size={20}
            color={theme.colors.text.tertiary}
          />
          <Text
            variant="micro"
            numberOfLines={1}
            style={{ color: theme.colors.text.tertiary }}
          >
            {item.name}
          </Text>
        </View>
      )}
    </HappierMediaTile>
  );
});

export type GalleryGridProps = Readonly<{
  folders: readonly GalleryFolder[];
  sections: readonly GalleryDaySection[];
  /** The listing's first answer is still on its way: skeleton tiles, nothing else moves. */
  loading: boolean;
  /** The Machine is away: only pictures this device already holds are drawn. */
  stale: boolean;
  /** Lines at the foot (other files, the listing cap), drawn in order. */
  foot?: React.ReactNode;
  /** Above the grid inside its scroller (a pane's path bar scrolls away with the pictures). */
  header?: React.ReactElement | null;
  /** Nothing to show once loaded: the host's own empty state. */
  empty?: React.ReactElement | null;
  onOpenFolder?: (folder: GalleryFolder, event?: unknown) => void;
  /** Opens the stage at this item's index in visual order. */
  onOpenItem: (index: number) => void;
  /** The body's side inset: the Files pane's text edge, or a Details tab's wider one. */
  insetPx: number;
  testID?: string;
}>;

const SKELETON_ROWS = 3;

/**
 * The gallery body every host draws (Files pane, Details tab, Session Media): the shared media grid's lines through
 * the app's virtualized list, so a folder of hundreds mounts only the rows near the window.
 */
export function GalleryGrid(props: GalleryGridProps) {
  const { theme } = useUnistyles();
  const touch = useHappierTouchPrimaryPointer(Platform.OS);
  const [width, setWidth] = React.useState<number | null>(null);
  const geometry = resolveHappierMediaGridGeometry(
    Math.max(0, (width ?? 0) - props.insetPx * 2),
  );
  const { columns, tilePx, folderColumns } = geometry;
  const [nowMs] = React.useState(() => Date.now());
  const items = React.useMemo(
    () => props.sections.flatMap((section) => section.items),
    [props.sections],
  );
  const hasFoot =
    props.foot !== undefined && props.foot !== null && props.foot !== false;
  const lines = React.useMemo(
    () =>
      buildHappierMediaGridLines<GalleryMediaItem, GalleryFolder>({
        folders: props.folders,
        columns,
        folderColumns,
        foot: hasFoot,
        sections: props.sections.map((section) => ({
          key: section.day ?? 'unknown',
          title: formatGalleryDay(section.day, nowMs),
          items: section.items,
        })),
        keyOf: (item) => item.id,
        folderKeyOf: (folder) => folder.path,
      }),
    [columns, folderColumns, hasFoot, nowMs, props.folders, props.sections],
  );
  const folderWidth =
    (Math.max(0, (width ?? 0) - props.insetPx * 2) -
      HAPPIER_MEDIA_GRID_METRICS.gapPx * (folderColumns - 1)) /
    folderColumns;
  const { onOpenFolder, onOpenItem, stale } = props;
  const foot = props.foot;
  const renderLine = React.useCallback<
    VirtualizedListRenderItem<
      HappierMediaGridLine<GalleryMediaItem, GalleryFolder>
    >
  >(
    ({ item: line }) => {
      switch (line.kind) {
        case 'folders':
          return (
            <HappierMediaGridRow>
              {line.folders.map((folder) => (
                <HappierMediaFolderTile
                  key={folder.path}
                  name={folder.name}
                  widthPx={folderWidth}
                  touch={touch}
                  glyph={
                    <Icon
                      name="folder"
                      size={16}
                      color={theme.colors.text.secondary}
                    />
                  }
                  onPress={(event) => onOpenFolder?.(folder, event)}
                  testID={`gallery-folder-${folder.name}`}
                />
              ))}
            </HappierMediaGridRow>
          );
        case 'heading':
          return (
            <HappierMediaGridHeading
              title={line.title}
              count={formatExactCount(line.count)}
            />
          );
        case 'tiles':
          return (
            <HappierMediaGridRow testID="gallery-row">
              {line.items.map((item, offset) => (
                <GalleryTile
                  key={item.id}
                  item={item}
                  index={line.first + offset}
                  sizePx={tilePx}
                  cacheOnly={stale}
                  onOpen={onOpenItem}
                />
              ))}
            </HappierMediaGridRow>
          );
        case 'foot':
          return <View>{foot}</View>;
      }
    },
    [
      folderWidth,
      foot,
      onOpenFolder,
      onOpenItem,
      stale,
      theme.colors.text.secondary,
      tilePx,
      touch,
    ],
  );

  const contentStyle = React.useMemo(
    () => ({
      paddingHorizontal: props.insetPx,
      paddingBottom: theme.space.s16,
    }),
    [props.insetPx, theme.space.s16],
  );
  const measure = (event: { nativeEvent: { layout: { width: number } } }) => {
    const next = event.nativeEvent.layout.width;
    setWidth((current) =>
      current !== null && Math.abs(current - next) < 0.5 ? current : next,
    );
  };
  if (props.loading && items.length === 0 && props.folders.length === 0) {
    const rows = Array.from({ length: SKELETON_ROWS }, (_, row) => row);
    return (
      <View
        style={styles.fill}
        onLayout={measure}
        testID={props.testID ? `${props.testID}-loading` : undefined}
      >
        {props.header ?? null}
        {width === null ? null : (
          <View style={contentStyle}>
            <View style={styles.skeletonHeading} />
            {rows.map((row) => (
              <HappierMediaGridRow key={row}>
                {Array.from({ length: columns }, (_, column) => (
                  <HappierMediaTileSkeleton
                    key={column}
                    sizePx={tilePx}
                    testID="gallery-skeleton-tile"
                  />
                ))}
              </HappierMediaGridRow>
            ))}
          </View>
        )}
      </View>
    );
  }
  if (
    !props.loading &&
    items.length === 0 &&
    props.folders.length === 0 &&
    props.empty
  ) {
    return (
      <View style={styles.fill} testID={props.testID}>
        {props.header ?? null}
        {props.empty}
        {foot ?? null}
      </View>
    );
  }
  return (
    <View style={styles.fill} onLayout={measure}>
      {width === null ? null : (
        <VirtualizedList
          testID={props.testID}
          data={lines}
          keyExtractor={(line) => line.key}
          renderItem={renderLine}
          extraData={renderLine}
          getItemType={(line) => line.kind}
          estimatedItemSize={tilePx + HAPPIER_MEDIA_GRID_METRICS.gapPx}
          ListHeaderComponent={props.header ?? null}
          contentContainerStyle={contentStyle}
          style={styles.fill}
        />
      )}
    </View>
  );
}


/** A quiet foot line with an optional link at its end, for hosts composing the gallery's foot. */
export function GalleryFootLine(
  props: Readonly<{
    icon: React.ComponentProps<typeof Icon>['name'];
    text: string;
    action?: Readonly<{
      label: string;
      onPress: () => void;
      testID?: string;
    }> | null;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <HappierMediaGridFootLine
      testID={props.testID}
      glyph={
        <Icon name={props.icon} size={14} color={theme.colors.text.tertiary} />
      }
      text={props.text}
      action={
        props.action ? (
          <TextLinkButton
            size="meta"
            verticalReach={0}
            label={props.action.label}
            onPress={props.action.onPress}
            testID={props.action.testID}
          />
        ) : null
      }
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1, minHeight: 0 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 18,
    paddingHorizontal: theme.space.s4,
    borderRadius: 9,
    backgroundColor: theme.colors.overlay.scrim,
  },
  standIn: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.s4,
    padding: theme.space.s8,
    maxWidth: '100%',
  },
  skeletonHeading: {
    height:
      HAPPIER_MEDIA_GRID_METRICS.headingPadTopPx +
      18 +
      HAPPIER_MEDIA_GRID_METRICS.headingPadBottomPx,
  },
}));
