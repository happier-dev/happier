import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * The one row inside a widget body (lab `ai`, `.fact`, `.pj-cr`): a mark, a label with an optional
 * short tag, an optional quiet fact line beneath, and one trailing element. Checkouts, About, Local
 * changes and the Session companion draw their rows with it, so a glance reads the same wherever it
 * is placed. A row that leads somewhere is one pressable; a row with its own control (Push) is not.
 */
export const WidgetGlanceRow = React.memo(function WidgetGlanceRow(props: Readonly<{
    testID?: string;
    /** The row's mark: a glyph, or an element (a brand mark, a spinner). It stands alone, never on a tile. */
    mark?: IconName | React.ReactElement | null;
    title: string;
    /** `fact` draws the label as a quiet one-line statement (About); `row` is a thing with a name. */
    variant?: 'row' | 'fact';
    /** A short tag on the label's line ("Here"). */
    tag?: string | null;
    /** The second line: where it is and what is happening there. */
    fact?: string | null;
    /** `attention`: the fact needs the person (amber). Healthy state stays quiet. */
    factTone?: 'quiet' | 'attention';
    /** The label is a path, id or ref: drawn in the mono face. */
    mono?: boolean;
    trailing?: React.ReactNode;
    /** Last-known while its machine is away. */
    dimmed?: boolean;
    onPress?: (() => void) | null;
    accessibilityLabel?: string;
}>) {
    const { theme } = useUnistyles();
    const variant = props.variant ?? 'row';
    const mark = typeof props.mark === 'string'
        ? <Icon name={props.mark} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
        : props.mark ?? null;
    const content = (
        <>
            {props.mark !== undefined ? <View style={styles.mark}>{mark}</View> : null}
            <View style={styles.text}>
                <View style={styles.titleLine}>
                    <Text numberOfLines={1} style={[variant === 'fact' ? styles.factTitle : styles.title, props.mono ? styles.mono : null]}>
                        {props.title}
                    </Text>
                    {props.tag ? <Text numberOfLines={1} style={styles.tag}>{props.tag}</Text> : null}
                </View>
                {props.fact ? (
                    <Text numberOfLines={1} style={[styles.fact, props.factTone === 'attention' ? styles.factAttention : null]}>
                        {props.fact}
                    </Text>
                ) : null}
            </View>
            {props.trailing ?? null}
        </>
    );
    const rowStyle = [variant === 'fact' ? styles.factRow : styles.row, props.dimmed ? styles.dimmed : null];
    if (!props.onPress) {
        return <View testID={props.testID} style={rowStyle}>{content}</View>;
    }
    return (
        <HappierPressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel ?? [props.title, props.tag, props.fact].filter(Boolean).join(', ')}
            onPress={props.onPress}
            style={(state) => [
                rowStyle,
                styles.pressable,
                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                state.pressed || state.hovered ? { backgroundColor: theme.colors.surface.pressed } : null,
            ]}
        >
            {content}
        </HappierPressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    row: {
        minHeight: 40,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minWidth: 0,
    },
    factRow: {
        minHeight: 28,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minWidth: 0,
    },
    // The hover wash reaches past the text to the frame's inset; the text keeps its column.
    pressable: {
        marginHorizontal: -8,
        paddingHorizontal: 8,
        borderRadius: 8,
    },
    dimmed: {
        opacity: 0.6,
    },
    mark: {
        width: ICON_SIZE.sm,
        alignItems: 'center',
        justifyContent: 'center',
    },
    text: {
        flex: 1,
        minWidth: 0,
    },
    titleLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
    },
    title: {
        ...Typography.rowTitle(),
        color: theme.colors.text.primary,
        flexShrink: 1,
        minWidth: 0,
    },
    factTitle: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
        flexShrink: 1,
        minWidth: 0,
    },
    mono: {
        ...Typography.mono(),
    },
    tag: {
        ...Typography.rowMeta(),
        color: theme.colors.text.tertiary,
        flexShrink: 0,
    },
    fact: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    factAttention: {
        color: theme.colors.state.warning.foreground,
    },
}));
