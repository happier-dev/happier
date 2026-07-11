import * as React from 'react';
import { Image, Pressable, View, type ImageLoadEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { useSessionImagePreview } from '@/components/sessions/files/content/imagePreview/useSessionImagePreview';
import {
    AttachmentImagePreviewModal,
    type AttachmentImagePreviewModalImage,
} from '@/components/sessions/attachments/preview/AttachmentImagePreviewModal';
import {
    resolveSessionMediaInlineImageDimensions,
    resolveSessionMediaInlineImageLayout,
    type SessionMediaInlineImageDimensions,
} from '@/components/sessions/media/resolveSessionMediaInlineImageLayout';
import type {
    SessionMediaInlineImageAvailableSummary,
    SessionMediaInlineMediaSummary,
    SessionMediaInlineImageSummary,
    SessionMediaInlineImageUnavailableSummary,
    SessionMediaInlineVideoAvailableSummary,
} from '@/sync/domains/session/media/sessionMediaMessageMeta';

type SessionMediaInlineRenderableSummary =
    | SessionMediaInlineImageSummary
    | SessionMediaInlineMediaSummary;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        marginTop: 2,
        marginBottom: 7,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    tile: {
        borderRadius: 12,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
    },
    image: {
        width: '100%',
        height: '100%',
    },
    placeholder: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.elevated,
    },
    unavailableText: {
        marginTop: 6,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    videoLabel: {
        marginTop: 6,
        color: theme.colors.text.secondary,
        textAlign: 'center',
        paddingHorizontal: 8,
    },
}));

function isUnavailableInlineImage(
    media: SessionMediaInlineRenderableSummary,
): media is SessionMediaInlineImageUnavailableSummary {
    return media.status === 'unavailable';
}

function isInlineVideo(
    media: SessionMediaInlineRenderableSummary,
): media is SessionMediaInlineVideoAvailableSummary {
    return 'mediaKind' in media && media.mediaKind === 'video';
}

function resolveInlineImageAccessibilityLabel(media: SessionMediaInlineImageSummary): string {
    if (media.category === 'attachment') {
        return t('files.sessionMedia.attachmentImageA11y', { name: media.name });
    }
    if (media.category === 'tool-artifact') {
        return t('files.sessionMedia.toolArtifactImageA11y', { name: media.name });
    }
    return t('files.sessionMedia.generatedImageA11y', { name: media.name });
}

function resolveInlineVideoAccessibilityLabel(media: SessionMediaInlineVideoAvailableSummary): string {
    if (media.category === 'attachment') {
        return t('files.sessionMedia.attachmentVideoA11y', { name: media.name });
    }
    if (media.category === 'tool-artifact') {
        return t('files.sessionMedia.toolArtifactVideoA11y', { name: media.name });
    }
    return t('files.sessionMedia.generatedVideoA11y', { name: media.name });
}

function SessionMediaInlineVideoPreview(props: Readonly<{
    uri: string;
    accessibilityLabel: string;
}>): React.ReactElement {
    const player = useVideoPlayer(props.uri, (instance: VideoPlayer) => {
        instance.loop = false;
        instance.muted = true;
        instance.allowsExternalPlayback = false;
        instance.timeUpdateEventInterval = 0;
    });

    React.useEffect(() => {
        player.loop = false;
        player.muted = true;
        player.allowsExternalPlayback = false;
        player.timeUpdateEventInterval = 0;
    }, [player]);

    React.useEffect(() => () => {
        try { player.pause(); } catch {}
    }, [player]);

    return (
        <VideoView
            player={player}
            style={{ width: '100%', height: '100%' }}
            contentFit="contain"
            nativeControls={false}
            allowsPictureInPicture={false}
            accessibilityLabel={props.accessibilityLabel}
        />
    );
}

function SessionMediaInlineVideoTile(props: Readonly<{
    sessionId: string;
    media: SessionMediaInlineVideoAvailableSummary;
    testIdPrefix: string;
    onOpenPath: (path: string) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const preview = useSessionImagePreview({
        sessionId: props.sessionId,
        filePath: props.media.path,
        enabled: true,
        cacheKey: props.media.sha256 ?? null,
        mimeType: props.media.mimeType,
        sizeBytes: props.media.sizeBytes,
    });
    const accessibilityLabel = resolveInlineVideoAccessibilityLabel(props.media);

    return (
        <Pressable
            testID={`${props.testIdPrefix}-inline-video:${props.media.path}`}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityHint={preview.status === 'error'
                ? t('files.sessionMedia.previewUnavailableA11y')
                : undefined}
            onPress={() => props.onOpenPath(props.media.path)}
            style={[styles.tile, { width: 168, height: 104 }]}
        >
            {preview.status === 'loaded' ? (
                <SessionMediaInlineVideoPreview
                    uri={preview.uri}
                    accessibilityLabel={accessibilityLabel}
                />
            ) : (
                <View style={styles.placeholder}>
                    <Ionicons
                        name={preview.status === 'error' ? 'alert-circle-outline' : 'videocam-outline'}
                        size={24}
                        color={theme.colors.text.secondary}
                    />
                    <Text style={styles.videoLabel} numberOfLines={2}>
                        {props.media.name}
                    </Text>
                </View>
            )}
        </Pressable>
    );
}

function SessionMediaInlineImageTile(props: Readonly<{
    sessionId: string;
    media: SessionMediaInlineImageAvailableSummary;
    imageIndex: number;
    testIdPrefix: string;
    onOpenPath: (path: string) => void;
    onOpenPreview: (index: number) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [loadedDimensions, setLoadedDimensions] = React.useState<SessionMediaInlineImageDimensions | null>(null);
    const thumbnailSize = resolveSessionMediaInlineImageLayout({
        persistedDimensions: props.media,
        loadedDimensions,
    });

    React.useEffect(() => {
        setLoadedDimensions(null);
    }, [props.media.path, props.media.sha256]);

    const handleImageLoad = React.useCallback((event: ImageLoadEvent) => {
        const dimensions = resolveSessionMediaInlineImageDimensions(event.nativeEvent.source);
        if (!dimensions) return;
        setLoadedDimensions((current) => (
            current?.width === dimensions.width && current.height === dimensions.height
                ? current
                : dimensions
        ));
    }, []);

    const preview = useSessionImagePreview({
        sessionId: props.sessionId,
        filePath: props.media.path,
        enabled: true,
        cacheKey: props.media.sha256 ?? null,
        mimeType: props.media.mimeType,
        sizeBytes: props.media.sizeBytes,
    });

    return (
        <Pressable
            testID={`${props.testIdPrefix}-inline-image:${props.media.path}`}
            accessibilityRole="button"
            accessibilityLabel={resolveInlineImageAccessibilityLabel(props.media)}
            accessibilityHint={preview.status === 'error'
                ? t('files.sessionMedia.previewUnavailableA11y')
                : undefined}
            onPress={() => {
                if (preview.status === 'error') {
                    props.onOpenPath(props.media.path);
                    return;
                }
                props.onOpenPreview(props.imageIndex);
            }}
            style={[styles.tile, thumbnailSize]}
        >
            {preview.status === 'loaded' ? (
                <Image
                    testID={`${props.testIdPrefix}-inline-image-preview:${props.media.path}`}
                    source={{ uri: preview.uri }}
                    resizeMode="contain"
                    onLoad={handleImageLoad}
                    style={styles.image}
                />
            ) : (
                <View style={styles.placeholder}>
                    <Ionicons
                        name={preview.status === 'error' ? 'alert-circle-outline' : 'image-outline'}
                        size={22}
                        color={theme.colors.text.secondary}
                    />
                </View>
            )}
        </Pressable>
    );
}

function SessionMediaUnavailableInlineImageTile(props: Readonly<{
    media: SessionMediaInlineImageUnavailableSummary;
    testIdPrefix: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    return (
        <View
            testID={`${props.testIdPrefix}-inline-image-unavailable:${props.media.id}`}
            accessibilityRole="image"
            accessibilityLabel={t('files.sessionMedia.unavailableImageA11y', { name: props.media.name })}
            style={[styles.tile, styles.placeholder, { width: 84, height: 84 }]}
        >
            <Ionicons
                name="alert-circle-outline"
                size={22}
                color={theme.colors.text.secondary}
            />
            <Text style={styles.unavailableText} numberOfLines={2}>
                {t('files.sessionMedia.previewUnavailableA11y')}
            </Text>
        </View>
    );
}

export const SessionMediaInlineImages = React.memo(function SessionMediaInlineImages(props: Readonly<{
    sessionId: string;
    media: readonly SessionMediaInlineRenderableSummary[];
    onOpenPath: (path: string) => void;
    testIdPrefix?: string;
}>) {
    const styles = stylesheet;
    const testIdPrefix = props.testIdPrefix ?? 'message-session-media';

    const images = React.useMemo(() => {
        let nextModalIndex = 0;
        return props.media.map((media): Readonly<{
            media: SessionMediaInlineRenderableSummary;
            modalImage: AttachmentImagePreviewModalImage | null;
            modalIndex: number | null;
        }> => {
            if (isUnavailableInlineImage(media) || isInlineVideo(media)) {
                return {
                    media,
                    modalImage: null,
                    modalIndex: null,
                };
            }

            const modalIndex = nextModalIndex;
            nextModalIndex += 1;
            return {
                media,
                modalImage: {
                    kind: 'session-image',
                    title: media.name,
                    sessionId: props.sessionId,
                    filePath: media.path,
                    mimeType: media.mimeType,
                    sizeBytes: media.sizeBytes,
                    cacheKey: media.sha256 ?? null,
                },
                modalIndex,
            };
        });
    }, [props.media, props.sessionId]);

    if (images.length === 0) return null;

    return (
        <View testID={`${testIdPrefix}-inline-images`} style={styles.container}>
            {images.map((entry, index) => (
                isUnavailableInlineImage(entry.media) ? (
                    <SessionMediaUnavailableInlineImageTile
                        key={entry.media.id}
                        media={entry.media}
                        testIdPrefix={testIdPrefix}
                    />
                ) : isInlineVideo(entry.media) ? (
                    <SessionMediaInlineVideoTile
                        key={`${entry.media.id}:${entry.media.path}`}
                        sessionId={props.sessionId}
                        media={entry.media}
                        testIdPrefix={testIdPrefix}
                        onOpenPath={props.onOpenPath}
                    />
                ) : (
                    <SessionMediaInlineImageTile
                        key={`${entry.media.id}:${entry.media.path}`}
                        sessionId={props.sessionId}
                        media={entry.media}
                        imageIndex={entry.modalIndex ?? 0}
                        testIdPrefix={testIdPrefix}
                        onOpenPath={props.onOpenPath}
                        onOpenPreview={(imageIndex) => {
                            const modalImages = images.flatMap((imageEntry) => (
                                imageEntry.modalImage ? [imageEntry.modalImage] : []
                            ));
                            Modal.show({
                                component: AttachmentImagePreviewModal,
                                props: {
                                    images: modalImages,
                                    initialIndex: Math.min(imageIndex, Math.max(0, modalImages.length - 1)),
                                },
                            });
                        }}
                    />
                )
            ))}
        </View>
    );
});
