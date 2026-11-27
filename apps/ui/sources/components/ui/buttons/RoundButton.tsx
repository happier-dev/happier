import * as React from 'react';
import { Platform, Pressable, StyleProp, TextStyle, View, ViewStyle, type GestureResponderEvent } from 'react-native';
import { iOSUIKit } from 'react-native-typography';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { GradientSurface, type SurfaceGradient } from '@/components/ui/surfaces/GradientSurface';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { FocusRing, WEB_FOCUS_OUTLINE_RESET } from '@/components/ui/interaction/FocusRing';
import { useIsKeyboardModality } from '@/components/ui/interaction/inputModalityStore';


export type RoundButtonSize = 'large' | 'normal' | 'small';
const RoundButtonSizeContext = React.createContext<RoundButtonSize | undefined>(undefined);

export function RoundButtonSizeScope(props: Readonly<{
    size: RoundButtonSize;
    children: React.ReactNode;
}>) {
    return (
        <RoundButtonSizeContext.Provider value={props.size}>
            {props.children}
        </RoundButtonSizeContext.Provider>
    );
}
const sizes: { [key in RoundButtonSize]: { fontSize: number, hitSlop: number, pad: number } } = {
    large: { fontSize: 21, hitSlop: 0, pad: Platform.OS == 'ios' ? 0 : -1 },
    normal: { fontSize: 16, hitSlop: 8, pad: Platform.OS == 'ios' ? 1 : -2 },
    small: { fontSize: 14, hitSlop: 12, pad: Platform.OS == 'ios' ? -1 : -1 }
}

/**
 * `outline` is the secondary action beside a primary one: transparent with the strong border.
 * `contrast` is the one decisive action on a surface whose primary fill would sink into it (the
 * dark theme's primary is a near-surface grey): the text colour as fill, the surface as ink, so it
 * reads as the strongest control in both themes.
 */
export type RoundButtonDisplay = 'default' | 'inverted' | 'outline' | 'contrast';

const stylesheet = StyleSheet.create((theme) => ({
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
    text: {
        ...Typography.default('semiBold'),
        fontWeight: '600',
        includeFontPadding: false,
    },
    completeTitle: {
        maxWidth: '100%',
        textAlign: 'center',
    },
}));

export type RoundButtonProps = {
    size?: RoundButtonSize,
    display?: RoundButtonDisplay,
    title?: any,
    /** Preserve the full action wording when a constrained surface needs wrapping. */
    titleNumberOfLines?: 1 | 'complete',
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
    style?: StyleProp<ViewStyle>,
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
    onPress?: (event: GestureResponderEvent) => void,
    action?: () => Promise<any>
};

export const RoundButton = React.memo(React.forwardRef<
    React.ElementRef<typeof Pressable>,
    RoundButtonProps
>(function RoundButton(props, ref) {
    const { theme } = useUnistyles();
    const scopedSize = React.useContext(RoundButtonSizeContext);
    const styles = stylesheet;
    const [loading, setLoading] = React.useState(false);
    const doLoading = props.loading !== undefined ? props.loading : loading;
    const doAction = React.useCallback((event: GestureResponderEvent) => {
        if (props.onPress) {
            props.onPress(event);
            return;
        }
        if (props.action) {
            setLoading(true);
            (async () => {
                try {
                    await props.action!();
                } finally {
                    setLoading(false);
                }
            })();
        }
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
        inverted: {
            backgroundColor: 'transparent',
            borderColor: 'transparent',
            textColor: theme.colors.text.primary,
        },
        outline: {
            backgroundColor: 'transparent',
            borderColor: theme.colors.border.strong,
            textColor: theme.colors.text.primary,
        },
        contrast: {
            backgroundColor: theme.colors.text.primary,
            borderColor: 'transparent',
            textColor: theme.colors.surface.base,
        },
    }

    const size = sizes[props.size ?? scopedSize ?? 'large'];
    const display = displays[props.display || 'default'];

    // React Native has no `:focus-visible`, so the ring is gated on keyboard modality by the
    // canonical input-modality store; a ring that flashed on every tap would be worse than none.
    // The ring is mounted only once focus has been possible, because `FocusRing` runs a Reanimated
    // animated style and this primitive is on nearly every screen.
    const keyboardModality = useIsKeyboardModality();
    const [focused, setFocused] = React.useState(false);
    const handleFocus = React.useCallback(() => setFocused(true), []);
    const handleBlur = React.useCallback(() => setFocused(false), []);
    const disabled = doLoading || props.disabled === true;
    const ringVisible = focused && keyboardModality && !disabled;

    return (
        <Pressable
            ref={ref}
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            accessibilityHint={props.accessibilityHint}
            disabled={disabled}
            hitSlop={size.hitSlop}
            onFocus={handleFocus}
            onBlur={handleBlur}
            style={(p) => ([
                {
                    borderWidth: 1,
                    borderRadius: 10,
                    backgroundColor: display.backgroundColor,
                    borderColor: display.borderColor,
                    opacity: props.disabled ? 0.35 : (p.pressed ? 0.9 : 1),
                    overflow: 'hidden',
                },
                Platform.OS === 'web' ? WEB_FOCUS_OUTLINE_RESET : null,
                props.style])}
            onPress={doAction}
        >
            <View
                style={[
                    styles.contentContainer,
                    props.leading || props.trailing ? styles.contentContainerWithMark : null,
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
                {doLoading && (
                    <View style={styles.loadingContainer}>
                        <ActivitySpinner color={display.textColor} size='small' />
                    </View>
                )}
                {props.leading ? (
                    <View style={[styles.markSlot, { opacity: doLoading ? 0 : 1 }]}>
                        {props.leading}
                    </View>
                ) : null}
                <Text
                    style={[
                        iOSUIKit.title3,
                        styles.text,
                        {
                            marginTop: size.pad,
                            opacity: doLoading ? 0 : 1,
                            color: display.textColor,
                            fontSize: size.fontSize,
                        },
                        props.titleNumberOfLines === 'complete' ? styles.completeTitle : null,
                        props.textStyle
                    ]}
                    numberOfLines={props.titleNumberOfLines === 'complete' ? undefined : 1}
                >
                    {props.title}
                </Text>
                {props.trailing ? (
                    <View style={[styles.markSlot, { opacity: doLoading ? 0 : 1 }]}>
                        {props.trailing}
                    </View>
                ) : null}
            </View>
            {keyboardModality || focused ? (
                <FocusRing
                    testID={props.testID === undefined ? undefined : `${props.testID}-focus-ring`}
                    visible={ringVisible}
                    // The pill clips its gradient with `overflow: hidden`, so an outside ring would
                    // be cut off exactly where it needs to be seen.
                    placement="inside"
                    radius={10}
                />
            ) : null}
        </Pressable>
    )
}));

RoundButton.displayName = 'RoundButton';
