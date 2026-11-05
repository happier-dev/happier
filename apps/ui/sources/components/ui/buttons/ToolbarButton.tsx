import * as React from 'react';
import { Platform, View } from 'react-native';
import type { GestureResponderEvent, StyleProp, ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { resolveThemeControlEdge, resolveThemeGloss, resolveThemeSurfaceFinish } from '@/components/ui/surfaces/themeRaisedEdge';
import { HappierPressable, type HappierSurfaceProps, HappierSurfaceGradientLayer, happierSurfaceGradientWebStyle } from '@happier-dev/plugin-ui/presentation';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { happierRaisedEdgeStyle } from '@happier-dev/plugin-ui/presentation';
import { readSurfaceStyleProperty } from '@/components/ui/surfaces/surfaceStyle';
import { FIELD_BOX_METRICS } from '@/components/ui/forms/fieldBox';

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
    /** Receives the press event; a folded menu row (a phone header's `⋯`) presses it without one. */
    onPress?: (event?: GestureResponderEvent) => void;
    disabled?: boolean;
    /**
     * The action this button issues is in flight and not yet settled. It is
     * announced as busy alongside `disabled`, so assistive technology hears
     * "waiting", not "unavailable".
     */
    busy?: boolean;
    /** Renders the resting fill as if hovered — for a control that is toggled on. */
    active?: boolean;
    tone?: ToolbarButtonTone;
    /**
     * The action ends or removes something. A neutral desktop button (a Run's Stop) keeps its quiet
     * chrome; folded into a phone header's `⋯`, it becomes a destructive row, last in the menu.
     */
    destructive?: boolean;
    /** Taller variant for form rows, where the button sits beside 34pt inputs. */
    size?: 'sm' | 'md';
    /** Overrides the label colour, for a destructive or accented action. */
    labelColor?: string;
    testID?: string;
    accessibilityLabel?: string;
    /**
     * The side this button shares with its sibling in a split button (Publish branch | ⌄), as
     * `RoundButton` names it: that side is drawn square and the two halves meet with no gap, so they read
     * as one control. The `start`-joined half (the menu chevron) draws the seam between them: the
     * neighbour's hairline on the quiet tone, a quiet line in the label's ink on a filled one.
     */
    joinedEdge?: 'start' | 'end';
    style?: StyleProp<ViewStyle>;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    base: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space.s6,
        // A toolbar's buttons and its fields (search, selects) stand at one height.
        minHeight: FIELD_BOX_METRICS.minHeightPx,
        paddingHorizontal: theme.space.s10,
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
    // A quiet button stands on its raised edge at rest and hover; pressed, active or disabled it sits flat.
    raised: {
        ...happierRaisedEdgeStyle(resolveThemeControlEdge(theme, 'subtle')),
    },
    primary: {
        borderColor: 'transparent',
        backgroundColor: theme.colors.button.primary.background,
    },
    primaryRaised: {
        ...happierRaisedEdgeStyle(resolveThemeGloss(theme)),
    },
    primaryPressed: {
        opacity: motionTokens.press.opacity,
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
    // A split button's halves: square where they meet. The menu half drops its own start hairline (the
    // primary half's end hairline is the seam) and keeps a narrower inset around its lone chevron.
    joinedEnd: {
        borderTopEndRadius: 0,
        borderBottomEndRadius: 0,
    },
    // A filled half has no hairline to share: its transparent end edge would read as a gap in the fill.
    joinedEndFilled: {
        borderEndWidth: 0,
    },
    joinedStart: {
        borderTopStartRadius: 0,
        borderBottomStartRadius: 0,
        borderStartWidth: 0,
        paddingHorizontal: theme.space.s6,
    },
    // On a filled half the seam is a short line in the label's ink, inset from the top and bottom edges.
    joinedSeam: {
        position: 'absolute',
        start: 0,
        top: theme.space.s6,
        bottom: theme.space.s6,
        width: StyleSheet.hairlineWidth,
        opacity: 0.35,
    },
    label: {
        minWidth: 0,
        flexShrink: 1,
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,

    },
}));

export const ToolbarButton = React.memo((props: ToolbarButtonProps) => {
    const styles = stylesheet;
    const tone = props.tone ?? 'default';
    const isPrimary = tone === 'primary';
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const callerBackground = readSurfaceStyleProperty(props.style, 'backgroundColor');
    return (
        <HappierPressable
            testID={props.testID}
            onPress={event => { props.onPress?.(event as GestureResponderEvent); }}
            disabled={props.disabled}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel ?? props.label}
            busy={props.busy}
            style={({ hovered, pressed, focused }) => [
                styles.base,
                props.size === 'md' ? styles.md : null,
                isPrimary ? styles.primary : null,
                props.active ? styles.active : null,
                // A primary keeps its fill under the pointer; the quiet fills are for the quiet tones.
                hovered && !props.disabled && !isPrimary ? styles.hovered : null,
                pressed && !props.disabled ? (isPrimary ? styles.primaryPressed : styles.pressed) : null,
                !pressed && !props.disabled && !props.active ? (isPrimary ? styles.primaryRaised : styles.raised) : null,
                props.disabled ? styles.disabled : null,
                props.joinedEdge === 'end' ? styles.joinedEnd : props.joinedEdge === 'start' ? styles.joinedStart : null,
                props.joinedEdge === 'end' && isPrimary ? styles.joinedEndFilled : null,
                // Native caller styles cross the portable adapter unchanged.
                props.style as HappierSurfaceProps['style'],
                callerBackground !== undefined && typeof callerBackground !== 'string' ? null : {
                    backgroundColor: paintColor(callerBackground ?? (isPrimary ? theme.colors.button.primary.background : pressed && !props.disabled ? theme.colors.surface.selected : props.active || hovered && !props.disabled ? theme.colors.surface.pressed : theme.colors.surface.base), undefined, isPrimary || callerBackground !== undefined ? 'solidControl' : 'surface'),
                },
                Platform.OS === 'web' ? happierSurfaceGradientWebStyle(resolveThemeSurfaceFinish(theme, isPrimary ? 'primaryButton' : 'secondaryButton', { pressed, focused, disabled: props.disabled || props.active }), !theme.dark) : null,
            ]}
        >
            {({ pressed, focused }) => <>
            <HappierSurfaceGradientLayer gradient={resolveThemeSurfaceFinish(theme, isPrimary ? 'primaryButton' : 'secondaryButton', { pressed, focused, disabled: props.disabled || props.active })} borderRadius={8} />
            {props.joinedEdge === 'start' && isPrimary ? (
                <View pointerEvents="none" style={[styles.joinedSeam, { backgroundColor: props.labelColor ?? paintColor(theme.colors.button.primary.tint, theme.colors.text.primary, 'solidControl') }]} />
            ) : null}
            {props.icon ? <View pointerEvents="none">{props.icon}</View> : null}
            <Text
                numberOfLines={1}
                style={[
                    styles.label,
                    isPrimary ? styles.primaryLabel : null,
                    tone === 'danger' ? styles.dangerLabel : null,
                    props.labelColor ? { color: props.labelColor } : null,
                    isPrimary && !props.labelColor ? { color: paintColor(theme.colors.button.primary.tint, theme.colors.text.primary, 'solidControl') } : null,
                ]}
            >
                {props.label}
            </Text>
            {props.trailing ? <View pointerEvents="none">{props.trailing}</View> : null}
            </>}
        </HappierPressable>
    );
});

ToolbarButton.displayName = 'ToolbarButton';
