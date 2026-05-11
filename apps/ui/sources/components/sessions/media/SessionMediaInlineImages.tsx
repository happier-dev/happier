import * as React from 'react';
import {
    Image,
    Pressable,
    View,
    type ImageLoadEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { t } from '@/text';
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
import type { SessionMediaInlineImageSummary } from '@/sync/domains/session/media/sessionMediaMessageMeta';

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

function resolveInlineImageAccessibilityLabel(media: SessionMediaInlineImageSummary): string {
    if (media.category === 'attachment') {
        return t('files.sessionMedia.attachmentImageA11y', { name: media.name });
    }
    if (media.category === 'tool-artifact') {
        return t('files.sessionMedia.toolArtifactImageA11y', { name: media.name });
    }
    return t('files.sessionMedia.generatedImageA11y', { name: media.name });
}

function SessionMediaInlineImageTile(props: Readonly<{
    sessionId: string;
    media: SessionMediaInlineImageSummary;
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

export const SessionMediaInlineImages = React.memo(function SessionMediaInlineImages(props: Readonly<{
    sessionId: string;
    media: readonly SessionMediaInlineImageSummary[];
    onOpenPath: (path: string) => void;
    testIdPrefix?: string;
}>) {
    const styles = stylesheet;
    const testIdPrefix = props.testIdPrefix ?? 'message-session-media';

    const images = React.useMemo(() => props.media.map((media): Readonly<{
        media: SessionMediaInlineImageSummary;
        modalImage: AttachmentImagePreviewModalImage;
    }> => ({
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
    })), [props.media, props.sessionId]);

    if (images.length === 0) return null;

    return (
        <View testID={`${testIdPrefix}-inline-images`} style={styles.container}>
            {images.map((entry, index) => (
                <SessionMediaInlineImageTile
                    key={`${entry.media.id}:${entry.media.path}`}
                    sessionId={props.sessionId}
                    media={entry.media}
                    imageIndex={index}
                    testIdPrefix={testIdPrefix}
                    onOpenPath={props.onOpenPath}
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
            ))}
        </View>
    );
});
