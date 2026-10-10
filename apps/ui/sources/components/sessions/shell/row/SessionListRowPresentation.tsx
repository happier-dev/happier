import * as React from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { resolveHappierWorkStatusSurfaceStyle, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { Text, type AppTextProps } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { WorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { projectWorkColors } from '@/components/work/status/workStatusTreatment';

import {
    SESSION_LIST_ROW_CORNER_RADIUS,
    SESSION_LIST_ROW_IDENTITY_METRICS,
    SESSION_LIST_ROW_SELECTION_RADIUS,
    SESSION_LIST_ROW_TITLE_TEXT_METRICS,
    type SessionListRowDensity,
} from '../resolveSessionListDensityViewState';
import {
    SESSION_LIST_ROW_HEIGHT_COMPACT,
    SESSION_LIST_ROW_HEIGHT_DEFAULT,
    SESSION_LIST_ROW_HEIGHT_MINIMAL,
    SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_PHONE,
} from '../sessionListRowHeights';


type RowDensityProps = Readonly<{
    density: SessionListRowDensity;
    readableNativePhoneMinimal?: boolean;
    textScale?: number;
}>;

const styles = StyleSheet.create((theme) => ({
    row: {
        height: SESSION_LIST_ROW_HEIGHT_DEFAULT,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 15,
        backgroundColor: theme.colors.surface.base,
        borderLeftWidth: 2,
        borderRightWidth: 2,
        borderColor: theme.colors.surface.base,
    },
    first: {
        borderTopLeftRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderTopRightRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderTopWidth: 2,
    },
    last: {
        borderBottomLeftRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderBottomRightRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderBottomWidth: 2,
    },
    separator: { borderBottomWidth: 1, borderBottomColor: theme.colors.border.default },
    compact: { height: SESSION_LIST_ROW_HEIGHT_COMPACT, paddingHorizontal: 13 },
    minimal: { height: SESSION_LIST_ROW_HEIGHT_MINIMAL, paddingHorizontal: 8 },
    minimalNativePhone: { height: SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_PHONE },
    // The open row is a rounded fill inside its group's sheet, the sheet's paper showing around it.
    selected: {
        backgroundColor: theme.colors.surface.selected,
        borderColor: theme.colors.surface.base,
        borderRadius: SESSION_LIST_ROW_SELECTION_RADIUS,
    },
    attention: {
        ...resolveHappierWorkStatusSurfaceStyle('attention', projectWorkColors(theme)),
        backgroundColor: theme.colors.state.warning.background,
    },
    danger: {
        ...resolveHappierWorkStatusSurfaceStyle('danger', projectWorkColors(theme)),
        backgroundColor: theme.colors.state.danger.background,
    },
    identity: {
        position: 'relative',
        width: SESSION_LIST_ROW_IDENTITY_METRICS.default.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.default.slotSize,
        alignItems: 'center',
        justifyContent: 'center',
    },
    identityCompact: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize,
    },
    identityMinimal: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.minimal.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.minimal.slotSize,
    },
    identityMinimalNativePhone: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.minimalNativePhone.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.minimalNativePhone.slotSize,
    },
    content: { flex: 1, marginLeft: 14, justifyContent: 'center' },
    contentCompact: { marginLeft: 12 },
    contentMinimal: { marginLeft: 0 },
    contentMinimalWithIdentity: { marginLeft: 8 },
    titleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 1, gap: 6 },
    title: {
        ...SESSION_LIST_ROW_TITLE_TEXT_METRICS.default,
        flex: 1,
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
    titleCompact: SESSION_LIST_ROW_TITLE_TEXT_METRICS.compact,
    titleMinimal: SESSION_LIST_ROW_TITLE_TEXT_METRICS.minimal,
    titleMinimalNativePhone: SESSION_LIST_ROW_TITLE_TEXT_METRICS.minimalNativePhone,
    emphasized: { ...Typography.default('semiBold') },
    subtitle: { fontSize: 12, color: theme.colors.text.secondary, lineHeight: 16, ...Typography.default() },
    subtitleCompact: { fontSize: 11, lineHeight: 14 },
    subtitleMinimal: { fontSize: 10, lineHeight: 12 },
    trailing: { marginLeft: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
    // The row's press target: everything left of the trailing slot, the row's full height.
    pressTarget: { flex: 1, minWidth: 0, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center' },
}));

/** The real row's geometry, with no session, settings, activity or action subscriptions. */
export function SessionListRowPresentation(props: RowDensityProps & Readonly<{
    first?: boolean;
    last?: boolean;
    selected?: boolean;
    separator?: boolean;
    statusTone?: WorkStatusTone;
    identity?: React.ReactNode;
    title: React.ReactNode;
    children?: React.ReactNode;
    trailing?: React.ReactNode;
    trailingProps?: Omit<ViewProps, 'style' | 'children'>;
    /**
     * The live row supplies its Pressable as the press target for the identity and text; static
     * previews use a View. The trailing slot is its sibling, never its child: on the web a button
     * role renders a `<button>`, and the trailing actions (tag, pin, ⋯) are buttons of their own.
     */
    renderContainer?: (content: React.ReactNode, style: StyleProp<ViewStyle>) => React.ReactElement;
    /** Measures the whole row (the trailing slot included). */
    onLayout?: (event: LayoutChangeEvent) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const selected = props.selected === true;
    const danger = props.statusTone === 'danger';
    const attention = props.statusTone === 'attention';
    const baseColor = danger ? theme.colors.state.danger.background : attention ? theme.colors.state.warning.background : selected ? theme.colors.surface.selected : theme.colors.surface.base;
    const compact = props.density !== 'default';
    const minimal = props.density === 'minimal';
    const textScale = typeof props.textScale === 'number' && Number.isFinite(props.textScale)
        ? Math.max(1, props.textScale)
        : 1;
    const largeText = textScale > 1.1;
    const baseRowHeight = props.density === 'default'
        ? SESSION_LIST_ROW_HEIGHT_DEFAULT
        : props.density === 'minimal'
            ? SESSION_LIST_ROW_HEIGHT_MINIMAL
            : SESSION_LIST_ROW_HEIGHT_COMPACT;
    const scaledRowHeight = largeText ? Math.ceil(baseRowHeight * Math.min(textScale, 2.5)) : baseRowHeight;
    const hasIdentity = props.identity != null;
    const rowStyle = [
        styles.row,
        props.first ? styles.first : null,
        props.last ? styles.last : null,
        compact ? styles.compact : null,
        minimal ? styles.minimal : null,
        props.readableNativePhoneMinimal ? styles.minimalNativePhone : null,
        props.selected ? styles.selected : null,
        props.separator ? styles.separator : null,
        // Keep the incumbent geometry at normal scale. Large text may grow so the
        // title and context remain readable instead of being clipped by a fixed height.
        largeText ? { minHeight: scaledRowHeight, height: undefined } : null,
        props.statusTone === 'attention' ? styles.attention : props.statusTone === 'danger' ? styles.danger : null,
        {
            backgroundColor: materialColor(baseColor, danger || attention || selected ? baseColor : 'transparent'),
            ...(!danger && !attention ? { borderColor: materialColor(theme.colors.surface.base, 'transparent') } : null),
        },
    ];
    const pressContent = <>
        {hasIdentity ? <View style={[
            styles.identity,
            compact ? styles.identityCompact : null,
            minimal ? styles.identityMinimal : null,
            props.readableNativePhoneMinimal ? styles.identityMinimalNativePhone : null,
        ]}>{props.identity}</View> : null}
        <View style={[
            styles.content,
            compact ? styles.contentCompact : null,
            minimal ? styles.contentMinimal : null,
            minimal && hasIdentity ? styles.contentMinimalWithIdentity : null,
        ]}>
            <View style={styles.titleRow}>{props.title}</View>
            {props.children}
        </View>
    </>;
    const trailing = <View {...props.trailingProps} style={styles.trailing}>{props.trailing}</View>;
    return (
        <View style={rowStyle} onLayout={props.onLayout}>
            {props.renderContainer ? props.renderContainer(pressContent, styles.pressTarget) : pressContent}
            {trailing}
        </View>
    );
}

export function SessionListRowTitle({ density, readableNativePhoneMinimal, textScale, emphasized, color, style, ...props }:
    RowDensityProps & AppTextProps & Readonly<{ emphasized?: boolean; color?: string }>): React.ReactElement {
    return <Text {...props} numberOfLines={textScale && textScale > 1.1 ? 2 : 1} style={[
        styles.title,
        density !== 'default' ? styles.titleCompact : null,
        density === 'minimal' ? styles.titleMinimal : null,
        readableNativePhoneMinimal ? styles.titleMinimalNativePhone : null,
        emphasized ? styles.emphasized : null,
        color ? { color } : null,
        style,
    ]} />;
}

export function SessionListRowSubtitle({ density, textScale, style, ...props }:
    RowDensityProps & AppTextProps): React.ReactElement {
    return <Text {...props} numberOfLines={textScale && textScale > 1.1 ? 2 : 1} style={[
        styles.subtitle,
        density !== 'default' ? styles.subtitleCompact : null,
        density === 'minimal' ? styles.subtitleMinimal : null,
        style,
    ]} />;
}
