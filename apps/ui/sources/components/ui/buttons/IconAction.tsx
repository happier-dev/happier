import * as React from 'react';
import { Pressable, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

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
 */

export type IconActionSize = 'sm' | 'md';

export type IconActionProps = Readonly<{
    /** The glyph. Sized and tinted by the caller — this component owns the box, not the icon. */
    children: React.ReactNode;
    onPress?: () => void;
    /** Required: a glyph alone is not an accessible name, and it doubles as the web tooltip. */
    accessibilityLabel: string;
    size?: IconActionSize;
    disabled?: boolean;
    /** Renders the resting fill as if hovered — for a control that is toggled on. */
    active?: boolean;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    base: {
        alignItems: 'center',
        justifyContent: 'center',
        // 8px keeps the hover fill on the shared radius scale, so it nests correctly inside an
        // 8px-padded header without the corners disagreeing.
        borderRadius: 8,
    },
    sm: {
        width: 28,
        height: 28,
    },
    md: {
        width: 34,
        height: 34,
    },
    hovered: {
        backgroundColor: theme.colors.surface.pressed,
    },
    pressed: {
        backgroundColor: theme.colors.surface.selected,
    },
    active: {
        backgroundColor: theme.colors.surface.pressed,
    },
    disabled: {
        opacity: 0.4,
    },
}));

export const IconAction = React.memo((props: IconActionProps) => {
    const styles = stylesheet;
    const size = props.size ?? 'md';

    return (
        <Pressable
            testID={props.testID}
            onPress={props.disabled ? undefined : props.onPress}
            disabled={props.disabled}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            accessibilityState={{ disabled: Boolean(props.disabled) }}
            // Native tooltip on web; a no-op elsewhere.
            {...({ title: props.accessibilityLabel } as object)}
            style={({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) => [
                styles.base,
                size === 'sm' ? styles.sm : styles.md,
                props.active ? styles.active : null,
                hovered && !props.disabled ? styles.hovered : null,
                pressed && !props.disabled ? styles.pressed : null,
                props.disabled ? styles.disabled : null,
                props.style,
            ]}
        >
            <View pointerEvents="none">{props.children}</View>
        </Pressable>
    );
});

IconAction.displayName = 'IconAction';
