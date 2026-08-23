import * as React from 'react';
import { Platform, Pressable, ScrollView, View, type ViewStyle } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveOverlayPointerEvents } from '@/components/ui/overlays/resolveOverlayPointerEvents';
import type { CompanionPoint } from '@/components/companion/interaction/useCompanionNativePanGesture';
import { useCompanionNoDragRegions } from '@/components/companion/interaction/CompanionNoDragRegion';
import {
    ControlRow,
    VoiceTransport,
    type VoiceControlAction,
    type VoiceControlId,
} from '@/components/voice/controls/VoiceControls';
import { Bloom, Grain, PlanetOrb, VoiceWaveform } from '@/components/voice/light/VoiceLight';
import { useVoiceEnergy, useVoiceEnergyPresence } from '@/components/voice/light/useVoiceEnergy';
import {
    VOICE_MOTION,
    light,
    onPlanetInk,
    useVoiceLightTokens,
} from '@/components/voice/light/voiceLightTokens';
import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';

import { useVoiceOrbDrag } from './useVoiceOrbDrag';
import {
    VOICE_ORB_BAR_RADIUS,
    VOICE_ORB_BOTTOM,
    VOICE_ORB_DRAG_LIFT_SCALE,
    VOICE_ORB_EXPANDED_SCALE,
    VOICE_ORB_HIT_TARGET,
    VOICE_ORB_SIZE,
    VOICE_ORB_SWIPE_OPEN_VELOCITY,
    resolveVoiceOrbInteractionGeometry,
    resolveVoiceOrbSheetLayout,
} from './voiceOrbGeometry';

const EASE_SPATIAL = Easing.bezier(...(VOICE_MOTION.spatial.bezier as [number, number, number, number]));
/** ARIA key names, space separated — not user-visible copy, so not translated. */
const VOICE_ORB_EXPANSION_KEY_SHORTCUTS = 'ArrowUp ArrowDown';
const VoiceOrbSheetBoundary = Animated.View as React.ComponentType<
    React.ComponentProps<typeof Animated.View>
    & Pick<React.HTMLAttributes<HTMLElement>, 'inert'>
>;

export type VoiceOrbLabels = Readonly<{
    /** States the current state, not just the control. */
    orb: string;
    startHint: string;
    endHint: string;
    expandAction: string;
    collapseAction: string;
    startAction: string;
    endAction: string;
    status: string;
    caption: string | null;
    transport: React.ComponentProps<typeof VoiceTransport>['labels'];
}>;

/**
 * ORB — the Happier planet as a floating companion (§2.2).
 *
 * One object that travels: collapsed it is a 34pt planet in a corner and *is* the transport;
 * expanded it is the same planet scaled 2.7× and docked above a bottom sheet. It is never unmounted
 * and remounted, so the user never loses the thing they were looking at.
 *
 * Presentational: every string arrives as a prop and every action routes through the caller's
 * `VoiceAttemptControlProjection`. It owns no lifecycle and reads no placement policy.
 */
export function VoiceOrb(props: Readonly<{
    control: VoiceAttemptControlProjection;
    labels: VoiceOrbLabels;
    expanded: boolean;
    onExpandedChange: (next: boolean) => void;
    /** Distance from the bottom of the host to the orb's resting edge (safe area + chrome). */
    restingBottomInset: number;
    /**
     * How much vertical space the sheet may take — viewport minus safe area, minus the keyboard.
     *
     * A ceiling, not the height: the sheet measures its own content and renders at
     * `min(desired, available)` (§2.7). Passing a frozen `236` here is what let a long locale or an
     * open keyboard cut the transport bar off the bottom of the sheet.
     */
    availableSheetHeight: number;
    /** Contextual controls beyond the transport (retry, open conversation…). */
    extraControls?: readonly VoiceControlAction[];
    onAction?: (id: VoiceControlId) => void;
    testID?: string;
}>): React.ReactElement {
    const tokens = useVoiceLightTokens();
    const energy = useVoiceEnergy();
    const energyPresence = useVoiceEnergyPresence();
    const noDragRegions = useCompanionNoDragRegions();
    const { control, labels, expanded } = props;
    // CSS has no `box-none`. On web the full-size frame must therefore be `none`,
    // with the orb and expanded panel explicitly opting back into pointer input below.
    const passthroughPointerEvents = resolveOverlayPointerEvents(
        Platform.OS === 'web' ? 'none' : 'box-none',
    );
    const interactivePointerEvents = resolveOverlayPointerEvents('auto');
    const decorativePointerEvents = resolveOverlayPointerEvents('none');
    const sheetPointerEvents = resolveOverlayPointerEvents(
        Platform.OS === 'web' ? 'none' : (expanded ? 'box-none' : 'none'),
    );
    const sheetContentPointerEvents = resolveOverlayPointerEvents(expanded ? 'auto' : 'none');
    React.useEffect(() => {
        energyPresence.acquire();
        return () => energyPresence.release();
    }, [energyPresence]);
    /*
     * The transport reads *actionability*, not presence.
     *
     * `control.live` only says an attempt object exists — an errored one still does. Drawing End,
     * the meter and the "ends the conversation" hint from it put an enabled End on screen in a
     * state where nothing could be ended (§2.2). `canStop` is the same fact the press acts on, so
     * the two cannot disagree; the availability ladder above routes that state to recovery instead.
     */
    const live = control.canStop;
    const stop = control.stop;
    const primaryActionLabel = control.primaryActionLabel ?? labels.startAction;
    const primaryActionHint = control.primaryActionHint ?? labels.startHint;
    const transportLabels = React.useMemo(() => ({
        ...labels.transport,
        micState: control.micStateLabel,
        start: primaryActionLabel,
        startHint: primaryActionHint,
        startText: primaryActionLabel,
        end: primaryActionLabel,
        endHint: primaryActionHint,
        endText: primaryActionLabel,
    }), [control.micStateLabel, labels.transport, primaryActionHint, primaryActionLabel]);

    const [bounds, setBounds] = React.useState({ w: 320, h: 480 });
    const orbRef = React.useRef<React.ComponentRef<typeof Pressable> | null>(null);
    const [orbFocused, setOrbFocused] = React.useState(false);

    /*
     * §2.7 — the sheet is measured, then clamped, and the bar is never what gets cut.
     *
     * The status/caption block and the transport bar report their natural heights, so a long
     * translation, 200% web text or Dynamic Type grows the sheet instead of overflowing it. When
     * the growth exceeds what the viewport and keyboard leave, the *caption* becomes the sheet's
     * one internal scroll owner — End Voice, recovery and the contextual actions stay pinned.
     */
    const contentBottomPadding = Math.max(0, props.restingBottomInset + VOICE_ORB_BOTTOM - 12);
    const [captionHeight, setCaptionHeight] = React.useState(0);
    const [barHeight, setBarHeight] = React.useState(0);
    const sheet = resolveVoiceOrbSheetLayout({
        availableHeight: props.availableSheetHeight,
        content: { captionHeight, barHeight, bottomPadding: contentBottomPadding },
    });
    const sheetHeight = sheet.height;

    // One geometry owner positions the physical 48pt target. The 34pt planet is centred inside it,
    // so its resting, edge-clamp and docked coordinates remain exactly where they were.
    const interactionGeometry = resolveVoiceOrbInteractionGeometry({
        hostWidth: bounds.w,
        hostHeight: bounds.h,
        restingBottomInset: props.restingBottomInset,
        sheetHeight,
    });
    const dockedX = interactionGeometry.dockedPoint.x;
    const dockedY = interactionGeometry.dockedPoint.y;
    const dragBounds = React.useMemo(
        () => interactionGeometry.dragBounds,
        [
            interactionGeometry.dragBounds.maxX,
            interactionGeometry.dragBounds.maxY,
            interactionGeometry.dragBounds.minX,
            interactionGeometry.dragBounds.minY,
        ],
    );
    const initialPoint = React.useMemo<CompanionPoint>(
        () => interactionGeometry.restingPoint,
        [interactionGeometry.restingPoint.x, interactionGeometry.restingPoint.y],
    );

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
    }, [energy.reduced, expanded, open]);

    const onExpandedChange = props.onExpandedChange;
    const handleRelease = React.useCallback((release: Readonly<{
        velocityX: number;
        velocityY: number;
    }>) => {
        /*
         * A decisive upward flick opens the sheet. This replaces the chevron: a chip parked on the
         * planet read as a second object stuck to it, and a bottom-anchored sheet already implies
         * swipe-to-open. Tap stays the transport.
         */
        if (
            release.velocityY < VOICE_ORB_SWIPE_OPEN_VELOCITY
            && Math.abs(release.velocityY) > Math.abs(release.velocityX)
        ) {
            onExpandedChange(true);
        }
    }, [onExpandedChange]);

    const pan = useVoiceOrbDrag({
        enabled: !expanded,
        bounds: dragBounds,
        initialPoint,
        noDragRegions,
        onDragRelease: handleRelease,
        motionPolicy: energy.reduced ? 'snap' : 'animate',
    });

    const gesture = React.useMemo(
        // Off on web: the pointer session owns the drag there, and two live drag owners on one
        // object is the split-brain this hook exists to close.
        () => pan.gesture.enabled(!expanded && Platform.OS !== 'web'),
        [expanded, pan.gesture],
    );

    const translateX = pan.translateX;
    const translateY = pan.translateY;
    const dragProgress = pan.dragProgress;
    /*
     * Press feedback lives on the orb's own transform rather than in a second pressable primitive:
     * the orb is one animated object that is already interpolating position, dock and drag lift, and
     * wrapping it in another animated pressable would give the same body two competing scales.
     */
    const pressed = useSharedValue(0);
    const orbStyle = useAnimatedStyle(() => {
        'worklet';
        const p = open.get();
        const restX = translateX.get();
        const restY = translateY.get();
        return {
            transform: [
                { translateX: restX + (dockedX - restX) * p },
                { translateY: restY + (dockedY - restY) * p },
                {
                    scale: (1 + (VOICE_ORB_EXPANDED_SCALE - 1) * p)
                        * (1 + dragProgress.get() * VOICE_ORB_DRAG_LIFT_SCALE)
                        * (1 - pressed.get() * 0.04),
                },
            ],
        };
    });

    // Caption and bar rise under the orb rather than arriving as a slab.
    const contentStyle = useAnimatedStyle(() => {
        'worklet';
        const p = open.get();
        return {
            opacity: Math.max(0, p * 1.4 - 0.4),
            transform: [{ translateY: (1 - p) * 18 }],
        } as never;
    });

    // Inside the orb the meter only exists while collapsed — once the sheet is open the full-width
    // meter in the bar is the better instrument.
    const collapsedMeterStyle = useAnimatedStyle(() => {
        'worklet';
        return { opacity: 1 - Math.min(1, open.get() * 2) };
    });

    const floorStyle = useAnimatedStyle(() => {
        'worklet';
        const p = open.get();
        return { opacity: p };
    });

    const collapse = React.useCallback(() => {
        onExpandedChange(false);
        // Focus returns to the orb, not to the start of the document.
        const node = orbRef.current as unknown as { focus?: () => void } | null;
        node?.focus?.();
    }, [onExpandedChange]);

    const handlePress = React.useCallback(() => {
        // A drag past threshold cancels the tap; a drag that starts and ends in place is a tap.
        if (pan.shouldSuppressPress()) return;
        // Minimised, the orb IS the transport — one tap starts or ends, which is the whole point of
        // keeping it in the corner. Expanded, it minimises.
        if (expanded) {
            collapse();
            return;
        }
        control.onPrimaryAction();
    }, [collapse, control, expanded, pan]);

    const accessibilityActions = React.useMemo(() => ([
        { name: 'activate', label: primaryActionLabel },
        expanded
            ? { name: 'collapse' as const, label: labels.collapseAction }
            : { name: 'expand' as const, label: labels.expandAction },
    ]), [expanded, labels.collapseAction, labels.expandAction, primaryActionLabel]);

    const onAccessibilityAction = React.useCallback((event: Readonly<{
        nativeEvent: Readonly<{ actionName: string }>;
    }>) => {
        const action = event.nativeEvent.actionName;
        if (action === 'expand') onExpandedChange(true);
        else if (action === 'collapse') collapse();
        /*
         * `activate` is the *transport*, on both sides of the expansion.
         *
         * Routing it through the pointer handler made the expanded orb's only default action
         * minimise the sheet — a screen-reader user could open the companion and then had no way to
         * start or end Voice from it at all, because Collapse was published twice under two names.
         * Expand/Collapse stay separate actions; this one always does what a press on the transport
         * does, and the availability ladder decides whether that is start, end or recovery.
         *
         * Only the three names published above act. Starting or ending a live conversation is not a
         * safe default for an action nobody asked for, so anything else — a platform action the
         * runtime added, a misdispatch, a future name — falls through to nothing.
         */
        else if (action === 'activate') control.onPrimaryAction();
    }, [collapse, control, onExpandedChange]);

    /*
     * One node, two owners: focus return after collapse needs the element, and the web pointer
     * session needs it to attach its `pointerdown` listener and capture the pointer against it.
     */
    const dragTargetRef = pan.dragTargetRef;
    const setOrbNode = React.useCallback((node: React.ComponentRef<typeof Pressable> | null) => {
        orbRef.current = node;
        dragTargetRef(node);
    }, [dragTargetRef]);

    const onContainerKeyDown = React.useCallback((event: unknown) => {
        const key = (event as { nativeEvent?: { key?: string }; key?: string }).nativeEvent?.key
            ?? (event as { key?: string }).key;
        if (key === 'Escape' && expanded) {
            (event as { preventDefault?: () => void }).preventDefault?.();
            collapse();
        }
    }, [collapse, expanded]);

    const onOrbKeyDownCapture = React.useCallback((event: unknown) => {
        const key = (event as { nativeEvent?: { key?: string }; key?: string }).nativeEvent?.key
            ?? (event as { key?: string }).key;
        const repeat = (event as { nativeEvent?: { repeat?: boolean } }).nativeEvent?.repeat
            ?? (event as { repeat?: boolean }).repeat
            ?? false;

        /*
         * The keyboard equivalent of the approved upward flick (§2.2).
         *
         * Expand/Collapse is published *only* through `accessibilityActions`, which
         * react-native-web does not implement — so on web a keyboard or screen-reader user could
         * start and end Voice but never open the sheet, and therefore never reach Mute. Arrow keys
         * mirror the gesture vocabulary the spec already approved and collide with nothing:
         * Enter/Space stay the transport, Escape stays collapse.
         */
        if (key === 'ArrowUp' || key === 'ArrowDown') {
            const next = key === 'ArrowUp';
            if (next === expanded) return;
            (event as { preventDefault?: () => void }).preventDefault?.();
            (event as { stopPropagation?: () => void }).stopPropagation?.();
            if (next) onExpandedChange(true);
            else collapse();
            return;
        }

        if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return;

        /*
         * React Native Web normally turns Enter/Space into `onPress` on key-up. That is truthful
         * while collapsed, but expanded pointer presses intentionally collapse the sheet. Claim
         * keyboard transport in capture before Pressable starts its synthesized press session, so
         * the same key cannot later arrive as a second pointer-like activation.
         */
        (event as { preventDefault?: () => void }).preventDefault?.();
        (event as { stopPropagation?: () => void }).stopPropagation?.();
        /*
         * A held key is one press, not one press per repeat interval.
         *
         * Every other Voice control is a real `<button>` and inherits this from the platform: the
         * browser activates Space once, on key-up. The orb claims the key itself, so it has to
         * carry the rule too — and Start/End is the one action that tears a live realtime session
         * down and builds a new one, so a leaning finger would otherwise run that at the OS repeat
         * rate. The repeat still has to be consumed above rather than returned early: handing it
         * back to the browser would just get it answered by the native activation this handler
         * exists to replace.
         */
        if (repeat) return;
        control.onPrimaryAction();
    }, [collapse, control, expanded, onExpandedChange]);

    const extraControls = props.extraControls ?? [];

    return (
        <View
            testID={props.testID}
            style={[{ flex: 1 }, passthroughPointerEvents.webStyle]}
            // The luminous floor is non-modal: transparent regions never intercept unrelated app
            // interaction, and there is no focus trap — a modal or popover always wins.
            pointerEvents={passthroughPointerEvents.nativePointerEvents}
            onLayout={(event) => {
                const { width, height } = event.nativeEvent.layout;
                setBounds((current) => (
                    current.w === Math.round(width) && current.h === Math.round(height)
                        ? current
                        : { w: Math.round(width), h: Math.round(height) }
                ));
            }}
            {...(Platform.OS === 'web' ? { onKeyDown: onContainerKeyDown } : {})}
        >
            {/*
              * The orb. One object: it travels between corner and dock.
              *
              * It is rendered *before* the sheet because it is the sheet's disclosure trigger, and
              * sequential keyboard navigation follows document order: with the sheet first, Tab from
              * a focused orb left the companion entirely and End Voice and Mute were only reachable
              * backwards. Document order now matches the reading order the expanded sheet already
              * draws — planet, status, then the bar. Paint order is restored explicitly below, since
              * the docked planet overlaps the luminous floor and must stay on top of it.
              */}
            <GestureDetector gesture={gesture}>
                <Animated.View style={[{ position: 'absolute', left: 0, top: 0, zIndex: 1 }, orbStyle]}>
                    <Pressable
                        ref={setOrbNode}
                        style={[
                            {
                                width: VOICE_ORB_HIT_TARGET,
                                height: VOICE_ORB_HIT_TARGET,
                                alignItems: 'center',
                                justifyContent: 'center',
                            },
                            interactivePointerEvents.webStyle,
                            orbFocused && Platform.OS === 'web' ? {
                                outlineStyle: 'solid',
                                outlineWidth: 2,
                                outlineColor: tokens.ink,
                                outlineOffset: 2,
                            } as ViewStyle : undefined,
                        ]}
                        pointerEvents={interactivePointerEvents.nativePointerEvents}
                        accessibilityRole="button"
                        testID="voice.orb.body"
                        accessibilityLabel={labels.orb}
                        accessibilityHint={primaryActionHint}
                        /*
                         * The one spelling that lands on both platforms, as `TactilePressable`
                         * already documents: react-native-web has no `accessibilityState` handling,
                         * only `aria-expanded` reaches the DOM, and React Native's own Pressable
                         * folds `aria-expanded` back into `accessibilityState.expanded` for native
                         * assistive tech. Without it the orb never told anyone whether the sheet —
                         * and therefore Mute — was open.
                         */
                        aria-expanded={expanded}
                        // A custom-gesture-only control is unreachable: Start/End and
                        // Expand/Collapse are exposed as screen-reader actions too.
                        accessibilityActions={accessibilityActions}
                        onAccessibilityAction={onAccessibilityAction}
                        onFocus={() => setOrbFocused(true)}
                        onBlur={() => setOrbFocused(false)}
                        onPressIn={() => pressed.set(
                            energy.reduced
                                ? 1
                                : withTiming(1, { duration: VOICE_MOTION.feedback.durationMs }),
                        )}
                        onPressOut={() => pressed.set(
                            energy.reduced
                                ? 0
                                : withTiming(0, { duration: VOICE_MOTION.local.durationMs }),
                        )}
                        onPress={handlePress}
                        // Long-press opens; it must not fire Start or End on the way, which RN
                        // guarantees by not calling `onPress` once `onLongPress` has fired.
                        onLongPress={() => onExpandedChange(true)}
                        // A physical 48×48 wrapper contains the centred 34pt planet. Native parents
                        // may clip hit slop, so the interaction target itself owns the required size.
                        // The web grab handle the shared pointer-drag selectors look for, and the
                        // pointer-down that opens a drag session against it.
                        {...(Platform.OS === 'web'
                            ? {
                                dataSet: { voiceOrb: 'true' },
                                'data-voice-orb': 'true',
                                onKeyDownCapture: onOrbKeyDownCapture,
                                // Web's replacement for the `accessibilityActions` react-native-web
                                // never implements: the keys that actually reach Expand/Collapse,
                                // announced by the screen reader alongside `aria-expanded`.
                                'aria-keyshortcuts': VOICE_ORB_EXPANSION_KEY_SHORTCUTS,
                            }
                            : {})}
                        {...pan.pointerHandlers}
                    >
                        <View>
                            <PlanetOrb size={VOICE_ORB_SIZE} tint={stop} tintAmount={0.11} />
                            {/*
                              * Minimised, the orb IS the meter. A collapsed companion that shows
                              * only a colour tells you something is on; showing the voice inside it
                              * tells you what it is doing.
                              */}
                            {live ? (
                                <Animated.View
                                    pointerEvents={decorativePointerEvents.nativePointerEvents}
                                    style={[
                                        {
                                            position: 'absolute',
                                            left: VOICE_ORB_SIZE * 0.26,
                                            right: VOICE_ORB_SIZE * 0.26,
                                            top: VOICE_ORB_SIZE * 0.38,
                                            height: VOICE_ORB_SIZE * 0.24,
                                        },
                                        collapsedMeterStyle,
                                        decorativePointerEvents.webStyle,
                                    ]}
                                >
                                    <VoiceWaveform
                                        stop={stop}
                                        slots={7}
                                        height={VOICE_ORB_SIZE * 0.24}
                                        barWidth={2}
                                        color={onPlanetInk(tokens)}
                                    />
                                </Animated.View>
                            ) : null}
                            {/*
                              * The mute pip. Explicit user mute must remain legible on the collapsed
                              * object and must not depend on the body's colour; transient capture
                              * closure is named and drawn by the expanded transport.
                              */}
                            {control.muted ? (
                                <View
                                    testID="voice.orb.mutePip"
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
                    </Pressable>
                </Animated.View>
            </GestureDetector>

            {/*
              * A luminous floor rather than a scrim over the whole app. Voice often runs *while* the
              * user watches a build, so the content above must stay readable — the sheet lights its
              * own region instead of dimming the world.
              */}
            <VoiceOrbSheetBoundary
                testID="voice.orb.sheet"
                // Explicitly beneath the orb: the docked planet is drawn before the floor now, so
                // stacking order carries what document order used to.
                style={[
                    { position: 'absolute', inset: 0, zIndex: 0 },
                    sheetPointerEvents.webStyle,
                ]}
                pointerEvents={sheetPointerEvents.nativePointerEvents}
                {...(Platform.OS === 'web'
                    ? {
                        inert: !expanded,
                        'aria-hidden': !expanded,
                    }
                    : {
                        accessibilityElementsHidden: !expanded,
                        importantForAccessibility: expanded ? 'auto' : 'no-hide-descendants',
                    })}
            >
                <Animated.View
                    pointerEvents={decorativePointerEvents.nativePointerEvents}
                    style={[
                        {
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: 0,
                            height: sheetHeight,
                            overflow: 'hidden',
                        },
                        floorStyle,
                        decorativePointerEvents.webStyle,
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
                    stop={stop}
                    alpha={0.34}
                    polarity={1}
                    reactivity={1}
                    style={{ left: -bounds.w * 0.25, top: -bounds.w * 0.2 }}
                />
                <Grain />
                {/* The floor resolves into the content above it rather than slicing across a
                    session row with a hairline. */}
                <LinearGradient
                    colors={[tokens.hostSurfaceTransparent, tokens.hostSurface]}
                    locations={[0, 1]}
                    style={[
                        { position: 'absolute', left: 0, right: 0, top: 0, height: 26 },
                        decorativePointerEvents.webStyle,
                    ]}
                    pointerEvents={decorativePointerEvents.nativePointerEvents}
                />
                </Animated.View>

            {/* Caption + transport bar, anchored to the bottom and centred. */}
                <Animated.View
                    pointerEvents={sheetContentPointerEvents.nativePointerEvents}
                    style={[
                        {
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: 0,
                            paddingBottom: contentBottomPadding,
                        },
                        contentStyle,
                        sheetContentPointerEvents.webStyle,
                    ]}
                >
                {/*
                  * The sheet's one internal scroll owner (§2.7) — never nested, and never the bar.
                  *
                  * A long translation, 200% web text or a large Dynamic Type size makes the status
                  * and caption taller than the room the viewport and keyboard leave. Something has to
                  * give, and the rule is that it is never the way out: this region scrolls, the bar
                  * below it does not move.
                  */}
                <ScrollView
                    testID="voice.orb.captionScroll"
                    style={{ flexGrow: 0, maxHeight: sheet.captionMaxHeight }}
                    scrollEnabled={sheet.scrolls}
                    showsVerticalScrollIndicator={false}
                    // Reported without the ceiling applied, so growing the sheet and clamping it are
                    // decided from the text's natural height rather than from last frame's clamp.
                    onContentSizeChange={(_width, height) => {
                        setCaptionHeight((current) => (
                            Math.round(current) === Math.round(height) ? current : height
                        ));
                    }}
                >
                    <View style={{ alignItems: 'center', paddingHorizontal: 20, paddingBottom: 14, gap: 3 }}>
                        <Text
                            style={{
                                ...Typography.default('semiBold'),
                                fontSize: 17,
                                letterSpacing: -0.3,
                                color: tokens.ink,
                                textAlign: 'center',
                            }}
                        >
                            {labels.status}
                        </Text>
                        {labels.caption ? (
                            <Text
                                style={{
                                    ...Typography.default(),
                                    fontSize: 13,
                                    color: tokens.inkMuted,
                                    textAlign: 'center',
                                }}
                            >
                                {labels.caption}
                            </Text>
                        ) : null}
                    </View>
                </ScrollView>

                {/*
                  * One pill: transport · meter · contextual. This goes through `VoiceTransport` and
                  * `ControlRow` rather than hand-rolled buttons.
                  */}
                <View
                    testID="voice.orb.bar"
                    onLayout={(event) => {
                        const { height } = event.nativeEvent.layout;
                        setBarHeight((current) => (
                            Math.round(current) === Math.round(height) ? current : height
                        ));
                    }}
                    style={{
                        marginHorizontal: 12,
                        // Pinned: End Voice and every recovery action live in here, so the bar keeps
                        // its full height however little is left.
                        flexShrink: 0,
                        flexDirection: 'row',
                        // At 320px with 200% text or the longest localization the groups cannot
                        // share one line. They wrap onto a second line rather than pushing End
                        // Voice, Mute or a recovery action past the edge.
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        rowGap: 8,
                        columnGap: 12,
                        paddingHorizontal: 12,
                        paddingVertical: 12,
                        borderRadius: VOICE_ORB_BAR_RADIUS,
                        borderWidth: 1,
                        borderColor: tokens.rule,
                        backgroundColor: tokens.dark ? 'rgba(32,28,40,0.86)' : 'rgba(0,0,0,0.042)',
                    }}
                >
                    <View testID="voice.orb.bar.transport" style={{ flexShrink: 0 }}>
                        <VoiceTransport
                            labels={transportLabels}
                            live={live}
                            canStart={control.primaryAction === 'start' || control.primaryAction === 'recover'}
                            muted={control.muted}
                            capturing={control.capturing}
                            canMute={control.canMute}
                            onStart={control.onPrimaryAction}
                            onEnd={control.onPrimaryAction}
                            onToggleMute={control.onToggleMute}
                            onAction={props.onAction ?? (() => {})}
                        />
                    </View>

                    {/*
                      * The meter is the one child that gives way first: `flexBasis: 0` means it
                      * only ever takes what the controls left over, so it can never be the reason
                      * a control wraps, and it clips instead of overflowing when that is nothing.
                      * A meter with no audio behind it is decoration, so the slot stays empty then
                      * and simply holds the leftover space open.
                      */}
                    <View
                        testID="voice.orb.bar.meter"
                        style={{
                            flexGrow: 1,
                            flexBasis: 0,
                            minWidth: 0,
                            height: 24,
                            justifyContent: 'center',
                            overflow: 'hidden',
                        }}
                    >
                        {live ? <VoiceWaveform stop={stop} height={24} /> : null}
                    </View>

                    {extraControls.length > 0 ? (
                        <View style={{ flexShrink: 1, minWidth: 0 }}>
                            <ControlRow controls={extraControls} onAction={props.onAction ?? (() => {})} />
                        </View>
                    ) : null}
                </View>
                </Animated.View>
            </VoiceOrbSheetBoundary>
        </View>
    );
}
