import * as React from 'react';
import { Animated, View, type LayoutChangeEvent } from 'react-native';

import { ComposerKeyboardFloatingInset } from '@/components/sessions/keyboardAvoidance';
import { resolveOverlayMotionPreset, useOverlayMotionAnimation, useOverlayPresence } from '@/components/ui/overlays/motion/overlayMotion';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useFloatingChromeClearance } from '@/components/ui/layout/useFloatingChromeClearance';
import { useDeviceType } from '@/utils/platform/responsive';
import { useFindComposerSlotSeat } from './FindComposerSlot';

export function useFindBarPresentation(): 'inline' | 'keyboardSeated' {
    return useDeviceType() === 'phone' ? 'keyboardSeated' : 'inline';
}

/**
 * The Find bar arrives and leaves like the app's other floating capsules (the overlay motion owner's
 * popover preset): from above at the top of a surface, from below where it is seated on a phone.
 */
const FIND_BAR_MOTION = {
    inline: resolveOverlayMotionPreset({ kind: 'popover', direction: 'bottom' }),
    seated: resolveOverlayMotionPreset({ kind: 'popover', direction: 'top' }),
} as const;

/** True while the bar is leaving: it renders its last frame inert (no focus, no ids, not announced). */
export const FindBarExitingContext = React.createContext(false);

/**
 * The band an inline Find bar covers at the top of its surface, in px from the surface's top (0 when no
 * bar floats there, or on a phone where the bar is seated below). Content under the bar keeps its first
 * lines clear of this band, so a match on line 1 is never hidden by the bar that counts it.
 */
export const FindBarBandContext = React.createContext(0);

/** The room between the capsule's bottom edge and the first content it keeps clear. */
const FIND_BAR_BAND_GAP_PX = 8;

/** The band of an inline capsule from its placement frame: its bottom edge plus the gap below it. */
export function findBarBandFromLayout(layout: Readonly<{ y: number; height: number }>, gapPx = FIND_BAR_BAND_GAP_PX): number {
    return Math.ceil(layout.y + layout.height + gapPx);
}

/**
 * The band a surface publishes through `FindBarBandContext` while its inline bar is open: measured from
 * `FindBarPlacement`'s `onLayout`, and 0 once the bar closes or is seated.
 */
export function useFindBarBand(open: boolean): Readonly<{ bandPx: number; onLayout: (event: LayoutChangeEvent) => void }> {
    const seated = useFindBarPresentation() === 'keyboardSeated';
    const [measured, setMeasured] = React.useState(0);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const band = findBarBandFromLayout(event.nativeEvent.layout);
        setMeasured((previous) => previous === band ? previous : band);
    }, []);
    return { bandPx: open && !seated ? measured : 0, onLayout };
}

/**
 * Whether a surface keeps its Find bar mounted: while open, and through the bar's exit after it closes.
 * The surface closes its Find model and returns focus at once; only the bar's last frame lingers.
 */
export function useFindBarPresence(open: boolean): Readonly<{ present: boolean; exiting: boolean }> {
    const reducedMotion = useReducedMotionPreference();
    const preset = FIND_BAR_MOTION.inline;
    return useOverlayPresence(open, reducedMotion ? preset.reducedMotionFadeMs : preset.exitMs);
}

/** One host placement for every Find bar; the terminal footer already follows the keyboard. */
export function FindBarPlacement(props: Readonly<{
    children(presentation: 'inline' | 'keyboardSeated'): React.ReactNode;
    /** False while the bar leaves (`useFindBarPresence`): the last open frame stays, inert, as it exits. */
    visible?: boolean;
    seatedInFlow?: boolean;
    testID?: string;
    /** The inline capsule's frame (bar plus its note), so its surface can keep content clear of it. */
    onLayout?: (event: LayoutChangeEvent) => void;
}>) {
    const visible = props.visible ?? true;
    const presentation = useFindBarPresentation();
    const seated = presentation === 'keyboardSeated';
    // A seated bar floating over a page clears the phone's floating tab bar, the same reservation pinned bars make.
    const chromeClearance = useFloatingChromeClearance();
    // While open the bar renders live; while leaving it keeps its last open frame.
    const lastFrame = React.useRef<React.ReactNode>(null);
    if (visible) lastFrame.current = props.children(presentation);
    const motionRef = React.useRef<React.ComponentRef<typeof View>>(null);
    const motion = useOverlayMotionAnimation({
        visible, preset: seated ? FIND_BAR_MOTION.seated : FIND_BAR_MOTION.inline, elementRef: motionRef,
    });
    const bar = <Animated.View ref={motionRef} pointerEvents={visible ? undefined : 'none'}
        aria-hidden={visible ? undefined : true} accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? undefined : 'no-hide-descendants'}
        style={[seated ? undefined : { maxWidth: 560, width: '100%' }, motion.style]}>
        <FindBarExitingContext.Provider value={!visible}>{lastFrame.current}</FindBarExitingContext.Provider>
    </Animated.View>;
    // On a phone screen with a composer slot, the seated bar takes the composer's place (F1p); while it
    // leaves, the composer is already back beneath it. The terminal footer seats it in its own flow.
    const inComposerSlot = useFindComposerSlotSeat(
        <View testID={visible ? props.testID : undefined}>{bar}</View>,
        seated && !props.seatedInFlow,
        !visible,
    );
    if (inComposerSlot) return null;
    if (seated && props.seatedInFlow) {
        return <View testID={visible ? props.testID : undefined} pointerEvents="box-none">{bar}</View>;
    }
    return seated
        ? <ComposerKeyboardFloatingInset testID={visible ? props.testID : undefined} baseBottom={chromeClearance}
            style={{ position: 'absolute', left: 0, right: 0, zIndex: 20 }}>{bar}</ComposerKeyboardFloatingInset>
        : <View testID={visible ? props.testID : undefined} pointerEvents="box-none" onLayout={visible ? props.onLayout : undefined}
            style={{ position: 'absolute', top: 10, left: 14, right: 14, alignItems: 'flex-end', zIndex: 20 }}>{bar}</View>;
}
