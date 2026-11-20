import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { Typography } from '@/constants/Typography';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { FlashList } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { AttachmentImagePreviewModal } from '@/components/sessions/attachments/preview/AttachmentImagePreviewModal';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useSessionMediaItems } from '@/hooks/session/files/useSessionMediaItems';
import type { SessionMediaGalleryItem } from '@/sync/domains/sessionMedia/collectSessionMediaItems';

import { SessionMediaInlineImagePreviewTile } from './SessionMediaInlineImages';
import { resolveSessionMediaImageMimeType, toSessionMediaPreviewImage } from './sessionMediaPresentation';

const PAGE_SIZE = 8;
const MIN_CELL_WIDTH = 150;
const CELL_HEIGHT = 200;

const stylesheet = StyleSheet.create((theme) => ({
    root: { flex: 1 },
    cell: {
        height: CELL_HEIGHT,
        paddingHorizontal: 6,
        paddingVertical: 6,
        gap: 6,
        alignItems: 'center',
    },
    thumbnailArea: {
        flex: 1,
        alignSelf: 'stretch',
        alignItems: 'center',
        justifyContent: 'center',
    },
    fileTile: {
        alignSelf: 'stretch',
        flex: 1,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: 8,
    },
    caption: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    jump: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingVertical: 2,
    },
    loading: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 24,
        paddingVertical: 12,
    },
    footerButton: {
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
    },
}));

type MediaGridEntry = Readonly<{
    kind: 'media';
    item: SessionMediaGalleryItem;
    /** Present for images only; non-images open as files. */
    imageMimeType: string | null;
    imageIndex: number;
}>;

/** Trailing "?" tile: older history has not been ruled out, so there may be more media. */
type UnknownGridEntry = Readonly<{ kind: 'unknown' }>;

type GridEntry = MediaGridEntry | UnknownGridEntry;

export const SessionMediaGrid = React.memo(function SessionMediaGrid(props: Readonly<{
    sessionId: string;
    onOpenFile: (path: string) => void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    // Start small: older history is only paged in as far as the shown count needs, and fully on "Show all".
    const [limit, setLimit] = React.useState<number | null>(PAGE_SIZE);
    const { items, isLoaded, isLoadingHistory, historyExhausted } = useSessionMediaItems(props.sessionId, true, limit);
    const visibleItems = React.useMemo(() => (limit === null ? items : items.slice(0, limit)), [items, limit]);
    const hasMore = !historyExhausted || items.length > visibleItems.length;
    // Unsure (rather than known) that more exists: everything loaded is shown and history is not exhausted.
    const showUnknownTile = !historyExhausted && visibleItems.length === items.length;
    const showMore = React.useCallback(() => {
        setLimit((current) => (current === null ? null : current + PAGE_SIZE));
    }, []);
    const navigateToSession = useNavigateToSession();
    const [width, setWidth] = React.useState(0);
    const columns = Math.max(2, Math.floor(width / MIN_CELL_WIDTH));

    const { entries, previewImages } = React.useMemo(() => {
        const result: GridEntry[] = [];
        const images: ReturnType<typeof toSessionMediaPreviewImage>[] = [];
        for (const item of visibleItems) {
            const imageMimeType = resolveSessionMediaImageMimeType(item.media);
            result.push({ kind: 'media', item, imageMimeType, imageIndex: imageMimeType ? images.length : -1 });
            if (imageMimeType) images.push(toSessionMediaPreviewImage(props.sessionId, item.media, imageMimeType));
        }
        if (showUnknownTile) result.push({ kind: 'unknown' });
        return { entries: result, previewImages: images };
    }, [visibleItems, props.sessionId, showUnknownTile]);

    const openPreview = React.useCallback((index: number) => {
        Modal.show({
            component: AttachmentImagePreviewModal,
            props: { images: previewImages, initialIndex: index },
        });
    }, [previewImages]);

    const renderItem = React.useCallback(({ item: entry }: Readonly<{ item: GridEntry }>) => {
        if (entry.kind === 'unknown') {
            return (
                <View style={styles.cell}>
                    <Pressable
                        testID="session-media-grid-unknown"
                        accessibilityRole="button"
                        accessibilityLabel={t('files.sessionMedia.showMore')}
                        onPress={showMore}
                        style={styles.fileTile}
                    >
                        <Icon name="question" size={96} weight="bold" color={theme.colors.text.primary} />
                    </Pressable>
                </View>
            );
        }
        const { media, seq, messageId } = entry.item;
        return (
            <View style={styles.cell}>
                <View style={styles.thumbnailArea}>
                    {entry.imageMimeType ? (
                        <SessionMediaInlineImagePreviewTile
                            sessionId={props.sessionId}
                            media={media}
                            mimeType={entry.imageMimeType}
                            imageIndex={entry.imageIndex}
                            onOpenPath={props.onOpenFile}
                            fileOpenEnabled
                            onOpenPreview={openPreview}
                            imageTestIDPrefix="session-media-grid-image"
                            previewTestIDPrefix="session-media-grid-image-preview"
                        />
                    ) : (
                        <Pressable
                            testID={`session-media-grid-file:${media.path}`}
                            accessibilityRole="button"
                            accessibilityLabel={media.name}
                            onPress={() => props.onOpenFile(media.path)}
                            style={styles.fileTile}
                        >
                            <Icon name="file" size={28} color={theme.colors.text.secondary} />
                            <Text numberOfLines={2} style={styles.caption}>{media.name}</Text>
                        </Pressable>
                    )}
                </View>
                {seq !== null ? (
                    <Pressable
                        testID={`session-media-grid-jump:${messageId}`}
                        accessibilityRole="button"
                        accessibilityLabel={t('files.sessionMedia.jumpToMessage')}
                        onPress={() => { void navigateToSession(props.sessionId, { query: { jumpSeq: seq } }); }}
                        style={styles.jump}
                    >
                        <Icon name="chats-circle" size={14} color={theme.colors.text.link} />
                        <Text style={[styles.caption, { color: theme.colors.text.link }]}>
                            {t('files.sessionMedia.jumpToMessage')}
                        </Text>
                    </Pressable>
                ) : null}
            </View>
        );
    }, [navigateToSession, openPreview, props.onOpenFile, props.sessionId, showMore, styles, theme.colors.text.link, theme.colors.text.primary, theme.colors.text.secondary]);

    if (isLoaded && !isLoadingHistory && visibleItems.length === 0) {
        return (
            <View testID="session-media-grid-empty" style={styles.empty}>
                <Text style={styles.caption}>{t('files.sessionMedia.empty')}</Text>
            </View>
        );
    }

    return (
        <View
            testID="session-media-grid"
            style={styles.root}
            onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        >
            {isLoadingHistory ? (
                <View testID="session-media-grid-loading" style={styles.loading}>
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    <Text style={styles.caption}>{t('common.loading')}</Text>
                </View>
            ) : null}
            {width > 0 ? (
                <FlashList
                    key={columns}
                    data={entries}
                    numColumns={columns}
                    keyExtractor={(entry: GridEntry) => (entry.kind === 'unknown' ? 'unknown' : entry.item.key)}
                    renderItem={renderItem}
                    estimatedItemSize={CELL_HEIGHT}
                    ListFooterComponent={hasMore ? (
                        <View style={styles.footer}>
                            <Pressable
                                testID="session-media-grid-show-more"
                                accessibilityRole="button"
                                onPress={showMore}
                                style={styles.footerButton}
                            >
                                <Text style={[styles.caption, { color: theme.colors.text.link }]}>{t('files.sessionMedia.showMore')}</Text>
                            </Pressable>
                            <Pressable
                                testID="session-media-grid-show-all"
                                accessibilityRole="button"
                                onPress={() => setLimit(null)}
                                style={styles.footerButton}
                            >
                                <Text style={[styles.caption, { color: theme.colors.text.link }]}>{t('files.sessionMedia.showAll')}</Text>
                            </Pressable>
                        </View>
                    ) : null}
                />
            ) : null}
        </View>
    );
});
