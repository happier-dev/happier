import * as React from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    Easing,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { ControlRow, TactilePressable, VoiceTransport } from '../ConceptControls';
import { LinearGradient } from 'expo-linear-gradient';

import { Bloom, Grain, PlanetOrb, VoiceWaveform } from '../VoiceLight';
import { useVoiceLabEnergy } from '../useVoiceLabEnergy';
import { controlsForState } from '../voiceLabModel';
import { VOICE_MOTION, light, onPlanetInk, useVoiceLabTokens } from '../voiceLabTokens';
import { useVoiceOrbExpanded } from '../voiceLabOrbPreference';
import type { VoiceConceptProps } from '../conceptTypes';

const EASE_SPATIAL = Easing.bezier(...(VOICE_MOTION.spatial.bezier as [number, number, number, number]));

/** Collapsed diameter. Expanded is the same object scaled, never a second one. */
const ORB = 34;
const ORB_EXPANDED_SCALE = 2.7;
/** Bottom-sheet geometry, following the Grok composer's proportions. */
const SHEET_HEIGHT = 236;
const BAR_RADIUS = 24;
const BAR_BUTTON = 36;
const EDGE = 14;
const BOTTOM = 34;

/**
 * ORB — the Happier planet as a floating mobile companion.
 *
 * The structural claim: on mobile there is no sidebar to put Voice in
 * (`PhoneMainView` has no sidebar at all), so Global Voice has to become an
 * object with a position.
 *
 * The expanded form follows the Grok composer's shape, which is the strongest
 * layout in the reference set: a **centred persona orb with its caption beneath
 * it, above a single pill-shaped control bar** carrying end · meter · mic.
 * Theirs is a 72pt bubble with 36pt circular buttons in a 24-radius bar; the
 * same proportions are used here with the Happier planet in place of their
 * bubble, and the earthy planet palette in place of their monochrome.
 *
 * The important difference from a modal: the orb is **one object throughout**.
 * Collapsed it sits in the corner; opening interpolates its position and scale
 * to the sheet's centre while the caption and bar rise beneath it. It is never
 * unmounted and re-mounted, so there is no moment where the user loses the
 * thing they were looking at.
 */
export function OrbConcept(props: VoiceConceptProps) {
    const tokens = useVoiceLabTokens();
    const energy = useVoiceLabEnergy();
    const { state } = props;
    /*
     * Minimised vs expanded is a *preference*, not transient state: it survives
     * the app so the user does not have to re-make the same choice every
     * session. The lab's own Expand control still works — it writes the same
     * preference — so the two never disagree.
     */
    const [persistedExpanded, setPersistedExpanded] = useVoiceOrbExpanded();
    const expanded = props.expanded || persistedExpanded;
    const dormant = state.id === 'ready' || state.id === 'unavailable';
    const live = !dormant && state.id !== 'error' && state.id !== 'ended';
    // The transport owns start/end/mute; everything else (retry, Open Inbox,
    // Go to session…) stays contextual and provider-gated.
    const extra = controlsForState(state.id, props.provider, props.surface === 'session')
        .filter((c) => c.id !== 'start' && c.id !== 'end' && c.id !== 'mute');

    const [bounds, setBounds] = React.useState({ w: 320, h: 480 });

    // Drag offset from the resting corner, in points. Only meaningful collapsed.
    const dx = useSharedValue(0);
    const dy = useSharedValue(0);
    const startX = useSharedValue(0);
    const startY = useSharedValue(0);
    const dragging = useSharedValue(0);

    const open = useSharedValue(expanded ? 1 : 0);
    React.useEffect(() => {
        open.set(
            energy.reduced
                ? (expanded ? 1 : 0)
                : withTiming(expanded ? 1 : 0, {
                    duration: expanded ? VOICE_MOTION.spatial.durationMs : VOICE_MOTION.exit.durationMs,
                    easing: EASE_SPATIAL,
                }),
        );
        // Docking resets the drag: the sheet is always centred, so a dragged
        // orb must travel back rather than pull the composition off-axis.
        if (expanded) {
            dx.set(withTiming(0, { duration: VOICE_MOTION.spatial.durationMs, easing: EASE_SPATIAL }));
            dy.set(withTiming(0, { duration: VOICE_MOTION.spatial.durationMs, easing: EASE_SPATIAL }));
        }
    }, [dx, dy, energy.reduced, expanded, open]);

    const onSwipeOpen = React.useCallback(() => setPersistedExpanded(true), [setPersistedExpanded]);

    const pan = React.useMemo(
        () =>
            Gesture.Pan()
                .enabled(!expanded)
                .onBegin(() => {
                    'worklet';
                    dragging.set(withTiming(1, { duration: 120 }));
                    startX.set(dx.get());
                    startY.set(dy.get());
                })
                .onUpdate((e) => {
                    'worklet';
                    // 1:1 with the finger. Anything else reads as lag.
                    dx.set(startX.get() + e.translationX);
                    dy.set(startY.get() + e.translationY);
                })
                .onFinalize((e) => {
                    'worklet';
                    dragging.set(withTiming(0, { duration: 180 }));
                    /*
                     * A decisive upward flick opens the sheet. This replaces the
                     * chevron: a chip parked on the planet read as a second
                     * object stuck to it, and a bottom-anchored sheet already
                     * implies swipe-to-open. Tap stays the transport.
                     */
                    if (e.velocityY < -700 && Math.abs(e.velocityY) > Math.abs(e.velocityX)) {
                        dx.set(withSpring(0, { damping: 22, stiffness: 190 }));
                        dy.set(withSpring(0, { damping: 24, stiffness: 200 }));
                        runOnJS(onSwipeOpen)();
                        return;
                    }
                    // Project the throw before choosing an edge, so a flick lands
                    // where it was aimed rather than where the finger left.
                    const projected = dx.get() + e.velocityX * 0.12;
                    const minX = -(bounds.w - ORB - EDGE * 2);
                    const targetX = projected < minX / 2 ? minX : 0;
                    // Never above the header, never below the home indicator.
                    const targetY = Math.max(
                        -(bounds.h - ORB - BOTTOM - 60),
                        Math.min(0, dy.get() + e.velocityY * 0.12),
                    );
                    dx.set(withSpring(targetX, { damping: 22, stiffness: 190, velocity: e.velocityX }));
                    dy.set(withSpring(targetY, { damping: 24, stiffness: 200, velocity: e.velocityY }));
                }),
        [bounds.h, bounds.w, dragging, dx, dy, expanded, onSwipeOpen, startX, startY],
    );

    // The orb's resting corner, and where it docks when the sheet opens.
    const cornerX = bounds.w - EDGE - ORB;
    const cornerY = bounds.h - BOTTOM - ORB;
    const dockedX = (bounds.w - ORB) / 2;
    // Close to its caption, not floating above it. At 2.2x a 42pt orb is 92pt
    // tall; docking it just inside the sheet's top edge puts ~12pt between the
    // planet's lower limb and the status word.
    const dockedY = bounds.h - SHEET_HEIGHT + 10;

    const orbStyle = useAnimatedStyle(() => {
        'worklet';
        const p = open.get();
        const restX = cornerX + dx.get();
        const restY = cornerY + dy.get();
        return {
            transform: [
                { translateX: restX + (dockedX - restX) * p },
                { translateY: restY + (dockedY - restY) * p },
                { scale: (1 + (ORB_EXPANDED_SCALE - 1) * p) * (1 + dragging.get() * 0.06) },
            ],
        };
    });

    // Caption and bar rise under the orb rather than arriving as a slab.
    const contentStyle = useAnimatedStyle(() => {
        'worklet';
        const p = open.get();
        return {
            opacity: Math.max(0, p * 1.4 - 0.4),
            pointerEvents: p > 0.5 ? 'auto' : 'none',
            transform: [{ translateY: (1 - p) * 18 }],
        } as never;
    });

    // Inside the orb the meter only exists while collapsed — once the sheet is
    // open the full-width meter in the bar is the better instrument.
    const collapsedMeterStyle = useAnimatedStyle(() => {
        'worklet';
        return { opacity: 1 - Math.min(1, open.get() * 2) };
    });


    const floorStyle = useAnimatedStyle(() => {
        'worklet';
        const p = open.get();
        return { opacity: p, pointerEvents: p > 0.5 ? 'auto' : 'none' } as never;
    });

    return (
        <View
            style={{ flex: 1 }}
            pointerEvents="box-none"
            onLayout={(e) => {
                const { width, height } = e.nativeEvent.layout;
                setBounds({ w: Math.round(width), h: Math.round(height) });
            }}
        >
            {/*
              * A luminous floor rather than a scrim over the whole app. Voice
              * often runs *while* the user watches a build, so the content above
              * must stay readable — the sheet lights its own region instead of
              * dimming the world.
              */}
            <Animated.View
                style={[
                    { position: 'absolute', left: 0, right: 0, bottom: 0, height: SHEET_HEIGHT, overflow: 'hidden' },
                    floorStyle,
                ]}
            >
                <View
                    style={{
                        position: 'absolute',
                        inset: 0,
                        backgroundColor: tokens.dark ? 'rgba(12,11,17,0.93)' : 'rgba(252,251,253,0.95)',
                    }}
                />
                <Bloom
                    size={bounds.w * 1.5}
                    blur={bounds.w * 0.32}
                    stop={state.stop}
                    alpha={0.34}
                    polarity={1}
                    reactivity={1}
                    style={{ left: -bounds.w * 0.25, top: -bounds.w * 0.2 }}
                />
                <Grain />
                {/* The floor resolves into the content above it rather than
                    slicing across a session row with a hairline. */}
                <LinearGradient
                    colors={[tokens.hostSurfaceTransparent, tokens.hostSurface]}
                    locations={[0, 1]}
                    style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 26 }}
                    pointerEvents="none"
                />
            </Animated.View>

            {/* Caption + transport bar, anchored to the bottom and centred. */}
            <Animated.View
                style={[
                    { position: 'absolute', left: 0, right: 0, bottom: 0, paddingBottom: BOTTOM - 12 },
                    contentStyle,
                ]}
            >
                <View style={{ alignItems: 'center', paddingHorizontal: 20, paddingBottom: 14, gap: 3 }}>
                    <Text
                        numberOfLines={1}
                        style={{
                            ...Typography.default('semiBold'),
                            fontSize: 17,
                            letterSpacing: -0.3,
                            color: tokens.ink,
                        }}
                    >
                        {state.label}
                    </Text>
                    {state.caption ? (
                        <Text
                            numberOfLines={1}
                            style={{ ...Typography.default(), fontSize: 13, color: tokens.inkMuted }}
                        >
                            {state.caption}
                        </Text>
                    ) : null}
                </View>


                {/*
                  * One pill: transport · meter · contextual.
                  *
                  * This goes through `VoiceTransport` and `ControlRow` rather
                  * than hand-rolled buttons — hand-rolling is exactly how the
                  * bar ended up showing a stop square in every state, a meter
                  * with no audio behind it, and no retry on an error.
                  */}
                <View
                    style={{
                        marginHorizontal: 12,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                        paddingHorizontal: 12,
                        paddingVertical: 12,
                        borderRadius: BAR_RADIUS,
                        borderWidth: 1,
                        borderColor: tokens.rule,
                        backgroundColor: tokens.dark ? 'rgba(32,28,40,0.86)' : 'rgba(0,0,0,0.042)',
                    }}
                >
                    <VoiceTransport
                        live={live}
                        canStart={state.id !== 'unavailable'}
                        muted={props.muted}
                        canMute={live}
                        onStart={() => props.onAction('start')}
                        onEnd={() => props.onAction('end')}
                        onToggleMute={props.onToggleMute}
                        onAction={props.onAction}
                    />

                    {/* A meter with no audio behind it is decoration. */}
                    {live ? <VoiceWaveform stop={state.stop} height={24} /> : <View style={{ flex: 1 }} />}

                    {extra.length > 0 ? (
                        <ControlRow controls={extra} onAction={props.onAction} />
                    ) : null}
                </View>
            </Animated.View>

            {/* The orb. One object: it travels between corner and dock. */}
            <GestureDetector gesture={pan}>
                <Animated.View style={[{ position: 'absolute', left: 0, top: 0 }, orbStyle]}>
                    <TactilePressable
                        static
                        accessibilityLabel={`Voice. ${state.label}. ${props.muted ? 'Microphone muted.' : ''}`}
                        accessibilityHint={
                            expanded
                                ? 'Minimises Voice'
                                : live
                                    ? 'Ends the spoken conversation. Coding work already started keeps running. Swipe up to open the conversation.'
                                    : 'Starts a spoken conversation. Swipe up to open the conversation.'
                        }
                        onPress={() => {
                            // Minimised, the orb is the transport — one tap
                            // starts or ends, which is the whole point of
                            // keeping it in the corner. Expanded, it minimises.
                            if (expanded) {
                                setPersistedExpanded(false);
                                return;
                            }
                            props.onAction(live ? 'end' : 'start');
                        }}
                        onLongPress={() => setPersistedExpanded(true)}
                    >
                        <View>
                            <PlanetOrb size={ORB} tint={state.stop} tintAmount={0.11} />
                            {/*
                              * Minimised, the orb IS the meter. A collapsed
                              * companion that shows only a colour tells you
                              * something is on; showing the voice inside it tells
                              * you what it is doing, which is the whole reason to
                              * keep it on screen at all.
                              */}
                            {live ? (
                                <Animated.View
                                    pointerEvents="none"
                                    style={[
                                        {
                                            position: 'absolute',
                                            left: ORB * 0.26,
                                            right: ORB * 0.26,
                                            top: ORB * 0.38,
                                            height: ORB * 0.24,
                                        },
                                        collapsedMeterStyle,
                                    ]}
                                >
                                    <VoiceWaveform
                                        stop={state.stop}
                                        slots={7}
                                        height={ORB * 0.24}
                                        barWidth={2}
                                        color={onPlanetInk(tokens)}
                                    />
                                </Animated.View>
                            ) : null}
                            {/*
                              * The mute pip. On a collapsed object the single most
                              * important fact is whether the microphone is open,
                              * and it must not depend on the body's colour.
                              */}
                            {props.muted ? (
                                <View
                                    style={{
                                        position: 'absolute',
                                        right: -1,
                                        bottom: -1,
                                        width: 18,
                                        height: 18,
                                        borderRadius: 18,
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        backgroundColor: light('warm', 1, tokens),
                                        borderWidth: 2,
                                        borderColor: tokens.hostSurface,
                                    }}
                                >
                                    <View
                                        style={{
                                            width: 9,
                                            height: 1.6,
                                            borderRadius: 2,
                                            backgroundColor: tokens.dark ? '#131111' : '#FFFFFF',
                                            transform: [{ rotate: '-45deg' }],
                                        }}
                                    />
                                </View>
                            ) : null}
                        </View>
                    </TactilePressable>

                </Animated.View>
            </GestureDetector>

            <View
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', left: -10_000 }}
            >
                <Text>{props.muted ? `${state.announcement} Microphone muted.` : state.announcement}</Text>
            </View>
        </View>
    );
}


/** A mic drawn from primitives so the muted slash is a real object. */
const MicMark = React.memo(function MicMark(props: Readonly<{ muted: boolean; color: string }>) {
    return (
        <View style={{ width: 17, height: 17, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: 6.5, height: 9.5, borderRadius: 3.5, backgroundColor: props.color, marginTop: -2 }} />
            <View
                style={{
                    width: 11,
                    height: 5.5,
                    borderBottomLeftRadius: 7,
                    borderBottomRightRadius: 7,
                    borderWidth: 1.5,
                    borderTopWidth: 0,
                    borderColor: props.color,
                    marginTop: 1,
                }}
            />
            {props.muted ? (
                <View
                    style={{
                        position: 'absolute',
                        width: 20,
                        height: 1.7,
                        borderRadius: 2,
                        backgroundColor: props.color,
                        transform: [{ rotate: '-45deg' }],
                    }}
                />
            ) : null}
        </View>
    );
});
