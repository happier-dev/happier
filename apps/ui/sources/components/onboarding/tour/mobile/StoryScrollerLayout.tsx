import * as React from 'react';
import {
    Platform,
    ScrollView,
    View,
    useWindowDimensions,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PlanetBackground } from '../../unauthShell/PlanetBackground';
import { useBrandPaneTokens } from '../../unauthShell/brandPaneTokens';
import { JourneyConfigSlot, type JourneyConfigControllerSurface } from '../config/JourneyConfigSlot';
import { withPersistentJourneySkip } from '../config/journeyConfigNavigation';
import { NarrationColumn } from '../narration/NarrationColumn';
import type { JourneyBeat } from '../state/journeyBeats';
import type { JourneyProgressController } from '../state/useJourneyProgress';

export type StoryScrollerLayoutProps = Readonly<{
    progress: JourneyProgressController;
    controller: JourneyConfigControllerSurface;
    renderStage: (beat: JourneyBeat) => React.ReactNode;
    reducedMotion?: boolean;
    testID?: string;
}>;

export function resolveStoryScrollerStageBandPercent(beat: JourneyBeat): 60 | 35 {
    return beat.configStepId ? 35 : 60;
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
    },
    // R1's mobile welcome fade: transparent -> brand-pane canvas over the
    // bottom 60% so the bottom-anchored narration/config stays readable on the
    // planet (F-W13-5; mirrors WorkflowPanel's planetBottomFade).
    planetBottomFade: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: '60%',
    },
    pager: {
        flex: 1,
        minHeight: 0,
    },
    page: {
        flex: 1,
        minHeight: 0,
        paddingHorizontal: 18,
        paddingTop: 16,
        paddingBottom: 10,
    },
    stageBand: {
        width: '100%',
        minHeight: 0,
        justifyContent: 'center',
        overflow: 'hidden',
    },
    storyBand: {
        flex: 1,
        minHeight: 0,
        justifyContent: 'center',
        paddingTop: 18,
    },
    thumbZone: {
        width: '100%',
        paddingHorizontal: 18,
        paddingTop: 10,
        paddingBottom: 18,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
}));

export function StoryScrollerLayout(props: StoryScrollerLayoutProps): React.ReactElement {
    const styles = stylesheet;
    useUnistyles();
    const testID = props.testID ?? 'journey-mobile';
    const { width } = useWindowDimensions();
    const pageWidth = Math.max(1, width);
    const controller = withPersistentJourneySkip(props.controller, props.progress);
    // The cosmic identity carries into the story presentation exactly like
    // R1's mobile welcome (F-W13-5): the canonical PlanetBackground mobile
    // recipe (300% scale / 1.5 aspect / 20% anchor) behind the pager, on the
    // brand-pane canvas color, with the 60% bottom fade.
    const brandPaneTokens = useBrandPaneTokens();
    const planetFadeColors = [brandPaneTokens.backgroundTransparent, brandPaneTokens.background] as const;

    const handleMomentumScrollEnd = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const measuredWidth = event.nativeEvent.layoutMeasurement.width;
        const eventPageWidth = measuredWidth > 0 ? measuredWidth : pageWidth;
        if (eventPageWidth <= 0) return;

        const nextIndex = Math.max(
            0,
            Math.min(
                props.progress.visibleBeats.length - 1,
                Math.round(event.nativeEvent.contentOffset.x / eventPageWidth),
            ),
        );
        if (nextIndex > props.progress.currentIndex) {
            props.progress.advance();
            return;
        }
        if (nextIndex < props.progress.currentIndex) {
            props.progress.back();
        }
    }, [pageWidth, props.progress]);

    return (
        <View testID={testID} style={[styles.root, { backgroundColor: brandPaneTokens.background }]}>
            <PlanetBackground variant="mobile" />
            <LinearGradient
                testID={`${testID}-planet-fade`}
                pointerEvents="none"
                colors={planetFadeColors}
                locations={[0, 1]}
                style={styles.planetBottomFade}
            />
            <ScrollView
                testID={`${testID}-pager`}
                style={styles.pager}
                horizontal
                pagingEnabled
                contentOffset={{ x: props.progress.currentIndex * pageWidth, y: 0 }}
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                onMomentumScrollEnd={handleMomentumScrollEnd}
            >
                {props.progress.visibleBeats.map((beat) => {
                    const isCurrentBeat = beat.id === props.progress.currentBeat.id;
                    return (
                        <View
                            key={beat.id}
                            testID={`${testID}-page`}
                            style={[styles.page, { width: pageWidth }]}
                            aria-hidden={Platform.OS === 'web' && !isCurrentBeat ? true : undefined}
                            accessibilityElementsHidden={Platform.OS === 'web' ? undefined : !isCurrentBeat}
                            importantForAccessibility={
                                Platform.OS === 'web'
                                    ? undefined
                                    : isCurrentBeat
                                        ? 'auto'
                                        : 'no-hide-descendants'
                            }
                        >
                            <View
                                testID={`${testID}-stage-band-${beat.id}`}
                                style={[
                                    styles.stageBand,
                                    { flexBasis: `${resolveStoryScrollerStageBandPercent(beat)}%` },
                                ]}
                            >
                                {/* The pager keeps narration pages mounted, but the live
                                    DemoStage is one current-beat owner and already warms
                                    its neighboring frames internally. */}
                                {isCurrentBeat ? props.renderStage(beat) : null}
                            </View>
                            <View
                                testID={`${testID}-story-band-${beat.id}`}
                                style={styles.storyBand}
                            >
                                <NarrationColumn
                                    beat={beat}
                                    reducedMotion={props.reducedMotion}
                                    testID={`${testID}-narration-${beat.id}`}
                                />
                            </View>
                        </View>
                    );
                })}
            </ScrollView>
            <View testID={`${testID}-thumb-zone`} style={styles.thumbZone}>
                <JourneyConfigSlot
                    controller={controller}
                    testID={`${testID}-config`}
                />
            </View>
        </View>
    );
}
