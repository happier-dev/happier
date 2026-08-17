import * as React from 'react';
import { Pressable, View } from 'react-native';
import type { GestureResponderEvent, StyleProp, ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * The canonical small labelled action for pane toolbars and surface headers.
 *
 * A labelled button should still look like a button — that is the line between this and
 * {@link IconButton}, whose `plain` variant drops all chrome because a lone glyph has nothing to sit in. What this
 * changes is the *weight* of that chrome. These controls appeared three and four at a time above
 * a file list, each drawn at `borderWidth: 1` on `border.default`, and the row of outlines read
 * heavier than the content underneath. The border here is a hairline on `border.subtle` — the same
 * token as the sidebar/content seam — so the affordance survives at roughly half the visual weight.
 *
 * Before this existed, every toolbar re-declared the same control inline. Three of them had settled
 * on the identical numbers (h30 / r10 / bw1 / px10 / gap6 / 14px glyph / 12px semiBold label) by
 * copy, and a fourth had drifted to a full capsule, so the same action read as a different species
 * depending on which surface you were looking at.
 */

/**
 * `default` is the quiet toolbar button. `primary` is a filled call-to-action and carries no border
 * — a fill and an outline are two ways of saying the same thing. `danger` keeps the quiet chrome and
 * only tints the label, so a destructive action reads as destructive without shouting.
 */
export type ToolbarButtonTone = 'default' | 'primary' | 'danger';

export type ToolbarButtonProps = Readonly<{
    label: string;
    /** Optional leading glyph. Sized and tinted by the caller — this component owns the box. */
    icon?: React.ReactNode;
    /** Optional trailing glyph, for a control that opens a menu. */
    trailing?: React.ReactNode;
    onPress?: (event: GestureResponderEvent) => void;
    disabled?: boolean;
    /** Renders the resting fill as if hovered — for a control that is toggled on. */
    active?: boolean;
    tone?: ToolbarButtonTone;
    /** Taller variant for form rows, where the button sits beside 34pt inputs. */
    size?: 'sm' | 'md';
    /** Overrides the label colour, for a destructive or accented action. */
    labelColor?: string;
    testID?: string;
    accessibilityLabel?: string;
    style?: StyleProp<ViewStyle>;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    base: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: 30,
        paddingHorizontal: 10,
        // 8, not 10 and not a capsule: on the shared radius scale, and a small rounded rect among
        // the rectangular surfaces it sits on rather than a pill of its own kind.
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.subtle,
        backgroundColor: theme.colors.surface.base,
    },
    md: {
        minHeight: 34,
    },
    primary: {
        borderWidth: 0,
        backgroundColor: theme.colors.button.primary.background,
    },
    primaryLabel: {
        color: theme.colors.button.primary.tint,
    },
    dangerLabel: {
        color: theme.colors.state.danger.foreground,
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
        opacity: 0.45,
    },
    label: {
        minWidth: 0,
        flexShrink: 1,
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
}));

export const ToolbarButton = React.memo((props: ToolbarButtonProps) => {
    const styles = stylesheet;
    const tone = props.tone ?? 'default';
    const isPrimary = tone === 'primary';

    return (
        <Pressable
            testID={props.testID}
            onPress={props.disabled ? undefined : props.onPress}
            disabled={props.disabled}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel ?? props.label}
            accessibilityState={{ disabled: Boolean(props.disabled) }}
            style={({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) => [
                styles.base,
                props.size === 'md' ? styles.md : null,
                isPrimary ? styles.primary : null,
                props.active ? styles.active : null,
                hovered && !props.disabled ? styles.hovered : null,
                pressed && !props.disabled ? styles.pressed : null,
                props.disabled ? styles.disabled : null,
                props.style,
            ]}
        >
            {props.icon ? <View pointerEvents="none">{props.icon}</View> : null}
            <Text
                numberOfLines={1}
                style={[
                    styles.label,
                    isPrimary ? styles.primaryLabel : null,
                    tone === 'danger' ? styles.dangerLabel : null,
                    props.labelColor ? { color: props.labelColor } : null,
                ]}
            >
                {props.label}
            </Text>
            {props.trailing ? <View pointerEvents="none">{props.trailing}</View> : null}
        </Pressable>
    );
});

ToolbarButton.displayName = 'ToolbarButton';
