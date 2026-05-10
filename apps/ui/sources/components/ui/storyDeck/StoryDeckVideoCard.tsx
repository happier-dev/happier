import * as React from 'react';
import { ActivityIndicator, useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t, tLoose } from '@/text';
import type { StoryDeckVideoCard as VideoCardData } from '@/changelog/releaseNotes/types';

import { StoryDeckMediaFrame, clampMediaSize } from './StoryDeckMediaFrame';
import { DEFAULT_STORY_DECK_MEDIA_LOAD_TIMEOUT_MS } from './StoryDeckMediaLoading';
import {
    resolveStoryDeckMediaSources,
    resolveStoryDeckPosterImageSources,
} from './StoryDeckMediaSources';

export type StoryDeckVideoCardProps = Readonly<{
    card: VideoCardData;
    testID?: string;
    isCurrent: boolean;
    loadTimeoutMs?: number;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        alignItems: 'stretch',
        gap: 8,
    },
    placeholder: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHigh,
    },
    poster: {
        ...StyleSheet.absoluteFillObject,
    },
    failurePlaceholder: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHigh,
    },
    details: {
        paddingHorizontal: 30,
        paddingBottom: 30,
        gap: 8,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 20,
        lineHeight: 26,
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

export function StoryDeckVideoCard(props: StoryDeckVideoCardProps) {
    useUnistyles();
    const styles = stylesheet;
    const { width: viewportWidth } = useWindowDimensions();
    const reducedMotion = useReducedMotionPreference();

    const mediaSize = clampMediaSize(viewportWidth);
    const accessibilityLabel = tLoose(props.card.media.accessibilityLabelKey);

    const resolvedVideo = React.useMemo(() => resolveStoryDeckMediaSources(props.card.media), [props.card.media]);
    const muted = props.card.media.muted ?? true;
    const loop = props.card.media.loop ?? true;
    const loadTimeoutMs = props.loadTimeoutMs ?? DEFAULT_STORY_DECK_MEDIA_LOAD_TIMEOUT_MS;

    const [isReady, setIsReady] = React.useState(false);
    const [hasFailed, setHasFailed] = React.useState(false);
    const [sourceIndex, setSourceIndex] = React.useState(0);
    const [posterSourceIndex, setPosterSourceIndex] = React.useState(0);

    React.useEffect(() => {
        setIsReady(false);
        setHasFailed(false);
        setSourceIndex(0);
    }, [resolvedVideo.primaryUrl, resolvedVideo.fallbackUrl]);

    const videoSource = resolvedVideo.urls[sourceIndex] ?? null;
    const resolvedPosterImages = React.useMemo(
        () => resolveStoryDeckPosterImageSources(props.card.media),
        [props.card.media],
    );
    const posterSource = resolvedPosterImages.sources[posterSourceIndex] ?? null;
    const shouldMountPlayer = props.isCurrent && !reducedMotion && !hasFailed && videoSource != null;
    const showPoster = !isReady || hasFailed || reducedMotion || !shouldMountPlayer;
    const showSpinner = shouldMountPlayer && !isReady && !hasFailed;

    React.useEffect(() => {
        setPosterSourceIndex(0);
    }, [resolvedPosterImages.cacheKey]);

    const handleSourceFailure = React.useCallback(() => {
        setSourceIndex((currentIndex) => {
            const nextIndex = currentIndex + 1;
            if (nextIndex < resolvedVideo.urls.length) {
                setIsReady(false);
                return nextIndex;
            }
            setHasFailed(true);
            setIsReady(false);
            return currentIndex;
        });
    }, [resolvedVideo.urls.length]);

    const handleVideoStatus = React.useCallback((status: string) => {
        if (status === 'readyToPlay') {
            setIsReady(true);
            setHasFailed(false);
            return;
        }
        if (status === 'error') {
            handleSourceFailure();
            return;
        }
        if (status === 'loading') {
            setIsReady(false);
        }
    }, [handleSourceFailure]);

    const handlePosterError = React.useCallback(() => {
        setPosterSourceIndex((currentIndex) => {
            const nextIndex = currentIndex + 1;
            return nextIndex < resolvedPosterImages.sources.length ? nextIndex : currentIndex;
        });
    }, [resolvedPosterImages.sources.length]);

    React.useEffect(() => {
        if (!showSpinner) return;
        const timeout = setTimeout(handleSourceFailure, loadTimeoutMs);
        return () => {
            clearTimeout(timeout);
        };
    }, [handleSourceFailure, loadTimeoutMs, showSpinner, videoSource]);

    return (
        <View style={styles.container} testID={props.testID}>
            <StoryDeckMediaFrame containerWidth={viewportWidth}>
                <View style={{ width: mediaSize, height: mediaSize }}>
                    {shouldMountPlayer ? (
                        <StoryDeckVideoPlayer
                            key={videoSource}
                            source={videoSource}
                            muted={muted}
                            loop={loop}
                            isCurrent={props.isCurrent}
                            onStatusChange={handleVideoStatus}
                            mediaSize={mediaSize}
                            accessibilityLabel={accessibilityLabel}
                        />
                    ) : null}
                    {showPoster && posterSource ? (
                        <Image
                            testID={`${props.testID ?? 'story-video'}-media-poster`}
                            source={posterSource.source}
                            style={[styles.poster, { width: mediaSize, height: mediaSize }]}
                            contentFit="cover"
                            cachePolicy="memory-disk"
                            onError={handlePosterError}
                            accessibilityLabel={accessibilityLabel}
                            accessibilityRole="image"
                        />
                    ) : null}
                    {showSpinner ? (
                        <View style={styles.placeholder} testID={`${props.testID ?? 'story-video'}-media-loading`}>
                            <ActivityIndicator />
                        </View>
                    ) : null}
                    {(hasFailed || reducedMotion || !videoSource) && !posterSource ? (
                        <View
                            style={styles.failurePlaceholder}
                            testID={`${props.testID ?? 'story-video'}-media-failed`}
                            accessibilityRole="image"
                            accessibilityLabel={t('releaseNotes.mediaUnavailable')}
                        >
                            <Text style={styles.body}>{t('releaseNotes.mediaUnavailable')}</Text>
                        </View>
                    ) : null}
                </View>
            </StoryDeckMediaFrame>
            <View style={styles.details}>
                <Text style={styles.title}>{tLoose(props.card.titleKey)}</Text>
                <Text style={styles.body}>{tLoose(props.card.bodyKey)}</Text>
            </View>
        </View>
    );
}

type StoryDeckVideoPlayerProps = Readonly<{
    source: string;
    muted: boolean;
    loop: boolean;
    isCurrent: boolean;
    onStatusChange: (status: string) => void;
    mediaSize: number;
    accessibilityLabel: string;
}>;

function StoryDeckVideoPlayer(props: StoryDeckVideoPlayerProps) {
    const {
        accessibilityLabel,
        isCurrent,
        loop,
        mediaSize,
        muted,
        onStatusChange,
        source,
    } = props;

    const player = useVideoPlayer(source, (instance: VideoPlayer) => {
        instance.loop = loop;
        instance.muted = muted;
        instance.allowsExternalPlayback = false;
        instance.timeUpdateEventInterval = 0;
    });

    React.useEffect(() => {
        player.loop = loop;
        player.muted = muted;
        player.allowsExternalPlayback = false;
        player.timeUpdateEventInterval = 0;
    }, [loop, muted, player]);

    React.useEffect(() => {
        const subscription = player.addListener('statusChange', ({ status }) => {
            onStatusChange(status);
        });
        return () => {
            subscription.remove();
            try { player.pause(); } catch { /* ignore */ }
        };
    }, [onStatusChange, player]);

    React.useEffect(() => {
        if (!isCurrent) {
            try { player.pause(); } catch { /* ignore */ }
            return;
        }
        try { player.play(); } catch { /* ignore */ }
    }, [isCurrent, player]);

    return (
        <VideoView
            player={player}
            style={{ width: mediaSize, height: mediaSize }}
            contentFit="cover"
            nativeControls={false}
            allowsPictureInPicture={false}
            accessibilityLabel={accessibilityLabel}
        />
    );
}
