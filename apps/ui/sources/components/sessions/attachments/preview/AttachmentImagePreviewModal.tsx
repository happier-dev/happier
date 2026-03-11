import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { SvgXml } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useSessionImagePreview } from '@/components/sessions/files/content/imagePreview/useSessionImagePreview';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';

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
    }>;

type AttachmentImagePreviewModalProps = CustomModalInjectedProps & Readonly<{
    images: ReadonlyArray<AttachmentImagePreviewModalImage>;
    initialIndex?: number;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 8,
        elevation: 8,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        flex: 1,
        color: theme.colors.text,
        fontSize: 15,
        ...Typography.default('semiBold'),
    },
    closeButton: {
        padding: 2,
    },
    body: {
        flex: 1,
        backgroundColor: theme.colors.surfaceHigh,
    },
    imageSurface: {
        flex: 1,
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: theme.colors.surfaceHighest,
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
        color: theme.colors.textSecondary,
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
        backgroundColor: theme.colors.overlay.scrimStrong,
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
}));

function AttachmentImagePreviewCurrentImage(props: Readonly<{
    image: AttachmentImagePreviewModalImage;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const preview = useSessionImagePreview({
        sessionId: props.image.kind === 'session-image' ? props.image.sessionId : '',
        filePath: props.image.kind === 'session-image' ? props.image.filePath : '',
        enabled: props.image.kind === 'session-image',
        cacheKey: props.image.kind === 'session-image' ? props.image.cacheKey ?? null : null,
        mimeType: props.image.kind === 'session-image' ? props.image.mimeType ?? null : null,
        sizeBytes: props.image.kind === 'session-image' ? props.image.sizeBytes ?? null : null,
    });

    if (props.image.kind === 'direct') {
        return (
            <Image
                accessibilityRole="image"
                source={{ uri: props.image.uri }}
                style={[{ width: '100%', height: '100%' }, styles.image]}
                contentFit="contain"
            />
        );
    }

    if (preview.status === 'loaded') {
        if (Platform.OS !== 'web' && preview.svgXml) {
            return <SvgXml xml={preview.svgXml} width="100%" height="100%" />;
        }
        return (
            <Image
                accessibilityRole="image"
                source={{ uri: preview.uri }}
                style={[{ width: '100%', height: '100%' }, styles.image]}
                contentFit="contain"
            />
        );
    }

    if (preview.status === 'error') {
        return (
            <View style={styles.centeredState}>
                <Ionicons name="alert-circle-outline" size={28} color={theme.colors.textSecondary} />
                <Text style={styles.centeredStateText}>{preview.error || t('common.error')}</Text>
            </View>
        );
    }

    return (
        <View style={styles.centeredState}>
            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
        </View>
    );
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
    const shouldShowNavigation = hasMultipleImages && (Platform.OS === 'web' ? isHovered : true);

    if (!currentImage) return null;

    return (
        <View testID="attachment-image-preview-modal" style={[styles.container, { width: containerWidth, height: containerHeight }]}>
            <View style={styles.header}>
                <Text testID="attachment-image-preview-title" numberOfLines={1} style={styles.title}>
                    {currentImage.title}
                </Text>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close')}
                    hitSlop={10}
                    onPress={props.onClose}
                    style={({ pressed }) => [styles.closeButton, pressed ? { opacity: 0.7 } : null]}
                >
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            <View style={styles.body}>
                <Pressable
                    testID="attachment-image-preview-surface"
                    style={styles.imageSurface}
                    onHoverIn={Platform.OS === 'web' ? () => setIsHovered(true) : undefined}
                    onHoverOut={Platform.OS === 'web' ? () => setIsHovered(false) : undefined}
                >
                    <AttachmentImagePreviewCurrentImage image={currentImage} />

                    {shouldShowNavigation ? (
                        <>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('common.previous')}
                                disabled={!canGoPrevious}
                                hitSlop={10}
                                onPress={() => {
                                    if (!canGoPrevious) return;
                                    setCurrentIndex((value) => Math.max(0, value - 1));
                                }}
                                style={({ pressed }) => [
                                    styles.navButton,
                                    styles.navButtonLeft,
                                    !canGoPrevious ? styles.navButtonDisabled : null,
                                    pressed && canGoPrevious ? { opacity: 0.85 } : null,
                                ]}
                                testID="attachment-image-preview-previous"
                            >
                                <Ionicons name="chevron-back" size={24} color={theme.colors.overlay.text} />
                            </Pressable>

                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('common.next')}
                                disabled={!canGoNext}
                                hitSlop={10}
                                onPress={() => {
                                    if (!canGoNext) return;
                                    setCurrentIndex((value) => Math.min(props.images.length - 1, value + 1));
                                }}
                                style={({ pressed }) => [
                                    styles.navButton,
                                    styles.navButtonRight,
                                    !canGoNext ? styles.navButtonDisabled : null,
                                    pressed && canGoNext ? { opacity: 0.85 } : null,
                                ]}
                                testID="attachment-image-preview-next"
                            >
                                <Ionicons name="chevron-forward" size={24} color={theme.colors.overlay.text} />
                            </Pressable>
                        </>
                    ) : null}
                </Pressable>
            </View>
        </View>
    );
});
