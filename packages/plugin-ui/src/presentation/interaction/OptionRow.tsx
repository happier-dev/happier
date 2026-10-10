import * as React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { HappierText } from '../text/Text.js';
import type { HappierFocusable, HappierStyleProp, HappierTextHostProps } from '../portableTypes.js';

export type HappierOptionRowStyles = Readonly<{
    left?: HappierStyleProp;
    content?: HappierStyleProp;
    titleRow?: HappierStyleProp;
    title?: HappierStyleProp;
    titleWithAccessories?: HappierStyleProp;
    subtitleRow?: HappierStyleProp;
    subtitle?: HappierStyleProp;
    right?: HappierStyleProp;
    accessoryTitleAligned?: HappierStyleProp;
    splitPressable?: HappierStyleProp;
}>;

export type HappierOptionRowControlProps = Readonly<{
    testID?: string;
    accessibilityLabel?: string;
    accessibilityRole?: 'button' | 'radio';
    accessibilityState?: Readonly<{ disabled?: boolean; selected?: boolean; checked?: boolean }>;
    role?: React.AriaRole;
    'aria-checked'?: boolean;
    'aria-pressed'?: boolean;
    tabIndex?: -1 | 0;
    pointerEvents?: 'box-none' | 'auto';
    focusable?: boolean;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
    onMouseDownCapture?: (event: unknown) => void;
    onKeyDown?: (event: unknown) => void;
}>;

// The same host component is RNW on web, where role accepts the full ARIA union.
// Keep that host-only extension here rather than narrowing the public control contract to native roles.
const OptionRowPressable = Pressable as React.ComponentType<
    Omit<React.ComponentProps<typeof Pressable>, 'role'> & Pick<HappierOptionRowControlProps, 'role'>
>;

/** Controlled option anatomy. Admission, option inventories, selection and theme paint belong to callers. */
export type HappierOptionRowProps = Readonly<{
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    titleLeading?: React.ReactNode;
    titleAccessory?: React.ReactNode;
    subtitleLeading?: React.ReactNode;
    left?: React.ReactNode;
    right?: React.ReactNode;
    leftGap?: number;
    rightElementOutsidePressable?: boolean;
    disabled?: boolean;
    onSelect?: () => void;
    controlProps?: HappierOptionRowControlProps;
    /** The incumbent adapter supplies exact themed styles; this anatomy does not choose another density. */
    styles: HappierOptionRowStyles;
    rowStyle: (pressed: boolean) => HappierStyleProp;
    splitPressOpacity: number;
    /** A host can retain its text binding; unhosted presentation uses the public text owner. */
    textComponent?: React.ComponentType<Pick<HappierTextHostProps, 'children' | 'style' | 'numberOfLines'>>;
}>;

export const HappierOptionRow = React.forwardRef<HappierFocusable, HappierOptionRowProps>(function HappierOptionRow(props, ref) {
    const Text = props.textComponent ?? HappierText;
    const { styles } = props;
    const bindRef = React.useCallback((node: React.ElementRef<typeof Pressable> | null) => {
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
    }, [ref]);
    const aligned = props.subtitle ? styles.accessoryTitleAligned : null;
    const content = (includeRight: boolean) => <>
        {props.left ? <View style={[styles.left, aligned, typeof props.leftGap === 'number' ? { marginRight: props.leftGap } : null]}>{props.left}</View> : null}
        <View style={styles.content}>
            {props.titleAccessory || props.titleLeading ? <View style={styles.titleRow}>
                {props.titleLeading}
                <Text style={styles.titleWithAccessories} numberOfLines={1}>{props.title}</Text>
                {props.titleAccessory}
            </View> : <Text style={styles.title} numberOfLines={1}>{props.title}</Text>}
            {props.subtitle ? <View style={styles.subtitleRow}>{props.subtitleLeading}<Text style={styles.subtitle} numberOfLines={2}>{props.subtitle}</Text></View> : null}
        </View>
        {includeRight && props.right ? <View style={[styles.right, aligned]}>{props.right}</View> : null}
    </>;
    const control = { ...props.controlProps, ref: bindRef, disabled: props.disabled, onPress: props.disabled ? undefined : props.onSelect };
    if (props.rightElementOutsidePressable && props.right) return <View style={props.rowStyle(false) as StyleProp<ViewStyle>}>
        <OptionRowPressable {...control} style={({ pressed }) => [styles.splitPressable, pressed && !props.disabled ? { opacity: props.splitPressOpacity } : null]}>{content(false)}</OptionRowPressable>
        <View style={styles.right}>{props.right}</View>
    </View>;
    return <OptionRowPressable {...control} style={({ pressed }) => props.rowStyle(pressed) as StyleProp<ViewStyle>}>{content(true)}</OptionRowPressable>;
});
