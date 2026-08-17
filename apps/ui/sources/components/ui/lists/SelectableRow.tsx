import * as React from 'react';
import { Platform, Pressable, View, StyleProp, ViewStyle, TextStyle, StyleSheet as RNStyleSheet } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { buildActionRowAccessibilityLabel } from './actionRowAccessibility';
import { ICON_LABEL_OPTICAL_NUDGE_STYLE } from '@/components/ui/icons/iconOpticalAlignment';


/**
 * Resizes an icon-like accessory, and only an icon-like one.
 *
 * A node is icon-like when it names a glyph and takes a size and has no children. Avatars, gauges
 * and composed nodes are laid out by their own owner and must not be stretched to the icon box.
 */
function sizeRowIconForDensity(node: React.ReactNode, glyphSize: number): React.ReactNode {
    if (!React.isValidElement(node) || node.type === React.Fragment) return node;
    const nodeProps = (node.props ?? {}) as Record<string, unknown>;
    const isIconLike = typeof nodeProps.name === 'string'
        && (typeof nodeProps.size === 'number' || typeof nodeProps.size === 'string')
        && nodeProps.children == null;
    if (!isIconLike) return node;
    return React.cloneElement(node, { size: glyphSize } as Record<string, unknown>);
}

export type SelectableRowVariant = 'slim' | 'default' | 'selectable';

export type SelectableRowProps = Readonly<{
    testID?: string;
    title: React.ReactNode;
    titleAccessory?: React.ReactNode;
    subtitle?: React.ReactNode;
    left?: React.ReactNode;
    right?: React.ReactNode;
    /** Renders the right accessory beside, rather than inside, the row activation target. */
    rightElementOutsidePressable?: boolean;
    leftGap?: number;

    selected?: boolean;
    disabled?: boolean;
    /**
     * When `disabled`, the row will not be pressable. Set this to true when the row
     * contains nested interactive elements (e.g. menu buttons) that must remain
     * usable even while the row itself is disabled.
     */
    allowChildInteractionWhenDisabled?: boolean;
    destructive?: boolean;

    variant?: SelectableRowVariant;
    onPress?: () => void;
    onHover?: () => void;
    onMouseDownCapture?: (event: unknown) => void;
    onKeyDown?: (event: unknown) => void;
    accessibilityLabel?: string;
    accessibilityRole?: 'radio';
    webRole?: React.AriaRole;
    tabIndex?: 0 | -1;

    containerStyle?: StyleProp<ViewStyle>;
    titleStyle?: StyleProp<TextStyle>;
    subtitleStyle?: StyleProp<TextStyle>;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 10,
        backgroundColor: 'transparent',
        borderWidth: RNStyleSheet.hairlineWidth || 1,
        borderColor: 'transparent',
    },
    rowSlim: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 0,
    },
    rowDefault: {
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    rowSelectable: {
        // Match historical CommandPalette look
        paddingHorizontal: 24,
        paddingVertical: 12,
        marginHorizontal: 8,
        marginVertical: 2,
        borderRadius: 8,
    },
    rowPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    rowHovered: {
        backgroundColor: theme.colors.surface.pressed,
    },
    rowSelected: {
        backgroundColor: theme.colors.surface.pressedOverlay,
        borderColor: theme.colors.border.strong,
    },
    // Palette variant states (match old CommandPaletteItem styles exactly)
    rowSelectablePressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    rowSelectableHovered: {
        backgroundColor: theme.dark ? theme.colors.surface.elevated : theme.colors.surface.inset,
    },
    rowDisabled: {
        opacity: 0.5,
    },
    left: {
        marginRight: 12,
        alignItems: 'center',
        justifyContent: 'center',
        // Optical, not geometric — see ICON_LABEL_OPTICAL_NUDGE_STYLE.
        ...ICON_LABEL_OPTICAL_NUDGE_STYLE,
    },
    content: {
        flex: 1,
        minWidth: 0,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        alignSelf: 'flex-start',
    },
    titleText: {
        flexGrow: 0,
        flexShrink: 1,
        minWidth: 0,
    },
    title: {
        ...Typography.default(),
        color: theme.colors.text.primary,
        fontSize: Platform.select({ ios: 16, default: 15 }),
        lineHeight: Platform.select({ ios: 20, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.2, default: 0 }),
    },
    titleSelectable: {
        color: theme.colors.text.primary,
        fontSize: 15,
        letterSpacing: -0.2,
    },
    titleDestructive: {
        color: theme.colors.state.danger.foreground,
    },
    subtitle: {
        ...Typography.default(),
        marginTop: 2,
        color: theme.colors.text.secondary,
        fontSize: Platform.select({ ios: 13, default: 13 }),
        lineHeight: 18,
    },
    subtitleSelectable: {
        color: theme.colors.text.secondary,
        letterSpacing: -0.1,
    },
    right: {
        marginLeft: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    accessoryTitleAligned: {
        alignSelf: 'flex-start',
        marginTop: 2,
    },
    splitPressable: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
    },
}));

export const SelectableRow = React.forwardRef<React.ElementRef<typeof Pressable>, SelectableRowProps>(function SelectableRow(props, ref) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [isHovered, setIsHovered] = React.useState(false);

    const variant: SelectableRowVariant = props.variant ?? 'default';
    const selected = Boolean(props.selected);
    const disabled = Boolean(props.disabled);
    const allowChildInteractionWhenDisabled = Boolean(props.allowChildInteractionWhenDisabled);

    const canHover = Platform.OS === 'web' && !disabled;

    const pressableProps: any = {};
    if (Platform.OS === 'web') {
        pressableProps.onMouseEnter = () => {
            if (!canHover) return;
            setIsHovered(true);
            props.onHover?.();
        };
        pressableProps.onMouseLeave = () => {
            if (!canHover) return;
            setIsHovered(false);
        };
        if (props.onMouseDownCapture) {
            pressableProps.onMouseDownCapture = props.onMouseDownCapture;
        }
    }

    const rowVariantStyle =
        variant === 'slim'
            ? styles.rowSlim
            : variant === 'selectable'
                ? styles.rowSelectable
                : styles.rowDefault;

    const titleColorStyle = props.destructive ? styles.titleDestructive : null;
    const titleVariantStyle = variant === 'selectable' ? styles.titleSelectable : null;
    const subtitleVariantStyle = variant === 'selectable' ? styles.subtitleSelectable : null;
    // A menu row's icon is one size whichever row kind the dropdown chose, and whatever list density
    // the user prefers. `SelectableRow` rows used to pass the call site's number straight through, so
    // the same DropdownMenu could show 16px icons on one menu and 24px on the next.
    const iconGlyphSize = MENU_ROW_METRICS.iconGlyphSizePx;
    const leftAccessory = React.useMemo(
        () => sizeRowIconForDensity(normalizeNodeForView(props.left ?? null), iconGlyphSize),
        [props.left, iconGlyphSize],
    );
    const rightAccessory = React.useMemo(() => normalizeNodeForView(props.right ?? null), [props.right]);
    const titleAccessory = React.useMemo(() => normalizeNodeForView(props.titleAccessory ?? null), [props.titleAccessory]);
    const accessoryTitleAlignmentStyle = props.subtitle ? styles.accessoryTitleAligned : null;
    const explicitWebRole = props.webRole ?? (props.accessibilityRole === 'radio' ? 'radio' : undefined);
    const webRole = Platform.OS === 'web' && props.onPress && (!disabled || explicitWebRole)
        ? (explicitWebRole ?? 'button')
        : undefined;
    const isRadio = props.accessibilityRole === 'radio' || webRole === 'radio';
    const accessibilityLabel = props.accessibilityLabel ?? (
        webRole ? buildActionRowAccessibilityLabel([props.title, props.subtitle]) : undefined
    );
    const accessibilityState = isRadio
        ? {
            checked: selected,
            ...(disabled ? { disabled: true } : {}),
        }
        : (disabled ? ({ disabled: true } as const) : undefined);
    const splitRightAccessory = Boolean(props.rightElementOutsidePressable && rightAccessory);
    const rowStyle = (pressed: boolean) => ([
        styles.row,
        rowVariantStyle,
        Platform.OS === 'web' && disabled ? ({ cursor: 'not-allowed' } as any) : null,
        pressed && !disabled
            ? (variant === 'selectable' ? styles.rowSelectablePressed : styles.rowPressed)
            : null,
        isHovered && !selected && !disabled
            ? (variant === 'selectable' ? styles.rowSelectableHovered : styles.rowHovered)
            : null,
        selected
            ? styles.rowSelected
            : null,
        disabled ? styles.rowDisabled : null,
        props.containerStyle,
    ]);
    const content = (includeRightAccessory: boolean) => (
        <>
            {leftAccessory ? (
                <View style={[styles.left, accessoryTitleAlignmentStyle, typeof props.leftGap === 'number' ? { marginRight: props.leftGap } : null]}>
                    {leftAccessory}
                </View>
            ) : null}

            <View style={styles.content}>
                {titleAccessory ? (
                    <View style={styles.titleRow}>
                        <Text style={[styles.title, styles.titleText, titleVariantStyle, titleColorStyle, props.titleStyle]} numberOfLines={1}>
                            {props.title}
                        </Text>
                        {titleAccessory}
                    </View>
                ) : (
                    <Text style={[styles.title, titleVariantStyle, titleColorStyle, props.titleStyle]} numberOfLines={1}>
                        {props.title}
                    </Text>
                )}
                {props.subtitle ? (
                    <Text style={[styles.subtitle, subtitleVariantStyle, props.subtitleStyle]} numberOfLines={2}>
                        {props.subtitle}
                    </Text>
                ) : null}
            </View>

            {includeRightAccessory && rightAccessory ? (
                <View style={[styles.right, accessoryTitleAlignmentStyle]}>
                    {rightAccessory}
                </View>
            ) : null}
        </>
    );
    const handleKeyDown = React.useCallback((event: unknown) => {
        props.onKeyDown?.(event);
    }, [props.onKeyDown]);
    const semanticProps = {
        ref,
        testID: props.testID,
        onPress: disabled ? undefined : props.onPress,
        onKeyDown: Platform.OS === 'web' && props.onKeyDown
            ? handleKeyDown
            : undefined,
        accessibilityState,
        accessibilityRole: Platform.OS === 'web' ? undefined : (props.accessibilityRole ?? (props.onPress ? 'button' : undefined)),
        accessibilityLabel,
        ...(webRole ? { role: webRole } : undefined),
        ...(isRadio && Platform.OS === 'web' ? { 'aria-checked': selected } : undefined),
        ...(Platform.OS === 'web' && props.tabIndex !== undefined ? { tabIndex: props.tabIndex } : undefined),
        pointerEvents: disabled && allowChildInteractionWhenDisabled ? 'box-none' : 'auto',
        ...pressableProps,
    };

    if (splitRightAccessory) {
        return (
            <View style={rowStyle(false)}>
                <Pressable
                    {...semanticProps}
                    style={({ pressed }) => [styles.splitPressable, pressed && !disabled ? { opacity: 0.72 } : null]}
                >
                    {content(false)}
                </Pressable>
                <View style={[styles.right, accessoryTitleAlignmentStyle]}>
                    {rightAccessory}
                </View>
            </View>
        );
    }

    return (
        <Pressable
            {...semanticProps}
            style={({ pressed }) => rowStyle(pressed)}
        >
            {content(true)}
        </Pressable>
    );
});
