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
  buildHappierMediaGridLines,
  resolveHappierMediaGridGeometry,
  type HappierMediaGridLine,
} from '@happier-dev/plugin-ui/presentation';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';

import { GallerySkeleton } from './GallerySkeleton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import {
  VirtualizedList,
  type VirtualizedListRenderItem,
} from '@/components/ui/lists/virtualized';
import { MediaPicture } from '@/components/ui/media/MediaPicture';
import { useFilePreviewSource } from '@/components/ui/media/useFilePreviewSource';
import { Text } from '@/components/ui/text/Text';
import { formatPlaybackTime } from '@/components/workspaces/files/file/filePageMediaFacts';
import { withVideoFrameSource } from '@/components/workspaces/files/file/videoFrameAccess';
import { useSetting } from '@/sync/domains/state/storage';
import { createGalleryPreviewInput } from '@/hooks/workspaces/files/gallery/galleryStage';
import {
  localDay,
  type GalleryDaySection,
  type GalleryMediaItem,
} from '@/hooks/workspaces/files/gallery/galleryModel';
import { formatCalendarDate, formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
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

/** A poster's decoded width: one still per video, large enough for the widest tile at 2x. */
const POSTER_WIDTH_PX = 320;
type VideoPoster = Readonly<{ source: string; uri: string; durationSeconds?: number }>;

/** The video's first frame and its length, decoded once through the shared frame owner while the tile is mounted. */
function useVideoPoster(uri: string | null): VideoPoster | null {
  const [poster, setPoster] = React.useState<VideoPoster | null>(null);
  React.useEffect(() => {
    if (!uri) return;
    const lifetime = new AbortController();
    void withVideoFrameSource(uri, (player) => player.readFrame({ timeSeconds: 0, width: POSTER_WIDTH_PX }), lifetime.signal)
      .then((frame) => {
        if (lifetime.signal.aborted) return;
        setPoster({ source: uri, uri: frame.uri,
          ...(frame.durationSeconds === undefined ? {} : { durationSeconds: frame.durationSeconds }) });
      })
      // An undecodable video keeps its name as the stand-in.
      .catch(() => undefined);
    return () => lifetime.abort();
  }, [uri]);
  return poster?.source === uri ? poster : null;
}

/** When an item was made, for the stage caption: its day heading's words and the local time ("Today 13:51"). */
export function formatGalleryMoment(modifiedMs: number, nowMs: number): string {
  return `${formatGalleryDay(localDay(modifiedMs), nowMs)} ${formatWithCachedDateTimeFormatter(modifiedMs, undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

const GalleryTile = React.memo(function GalleryTile(
  props: Readonly<{
    item: GalleryMediaItem;
    index: number;
    sizePx: number;
    cacheOnly: boolean;
    selected: boolean;
    onOpen: (index: number) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { item } = props;
  const video = item.kind === 'video';
  // A video reads under the pictures' own preview budget; a longer one keeps its name as the stand-in.
  const previewLimit = useSetting('filesImagePreviewMaxBytes');
  // A tile is mounted only while its row is near the list's window (the virtualized list owns that), so mounting is
  // the demand; a stale (Machine away) gallery shows what this device holds.
  const preview = useFilePreviewSource(
    createGalleryPreviewInput(item, true, {
      ...(props.cacheOnly ? { cacheOnly: true } : {}),
      ...(video ? { maxBytes: previewLimit } : {}),
    }),
  );
  const poster = useVideoPoster(video && preview.status === 'loaded' ? preview.uri : null);
  const pictureUri = video ? poster?.uri ?? null : preview.status === 'loaded' ? preview.uri : null;
  const pending = preview.status === 'loading' || (video && preview.status === 'loaded' && poster === null);
  return (
    <HappierMediaTile
      sizePx={props.sizePx}
      accessibilityLabel={item.name}
      onPress={() => props.onOpen(props.index)}
      selected={props.selected}
      testID={`gallery-tile-${item.name}`}
      badge={
        video ? (
          <View style={styles.badge}>
            <Icon
              name="play"
              weight="fill"
              size={10}
              color={theme.colors.overlay.foreground}
            />
            {poster?.durationSeconds !== undefined ? (
              <Text variant="micro" emphasis="semiBold" style={styles.badgeText}>
                {formatPlaybackTime(poster.durationSeconds)}
              </Text>
            ) : null}
          </View>
        ) : null
      }
      endBadge={
        // A picture someone attached in the chat (lab SM1): the paperclip says where it came from.
        item.origin === 'messages' ? (
          <View style={styles.badge} testID="gallery-tile-attached">
            <Icon name="paperclip" size={10} color={theme.colors.overlay.foreground} />
          </View>
        ) : null
      }
    >
      {pictureUri ? (
        <MediaPicture
          kind={item.kind === 'svg' ? 'svg' : 'image'}
          uri={pictureUri}
          fit="cover"
          size={{ width: props.sizePx, height: props.sizePx }}
          style={StyleSheet.absoluteFill}
        />
      ) : pending ? null : (
        // Not readable here (a video, past the preview limit, not cached while the Machine is away): its name stands in.
        <View style={styles.standIn}>
          {video ? null : (
            <Icon name="image" size={20} color={theme.colors.text.tertiary} />
          )}
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
  /** The item the person last went to (the stage's current item, a chat jump's picture): its tile is ringed. */
  selectedItemId?: string | null;
  /** The body's side inset: the Files pane's text edge, or a Details tab's wider one. */
  insetPx: number;
  testID?: string;
}>;


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
  const selectedItemId = props.selectedItemId ?? null;
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
                  selected={item.id === selectedItemId}
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
      selectedItemId,
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
    return <GallerySkeleton insetPx={props.insetPx} header={props.header}
      testID={props.testID ? `${props.testID}-loading` : undefined} />;
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
    gap: theme.space.s2,
    paddingVertical: theme.space.s2,
    paddingHorizontal: theme.space.s4,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.overlay.scrim,
  },
  badgeText: {
    color: theme.colors.overlay.foreground,
    fontVariant: ['tabular-nums'],
  },
  standIn: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.s4,
    padding: theme.space.s8,
    maxWidth: '100%',
  },
}));
