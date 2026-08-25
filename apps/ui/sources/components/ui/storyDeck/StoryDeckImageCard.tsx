import * as React from 'react';
import { View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t, tLoose } from '@/text';
import type { StoryDeckImageCard as ImageCardData, StoryDeckMediaSurface } from '@/changelog/releaseNotes/types';

import { StoryDeckMediaFrame, clampMediaSize } from './StoryDeckMediaFrame';
import { DEFAULT_STORY_DECK_MEDIA_LOAD_TIMEOUT_MS } from './StoryDeckMediaLoading';
import {
    resolveStoryDeckImageMediaForSurface,
    resolveStoryDeckImageSources,
} from './StoryDeckMediaSources';
import type { StoryDeckCardLayout } from './storyDeckPresentation';
import {
    STORY_DECK_WIDE_CONTENT_BOTTOM_PADDING,
    STORY_DECK_WIDE_CONTENT_HORIZONTAL_PADDING,
    STORY_DECK_WIDE_CONTENT_TOP_PADDING,
    STORY_DECK_WIDE_BODY_FONT_SIZE,
    STORY_DECK_WIDE_BODY_LINE_HEIGHT,
    STORY_DECK_WIDE_DETAILS_MAX_WIDTH,
    STORY_DECK_WIDE_MEDIA_TEXT_GAP,
    STORY_DECK_WIDE_TITLE_FONT_SIZE,
    STORY_DECK_WIDE_TITLE_LINE_HEIGHT,
    resolveWideStoryDeckMediaSize,
} from './storyDeckLayout';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { resolveStoryDeckBundledImageAsset } from './storyDeckBundledAssetRegistry';

export type StoryDeckImageCardProps = Readonly<{
    card: ImageCardData;
    testID?: string;
    isCurrent: boolean;
    loadTimeoutMs?: number;
    mediaSurface?: StoryDeckMediaSurface;
    layout?: StoryDeckCardLayout;
    mediaPlacement?: 'start' | 'end';
    initialContainerWidth?: number;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        alignItems: 'stretch',
        gap: 25,
        minHeight: 0,
    },
    containerWide: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: STORY_DECK_WIDE_MEDIA_TEXT_GAP,
        paddingHorizontal: STORY_DECK_WIDE_CONTENT_HORIZONTAL_PADDING,
        paddingTop: STORY_DECK_WIDE_CONTENT_TOP_PADDING,
        paddingBottom: STORY_DECK_WIDE_CONTENT_BOTTOM_PADDING,
    },
    containerWideMediaEnd: {
        flexDirection: 'row-reverse',
    },
    placeholder: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.inset,
    },
    failurePlaceholder: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.inset,
    },
    details: {
        paddingHorizontal: 30,
        paddingBottom: 18,
        gap: 12,
        flexShrink: 1,
    },
    detailsWide: {
        flex: 1,
        minWidth: 0,
        maxWidth: STORY_DECK_WIDE_DETAILS_MAX_WIDTH,
        justifyContent: 'center',
        paddingHorizontal: 0,
        paddingBottom: 0,
        gap: 16,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 19,
        lineHeight: 25,
        letterSpacing: -0.2,
        color: theme.colors.text.primary,
    },
    titleWide: {
        fontSize: STORY_DECK_WIDE_TITLE_FONT_SIZE,
        lineHeight: STORY_DECK_WIDE_TITLE_LINE_HEIGHT,
    },
    body: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.text.secondary,
    },
    bodyWide: {
        fontSize: STORY_DECK_WIDE_BODY_FONT_SIZE,
        lineHeight: STORY_DECK_WIDE_BODY_LINE_HEIGHT,
    },
    bodyStack: {
        gap: 8,
    },
    mediaPlane: {
        position: 'relative',
        overflow: 'hidden',
    },
    backdropLayer: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
    },
    foregroundLayer: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 1,
    },
}));

export function StoryDeckImageCard(props: StoryDeckImageCardProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { width: viewportWidth } = useWindowDimensions();
    const [measuredWidth, setMeasuredWidth] = React.useState<number | null>(null);
    const [loaded, setLoaded] = React.useState(false);
    const [sourceIndex, setSourceIndex] = React.useState(0);
    const [failed, setFailed] = React.useState(false);

    const isWide = props.layout === 'wide';
    const titleKey = isWide && props.card.wideTitleKey ? props.card.wideTitleKey : props.card.titleKey;
    const media = React.useMemo(
        () => resolveStoryDeckImageMediaForSurface(props.card.media, props.mediaSurface),
        [props.card.media, props.mediaSurface],
    );
    const resolved = React.useMemo(
        () => resolveStoryDeckImageSources(props.card.media, { surface: props.mediaSurface }),
        [props.card.media, props.mediaSurface],
    );
    const imageSource = resolved.sources[sourceIndex] ?? null;
    const loadTimeoutMs = props.loadTimeoutMs ?? DEFAULT_STORY_DECK_MEDIA_LOAD_TIMEOUT_MS;
    const fallbackContainerWidth = props.initialContainerWidth && props.initialContainerWidth > 0
        ? props.initialContainerWidth
        : viewportWidth;
    const containerWidth = measuredWidth && measuredWidth > 0 ? measuredWidth : fallbackContainerWidth;
    const mediaContainerWidth = isWide ? resolveWideStoryDeckMediaSize(containerWidth) : containerWidth;
    const mediaFramePadding = isWide ? 0 : undefined;
    const mediaSize = isWide
        ? clampMediaSize(mediaContainerWidth, mediaContainerWidth, 0)
        : clampMediaSize(mediaContainerWidth);
    const mediaAspectRatio = media.aspectRatio && media.aspectRatio > 0 ? media.aspectRatio : 1;
    const mediaHeight = mediaSize / mediaAspectRatio;

    const altLabel = tLoose(media.altKey);
    const backdropSource = resolveStoryDeckBundledImageAsset(
        theme.dark ? media.backdrop?.darkLocalAssetKey : media.backdrop?.lightLocalAssetKey,
    );

    React.useEffect(() => {
        setLoaded(false);
        setSourceIndex(0);
        setFailed(false);
    }, [resolved.cacheKey]);

    const handleError = React.useCallback(() => {
        setSourceIndex((currentIndex) => {
            const nextIndex = currentIndex + 1;
            if (nextIndex < resolved.sources.length) {
                setLoaded(false);
                return nextIndex;
            }
            setLoaded(false);
            setFailed(true);
            return currentIndex;
        });
    }, [resolved.sources.length]);

    React.useEffect(() => {
        if (!imageSource || loaded || failed) return;
        const timeout = setTimeout(handleError, loadTimeoutMs);
        return () => {
            clearTimeout(timeout);
        };
    }, [failed, handleError, imageSource, loadTimeoutMs, loaded]);

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextWidth = event.nativeEvent.layout.width;
        if (nextWidth <= 0) return;
        setMeasuredWidth((current) => (current === nextWidth ? current : nextWidth));
    }, []);

    return (
        <View
            style={[
                styles.container,
                isWide ? styles.containerWide : null,
                isWide && props.mediaPlacement === 'end' ? styles.containerWideMediaEnd : null,
            ]}
            testID={props.testID}
            onLayout={handleLayout}
        >
            <StoryDeckMediaFrame
                containerWidth={mediaContainerWidth}
                maxSize={isWide ? mediaContainerWidth : undefined}
                horizontalPadding={mediaFramePadding}
                topPadding={mediaFramePadding}
                aspectRatio={media.aspectRatio}
            >
                <View style={[styles.mediaPlane, { width: mediaSize, height: mediaHeight }]}>
                    {backdropSource ? (
                        <View style={styles.backdropLayer}>
                            <Image
                                testID={`${props.testID ?? 'story-image'}-media-backdrop`}
                                source={backdropSource}
                                style={{ width: mediaSize, height: mediaHeight }}
                                contentFit="cover"
                                cachePolicy="memory-disk"
                                accessibilityElementsHidden
                                importantForAccessibility="no-hide-descendants"
                            />
                        </View>
                    ) : null}
                    {imageSource && !failed ? (
                        <View style={styles.foregroundLayer}>
                            <Image
                                testID={`${props.testID ?? 'story-image'}-media-image`}
                                source={imageSource.source}
                                style={{ width: mediaSize, height: mediaHeight }}
                                contentFit={media.contentFit ?? 'cover'}
                                cachePolicy="memory-disk"
                                onLoad={() => setLoaded(true)}
                                onError={handleError}
                                accessibilityLabel={altLabel}
                                accessibilityRole="image"
                            />
                            {!loaded ? (
                                <View
                                    testID={`${props.testID ?? 'story-image'}-media-loading`}
                                    style={[styles.placeholder, { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 2 }]}
                                >
                                    <ActivitySpinner />
                                </View>
                            ) : null}
                        </View>
                    ) : (
                        <View
                            style={styles.failurePlaceholder}
                            testID={`${props.testID ?? 'story-image'}-media-failed`}
                            accessibilityRole="image"
                            accessibilityLabel={t('releaseNotes.mediaUnavailable')}
                        >
                            <Text style={styles.body}>{t('releaseNotes.mediaUnavailable')}</Text>
                        </View>
                    )}
                </View>
            </StoryDeckMediaFrame>
            <View style={[styles.details, isWide ? styles.detailsWide : null]}>
                <Text style={[styles.title, isWide ? styles.titleWide : null]}>{tLoose(titleKey)}</Text>
                <View style={styles.bodyStack}>
                    {(props.card.paragraphKeys ?? [props.card.bodyKey]).map((paragraphKey) => (
                        <Text key={paragraphKey} style={[styles.body, isWide ? styles.bodyWide : null]}>
                            {tLoose(paragraphKey)}
                        </Text>
                    ))}
                </View>
            </View>
        </View>
    );
}
