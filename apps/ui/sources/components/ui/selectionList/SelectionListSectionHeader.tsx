import * as React from 'react';
import { View, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * R6 — Premium UI design polish (Fix 1): a lighter, command-bar-style section
 * header used for SelectionList sections on web. Replaces the heavy `ItemGroup`
 * chrome (background card + 32pt padded title bar) that gave the picker a
 * settings-list feel.
 *
 * Visual contract:
 *  - Web: a flat label rendered with a thin top border so consecutive sections
 *    read as a continuous command-bar list.
 *  - Native: keeps the iOS-style padding/typography that `ItemGroup` already
 *    provides (we render the same shape but without the surface card around
 *    rows; the orchestrator owns row chrome).
 *
 * The component is presentational: it doesn't own selection state, dividers
 * between rows, or any interactivity. It is rendered by `SelectionList.tsx`
 * directly above the option rows for non-virtualized sections, and by the
 * virtualized section helper above the FlashList host.
 */
export type SelectionListSectionHeaderProps = Readonly<{
    /** Section title (rendered as uppercase eyebrow text). May be undefined. */
    title?: string;
    /**
     * Optional count rendered to the right of the title with tabular-nums so
     * width stays stable as numbers tick.
     */
    count?: number;
    /** Stable testID anchor (e.g. `<sectionTestId>:header`). */
    testID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        // R13 (Fix 4): drop the full-width 1pt top border that R6 used. The
        // command-bar surface reads as a continuous list without an explicit
        // divider — section grouping comes from typography + vertical rhythm.
        ...(Platform.select({
            web: {
                paddingHorizontal: 16,
                paddingTop: 10,
                paddingBottom: 4,
            },
            default: {
                paddingHorizontal: 16,
                paddingTop: Platform.select({ ios: 16, default: 14 }),
                paddingBottom: Platform.select({ ios: 6, default: 6 }),
            },
        }) as object),
    },
    label: {
        flex: 1,
        // R13 (Fix 4): use the most muted text token so the eyebrow recedes
        // visually below option rows. R6 used `text.secondary`.
        color: theme.colors.text.tertiary,
        // Keep app-wide uppercase eyebrow text without extra letter spacing,
        // so section labels align with the rest of the app without reverting
        // to the heavier settings-list group title treatment.
        fontSize: Platform.select({ ios: 13, default: 11 }),
        lineHeight: Platform.select({ ios: 16, default: 14 }),
    },
    count: {
        color: theme.colors.text.tertiary,
        fontSize: Platform.select({ ios: 13, default: 11 }),
        lineHeight: Platform.select({ ios: 16, default: 14 }),
        marginLeft: 8,
    },
}));

/**
 * Render a SelectionList section header. Intentionally tiny: only paints
 * typography + the optional count accessory. Empty titles render nothing.
 */
export function SelectionListSectionHeader(
    props: SelectionListSectionHeaderProps,
): React.ReactElement | null {
    const styles = stylesheet;
    if (props.title === undefined || props.title.length === 0) return null;
    const title = props.title.toLocaleUpperCase();
    return (
        <View testID={props.testID} style={styles.container}>
            <Text style={styles.label}>{title}</Text>
            {typeof props.count === 'number' ? (
                <Text style={[styles.count, Typography.tabular()]}>{String(props.count)}</Text>
            ) : null}
        </View>
    );
}
