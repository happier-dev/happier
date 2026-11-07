import * as React from 'react';
import type { ViewStyle } from 'react-native';
import { runOnJS, runOnUI, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/**
 * How far the composer card travels on entry.
 *
 * Durations and the curve come from `motionTokens.overlay.modal` — this is an ordinary overlay and
 * should settle like every other one. Only the distance is local, because distance is a property of
 * the surface rather than of the preset (the shared tokens range from 8 for a popover upward). A
 * bottom-anchored card wants enough travel to read as lifting into place and little enough that it
 * does not read as a sheet arriving: the preset's own 10 is invisible here, and anything past ~32
 * reads as the sheet this replaces. The tab bar the composer replaces occupies roughly this much of
 * the same space, so the card reads as rising into the layer the bar just vacated.
 */
const ENTER_TRAVEL_PX = 32;

/** Shared modal arrival scale; the card grows into place rather than only sliding. */
const ENTER_FROM_SCALE = motionTokens.overlay.modal.fromScale;

/** A shorter drop on the way out — exits are quieter than entrances. */
const EXIT_TRAVEL_PX = 12;

/**
 * The floating composer's arrival and exit, wherever it floats (the `/new` panel, the Docked host): the card
 * rises into place from its first layout and drops out on its way, and what is around it only fades.
 */
export function useFloatingComposerEntrance(enabled: boolean): Readonly<{
    enterProgress: SharedValue<number>;
    onComposerLayout: (() => void) | undefined;
    style: ReturnType<typeof useAnimatedStyle<ViewStyle>>;
    /** Animates the card out, then settles: `onLeft` also runs on interruption and at once with reduced motion. */
    leave: (onLeft: () => void) => void;
}> {
    const reducedMotion = useReducedMotionPreference();
    // Seeded settled for the non-floating case so the sheet path renders exactly as it did before.
    const enterProgress = useSharedValue(enabled ? 0 : 1);
    const hasStartedEntranceRef = React.useRef(false);
    const cardExitProgress = useSharedValue(1);

    // Started from the composer's FIRST LAYOUT, not from a mount effect. A mount effect fires while
    // this screen is still doing its (substantial) mount work and before the modal is presented, so
    // a fixed-duration animation was already finished by the time anything was on screen.
    const onLayout = React.useCallback(() => {
        if (!enabled || hasStartedEntranceRef.current) return;
        hasStartedEntranceRef.current = true;
        if (reducedMotion) {
            enterProgress.value = 1;
            return;
        }
        // One frame after layout, not on the layout callback itself. Layout runs BEFORE
        // react-native-screens presents the modal — it defers the present to the next main-queue
        // turn precisely so children are laid out first — so starting here spent the opening frames
        // off screen and only the tail of the curve was ever visible.
        // Schedule that frame on the UI runtime. A busy JS frame queue otherwise leaves both
        // the card's travel and the scrim at their initial values long after native presentation.
        runOnUI(() => {
            'worklet';
            requestAnimationFrame(() => {
                enterProgress.value = withTiming(1, {
                    duration: motionTokens.overlay.popover.enterMs,
                    easing: reanimatedMotionTokens.easing.standard,
                });
            });
        })();
    }, [enabled, enterProgress, reducedMotion]);

    const leave = React.useCallback((onLeft: () => void) => {
        if (reducedMotion) {
            onLeft();
            return;
        }
        // Only the CARD animates out; the frost is left where it is. Animating opacity on an
        // ancestor of the blur stack has the same offscreen-composite cost as moving it.
        cardExitProgress.value = withTiming(0, {
            duration: motionTokens.overlay.popover.exitMs,
            easing: reanimatedMotionTokens.easing.standard,
        }, () => {
            // Completion and interruption both settle the requested dismissal.
            runOnJS(onLeft)();
        });
    }, [cardExitProgress, reducedMotion]);

    // Travel only, never opacity: the scrim carries the fade, and a card that never faded in cannot
    // be left invisible if the entrance is somehow missed — the blank-composer hazard
    // `ComposerKeyboardScaffold` warns about.
    // Rise plus a touch of scale. Travel alone reads as a panel being repositioned; the small scale
    // is what makes it read as a surface arriving. `fromScale` is the shared modal token rather than
    // a number invented here.
    const style = useAnimatedStyle(() => {
        const settled = enterProgress.value;
        return {
            opacity: cardExitProgress.value,
            transform: [
                { translateY: (1 - settled) * ENTER_TRAVEL_PX + (1 - cardExitProgress.value) * EXIT_TRAVEL_PX },
                { scale: ENTER_FROM_SCALE + (1 - ENTER_FROM_SCALE) * settled },
            ],
        };
    }, [cardExitProgress, enterProgress]);

    return { enterProgress, onComposerLayout: enabled ? onLayout : undefined, style, leave };
}
