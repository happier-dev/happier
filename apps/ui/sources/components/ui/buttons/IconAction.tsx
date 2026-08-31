import * as React from 'react';
import { View } from 'react-native';
import type {
    AccessibilityRole,
    AccessibilityState,
    GestureResponderEvent,
    PressableProps,
    StyleProp,
    ViewStyle,
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { PressableSurface } from '@/components/ui/interaction/PressableSurface';

/**
 * The canonical icon-only action.
 *
 * Glyph-only controls carry NO chrome at rest — no border, no fill. A bordered box around a single
 * icon is a visual element competing for attention with the content beside it, and once a header has
 * four of them the chrome outweighs the content. The affordance moves to hover, where it is wanted,
 * and to the focus ring for keyboard users.
 *
 * This is deliberately NOT a variant of `RoundButton`: a button with a text label *should* look like
 * a button, and `RoundButton` owns that. The rule this component encodes is the boundary between the
 * two — label present, chrome present; glyph alone, chrome absent.
 *
 * Before this existed every header re-implemented the same 34x34 bordered square locally, which is
 * why the pattern spread. New icon-only actions belong here, not in a local stylesheet.
 *
 * The press/hover fills and the focus ring live in {@link PressableSurface}; this component keeps
 * only its box. The fills are unchanged by that move — it exists so the "tint the surface, never
 * dim the content" rule has one owner instead of one copy per control.
 */

export type IconActionSize = 'sm' | 'md' | 'lg';

export type IconActionProps = Readonly<{
    /** The glyph. Sized and tinted by the caller — this component owns the box, not the icon. */
    children: React.ReactNode;
    /** Receives the gesture event so a row-nested action can stop propagation to its row. */
    onPress?: (event: GestureResponderEvent) => void;
    /** Required: a glyph alone is not an accessible name, and it doubles as the web tooltip. */
    accessibilityLabel: string;
    accessibilityRole?: AccessibilityRole;
    accessibilityState?: AccessibilityState;
    size?: IconActionSize;
    /**
     * Extends the touch target beyond the painted box.
     *
     * The `sm` box is 28pt, below the 44pt floor, which is fine in a desktop header and not fine on
     * a phone row. A caller that needs the floor asks for it here — `hitSlop={8}` takes 28 to 44 —
     * instead of growing the visible chrome or re-implementing the control locally, which is how a
     * corridor ends up with four hand-rolled 30x30 icon buttons.
     */
    hitSlop?: PressableProps['hitSlop'];
    disabled?: boolean;
    /** Renders the resting fill as if hovered — for a control that is toggled on. */
    active?: boolean;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>;

// 8px keeps the hover fill on the shared radius scale, so it nests correctly inside an
// 8px-padded header without the corners disagreeing. `lg` grows the corner with the box so the
// curvature stays proportional instead of looking tighter than its neighbours'.
const ICON_ACTION_RADIUS_PX = { sm: 8, md: 8, lg: 12 } as const;

/**
 * The painted box per size.
 *
 * Exported because a caller that places two of these side by side has to reason about the touch
 * geometry they compose — where each one's `hitSlop` reaches, and whether the two overlap. A caller
 * that re-typed `28` to do that arithmetic would be holding a private copy of this table, and the
 * copy is what silently stops matching when a size changes here.
 */
export const ICON_ACTION_BOX_PX = { sm: 28, md: 34, lg: 38 } as const;

const stylesheet = StyleSheet.create(() => ({
    base: {
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: ICON_ACTION_RADIUS_PX.md,
    },
    sm: {
        width: ICON_ACTION_BOX_PX.sm,
        height: ICON_ACTION_BOX_PX.sm,
    },
    md: {
        width: ICON_ACTION_BOX_PX.md,
        height: ICON_ACTION_BOX_PX.md,
    },
    // Sized to sit in a row with a 38pt primary action.
    lg: {
        width: ICON_ACTION_BOX_PX.lg,
        height: ICON_ACTION_BOX_PX.lg,
        borderRadius: ICON_ACTION_RADIUS_PX.lg,
    },
    disabled: {
        // Not the press idiom: WCAG exempts an inactive control from contrast minimums, and a
        // disabled affordance is supposed to recede. Press feedback never touches opacity.
        opacity: 0.4,
    },
}));

export const IconAction = React.memo((props: IconActionProps) => {
    const styles = stylesheet;
    const size = props.size ?? 'md';

    return (
        <PressableSurface
            testID={props.testID}
            onPress={props.onPress}
            hitSlop={props.hitSlop}
            disabled={props.disabled}
            active={props.active}
            accessibilityLabel={props.accessibilityLabel}
            accessibilityRole={props.accessibilityRole}
            accessibilityState={props.accessibilityState}
            webTooltip={props.accessibilityLabel}
            focusRingRadius={ICON_ACTION_RADIUS_PX[size]}
            style={[
                styles.base,
                size === 'sm' ? styles.sm : size === 'lg' ? styles.lg : styles.md,
                props.disabled ? styles.disabled : null,
            ]}
            styleOverride={props.style}
        >
            <View pointerEvents="none">{props.children}</View>
        </PressableSurface>
    );
});

IconAction.displayName = 'IconAction';
