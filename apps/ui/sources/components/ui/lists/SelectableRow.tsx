import * as React from 'react';
import { Platform, Pressable, View, StyleProp, ViewStyle, TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';


export type SelectableRowVariant = 'slim' | 'default' | 'selectable';

export type SelectableRowProps = Readonly<{
    testID?: string;
    title: React.ReactNode;
    titleAccessory?: React.ReactNode;
    subtitle?: React.ReactNode;
    left?: React.ReactNode;
    right?: React.ReactNode;
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
        borderWidth: 2,
        borderColor: 'transparent',
    },
    rowPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    rowHovered: {
        backgroundColor: theme.colors.surface.pressed,
    },
    rowSelected: {
        backgroundColor: theme.colors.surface.pressedOverlay,
        borderColor: theme.colors.border.default,
    },
    // Palette variant states (match old CommandPaletteItem styles exactly)
    rowSelectablePressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    rowSelectableHovered: {
        backgroundColor: theme.dark ? theme.colors.surface.elevated : theme.colors.surface.inset,
    },
    rowSelectableSelected: {
        backgroundColor: theme.colors.surface.selected,
        borderColor: theme.colors.accent.blue,
    },
    rowDisabled: {
        opacity: 0.5,
    },
    left: {
        marginRight: 12,
        alignItems: 'center',
        justifyContent: 'center',
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
}));

export function SelectableRow(props: SelectableRowProps) {
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
    const leftAccessory = React.useMemo(() => normalizeNodeForView(props.left ?? null), [props.left]);
    const rightAccessory = React.useMemo(() => normalizeNodeForView(props.right ?? null), [props.right]);
    const titleAccessory = React.useMemo(() => normalizeNodeForView(props.titleAccessory ?? null), [props.titleAccessory]);
    const accessoryTitleAlignmentStyle = props.subtitle ? styles.accessoryTitleAligned : null;

    return (
        <Pressable
            testID={props.testID}
            onPress={disabled ? undefined : props.onPress}
            accessibilityState={disabled ? ({ disabled: true } as const) : undefined}
            accessibilityRole={Platform.OS === 'web' ? undefined : (props.onPress ? 'button' : undefined)}
            pointerEvents={disabled && allowChildInteractionWhenDisabled ? 'box-none' : 'auto'}
            style={({ pressed }) => ([
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
                    ? (variant === 'selectable' ? styles.rowSelectableSelected : styles.rowSelected)
                    : null,
                disabled ? styles.rowDisabled : null,
                props.containerStyle,
            ])}
            {...pressableProps}
        >
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

            {rightAccessory ? (
                <View style={[styles.right, accessoryTitleAlignmentStyle]}>
                    {rightAccessory}
                </View>
            ) : null}
        </Pressable>
    );
}
