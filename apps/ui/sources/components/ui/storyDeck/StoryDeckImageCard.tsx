import * as React from 'react';
import { ActivityIndicator, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t, tLoose } from '@/text';
import type { StoryDeckImageCard as ImageCardData } from '@/changelog/releaseNotes/types';

import { StoryDeckMediaFrame, clampMediaSize } from './StoryDeckMediaFrame';
import { DEFAULT_STORY_DECK_MEDIA_LOAD_TIMEOUT_MS } from './StoryDeckMediaLoading';
import { resolveStoryDeckImageSources } from './StoryDeckMediaSources';

export type StoryDeckImageCardProps = Readonly<{
    card: ImageCardData;
    testID?: string;
    isCurrent: boolean;
    loadTimeoutMs?: number;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        alignItems: 'stretch',
        gap: 25,
        minHeight: 0,
    },
    placeholder: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHigh,
    },
    failurePlaceholder: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHigh,
    },
    details: {
        paddingHorizontal: 30,
        paddingBottom: 18,
        gap: 6,
        flexShrink: 1,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 19,
        lineHeight: 25,
        letterSpacing: -0.2,
        color: theme.colors.text,
    },
    body: {
        ...Typography.default(),
        fontSize: 15,
        lineHeight: 21,
        color: theme.colors.textSecondary,
    },
}));

export function StoryDeckImageCard(props: StoryDeckImageCardProps) {
    useUnistyles();
    const styles = stylesheet;
    const { width: viewportWidth } = useWindowDimensions();
    const [measuredWidth, setMeasuredWidth] = React.useState<number | null>(null);
    const [loaded, setLoaded] = React.useState(false);
    const [sourceIndex, setSourceIndex] = React.useState(0);
    const [failed, setFailed] = React.useState(false);

    const resolved = React.useMemo(() => resolveStoryDeckImageSources(props.card.media), [props.card.media]);
    const imageSource = resolved.sources[sourceIndex] ?? null;
    const loadTimeoutMs = props.loadTimeoutMs ?? DEFAULT_STORY_DECK_MEDIA_LOAD_TIMEOUT_MS;
    const containerWidth = measuredWidth && measuredWidth > 0 ? measuredWidth : viewportWidth;
    const mediaSize = clampMediaSize(containerWidth);

    const altLabel = tLoose(props.card.media.altKey);

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
        <View style={styles.container} testID={props.testID} onLayout={handleLayout}>
            <StoryDeckMediaFrame containerWidth={containerWidth}>
                {imageSource && !failed ? (
                    <>
                        <Image
                            testID={`${props.testID ?? 'story-image'}-media-image`}
                            source={imageSource.source}
                            style={{ width: mediaSize, height: mediaSize }}
                            contentFit="cover"
                            cachePolicy="memory-disk"
                            onLoad={() => setLoaded(true)}
                            onError={handleError}
                            accessibilityLabel={altLabel}
                            accessibilityRole="image"
                        />
                        {!loaded ? (
                            <View
                                testID={`${props.testID ?? 'story-image'}-media-loading`}
                                style={[styles.placeholder, { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }]}
                            >
                                <ActivityIndicator />
                            </View>
                        ) : null}
                    </>
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
            </StoryDeckMediaFrame>
            <View style={styles.details}>
                <Text style={styles.title}>{tLoose(props.card.titleKey)}</Text>
                <Text style={styles.body}>{tLoose(props.card.bodyKey)}</Text>
            </View>
        </View>
    );
}
