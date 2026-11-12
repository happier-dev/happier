import * as React from 'react';
import { Platform, Pressable, StyleProp, ViewStyle, TextStyle, StyleSheet as RNStyleSheet } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { MENU_ROW_METRICS, MENU_ROW_SHAPE, MENU_ROW_TRAILING } from '@/components/ui/lists/itemDensityMetrics';
import { HAPPIER_MENU_ROW_TEXT } from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { buildActionRowAccessibilityLabel } from './actionRowAccessibility';
import { ICON_LABEL_OPTICAL_NUDGE_STYLE } from '@/components/ui/icons/iconOpticalAlignment';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { ITEM_TITLE_MAX_LINES_WITHOUT_SUBTITLE } from './itemTextClamp';
import { HappierOptionRow, useHappierMaterialColorResolver, type HappierFocusable, type HappierOptionRowControlProps, type HappierStyleProp } from '@happier-dev/plugin-ui/presentation';


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
    titleLeading?: React.ReactNode;
    titleAccessory?: React.ReactNode;
    subtitle?: React.ReactNode;
    /** A status mark drawn before the subtitle on its line (a dot, a warning glyph), as `Item` does. */
    subtitleLeading?: React.ReactNode;
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
    /**
     * `menu`: a row of a floating menu (dropdown, action list). Whatever the variant's density, its
     * highlight is the menu's inset rounded fill (`MENU_ROW_SHAPE`), never an outline.
     */
    presentation?: 'menu';
    onPress?: () => void;
    onHover?: () => void;
    onMouseDownCapture?: (event: unknown) => void;
    onKeyDown?: (event: unknown) => void;
    accessibilityLabel?: string;
    /** A checked choice: `radio` among siblings, `checkbox` for a lone on/off row. */
    accessibilityRole?: 'radio' | 'checkbox';
    /** Overrides the checked state without changing the visual keyboard highlight. */
    accessibilityChecked?: boolean;
    /**
     * Exposes an applied choice while retaining button activation semantics.
     * Native accessibility uses `selected`; web uses the valid toggle-button
     * equivalent, `aria-pressed`, because `aria-selected` is invalid on a button.
     */
    accessibilityButtonSelected?: boolean;
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
        // A row: the `md` step of the one radius base.
        borderRadius: theme.borderRadius.md,
        backgroundColor: 'transparent',
        borderWidth: RNStyleSheet.hairlineWidth || 1,
        borderColor: 'transparent',
    },
    rowSlim: {
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s8,
        borderRadius: 0,
    },
    rowDefault: {
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s10,
    },
    rowSelectable: {
        // Match historical CommandPalette look
        paddingHorizontal: theme.space.s24,
        paddingVertical: theme.space.s12,
        marginHorizontal: theme.space.s8,
        marginVertical: theme.space.s2,
        borderRadius: theme.borderRadius.md,
    },
    rowPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    rowHovered: {
        backgroundColor: theme.colors.surface.hover,
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
    rowMenu: {
        alignSelf: 'stretch',
        // Whatever row variant a menu picks, its highlight is the menu's inset rounded fill (MENU_ROW_SHAPE).
        ...MENU_ROW_SHAPE,
        marginVertical: 0,
        borderWidth: 0,
    },
    rowMenuSelected: {
        backgroundColor: theme.colors.surface.selected,
    },
    left: {
        marginRight: theme.space.s12,
        alignItems: 'center',
        justifyContent: 'center',
        // Optical, not geometric — see ICON_LABEL_OPTICAL_NUDGE_STYLE.
        ...ICON_LABEL_OPTICAL_NUDGE_STYLE,
    },
    // A menu row's leading column is one width, so every title of a menu starts on one edge: a glyph sits centred
    // in it and an identity mark (`MENU_ROW_METRICS.identityMarkPx`) overhangs it evenly instead of widening it.
    leftMenu: {
        width: MENU_ROW_METRICS.iconBoxSizePx,
        marginRight: MENU_ROW_METRICS.iconMarginRightPx,
    },
    content: {
        flex: 1,
        minWidth: 0,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minWidth: 0,
        width: '100%',
        alignSelf: 'stretch',
    },
    titleText: {
        flexGrow: 0,
        flexShrink: 1,
        minWidth: 0,
    },
    // The one menu row type, shared with plugin menus (`HAPPIER_MENU_ROW_TEXT`).
    title: {
        ...Typography.default(),
        color: theme.colors.text.primary,
        fontSize: HAPPIER_MENU_ROW_TEXT.label.fontSize,
        lineHeight: HAPPIER_MENU_ROW_TEXT.label.lineHeight,
        letterSpacing: HAPPIER_MENU_ROW_TEXT.label.letterSpacing,
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
        flexShrink: 1,
        color: theme.colors.text.secondary,
        fontSize: HAPPIER_MENU_ROW_TEXT.subtitle.fontSize,
        lineHeight: HAPPIER_MENU_ROW_TEXT.subtitle.lineHeight,
    },
    subtitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        marginTop: MENU_ROW_METRICS.subtitleGapPx,
        minWidth: 0,
    },
    subtitleSelectable: {
        color: theme.colors.text.secondary,
        letterSpacing: -0.1,
    },
    right: {
        marginLeft: theme.space.s12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    accessoryTitleAligned: {
        alignSelf: 'flex-start',
        marginTop: theme.space.s2,
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
    const paintColor = useHappierMaterialColorResolver();
    const styles = stylesheet;
    const [isHovered, setIsHovered] = React.useState(false);

    const variant: SelectableRowVariant = props.variant ?? 'default';
    const isMenu = props.presentation === 'menu';
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
    const titleLeading = React.useMemo(() => normalizeNodeForView(props.titleLeading ?? null), [props.titleLeading]);
    const subtitleLeading = React.useMemo(() => normalizeNodeForView(props.subtitleLeading ?? null), [props.subtitleLeading]);
    const explicitWebRole = props.webRole ?? props.accessibilityRole;
    const webRole = Platform.OS === 'web' && props.onPress && (!disabled || explicitWebRole)
        ? (explicitWebRole ?? 'button')
        : undefined;
    const isRadio = props.accessibilityRole !== undefined || webRole === 'radio' || webRole === 'checkbox';
    const accessibilityLabel = props.accessibilityLabel ?? (
        webRole ? buildActionRowAccessibilityLabel([props.title, props.subtitle]) : undefined
    );
    const accessibilityState = isRadio
        ? {
            checked: props.accessibilityChecked ?? selected,
            ...(disabled ? { disabled: true } : {}),
        }
        : props.accessibilityButtonSelected !== undefined
            ? {
                selected: props.accessibilityButtonSelected,
                ...(disabled ? { disabled: true } : {}),
            }
        : (disabled ? ({ disabled: true } as const) : undefined);
    // Retain the native adapter's registered style binding and web-only paint.
    const rowStyle = (pressed: boolean) => ([
        styles.row,
        rowVariantStyle,
        Platform.OS === 'web' && disabled ? ({ cursor: 'not-allowed' } satisfies React.CSSProperties) : null,
        pressed && !disabled
            ? (variant === 'selectable' ? styles.rowSelectablePressed : styles.rowPressed)
            : null,
        isHovered && !selected && !disabled
            ? (variant === 'selectable' ? styles.rowSelectableHovered : styles.rowHovered)
            : null,
        selected
            ? (isMenu ? styles.rowMenuSelected : styles.rowSelected)
            : null,
        selected ? { backgroundColor: paintColor(isMenu ? theme.colors.surface.selected : theme.colors.surface.pressedOverlay) }
            : isHovered && !disabled ? { backgroundColor: paintColor(variant === 'selectable' ? (theme.dark ? theme.colors.surface.elevated : theme.colors.surface.inset) : theme.colors.surface.hover) }
                : pressed && !disabled ? { backgroundColor: paintColor(theme.colors.surface.pressed) } : null,
        disabled ? styles.rowDisabled : null,
        isMenu ? styles.rowMenu : null,
        props.containerStyle,
    ]) as HappierStyleProp;
    const handleKeyDown = React.useCallback((event: unknown) => {
        props.onKeyDown?.(event);
    }, [props.onKeyDown]);
    const semanticProps: HappierOptionRowControlProps = {
        testID: props.testID,
        onKeyDown: Platform.OS === 'web' && props.onKeyDown
            ? handleKeyDown
            : undefined,
        accessibilityState,
        accessibilityRole: Platform.OS === 'web' ? undefined : (props.accessibilityRole ?? (props.onPress ? 'button' : undefined)),
        accessibilityLabel,
        ...(webRole ? { role: webRole } : undefined),
        ...(isRadio && Platform.OS === 'web' ? { 'aria-checked': props.accessibilityChecked ?? selected } : undefined),
        ...(Platform.OS === 'web' && props.accessibilityButtonSelected !== undefined
            ? { 'aria-pressed': props.accessibilityButtonSelected }
            : undefined),
        ...(Platform.OS === 'web' && props.tabIndex !== undefined ? { tabIndex: props.tabIndex } : undefined),
        pointerEvents: disabled && allowChildInteractionWhenDisabled ? 'box-none' : 'auto',
        // A row with no action is content, not a control: never a tab stop that does nothing.
        ...(props.onPress ? undefined : { focusable: false }),
        ...pressableProps,
    };

    return <HappierOptionRow
        ref={ref as React.Ref<HappierFocusable>}
        title={props.title}
        subtitle={props.subtitle}
        // A menu has no other place to read the rest of a choice's description (a
        // permission mode's risk, a disabled action's recovery), so it wraps.
        subtitleLines={isMenu ? 0 : undefined}
        // Its title wraps like a grouped row's (a narrow phone menu beside a pin read "Workflo…").
        titleLines={isMenu ? ITEM_TITLE_MAX_LINES_WITHOUT_SUBTITLE : undefined}
        titleLeading={titleLeading}
        titleAccessory={titleAccessory}
        subtitleLeading={subtitleLeading}
        left={leftAccessory}
        right={rightAccessory}
        leftGap={props.leftGap}
        rightElementOutsidePressable={props.rightElementOutsidePressable}
        disabled={disabled}
        onSelect={props.onPress}
        controlProps={semanticProps}
        textComponent={Text}
        rowStyle={rowStyle}
        splitPressOpacity={motionTokens.press.opacity}
        styles={{
            ...styles,
            left: isMenu ? [styles.left, styles.leftMenu] as HappierStyleProp : styles.left,
            // A menu row's trailing controls sit on its one line and never grow it (MENU_ROW_TRAILING).
            right: isMenu ? [styles.right, MENU_ROW_TRAILING] as HappierStyleProp : styles.right,
            // The native adapter retains its exact style binding (including registered RN styles).
            title: [styles.title, titleVariantStyle, titleColorStyle, props.titleStyle] as HappierStyleProp,
            titleWithAccessories: [styles.title, styles.titleText, titleVariantStyle, titleColorStyle, props.titleStyle] as HappierStyleProp,
            subtitle: [styles.subtitle, subtitleVariantStyle, props.subtitleStyle] as HappierStyleProp,
        }}
    />;
});
