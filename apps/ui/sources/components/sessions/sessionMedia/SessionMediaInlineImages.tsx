import * as React from 'react';
import {
    Image,
    Platform,
    Pressable,
    View,
    type ImageLoadEvent,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { t } from '@/text';
import { useSessionImagePreview } from '@/components/sessions/files/content/imagePreview/useSessionImagePreview';
import {
    AttachmentImagePreviewModal,
    type AttachmentImagePreviewModalImage,
} from '@/components/sessions/attachments/preview/AttachmentImagePreviewModal';
import * as FlashListCompat from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { SafeNativeSvgXml } from '@/components/ui/media/SafeNativeSvgXml';
import type { SessionMediaInlineImageSummary } from '@/sync/domains/sessionMedia/sessionMediaMessageMeta';

import { resolveSessionMediaImageMimeType, toSessionMediaPreviewImage } from './sessionMediaPresentation';
import { Icon } from '@/components/ui/icons/Icon';

const FALLBACK_THUMBNAIL_SIZE = 84;
const MAX_THUMBNAIL_WIDTH = 220;
const MAX_THUMBNAIL_HEIGHT = 160;
const DEFAULT_MAX_THUMBNAIL: ImageDimensions = { width: MAX_THUMBNAIL_WIDTH, height: MAX_THUMBNAIL_HEIGHT };
const fallbackSessionMediaMappingHelper: FlashListCompat.FlashListMappingHelper = {
    getMappingKey: (itemKey: FlashListCompat.FlashListMappingKey) => itemKey,
};

function useSessionMediaMappingHelper(): FlashListCompat.FlashListMappingHelper {
    return typeof FlashListCompat.useMappingHelper === 'function'
        ? FlashListCompat.useMappingHelper()
        : fallbackSessionMediaMappingHelper;
}

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
}));

type ImageDimensions = Readonly<{
    width: number;
    height: number;
}>;

function readPositiveDimension(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : null;
}

function resolveImageDimensions(value: Readonly<{ width?: number; height?: number }> | null): ImageDimensions | null {
    const width = readPositiveDimension(value?.width);
    const height = readPositiveDimension(value?.height);
    return width && height ? { width, height } : null;
}

function resolveThumbnailSize(dimensions: ImageDimensions | null, max: ImageDimensions = DEFAULT_MAX_THUMBNAIL): ImageDimensions {
    if (!dimensions) {
        return {
            width: FALLBACK_THUMBNAIL_SIZE,
            height: FALLBACK_THUMBNAIL_SIZE,
        };
    }

    const scale = Math.min(
        max.width / dimensions.width,
        max.height / dimensions.height,
    );
    return {
        width: Math.max(1, Math.round(dimensions.width * scale)),
        height: Math.max(1, Math.round(dimensions.height * scale)),
    };
}

function resolveSessionMediaAccessibilityLabel(media: SessionMediaInlineImageSummary): string {
    const accessibleName = (media.description ?? media.name).slice(0, 512);
    if (media.category === 'attachment') {
        return t('files.sessionMedia.attachmentImageA11y', { name: accessibleName });
    }
    if (media.category === 'tool-artifact') {
        return t('files.sessionMedia.toolArtifactImageA11y', { name: accessibleName });
    }
    return t('files.sessionMedia.generatedImageA11y', { name: accessibleName });
}

export function SessionMediaInlineImagePreviewTile(props: Readonly<{
    sessionId: string;
    media: SessionMediaInlineImageSummary;
    mimeType: string;
    imageIndex: number;
    onOpenPath: (path: string) => void;
    fileOpenEnabled: boolean;
    onOpenPreview: (index: number) => void;
    imageTestIDPrefix: string;
    previewTestIDPrefix: string;
    /** Largest thumbnail to draw; the transcript default unless a host (the grid) has a smaller cell. */
    maxThumbnailSize?: Readonly<{ width: number; height: number }>;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const metadataDimensions = resolveImageDimensions(props.media);
    const [loadedDimensions, setLoadedDimensions] = React.useState<ImageDimensions | null>(null);
    const thumbnailSize = resolveThumbnailSize(metadataDimensions ?? loadedDimensions, props.maxThumbnailSize);

    React.useEffect(() => {
        setLoadedDimensions(null);
    }, [props.media.path, props.media.sha256]);

    const handleImageLoad = React.useCallback((event: ImageLoadEvent) => {
        const dimensions = resolveImageDimensions(event.nativeEvent.source);
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
        mimeType: props.mimeType,
        sizeBytes: props.media.sizeBytes,
    });
    const accessibilityLabel = resolveSessionMediaAccessibilityLabel(props.media);

    return (
        <Pressable
            testID={`${props.imageTestIDPrefix}:${props.media.path}`}
            accessibilityRole="imagebutton"
            accessibilityLabel={accessibilityLabel}
            onPress={() => {
                if (preview.status === 'error') {
                    if (props.fileOpenEnabled) {
                        props.onOpenPath(props.media.path);
                    }
                    return;
                }
                props.onOpenPreview(props.imageIndex);
            }}
            style={[styles.tile, thumbnailSize]}
        >
            {preview.status === 'loaded' ? (
                Platform.OS !== 'web' && preview.svgXml ? (
                    // SVG stays supported, but only after the daemon preview path has read an authorized session file.
                    // Never render transcript-inline XML, provider URLs, or file:// sources here.
                    <SafeNativeSvgXml xml={preview.svgXml} width="100%" height="100%" />
                ) : (
                    <Image
                        testID={`${props.previewTestIDPrefix}:${props.media.path}`}
                        source={{ uri: preview.uri }}
                        resizeMode="contain"
                        onLoad={handleImageLoad}
                        style={styles.image}
                    />
                )
            ) : (
                <View style={styles.placeholder}>
                    <Icon
                        name={preview.status === 'error' ? 'warning-circle' : 'image'}
                        size={20}
                        color={theme.colors.text.secondary}
                    />
                </View>
            )}
        </Pressable>
    );
}

function SessionMediaInlineImageInertTile(props: Readonly<{
    media: SessionMediaInlineImageSummary;
    imageTestIDPrefix: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const thumbnailSize = resolveThumbnailSize(resolveImageDimensions(props.media));

    return (
        <View
            testID={`${props.imageTestIDPrefix}:${props.media.path}`}
            accessibilityRole="image"
            accessibilityLabel={resolveSessionMediaAccessibilityLabel(props.media)}
            style={[styles.tile, thumbnailSize]}
        >
            <View style={styles.placeholder}>
                <Icon
                    name="image"
                    size={20}
                    color={theme.colors.text.secondary}
                />
            </View>
        </View>
    );
}

export const SessionMediaInlineImages = React.memo(function SessionMediaInlineImages(props: Readonly<{
    sessionId: string;
    media: readonly SessionMediaInlineImageSummary[];
    onOpenPath: (path: string) => void;
    fileOpenEnabled: boolean;
    mediaPreviewEnabled: boolean;
    containerTestID?: string;
    imageTestIDPrefix?: string;
    previewTestIDPrefix?: string;
}>) {
    const styles = stylesheet;
    const containerTestID = props.containerTestID ?? 'message-session-media-inline-images';
    const imageTestIDPrefix = props.imageTestIDPrefix ?? 'message-session-media-inline-image';
    const previewTestIDPrefix = props.previewTestIDPrefix ?? 'message-session-media-inline-image-preview';
    const { getMappingKey } = useSessionMediaMappingHelper();

    const images = React.useMemo(() => {
        const result: Array<Readonly<{
            media: SessionMediaInlineImageSummary;
            mimeType: string;
            modalImage: AttachmentImagePreviewModalImage;
        }>> = [];
        for (const media of props.media) {
            const mimeType = resolveSessionMediaImageMimeType(media);
            if (!mimeType) continue;
            result.push({
                media,
                mimeType,
                modalImage: toSessionMediaPreviewImage(props.sessionId, media, mimeType),
            });
        }
        return result;
    }, [props.media, props.sessionId]);

    if (images.length === 0) return null;

    return (
        <View testID={containerTestID} style={styles.container}>
            {images.map((entry, index) => {
                const key = getMappingKey(`${entry.media.path}:${entry.media.name}`, index);
                if (!props.mediaPreviewEnabled) {
                    return (
                        <SessionMediaInlineImageInertTile
                            key={key}
                            media={entry.media}
                            imageTestIDPrefix={imageTestIDPrefix}
                        />
                    );
                }

                return (
                    <SessionMediaInlineImagePreviewTile
                        key={key}
                        sessionId={props.sessionId}
                        media={entry.media}
                        mimeType={entry.mimeType}
                        imageIndex={index}
                        onOpenPath={props.onOpenPath}
                        fileOpenEnabled={props.fileOpenEnabled}
                        imageTestIDPrefix={imageTestIDPrefix}
                        previewTestIDPrefix={previewTestIDPrefix}
                        onOpenPreview={(imageIndex) => {
                            Modal.show({
                                component: AttachmentImagePreviewModal,
                                props: {
                                    images: images.map((imageEntry) => imageEntry.modalImage),
                                    initialIndex: imageIndex,
                                },
                            });
                        }}
                    />
                );
            })}
        </View>
    );
});
