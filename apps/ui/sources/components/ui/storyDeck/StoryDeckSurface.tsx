import * as React from 'react';
import {
    ScrollView,
    PanResponder,
    View,
    useWindowDimensions,
    type LayoutChangeEvent,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Image as ExpoImage } from 'expo-image';
import type { StoryDeckCard, StoryDeckMediaSurface } from '@/changelog/releaseNotes/types';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { resolveStepTransitionDirection } from '@/components/ui/motion/resolveStepTransitionDirection';
import { SoftSlideTransitionFrame } from '@/components/ui/motion/SoftSlideTransitionFrame';

import { StoryDeckA11yAnnouncements } from './StoryDeckA11yAnnouncements';
import { StoryDeckFooterActions } from './StoryDeckFooterActions';
import { StoryDeckFrame } from './StoryDeckFrame';
import { StoryDeckImageCard } from './StoryDeckImageCard';
import { StoryDeckListCard } from './StoryDeckListCard';
import { StoryDeckVideoCard } from './StoryDeckVideoCard';
import { StoryDeckKeyboardShortcuts } from './StoryDeckKeyboardShortcuts';
import {
    resolveStoryDeckImageSources,
    resolveStoryDeckMediaSources,
    resolveStoryDeckPosterImageSources,
    type StoryDeckImageSource,
} from './StoryDeckMediaSources';
import { resolveStoryDeckPresentation, type StoryDeckCardLayout } from './storyDeckPresentation';

export type StoryDeckSlideAnimation = 'pager' | 'softBlur';

export type StoryDeckSurfaceProps = Readonly<{
    cards: ReadonlyArray<StoryDeckCard>;
    onComplete: () => void;
    onDismiss?: () => void;
    onSecondaryAction?: () => void;
    secondaryActionLabel?: string;
    slideAnimation?: StoryDeckSlideAnimation;
    alternateWideMediaPlacement?: boolean;
    testID?: string;
}>;

function prefetchRemoteStoryDeckImageSources(sources: readonly StoryDeckImageSource[]): void {
    for (const source of sources) {
        if (source.kind === 'remote') {
            void ExpoImage.prefetch(source.uri);
        }
    }
}

const stylesheet = StyleSheet.create({
    container: {
        flex: 1,
        minHeight: 0,
    },
    pager: {
        flex: 1,
        overflow: 'hidden',
    },
    page: {
        flex: 1,
        overflow: 'hidden',
    },
});

const DRAG_SLIDE_MIN_DISTANCE = 48;
const DRAG_SLIDE_DOMINANCE_RATIO = 1.2;

function getCardTitleKey(card: StoryDeckCard): string {
    return card.titleKey;
}

export function StoryDeckSurface(props: StoryDeckSurfaceProps) {
    useUnistyles();
    const styles = stylesheet;
    const { width: viewportWidth } = useWindowDimensions();
    const reducedMotion = useReducedMotionPreference();
    const scrollRef = React.useRef<ScrollView | null>(null);
    const [currentIndex, setCurrentIndex] = React.useState(0);
    const [measuredWidth, setMeasuredWidth] = React.useState<number | null>(null);
    const previousIndexRef = React.useRef<number | null>(null);
    const slideAnimation = props.slideAnimation ?? 'pager';
    const usesPager = slideAnimation === 'pager';
    const presentation = React.useMemo(
        () => resolveStoryDeckPresentation(viewportWidth),
        [viewportWidth],
    );

    const totalCount = props.cards.length;
    const isLastSlide = currentIndex >= totalCount - 1;
    const fallbackPageWidth = presentation.cardLayout === 'wide'
        ? Math.min(viewportWidth - 32, presentation.frameMaxWidth)
        : viewportWidth;
    const pageWidth = measuredWidth && measuredWidth > 0 ? measuredWidth : fallbackPageWidth;

    React.useEffect(() => {
        // Prefetch the first card's image and the next card's image where applicable.
        if (props.cards.length === 0) return;
        for (let i = 0; i < Math.min(2, props.cards.length); i += 1) {
            const card = props.cards[i];
            if (!card) continue;
            if (card.kind !== 'image' && card.kind !== 'video') continue;
            if (card.kind === 'image') {
                prefetchRemoteStoryDeckImageSources(resolveStoryDeckImageSources(card.media, {
                    surface: presentation.mediaSurface,
                }).sources);
                continue;
            }
            for (const url of resolveStoryDeckMediaSources(card.media, { surface: presentation.mediaSurface }).urls) {
                void ExpoImage.prefetch(url);
            }
            prefetchRemoteStoryDeckImageSources(resolveStoryDeckPosterImageSources(card.media, {
                surface: presentation.mediaSurface,
            }).sources);
        }
    }, [presentation.mediaSurface, props.cards]);

    const setIndex = React.useCallback((nextIndex: number, animated: boolean) => {
        const safeIndex = Math.max(0, Math.min(nextIndex, totalCount - 1));
        previousIndexRef.current = currentIndex;
        setCurrentIndex(safeIndex);
        if (usesPager) {
            scrollRef.current?.scrollTo({ x: safeIndex * pageWidth, animated: animated && !reducedMotion });
        }
    }, [currentIndex, pageWidth, reducedMotion, totalCount, usesPager]);

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextWidth = event.nativeEvent.layout.width;
        if (nextWidth <= 0) return;
        setMeasuredWidth((current) => (current === nextWidth ? current : nextWidth));
    }, []);

    const handlePrimary = React.useCallback(() => {
        if (isLastSlide) {
            props.onComplete();
            return;
        }
        setIndex(currentIndex + 1, true);
    }, [isLastSlide, currentIndex, setIndex, props]);

    const handleBack = React.useCallback(() => {
        if (currentIndex <= 0) return;
        setIndex(currentIndex - 1, true);
    }, [currentIndex, setIndex]);

    const softSlidePanResponder = React.useMemo(() => PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gestureState) => {
            if (usesPager) return false;
            const dx = Math.abs(gestureState.dx);
            const dy = Math.abs(gestureState.dy);
            return dx >= 8 && dx > dy * DRAG_SLIDE_DOMINANCE_RATIO;
        },
        onPanResponderRelease: (_event, gestureState) => {
            if (usesPager) return;
            const dx = gestureState.dx;
            const dy = gestureState.dy;
            if (Math.abs(dx) < DRAG_SLIDE_MIN_DISTANCE || Math.abs(dx) <= Math.abs(dy) * DRAG_SLIDE_DOMINANCE_RATIO) {
                return;
            }
            if (dx < 0) {
                setIndex(currentIndex + 1, true);
                return;
            }
            setIndex(currentIndex - 1, true);
        },
    }), [currentIndex, setIndex, usesPager]);

    const handleScrollEnd = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (pageWidth <= 0) return;
        const offsetX = event.nativeEvent.contentOffset.x;
        const nextIndex = Math.round(offsetX / pageWidth);
        if (nextIndex !== currentIndex) {
            previousIndexRef.current = currentIndex;
            setCurrentIndex(Math.max(0, Math.min(nextIndex, totalCount - 1)));
        }
    }, [currentIndex, pageWidth, totalCount]);

    const currentCard = props.cards[currentIndex];
    const transitionDirection = resolveStepTransitionDirection({
        previousIndex: previousIndexRef.current,
        nextIndex: currentIndex,
    });

    return (
        <View
            style={styles.container}
            testID={props.testID ?? 'story-deck-surface'}
            onLayout={handleLayout}
        >
            <StoryDeckA11yAnnouncements
                currentIndex={currentIndex}
                totalCount={totalCount}
                currentTitleKey={currentCard ? getCardTitleKey(currentCard) : ''}
            />
            <StoryDeckKeyboardShortcuts
                onAdvance={handlePrimary}
                onBack={currentIndex > 0 ? handleBack : undefined}
                onDismiss={props.onDismiss}
            />
            <StoryDeckFrame
                currentIndex={currentIndex}
                totalCount={totalCount}
                footer={(
                    <StoryDeckFooterActions
                        isLastSlide={isLastSlide}
                        onPrimary={handlePrimary}
                        onSecondary={props.onSecondaryAction}
                        secondaryLabel={props.secondaryActionLabel}
                        testID={`${props.testID ?? 'story-deck'}-footer`}
                    />
                )}
            >
                {usesPager ? (
                    <ScrollView
                        ref={scrollRef}
                        style={styles.pager}
                        horizontal
                        pagingEnabled
                        showsHorizontalScrollIndicator={false}
                        onMomentumScrollEnd={handleScrollEnd}
                        keyboardShouldPersistTaps="handled"
                    >
                        {props.cards.map((card, index) => (
                            <View
                                key={`${card.kind}-${index}`}
                                style={[styles.page, { width: pageWidth }]}
                                testID={`${props.testID ?? 'story-deck'}-page-${index}`}
                            >
                                {renderCard(
                                    card,
                                    index === currentIndex,
                                    `${props.testID ?? 'story-deck'}-card-${index}`,
                                    presentation.mediaSurface,
                                    presentation.cardLayout,
                                    index,
                                    pageWidth,
                                    props.alternateWideMediaPlacement === true,
                                )}
                            </View>
                        ))}
                    </ScrollView>
                ) : (
                    <View
                        style={styles.pager}
                        testID={`${props.testID ?? 'story-deck'}-soft-slide-gesture-surface`}
                        {...softSlidePanResponder.panHandlers}
                    >
                        <SoftSlideTransitionFrame
                            direction={transitionDirection}
                            reducedMotion={reducedMotion}
                            style={styles.pager}
                            testID={`${props.testID ?? 'story-deck'}-soft-slide`}
                            transitionKey={currentIndex}
                        >
                            {currentCard
                                ? (
                                    <View
                                        style={[styles.page, { width: pageWidth }]}
                                        testID={`${props.testID ?? 'story-deck'}-page-${currentIndex}`}
                                    >
                                        {renderCard(
                                            currentCard,
                                            true,
                                            `${props.testID ?? 'story-deck'}-card-${currentIndex}`,
                                            presentation.mediaSurface,
                                            presentation.cardLayout,
                                            currentIndex,
                                            pageWidth,
                                            props.alternateWideMediaPlacement === true,
                                        )}
                                    </View>
                                )
                                : null}
                        </SoftSlideTransitionFrame>
                    </View>
                )}
            </StoryDeckFrame>
        </View>
    );
}

function renderCard(
    card: StoryDeckCard,
    isCurrent: boolean,
    testID: string,
    mediaSurface: StoryDeckMediaSurface,
    layout: StoryDeckCardLayout,
    index: number,
    initialContainerWidth: number,
    alternateWideMediaPlacement: boolean,
): React.ReactNode {
    const mediaPlacement = layout === 'wide' && alternateWideMediaPlacement && index % 2 === 1 ? 'end' : 'start';

    switch (card.kind) {
        case 'list':
            return <StoryDeckListCard card={card} layout={layout} testID={testID} />;
        case 'image':
            return (
                <StoryDeckImageCard
                    card={card}
                    isCurrent={isCurrent}
                    mediaSurface={mediaSurface}
                    layout={layout}
                    mediaPlacement={mediaPlacement}
                    initialContainerWidth={initialContainerWidth}
                    testID={testID}
                />
            );
        case 'video':
            return (
                <StoryDeckVideoCard
                    card={card}
                    isCurrent={isCurrent}
                    mediaSurface={mediaSurface}
                    layout={layout}
                    mediaPlacement={mediaPlacement}
                    initialContainerWidth={initialContainerWidth}
                    testID={testID}
                />
            );
        default:
            return null;
    }
}
