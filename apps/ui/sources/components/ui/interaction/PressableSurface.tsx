import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import type {
    AccessibilityRole,
    AccessibilityState,
    GestureResponderEvent,
    PressableProps,
    StyleProp,
    ViewStyle,
} from 'react-native';

import { FocusRing, WEB_FOCUS_OUTLINE_RESET, type FocusRingPlacement } from '@/components/ui/interaction/FocusRing';
import { useIsKeyboardModality } from '@/components/ui/interaction/inputModalityStore';
import { usePressFeedback, type PressFeedbackTone } from '@/components/ui/interaction/usePressFeedback';

/**
 * A `Pressable` that already knows the two things every pressable in this app kept getting wrong:
 * press feedback tints the surface instead of dimming the content, and keyboard focus is visible
 * while touch focus is not.
 *
 * It owns no box of its own — no size, no radius, no chrome. `IconAction` and `ToolbarButton` keep
 * their own geometry and hand it in, which is why adopting this changed neither of them visually.
 */

export type PressableSurfaceProps = Readonly<{
    children?: React.ReactNode;
    onPress?: (event: GestureResponderEvent) => void;
    onLongPress?: (event: GestureResponderEvent) => void;
    disabled?: boolean;
    /** Renders the resting fill as if hovered — a control that is toggled on. */
    active?: boolean;
    tone?: PressFeedbackTone;
    hitSlop?: PressableProps['hitSlop'];
    accessibilityRole?: AccessibilityRole;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    accessibilityState?: AccessibilityState;
    /** Corner radius the focus ring traces. Keep it equal to the box's own radius. */
    focusRingRadius?: number;
    focusRingPlacement?: FocusRingPlacement;
    /** The control's own box styling. The feedback fill is applied ON TOP of it. */
    style?: StyleProp<ViewStyle>;
    /**
     * Applied LAST, after the feedback fill, so a consumer's `style` prop still has the final word
     * — which is the ordering the adopting controls already had.
     */
    styleOverride?: StyleProp<ViewStyle>;
    /** Native tooltip on web; a no-op elsewhere. */
    webTooltip?: string;
    testID?: string;
}>;

export const PressableSurface = React.memo((props: PressableSurfaceProps) => {
    const disabled = props.disabled ?? false;
    const feedback = usePressFeedback({
        tone: props.tone ?? 'control',
        disabled,
        selected: props.active,
    });

    const keyboardModality = useIsKeyboardModality();
    const [focused, setFocused] = React.useState(false);
    const ringVisible = focused && keyboardModality && !disabled;
    // `FocusRing` runs a Reanimated animated style, so an always-mounted one would cost a shared
    // value per control on every surface in the app for a ring that native can never show (RN
    // reports no keypress, so the modality never leaves `pointer` there). `focused` keeps it
    // mounted while it fades out after the user drops back to the pointer.
    const ringMounted = keyboardModality || focused;

    const handleFocus = React.useCallback(() => setFocused(true), []);
    const handleBlur = React.useCallback(() => setFocused(false), []);

    const resolveStyle = React.useCallback(({ pressed, hovered }: { pressed?: boolean; hovered?: boolean }) => {
        const backgroundColor = feedback.resolveBackgroundColor({ pressed, hovered });
        return [
            props.style,
            Platform.OS === 'web' ? WEB_FOCUS_OUTLINE_RESET : null,
            backgroundColor === undefined ? null : { backgroundColor },
            props.styleOverride,
        ];
    }, [feedback, props.style, props.styleOverride]);

    return (
        <Pressable
            testID={props.testID}
            onPress={disabled ? undefined : props.onPress}
            onLongPress={disabled ? undefined : props.onLongPress}
            onFocus={handleFocus}
            onBlur={handleBlur}
            hitSlop={props.hitSlop}
            disabled={disabled}
            accessibilityRole={props.accessibilityRole ?? 'button'}
            accessibilityLabel={props.accessibilityLabel}
            accessibilityHint={props.accessibilityHint}
            accessibilityState={{ ...props.accessibilityState, disabled }}
            {...(props.webTooltip === undefined ? undefined : ({ title: props.webTooltip } as object))}
            style={resolveStyle}
        >
            {props.children}
            {ringMounted ? (
                <FocusRing
                    testID={props.testID === undefined ? undefined : `${props.testID}-focus-ring`}
                    visible={ringVisible}
                    radius={props.focusRingRadius}
                    placement={props.focusRingPlacement}
                />
            ) : null}
        </Pressable>
    );
});

PressableSurface.displayName = 'PressableSurface';
