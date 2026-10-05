import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** Below this width the paths sit above the pane as a row of chips instead of a column beside it. */
const SIDE_BY_SIDE_MIN_WIDTH_PX = 600;
const PATH_COLUMN_WIDTH_PX = 264;

export type SetupPath<T extends string> = Readonly<{
    id: T;
    /** A plain glyph or identity mark: nothing behind it. */
    glyph: React.ReactNode;
    title: string;
    subtitle: string;
    /** A shorter label for the narrow chip row. */
    chipLabel?: string;
}>;

/**
 * An opened set-up block that offers several ways to do one thing (add a machine, sign in to Homes you
 * already use): the ways stay listed — a column on the left, or a row of chips when narrow — so
 * switching is one press and none hides behind another, and the chosen way is the pane. It is the
 * content of Get set up's in-place morph (`SetupBlockGrid`), which owns the frame, the growth and Esc.
 */
export function SetupPathPanel<T extends string>(props: Readonly<{
    testID: string;
    title: string;
    paths: ReadonlyArray<SetupPath<T>>;
    active: T;
    onChoose: (id: T) => void;
    pane: React.ReactNode;
    /** Under the column when side by side (a quieter related action); hidden in the chip layout. */
    foot?: React.ReactNode;
    onClose: () => void;
}>) {
    const styles = stylesheet;
    const [width, setWidth] = React.useState<number | null>(null);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = event.nativeEvent.layout.width;
        if (Number.isFinite(next) && next > 0) setWidth((current) => (current === next ? current : next));
    }, []);
    const sideBySide = width === null || width >= SIDE_BY_SIDE_MIN_WIDTH_PX;
    const { onChoose } = props;

    return (
        <View
            testID={props.testID}
            accessibilityLabel={props.title}
            onLayout={onLayout}
            style={[styles.panel, sideBySide ? styles.panelSideBySide : null]}
        >
            {sideBySide ? (
                <View style={styles.column}>
                    <Text accessibilityRole="header" style={styles.columnTitle}>{props.title}</Text>
                    <View accessibilityRole="tablist">
                        {props.paths.map((path) => {
                            const selected = path.id === props.active;
                            return (
                                <HappierPressable
                                    key={path.id}
                                    testID={`${props.testID}.path.${path.id}`}
                                    accessibilityRole="tab"
                                    selected={selected}
                                    onPress={() => onChoose(path.id)}
                                    style={({ hovered }) => [
                                        styles.path,
                                        selected ? styles.pathSelected : hovered ? styles.pathHovered : null,
                                    ]}
                                >
                                    <View style={styles.pathGlyph}>{path.glyph}</View>
                                    <View style={styles.pathCopy}>
                                        <Text style={styles.pathTitle}>{path.title}</Text>
                                        <Text style={styles.pathSubtitle}>{path.subtitle}</Text>
                                    </View>
                                </HappierPressable>
                            );
                        })}
                    </View>
                    {props.foot ? <View style={styles.foot}>{props.foot}</View> : null}
                </View>
            ) : (
                <View style={styles.top}>
                    <Text accessibilityRole="header" style={styles.topTitle}>{props.title}</Text>
                    <View accessibilityRole="tablist" style={styles.chips}>
                        {props.paths.map((path) => {
                            const selected = path.id === props.active;
                            return (
                                <HappierPressable
                                    key={path.id}
                                    testID={`${props.testID}.path.${path.id}`}
                                    accessibilityRole="tab"
                                    selected={selected}
                                    onPress={() => onChoose(path.id)}
                                    style={({ hovered }) => [
                                        styles.chip,
                                        selected ? styles.chipSelected : hovered ? styles.chipHovered : null,
                                    ]}
                                >
                                    {path.glyph}
                                    <Text style={[styles.chipLabel, selected ? styles.chipLabelSelected : null]} numberOfLines={1}>
                                        {path.chipLabel ?? path.title}
                                    </Text>
                                </HappierPressable>
                            );
                        })}
                    </View>
                </View>
            )}
            <View style={[styles.pane, sideBySide ? styles.paneSide : null]}>{props.pane}</View>
            <View style={styles.close}>
                <IconButton
                    testID={`${props.testID}.close`}
                    iconName="x"
                    variant="plain"
                    size={24}
                    iconSize={13}
                    accessibilityLabel={t('common.close')}
                    tooltip={t('common.close')}
                    onPress={props.onClose}
                />
            </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    panel: {
        minHeight: 330,
    },
    panelSideBySide: {
        flexDirection: 'row',
    },
    column: {
        width: PATH_COLUMN_WIDTH_PX,
        gap: 2,
        paddingVertical: 16,
        paddingHorizontal: 10,
        backgroundColor: theme.colors.surface.sectionTint,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderRightColor: theme.colors.border.default,
    },
    columnTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.primary,
        paddingHorizontal: 8,
        marginBottom: 10,
    },
    path: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        paddingVertical: 9,
        paddingHorizontal: 10,
        borderRadius: 10,
    },
    pathSelected: {
        backgroundColor: theme.colors.surface.selected,
    },
    pathHovered: {
        backgroundColor: theme.colors.surface.pressed,
    },
    pathGlyph: {
        width: 20,
        height: 20,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 1,
    },
    pathCopy: {
        flex: 1,
        minWidth: 0,
    },
    pathTitle: {
        ...Typography.default('medium'),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.primary,
    },
    pathSubtitle: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
        marginTop: 1,
    },
    foot: {
        marginTop: 'auto',
        paddingTop: 12,
        paddingHorizontal: 8,
    },
    top: {
        gap: 12,
        paddingTop: 18,
        paddingHorizontal: 18,
        paddingRight: 48,
    },
    topTitle: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        lineHeight: 22,
        color: theme.colors.text.primary,
    },
    chips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 32,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    chipSelected: {
        borderColor: theme.colors.text.primary,
    },
    chipHovered: {
        backgroundColor: theme.colors.surface.pressed,
    },
    chipLabel: {
        ...Typography.default('medium'),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    chipLabelSelected: {
        color: theme.colors.text.primary,
    },
    pane: {
        paddingVertical: 20,
        paddingHorizontal: 24,
        minWidth: 0,
    },
    paneSide: {
        flex: 1,
    },
    close: {
        position: 'absolute',
        top: 12,
        right: 12,
    },
}));
