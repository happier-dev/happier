import * as React from 'react';
import type { ComposerContentHandleV1 } from '@happier-dev/protocol';
import { Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useSessionImagePreview } from '@/components/sessions/files/content/imagePreview/useSessionImagePreview';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';

export type AttachmentImagePreviewModalImage =
    | Readonly<{
        kind: 'direct';
        uri: string;
        title: string;
    }>
    | Readonly<{
        kind: 'session-image';
        title: string;
        sessionId: string;
        filePath: string;
        mimeType?: string;
        sizeBytes?: number;
        cacheKey?: string | null;
    }>
    | Readonly<{
        /** Draft-only opaque stage; the preview hook owns any temporary URI. */
        kind: 'composer-staged-image';
        title: string;
        handle: ComposerContentHandleV1;
    }>;

type AttachmentImagePreviewModalProps = CustomModalInjectedProps & Readonly<{
    images: ReadonlyArray<AttachmentImagePreviewModalImage>;
    initialIndex?: number;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        flex: 1,
        backgroundColor: theme.colors.surface.inset,
    },
    imageSurface: {
        flex: 1,
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.elevated,
    },
    image: {
    },
    centeredState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        paddingHorizontal: 24,
    },
    centeredStateText: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        textAlign: 'center',
        ...Typography.default('regular'),
    },
    navButton: {
        position: 'absolute',
        top: '50%',
        marginTop: -22,
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 999,
        backgroundColor: theme.colors.overlay.scrim,
        zIndex: 1,
    },
    navButtonLeft: {
        left: 16,
    },
    navButtonRight: {
        right: 16,
    },
    navButtonDisabled: {
        opacity: 0.35,
    },
    navButtonIdle: {
        opacity: 0.65,
    },
}));

function AttachmentImagePreviewCurrentImage(props: Readonly<{
    image: AttachmentImagePreviewModalImage;
    accessibilityLabel: string;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const sessionImage = props.image.kind === 'session-image' ? props.image : null;
    const composerStagedImage = props.image.kind === 'composer-staged-image' ? props.image : null;
    const preview = useSessionImagePreview({
        sessionId: sessionImage?.sessionId ?? '',
        filePath: sessionImage?.filePath ?? composerStagedImage?.handle.name ?? '',
        enabled: sessionImage !== null || composerStagedImage !== null,
        cacheKey: sessionImage?.cacheKey ?? composerStagedImage?.handle.sha256 ?? null,
        mimeType: sessionImage?.mimeType ?? composerStagedImage?.handle.mimeType ?? null,
        sizeBytes: sessionImage?.sizeBytes ?? composerStagedImage?.handle.sizeBytes ?? null,
        composerStagedMedia: composerStagedImage?.handle ?? null,
    });

    if (props.image.kind === 'direct') {
        return (
            <Image
                accessibilityRole="image"
                accessibilityLabel={props.accessibilityLabel}
                source={{ uri: props.image.uri }}
                style={[{ width: '100%', height: '100%' }, styles.image]}
                contentFit="contain"
            />
        );
    }

    if (preview.status === 'loaded') {
        return (
            <Image
                accessibilityRole="image"
                accessibilityLabel={props.accessibilityLabel}
                source={{ uri: preview.uri }}
                style={[{ width: '100%', height: '100%' }, styles.image]}
                contentFit="contain"
            />
        );
    }

    if (preview.status === 'error') {
        return (
            <View style={styles.centeredState}>
                <Icon name="warning-circle" size={29} color={theme.colors.text.secondary} />
                <Text style={styles.centeredStateText}>{t('common.error')}</Text>
            </View>
        );
    }

    return (
        <View style={styles.centeredState}>
            <ActivitySpinner size="small" color={theme.colors.text.secondary} />
        </View>
    );
}

function resolvePreviewImageAccessibilityLabel(
    image: AttachmentImagePreviewModalImage,
    index: number,
    total: number,
): string {
    return t('files.sessionMedia.previewImageA11y', {
        name: image.title,
        current: index + 1,
        total,
    });
}

export const AttachmentImagePreviewModal = React.memo(function AttachmentImagePreviewModal(props: AttachmentImagePreviewModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { width, height } = useWindowDimensions();
    const clampedInitialIndex = React.useMemo(() => {
        if (props.images.length === 0) return 0;
        const raw = typeof props.initialIndex === 'number' ? props.initialIndex : 0;
        return Math.max(0, Math.min(raw, props.images.length - 1));
    }, [props.images, props.initialIndex]);
    const [currentIndex, setCurrentIndex] = React.useState(clampedInitialIndex);
    const [isHovered, setIsHovered] = React.useState(false);

    React.useEffect(() => {
        setCurrentIndex(clampedInitialIndex);
    }, [clampedInitialIndex]);

    const containerWidth = Math.max(280, Math.min(width - 24, 960));
    const containerHeight = Math.max(240, Math.min(height - 24, 840));
    const currentImage = props.images[currentIndex] ?? props.images[0] ?? null;
    const hasMultipleImages = props.images.length > 1;
    const canGoPrevious = currentIndex > 0;
    const canGoNext = currentIndex < props.images.length - 1;

    if (!currentImage) return null;

    const currentImageAccessibilityLabel = resolvePreviewImageAccessibilityLabel(
        currentImage,
        currentIndex,
        props.images.length,
    );

    const maxHeightRatio = height > 0 ? (containerHeight / height) : 0.92;
    const chromeDimensions = React.useMemo(() => ({
        width: containerWidth,
        maxHeightRatio,
        size: 'lg' as const,
    }), [containerWidth, maxHeightRatio]);

    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: currentImage.title,
        testID: 'attachment-image-preview-modal',
        titleTestID: 'attachment-image-preview-title',
        ...(Platform.OS === 'web' ? { scrollHost: 'body' as const } : {}),
        dimensions: chromeDimensions,
    }), [chromeDimensions, currentImage.title]);

    useModalCardChrome(props.setChrome, chrome);

    return (
        <View style={styles.body}>
            <Pressable
                testID="attachment-image-preview-surface"
                style={styles.imageSurface}
                onHoverIn={Platform.OS === 'web' ? () => setIsHovered(true) : undefined}
                onHoverOut={Platform.OS === 'web' ? () => setIsHovered(false) : undefined}
            >
                <AttachmentImagePreviewCurrentImage
                    image={currentImage}
                    accessibilityLabel={currentImageAccessibilityLabel}
                />

                {hasMultipleImages ? (
                    <>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('common.previous')}
                            disabled={!canGoPrevious}
                            accessibilityState={{ disabled: !canGoPrevious }}
                            hitSlop={10}
                            onPress={() => {
                                if (!canGoPrevious) return;
                                const nextIndex = currentIndex - 1;
                                setCurrentIndex(nextIndex);
                                announceAccessibilityMessage(resolvePreviewImageAccessibilityLabel(
                                    props.images[nextIndex]!,
                                    nextIndex,
                                    props.images.length,
                                ));
                            }}
                            style={({ pressed }) => [
                                styles.navButton,
                                styles.navButtonLeft,
                                Platform.OS === 'web' && !isHovered ? styles.navButtonIdle : null,
                                !canGoPrevious ? styles.navButtonDisabled : null,
                                pressed && canGoPrevious ? { opacity: 0.85 } : null,
                            ]}
                            testID="attachment-image-preview-previous"
                        >
                            <Icon name="caret-left" size={24} color={theme.colors.overlay.foreground} />
                        </Pressable>

                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('common.next')}
                            disabled={!canGoNext}
                            accessibilityState={{ disabled: !canGoNext }}
                            hitSlop={10}
                            onPress={() => {
                                if (!canGoNext) return;
                                const nextIndex = currentIndex + 1;
                                setCurrentIndex(nextIndex);
                                announceAccessibilityMessage(resolvePreviewImageAccessibilityLabel(
                                    props.images[nextIndex]!,
                                    nextIndex,
                                    props.images.length,
                                ));
                            }}
                            style={({ pressed }) => [
                                styles.navButton,
                                styles.navButtonRight,
                                Platform.OS === 'web' && !isHovered ? styles.navButtonIdle : null,
                                !canGoNext ? styles.navButtonDisabled : null,
                                pressed && canGoNext ? { opacity: 0.85 } : null,
                            ]}
                            testID="attachment-image-preview-next"
                        >
                            <Icon name="caret-right" size={24} color={theme.colors.overlay.foreground} />
                        </Pressable>
                    </>
                ) : null}
            </Pressable>
        </View>
    );
});
