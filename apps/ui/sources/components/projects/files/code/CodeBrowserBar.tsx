import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierBreadcrumb, HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { KeyboardCommandHint } from '@/components/ui/keyboard/KeyHint';

import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** One step of a Code location: the root (the project's name) or a folder/file under it. */
export type CodeBreadcrumbSegment = Readonly<{ path: string; label: string }>;

/** `apps/ui/sources` → root, `apps`, `apps/ui`, `apps/ui/sources`. */
export function buildCodeBreadcrumbSegments(rootLabel: string, path: string): CodeBreadcrumbSegment[] {
    const parts = path.split('/').filter((part) => part.length > 0);
    const segments: CodeBreadcrumbSegment[] = [{ path: '', label: rootLabel }];
    parts.forEach((part, index) => {
        segments.push({ path: parts.slice(0, index + 1).join('/'), label: part });
    });
    return segments;
}

/**
 * The line above a Code folder or file (lab p-code BROWSE/FILE): where you are, as a breadcrumb whose
 * every ancestor goes back to its folder page, and Go to file, the workspace's file search.
 */
export const CodeBrowserBar = React.memo(function CodeBrowserBar(props: Readonly<{
    testID?: string;
    rootLabel: string;
    path: string;
    onNavigateFolder: (path: string) => void;
    /**
     * Go to file: opens quick open (⌘P, Files in this workspace; plan P3 §3.6). Absent in the Overview
     * widget, where Go to file belongs to the Code page.
     */
    onQuickOpen?: (() => void) | null;
    /** Off while a file is open: the File page header carries its breadcrumb. */
    crumbs?: boolean;
    /** Phone layout keeps nested up navigation above a full-width Go to file field. */
    compact?: boolean;
    /** The folder's own controls (View, +), at the end of the line after Go to file. */
    trailing?: React.ReactNode;
    /** One quiet status on the bar's own line (an approval waiting), so it never pushes the page down. */
    status?: React.ReactNode;
}>) {
    const testID = props.testID ?? 'code-browser-bar';
    const { theme } = useUnistyles();
    const segments = React.useMemo(() => buildCodeBreadcrumbSegments(props.rootLabel, props.path), [props.path, props.rootLabel]);
    return (
        <View testID={testID} style={[styles.bar, props.compact ? styles.barCompact : null]}>
            {(props.compact && props.path === '') || props.crumbs === false ? null : <HappierBreadcrumb accessibilityRole="header" style={styles.crumbs}
                separator={<Text style={styles.separator}>/</Text>}
                linkStyle={styles.crumb}
                colors={{ focus: theme.colors.border.focus, hover: theme.colors.surface.hover }}
                items={segments.map((segment, index) => {
                    const current = index === segments.length - 1;
                    return { key: segment.path || '/', label: segment.label, testID: current ? `${testID}-current` : `${testID}-crumb-${index}`, onPress: current ? undefined : () => props.onNavigateFolder(segment.path) };
                })}
                renderLabel={(item) => <Text testID={item.onPress ? undefined : item.testID} numberOfLines={1} style={item.onPress ? styles.crumbLabel : styles.current}>{item.label}</Text>}
            />}
            {props.compact ? null : <View style={[styles.grow, styles.growRow]}>{props.status ? <View style={styles.status}>{props.status}</View> : null}</View>}
            <View style={props.compact ? styles.toolsCompact : styles.tools}>
                {props.onQuickOpen ? <CodeQuickOpenField testID={`${testID}-goto`} onPress={props.onQuickOpen} compact={props.compact} /> : null}
                {props.trailing}
            </View>
            {props.compact && props.status ? <View style={styles.statusCompact}>{props.status}</View> : null}
        </View>
    );
});

/**
 * Go to file: the field that opens quick open, the one file picker (lab FB2 "CodeGoToFile becomes a
 * button that opens this scope"); its ⌘P keycaps say the shortcut that does the same.
 */
function CodeQuickOpenField(props: Readonly<{ testID: string; onPress: () => void; compact?: boolean }>) {
    return (
        <HappierPressable testID={props.testID} accessibilityRole="button" accessibilityLabel={t('projects.code.goToFile')}
            onPress={props.onPress} style={props.compact ? styles.gotoCompact : styles.goto}>
            {/* Drawn as the field it opens; the button is the one control assistive tech and pointers reach. */}
            <View style={[styles.gotoField, { pointerEvents: 'none' }]} aria-hidden importantForAccessibility="no-hide-descendants">
                <CompactSearchField
                    testID={`${props.testID}-field`}
                    value=""
                    onChangeText={ignoreFieldText}
                    placeholder={t('projects.code.goToFile')}
                    editable={false}
                    trailing={<KeyboardCommandHint commandId="search.files" />}
                />
            </View>
        </HappierPressable>
    );
}

const ignoreFieldText = () => {};

const styles = StyleSheet.create((theme) => ({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 32,
        marginBottom: 12,
    },
    crumbs: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 4,
        flexShrink: 1,
        minWidth: 0,
    },
    barCompact: {
        flexDirection: 'column',
        alignItems: 'stretch',
    },
    crumb: {
        paddingHorizontal: 4,
        paddingVertical: 2,
        borderRadius: 6,
    },
    crumbLabel: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.link,
    },
    current: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
        paddingHorizontal: 4,
        paddingVertical: 2,
    },
    separator: {
        ...Typography.variant('label', 'semiBold'),
        ...Typography.default('regular'),
        color: theme.colors.text.tertiary,
    },
    grow: {
        flex: 1,
        minWidth: 0,
    },
    growRow: {
        flexDirection: 'row',
        alignSelf: 'stretch',
        alignItems: 'center',
    },
    // The status takes the bar's free space after the breadcrumb, ending at Go to file.
    status: {
        flex: 1,
        flexDirection: 'row',
        minWidth: 0,
        paddingHorizontal: theme.space.s4,
    },
    statusCompact: {
        flexDirection: 'row',
        minWidth: 0,
    },
    tools: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    toolsCompact: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        alignSelf: 'stretch',
    },
    goto: {
        width: 240,
    },
    gotoCompact: {
        flex: 1,
        minWidth: 0,
    },
    // The field is the button's face: presses land on the button, never in a text input.
    gotoField: {
        pointerEvents: 'none',
    },
}));
