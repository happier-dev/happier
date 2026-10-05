import { HappierPressable, type HappierPressableProps } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, StyleProp, TextStyle, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { iOSUIKit } from 'react-native-typography';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { GradientSurface, type SurfaceGradient } from '@/components/ui/surfaces/GradientSurface';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { usePressFeedback } from '@/components/ui/interactions/usePressFeedback';


/** `mini` is the inline action inside a compact capsule (a live call's Retry), not a call to action. */
export type RoundButtonSize = 'large' | 'normal' | 'small' | 'mini';
const RoundButtonDefaultSizeContext = React.createContext<RoundButtonSize>('large');

export function RoundButtonSizeScope(props: Readonly<{ size: RoundButtonSize; children: React.ReactNode }>) {
    return <RoundButtonDefaultSizeContext.Provider value={props.size}>{props.children}</RoundButtonDefaultSizeContext.Provider>;
}
const sizes: { [key in RoundButtonSize]: { fontSize: number, hitSlop: number, pad: number } } = {
    large: { fontSize: 21, hitSlop: 0, pad: Platform.OS == 'ios' ? 0 : -1 },
    normal: { fontSize: 16, hitSlop: 8, pad: Platform.OS == 'ios' ? 1 : -2 },
    small: { fontSize: 13, hitSlop: 12, pad: Platform.OS == 'ios' ? -1 : -1 },
    mini: { fontSize: 12, hitSlop: 8, pad: 0 },
}

/**
 * `default` is the filled primary action. `secondary` is the bordered inline action a configuration
 * row or page header carries (it matches the page field trigger). `destructive` is the same inline
 * action for an irreversible operation. `inverted` is a bare text button.
 */
export type RoundButtonDisplay = 'default' | 'secondary' | 'destructive' | 'inverted';

const stylesheet = StyleSheet.create((theme) => ({
    pill: {
        flexGrow: 1,
        justifyContent: 'center',
        borderWidth: 1,
        borderRadius: 10,
        overflow: 'hidden',
    },
    loadingContainer: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
    contentContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 9999,
    },
    // An inline row or header action: it sits beside a label, so it is shorter than a call to action.
    contentContainerSecondary: {
        paddingHorizontal: 12,
        paddingVertical: 5,
    },
    contentContainerSmall: {
        paddingHorizontal: 10,
        paddingVertical: 3,
    },
    textSmall: {
        lineHeight: 18,
    },
    // A capsule's inline action: it shares the capsule's height band instead of setting its own.
    contentContainerMini: {
        paddingHorizontal: 12,
        paddingVertical: 0,
    },
    // Applied only when a mark is present, so a title-only button keeps the exact
    // single-child layout it has always had.
    contentContainerWithMark: {
        flexDirection: 'row',
        // The seam between the words and the mark. The mark stands in for a word,
        // so this reads as the space between two words rather than as the wider
        // icon-to-label gutter a toolbar button would use.
        gap: 5,
    },
    // The row already centres this slot on the label's own band, so the mark
    // needs no nudge of its own. Measured on an iPhone 17 Pro (iOS 26.3) against
    // the cap midline of the words beside it: 0.03pt with the slot centred as-is,
    // against 0.31pt once the label's legacy `size.pad` lift is mirrored onto the
    // mark — mirroring it double-counts a nudge the text has already spent.
    markSlot: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    // Centres a fixed-height capsule inside whatever touch floor the pressable imposes.
    capsuleBox: {
        justifyContent: 'center',
    },
    text: {
        ...Typography.default('semiBold'),
        fontWeight: '600',
        includeFontPadding: false,
    },
}));

type RoundButtonStyle = Exclude<HappierPressableProps['style'], (state: never) => unknown>;

const TRANSPARENT_LAYOUT_BOX = { backgroundColor: 'transparent' } as const;

function readBackgroundColor(style: RoundButtonStyle): string | undefined {
    if (!style) return undefined;
    if (Array.isArray(style)) {
        return style.reduce<string | undefined>((current, entry) => readBackgroundColor(entry) ?? current, undefined);
    }
    return style.backgroundColor;
}

export const RoundButton = React.memo((props: {
    size?: RoundButtonSize,
    display?: RoundButtonDisplay,
    title?: any,
    /**
     * How much of the title the pill may show.
     *
     * Ordinary buttons stay on their single line. `2` is the bounded opt-in for a
     * label that occasionally runs long, and `'complete'` is the mode a
     * consequence-bearing label uses: it wraps to as many lines as its words need,
     * because a destructive action truncated to "Mirror workspace and allow
     * destination-only files to be…" asks for consent to a sentence the reader
     * cannot finish — and translations and large text sizes are exactly where that
     * happens.
     */
    titleNumberOfLines?: 1 | 2 | 'complete',
    /**
     * A mark drawn before the title, inside the same fill.
     *
     * The button still hugs its content — the mark widens it rather than sitting in
     * a fixed box — so a logo-and-label button is this primitive with one more
     * child, not a second pill implementation beside it.
     */
    leading?: React.ReactNode,
    /**
     * The same mark, drawn after the title instead.
     *
     * Which side a mark belongs on is a property of the sentence, not of the
     * button: "Continue with {Agent}" closes with the Agent while "{Agent} で続ける"
     * opens with it. Both slots exist so the caller can put the mark where its
     * words put it, rather than the button imposing an order on every language.
     */
    trailing?: React.ReactNode,
    /**
     * Draws the visible pill at exactly this height with fully round ends — a capsule's inline
     * action standing level with the round wells beside it. The touch floor around it stays the
     * pressable's, so a 34pt pill keeps its 44pt target without growing to fill it.
     */
    capsuleHeight?: number,
    style?: RoundButtonStyle,
    textStyle?: StyleProp<TextStyle>,
    disabled?: boolean,
    loading?: boolean,
    testID?: string,
    accessibilityLabel?: string,
    /**
     * Why the button is in the state it is in — most usefully, why a disabled one
     * cannot be pressed. The name says what the press does; the hint says what is
     * missing, and without it a disabled pill reads to a screen reader as an
     * action with no explanation.
     */
    accessibilityHint?: string,
    /** Exposes the canonical focus handle to recovery surfaces without a raw Pressable ref. */
    controlRef?: HappierPressableProps['controlRef'],
    /** Disclosure state for buttons that reveal inline detail. */
    expanded?: boolean,
    onPress?: HappierPressableProps['onPress'],
    action?: () => Promise<any>
}) => {
    const { theme } = useUnistyles();
    const scopedDefaultSize = React.useContext(RoundButtonDefaultSizeContext);
    const styles = stylesheet;
    /**
     * `onPress` wins and stays synchronous, exactly as before: only the `action`
     * prop opts into the pending lifecycle. Returning the action's promise is
     * what hands that lifecycle to the shared owner — this component used to run
     * its own `setLoading` around the same await, with no guard against a second
     * press landing in the same tick.
     */
    const doAction = React.useCallback((event?: Parameters<HappierPressableProps['onPress']>[0]) => {
        if (props.onPress) {
            props.onPress(event);
            return undefined;
        }
        return props.action?.();
    }, [props.onPress, props.action]);
    const displays: { [key in RoundButtonDisplay]: {
        textColor: string,
        backgroundColor: string,
        borderColor: string,
        gradient?: SurfaceGradient,
    } } = {
        default: {
            backgroundColor: theme.colors.button.primary.background,
            gradient: theme.colors.button.primary.gradient,
            borderColor: 'transparent',
            textColor: theme.colors.button.primary.tint
        },
        secondary: {
            backgroundColor: theme.colors.surface.base,
            borderColor: theme.colors.border.strong,
            textColor: theme.colors.text.primary,
        },
        destructive: {
            backgroundColor: theme.colors.surface.base,
            borderColor: theme.colors.state.danger.border,
            textColor: theme.colors.state.danger.foreground,
        },
        inverted: {
            backgroundColor: 'transparent',
            borderColor: 'transparent',
            textColor: theme.colors.text.primary,
        }
    }

    const pressFeedback = usePressFeedback();
    // A caller fill (for example a destructive tone) belongs to the pill that moves,
    // not to the static layout box behind it.
    const callerBackgroundColor = readBackgroundColor(props.style);
    const resolvedSize = props.size ?? scopedDefaultSize;
    const size = sizes[resolvedSize];
    const display = displays[props.display || 'default'];
    const titleLines = props.titleNumberOfLines ?? 1;
    // `undefined` is React Native's "as many lines as it takes"; `0` is not portable
    // across the platforms this primitive renders on.
    const titleNumberOfLines = titleLines === 'complete' ? undefined : titleLines;
    return (
        <HappierPressable
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel}
            accessibilityHint={props.accessibilityHint}
            controlRef={props.controlRef}
            expanded={props.expanded}
            disabled={props.disabled}
            busy={props.loading}
            hitSlop={size.hitSlop}
            // The pressable keeps the caller's layout and the hit area; the visible
            // pill is the animated frame inside it, so the tactile press moves the
            // whole fill rather than only its label.
            // Declared-disabled dims; merely pending does not. A button that fades
            // the moment it is pressed reads as unavailable rather than working.
            // The touch-target floor is `HappierPressable`'s (native only); web and
            // desktop keep their pointer density, so the button adds none of its own.
            style={[
                { opacity: props.disabled ? 0.35 : 1 },
                props.capsuleHeight !== undefined ? styles.capsuleBox : null,
                props.style,
                TRANSPARENT_LAYOUT_BOX,
            ]}
            onPressIn={pressFeedback.onPressIn}
            onPressOut={pressFeedback.onPressOut}
            onPress={doAction}
        >
            {(state) => (
                <Animated.View
                    style={[
                        styles.pill,
                        {
                            backgroundColor: callerBackgroundColor ?? display.backgroundColor,
                            borderColor: display.borderColor,
                        },
                        props.capsuleHeight !== undefined
                            ? { flexGrow: 0, height: props.capsuleHeight, borderRadius: props.capsuleHeight / 2 }
                            : null,
                        focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                        pressFeedback.animatedStyle,
                    ]}
                >
                    <View
                        style={[
                            styles.contentContainer,
                            props.leading || props.trailing ? styles.contentContainerWithMark : null,
                            props.display === 'secondary' || props.display === 'destructive' ? styles.contentContainerSecondary : null,
                            resolvedSize === 'small' ? styles.contentContainerSmall : null,
                            props.size === 'mini' ? styles.contentContainerMini : null,
                        ]}
                    >
                        {display.gradient ? (
                            <GradientSurface
                                fallbackColor={display.backgroundColor}
                                gradient={display.gradient}
                                borderRadius={10}
                                style={StyleSheet.absoluteFillObject}
                            />
                        ) : null}
                        {state.busy && (
                            <View style={styles.loadingContainer}>
                                <ActivitySpinner color={display.textColor} size='small' />
                            </View>
                        )}
                        {props.leading ? (
                            <View style={[styles.markSlot, { opacity: state.busy ? 0 : 1 }]}>
                                {props.leading}
                            </View>
                        ) : null}
                        <Text
                            style={[
                                iOSUIKit.title3,
                                styles.text,
                                {
                                    marginTop: size.pad,
                                    opacity: state.busy ? 0 : 1,
                                    color: display.textColor,
                                    fontSize: props.display === 'secondary' || props.display === 'destructive' ? Math.min(size.fontSize, 13) : size.fontSize,
                                },
                                resolvedSize === 'small' ? styles.textSmall : null,
                                // A wrapped label is a paragraph inside a centred pill, so
                                // its second line centres under the first rather than
                                // hanging off the leading edge. Single-line buttons are
                                // already centred by the container and are unaffected.
                                titleLines === 1 ? null : { textAlign: 'center' as const, maxWidth: '100%' as const },
                                props.textStyle
                            ]}
                            numberOfLines={titleNumberOfLines}
                        >
                            {props.title}
                        </Text>
                        {props.trailing ? (
                            <View style={[styles.markSlot, { opacity: state.busy ? 0 : 1 }]}>
                                {props.trailing}
                            </View>
                        ) : null}
                    </View>
                </Animated.View>
            )}
        </HappierPressable>
    )
});
