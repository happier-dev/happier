import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, HAPPIER_PAGE_METRICS, HAPPIER_TYPE_SCALE, HappierPressable, happierRaisedEdgeStyle, type HappierPressableProps, type HappierTypeRole } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, StyleProp, TextStyle, View, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { GradientSurface, type SurfaceGradient } from '@/components/ui/surfaces/GradientSurface';
import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { resolveThemeControlEdge, resolveThemeGloss, resolveThemeSurfaceFinish } from '@/components/ui/surfaces/themeRaisedEdge';
import { HappierSurfaceGradientLayer, happierSurfaceGradientWebStyle } from '@happier-dev/plugin-ui/presentation';
import { usePressFeedback } from '@/components/ui/interactions/usePressFeedback';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';
import { happierMaterialGradient, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { readSurfaceStyleProperty } from '@/components/ui/surfaces/surfaceStyle';
import { parseThemeColor } from '@/theme/parseThemeColor';
import { GlassBackedInkContext, glassThemeInkWebStyle, useGlassOwnFillOnPicture } from '@/components/ui/glass/glassBackedInk';


/** How much of the primary shows while it cannot act (unified-work lab `.uwr-dis`, opacity .38). */
const DISABLED_PRIMARY_PRESENCE = 0.38;
const disabledPrimaryColors = new WeakMap<object, Readonly<{ backgroundColor: string; textColor: string }>>();

/** The primary's fill and words at {@link DISABLED_PRIMARY_PRESENCE} over the page, as solid colours; memoized per theme. */
function resolveDisabledPrimaryColors(theme: Readonly<{ colors: Readonly<{
    surface: Readonly<{ base: string }>;
    button: Readonly<{ primary: Readonly<{ background: string; tint: string; disabled: string }> }>;
}> }>): Readonly<{ backgroundColor: string; textColor: string }> {
    const existing = disabledPrimaryColors.get(theme);
    if (existing) return existing;
    const { surface, button } = theme.colors;
    const page = parseThemeColor(surface.base);
    const background = parseThemeColor(button.primary.background);
    const tint = parseThemeColor(button.primary.tint);
    const resolved = page && background && tint
        ? {
            backgroundColor: page.mix(background, DISABLED_PRIMARY_PRESENCE).rgb().string(),
            textColor: page.mix(tint, DISABLED_PRIMARY_PRESENCE).rgb().string(),
        }
        // A custom theme value the parser cannot read keeps the theme's own disabled slab.
        : { backgroundColor: button.primary.disabled, textColor: button.primary.tint };
    disabledPrimaryColors.set(theme, resolved);
    return resolved;
}

/**
 * Size says where a button stands; `display` says how much it matters. `normal` is the page control height: every
 * page header action (`PageHeader` scopes it, so they pass no `size`) and every dialog or form action. `small` is inside
 * the content: a row, a card, a section, a rail. `large` is a hero call to action. `mini` is the inline action inside a
 * compact capsule (a live call's Retry), not a call to action.
 */
export type RoundButtonSize = 'large' | 'normal' | 'small' | 'mini';
const RoundButtonDefaultSizeContext = React.createContext<Readonly<{
    size: RoundButtonSize;
    presentation: 'contextual' | 'uniform';
}>>({ size: 'large', presentation: 'contextual' });

export function RoundButtonSizeScope(props: Readonly<{
    size: RoundButtonSize;
    /** `uniform` gives an action group one geometry across primary, secondary and destructive fills. */
    presentation?: 'contextual' | 'uniform';
    children: React.ReactNode;
}>) {
    const value = React.useMemo(() => ({ size: props.size, presentation: props.presentation ?? 'contextual' }), [props.size, props.presentation]);
    return <RoundButtonDefaultSizeContext.Provider value={value}>{props.children}</RoundButtonDefaultSizeContext.Provider>;
}
/**
 * Each tier's words are a role of the one type scale; the tiers differ by role and by the pill's
 * geometry. `large` (a hero call to action: onboarding, story decks) reads `heading` in a taller pill
 * rather than a display-size label; `normal` is every dialog and form action and reads `label`, the
 * role a WebAlert action also uses, so all dialog actions are one family. `pad` is the native lift
 * measured against each platform's line box; web centres the role's line box as it is.
 */
const sizes: { [key in RoundButtonSize]: { role: HappierTypeRole, hitSlop: number, pad: number } } = {
    large: { role: 'heading', hitSlop: 0, pad: Platform.select({ ios: 0, android: -1, default: 0 }) },
    normal: { role: 'label', hitSlop: 8, pad: Platform.select({ ios: 1, android: -2, default: 0 }) },
    small: { role: 'body', hitSlop: 12, pad: Platform.select({ ios: -1, android: -1, default: 0 }) },
    mini: { role: 'meta', hitSlop: 8, pad: 0 },
}
/**
 * The drawn height of the sizes that follow the page control metrics, the same two the plugin-ui button
 * draws (`resolveHappierButtonChrome`), so the two owners of a button's size cannot drift. `large` and
 * `mini` are padding-designed; a touch target is never drawn, the pressable's hit area reaches it.
 */
const DRAWN_HEIGHT_PX: { [key in RoundButtonSize]?: number } = {
    normal: HAPPIER_PAGE_METRICS.controlHeightPx,
    small: HAPPIER_PAGE_METRICS.smallControlHeightPx,
};
/** A contextual inline action (bordered, beside a label) never reads larger than `body`. */
function resolveRoundButtonTextRole(role: HappierTypeRole, compactInline: boolean): HappierTypeRole {
    return compactInline && HAPPIER_TYPE_SCALE[role].fontSize > HAPPIER_TYPE_SCALE.body.fontSize ? 'body' : role;
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
        // A control: the `md` step of the one radius base.
        borderRadius: theme.borderRadius.md,
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
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s8,
        borderRadius: 9999,
    },
    // A hero call to action: the same `md` pill, taller, so it leads by presence rather than type size.
    contentContainerLarge: {
        paddingVertical: theme.space.s10,
    },
    // An inline row or header action: it sits beside a label, so it is shorter than a call to action
    // (`body` words in the 32 control height).
    contentContainerSecondary: {
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s6,
    },
    // `normal` and `small` draw at the page control heights (see `DRAWN_HEIGHT_PX`); their label is centred
    // in that height, and a wrapped label still grows the pill.
    contentContainerNormal: {
        paddingVertical: theme.space.s4,
    },
    contentContainerSmall: {
        paddingHorizontal: theme.space.s10,
        paddingVertical: 0,
    },
    // The smallest inline action; inside a capsule it shares the capsule's height band instead.
    contentContainerMini: {
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s4,
    },
    contentContainerInCapsule: {
        paddingVertical: 0,
    },
    // Applied only when a mark is present, so a title-only button keeps the exact
    // single-child layout it has always had.
    contentContainerWithMark: {
        flexDirection: 'row',
        // The seam between the words and the mark. The mark stands in for a word,
        // so this reads as the space between two words rather than as the wider
        // icon-to-label gutter a toolbar button would use.
        gap: theme.space.s4,
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
    // Centres a fixed-height capsule inside a caller's taller box (a header action's own target).
    capsuleBox: {
        justifyContent: 'center',
    },
    text: {
        includeFontPadding: false,
    },
}));

/**
 * What the pill stands on: the primary fill's gloss, the bordered actions' raised edge, nothing for a
 * bare text button. A pressed, focused or disabled pill sits flat, like every other raised control.
 */
function resolveRoundButtonEdge(
    theme: Parameters<typeof resolveThemeGloss>[0],
    display: RoundButtonDisplay,
    state: Readonly<{ pressed: boolean; focused: boolean; disabled: boolean }>,
) {
    if (display === 'default') return resolveThemeGloss(theme, state);
    if (display === 'secondary') return resolveThemeControlEdge(theme, 'strong', state);
    if (display === 'destructive') return resolveThemeControlEdge(theme, 'danger', state);
    return null;
}

type RoundButtonStyle = Exclude<HappierPressableProps['style'], (state: never) => unknown>;

/** The mark size a busy spinner takes the place of (the quiet inline actions draw their glyph at 14). */
const BUSY_MARK_SIZE = 14;

const TRANSPARENT_LAYOUT_BOX = { backgroundColor: 'transparent' } as const;

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
     * action standing level with the round wells beside it. Under a finger the pressable's hit area
     * reaches the touch target past it, so a 34pt pill keeps its 44pt target without growing.
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
    const scopedSizing = React.useContext(RoundButtonDefaultSizeContext);
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
    const paintColor = useHappierMaterialColorResolver();
    const secondaryFill = paintColor(theme.colors.edge.fill);
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
            backgroundColor: secondaryFill,
            borderColor: theme.colors.border.strong,
            textColor: theme.colors.text.primary,
        },
        destructive: {
            backgroundColor: secondaryFill,
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
    const callerBackgroundColor = readSurfaceStyleProperty(props.style, 'backgroundColor');
    const resolvedSize = props.size ?? scopedSizing.size;
    const size = sizes[resolvedSize];
    // Contextual inline actions keep their compact presentation. A uniform action group owns one
    // geometry regardless of fill; an explicit size still overrides the group's default size.
    const compactInlineDisplay = scopedSizing.presentation !== 'uniform'
        && (props.display === 'secondary' || props.display === 'destructive');
    const textTypography = Typography.variant(resolveRoundButtonTextRole(size.role, compactInlineDisplay), 'semiBold');
    // The pill draws at its design size under every pointer. Under a finger the shared Pressable reaches
    // the touch target with its hit area (native hitSlop, the web's invisible frame), never by growing
    // the button (DESIGN.md → touch targets are hit areas). The slop below is a precise pointer's extra
    // reach only, and none when a caller's own box (a header action) is already the target.
    const callerMinHeight = readSurfaceStyleProperty(props.style, 'minHeight');
    const slopDeclared = !(typeof callerMinHeight === 'number' && callerMinHeight >= HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE);
    const baseDisplay = displays[props.display || 'default'];
    // A disabled primary is still the primary: its own fill and words, receded into the page
    // (unified-work lab `.uwr-dis`), so the one action of a view stays recognisable while it waits
    // for its reason. Laid over the page as solid colours, it never shows floating material through.
    const disabledPrimary = props.disabled === true && (props.display ?? 'default') === 'default';
    const display: (typeof displays)[RoundButtonDisplay] = disabledPrimary
        ? { ...resolveDisabledPrimaryColors(theme), borderColor: 'transparent' }
        : baseDisplay;
    const textColor = (props.display ?? 'default') === 'default' && !disabledPrimary ? paintColor(display.textColor, theme.colors.text.primary, 'solidControl') : display.textColor;
    const pillBackgroundColor = callerBackgroundColor ?? display.backgroundColor;
    // A pill with its own fill on the Wallpaper picture keeps the theme's ink for its label and mark.
    const ownFillOnPicture = useGlassOwnFillOnPicture(pillBackgroundColor !== 'transparent');
    const inkScope = React.useContext(GlassBackedInkContext);
    const paintRole = (props.display ?? 'default') === 'default' || callerBackgroundColor !== undefined ? 'solidControl' : 'surface';
    // A button with a mark and words keeps its words while it works: the spinner takes the mark's place.
    // A words-only or mark-only button has nothing to trade, so its spinner covers it at the same width.
    const busyTradesMark = props.leading != null && props.title != null && props.title !== '';
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
            hitSlop={slopDeclared ? size.hitSlop : undefined}
            // The pressable keeps the caller's layout and the hit area; the visible
            // pill is the animated frame inside it, so the tactile press moves the
            // whole fill rather than only its label.
            // Declared-disabled dims; merely pending does not. A button that fades
            // the moment it is pressed reads as unavailable rather than working.
            style={[
                { opacity: props.disabled && !disabledPrimary ? 0.35 : 1 },
                props.capsuleHeight !== undefined ? styles.capsuleBox : null,
                props.style,
                TRANSPARENT_LAYOUT_BOX,
                // The ring belongs to the pill inside the hit area.
                HAPPIER_FOCUS_RING_DELEGATED_STYLE,
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
                            backgroundColor: typeof pillBackgroundColor === 'string' ? paintColor(pillBackgroundColor, undefined, paintRole) : pillBackgroundColor,
                            borderColor: display.borderColor,
                        },
                        props.capsuleHeight !== undefined
                            ? { flexGrow: 0, height: props.capsuleHeight, borderRadius: props.capsuleHeight / 2 }
                            : { minHeight: DRAWN_HEIGHT_PX[resolvedSize] },
                        focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                        happierRaisedEdgeStyle(resolveRoundButtonEdge(theme, props.display ?? 'default', { pressed: state.pressed, focused: state.focused, disabled: state.disabled })),
                        Platform.OS === 'web' && !display.gradient ? happierSurfaceGradientWebStyle(resolveThemeSurfaceFinish(theme, (props.display ?? 'default') === 'default' ? 'primaryButton' : 'secondaryButton', { pressed: state.pressed, focused: state.focused, disabled: state.disabled || props.display === 'inverted' }), !theme.dark) : null,
                        ownFillOnPicture && Platform.OS === 'web' ? glassThemeInkWebStyle(theme.colors.text) as ViewStyle : null,
                        pressFeedback.animatedStyle,
                    ]}
                >
                    <GlassBackedInkContext.Provider value={ownFillOnPicture ? null : inkScope}>
                    {/* The fill's gloss belongs to the pill, not to its content: when a touch floor or a
                        caller's layout makes the pill taller than its label, a gloss sized by the
                        content would draw a second, smaller pill inside the fill. */}
                    {display.gradient ? (
                        <GradientSurface
                            fallbackColor={paintColor(display.backgroundColor, undefined, 'solidControl')}
                            gradient={happierMaterialGradient(display.gradient, color => paintColor(color, undefined, 'solidControl'))}
                            overlay={resolveThemeSurfaceFinish(theme, 'primaryButton', { pressed: state.pressed, focused: state.focused, disabled: state.disabled })}
                            clipToPaddingBox={!theme.dark}
                            borderRadius={theme.borderRadius.md}
                            style={StyleSheet.absoluteFillObject}
                        />
                    ) : null}
                    {!display.gradient ? <HappierSurfaceGradientLayer gradient={resolveThemeSurfaceFinish(theme, (props.display ?? 'default') === 'default' ? 'primaryButton' : 'secondaryButton', { pressed: state.pressed, focused: state.focused, disabled: state.disabled || props.display === 'inverted' })} borderRadius={props.capsuleHeight !== undefined ? props.capsuleHeight / 2 : theme.borderRadius.md} /> : null}
                    <View
                        style={[
                            styles.contentContainer,
                            props.leading || props.trailing ? styles.contentContainerWithMark : null,
                            resolvedSize === 'large' ? styles.contentContainerLarge : null,
                            resolvedSize === 'normal' ? styles.contentContainerNormal : null,
                            compactInlineDisplay ? styles.contentContainerSecondary : null,
                            resolvedSize === 'small' ? styles.contentContainerSmall : null,
                            props.size === 'mini' ? styles.contentContainerMini : null,
                            props.capsuleHeight !== undefined ? styles.contentContainerInCapsule : null,
                        ]}
                    >
                        {state.busy && !busyTradesMark && (
                            <View style={styles.loadingContainer}>
                                <ActivitySpinner color={textColor} size='small' />
                            </View>
                        )}
                        {props.leading ? (
                            <View style={[styles.markSlot, { opacity: state.busy && !busyTradesMark ? 0 : 1 }]}>
                                {state.busy && busyTradesMark
                                    ? <ActivitySpinner color={textColor} size={iconMatchedSpinnerSize(BUSY_MARK_SIZE)} />
                                    : props.leading}
                            </View>
                        ) : null}
                        <Text
                            style={[
                                textTypography,
                                styles.text,
                                {
                                    marginTop: size.pad,
                                    opacity: state.busy && !busyTradesMark ? 0 : 1,
                                    color: textColor,
                                },
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
                            <View style={[styles.markSlot, { opacity: state.busy && !busyTradesMark ? 0 : 1 }]}>
                                {props.trailing}
                            </View>
                        ) : null}
                    </View>
                    </GlassBackedInkContext.Provider>
                </Animated.View>
            )}
        </HappierPressable>
    )
});
