import {
    HappierPressable,
    HAPPIER_ICON_BUTTON_SIZE,
    resolveHappierIconButtonChrome,
    type HappierPressableProps,
    type HappierPressableRole,
    useHappierMaterialColorResolver,
} from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { resolveIconButtonGlyphSize } from '@/components/ui/icons/iconButtonGlyphSize';
import { visuallyHiddenStyle } from '@/components/ui/accessibility/visuallyHiddenStyle';

import { DeferredAnchoredTooltip } from '@/components/ui/overlays/DeferredAnchoredTooltip';

const DEFAULT_SIZE = HAPPIER_ICON_BUTTON_SIZE;

export type IconButtonTone = 'default' | 'primary' | 'danger';
export type IconButtonVariant = 'outlined' | 'plain';
/**
 * A borderless resting fill, for a compact transport where the buttons themselves are the
 * object (a call's Mute · End): `neutral` is a quiet well, `danger` the tinted terminal action.
 * Hover deepens the fill; the shape never gains a border.
 */
export type IconButtonFill = 'neutral' | 'danger';

const stylesheet = StyleSheet.create((theme) => ({
    pressFrame: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    tooltipWrap: {
        // Wide invisible strip below the button so the bubble can center on it
        // without percentage transforms (not supported on older RN natives).
        position: 'absolute',
        top: '100%',
        left: -110,
        right: -110,
        alignItems: 'center',
        marginTop: theme.space.s6,
        zIndex: 1000,
        pointerEvents: 'none',
    },
    tooltip: {
        maxWidth: 240,
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s4,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.surface,
        backgroundColor: theme.colors.surface.elevated,
    },
    tooltipText: {

        ...Typography.variant('meta'),

        color: theme.colors.text.primary,
    },
    iconWrap: {
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

/**
 * The ONE shared icon-only action button (promoted `ServiceActionButton`
 * pattern — audit XS-1).
 *
 * The press mechanism is `HappierPressable`, the shared presentation owner that
 * plugin surfaces render too (UI-T27). It used to live here — a local
 * `isPromiseLike`, a `busyRef` and a mount guard — beside a second, subtly
 * different copy in `RoundButton`. This adapter now owns only what Happier core
 * owns: its Unistyles chrome, its icon seam and its tooltip. What it still
 * provides, unchanged:
 *
 * - required accessibility label (icon-only buttons are never unlabeled);
 * - pressed / hover (web) / focus-visible states;
 * - async-pending handling: while the `onPress` promise is unresolved the icon
 *   is replaced by an {@link ActivitySpinner} and the button is disabled, so a
 *   slow daemon action never looks unresponsive. Pending clears on settle
 *   (resolve OR reject) without fabricating a new status;
 * - optional tooltip shown on hover/focus (desktop); a `disabledReason` takes
 *   priority over the tooltip and is exposed as the accessibility hint.
 *
 * Tones map to theme state colors; `variant: 'plain'` drops the border/fill
 * for dense toolbars.
 *
 * `size` is the VISIBLE square and its whole layout box. Under a finger the shared
 * pressable's hit area reaches the touch target past it (native `hitSlop`, an
 * invisible frame on the web); a caller that asks for a larger hit area declares
 * `minimumInteractiveTargetSize`, and the free space it may reach into.
 */
/**
 * Exactly one glyph source. `iconName` covers the common case of a single seam-registered glyph;
 * `icon` takes any element, which is what lets non-seam-icon controls (e.g. the source-control
 * actions) share this owner instead of growing a parallel icon-only button next to it.
 */
export type IconButtonIconName = IconName;

export type IconButtonGlyph =
    | Readonly<{ iconName: IconButtonIconName; icon?: never }>
    | Readonly<{ icon: React.ReactNode; iconName?: never }>;

export function IconButton(props: Readonly<{
    testID?: string;
    /** Required: icon-only controls must always announce their action. */
    accessibilityLabel: string;
    /** What the press will do beyond its name ("Coding work already started keeps running"). */
    accessibilityHint?: string;
    /** Short helper shown on hover/focus (desktop pointer/keyboard users). */
    tooltip?: string;
    tooltipContent?: React.ReactNode;
    tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right';
    /**
     * Hide the tooltip for now (for example while this button's own popover is open) without
     * changing the button's structure, so the pressable is not remounted and keeps its focus.
     */
    tooltipHidden?: boolean;
    /** VISIBLE container square in px; the glyph is the icon-scale step that fits it. Default 28. */
    size?: number;
    /**
     * A hit area this control asks for beyond the defaults: the environment's touch target under a
     * finger and the WCAG pointer floor under a precise pointer. It never changes the drawn square
     * or its layout.
     */
    minimumInteractiveTargetSize?: number;
    /**
     * Horizontal gap this control's row leaves to its nearest neighbour, in px. The hit area reaches
     * at most half of it sideways, so adjacent targets never overlap; above and below it reaches the
     * whole target, so the caller must not clip that space.
     */
    interactiveTargetGapPx?: number;
    /**
     * The free space on each side the hit area may take (half of each neighbour gap, or the
     * container's padding at its ends), so a row of controls tiles its container with targets and
     * none overlap. Overrides `interactiveTargetGapPx`. `top` and `bottom` bound the vertical reach
     * where a clipping edge sits closer than the target (a control in a clipped block); omitted, the
     * hit area reaches the whole target above and below.
     */
    interactiveTargetEdgesPx?: Readonly<{ leading: number; trailing: number; top?: number; bottom?: number }>;
    /**
     * Vertical gap this control's column leaves to the neighbours above and below, in px. The hit area
     * reaches at most half of it up and down (a stacked rail of controls); omitted, it reaches the
     * whole target, so a caller that stacks controls declares it.
     */
    interactiveTargetVerticalGapPx?: number;
    iconSize?: number;
    tone?: IconButtonTone;
    variant?: IconButtonVariant;
    /** Borderless resting fill; overrides `variant`. See {@link IconButtonFill}. */
    fill?: IconButtonFill;
    disabled?: boolean;
    /**
     * Work owned elsewhere is in flight (a write that outlives the press that started it): the icon
     * becomes the spinner and presses are ignored, as for a pending `onPress` promise.
     */
    busy?: boolean;
    /** Whether this toggle-style action is currently selected. */
    selected?: boolean;
    /** Disable the resting selection fill when the caller supplies another selection marker. */
    selectedBackground?: boolean;
    /** Opt into a concrete toggle semantic such as checkbox or switch. */
    accessibilityRole?: HappierPressableRole;
    /** Checked state paired with an explicit checkbox/radio/switch role. */
    checked?: HappierPressableProps['checked'];
    /** Whether the menu or panel this button opens is showing (a popover trigger). */
    expanded?: boolean;
    /** The kind of surface this button opens, announced to assistive technology. */
    hasPopup?: HappierPressableProps['hasPopup'];
    /** Receives the focusable control, so a surface this button opened can hand focus back to it. */
    controlRef?: HappierPressableProps['controlRef'];
    /** Compound controls use the shared pressable's keyboard and roving-focus contract. */
    onKeyDown?: HappierPressableProps['onKeyDown'];
    tabIndex?: HappierPressableProps['tabIndex'];
    /** Human copy for WHY the button is disabled — tooltip + a11y hint. */
    disabledReason?: string;
    animationEnabled?: boolean;
    /** Receives the gesture event so a row-nested action can stop propagation to its row. */
    onPress: HappierPressableProps['onPress'];
    /** A secondary invocation (press and hold); when it fires, `onPress` does not. */
    onLongPress?: HappierPressableProps['onLongPress'];
    onPressIn?: HappierPressableProps['onPressIn'];
    preserveFocusOnPress?: HappierPressableProps['preserveFocusOnPress'];
    onPressOut?: HappierPressableProps['onPressOut'];
    onFocusChange?: HappierPressableProps['onFocusChange'];
    /** The pointer's secondary click on the web, for the same secondary invocation as a long press. */
    onContextMenu?: HappierPressableProps['onContextMenu'];
}> & IconButtonGlyph): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();

    const tone = props.tone ?? 'default';
    const tint = tone === 'danger'
        ? theme.colors.state.danger.foreground
        : tone === 'primary'
            ? theme.colors.text.primary
            : theme.colors.button.secondary.tint;

    const size = props.size ?? DEFAULT_SIZE;
    const iconSize = props.iconSize ?? resolveIconButtonGlyphSize(size);
    const variant = props.fill ? 'well' : props.variant ?? 'outlined';
    const fillColor = props.fill === 'danger'
        ? theme.colors.state.danger.background
        : props.fill === 'neutral'
            ? theme.colors.state.neutral.background
            : null;
    const chrome = (state: Readonly<{
        selected: boolean; hovered: boolean; pressed: boolean; focused: boolean; disabled: boolean;
    }>) => resolveHappierIconButtonChrome({
        ...state, size, variant, selectedBackground: props.selectedBackground,
        colors: fillColor === null ? {
            background: paintColor(theme.colors.surface.inset),
            border: theme.colors.border.default,
            hover: paintColor(theme.colors.surface.selected),
            pressed: paintColor(theme.colors.surface.pressed),
            selected: paintColor(theme.colors.surface.pressed),
            focus: theme.colors.border.focus,
        } : {
            // The fill is its own edge: a `well` draws no outline.
            background: paintColor(fillColor, undefined, 'solidControl'),
            border: fillColor,
            hover: paintColor(props.fill === 'danger' ? fillColor : theme.colors.state.neutral.border, undefined, 'solidControl'),
            pressed: paintColor(props.fill === 'danger' ? fillColor : theme.colors.state.neutral.border, undefined, 'solidControl'),
            selected: paintColor(theme.colors.state.neutral.border, undefined, 'solidControl'),
            focus: theme.colors.border.focus,
        },
    });
    const hitTarget = Number.isFinite(props.minimumInteractiveTargetSize)
        ? Math.round(props.minimumInteractiveTargetSize!)
        : HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE;
    const halfGap = Number.isFinite(props.interactiveTargetGapPx)
        ? Math.max(0, props.interactiveTargetGapPx!) / 2
        : undefined;
    const edges = props.interactiveTargetEdgesPx;
    // The hit area is the shared pressable's: the drawn square is the whole layout box and the hit
    // area reaches past it into the free space declared here, never into a neighbour's.
    const halfVerticalGap = Number.isFinite(props.interactiveTargetVerticalGapPx)
        ? Math.max(0, props.interactiveTargetVerticalGapPx!) / 2
        : undefined;
    const horizontalReach = edges
        ? {
            left: Math.max(0, edges.leading),
            right: Math.max(0, edges.trailing),
            ...(edges.top === undefined ? null : { top: Math.max(0, edges.top) }),
            ...(edges.bottom === undefined ? null : { bottom: Math.max(0, edges.bottom) }),
        }
        : halfGap === undefined ? undefined : { left: halfGap, right: halfGap };
    const hitReach = halfVerticalGap === undefined
        ? horizontalReach
        : { ...horizontalReach, top: halfVerticalGap, bottom: halfVerticalGap };
    const pressFrame = { width: size, height: size };

    const tooltipContent = props.disabled === true && props.disabledReason
        ? props.disabledReason
        : props.tooltip;
    const richTooltipContent = props.disabled === true && props.disabledReason ? undefined : props.tooltipContent;
    const hasTooltip = richTooltipContent != null || (tooltipContent != null && tooltipContent.length > 0);
    const tooltipAnchorRef = React.useRef<View | null>(null);
    // A press answers the pointer: its tooltip steps aside until the pointer leaves, and stays away
    // while the menu or popover the button opened is showing.
    const [pressedSinceHover, setPressedSinceHover] = React.useState(false);
    const onPressIn = props.onPressIn;
    const handlePressIn = React.useCallback((event: Parameters<NonNullable<typeof onPressIn>>[0]) => {
        setPressedSinceHover(true);
        onPressIn?.(event);
    }, [onPressIn]);
    const onHoverChange = React.useCallback((hovered: boolean) => {
        if (!hovered) {
            setPressedSinceHover(false);
            setReasonRevealed(false);
        }
    }, []);
    const tooltipQuiet = props.tooltipHidden === true || props.expanded === true || pressedSinceHover;
    const descriptionId = React.useId();
    const disabledReason = props.disabled === true ? props.disabledReason : undefined;
    // A disabled button with a reason stays reachable. A pointer already gets the reason on hover and
    // the keyboard on focus; a finger can only press, so a touch press shows it. Leaving or blurring
    // the button puts it away again.
    const [reasonRevealed, setReasonRevealed] = React.useState(false);
    const revealReason = React.useCallback((event?: unknown) => {
        const pointerType = (event as { nativeEvent?: { pointerType?: unknown } } | undefined)?.nativeEvent?.pointerType;
        if (Platform.OS === 'web' && pointerType !== 'touch') return;
        setReasonRevealed(true);
    }, []);
    React.useEffect(() => {
        if (!disabledReason) setReasonRevealed(false);
    }, [disabledReason]);
    const onFocusChange = props.onFocusChange;
    const handleFocusChange = React.useCallback((focused: boolean) => {
        if (!focused) setReasonRevealed(false);
        onFocusChange?.(focused);
    }, [onFocusChange]);
    const showReason = reasonRevealed && disabledReason !== undefined && props.tooltipHidden !== true;

    return (
        <HappierPressable
            testID={props.testID}
            accessibilityRole={props.accessibilityRole}
            accessibilityLabel={props.accessibilityLabel}
            accessibilityHint={props.disabled === true && props.disabledReason ? props.disabledReason : props.accessibilityHint}
            describedById={disabledReason ? descriptionId : undefined}
            disabled={props.disabled}
            onDisabledPress={disabledReason ? revealReason : undefined}
            busy={props.busy}
            selected={props.selected}
            checked={props.checked}
            expanded={props.expanded}
            hasPopup={props.hasPopup}
            controlRef={props.controlRef}
            onKeyDown={props.onKeyDown}
            tabIndex={props.tabIndex}
            hitSlop={8}
            hitTarget={hitTarget}
            hitReach={hitReach}
            onPress={props.onPress}
            onLongPress={props.onLongPress}
            onPressIn={handlePressIn}
            preserveFocusOnPress={props.preserveFocusOnPress}
            onHoverChange={onHoverChange}
            onPressOut={props.onPressOut}
            onFocusChange={handleFocusChange}
            onContextMenu={props.onContextMenu}
            style={(state) => [
                styles.pressFrame,
                pressFrame,
                chrome(state).frame,
            ]}
            overlay={hasTooltip ? (state) => (
                showReason || ((state.hovered || state.focused) && !tooltipQuiet) ? (Platform.OS === 'web' ? (
                    <>
                        <View ref={tooltipAnchorRef} style={{ pointerEvents: 'none', position: 'absolute', top: 0, left: 0, width: size, height: size }} />
                        <DeferredAnchoredTooltip activationKey={`${state.hovered}:${state.focused}:${showReason}`} anchorRef={tooltipAnchorRef} placement={props.tooltipPlacement} label={tooltipContent ?? props.accessibilityLabel} content={richTooltipContent} testID={props.testID ? `${props.testID}-tooltip` : undefined} />
                    </>
                ) : (
                    <View style={styles.tooltipWrap}>
                        <View testID={props.testID ? `${props.testID}-tooltip` : undefined} style={styles.tooltip}>
                            {richTooltipContent ?? <Text style={styles.tooltipText} numberOfLines={3}>
                                {tooltipContent}
                            </Text>}
                        </View>
                    </View>
                )) : null
            ) : undefined}
        >
            {(state) => (
                <View
                    testID={props.testID ? `${props.testID}-surface` : undefined}
                    style={[
                        chrome(state).surface,
                    ]}
                >
                    {disabledReason ? <Text nativeID={descriptionId} style={visuallyHiddenStyle}
                        accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{disabledReason}</Text> : null}
                    <View
                        testID={props.testID ? `${props.testID}-icon` : undefined}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                        style={styles.iconWrap}
                    >
                        {state.busy ? (
                            <ActivitySpinner
                                testID={props.testID ? `${props.testID}-spinner` : undefined}
                                size={iconMatchedSpinnerSize(iconSize)}
                                color={tint}
                                animationEnabled={props.animationEnabled !== false}
                            />
                        ) : (
                            props.icon ?? <Icon name={props.iconName!} size={iconSize} color={tint} />
                        )}
                    </View>
                </View>
            )}
        </HappierPressable>
    );
}
