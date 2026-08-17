import {
    HappierPressable,
    type HappierPressableProps,
    type HappierPressableRole,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

const DEFAULT_SIZE = 28;

export type IconButtonTone = 'default' | 'primary' | 'danger';
export type IconButtonVariant = 'outlined' | 'plain';

const stylesheet = StyleSheet.create((theme) => ({
    pressFrame: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    button: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    /**
     * The outlined border draws the VISIBLE square, so it lives on the surface.
     * Its fill lives on the frame below: the surface stays transparent, which is
     * what lets the frame's interaction tint show through instead of being
     * covered by an opaque inset background.
     */
    surfaceOutlined: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    frameOutlined: {
        backgroundColor: theme.colors.surface.inset,
    },
    buttonHovered: {
        backgroundColor: theme.colors.surface.selected,
    },
    buttonPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    buttonSelected: {
        backgroundColor: theme.colors.surface.pressed,
    },
    buttonFocused: {
        borderWidth: 1,
        borderColor: theme.colors.border.strong,
    },
    buttonDisabled: {
        opacity: 0.5,
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
    /** Short helper shown on hover/focus (desktop pointer/keyboard users). */
    tooltip?: string;
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
    disabled?: boolean;
    /** Whether this toggle-style action is currently selected. */
    selected?: boolean;
    /** Opt into a concrete toggle semantic such as checkbox or switch. */
    accessibilityRole?: HappierPressableRole;
    /** Checked state paired with an explicit checkbox/radio/switch role. */
    checked?: boolean;
    /** Human copy for WHY the button is disabled — tooltip + a11y hint. */
    disabledReason?: string;
    animationEnabled?: boolean;
    /** Receives the gesture event so a row-nested action can stop propagation to its row. */
    onPress: HappierPressableProps['onPress'];
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
    const variant = props.variant ?? 'outlined';
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
     * layout still measures the drawn square. Same technique as
     * `components/ui/lists/ItemRowActions.tsx`.
     *
     * Vertical is the free axis for an icon control in a row; horizontal is
     * bounded by {@link IconButton}'s declared neighbour gap so targets meet but
     * never overlap.
     */
    const targetDeficitPerSide = minimumInteractiveTargetSize === null
        ? 0
        : Math.max(0, (minimumInteractiveTargetSize - size) / 2);
    const neighborGapPx = Number.isFinite(props.interactiveTargetGapPx)
        ? Math.max(0, props.interactiveTargetGapPx!)
        : 0;
    const targetExpandY = targetDeficitPerSide;
    const targetExpandX = Math.min(targetDeficitPerSide, neighborGapPx / 2);
    const frameWidth = size + (targetExpandX * 2);
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
    const hasTooltip = tooltipContent != null && tooltipContent.length > 0;

    return (
        <HappierPressable
            testID={props.testID}
            accessibilityRole={props.accessibilityRole}
            accessibilityLabel={props.accessibilityLabel}
            accessibilityHint={props.disabled === true ? props.disabledReason : undefined}
            disabled={props.disabled}
            selected={props.selected}
            checked={props.checked}
            hitSlop={hitSlop}
            onPress={props.onPress}
            style={(state) => [
                styles.pressFrame,
                pressFrame,
                variant === 'outlined' ? styles.frameOutlined : null,
                props.selected === true ? styles.buttonSelected : null,
                state.hovered ? styles.buttonHovered : null,
                state.pressed ? styles.buttonPressed : null,
                state.disabled ? styles.buttonDisabled : null,
            ]}
            overlay={hasTooltip ? (state) => (
                state.hovered || state.focused ? (
                    <View style={styles.tooltipWrap}>
                        <View testID={props.testID ? `${props.testID}-tooltip` : undefined} style={styles.tooltip}>
                            <Text style={styles.tooltipText} numberOfLines={3}>
                                {tooltipContent}
                            </Text>
                        </View>
                    </View>
                ) : null
            ) : undefined}
        >
            {(state) => (
                <View
                    testID={props.testID ? `${props.testID}-surface` : undefined}
                    style={[
                        styles.button,
                        { width: size, height: size, borderRadius: size / 2 },
                        variant === 'outlined' ? styles.surfaceOutlined : null,
                        state.focused ? styles.buttonFocused : null,
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
