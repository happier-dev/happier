import {
    HappierPressable,
    HAPPIER_ICON_BUTTON_SIZE,
    resolveHappierIconButtonChrome,
    type HappierPressableProps,
    type HappierPressableRole,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

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
        marginTop: 6,
        zIndex: 1000,
        pointerEvents: 'none',
    },
    tooltip: {
        maxWidth: 240,
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.surface,
        backgroundColor: theme.colors.surface.elevated,
    },
    tooltipText: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
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
 * `size` is the VISIBLE square and nothing else. A caller that needs a bigger
 * physical target declares `minimumInteractiveTargetSize` (plus the row gap it
 * owns) and gets a real press frame around the unchanged drawn square — see
 * the frame comment below for why this is not `hitSlop`.
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
    /** VISIBLE container square in px (icon scales with it). Default 28. */
    size?: number;
    /**
     * Required physical press target while preserving the compact visual square.
     * Callers obtain this from the shared platform policy rather than encoding
     * platform-sized hit slop locally.
     */
    minimumInteractiveTargetSize?: number;
    /**
     * Layout gap this control's own row leaves between it and its nearest
     * neighbour, in px. Horizontal press-frame growth is capped at half of it so
     * two adjacent targets meet exactly and never overlap — DESIGN.md forbids
     * overlapping targets outright. Omitted means "an unknown neighbour could be
     * flush against this control", so the frame grows only on the free vertical
     * axis; the constrained axis then stays at `size`, which still clears WCAG
     * 2.2 AA SC 2.5.8 (24×24 CSS px) at the default size.
     */
    interactiveTargetGapPx?: number;
    iconSize?: number;
    tone?: IconButtonTone;
    variant?: IconButtonVariant;
    /** Borderless resting fill; overrides `variant`. See {@link IconButtonFill}. */
    fill?: IconButtonFill;
    disabled?: boolean;
    /** Whether this toggle-style action is currently selected. */
    selected?: boolean;
    /** Disable the resting selection fill when the caller supplies another selection marker. */
    selectedBackground?: boolean;
    /** Opt into a concrete toggle semantic such as checkbox or switch. */
    accessibilityRole?: HappierPressableRole;
    /** Checked state paired with an explicit checkbox/radio/switch role. */
    checked?: boolean;
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
    onPressOut?: HappierPressableProps['onPressOut'];
    onFocusChange?: HappierPressableProps['onFocusChange'];
    /** The pointer's secondary click on the web, for the same secondary invocation as a long press. */
    onContextMenu?: HappierPressableProps['onContextMenu'];
}> & IconButtonGlyph): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    const tone = props.tone ?? 'default';
    const tint = tone === 'danger'
        ? theme.colors.state.danger.foreground
        : tone === 'primary'
            ? theme.colors.text.primary
            : theme.colors.button.secondary.tint;

    const size = props.size ?? DEFAULT_SIZE;
    const iconSize = props.iconSize ?? Math.max(12, size - 10);
    const variant = props.fill ? 'outlined' : props.variant ?? 'outlined';
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
            background: theme.colors.surface.inset,
            border: theme.colors.border.default,
            hover: theme.colors.surface.selected,
            pressed: theme.colors.surface.pressed,
            selected: theme.colors.surface.pressed,
            focus: theme.colors.border.focus,
        } : {
            // The fill is its own edge: the outline the chrome draws matches it.
            background: fillColor,
            border: fillColor,
            hover: props.fill === 'danger' ? fillColor : theme.colors.state.neutral.border,
            pressed: props.fill === 'danger' ? fillColor : theme.colors.state.neutral.border,
            selected: theme.colors.state.neutral.border,
            focus: theme.colors.border.focus,
        },
    });
    /*
     * A filled well is the drawn square itself: its fill (and its hover/selected step)
     * paints the visible circle, never the larger touch frame around it, and it has no edge (the
     * keyboard focus ring is the shared outline, outside it). Painting the frame drew a second, wider disc — a double ring on a selected
     * Mute and a ring around End inside a touch target.
     */
    const resolveChrome = (state: Parameters<typeof chrome>[0]) => {
        const resolved = chrome(state);
        if (fillColor === null) return resolved;
        const { backgroundColor, ...frame } = resolved.frame;
        return {
            frame,
            surface: { ...resolved.surface, backgroundColor, borderWidth: 0 },
        };
    };
    const minimumInteractiveTargetSize = Number.isFinite(props.minimumInteractiveTargetSize)
        ? Math.max(size, Math.round(props.minimumInteractiveTargetSize!))
        : null;
    /**
     * The press frame, when the declared target is larger than the drawn square.
     *
     * **Not `hitSlop`.** react-native-web 0.21 implements `hitSlop` only in its
     * legacy `Touchable` export — `Pressable` and `View` never read it — and the
     * desktop app IS the web bundle, so a slop-declared target there is a target
     * that does not exist (on Android it is additionally clipped to the parent).
     * The frame is therefore real box model: a larger width/height plus an equal
     * negative margin, which grows the press box on every platform while the
     * layout uses the existing gap first and allocates any remaining width. Same technique as
     * `components/ui/lists/ItemRowActions.tsx`.
     *
     * Vertical is the free axis for an icon control in a row; horizontal is
     * negative margins are bounded by the declared neighbour gap so targets meet but never overlap.
     */
    const targetDeficitPerSide = minimumInteractiveTargetSize === null
        ? 0
        : Math.max(0, (minimumInteractiveTargetSize - size) / 2);
    const neighborGapPx = Number.isFinite(props.interactiveTargetGapPx)
        ? Math.max(0, props.interactiveTargetGapPx!)
        : 0;
    const targetExpandY = targetDeficitPerSide;
    const targetExpandX = Math.min(targetDeficitPerSide, neighborGapPx / 2);
    // The declared floor is a physical target. Only margins are gap-limited; layout allocates
    // any remaining width instead of silently shrinking the target below its contract.
    const frameWidth = minimumInteractiveTargetSize ?? size;
    const frameHeight = size + (targetExpandY * 2);
    const pressFrame = {
        width: frameWidth,
        height: frameHeight,
        // `-0` is a distinct value to strict equality; keep an ungrown frame at a plain 0.
        marginHorizontal: targetExpandX === 0 ? 0 : -targetExpandX,
        marginVertical: targetExpandY === 0 ? 0 : -targetExpandY,
        // The frame carries the fill and the interaction tint, so it stays a
        // capsule around the narrow axis rather than a rounded rectangle. With no
        // growth this is exactly the drawn square's `size / 2`.
        borderRadius: Math.min(frameWidth, frameHeight) / 2,
    };
    // A declared target is owned by the frame; nothing is delegated to inert slop.
    const hitSlop = minimumInteractiveTargetSize === null ? 8 : 0;

    const tooltipContent = props.disabled === true && props.disabledReason
        ? props.disabledReason
        : props.tooltip;
    const richTooltipContent = props.disabled === true && props.disabledReason ? undefined : props.tooltipContent;
    const hasTooltip = richTooltipContent != null || (tooltipContent != null && tooltipContent.length > 0);
    const tooltipAnchorRef = React.useRef<View | null>(null);

    return (
        <HappierPressable
            testID={props.testID}
            accessibilityRole={props.accessibilityRole}
            accessibilityLabel={props.accessibilityLabel}
            accessibilityHint={props.disabled === true && props.disabledReason ? props.disabledReason : props.accessibilityHint}
            disabled={props.disabled}
            selected={props.selected}
            checked={props.checked}
            expanded={props.expanded}
            hasPopup={props.hasPopup}
            controlRef={props.controlRef}
            onKeyDown={props.onKeyDown}
            tabIndex={props.tabIndex}
            hitSlop={hitSlop}
            onPress={props.onPress}
            onLongPress={props.onLongPress}
            onPressIn={props.onPressIn}
            onPressOut={props.onPressOut}
            onFocusChange={props.onFocusChange}
            onContextMenu={props.onContextMenu}
            style={(state) => [
                styles.pressFrame,
                pressFrame,
                resolveChrome(state).frame,
            ]}
            overlay={hasTooltip ? (state) => (
                (state.hovered || state.focused) && props.tooltipHidden !== true ? (Platform.OS === 'web' ? (
                    <>
                        <View ref={tooltipAnchorRef} style={{ pointerEvents: 'none', position: 'absolute', top: 0, left: 0, width: size, height: size }} />
                        <DeferredAnchoredTooltip activationKey={`${state.hovered}:${state.focused}`} anchorRef={tooltipAnchorRef} placement={props.tooltipPlacement} label={tooltipContent ?? props.accessibilityLabel} content={richTooltipContent} testID={props.testID ? `${props.testID}-tooltip` : undefined} />
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
                        resolveChrome({ ...state, pressed: false }).surface,
                    ]}
                >
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
