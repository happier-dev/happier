import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

const DEFAULT_SIZE = 28;

type WebPressableInteractionState = Readonly<{
    pressed: boolean;
    hovered?: boolean;
    focused?: boolean;
}>;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    if (value === null) return false;
    const valueType = typeof value;
    if (valueType !== 'object' && valueType !== 'function') return false;
    return typeof (value as { then?: unknown }).then === 'function';
}

export type IconButtonTone = 'default' | 'primary' | 'danger';
export type IconButtonVariant = 'outlined' | 'plain';

const stylesheet = StyleSheet.create((theme) => ({
    button: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonOutlined: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    buttonHovered: {
        backgroundColor: theme.colors.surface.selected,
    },
    buttonPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    buttonFocused: {
        borderWidth: 1,
        borderColor: theme.colors.border.strong,
    },
    buttonDisabled: {
        opacity: 0.5,
    },
    anchor: {
        // The tooltip is absolutely positioned against this wrapper.
        position: 'relative',
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
 * pattern — audit XS-1). `Pressable` + theme tokens + `SafeIonicons` with:
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
 */
export function IconButton(props: Readonly<{
    testID?: string;
    iconName: React.ComponentProps<typeof SafeIonicons>['name'];
    /** Required: icon-only controls must always announce their action. */
    accessibilityLabel: string;
    /** Short helper shown on hover/focus (desktop pointer/keyboard users). */
    tooltip?: string;
    /** Container square in px (icon scales with it). Default 28. */
    size?: number;
    iconSize?: number;
    tone?: IconButtonTone;
    variant?: IconButtonVariant;
    disabled?: boolean;
    /** Human copy for WHY the button is disabled — tooltip + a11y hint. */
    disabledReason?: string;
    animationEnabled?: boolean;
    onPress: () => void | Promise<unknown> | undefined;
}>): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [isBusy, setIsBusy] = React.useState(false);
    const [isHovered, setIsHovered] = React.useState(false);
    const [isFocused, setIsFocused] = React.useState(false);
    const isMountedRef = React.useRef(true);
    const busyRef = React.useRef(false);
    React.useEffect(() => () => {
        isMountedRef.current = false;
    }, []);

    const tone = props.tone ?? 'default';
    const tint = tone === 'danger'
        ? theme.colors.state.danger.foreground
        : tone === 'primary'
            ? theme.colors.text.primary
            : theme.colors.button.secondary.tint;

    const size = props.size ?? DEFAULT_SIZE;
    const iconSize = props.iconSize ?? Math.max(12, size - 10);
    const variant = props.variant ?? 'outlined';
    const isDisabled = props.disabled === true || isBusy;

    const handlePress = React.useCallback(() => {
        if (busyRef.current || props.disabled === true) {
            return;
        }
        const result = props.onPress();
        if (!isPromiseLike(result)) {
            return;
        }
        busyRef.current = true;
        setIsBusy(true);
        void Promise.resolve(result).catch(() => undefined).finally(() => {
            busyRef.current = false;
            if (isMountedRef.current) {
                setIsBusy(false);
            }
        });
    }, [props]);

    const tooltipContent = props.disabled === true && props.disabledReason
        ? props.disabledReason
        : props.tooltip;
    const showTooltip = tooltipContent != null && tooltipContent.length > 0 && (isHovered || isFocused);

    return (
        <View style={styles.anchor}>
            <Pressable
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={props.accessibilityLabel}
                accessibilityHint={props.disabled === true ? props.disabledReason : undefined}
                accessibilityState={{ busy: isBusy, disabled: isDisabled }}
                disabled={isDisabled}
                hitSlop={8}
                onPress={handlePress}
                onHoverIn={() => setIsHovered(true)}
                onHoverOut={() => setIsHovered(false)}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                style={(state) => {
                    const { pressed } = state;
                    // RN Web exposes `hovered`/`focused` in the Pressable state
                    // callback; the react-native types do not model them.
                    const webState = state as WebPressableInteractionState;
                    return [
                        styles.button,
                        { width: size, height: size, borderRadius: size / 2 },
                        variant === 'outlined' ? styles.buttonOutlined : null,
                        webState.hovered === true || isHovered ? styles.buttonHovered : null,
                        pressed ? styles.buttonPressed : null,
                        webState.focused === true || isFocused ? styles.buttonFocused : null,
                        isDisabled ? styles.buttonDisabled : null,
                    ];
                }}
            >
                <View
                    testID={props.testID ? `${props.testID}-icon` : undefined}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={styles.iconWrap}
                >
                    {isBusy ? (
                        <ActivitySpinner
                            testID={props.testID ? `${props.testID}-spinner` : undefined}
                            size={Math.max(10, iconSize - 2)}
                            color={tint}
                            animationEnabled={props.animationEnabled !== false}
                        />
                    ) : (
                        <SafeIonicons name={props.iconName} size={iconSize} color={tint} />
                    )}
                </View>
            </Pressable>
            {showTooltip ? (
                <View style={styles.tooltipWrap}>
                    <View testID={props.testID ? `${props.testID}-tooltip` : undefined} style={styles.tooltip}>
                        <Text style={styles.tooltipText} numberOfLines={3}>
                            {tooltipContent}
                        </Text>
                    </View>
                </View>
            ) : null}
        </View>
    );
}
