import * as React from 'react';
import { Image, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Icon } from '@/components/ui/icons/Icon';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { Text } from '@/components/ui/text/Text';
import { VirtualizedList, type VirtualizedListRef, type VirtualizedListRenderItem } from '@/components/ui/lists/virtualized';
import { formatPlaybackTime } from '@/components/workspaces/files/file/filePageMediaFacts';
import type { NativeCaptureError, NativeRecentCaptureEntry, NativeRecentCaptureFolder } from '@/desktop/capture/nativeCapture';
import { t } from '@/text';
import { leafFolderName } from '@/utils/path/pathUtils';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';

import { useRecentCaptures, type RecentCaptureConsumer } from './useRecentCaptures';
import { readRecentCaptureThumbnail, useRecentCaptureThumbnail, type RecentCaptureThumbnailReader } from './thumbnail';
export type { RecentCaptureThumbnail, RecentCaptureThumbnailReader } from './thumbnail';

/** Lab `rc` REC: three tiles across; a tile's picture is 96 pt tall. */
const COLUMNS = 3;
const THUMBNAIL_HEIGHT = 96;

const Tile = React.memo(function Tile(props: Readonly<{
    entry: NativeRecentCaptureEntry;
    now: number;
    selected: boolean;
    readThumbnail: RecentCaptureThumbnailReader;
    index: number;
    onHover: (index: number) => void;
    onChoose: (entry: NativeRecentCaptureEntry) => void;
}>) {
    const { theme } = useUnistyles();
    const { entry, readThumbnail: read } = props;
    const [visible, setVisible] = React.useState(false);
    const thumbnail = useRecentCaptureThumbnail(entry, read, visible);
    const place = React.useRef<View>(null);
    // A tile reads its picture the first time it scrolls into view, so a long folder costs what is seen.
    React.useEffect(() => {
        const node = place.current as unknown as Element | null;
        if (!node) return;
        const observer = new IntersectionObserver(([seen]) => {
            if (!seen?.isIntersecting) return;
            observer.disconnect();
            setVisible(true);
        });
        observer.observe(node);
        return () => { observer.disconnect(); };
    }, []);
    return (
        <HappierPressable
            accessibilityRole="button"
            accessibilityLabel={entry.name}
            onPress={() => props.onChoose(entry)}
            style={styles.tile}
            testID={`recent-capture-${entry.name}`}
        >
            <View ref={place} collapsable={false} {...({ onPointerEnter: () => props.onHover(props.index) } as object)} style={[styles.thumbnail, props.selected ? styles.thumbnailSelected : null]}>
                {thumbnail ? <Image source={{ uri: thumbnail.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
                {thumbnail?.durationSeconds !== undefined ? (
                    <View style={styles.duration}>
                        <Icon name="play" weight="fill" size={10} color={theme.colors.overlay.foreground} />
                        <Text variant="micro" emphasis="semiBold" style={styles.durationText}>{formatPlaybackTime(thumbnail.durationSeconds)}</Text>
                    </View>
                ) : null}
            </View>
            <View>
                <Text variant="meta" emphasis="medium" numberOfLines={1} style={styles.name}>{entry.name}</Text>
                {entry.modifiedAt ? <Text variant="meta" numberOfLines={1} style={styles.age}>{formatShortRelativeTimeAt(entry.modifiedAt, props.now)}</Text> : null}
            </View>
        </HappierPressable>
    );
});

/** The grid on the capture folders themselves. */
export function RecentCaptureGrid(props: Readonly<{
    maxHeight: number;
    onChoose: RecentCaptureConsumer;
}>) {
    const recent = useRecentCaptures();
    const { choose, chooseFile } = recent;
    const onChoose = React.useCallback((entry: NativeRecentCaptureEntry) => { void choose(entry, props.onChoose); }, [choose, props.onChoose]);
    return (
        <RecentCaptureGridView
            {...props}
            onChoose={onChoose}
            entries={recent.entries}
            folders={recent.folders}
            status={recent.status}
            refreshing={recent.refreshing || recent.choosing}
            error={recent.error}
            onRefresh={() => void recent.refresh()}
            onChooseFile={() => void chooseFile(props.onChoose)}
            onChooseFolder={() => void recent.chooseFolder()}
            readThumbnail={readRecentCaptureThumbnail}
        />
    );
}

/** Attach recent capture (lab `rc` REC): a grid, newest first, with durations on recordings. */
export function RecentCaptureGridView(props: Readonly<{
    maxHeight: number;
    entries: readonly NativeRecentCaptureEntry[];
    folders: readonly NativeRecentCaptureFolder[];
    /** The folder owner's read: first read pending, settled, or failed (entries may still be last-known). */
    status?: 'loading' | 'ready' | 'error';
    refreshing?: boolean;
    error?: NativeCaptureError | null;
    readThumbnail: RecentCaptureThumbnailReader;
    onChoose: (entry: NativeRecentCaptureEntry) => void;
    onRefresh?: () => void;
    onChooseFile?: () => void;
    onChooseFolder?: () => void;
    onShowFolder?: () => void;
}>) {
    const { entries, folders } = props;
    const { theme } = useUnistyles();
    const folderNames = folders.map(({ path }) => leafFolderName(path) ?? path);
    const failed = props.status === 'error';
    const [selected, setSelected] = React.useState(0);
    const [now] = React.useState(() => Date.now());
    const list = React.useRef<VirtualizedListRef>(null);
    const rows = React.useMemo(() => {
        const groups: (readonly NativeRecentCaptureEntry[])[] = [];
        for (let index = 0; index < entries.length; index += COLUMNS) groups.push(entries.slice(index, index + COLUMNS));
        return groups;
    }, [entries]);
    const renderRow = React.useCallback<VirtualizedListRenderItem<readonly NativeRecentCaptureEntry[]>>(({ item, index }) => (
        <View style={styles.rows}>
            {item.map((entry, column) => (
                <Tile key={entry.path} entry={entry} now={now} selected={index * COLUMNS + column === selected}
                    index={index * COLUMNS + column} readThumbnail={props.readThumbnail} onHover={setSelected} onChoose={props.onChoose} />
            ))}
        </View>
    ), [now, selected, props.readThumbnail, props.onChoose]);
    const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
        const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }[event.key];
        if (step !== undefined) {
            event.preventDefault();
            const next = Math.max(0, Math.min(entries.length - 1, selected + step));
            setSelected(next);
            void list.current?.scrollToIndex({ index: Math.floor(next / COLUMNS), animated: false });
        } else if (event.key === 'Enter' && entries[selected]) {
            event.preventDefault();
            props.onChoose(entries[selected]!);
        }
    };
    return (
        <View style={[styles.root, { maxHeight: props.maxHeight }]} aria-label={t('screenCapture.recent.title')} {...({ role: 'listbox', tabIndex: 0, onKeyDown } as object)} testID="recent-captures-grid">
            <View style={styles.header}>
                <Text variant="body" emphasis="medium" style={styles.title}>{t('screenCapture.recent.title')}</Text>
                <View style={styles.headerFacts}>
                    {props.refreshing ? <ActivitySpinner size={14} color={theme.colors.text.tertiary} /> : null}
                    <Text variant="body" numberOfLines={1} style={styles.folders}>{folderNames.join(' · ')}</Text>
                </View>
            </View>
            {/* One line per folder that can't be shown in full; last-known captures stay below it. */}
            {folders.map((folder) => folder.issue ? (
                <SurfaceStateCard key={folder.path} size="line" kind="warning" testID={`recent-captures-folder-${folder.issue}`}
                    title={folderIssueLine(folder.issue, leafFolderName(folder.path) ?? folder.path)} />
            ) : null)}
            {/* The error names no operation: a refresh, a chosen file or an attach can each fail here, and the list stands. */}
            {failed && entries.length > 0 ? (
                <SurfaceStateCard size="line" kind="error" title={t('screenCapture.recent.operationFailed')} diagnosticCode={props.error?.code ?? null}
                    {...(props.onRefresh ? { action: { label: t('screenCapture.recent.refresh'), onPress: props.onRefresh } } : {})} />
            ) : null}
            {entries.length === 0 ? (
                <View style={[styles.empty, styles.body, { height: props.maxHeight }]} testID={`recent-captures-${props.status ?? 'ready'}`}>
                    {props.status === 'loading' ? (
                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    ) : failed ? (
                        <SurfaceStateCard kind="error" title={t('screenCapture.recent.loadFailed')} diagnosticCode={props.error?.code ?? null}
                            {...(props.onRefresh ? { action: { label: t('screenCapture.recent.refresh'), onPress: props.onRefresh } } : {})} />
                    ) : (
                        <SurfaceStateCard kind="empty" iconName="image" title={t('screenCapture.recent.empty')}
                            {...(props.onChooseFolder ? { action: { label: t('screenCapture.recent.chooseFolder'), onPress: props.onChooseFolder } } : {})} />
                    )}
                </View>
            ) : (
                <VirtualizedList ref={list} data={rows} renderItem={renderRow} extraData={selected}
                    recycleItems={false}
                    keyExtractor={row => row[0]!.path} estimatedItemSize={THUMBNAIL_HEIGHT + 54}
                    style={[styles.body, { height: props.maxHeight }]} />
            )}
            <View style={styles.footer}>
                {entries.length > 0 ? <View style={styles.key}><KeyHint label="↩" /><Text variant="meta" style={styles.age}>{t('screenCapture.recent.attach')}</Text></View> : null}
                <View style={styles.grow} />
                {props.onRefresh && !failed ? <TextLinkButton size="meta" verticalReach={0} label={t('screenCapture.recent.refresh')} onPress={props.onRefresh} testID="recent-captures-refresh" /> : null}
                {props.onChooseFile ? <TextLinkButton size="meta" verticalReach={0} label={t('screenCapture.recent.chooseFile')} onPress={props.onChooseFile} testID="recent-captures-choose-file" /> : null}
                {props.onChooseFolder ? <TextLinkButton size="meta" verticalReach={0} label={t('screenCapture.recent.chooseFolder')} onPress={props.onChooseFolder} testID="recent-captures-choose-folder" /> : null}
                {props.onShowFolder ? <TextLinkButton size="meta" verticalReach={0} label={t('screenCapture.window.showInFolder')} onPress={props.onShowFolder} /> : null}
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: {
        gap: theme.space.s8,
    },
    // The grid's whole surface fits its bound: the header and actions keep their rows, the captures give way.
    body: {
        flexGrow: 0,
        flexShrink: 1,
        minHeight: 0,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s8,
        paddingTop: theme.space.s6,
    },
    title: {
        color: theme.colors.text.primary,
    },
    headerFacts: {
        flexShrink: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    folders: {
        color: theme.colors.text.tertiary,
        flexShrink: 1,
    },
    rows: {
        display: 'grid',
        gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))`,
        gap: theme.space.s10,
        paddingHorizontal: theme.space.s8,
        paddingBottom: theme.space.s10,
    } as never,
    tile: {
        gap: theme.space.s6,
    },
    thumbnail: {
        height: THUMBNAIL_HEIGHT,
        borderRadius: theme.borderRadius.lg,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.inset,
        borderWidth: 1,
        borderColor: theme.colors.border.surface,
    },
    thumbnailSelected: {
        borderWidth: 2,
        borderColor: theme.colors.border.focus,
    },
    duration: {
        position: 'absolute',
        right: theme.space.s6,
        bottom: theme.space.s6,
        height: 20,
        borderRadius: 10,
        paddingHorizontal: theme.space.s6,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        backgroundColor: theme.colors.overlay.scrim,
    },
    durationText: {
        color: theme.colors.overlay.foreground,
        fontVariant: ['tabular-nums'],
    },
    name: {
        color: theme.colors.text.primary,
    },
    age: {
        color: theme.colors.text.secondary,
    },
    empty: {
        padding: theme.space.s24,
        alignItems: 'center',
        justifyContent: 'center',
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s8,
        paddingTop: theme.space.s8,
        paddingBottom: theme.space.s4,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.surface,
    },
    key: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    grow: {
        flex: 1,
    },
}));

function folderIssueLine(issue: NonNullable<NativeRecentCaptureFolder['issue']>, folder: string): string {
    switch (issue) {
        case 'missing': return t('screenCapture.recent.folderMissing', { folder });
        case 'denied': return t('screenCapture.recent.folderDenied', { folder });
        case 'read_failed': return t('screenCapture.recent.folderUnreadable', { folder });
        case 'watch_unavailable': return t('screenCapture.recent.folderNotWatched', { folder });
    }
}
