import { HappierPressable, type HappierPressableProps } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, StyleProp, TextStyle, View } from 'react-native';
import { iOSUIKit } from 'react-native-typography';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { GradientSurface, type SurfaceGradient } from '@/components/ui/surfaces/GradientSurface';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';


export type RoundButtonSize = 'large' | 'normal' | 'small';
const sizes: { [key in RoundButtonSize]: { fontSize: number, hitSlop: number, pad: number } } = {
    large: { fontSize: 21, hitSlop: 0, pad: Platform.OS == 'ios' ? 0 : -1 },
    normal: { fontSize: 16, hitSlop: 8, pad: Platform.OS == 'ios' ? 1 : -2 },
    small: { fontSize: 14, hitSlop: 12, pad: Platform.OS == 'ios' ? -1 : -1 }
}

export type RoundButtonDisplay = 'default' | 'inverted';

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
}));

export const RoundButton = React.memo((props: {
    size?: RoundButtonSize,
    display?: RoundButtonDisplay,
    title?: any,
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
    style?: Exclude<HappierPressableProps['style'], (state: never) => unknown>,
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
    onPress?: HappierPressableProps['onPress'],
    action?: () => Promise<any>
}) => {
    const { theme } = useUnistyles();
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
        inverted: {
            backgroundColor: 'transparent',
            borderColor: 'transparent',
            textColor: theme.colors.text.primary,
        }
    }

    const size = sizes[props.size || 'large'];
    const display = displays[props.display || 'default'];
    return (
        <HappierPressable
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel}
            accessibilityHint={props.accessibilityHint}
            disabled={props.disabled}
            busy={props.loading}
            hitSlop={size.hitSlop}
            style={(state) => ([
                {
                    borderWidth: 1,
                    borderRadius: 10,
                    backgroundColor: display.backgroundColor,
                    borderColor: display.borderColor,
                    // Declared-disabled dims; merely pending does not. A button
                    // that fades the moment it is pressed reads as unavailable
                    // rather than working.
                    opacity: props.disabled ? 0.35 : (state.pressed ? 0.9 : 1),
                    overflow: 'hidden',
                },
                props.style])}
            onPress={doAction}
        >
            {(state) => (
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
                                fontSize: size.fontSize,
                            },
                            props.textStyle
                        ]}
                        numberOfLines={1}
                    >
                        {props.title}
                    </Text>
                    {props.trailing ? (
                        <View style={[styles.markSlot, { opacity: state.busy ? 0 : 1 }]}>
                            {props.trailing}
                        </View>
                    ) : null}
                </View>
            )}
        </HappierPressable>
    )
});
