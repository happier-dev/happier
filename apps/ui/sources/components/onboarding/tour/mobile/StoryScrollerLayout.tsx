import * as React from 'react';
import {
    Platform,
    ScrollView,
    View,
    useWindowDimensions,
    type LayoutChangeEvent,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
    type ViewProps,
    type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { PlanetBackground } from '../../unauthShell/PlanetBackground';
import { useBrandPaneTokens } from '../../unauthShell/brandPaneTokens';
import { JourneyConfigSlot, type JourneyConfigControllerSurface } from '../config/JourneyConfigSlot';
import { withPersistentJourneySkip } from '../config/journeyConfigNavigation';
import { NarrationColumn } from '../narration/NarrationColumn';
import type { JourneyBeat, JourneyBeatId } from '../state/journeyBeats';
import type { JourneyProgressController } from '../state/useJourneyProgress';

export type StoryScrollerLayoutProps = Readonly<{
    progress: JourneyProgressController;
    controller: JourneyConfigControllerSurface;
    renderStage: (beat: JourneyBeat) => React.ReactNode;
    reducedMotion?: boolean;
    testID?: string;
}>;

// The native accessibility props already hide inactive page descendants. On
// web, `aria-hidden` does not remove a mounted page's ScrollView descendants
// from sequential focus, so use the same typed host boundary as retained panes.
const WebInertView = View as React.ComponentType<
    ViewProps & Pick<React.HTMLAttributes<HTMLElement>, 'inert'>
>;

const PAGE_HORIZONTAL_PADDING = 18;
const PAGE_TOP_PADDING = 16;
const THUMB_ZONE_HORIZONTAL_PADDING = 18;
const THUMB_ZONE_BOTTOM_PADDING = 18;

export function resolveStoryScrollerStageBandPercent(beat: JourneyBeat): 60 | 35 {
    return beat.configStepId ? 35 : 60;
}

/**
 * Natural config-body height (dp) that separates a controller whose thumb zone
 * only has to seat its action row from one carrying a real body. Narration beats
 * hand the slot a placeholder that measures nothing (up to one empty text line on
 * Android); the smallest real body is the two-row attention choice at ~128dp, and
 * the finale reel is several times that.
 */
const SUBSTANTIAL_CONFIG_BODY_HEIGHT = 64;

/**
 * Vertical share of the screen reserved for the bottom thumb zone.
 *
 * `JourneyConfigSlot`'s `scroll` layout is documented as a self-contained,
 * height-bounded region: its body is a `flex: 1` ScrollView above an action row.
 * A content-sized band cannot satisfy that contract — Yoga zeroes a flex line's
 * free space whenever the container is measured against its own content
 * (`SizingMode::FitContent`), which leaves the config body (relay pick, auth,
 * machine setup) and the Back/Next/Skip row at zero height. The band therefore
 * owns a definite share of the root, and the pager takes the remainder.
 *
 * How large a share is a property of the body the controller renders, not of
 * `beat.configStepId`: the finale beat A14 carries no config step yet its body is
 * the entire ShowcaseReel, so keying the share off the beat starved the reel. The
 * layout measures the body instead (see `handleConfigBodyLayout`), which keeps
 * one owner — the controller — for what the zone has to hold.
 */
export function resolveStoryScrollerThumbZonePercent(configBodyHeight: number): 44 | 22 {
    return configBodyHeight >= SUBSTANTIAL_CONFIG_BODY_HEIGHT ? 44 : 22;
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
    // Horizontal and top padding live in `pageInsetStyle`: they carry the device
    // safe area and would be dead declarations here.
    page: {
        flex: 1,
        minHeight: 0,
        paddingBottom: 10,
    },
    stageBand: {
        width: '100%',
        minHeight: 0,
        justifyContent: 'center',
        overflow: 'hidden',
    },
    // The band owns the vertical placement of the narration, so a beat whose copy
    // is shorter than the band stays optically centered like its desktop sibling.
    storyBand: {
        flex: 1,
        minHeight: 0,
        justifyContent: 'center',
        paddingTop: 18,
    },
    // The band resolves to a definite height, so narration cannot be handed to
    // it through an auto-height wrapper: NarrationColumn's root is auto-height
    // around a `flex: 1` transition frame, and Yoga zeroes that frame's free
    // space whenever its container is measured against a definite height
    // (`SizingMode::FitContent`), which paints nothing. A scroll container hands
    // its content view an unbounded main axis instead, so the beat is sized by
    // its own text and long copy scrolls rather than clipping.
    //
    // It hugs that content rather than filling the band (`flexGrow: 0`): Yoga
    // clamps a content-sized scroll container to the room its parent offers, so
    // long copy still scrolls, while short copy leaves the band free space to
    // center. Growing to the band instead — the desktop sibling's `flexGrow: 1`
    // content view — would top-align narration and, on native, hand the
    // narration frame a definite height again.
    storyScroll: {
        flexGrow: 0,
        flexShrink: 1,
        minHeight: 0,
        width: '100%',
    },
    // Deliberately free of `flexGrow`: stretching the content view back to the
    // band height would re-collapse the narration frame.
    storyScrollContent: {
        width: '100%',
    },
    configBodyMeasure: {
        width: '100%',
    },
    // Horizontal and bottom padding live in `thumbZoneStyle`: they carry the
    // device safe area and would be dead declarations here.
    thumbZone: {
        width: '100%',
        minHeight: 0,
        flexGrow: 0,
        paddingTop: 10,
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
    const safeAreaInsets = useSafeAreaInsets();
    const preferredReducedMotion = useReducedMotionPreference();
    const reducedMotion = props.reducedMotion ?? preferredReducedMotion;
    const controller = withPersistentJourneySkip(props.controller, props.progress);
    const currentBeatId = props.progress.currentBeat.id;
    // What the thumb zone must hold is the controller's business, and the
    // controller answers by rendering: the body is measured inside the slot's own
    // content-measured scroller, so its natural height is independent of the
    // share the zone currently has and cannot feed back into it. The measurement
    // belongs to the beat that produced it — stepping to a narration beat must
    // not inherit the finale reel's share.
    const [measuredConfigBody, setMeasuredConfigBody] = React.useState<
        Readonly<{ beatId: JourneyBeatId; height: number }> | null
    >(null);
    const configBodyHeight = measuredConfigBody?.beatId === currentBeatId ? measuredConfigBody.height : 0;
    const handleConfigBodyLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = event.nativeEvent.layout.height;
        setMeasuredConfigBody((current) => (
            current?.beatId === currentBeatId && current.height === height
                ? current
                : { beatId: currentBeatId, height }
        ));
    }, [currentBeatId]);
    const measuredController = {
        ...controller,
        body: (
            <View
                testID={`${testID}-config-body-measure`}
                style={styles.configBodyMeasure}
                onLayout={handleConfigBodyLayout}
            >
                {controller.body}
            </View>
        ),
    } satisfies JourneyConfigControllerSurface;
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

    // The pager position has exactly one owner: the imperative scroll below.
    // `contentOffset` is captured once and never re-derived, because both native
    // scrollers re-apply the prop on every commit whose value changed — iOS
    // Fabric assigns `_scrollView.contentOffset` in RCTScrollViewComponentView,
    // and Android's `contentOffset` @ReactProp calls `scrollTo` — so a value
    // tracking the beat would cut instantly to the destination and leave the
    // animated scroll a no-op. It stays as a mount seed because a journey opened
    // mid-story (`initialBeatId`) would otherwise paint page one for a frame,
    // and because react-native-web drops the prop outright, which is why the
    // declarative prop can never be the position's owner. The mount sync and
    // re-anchoring after a width change are never animated; only a beat change
    // animates, and only when motion is welcome.
    const pagerRef = React.useRef<ScrollView | null>(null);
    const syncedIndexRef = React.useRef<number | null>(null);
    const currentIndex = props.progress.currentIndex;
    const seededContentOffsetRef = React.useRef({ x: currentIndex * pageWidth, y: 0 });
    React.useEffect(() => {
        const previousIndex = syncedIndexRef.current;
        syncedIndexRef.current = currentIndex;
        pagerRef.current?.scrollTo({
            x: currentIndex * pageWidth,
            y: 0,
            animated: previousIndex !== null && previousIndex !== currentIndex && !reducedMotion,
        });
    }, [currentIndex, pageWidth, reducedMotion]);

    // Story pages sit under the notch and the thumb zone sits in the
    // home-indicator strip without these, exactly like the sibling split
    // layout and the unauth workflow pane.
    const pageInsetStyle: ViewStyle = {
        paddingTop: PAGE_TOP_PADDING + safeAreaInsets.top,
        paddingLeft: PAGE_HORIZONTAL_PADDING + safeAreaInsets.left,
        paddingRight: PAGE_HORIZONTAL_PADDING + safeAreaInsets.right,
    };
    const thumbZoneStyle: ViewStyle = {
        flexBasis: `${resolveStoryScrollerThumbZonePercent(configBodyHeight)}%`,
        paddingBottom: THUMB_ZONE_BOTTOM_PADDING + safeAreaInsets.bottom,
        paddingLeft: THUMB_ZONE_HORIZONTAL_PADDING + safeAreaInsets.left,
        paddingRight: THUMB_ZONE_HORIZONTAL_PADDING + safeAreaInsets.right,
    };

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
                ref={pagerRef}
                testID={`${testID}-pager`}
                style={styles.pager}
                horizontal
                pagingEnabled
                contentOffset={seededContentOffsetRef.current}
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                onMomentumScrollEnd={handleMomentumScrollEnd}
            >
                {props.progress.visibleBeats.map((beat) => {
                    const isCurrentBeat = beat.id === props.progress.currentBeat.id;
                    return (
                        <WebInertView
                            key={beat.id}
                            testID={`${testID}-page`}
                            style={[styles.page, pageInsetStyle, { width: pageWidth }]}
                            inert={Platform.OS === 'web' && !isCurrentBeat ? true : undefined}
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
                                <ScrollView
                                    testID={`${testID}-story-scroll-${beat.id}`}
                                    style={styles.storyScroll}
                                    contentContainerStyle={styles.storyScrollContent}
                                    showsVerticalScrollIndicator={false}
                                    keyboardShouldPersistTaps="handled"
                                    tabIndex={Platform.OS === 'web' && !isCurrentBeat ? -1 : undefined}
                                >
                                    <NarrationColumn
                                        beat={beat}
                                        reducedMotion={props.reducedMotion}
                                        testID={`${testID}-narration-${beat.id}`}
                                    />
                                </ScrollView>
                            </View>
                        </WebInertView>
                    );
                })}
            </ScrollView>
            <View testID={`${testID}-thumb-zone`} style={[styles.thumbZone, thumbZoneStyle]}>
                <JourneyConfigSlot
                    controller={measuredController}
                    testID={`${testID}-config`}
                />
            </View>
        </View>
    );
}
